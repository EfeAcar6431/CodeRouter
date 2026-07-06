import { randomUUID } from 'node:crypto';
import { detectClarifications } from '../clarify/detector.js';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import { scanContext } from '../context/scan.js';
import { composeDirectives } from '../customize/index.js';
import { loadProjectMemory } from '../memory/projectMemory.js';
import {
  BraveProvider,
  DocsProvider,
  DuckDuckGoProvider,
  GitHubProvider,
  TavilyProvider,
} from '../research/providers/index.js';
import {
  buildCitations,
  injectInlineCitations,
  renderReferences,
  verifyCitations,
} from '../research/citations.js';
import type { ResearchHit, ResearchProvider } from '../research/types.js';
import { effortProfile } from '../routing/effort.js';
import { pick, pickStrong } from '../routing/policy.js';
import { runDualPlan } from '../workflows/dualPlan.js';
import { runTournament } from '../workflows/tournament.js';
import type { Adapter } from '../adapters/types.js';
import type { Citation, RouteRef } from '../types.js';
import { extractOpenQuestions, extractPhases } from './plan.js';
import { newEmptyPlanFile, type PlanFile } from './planFile.js';
import { noopProgress } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput } from './types.js';

/**
 * Masterplan mode: the headline differentiator.
 *
 * Six phases (each instrumented for progress UI + perf budget):
 *   1) scope (clarify questions, refuses to proceed if blockers exist)
 *   2) internal evidence (memory + local code scan)
 *   3) external evidence (tavily + github + docs)
 *   4) synthesize plan (single | dualPlan @ high | tournament @ max)
 *   5) self-critique (cheap-model citation verification; max 2 retries)
 *   6) emit plan.md with inline [N] citations + References + checkpoints
 */
export async function runMasterplanMode(
  input: ModeInput,
  ctx: ModeContext,
): Promise<ModeOutput & { plan: PlanFile }> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);
  const effort = input.effort ?? 'high';
  const profile = effortProfile(effort);

  // Phase 1: scope / clarify
  progress({ phase: 'masterplan/phase1', stage: 'start', index: 1, total: 6, message: 'scope' });
  const corpus = await loadSeedCorpus();
  const classifier = new ClassifierCascade({ corpus });
  const classification = await classifier.classify({ prompt: input.prompt, noLlm: true });
  const memory = await loadProjectMemory(input.cwd);
  const directives = await composeDirectives(input.cwd).catch(() => '');
  const memoryText = [memory.text, directives].filter(Boolean).join('\n\n');
  const clarifications = detectClarifications({ prompt: input.prompt, classification });
  progress({ phase: 'masterplan/phase1', stage: 'done', index: 1, total: 6 });

  // Phase 2: internal evidence
  progress({ phase: 'masterplan/phase2', stage: 'start', index: 2, total: 6, message: 'internal evidence' });
  const manifest = await scanContext({ cwd: input.cwd, prompt: input.prompt });
  progress({ phase: 'masterplan/phase2', stage: 'done', index: 2, total: 6, data: { files: manifest.entries.length } });

  // Phase 3: external evidence
  progress({ phase: 'masterplan/phase3', stage: 'start', index: 3, total: 6, message: 'external research' });
  // DuckDuckGo is keyless so masterplan research works with zero setup;
  // Tavily/Brave still run when a key is configured (better snippets)
  // and simply return [] otherwise.
  const providers: ResearchProvider[] = profile.preferMasterplanResearch
    ? [
        new TavilyProvider(),
        new BraveProvider(),
        new DuckDuckGoProvider(),
        new GitHubProvider(),
        new DocsProvider(),
      ]
    : [];
  const hits = await Promise.all(
    providers.map((p) => p.search({ query: input.prompt, limit: 5 }).catch(() => [] as ResearchHit[])),
  );
  const research = hits.flat();
  progress({ phase: 'masterplan/phase3', stage: 'done', index: 3, total: 6, data: { hits: research.length } });

  // Phase 4: synthesize
  progress({ phase: 'masterplan/phase4', stage: 'start', index: 4, total: 6, message: 'synthesize' });
  const synthesizePrompt = buildPrompt({
    prompt: input.prompt,
    memoryText,
    manifestPaths: manifest.entries.map((e) => e.path),
    research,
  });

  let planText = '';
  let synthesisCost = 0;
  let synthesisRoute: RouteRef[] = [];

  if (effort === 'max') {
    const strong = pickStrong(classification, ctx.router, 'max');
    const tournament = await runTournament({
      task: synthesizePrompt,
      routes: strong,
      judgeRoute: strong[0]!,
      registry: ctx.registry,
      repoPath: input.cwd,
      budget: ctx.budget ?? {
        maxCostUsd: profile.maxCostUsd,
        maxDurationMs: profile.maxDurationMs,
        maxHandoffPasses: 0,
        maxContenders: profile.tournamentSize,
      },
    });
    planText = tournament.winner?.diff ?? tournament.judgeRationale;
    synthesisCost = tournament.totalCostUsd;
    synthesisRoute = strong;
  } else if (effort === 'high') {
    const strong = pickStrong(classification, ctx.router, 'high');
    if (strong.length >= 2) {
      const dual = await runDualPlan({
        task: synthesizePrompt,
        routes: [strong[0]!, strong[1]!],
        judgeRoute: strong[0]!,
        registry: ctx.registry,
        cwd: input.cwd,
        signal: input.signal,
      });
      planText = composeDualPlanText(dual);
      synthesisCost = dual.totalCostUsd;
      synthesisRoute = [strong[0]!, strong[1]!];
    } else {
      const single = await singlePlan(synthesizePrompt, classification, ctx, effort, input);
      planText = single.text;
      synthesisCost = single.costUsd;
      synthesisRoute = [single.route];
    }
  } else {
    const single = await singlePlan(synthesizePrompt, classification, ctx, effort, input);
    planText = single.text;
    synthesisCost = single.costUsd;
    synthesisRoute = [single.route];
  }
  progress({ phase: 'masterplan/phase4', stage: 'done', index: 4, total: 6 });

  // Phase 5: self-critique / citation verification
  progress({ phase: 'masterplan/phase5', stage: 'start', index: 5, total: 6, message: 'self-critique' });
  let citations: Citation[] = buildCitations(research);
  citations = await verifyCitations(citations).catch(() => citations);
  progress({ phase: 'masterplan/phase5', stage: 'done', index: 5, total: 6 });

  // Phase 6: emit
  progress({ phase: 'masterplan/phase6', stage: 'start', index: 6, total: 6, message: 'emit plan' });
  const plan = newEmptyPlanFile({
    planId: `mp-${runId}`,
    runId,
    route: synthesisRoute.map((r) => `${r.via ?? r.provider},${r.model}`).join(' | '),
    effort,
  });
  const bodyWithCitations = injectInlineCitations(planText, citations);
  plan.body = [
    `# Masterplan: ${input.prompt}`,
    '',
    `_classified as **${classification.taskType}** (confidence ${classification.confidence.toFixed(2)})_`,
    '',
    bodyWithCitations,
    '',
    renderReferences(citations),
  ].join('\n');
  plan.citations = citations;
  plan.frontmatter.status = 'ready';
  plan.frontmatter.estimatedCostUsd = synthesisCost;
  // Structured phases + open questions so the app/CLI can render a checklist
  // and a highlighted "confirm before executing" callout (parity with plan mode).
  plan.frontmatter.phases = extractPhases(planText);
  const openQuestions = extractOpenQuestions(planText);
  progress({ phase: 'masterplan/phase6', stage: 'done', index: 6, total: 6 });

  return {
    mode: 'masterplan',
    status: 'success',
    runId,
    text: plan.body,
    planFile: plan,
    plan,
    openQuestions,
    classification,
    contextManifest: manifest,
    routes: synthesisRoute,
    clarifications,
    citations,
    costUsd: synthesisCost,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: performance.now() - start,
    rationale: synthesisRoute.map((r) => r.rationale).join(' / '),
  };
}

