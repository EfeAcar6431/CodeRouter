import { randomUUID } from 'node:crypto';
import { exec } from '../sandbox/exec.js';
import { pickStrong } from '../routing/policy.js';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import type { Adapter } from '../adapters/types.js';
import type { RouteRef } from '../types.js';
import { noopProgress, routeProgressData } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput } from './types.js';

/**
 * Review mode: read-only diff/PR review.
 *
 * Takes the current diff against HEAD (or the configured base ref if
 * provided in `prompt`), runs it through a strong reviewer model, and
 * emits structured feedback. Never writes to the working tree.
 */
export async function runReviewMode(input: ModeInput, ctx: ModeContext): Promise<ModeOutput> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);

  progress({ phase: 'review/diff', stage: 'start' });
  const target = parseBaseRef(input.prompt);
  const diffRes = await exec('git', ['diff', target], { cwd: input.cwd, timeoutMs: 8_000 });
  if (diffRes.exitCode !== 0) {
    return {
      mode: 'review',
      status: 'failed',
      runId,
      text: `git diff ${target} failed: ${diffRes.stderr.slice(0, 500)}`,
      costUsd: 0,
      tokensIn: 0,
      tokensOut: 0,
      durationMs: performance.now() - start,
      rationale: 'review: diff unavailable',
    };
  }
  const diff = diffRes.stdout;
  progress({ phase: 'review/diff', stage: 'done', data: { bytes: diff.length } });

  const corpus = await loadSeedCorpus();
  const classifier = new ClassifierCascade({ corpus });
  const classification = await classifier.classify({ prompt: `review ${input.prompt}`, noLlm: true });
  const strong = pickStrong(classification, ctx.router, input.effort ?? 'high');
  const route: RouteRef | undefined = strong[0];
  if (!route) throw new Error('review: no strong route available');
  const adapter: Adapter = ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;

  progress({
    phase: 'review/judge',
    stage: 'start',
    data: routeProgressData(route),
  });
  const out = await adapter.run({
    prompt: [
      'Review the following diff. Produce structured feedback:',
      '',
      '## Risks',
      '## Regressions',
      '## Style / nitpicks',
      '## Missed cases',
      '',
      '```diff',
      diff.slice(0, 20_000),
      '```',
    ].join('\n'),
    reasoningEffort: 'high',
    maxTokens: 3_000,
    // Local-CLI adapters need a cwd; readOnly because review only
    // critiques the diff, it never edits.
    cwd: input.cwd,
    readOnly: true,
    signal: input.signal,
  });
  progress({ phase: 'review/judge', stage: 'done' });

  return {
    mode: 'review',
    status: 'success',
    runId,
    text: out.text,
    diff,
    classification,
    routes: [route],
    costUsd: out.costUsd,
    tokensIn: out.tokensIn,
    tokensOut: out.tokensOut,
    durationMs: performance.now() - start,
    rationale: route.rationale,
  };
}

function parseBaseRef(prompt: string): string {
  const m = /(?:against|vs\.?|base|target)\s+([\w/.-]+)/i.exec(prompt);
  if (m?.[1]) return m[1];
  return 'HEAD';
}
