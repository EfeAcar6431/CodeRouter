import { randomUUID } from 'node:crypto';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import { composeDirectives } from '../customize/index.js';
import { scanContext } from '../context/scan.js';
import { detectPromptImages } from '../context/images.js';
import { fastClassification } from '../routing/fast.js';
import { matchInstant } from '../routing/instant.js';
import { pick } from '../routing/policy.js';
import { effortProfile } from '../routing/effort.js';
import { classificationToSubtask, shadowRoute } from '../routing/shadow.js';
import { runHandoff } from '../handoff/workflow.js';
import {
  changedFiles,
  commitWorktreeState,
  createWorktree,
  destroyWorktree,
  diffWorkingTree,
  diffWorktree,
  ensureGitRepo,
  mergeWorktree,
  persistRunArtifact,
  snapshotWorkingTree,
  type Worktree,
} from '../sandbox/worktree.js';
import { scanText as scanForInjection } from '../security/injection.js';
import { detectProject, type ProjectType } from '../validate/detect.js';
import { runValidators, summarize } from '../validate/run.js';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import type { RouteRef } from '../types.js';
import { noopProgress } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput } from './types.js';

/**
 * Agent mode: decisive execution.
 *
 * Pipeline:
 *   instant -> classify -> context -> route -> worktree create
 *   -> adapter.run -> validators -> optional handoff-fix passes
 *   -> diff + merge (if --apply) -> report
 *
 * Honors --fast (skips classifier, context, validators). Respects the
 * effort knob via the router's reasoning thresholds + handoff pass caps.
 */
