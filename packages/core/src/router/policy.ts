import { EDITABLE_ADAPTERS, resolveIntent } from '../catalog/resolve.js';
import type { Intent } from '../catalog/types.js';
import { routingPolicy } from '../models/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { Classification, Effort, RouteRef } from '../types.js';
import { estimateDifficulty } from './difficulty.js';
import { effortProfile } from './effort.js';
import { matchInstant } from './instant.js';

/**
 * Router policy.
 *
 * Two entry points:
 *   - `pick(classification, opts)`: returns a single best route for the
 *     given classification, balancing cost vs effectiveness.
 *   - `pickStrong(classification, effort)`: returns the strongest route
 *     for a given cognitive shape, used by tournament/dualPlan when the
 *     workflow needs the high-end model regardless of cost.
 *
 * The router prefers the user's `routeOverrides` first, then consults
 * persistent memory (when supplied), then falls back to the built-in
 * cognitive-shape -> model mapping.
 */

export type RouterContext = {
  registry: ProviderRegistry;
  /** Repo-scoped persistent memory used to bias decisions. */
  memoryBias?: MemoryBias;
  /** Hard route override from config; if matched, returned verbatim. */
  routeOverrides?: { taskType?: Classification['taskType']; routeRef: RouteRef }[];
  /**
   * User-selected preferred models per tier (set via the dashboard's
   * Models tab). When present and the underlying provider is ready,
   * routing leans on these instead of the catalog default: `strong`
   * for high-effort intents, `cheap` for trivial / cost-sensitive ones.
   * A pick whose provider isn't ready is ignored so the router falls
   * back to its normal selection.
   */
  preferredModels?: { strong?: RouteRef; cheap?: RouteRef };
  /**
   * Per-model coding-score deltas learned from local run outcomes
   * (see `models/learn.ts`). Bounded + shrinkage-weighted, so this
   * nudges near-ties without overturning benchmark priors. Threaded
   * into the quality-first selector at intent-resolution time.
   */
  qualityBias?: Map<string, number>;
  /**
   * Per-model speed-prior adjustments learned from observed run latencies
   * (see `models/learn.ts`). Bounded + shrinkage-weighted; refines the
   * `value` objective's static speed feature with real-world speed.
   */
  latencyBias?: Map<string, number>;
  /**
   * Per-task-class preference learning: `taskClass -> (model -> coding
   * delta)` from local outcomes (see `computePolicyPreference`). The sub-map
   * for the current task is folded into the quality bias so a model that
   * reliably wins a task class gets nudged up for *that class only*.
   */
  policyBias?: Map<string, Map<string, number>>;
};

/** Read-only handle into the persistent memory shape the router actually uses. */
export type MemoryBias = {
  /** Routes the project has had repeated failures on (e.g. wrong shape). */
  forbiddenRoutes?: string[];
  /** Routes the project has had repeated success on. */
  preferredRoutes?: { route: string; reason: string }[];
  /** Last successful route for this repo (used by --fast). */
  lastSuccessfulRoute?: string;
};

export type PickOptions = {
  effort?: Effort;
  /** If true, callers want a cheap route even on high-shape requests (used for handoff-fix). */
  forceCheap?: boolean;
  /**
   * When true, the prompt contains images and only vision-capable
   * models are eligible. Bypasses non-vision shortcuts (memory bias,
   * instant, preferred-model) and constrains intent resolution to
   * entries with visionInput. Returns null when no vision model is
   * available so the caller can warn + fall back to text-only.
   */
  requiresVision?: boolean;
  /**
   * When true, every route this call can return must be backed by an
   * adapter that can edit files (`EDITABLE_ADAPTERS`). The orchestrator
   * sets this for execution sub-tasks so a chat-only model is never
   * handed a job that requires writing to the worktree. Non-editable
   * shortcuts (preferred pins, memory, instant) are skipped.
   */
  requireEditable?: boolean;
  /**
   * Raw user prompt, when the caller still has it. Optional: feeds a few
   * extra cheap features (length, code fences, stack traces, hard keywords)
   * into the difficulty estimator. Routing works fine without it.
   */
  prompt?: string;
};

/**
 * Returns the cost-effective route across the cheap+strong tiers.
 * Cheap-task short-circuits go to Ollama/Haiku; complex-task signals
 * (deep reasoning, multi-file taste, huge context) escalate to the
 * appropriate strong model.
 */
