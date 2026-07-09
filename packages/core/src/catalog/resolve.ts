import { detectCodexAuthMode } from '../adapters/codex.js';
import { isOllamaModelInstalled } from '../adapters/ollama.js';
import {
  type Candidate,
  type Objective,
  type QualityTier,
  type SelectConstraints,
  type Selection,
  type ValueWeights,
  INTENT_DEFAULTS,
  resolveCard,
  selectBest,
  selectModels,
} from '../models/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RouteRef } from '../types.js';
import { CATALOG } from './entries.js';
import type { CatalogEntry, Intent } from './types.js';

/**
 * Cached codex auth mode. Reading ~/.codex/auth.json is cheap but it
 * can't change without a `codex login`, so we memoise it for the
 * lifetime of the process. `resetCodexAuthCache()` is exported for
 * tests.
 */
let codexAuthCache: ReturnType<typeof detectCodexAuthMode> | null = null;
function codexAuthMode(): ReturnType<typeof detectCodexAuthMode> {
  if (codexAuthCache === null) codexAuthCache = detectCodexAuthMode();
  return codexAuthCache;
}
export function resetCodexAuthCache(): void {
  codexAuthCache = null;
}

/**
 * Intents whose *whole point* is getting a top-tier model. When codex
 * is logged in via a ChatGPT account, the CLI ignores `-m` and picks
 * whatever model the user's plan allows - so we can't guarantee we'll
 * actually get a reasoning-strength model out of it. We heavily demote
 * codex's quality for these intents so any configured cloud API wins,
 * but still keep it as a last-resort candidate (it survives the
 * below-floor fallback when nothing else is ready).
 *
 * `balanced-agent` and `fast-cheap` aren't penalised because for those
 * the "any-model-from-codex" mystery box is genuinely fine.
 */
const STRONG_MODEL_INTENTS: ReadonlySet<Intent> = new Set(['deep-reasoning', 'multi-file']);
const CODEX_CHATGPT_PENALTY_CODING = 8;

/**
 * Adapter kinds whose tool layer can actually edit files (write/patch
 * the worktree). Used by `requireEditable` so the orchestrator only
 * routes execution sub-tasks to providers that can do real work — never
 * a chat-only API that would emit text and leave the tree untouched.
 */
export const EDITABLE_ADAPTERS: ReadonlySet<RouteRef['provider']> = new Set([
  'claude_code',
  'codex',
  'coderouter_agent',
]);

export type ResolveIntentOptions = {
  /**
   * Names the caller wants tried first. When present, the selector is
   * run over just these providers' candidates before falling back to
   * the full set.
   */
  preferProviders?: readonly string[];
  /**
   * Specific (provider, model) pairs the caller refuses to route to,
   * encoded as "provider,model" strings to match the shape we get from
   * `memoryBias.forbiddenRoutes`.
   */
  forbidRoutes?: readonly string[];
  /** When true, only vision-capable models are eligible (prompt has images). */
  requireVision?: boolean;
  /**
   * When true, only providers whose adapter can edit files
   * (`EDITABLE_ADAPTERS`) are eligible. Used by the orchestrator so
   * every execution sub-task lands on a tools-capable coding agent.
   */
  requireEditable?: boolean;
  /** Override the per-intent quality floor (e.g. policy raises it for high effort). */
  floor?: QualityTier;
  /** Override the per-intent selection objective. */
  objective?: Objective;
  /** Feature weights for the `value` objective (from the routing policy). */
  weights?: ValueWeights;
  /** model id -> bounded coding-score delta from local outcomes (learn.ts). */
  qualityBias?: Map<string, number>;
  /** model id -> speed-prior adjustment from observed latencies (learn.ts). */
  latencyBias?: Map<string, number>;
};