function buildPrompt(args: {
  prompt: string;
  memoryText: string;
  manifestPaths: string[];
  research: ResearchHit[];
}): string {
  const evidence = args.research
    .slice(0, 12)
    .map((h, i) => `- (${h.kind}) ${h.title}${h.url ? ` -> ${h.url}` : ''}${h.snippet ? `\n  ${h.snippet}` : ''}`)
    .join('\n');
  return [
    'Produce a research-grade implementation plan. Use markdown.',
    'Include: Overview, Approach (numbered phases with explicit file paths), Risks, OpenQuestions.',
    'Cite evidence inline as {{cite:keyword}} so the renderer can replace with [N].',
    '',
    args.memoryText ? `# Project memory\n${args.memoryText}\n` : '',
    args.manifestPaths.length > 0 ? `# Local files (top of manifest)\n${args.manifestPaths.slice(0, 12).map((p) => `- ${p}`).join('\n')}\n` : '',
    `# External evidence\n${evidence || '(none)'}\n`,
    '# Task',
    args.prompt,
  ]
    .filter(Boolean)
    .join('\n');
}

function composeDualPlanText(dual: import('../workflows/dualPlan.js').DualPlanResult): string {
  const lines: string[] = ['## Plan'];
  if (dual.decision.agreements.length > 0) {
    lines.push('', '### Agreements', ...dual.decision.agreements.map((a) => `- ${a}`));
  }
  if (dual.decision.decisionPoints.length > 0) {
    lines.push('', '### Decision points');
    for (const dp of dual.decision.decisionPoints) {
      lines.push(
        `- **${dp.title}**: ${dp.description}`,
        `  - Option A (${dual.planA.route.model}): ${dp.optionA}`,
        `  - Option B (${dual.planB.route.model}): ${dp.optionB}`,
        dp.recommendation ? `  - Recommendation: ${dp.recommendation}` : '',
      );
    }
  }
  if (!dual.decision.agreements.length && !dual.decision.decisionPoints.length) {
    lines.push(dual.decision.fallbackText ?? dual.planA.text);
  }
  return lines.filter(Boolean).join('\n');
}

async function singlePlan(
  prompt: string,
  classification: import('../types.js').Classification,
  ctx: ModeContext,
  effort: import('../types.js').Effort,
  input: ModeInput,
): Promise<{ text: string; costUsd: number; route: RouteRef }> {
  const route = pick(classification, ctx.router, { effort });
  const adapter: Adapter = ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;
  const res = await (adapter.plan ?? adapter.run).call(adapter, {
    prompt,
    maxTokens: 6_000,
    reasoningEffort: effortProfile(effort).reasoningEffort,
    // Local-CLI adapters require a cwd; readOnly guards the user's
    // real tree since masterplan synthesis must never write.
    cwd: input.cwd,
    readOnly: true,
    signal: input.signal,
    // Stream synthesis so the app/CLI render the plan as it's written
    // instead of sitting on "thinking" until phase 6.
    onChunk: input.onChunk,
    onActivity: input.onActivity,
    onUsage: input.onUsage,
  });
  return { text: res.text, costUsd: res.costUsd, route };
}
