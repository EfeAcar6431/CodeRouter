import { randomUUID } from 'node:crypto';
import { fastClassification } from '../routing/fast.js';
import { pick, pickStrong } from '../routing/policy.js';
import {
  changedFiles,
  createWorktree,
  destroyWorktree,
  diffWorktree,
  ensureGitRepo,
  mergeWorktree,
  persistRunArtifact,
  type Worktree,
} from '../sandbox/worktree.js';
import { exec } from '../sandbox/exec.js';
import type { Classification, RouteRef } from '../types.js';
import { type LoopRunContext, resolveLoopAdapter } from './context.js';
import type {
  LoopIteration,
  LoopModelRole,
  LoopPhase,
  LoopSpec,
  LoopWorktree,
  VerifierResult,
} from './types.js';

/**
 * Loop runner.
 *
 * A deterministic control loop. The *system* owns iteration count, cost,
 * commands, file permissions, and stop conditions; the model only plans,
 * edits, and reviews. Each iteration: run the verifier; if it passes
 * we're done; otherwise plan the single highest-impact fix, edit the
 * code in an isolated worktree, optionally review, and re-verify — until
 * success or a hard limit trips.
 */

export type LoopCallbacks = {
  onPhase?: (index: number, phase: LoopPhase, message: string) => void;
  onChunk?: (index: number, text: string) => void;
  onVerifier?: (index: number, result: VerifierResult) => void;
  onIteration?: (it: LoopIteration) => void;
};

export type RunLoopResult = {
  status: 'succeeded' | 'failed' | 'stopped' | 'awaiting_approval';
  iterations: LoopIteration[];
  costUsd: number;
  filesChanged: string[];
  diff: string | null;
  applied: boolean;
  /** Present when status is awaiting_approval: the worktree to merge on approve. */
  worktree?: LoopWorktree;
  reason: string;
};

export type RunLoopOptions = {
  loopId: string;
  signal?: AbortSignal;
  callbacks?: LoopCallbacks;
  /** Polled between phases; return true to stop gracefully (pause/stop). */
  shouldStop?: () => boolean;
};

const VERIFIER_TIMEOUT_MS = 10 * 60 * 1000;