export function pick(
  classification: Classification,
  ctx: RouterContext,
  opts: PickOptions = {},
): RouteRef {
  const effort = opts.effort ?? 'medium';

  // 1) Hard overrides from config.
  for (const o of ctx.routeOverrides ?? []) {
    if (!o.taskType || o.taskType === classification.taskType) return o.routeRef;
  }

  // 1b) Vision-constrained routing. When the prompt contains images,
  //     bypass all non-vision shortcuts (memory, instant, preferred)
  //     and only pick from vision-capable models. Falls through the
  //     intent chain until one resolves, or returns a sentinel that
  //     the mode interprets as "no vision model available".
  if (opts.requiresVision) {
    const forbidRoutes = ctx.memoryBias?.forbiddenRoutes ?? [];
    const visionOpts = {
      forbidRoutes,
      requireVision: true,
      requireEditable: opts.requireEditable,
      qualityBias: ctx.qualityBias,
      latencyBias: ctx.latencyBias,
    };
    const intentsToTry: Intent[] = ['balanced-agent', 'multi-file', 'huge-context', 'deep-reasoning', 'fast-cheap'];
    for (const intent of intentsToTry) {
      const r = resolveIntent(intent, ctx.registry, visionOpts);
      if (r) return { ...r, rationale: `vision:${r.rationale}` };
    }
    // No vision-capable model is ready; return a sentinel the mode can detect.
    return {
      provider: 'none' as RouteRef['provider'],
      model: 'no-vision-model',
      rationale: 'no vision-capable model is configured/enabled',
      via: 'none',
    };
  }

  // 2) Effective quality bias: local-outcome learning (`qualityBias`) plus
  //    a *bounded* nudge toward routes this project has historically
  //    succeeded on. This is demoted from the old hard short-circuit -
  //    which returned the top memory route outright and pinned routing to a
  //    single model, creating a self-reinforcing loop - to a tie-breaker
  //    that flows through the value selector and can never override the
  //    cost-aware policy. `forbiddenRoutes` and user pins remain hard.
  const qualityBias = effectiveQualityBias(ctx, classification.taskType);
  const forbidRoutes = ctx.memoryBias?.forbiddenRoutes ?? [];
  const requireEditable = opts.requireEditable;
  const editableOk = (r: RouteRef): boolean => !(requireEditable && !EDITABLE_ADAPTERS.has(r.provider));

  // 3) Instant routes (typo, format, commit-message...) always win.
  const instant = matchInstant(classification.rationale);
  if (instant.matched) {
    const route = pickByHint(instant.pattern.route, ctx, requireEditable);
    if (route && editableOk(route)) return { ...route, rationale: instant.pattern.rationale };
  }

  // 4) Force-cheap (handoff-fix); pick the cheapest capable route.
  if (opts.forceCheap) {
    const pref = usablePreferred(ctx, 'cheap');
    if (pref && editableOk(pref)) return { ...pref, rationale: 'preferred-cheap: handoff fix' };
    const cheap = pickByHint('cheap', ctx, requireEditable);
    if (cheap) return { ...cheap, rationale: 'force-cheap: handoff fix' };
  }

  // 5) Per-task policy: difficulty (taskType + shape + effort) -> intent +
  //    floor + objective + weights. This is the cost-aware brain - cheap and
  //    strong models compete on a normalized value score (quality, price,
  //    speed, context), so everyday work no longer always lands on the most
  //    expensive frontier model. See `models/policies.ts`.
  const { taskType } = classification;
  const difficulty = estimateDifficulty(classification, effort, opts.prompt);
  const policy = routingPolicy(classification, effort, difficulty);

  const resolveByPolicy = (intent: Intent, rationale: string): RouteRef | null => {
    const ref = resolveIntent(intent, ctx.registry, {
      forbidRoutes,
      floor: policy.floor,
      objective: policy.objective,
      weights: policy.weights,
      qualityBias,
      latencyBias: ctx.latencyBias,
      requireEditable,
    });
    return ref ? { ...ref, rationale } : null;
  };

  // User pins beat the catalog: a cheap pin for cost policies, a strong pin
  // for any policy that demands a strong/frontier model.
  const needsStrong =
    policy.floor === 'frontier' ||
    policy.intent === 'multi-file' ||
    policy.intent === 'deep-reasoning' ||
    policy.intent === 'huge-context';
  if (policy.objective === 'cost') {
    const pref = usablePreferred(ctx, 'cheap');
    if (pref && editableOk(pref)) return { ...pref, rationale: `preferred-cheap:${taskType}` };
  } else if (needsStrong) {
    const pref = usablePreferred(ctx, 'strong');
    if (pref && editableOk(pref)) return { ...pref, rationale: 'preferred-strong' };
  }

  // Resolve the policy's intent, then fall back through progressively more
  // general intents so we always return something when a specialized pool
  // (e.g. 200k+ context) is empty.
  const primary = resolveByPolicy(
    policy.intent,
    `policy:${policy.name} [difficulty=${difficulty.band}/${difficulty.score.toFixed(2)}] - ${policy.rationale}`,
  );
  if (primary) return primary;
  if (policy.intent !== 'balanced-agent') {
    const balanced = resolveByPolicy('balanced-agent', `policy:${policy.name} (fallback: balanced)`);
    if (balanced) return balanced;
  }
  const cheap = pickByHint('cheap', ctx, requireEditable);
  if (cheap && editableOk(cheap)) return { ...cheap, rationale: `policy:${policy.name} (fallback: cheap)` };

  // 7) Last resort: the first ready provider in the registry. When the
  //    caller demanded an editable provider, skip chat-only adapters here
  //    too - otherwise this fallback could hand back exactly the chat-only
  //    sibling (e.g. OpenRouter's `openai_compat`) that requireEditable was
  //    meant to exclude, which then trips agent mode's canEdit guard.
  for (const p of ctx.registry.list()) {
    if (!ctx.registry.isReady(p.name)) continue;
    if (requireEditable && !EDITABLE_ADAPTERS.has(p.adapter)) continue;
    const model = Object.keys(p.models)[0];
    if (!model) continue;
    return {
      provider: p.adapter,
      model,
      rationale: 'fallback: first ready provider',
      via: p.name,
    };
  }
  throw new Error(
    'Router: no usable provider - configure an API key with /setup or export one of ' +
      'ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, OPENROUTER_API_KEY, DEEPSEEK_API_KEY, GROQ_API_KEY',
  );
}