export async function runAgentMode(input: ModeInput, ctx: ModeContext): Promise<ModeOutput> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);
  const effort = input.effort ?? 'medium';
  const profile = effortProfile(effort);

  progress({ phase: 'agent/instant', stage: 'start' });
  const instant = matchInstant(input.prompt);
  progress({ phase: 'agent/instant', stage: 'done' });

  // Prompt-injection scan. We run this before any classifier or
  // adapter call so a `block` policy can abort the run without
  // burning tokens or spinning up a worktree. Findings always flow
  // through to the report regardless of policy so the operator can
  // see them.
  progress({ phase: 'agent/security', stage: 'start' });
  const securityFindings = scanForInjection(input.prompt, { source: 'user-prompt' }).findings;
  progress({
    phase: 'agent/security',
    stage: 'done',
    data: { findings: securityFindings.length },
  });
  const policy = input.injectionPolicy ?? 'warn';
  const hasHighRisk = securityFindings.some((f) => f.severity === 'high');
  if (policy === 'block' && hasHighRisk) {
    return {
      mode: 'agent',
      status: 'failed',
      runId,
      classification: undefined,
      contextManifest: { entries: [], totalTokens: 0, budget: 0, truncated: false },
      routes: [],
      validators: [],
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: performance.now() - start,
      rationale: 'blocked: prompt-injection policy=block and high-severity finding present',
      securityFindings,
    };
  }

  const corpus = await loadSeedCorpus();
  // Optional LLM judge (cascade stage 3): only when a budget is present and
  // we'd actually run the classifier. The cascade invokes it solely on
  // low-confidence prompts and caches the result by hash, so this is a
  // bounded, occasional cost - and a cheap chat model, never a heavy CLI.
  const llmJudge = ctx.budget && !input.fast && !instant.matched ? buildCheapJudge(ctx) : undefined;
  const classifier = new ClassifierCascade({ corpus, llmJudge });

  const classification = input.fast
    ? fastClassification(input.prompt)
    : instant.matched
      ? instant.classification
      : await classifier.classify({ prompt: input.prompt, noLlm: !ctx.budget });

  // Detect image file paths referenced in the prompt.
  const detectedImages = detectPromptImages(input.prompt, input.cwd);
  const images = [...detectedImages, ...(input.images ?? [])];
  const requiresVision = images.length > 0;

  // Agent mode rewrites files, so every route it picks MUST be backed by a
  // tools-capable (editable) adapter. `requireEditable` filters the candidate
  // pool up front so the router can't hand back a chat-only sibling (e.g.
  // OpenRouter's `openai_compat` provider) that would trip the canEdit guard
  // below and abort the run. An explicit `--route` override is honored as-is.
  let route = input.route
    ? parseRoute(input.route)
    : pick(classification, ctx.router, { effort, requiresVision, requireEditable: true, prompt: input.prompt });

  // If vision was required but no vision model is available, the router
  // hands back a `no-vision-model` sentinel (provider 'none'). Warn,
  // drop the images, and re-route WITHOUT the vision constraint so we
  // still produce a (text-only) answer instead of crashing on the
  // sentinel's bogus provider.
  if (requiresVision && route.model === 'no-vision-model') {
    progress({
      phase: 'agent/route',
      stage: 'done',
      data: { warning: 'no vision-capable model is enabled; running text-only — enable one in /setup' },
    });
    images.length = 0; // clear so we don't try to attach
    route = input.route
      ? parseRoute(input.route)
      : pick(classification, ctx.router, { effort, requireEditable: true, prompt: input.prompt });
  }

  const adapter: Adapter = ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;

  // Hard guard: agent mode rewrites files, so the routed adapter
  // MUST have a tool layer that can actually do that. Local CLIs
  // (Claude Code / Codex) and the first-party CodeRouter agent
  // loop have `canEdit: true`; raw chat adapters (OpenAI direct,
  // OpenRouter chat-only, DeepSeek, ...) have `canEdit: false` and
  // would produce a text answer with no actual edits, leaving the
  // user staring at an unchanged worktree. We catch that here so
  // the failure mode is a clear error instead of "the agent ran
  // for 30s and didn't change anything".
  if (!adapter.capabilities.canEdit) {
    throw new Error(
      `agent mode requires a tools-capable provider, but the router picked '${route.provider}:${route.model}' which is chat-only. ` +
        `Configure a coding-agent provider via /setup (Claude Code or Codex on PATH, or any OpenRouter / OpenAI / etc. key - those route through the CodeRouter agent loop), or pick a tools-capable model directly with --route.`,
    );
  }

  // Shadow the new four-layer router alongside the live `pick` decision.
  // Best-effort and fire-and-forget: it logs a `routeSubtask` decision for the
  // eval/replay harness but never affects which adapter actually runs here.
  if (ctx.store && !input.dryRun) {
    const subtask = classificationToSubtask({
      subtaskId: runId,
      prompt: input.prompt,
      classification,
      effort,
      repoId: input.cwd,
    });
    void shadowRoute(ctx.store.routing, subtask);
  }

  progress({ phase: 'agent/worktree', stage: 'start' });
  // Two paths depending on whether the REPL is keeping a session-
  // wide worktree alive across turns:
  //
  //   1. `existingWorktree` set -> reuse it. The cwd/branch/baseSha
  //      from the last turn carry over so the agent sees the files
  //      it created earlier and "the directory above this one"
  //      means the same thing every turn. We DON'T re-init or
  //      mirror state here - that's a one-time cost paid on the
  //      first turn.
  //
  //   2. Unset -> create fresh. Bootstrap a git repo if needed
  //      (Claude Code-style "point me at any folder" UX), fork a
  //      worktree off HEAD, mirror the user's pending state in.
  // In-place execution (allowlist / unsandboxed run modes): the agent runs
  // directly in the user's real project directory instead of a throwaway
  // worktree. Edits land on real files immediately, dev servers can persist,
  // and the diff is computed from a before/after working-tree snapshot.
  const inPlace = input.runMode === 'unsandboxed' || input.runMode === 'allowlist';
  const reusedWorktree = input.existingWorktree;
  let wt: Worktree | undefined;
  let runDir: string;
  let inPlaceBaseTree: string | undefined;
  let repoInitCreated = false;
  let createdThisTurn = false;
  if (inPlace) {
    const repoInit = await ensureGitRepo(input.cwd, { autoInit: true });
    repoInitCreated = repoInit.created;
    runDir = input.cwd;
    // Snapshot the tree BEFORE the agent touches anything so the post-run
    // diff is exactly this turn's net change. Best-effort: a failure just
    // means we fall back to diffing against HEAD later.
    inPlaceBaseTree = await snapshotWorkingTree(input.cwd).catch(() => undefined);
  } else if (reusedWorktree) {
    wt = { ...reusedWorktree };
    runDir = wt.path;
  } else {
    const repoInit = await ensureGitRepo(input.cwd, { autoInit: true });
    repoInitCreated = repoInit.created;
    wt = await createWorktree({ repoPath: input.cwd, runId, prefix: 'agent' });
    createdThisTurn = true;
    runDir = wt.path;
  }
  progress({
    phase: 'agent/worktree',
    stage: 'done',
    message: repoInitCreated ? 'initialized git repo' : undefined,
  });

  let manifest = { entries: [], totalTokens: 0, budget: 0, truncated: false } as import('../types.js').ContextManifest;
  if (!input.fast) {
    progress({ phase: 'agent/context', stage: 'start' });
    manifest = await scanContext({ cwd: runDir, prompt: input.prompt });
    progress({ phase: 'agent/context', stage: 'done' });
  }

  // Tell the UI which route we picked the moment we know it - the
  // REPL stamps every tool block + the spinner row with this so the
  // user can see at a glance which model is doing the work. Also
  // useful for observability when handoffs swap models mid-run
  // (each handoff fires its own progress beat with a fresh route).
  progress({
    phase: 'agent/run',
    stage: 'start',
    data: {
      route: {
        provider: route.provider,
        model: route.model,
        via: route.via ?? route.provider,
        rationale: route.rationale,
      },
    },
  });
  // Display-only route we narrate to the UI. We start with the
  // requested model (e.g. `sonnet`, `opus`) and upgrade it the
  // moment the adapter tells us what the provider actually
  // resolved to (`claude-sonnet-4-5-20250929`). The notifier
  // re-emits the route data so the REPL can refresh its per-block
  // model labels.
  //
  // CRITICAL: this MUST stay separate from the route we hand back
  // in `ModeOutput.routes`. The router's memory-bias promotes
  // last-successful routes as preferred routes for the next turn
  // (`bias.ts`), and resolved provider-internal names like
  // `claude-sonnet-4-6-20251215` aren't keys in the provider
  // catalog (`default/opus/sonnet`). Leaking the resolved name
  // into the report would make the next turn try to resolve an
  // unknown model and crash with "ProviderRegistry: unknown
  // model 'claude-sonnet-4-6'".
  let liveRoute: RouteRef = { ...route };
  // Replay the prior session id for the routed provider, if the REPL
  // has one. Mismatches (different provider this turn, or no stored
  // id) just produce a fresh conversation - adapters tolerate
  // missing/invalid resume ids by design.
  const resumeSessionId = input.resumeSessions?.[route.provider];

  // Inject the user's rules + available skills into the system prompt.
  // Read from the real repo (input.cwd) so both project (.coderouter/)
  // and global (~/.coderouter/) directives resolve even though the
  // agent runs inside a forked worktree. Skipped in --fast.
  const directives = input.fast ? '' : await composeDirectives(input.cwd).catch(() => '');
  const systemPrompt = directives ? buildSystemPrompt({ append: directives }) : undefined;

  let res;
  try {
    res = await adapter.run({
      prompt: input.prompt,
      systemPrompt,
      cwd: runDir,
      runMode: input.runMode,
      images: images.length > 0 ? images : undefined,
      reasoningEffort: profile.reasoningEffort,
      contextManifest: manifest,
      signal: input.signal,
      resumeSessionId,
      priorMessages: input.priorMessages,
      onChunk: input.onChunk,
      onActivity: input.onActivity,
      onUsage: input.onUsage,
      onUserQuestion: input.onUserQuestion,
      onModelResolved: (resolvedModel) => {
        liveRoute = { ...liveRoute, model: resolvedModel };
        progress({
          phase: 'agent/run',
          stage: 'start',
          data: {
            route: {
              provider: liveRoute.provider,
              model: liveRoute.model,
              via: liveRoute.via ?? liveRoute.provider,
              rationale: liveRoute.rationale,
            },
          },
        });
      },
    });
  } catch (err) {
    // Only destroy the worktree on transient failures when we created
    // it this turn AND the caller hasn't asked us to keep it (REPL
    // passes `keepWorktree: true` to preserve cwd / accumulated
    // edits across prompts).
    if (!inPlace && wt && createdThisTurn && !input.keepWorktree) {
      await destroyWorktree(wt).catch(() => {});
    }
    // Surface cancellation as a structured outcome instead of letting
    // the AbortError propagate as a generic failure.
    if (input.signal?.aborted) {
      // Snapshot whatever partial state the model wrote before the
      // abort hit, so the next turn diffs against "the world as it
      // was when I aborted" rather than re-listing partial work
      // that the user already declined to apply. The file content
      // stays on disk (and visible to the agent on the next turn)
      // either way - we're just advancing the diff baseline.
      const newSha =
        !inPlace && wt && input.keepWorktree
          ? await commitWorktreeState(wt, 'coderouter: aborted turn').catch(() => null)
          : null;
      return {
        mode: 'agent',
        status: 'aborted',
        runId,
        classification,
        contextManifest: manifest,
        routes: [route],
        validators: [],
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
        durationMs: performance.now() - start,
        rationale: `${route.rationale} (aborted)`,
        securityFindings,
        // Hand the worktree back even on abort so the REPL can
        // reuse it on the next prompt - the user often hits esc to
        // course-correct mid-run, then types a refined prompt.
        worktree:
          !inPlace && wt && input.keepWorktree
            ? {
              runId: wt.runId,
              branch: wt.branch,
              path: wt.path,
              baseRef: wt.baseRef,
              baseSha: newSha ?? wt.baseSha,
              repoPath: wt.repoPath,
              createdAt: wt.createdAt,
            }
          : undefined,
      };
    }
    throw err;
  }
  progress({ phase: 'agent/run', stage: 'done' });

  // Compute the diff once, up front: it gates whether validators
  // (and therefore handoff) make sense at all. If the model didn't
  // touch any files we're answering a question, not making a change,
  // and running `pnpm lint` / `tsc` / `vitest` against an unchanged
  // worktree is at best wasted time and at worst noise that drowns
  // the actual answer.
  let files: string[];
  let diff: string;
  if (inPlace) {
    // Edits are already on the user's real files; describe them by diffing
    // the pre-run tree snapshot against the current working tree.
    const snap = inPlaceBaseTree
      ? await diffWorkingTree(input.cwd, inPlaceBaseTree).catch(() => ({ diff: '', files: [] as string[] }))
      : { diff: '', files: [] as string[] };
    files = snap.files;
    diff = snap.diff;
  } else {
    files = await changedFiles(wt!).catch(() => []);
    diff = await diffWorktree(wt!).catch(() => '');
  }

  // Validators only matter when the changed files belong to the
  // project's primary toolchain. Three common ways this skip fires:
  //
  //   1. Docs / config edits  (.md, .gitignore, package.json bump)
  //      can't break lint / tsc / tests in any meaningful way.
  //   2. Cross-language drops  (a Python script added to a Node
  //      project) can't be linted by the Node toolchain - running
  //      `pnpm run lint` on a `.py` file will fail with no signal.
  //   3. The worktree has no installed deps  (it's a fresh clone of
  //      the host repo without `node_modules`); a `pnpm` script is
  //      guaranteed to fail with "command not found" noise.
  //
  // Each case used to silently kick off a handoff fix-pass that
  // burned an LLM call trying to "fix" something the validators
  // can't even evaluate. Skip the whole pipeline cleanly with a
  // structured `skipped` reason instead.
  const project = await detectProject(runDir);
  const hasMatchingChanges = files.some((f) => isProjectSource(f, project.type));
  const hasInstalledDeps = await hasProjectDeps(runDir, project.type);
  let skipReason: string | null = null;
  if (files.length === 0) skipReason = 'no-file-changes';
  else if (!hasMatchingChanges) skipReason = `no-${project.type}-sources-changed`;
  else if (!hasInstalledDeps) skipReason = `${project.type}-deps-not-installed-in-worktree`;

  let validators: import('../types.js').ValidatorResult[] = [];
  let handoffPasses = 0;
  if (!input.fast && skipReason === null) {
    progress({ phase: 'agent/validate', stage: 'start' });
    validators = await runValidators({ cwd: runDir, signal: input.signal });
    progress({ phase: 'agent/validate', stage: 'done' });

    // The handoff fix-pass operates on a worktree; in-place runs have none,
    // so we report failing validators without an automated fix pass.
    if (!inPlace && wt && summarize(validators).status === 'fail' && profile.maxHandoffPasses > 0) {
      progress({ phase: 'agent/handoff', stage: 'start' });
      const handoff = await runHandoff({
        registry: ctx.registry,
        router: ctx.router,
        mode: 'fix',
        worktree: wt,
        classification,
        originalPrompt: input.prompt,
        fromRoute: route,
        effort,
        // Pre-computed validators - skips the redundant 2-3 min
        // re-run inside runHandoff that used to dominate the
        // fix-pass total. We just ran them; trust the result.
        initialValidators: validators,
        signal: input.signal,
        budget: {
          maxCostUsd: profile.maxCostUsd,
          maxDurationMs: profile.maxDurationMs,
          maxHandoffPasses: profile.maxHandoffPasses,
          maxContenders: profile.tournamentSize,
        },
      });
      validators = handoff.finalValidators;
      handoffPasses = handoff.passes.length;
      progress({ phase: 'agent/handoff', stage: 'done', data: { passes: handoffPasses } });
    }
  } else if (!input.fast) {
    // Skipped explicitly so the progress phase still emits a "done"
    // beat; otherwise the spinner gets stuck on "run · done" for the
    // remainder of the pipeline.
    progress({
      phase: 'agent/validate',
      stage: 'done',
      data: { skipped: skipReason ?? 'fast-mode' },
    });
  }

  // Always persist the diff to a stable, recoverable location BEFORE
  // we destroy the worktree. Without this the user has no way to
  // recover the changes they just watched the model "make" - the
  // worktree lives in /tmp and gets nuked on apply=off, which is the
  // exact pattern that produced the "claimed to create the file but
  // it doesn't exist" confusion.
  let artifactDir: string | undefined;
  if (!inPlace && wt && files.length > 0) {
    const artifact = await persistRunArtifact(wt, { diff, files });
    if (artifact) artifactDir = artifact.dir;
  }

  // Apply + lifecycle.
  //
  // In-place runs: edits are ALREADY on the user's real files, so there's
  // nothing to merge - `applied` just reflects whether anything changed
  // (the UI shows Keep/Undo and Undo reverses the diff).
  //
  // Worktree runs, three flavors:
  //   1. `keepWorktree=true`  (REPL session)    -> never destroy.
  //      Optionally merge into host when `apply` is on, then snapshot
  //      the worktree's state into a commit so `baseSha` advances
  //      and the next turn's diff is net-new.
  //   2. `keepWorktree=false`+`apply=true`      -> merge into host
  //      and destroy.
  //   3. `keepWorktree=false`+`apply=false`     -> destroy. The
  //      REPL/CLI's artifact pipeline ships the diff to disk
  //      separately above (`persistRunArtifact`) so the user can
  //      `git apply` it manually later if they want.
  let applied = false;
  let applyError: string | undefined;
  if (inPlace) {
    applied = files.length > 0;
  } else if (input.apply && wt && files.length > 0) {
    try {
      await mergeWorktree(wt, { cleanup: false });
      applied = true;
    } catch (err) {
      // Don't swallow this silently - the user passed --apply and
      // deserves to know the merge back into their tree failed (the
      // patch is still recoverable from artifactDir). This exact
      // silence made the "apply=off?!" confusion possible.
      applied = false;
      applyError = err instanceof Error ? err.message : String(err);
    }
  }
  if (!inPlace && wt && !input.keepWorktree) {
    await destroyWorktree(wt).catch(() => {});
  }

  // For session-wide worktrees, snapshot whatever state the agent
  // left behind into a commit on the worktree branch so the next
  // turn's `diffWorktree` produces only the *next* turn's net
  // changes. Without this, every subsequent turn would re-list (and
  // re-merge) the entire session's changes.
  let outgoingWorktree: import('./types.js').WorktreeHandle | undefined;
  if (!inPlace && wt && input.keepWorktree) {
    const newSha = await commitWorktreeState(wt).catch(() => null);
    outgoingWorktree = {
      runId: wt.runId,
      branch: wt.branch,
      path: wt.path,
      baseRef: wt.baseRef,
      baseSha: newSha ?? wt.baseSha,
      repoPath: wt.repoPath,
      createdAt: wt.createdAt,
    };
  }

  const status = summarize(validators).status === 'fail' ? 'partial' : 'success';

  return {
    mode: 'agent',
    status,
    runId,
    text: res.text,
    diff,
    filesChanged: files,
    classification,
    contextManifest: manifest,
    // Report the catalog-bound route (e.g. `claude_code,sonnet`) so
    // the next turn's memory-bias can re-pick the same model
    // through `registry.resolve()`. `liveRoute` holds the
    // display-only resolved name and is fed to the UI via the
    // `progress` callback above.
    routes: [route],
    validators,
    costUsd: res.costUsd,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    durationMs: performance.now() - start,
    rationale: `${route.rationale}${handoffPasses ? ` + ${handoffPasses} handoff pass(es)` : ''}`,
    securityFindings,
    applied,
    applyError,
    artifactDir,
    validatorsSkippedReason: skipReason ?? undefined,
    sessionId: res.sessionId,
    sessionProvider: res.sessionId ? route.provider : undefined,
    worktree: outgoingWorktree,
    messages: res.messages,
  };
}