export async function runLoop(
  spec: LoopSpec,
  ctx: LoopRunContext,
  opts: RunLoopOptions,
): Promise<RunLoopResult> {
  const cb = opts.callbacks ?? {};
  const cls = fastClassification(spec.goal);
  const iterations: LoopIteration[] = [];
  let totalCost = 0;

  await ensureGitRepo(ctx.cwd, { autoInit: true });
  const wt = await createWorktree({ repoPath: ctx.cwd, runId: opts.loopId.slice(0, 8), prefix: 'loop' });

  const finish = async (
    status: RunLoopResult['status'],
    reason: string,
  ): Promise<RunLoopResult> => {
    const files = await changedFiles(wt).catch(() => []);
    const diff = await diffWorktree(wt).catch(() => '');
    if (files.length > 0) await persistRunArtifact(wt, { diff, files }).catch(() => null);

    // Successful + no approval gate -> merge into host repo automatically.
    let applied = false;
    if (status === 'succeeded' && !spec.safety.requireApprovalBeforeCommit && files.length > 0) {
      try {
        await mergeWorktree(wt, { cleanup: false });
        applied = true;
      } catch {
        applied = false;
      }
    }

    if (status === 'succeeded' && spec.safety.requireApprovalBeforeCommit && files.length > 0) {
      // Keep the worktree alive so the daemon can merge on approval.
      return {
        status: 'awaiting_approval',
        iterations,
        costUsd: totalCost,
        filesChanged: files,
        diff,
        applied: false,
        worktree: toHandle(wt),
        reason: 'verifier passed; awaiting commit approval',
      };
    }

    await destroyWorktree(wt).catch(() => {});
    return { status, iterations, costUsd: totalCost, filesChanged: files, diff, applied, reason };
  };

  // Build verifier env (best-effort network gate).
  const env = spec.safety.allowNetwork ? undefined : networkBlockedEnv();

  // --- iteration 0: verify current state ----------------------------
  cb.onPhase?.(0, 'verify', 'running verifier on current state');
  let lastVerify = await runVerifier(spec.verifier.commands, wt.path, env, opts.signal, (r) =>
    cb.onVerifier?.(0, r),
  );
  iterations.push(
    record(opts.loopId, 0, 'verify', verdict(lastVerify), lastVerify, null, '', 0, cb),
  );
  if (allPass(lastVerify)) return finish('succeeded', 'verifier already passing');
  if (opts.signal?.aborted || opts.shouldStop?.()) return finish('stopped', 'stopped before edits');

  // --- fix iterations ------------------------------------------------
  for (let i = 1; i <= spec.limits.maxIterations; i++) {
    if (opts.signal?.aborted || opts.shouldStop?.()) return finish('stopped', `stopped at iteration ${i}`);
    if (totalCost >= spec.limits.maxCostUsd) return finish('failed', 'cost limit reached');

    const failureText = summarizeFailures(lastVerify);

    // plan: one focused fix (strong, read-only)
    cb.onPhase?.(i, 'plan', 'analyzing failure and planning a fix');
    let plan = '';
    try {
      const planRoute = routeForRole(spec.models.planner, cls, ctx, false);
      const planAdapter = resolveLoopAdapter(planRoute, ctx);
      const res = await (planAdapter.plan ?? planAdapter.run).call(planAdapter, {
        prompt: planPrompt(spec, failureText, diffSoFar(iterations)),
        cwd: wt.path,
        readOnly: true,
        maxTokens: 1_500,
        reasoningEffort: 'high',
        signal: opts.signal,
        onChunk: (c) => cb.onChunk?.(i, c),
      });
      totalCost += res.costUsd;
      plan = res.text?.trim() || 'Fix the highest-impact failing check with the smallest change.';
    } catch {
      plan = 'Fix the highest-impact failing check with the smallest change.';
    }

    if (opts.signal?.aborted || opts.shouldStop?.()) return finish('stopped', `stopped at iteration ${i}`);

    // edit: apply the fix (coding, edit-capable)
    cb.onPhase?.(i, 'edit', 'editing code');
    let editCost = 0;
    try {
      const editRoute = routeForRole(spec.models.executor, cls, ctx, true);
      const editAdapter = resolveLoopAdapter(editRoute, ctx);
      if (!editAdapter.capabilities.canEdit) {
        return finish('failed', `executor route ${editRoute.provider}:${editRoute.model} cannot edit files`);
      }
      const res = await editAdapter.run({
        prompt: editPrompt(spec, plan, failureText),
        cwd: wt.path,
        reasoningEffort: 'medium',
        signal: opts.signal,
        onChunk: (c) => cb.onChunk?.(i, c),
      });
      editCost = res.costUsd;
      totalCost += res.costUsd;
    } catch (err) {
      if (opts.signal?.aborted) return finish('stopped', 'aborted during edit');
      return finish('failed', `edit failed: ${(err as Error).message}`);
    }

    // safety gate: blocked files + file budget
    const files = await changedFiles(wt).catch(() => []);
    const blocked = files.filter((f) => isBlocked(f, spec.safety.blockedFiles));
    if (blocked.length > 0) {
      return finish('failed', `edit touched blocked file(s): ${blocked.join(', ')}`);
    }
    if (spec.safety.allowedPaths.length > 0) {
      const outside = files.filter((f) => !spec.safety.allowedPaths.some((p) => f.startsWith(p.replace(/\/$/, ''))));
      if (outside.length > 0) {
        return finish('failed', `edit touched paths outside allowed set: ${outside.join(', ')}`);
      }
    }
    if (files.length > spec.limits.maxFilesChanged) {
      return finish('failed', `changed ${files.length} files, exceeding budget of ${spec.limits.maxFilesChanged}`);
    }

    const iterDiff = await diffWorktree(wt).catch(() => '');

    // review: lightweight patch review (strong, read-only) — advisory
    cb.onPhase?.(i, 'review', 'reviewing patch');
    try {
      const reviewRoute = routeForRole(spec.models.reviewer, cls, ctx, false);
      const reviewAdapter = resolveLoopAdapter(reviewRoute, ctx);
      const res = await (reviewAdapter.plan ?? reviewAdapter.run).call(reviewAdapter, {
        prompt: reviewPrompt(spec, iterDiff),
        cwd: wt.path,
        readOnly: true,
        maxTokens: 800,
        reasoningEffort: 'low',
        signal: opts.signal,
      });
      totalCost += res.costUsd;
    } catch {
      // review is advisory; ignore failures
    }

    // re-verify
    cb.onPhase?.(i, 'verify', 'running verifier');
    lastVerify = await runVerifier(spec.verifier.commands, wt.path, env, opts.signal, (r) =>
      cb.onVerifier?.(i, r),
    );
    const it = record(opts.loopId, i, 'verify', verdict(lastVerify), lastVerify, iterDiff, plan, editCost, cb);
    iterations.push(it);

    if (allPass(lastVerify)) return finish('succeeded', `verifier passed after ${i} iteration(s)`);
  }

  return finish('failed', `verifier still failing after ${spec.limits.maxIterations} iterations`);
}