/**
 * Returns the strongest available route for the given shape. Used by
 * tournament and dualPlan, which want the top contenders regardless of
 * cost ceilings.
 */
export function pickStrong(
  classification: Classification,
  ctx: RouterContext,
  effort: Effort = 'high',
): RouteRef[] {
  const profile = effortProfile(effort);
  const { shape } = classification;
  const forbidRoutes = ctx.memoryBias?.forbiddenRoutes ?? [];
  const out: RouteRef[] = [];
  const pushIntent = (intent: Intent, rationale: string): void => {
    const r = resolveIntent(intent, ctx.registry, {
      forbidRoutes,
      floor: 'frontier',
      qualityBias: ctx.qualityBias,
    });
    if (r) out.push({ ...r, rationale });
  };

  // For tournaments we want a *deliberately diverse* set of strong
  // contenders, one per intent the shape triggers, plus a balanced
  // fallback so we always have at least one route.
  if (shape.deepReasoning >= 0.5 || shape.algorithmic >= 0.5 || shape.adversarial >= 0.7) {
    pushIntent('deep-reasoning', 'strong: deep-reasoning');
  }
  if (shape.multiFileTaste >= 0.5) {
    pushIntent('multi-file', 'strong: multi-file');
  }
  if (shape.hugeContext >= 0.4) {
    pushIntent('huge-context', 'strong: huge-context');
  }
  pushIntent('balanced-agent', 'strong: balanced');

  // De-dupe by (via, model) so we don't pit a model against itself.
  const seen = new Set<string>();
  const uniq = out.filter((r) => {
    const k = `${r.via ?? r.provider},${r.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return uniq.slice(0, Math.max(1, profile.tournamentSize));
}


function preferProvider(
  ctx: RouterContext,
  providers: string[],
  model: string,
): RouteRef | null {
  for (const name of providers) {
    const cfg = ctx.registry.list().find((p) => p.name === name);
    if (!cfg) continue;
    if (!cfg.models[model]) continue;
    // Don't surface a route the registry can't actually authenticate -
    // otherwise the run fails downstream with "API_KEY not set" even
    // though we know it ahead of time and could pick something else.
    if (!ctx.registry.isReady(name)) continue;
    const ref: RouteRef = {
      provider: cfg.adapter,
      model,
      via: cfg.name,
      rationale: '',
    };
    if (isForbidden(ref, ctx)) continue;
    return ref;
  }
  return null;
}

function pickByHint(
  hint: 'cheap' | 'haiku' | 'local',
  ctx: RouterContext,
  requireEditable?: boolean,
): RouteRef | null {
  const forbidRoutes = ctx.memoryBias?.forbiddenRoutes ?? [];
  if (hint === 'local') {
    return resolveIntent('local-offline', ctx.registry, {
      forbidRoutes,
      qualityBias: ctx.qualityBias,
      latencyBias: ctx.latencyBias,
      requireEditable,
    });
  }
  // 'haiku' and 'cheap' both resolve to fast-cheap; the haiku-specific
  // bias used to live in the explicit fallback order and now lives in
  // the catalog (Haiku is fast-cheap@rank2).
  return resolveIntent('fast-cheap', ctx.registry, {
    forbidRoutes,
    qualityBias: ctx.qualityBias,
    latencyBias: ctx.latencyBias,
    requireEditable,
  });
}

function parseRouteRef(route: string): RouteRef | null {
  const [provider, ...rest] = route.split(',');
  if (!provider || rest.length === 0) return null;
  return { provider: provider as RouteRef['provider'], model: rest.join(','), rationale: '', via: provider };
}

/** Bounded coding-score bonus for a route the project has succeeded on. */
const MEMORY_PREFERENCE_BONUS = 6;
const MEMORY_PREFERENCE_CAP = 12;

/**
 * Build the effective coding-score bias map the value selector sees. Folds
 * three local-learning signals into one bounded `model -> delta` map:
 *
 *   1. `qualityBias` - global success/rating learning across all tasks.
 *   2. `policyBias[taskClass]` - per-task-class preference learning, so a
 *      model that reliably wins (say) refactors is nudged up for refactors.
 *   3. memory `preferredRoutes` - a small bonus toward historically-good
 *      routes. Demoted from the old hard short-circuit (which pinned routing
 *      to one model and reinforced itself) to a tie-breaker that can only
 *      tip genuinely close decisions. Forbidden / not-ready / unconfigured
 *      routes contribute nothing.
 */
function effectiveQualityBias(ctx: RouterContext, taskClass: string): Map<string, number> | undefined {
  const prefs = ctx.memoryBias?.preferredRoutes ?? [];
  const perClass = ctx.policyBias?.get(taskClass);
  if (prefs.length === 0 && !perClass) return ctx.qualityBias;

  const out = new Map(ctx.qualityBias ?? []);
  if (perClass) {
    for (const [model, delta] of perClass) out.set(model, (out.get(model) ?? 0) + delta);
  }
  for (const top of prefs) {
    const ref = parseRouteRef(top.route);
    if (!ref) continue;
    if (isForbidden(ref, ctx)) continue;
    const providerName = ref.via ?? ref.provider;
    if (!ctx.registry.has(providerName) || !ctx.registry.isReady(providerName)) continue;
    const current = out.get(ref.model) ?? 0;
    out.set(ref.model, Math.min(MEMORY_PREFERENCE_CAP, current + MEMORY_PREFERENCE_BONUS));
  }
  return out;
}

/**
 * Resolve a tier's preferred model into a routable ref, or null when
 * unset / its provider isn't ready / it's been forbidden by memory. The
 * `via` (provider name) drives the readiness check; an unconfigured
 * preference is silently skipped so routing falls back to the catalog.
 */
function usablePreferred(ctx: RouterContext, tier: 'strong' | 'cheap'): RouteRef | null {
  const ref = ctx.preferredModels?.[tier];
  if (!ref) return null;
  const providerName = ref.via ?? ref.provider;
  if (!ctx.registry.has(providerName) || !ctx.registry.isReady(providerName)) return null;
  if (isForbidden(ref, ctx)) return null;
  return ref;
}

function isForbidden(ref: RouteRef, ctx: RouterContext): boolean {
  if (!ctx.memoryBias?.forbiddenRoutes) return false;
  const key = `${ref.via ?? ref.provider},${ref.model}`;
  return ctx.memoryBias.forbiddenRoutes.includes(key);
}
