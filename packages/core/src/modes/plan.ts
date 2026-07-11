import { randomUUID } from 'node:crypto';
import { detectClarifications } from '../clarify/detector.js';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import { scanContext } from '../context/scan.js';
import { composeDirectives } from '../customize/index.js';
import { loadProjectMemory } from '../memory/projectMemory.js';
import { pick } from '../routing/policy.js';
import { effortProfile } from '../routing/effort.js';
import type { Adapter } from '../adapters/types.js';
import type { RouteRef } from '../types.js';
import { newEmptyPlanFile, type PlanFile } from './planFile.js';
import { noopProgress, routeProgressData } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput } from './types.js';

/**
 * Plan mode.
 *
 *   Phase 1: clarify (skipped when nothing is ambiguous)
 *   Phase 4: synthesize via single-model `plan(task)`
 *   Phase 6: emit a plain-markdown plan with a phased structure
 *
 * Escalates to Masterplan via the returned `escalationHint` when the
 * detector fires; the CLI / MCP layer surfaces a one-time nudge. Plan
 * mode never executes code - the resulting plan file is a recipe a
 * subsequent `agent_run` or `coderouter execute <id>` invocation runs.
 */
export async function runPlanMode(input: ModeInput, ctx: ModeContext): Promise<ModeOutput & {
  escalationHint?: string;
}> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);

  progress({ phase: 'plan/phase1', stage: 'start', index: 1, total: 3, message: 'clarify' });
  const corpus = await loadSeedCorpus();
  const classifier = new ClassifierCascade({ corpus });
  const classification = await classifier.classify({ prompt: input.prompt, cwd: input.cwd, noLlm: true });

  const memory = await loadProjectMemory(input.cwd);
  const directives = await composeDirectives(input.cwd).catch(() => '');
  const memoryText = [memory.text, directives].filter(Boolean).join('\n\n');
  const clarifications = detectClarifications({ prompt: input.prompt, classification });
  progress({ phase: 'plan/phase1', stage: 'done', index: 1, total: 3 });

  const manifest = input.fast
    ? { entries: [], totalTokens: 0, budget: 0, truncated: false }
    : await scanContext({ cwd: input.cwd, prompt: input.prompt });

  progress({ phase: 'plan/phase4', stage: 'start', index: 2, total: 3, message: 'synthesize' });
  const route = input.route
    ? parseRoute(input.route)
    : pick(classification, ctx.router, { effort: input.effort ?? 'medium' });
  // Emit the chosen model BEFORE the adapter streams so the REPL can
  // stamp every tool/text block + the spinner with the route label.
  progress({
    phase: 'plan/phase4',
    stage: 'progress',
    index: 2,
    total: 3,
    message: 'synthesize',
    data: routeProgressData(route),
  });
  const adapter: Adapter = ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;

  const profile = effortProfile(input.effort ?? 'medium');
  const planPrompt = buildPlannerPrompt({
    prompt: input.prompt,
    memoryText,
    manifestPaths: manifest.entries.map((e) => e.path),
  });
  const res = await (adapter.plan ?? adapter.run).call(adapter, {
    prompt: planPrompt,
    maxTokens: 4_000,
    reasoningEffort: profile.reasoningEffort,
    // Local-CLI adapters (Claude Code / Codex) need a cwd to run in,
    // and giving them the actual repo lets the planner read real
    // code instead of planning blind. readOnly keeps them from
    // mutating anything - plan mode must never write.
    cwd: input.cwd,
    readOnly: true,
    signal: input.signal,
    onChunk: input.onChunk,
    onActivity: input.onActivity,
    onUsage: input.onUsage,
  });
  progress({ phase: 'plan/phase4', stage: 'done', index: 2, total: 3 });

  progress({ phase: 'plan/phase6', stage: 'start', index: 3, total: 3, message: 'emit' });
  const planFile = newEmptyPlanFile({
    planId: `plan-${runId}`,
    runId,
    route: `${route.via ?? route.provider},${route.model}`,
    effort: input.effort ?? 'medium',
  });
  planFile.body = renderPlanBody({
    prompt: input.prompt,
    planText: res.text,
    classification,
    manifestPaths: manifest.entries.map((e) => e.path),
    route,
  });
  planFile.frontmatter.status = 'ready';
  planFile.frontmatter.estimatedCostUsd = res.costUsd;
  planFile.frontmatter.phases = extractPhases(res.text);
  const openQuestions = extractOpenQuestions(res.text);
  progress({ phase: 'plan/phase6', stage: 'done', index: 3, total: 3 });

  const escalationHint = detectEscalation(input.prompt, classification, manifest.entries.length);

  return {
    mode: 'plan',
    status: 'success',
    runId,
    text: planFile.body,
    planFile,
    openQuestions,
    classification,
    contextManifest: manifest,
    routes: [route],
    clarifications,
    costUsd: res.costUsd,
    tokensIn: res.tokensIn,
    tokensOut: res.tokensOut,
    durationMs: performance.now() - start,
    rationale: route.rationale,
    escalationHint,
  };
}