/** Merge an awaiting-approval loop's worktree into the host repo. */
export async function approveLoopWorktree(wt: LoopWorktree): Promise<{ applied: boolean; error?: string }> {
  try {
    await mergeWorktree(wt as Worktree, { cleanup: true });
    return { applied: true };
  } catch (e) {
    return { applied: false, error: (e as Error).message };
  }
}

/** Discard an awaiting-approval loop's worktree (reject). */
export async function discardLoopWorktree(wt: LoopWorktree): Promise<void> {
  await destroyWorktree(wt as Worktree).catch(() => {});
}

// ---- routing -------------------------------------------------------

function routeForRole(
  role: LoopModelRole,
  cls: Classification,
  ctx: LoopRunContext,
  editable: boolean,
): RouteRef {
  if (role === 'cheap') {
    return pick(cls, ctx.router, { forceCheap: true, requireEditable: editable });
  }
  if ((role === 'frontier' || role === 'strong' || role === 'reviewer') && !editable) {
    const strong = pickStrong(cls, ctx.router, role === 'frontier' ? 'max' : 'high');
    if (strong.length > 0) return strong[0]!;
  }
  const effort = role === 'frontier' ? 'high' : 'medium';
  return pick(cls, ctx.router, { effort, requireEditable: editable });
}

// ---- verifier ------------------------------------------------------

async function runVerifier(
  commands: string[],
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  signal: AbortSignal | undefined,
  onResult?: (r: VerifierResult) => void,
): Promise<VerifierResult[]> {
  const results: VerifierResult[] = [];
  for (const command of commands) {
    if (signal?.aborted) break;
    const [cmd, args] = shellInvocation(command);
    let res: { stdout: string; stderr: string; exitCode: number; durationMs: number };
    try {
      res = await exec(cmd, args, { cwd, env, signal, timeoutMs: VERIFIER_TIMEOUT_MS });
    } catch (err) {
      if ((err as Error).name === 'AbortError') break;
      res = { stdout: '', stderr: (err as Error).message, exitCode: 1, durationMs: 0 };
    }
    const result: VerifierResult = {
      command,
      exitCode: res.exitCode,
      ok: res.exitCode === 0,
      durationMs: res.durationMs,
      output: tail(`${res.stdout}\n${res.stderr}`, 8_000),
    };
    results.push(result);
    onResult?.(result);
    // Stop at the first failing command — that's the one to fix next.
    if (!result.ok) break;
  }
  return results;
}

function shellInvocation(command: string): [string, string[]] {
  if (process.platform === 'win32') return ['cmd', ['/c', command]];
  return ['/bin/sh', ['-c', command]];
}

function allPass(results: VerifierResult[]): boolean {
  return results.length > 0 && results.every((r) => r.ok);
}

function verdict(results: VerifierResult[]): LoopIteration['status'] {
  return allPass(results) ? 'pass' : 'fail';
}

function summarizeFailures(results: VerifierResult[]): string {
  const failing = results.filter((r) => !r.ok);
  if (failing.length === 0) return '(no failures captured)';
  return failing.map((r) => `$ ${r.command}\n(exit ${r.exitCode})\n${tail(r.output, 4_000)}`).join('\n\n');
}

