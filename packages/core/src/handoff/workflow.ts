import type { Adapter } from '../adapters/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { pick, type RouterContext } from '../routing/policy.js';
import type { Worktree } from '../sandbox/worktree.js';
import { diffWorktree } from '../sandbox/worktree.js';
import { runValidators, summarize, type ValidatorSpec } from '../validate/run.js';
import type {
  Classification,
  Effort,
  RouteRef,
  RunBudget,
  RunOutcome,
  ValidatorResult,
} from '../types.js';
import { buildBrief, renderBriefAsPrompt } from './brief.js';

/** Effort ladder, low -> max, used to escalate the fixer one tier at a time. */
const EFFORT_ORDER: Effort[] = ['low', 'medium', 'high', 'max'];

function bumpEffort(e: Effort, steps = 1): Effort {
  const i = EFFORT_ORDER.indexOf(e);
  const next = Math.min(EFFORT_ORDER.length - 1, Math.max(0, i) + steps);
  return EFFORT_ORDER[next] ?? e;
}

export type HandoffOptions = {
  registry: ProviderRegistry;
  router: RouterContext;
  /** Mode: handoff-fix delegates failures to a cheap fixer; handoff-review asks for a second opinion. */
  mode: 'fix' | 'review';
  worktree: Worktree;
  classification: Classification;
  originalPrompt: string;
  /** Validators to run after each pass. */
  validators?: ValidatorSpec[];
  /**
   * Pre-computed validator results from the caller. When provided
   * we skip the redundant first validator pass at the top of
   * runHandoff - the caller (agent mode) just ran them, re-running
   * the full suite costs another 2-3 minutes on a multi-package
   * monorepo for zero new information.
   */
  initialValidators?: ValidatorResult[];
  /** The route that produced the work we're handing off from. */
  fromRoute: RouteRef;
  /**
   * The run's effort. Drives fixer escalation: the first fix pass tries a
   * cheap route (FrugalGPT-style cheap-first), and subsequent passes climb
   * one tier at a time - the run's effort on pass 2, then a bump toward
   * frontier on pass 3+ - so persistent failures get progressively stronger
   * models instead of hammering the same cheap one. Bounded by the effort
   * profile's pass/cost/time caps. Defaults to 'medium'.
   */
  effort?: Effort;
  /** Budget caps; passes stop when exhausted. */
  budget: RunBudget;
  /** Reviewer route (handoff-review) - if provided, used instead of picking. */
  reviewerRoute?: RouteRef;
  /** Persistent forbidden patterns from L5. */
  memoryForbidden?: string[];
  /**
   * Abort signal for ESC-while-busy. Threaded through to the inner
   * adapter call AND the post-pass validator run so cancellation is
   * actually responsive instead of waiting out a hung subprocess.
   */
  signal?: AbortSignal;
};

export type HandoffResult = {
  passes: HandoffPassResult[];
  finalValidators: ValidatorResult[];
  status: RunOutcome['status'];
  totalCostUsd: number;
};

export type HandoffPassResult = {
  pass: number;
  route: RouteRef;
  briefSummary: string;
  validators: ValidatorResult[];
  costUsd: number;
  durationMs: number;
};

/**
 * Runs one or more handoff passes against a worktree.
 *
 *   handoff-fix: pick a cheap capable fixer, repeat up to budget.maxHandoffPasses
 *                while validators still fail. Each pass receives a fresh brief
 *                summarising remaining failures.
 *
 *   handoff-review: single pass; reviewer's job is to comment, not to edit.
 *                   We capture the reviewer's response in `briefSummary`.
 *
 * Adapter selection: if `mode==='fix'` we ask the router for a cheap
 * route; if `mode==='review'` we use `reviewerRoute` when provided, else
 * a strong route from the router.
 */
