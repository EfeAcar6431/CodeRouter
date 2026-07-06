import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import { scanContext } from '../context/scan.js';
import { exec } from '../sandbox/exec.js';
import { pickStrong } from '../routing/policy.js';
import { runTournament } from '../workflows/tournament.js';
import type { Adapter } from '../adapters/types.js';
import type { RouteRef } from '../types.js';
import { noopProgress } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput } from './types.js';

/**
 * Debug mode.
 *
 *   1) Evidence gathering: stack traces, recent commits, suspect files.
 *   2) Hypothesis generation: deep-reasoning-biased route(s). At
 *      effort=max, runs a hypothesis tournament across GPT-5 reasoning,
 *      Opus, and DeepSeek-Reasoner.
 *   3) Emits a hypothesis tree to `.coderouter/debug/<runId>.md`.
 */
export async function runDebugMode(input: ModeInput, ctx: ModeContext): Promise<ModeOutput> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);
  const effort = input.effort ?? 'high';

  progress({ phase: 'debug/evidence', stage: 'start' });
  const corpus = await loadSeedCorpus();
  const classifier = new ClassifierCascade({ corpus });
  const classification = await classifier.classify({ prompt: input.prompt, noLlm: true });

  const recentCommits = await exec(
    'git',
    ['log', '--oneline', '-n', '20'],
    { cwd: input.cwd, timeoutMs: 5_000 },
  ).catch(() => null);
  const manifest = await scanContext({ cwd: input.cwd, prompt: input.prompt });
  progress({ phase: 'debug/evidence', stage: 'done', data: { files: manifest.entries.length } });

  const evidence = [
    '## Evidence',
    '',
    `Prompt: ${input.prompt}`,
    '',
    `Recent commits:\n${recentCommits?.stdout.slice(0, 1_500) ?? '(unavailable)'}`,
    '',
    `Suspect files (top of manifest):\n${manifest.entries
      .slice(0, 12)
      .map((e) => `- ${e.path} (${e.reason})`)
      .join('\n')}`,
  ].join('\n');

  progress({ phase: 'debug/hypothesis', stage: 'start' });
  const strong = pickStrong({ ...classification, shape: { ...classification.shape, deepReasoning: Math.max(classification.shape.deepReasoning, 0.85) } }, ctx.router, effort);

  let hypothesisText = '';
  let routes: RouteRef[] = [];
  let cost = 0;

  if (effort === 'max' && strong.length >= 2) {
    const t = await runTournament({
      task: `${evidence}\n\nGenerate 3 ranked hypotheses for the root cause. For each: claim, supporting evidence, recommended next probe.`,
      routes: strong,
      judgeRoute: strong[0]!,
      registry: ctx.registry,
      repoPath: input.cwd,
      budget: ctx.budget ?? {
        maxCostUsd: 5,
        maxDurationMs: 600_000,
        maxHandoffPasses: 0,
        maxContenders: strong.length,
      },
    });
    hypothesisText = t.winner?.diff ?? t.judgeRationale;
    routes = strong;
    cost = t.totalCostUsd;
  } else {
    const route = strong[0] ?? pickStrong(classification, ctx.router, effort)[0];
    if (!route) throw new Error('debug: no strong route available');
    const adapter: Adapter = ctx.resolveAdapter
      ? ctx.resolveAdapter(route)
      : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;
    const res = await adapter.run({
      prompt: `${evidence}\n\nGenerate 3 ranked hypotheses for the root cause. For each include claim, supporting evidence, and recommended next probe.`,
      reasoningEffort: 'high',
      maxTokens: 3_000,
      // Local-CLI adapters need a cwd; readOnly because debug mode
      // investigates, it doesn't fix.
      cwd: input.cwd,
      readOnly: true,
      signal: input.signal,
    });
    hypothesisText = res.text;
    routes = [route];
    cost = res.costUsd;
  }
  progress({ phase: 'debug/hypothesis', stage: 'done' });

  const out = [
    `# Debug ${runId}`,
    '',
    evidence,
    '',
    '## Hypotheses',
    hypothesisText,
  ].join('\n');

  const dest = join(input.cwd, '.coderouter', 'debug', `${runId}.md`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, out, 'utf8');

  return {
    mode: 'debug',
    status: 'success',
    runId,
    text: out,
    classification,
    contextManifest: manifest,
    routes,
    costUsd: cost,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: performance.now() - start,
    rationale: routes.map((r) => r.rationale).join(' / '),
  };
}