function parseRoute(route: string): RouteRef {
  const [provider, ...rest] = route.split(',');
  if (!provider || rest.length === 0) throw new Error(`Invalid route: ${route}`);
  return {
    provider: provider as RouteRef['provider'],
    model: rest.join(','),
    rationale: 'explicit route override',
    via: provider,
  };
}

/**
 * Probe classification used only to pick the cheapest available chat route
 * for the LLM judge. `forceCheap` short-circuits to a fast-cheap model.
 */
const JUDGE_PROBE = {
  taskType: 'trivial' as const,
  shape: {
    deepReasoning: 0,
    multiFileTaste: 0,
    hugeContext: 0,
    adversarial: 0,
    algorithmic: 0,
    exploratory: 0,
  },
  confidence: 1,
  rationale: 'classifier judge probe',
  source: 'rules' as const,
  hash: 'judge-probe',
};

/**
 * Build a cheap chat adapter to act as the classifier's stage-3 LLM judge,
 * or `undefined` when none is available. We route `forceCheap` to land on a
 * fast-cheap model (Haiku / 4o-mini / Flash) and refuse heavyweight editing
 * CLIs (`canEdit`) - spinning up Claude Code / Codex just to classify a
 * prompt would be slow and expensive, defeating the purpose.
 */
function buildCheapJudge(ctx: ModeContext): Adapter | undefined {
  try {
    const route = pick(JUDGE_PROBE, ctx.router, { forceCheap: true });
    if (!route || !route.model || route.model === 'no-vision-model') return undefined;
    const adapter = ctx.resolveAdapter
      ? ctx.resolveAdapter(route)
      : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;
    // Use a chat-only model as the judge; never a heavyweight editing CLI.
    if (adapter.capabilities.canEdit) return undefined;
    return adapter;
  } catch {
    return undefined;
  }
}