// ---- prompts -------------------------------------------------------

function planPrompt(spec: LoopSpec, failureText: string, priorDiff: string): string {
  return [
    'You are the planner in a self-verifying fix loop. Decide the SINGLE highest-impact',
    'change to make next. Be specific and minimal. Do not edit anything — just plan.',
    '',
    `GOAL: ${spec.goal}`,
    '',
    'CURRENT VERIFIER FAILURE:',
    failureText,
    priorDiff ? `\nCHANGES MADE SO FAR (diff):\n${tail(priorDiff, 3_000)}` : '',
    '',
    'Respond with a short, concrete instruction for the executor (1-5 sentences).',
  ].join('\n');
}

function editPrompt(spec: LoopSpec, plan: string, failureText: string): string {
  return [
    'You are executing ONE focused fix in a self-verifying loop. Make the smallest safe',
    'change that addresses the failure. Edit only the files you need.',
    '',
    `GOAL: ${spec.goal}`,
    '',
    'PLANNED FIX:',
    plan,
    '',
    'VERIFIER FAILURE YOU MUST ADDRESS:',
    failureText,
    '',
    spec.safety.blockedFiles.length
      ? `NEVER edit these files: ${spec.safety.blockedFiles.join(', ')}.`
      : '',
    'Make the file changes now.',
  ].join('\n');
}

function reviewPrompt(spec: LoopSpec, diff: string): string {
  return [
    'Review this patch for correctness and scope. Flag anything risky in 1-3 bullets.',
    `GOAL: ${spec.goal}`,
    '',
    'PATCH:',
    tail(diff, 4_000) || '(no diff)',
  ].join('\n');
}

// ---- helpers -------------------------------------------------------

function diffSoFar(iterations: LoopIteration[]): string {
  for (let i = iterations.length - 1; i >= 0; i--) {
    if (iterations[i]!.diff) return iterations[i]!.diff!;
  }
  return '';
}

function record(
  loopId: string,
  index: number,
  phase: LoopPhase,
  status: LoopIteration['status'],
  verifier: VerifierResult[],
  diff: string | null,
  summary: string,
  costUsd: number,
  cb: LoopCallbacks,
): LoopIteration {
  const it: LoopIteration = {
    id: randomUUID(),
    loopId,
    index,
    runId: null,
    phase,
    status,
    verifier,
    diff,
    summary,
    costUsd,
    createdAt: Date.now(),
  };
  cb.onIteration?.(it);
  return it;
}

function toHandle(wt: Worktree): LoopWorktree {
  return {
    runId: wt.runId,
    branch: wt.branch,
    path: wt.path,
    baseRef: wt.baseRef,
    baseSha: wt.baseSha,
    repoPath: wt.repoPath,
    createdAt: wt.createdAt,
  };
}

/**
 * Glob-ish matcher for blocked files. Supports `*` wildcards and matches
 * against both the full repo-relative path and the basename, so a rule
 * like `.env` blocks `config/.env` and `*.pem` blocks `keys/server.pem`.
 */
export function isBlocked(file: string, patterns: string[]): boolean {
  const base = file.split('/').pop() ?? file;
  for (const raw of patterns) {
    const pat = raw.trim();
    if (!pat) continue;
    if (pat.includes('*')) {
      const re = new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
      if (re.test(file) || re.test(base)) return true;
    } else if (file === pat || base === pat || file.endsWith(`/${pat}`)) {
      return true;
    }
  }
  return false;
}

function networkBlockedEnv(): NodeJS.ProcessEnv {
  // Best-effort: many tools honor these. True isolation needs OS sandboxing.
  return {
    ...process.env,
    HTTP_PROXY: 'http://127.0.0.1:0',
    HTTPS_PROXY: 'http://127.0.0.1:0',
    http_proxy: 'http://127.0.0.1:0',
    https_proxy: 'http://127.0.0.1:0',
    NO_PROXY: '',
  };
}

function tail(s: string, max: number): string {
  if (s.length <= max) return s.trim();
  return s.slice(s.length - max).trim();
}