function buildPlannerPrompt(args: { prompt: string; memoryText: string; manifestPaths: string[] }): string {
  return [
    'You are CodeRouter Plan mode. Produce a focused implementation plan as numbered phases.',
    'Each phase MUST include a short title, a 1-2 sentence intent, and concrete files to touch.',
    'No code blocks. Mark open questions explicitly as "OPEN:".',
    '',
    args.memoryText ? `# Project memory\n${args.memoryText}` : '',
    args.manifestPaths.length > 0
      ? `# Likely files (from repo scan)\n${args.manifestPaths.slice(0, 15).map((p) => `- ${p}`).join('\n')}`
      : '',
    '',
    '# Task',
    args.prompt,
  ]
    .filter(Boolean)
    .join('\n');
}

function renderPlanBody(args: {
  prompt: string;
  planText: string;
  classification: import('../types.js').Classification;
  manifestPaths: string[];
  route: RouteRef;
}): string {
  return [
    '## Task',
    args.prompt,
    '',
    `_classified as **${args.classification.taskType}** by ${args.classification.source}; route: ${args.route.via ?? args.route.provider},${args.route.model}_`,
    '',
    '## Plan',
    args.planText.trim(),
    '',
    '## Files referenced',
    args.manifestPaths.length === 0 ? '_(none)_' : args.manifestPaths.slice(0, 20).map((p) => `- ${p}`).join('\n'),
  ].join('\n');
}

/**
 * Pull out the planner's explicitly-flagged open questions - lines marked
 * `OPEN:` (optionally as a list item or bold). These are decisions the plan
 * couldn't resolve on its own; the UI highlights them so the user confirms
 * before execution. De-duplicated, trailing markdown emphasis stripped.
 */
export function extractOpenQuestions(text: string): string[] {
  const re = /^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*OPEN\s*(?:\*\*|__)?\s*:\s*(.+?)\s*$/gim;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    const q = (m[1] ?? '').replace(/\*\*|__/g, '').trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
    m = re.exec(text);
  }
  return out;
}

export function extractPhases(text: string): import('./planFile.js').PlanPhase[] {
  const phases: import('./planFile.js').PlanPhase[] = [];
  const lineRe = /^\s*(?:Phase\s*)?(\d+)[\).:]\s*(.+)$/gm;
  let m: RegExpExecArray | null = lineRe.exec(text);
  while (m !== null) {
    const idx = m[1];
    const title = m[2]?.trim();
    if (idx && title) {
      phases.push({
        id: `phase-${idx}`,
        title,
        intent: title,
        status: 'pending',
      });
    }
    m = lineRe.exec(text);
  }
  return phases;
}

const ESCALATION_PATTERNS = [
  /\b(architecture|architect|design|migrat|integrat|tradeoff|trade-?offs)\b/i,
  /\b(?:Stripe|OAuth|SSO|Postgres|Redis|S3|Kafka|GraphQL)\b/i,
];

function detectEscalation(
  prompt: string,
  classification: import('../types.js').Classification,
  fileCount: number,
): string | undefined {
  if (fileCount > 15) return 'Touches a lot of files; Masterplan mode would research first.';
  if (classification.shape.deepReasoning > 0.85 || classification.shape.exploratory > 0.85) {
    return 'High-stakes / exploratory shape detected; try `coderouter --mp "..."` for the deep-research pipeline.';
  }
  for (const p of ESCALATION_PATTERNS) {
    if (p.test(prompt)) return 'Mentions third-party services or architectural language; Masterplan mode is recommended.';
  }
  return undefined;
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