/**
 * Source-file extensions worth running lint / tsc / tests against.
 * Anything outside this set (markdown, JSON config, YAML, gitignore,
 * env files, etc.) is documentation or metadata that those validators
 * can't meaningfully check, so we skip the whole 2-3 minute pipeline
 * + potential handoff for those changes.
 *
 * Kept conservative on purpose: when in doubt, run the validators.
 * False negatives here just slow the user down; false positives let
 * a real bug ship un-validated.
 */
/**
 * Per-project-type extension whitelist. A file is "project source"
 * only if its extension matches the toolchain that will validate it.
 *
 * The point: dropping `script.py` into a Node monorepo does NOT make
 * `pnpm run lint / typecheck / test` meaningful - biome / tsc /
 * vitest can't see Python at all and just produce noise. Skip the
 * whole pipeline rather than report bogus failures.
 */
const PROJECT_EXTS: Record<ProjectType, ReadonlySet<string>> = {
  node: new Set([
    '.ts', '.tsx', '.mts', '.cts',
    '.js', '.jsx', '.mjs', '.cjs',
    '.json',
  ]),
  python: new Set(['.py', '.pyi']),
  rust: new Set(['.rs']),
  go: new Set(['.go']),
  unknown: new Set(),
};

function isProjectSource(path: string, projectType: ProjectType): boolean {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return false;
  return PROJECT_EXTS[projectType].has(path.slice(dot).toLowerCase());
}

/**
 * Quick existence check for the dependency directory the project
 * type's validators expect. The agent runs in a `git worktree` clone
 * which forks file state but NOT installed deps - so a Node project
 * worktree won't have `node_modules`, a Rust worktree won't have
 * `target/`, etc. Running validators in that state is guaranteed to
 * fail with a useless error like `pnpm: command not found` or
 * `cannot find module 'biome'`. Detect and skip cleanly instead.
 */
async function hasProjectDeps(cwd: string, projectType: ProjectType): Promise<boolean> {
  const probe = (rel: string): Promise<boolean> =>
    access(join(cwd, rel)).then(() => true, () => false);
  switch (projectType) {
    case 'node':
      return probe('node_modules');
    case 'python':
      // Python is more permissive - mypy / ruff / pytest all bootstrap
      // from the user's PATH, no per-project venv required.
      return true;
    case 'rust':
    case 'go':
      // Cargo / go fetch deps on first build; nothing to probe.
      return true;
    default:
      return false;
  }
}