/**
 * Pick the best model for a routing intent, restricted to providers that
 * are *actually configured* on the registry, ranking quality-first.
 *
 * Flow:
 *   1. Build the candidate set from catalog entries bound to this intent
 *      on ready, non-forbidden providers. Dynamic providers (OpenRouter)
 *      are expanded with their live catalog so we route to the best
 *      *current* model, not a single hardcoded id.
 *   2. Resolve each candidate to a benchmark-grounded `ModelCard`.
 *   3. Hand the candidates to the quality-first selector with the
 *      intent's capability requirements + quality floor + objective.
 *
 * Returns a `RouteRef` whose `rationale` explains the pick (tier +
 * coding score + what it cleared), or null when nothing is ready.
 */
export function resolveIntent(
  intent: Intent,
  registry: ProviderRegistry,
  opts: ResolveIntentOptions = {},
): RouteRef | null {
  const prefer = opts.preferProviders ?? [];
  const candidates = collectIntentCandidates(intent, registry, opts);
  if (candidates.length === 0) return null;
  const constraints = intentConstraints(intent, opts);

  // preferProviders, when supplied, get first crack at the selection.
  if (prefer.length > 0) {
    const preferred = candidates.filter((c) => prefer.includes(c.via));
    const sel = selectBest(preferred, constraints);
    if (sel) {
      return {
        provider: sel.candidate.adapter,
        model: sel.candidate.model,
        via: sel.candidate.via,
        rationale: `${intent}: ${sel.rationale}`,
      };
    }
  }

  const sel = selectBest(candidates, constraints);
  if (!sel) return null;
  return {
    provider: sel.candidate.adapter,
    model: sel.candidate.model,
    via: sel.candidate.via,
    rationale: `${intent}: ${sel.rationale}`,
  };
}

/**
 * Like `resolveIntent`, but returns the full ranked list of selections
 * (winner first) instead of a single route. Powers `coderouter route
 * --explain` so we can show the runners-up + their value breakdown.
 */
export function explainIntent(
  intent: Intent,
  registry: ProviderRegistry,
  opts: ResolveIntentOptions = {},
): Selection[] {
  const candidates = collectIntentCandidates(intent, registry, opts);
  if (candidates.length === 0) return [];
  return selectModels(candidates, intentConstraints(intent, opts));
}

function intentConstraints(intent: Intent, opts: ResolveIntentOptions): SelectConstraints {
  const d = INTENT_DEFAULTS[intent];
  return {
    requireVision: opts.requireVision,
    minContextWindow: d.minContextWindow,
    floor: opts.floor ?? d.floor,
    objective: opts.objective ?? d.objective,
    weights: opts.weights,
    qualityBias: opts.qualityBias,
    latencyBias: opts.latencyBias,
  };
}