export async function runHandoff(opts: HandoffOptions): Promise<HandoffResult> {
  const startedAt = performance.now();
  const passes: HandoffPassResult[] = [];
  let totalCostUsd = 0;

  // First validator pass: trust the caller's pre-computed result
  // when given. The agent mode ALWAYS runs validators right before
  // calling us - re-running the entire suite from scratch here would
  // cost another 2-3 minutes on a typical monorepo for zero new
  // information. Only fall back to running them ourselves when the
  // caller didn't pre-compute (review mode, tests, etc.).
  let validators: ValidatorResult[] =
    opts.initialValidators ??
    (await runValidators({
      cwd: opts.worktree.path,
      validators: opts.validators,
      signal: opts.signal,
    }));
  let status: RunOutcome['status'] = summarize(validators).status === 'pass' ? 'success' : 'partial';

  const maxPasses = opts.mode === 'review' ? 1 : opts.budget.maxHandoffPasses;
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (opts.mode === 'fix' && summarize(validators).status === 'pass') {
      status = 'success';
      break;
    }
    if (totalCostUsd >= opts.budget.maxCostUsd) {
      status = 'partial';
      break;
    }
    // Hard time budget. The maxDurationMs field used to live only
    // in the brief shown to the model; nothing actually cut us off
    // when the LLM took 5+ minutes per call. Now we enforce it as
    // a wall-clock cap and bail with whatever validators we last
    // observed so the caller still gets a coherent report.
    if (performance.now() - startedAt >= opts.budget.maxDurationMs) {
      status = 'partial';
      break;
    }
    if (opts.signal?.aborted) {
      status = 'partial';
      break;
    }

    const route =
      opts.mode === 'review'
        ? opts.reviewerRoute ?? pickReviewerRoute(opts)
        : pickFixerRoute(opts, pass);
    const priorDiff = await diffWorktree(opts.worktree).catch(() => undefined);
    const brief = buildBrief({
      intent:
        opts.mode === 'review'
          ? 'Review the diff and surface risks, regressions, and missed cases.'
          : 'Fix the remaining validator failures using the smallest viable change.',
      originalPrompt: opts.originalPrompt,
      fromRoute: opts.fromRoute,
      toRoute: route,
      reason: opts.mode === 'review' ? 'post-write second opinion' : 'residual validator failures',
      validators,
      priorDiff,
      scopeFiles:
        opts.mode === 'review'
          ? undefined
          : [...new Set(validators.flatMap((v) => v.failures).map((f) => f.file ?? '').filter(Boolean))],
      budget: opts.budget,
      memoryForbidden: opts.memoryForbidden,
    });

    const adapter = resolveAdapter(opts.registry, route);
    const t0 = performance.now();
    const out = await adapter.run({
      prompt: renderBriefAsPrompt(brief),
      cwd: opts.worktree.path,
      signal: opts.signal,
    });
    const durationMs = performance.now() - t0;
    totalCostUsd += out.costUsd;

    if (opts.mode === 'fix') {
      // Subset re-validation: only re-run the validators that
      // previously failed. If lint failed but tsc + tests passed,
      // there's no point re-running tsc + tests after every fixer
      // pass - they were already green and we'd burn another 2-3
      // minutes. The unfailed validators carry forward as-is.
      const failedNames = new Set(
        validators.filter((v) => v.status === 'fail').map((v) => v.name),
      );
      const subsetSpecs = opts.validators?.filter((s) => failedNames.has(s.name));
      const reRun =
        subsetSpecs && subsetSpecs.length > 0
          ? await runValidators({
              cwd: opts.worktree.path,
              validators: subsetSpecs,
              signal: opts.signal,
            })
          : await runValidators({
              cwd: opts.worktree.path,
              validators: opts.validators,
              signal: opts.signal,
            }).then((all) => all.filter((v) => failedNames.has(v.name)));
      // Merge: previously-passing validators keep their pass; the
      // re-run results overwrite their counterparts.
      const byName = new Map(validators.map((v) => [v.name, v]));
      for (const v of reRun) byName.set(v.name, v);
      validators = [...byName.values()];
    }

    passes.push({
      pass,
      route,
      briefSummary: out.text.slice(0, 600),
      validators: opts.mode === 'fix' ? validators : [],
      costUsd: out.costUsd,
      durationMs,
    });

    if (opts.mode === 'review') break;
  }

  if (summarize(validators).status === 'pass') status = 'success';
  else if (summarize(validators).status === 'fail' && passes.length >= maxPasses) status = 'partial';

  return {
    passes,
    finalValidators: validators,
    status,
    totalCostUsd,
  };
}

function pickFixerRoute(opts: HandoffOptions, pass: number): RouteRef {
  // Cheap-first cascade: pass 1 tries the cheapest capable fixer. If that
  // didn't clear the validators, escalate one tier per pass (run effort on
  // pass 2, a bump toward frontier on pass 3+), bounded by the budget's
  // pass cap. Editable-only so the escalated model can actually patch files.
  if (pass <= 1) {
    return pick(opts.classification, opts.router, { forceCheap: true, requireEditable: true });
  }
  const base = opts.effort ?? 'medium';
  const escalated = pass >= 3 ? bumpEffort(base) : base;
  return pick(opts.classification, opts.router, { effort: escalated, requireEditable: true });
}

function pickReviewerRoute(opts: HandoffOptions): RouteRef {
  return pick(opts.classification, opts.router, { effort: 'high' });
}

function resolveAdapter(registry: ProviderRegistry, ref: RouteRef): Adapter {
  const route = `${ref.via ?? ref.provider},${ref.model}`;
  return registry.resolve(route).adapter;
}