function collectIntentCandidates(
  intent: Intent,
  registry: ProviderRegistry,
  opts: ResolveIntentOptions,
): Candidate[] {
  const forbidRoutes = new Set(opts.forbidRoutes ?? []);

  const candidates: Candidate[] = [];
  // Dynamic (OpenRouter) providers that participate in this intent, with
  // whether they require tool-calling (agent providers do).
  const dynamicForIntent = new Map<string, { adapter: RouteRef['provider']; name: string; requireTools: boolean }>();

  for (const entry of CATALOG) {
    if (!entry.intents.some((b) => b.intent === intent)) continue;
    if (forbidRoutes.has(`${entry.provider},${entry.model}`)) continue;
    if (!registry.has(entry.provider) || !registry.isReady(entry.provider)) continue;
    // Provider-level readiness isn't model-level readiness for ollama.
    if (entry.provider === 'ollama' && !isOllamaModelInstalled(entry.model)) continue;
    const cfg = registry.list().find((p) => p.name === entry.provider);
    if (!cfg) continue;
    if (opts.requireEditable && !EDITABLE_ADAPTERS.has(cfg.adapter)) continue;

    if (cfg.dynamicCatalog === 'openrouter') {
      dynamicForIntent.set(entry.provider, {
        adapter: cfg.adapter,
        name: cfg.name,
        requireTools: cfg.adapter === 'coderouter_agent',
      });
      // Keep the curated entry as a fallback candidate so we still route
      // sensibly when the live catalog is empty (offline / no key yet).
      const live = registry.getOpenRouterCatalogModel(entry.model);
      candidates.push(toCandidate(entry.provider, cfg.adapter, entry.model, resolveCard(entry.model, live), entry));
      continue;
    }

    let card = resolveCard(entry.model);
    if (entry.provider === 'codex' && STRONG_MODEL_INTENTS.has(intent) && codexAuthMode() !== 'apikey') {
      card = {
        ...card,
        quality: { ...card.quality, coding: Math.min(card.quality.coding, CODEX_CHATGPT_PENALTY_CODING) },
      };
    }
    candidates.push(toCandidate(entry.provider, cfg.adapter, entry.model, card, entry));
  }

  // Expand dynamic providers with their full live catalog.
  //
  // Dedup by *canonical card id* so OpenRouter's floating aliases
  // (`~anthropic/claude-opus-latest`, `anthropic/claude-opus-4.5`,
  // `anthropic/claude-opus-4-5`, …) don't all enter the pool as
  // separate candidates. Without this, the alias that happens to
  // sort first (often `~…-latest`) wins every value race and the
  // TUI looks like "we only ever run Opus". Prefer the curated
  // catalog id when present; otherwise the cheapest live slug.
  if (dynamicForIntent.size > 0) {
    const live = registry.listOpenRouterCatalogModels();
    const seenCard = new Set(candidates.map((c) => c.card.id));
    for (const dyn of dynamicForIntent.values()) {
      // Group live models by the card they resolve to.
      const byCard = new Map<string, { m: (typeof live)[number]; card: ReturnType<typeof resolveCard> }>();
      for (const m of live) {
        // Skip OpenRouter's floating "~vendor/…" aliases — they
        // resolve to the same card as the pinned id but pollute
        // the route label and confuse users.
        if (m.id.startsWith('~')) continue;
        if (forbidRoutes.has(`${dyn.name},${m.id}`)) continue;
        const card = resolveCard(m.id, m);
        if (dyn.requireTools && !card.tools) continue;
        if (seenCard.has(card.id)) continue;
        const prev = byCard.get(card.id);
        if (!prev) {
          byCard.set(card.id, { m, card });
          continue;
        }
        // Prefer the curated/canonical id, then the cheaper slug.
        const preferCanonical = m.id === card.id && prev.m.id !== card.id;
        const cost = (card.pricePer1MIn ?? 0) + (card.pricePer1MOut ?? 0);
        const prevCost = (prev.card.pricePer1MIn ?? 0) + (prev.card.pricePer1MOut ?? 0);
        if (preferCanonical || (!preferCanonical && prev.m.id !== card.id && cost < prevCost)) {
          byCard.set(card.id, { m, card });
        }
      }
      for (const { m, card } of byCard.values()) {
        seenCard.add(card.id);
        candidates.push({
          via: dyn.name,
          adapter: dyn.adapter,
          model: m.id === card.id ? card.id : m.id,
          card,
          pricePer1MIn: card.pricePer1MIn ?? 0,
          pricePer1MOut: card.pricePer1MOut ?? 0,
          contextWindow: card.contextWindow,
        });
      }
    }
  }

  return candidates;
}

function toCandidate(
  via: string,
  adapter: RouteRef['provider'],
  model: string,
  card: ReturnType<typeof resolveCard>,
  entry: CatalogEntry,
): Candidate {
  return {
    via,
    adapter,
    model,
    card,
    pricePer1MIn: card.pricePer1MIn ?? entry.pricePer1MIn ?? 0,
    pricePer1MOut: card.pricePer1MOut ?? entry.pricePer1MOut ?? 0,
    contextWindow: card.contextWindow || entry.contextWindow || 0,
  };
}

/**
 * Look up a catalog entry by provider + model. Used by the report
 * layer (and the wizard) when we want to surface a model's context
 * window or price without parsing the registry.
 */
export function lookupModel(provider: string, model: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.provider === provider && e.model === model);
}
