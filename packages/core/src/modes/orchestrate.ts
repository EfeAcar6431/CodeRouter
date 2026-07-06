import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { Adapter } from '../adapters/types.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { EDITABLE_ADAPTERS } from '../catalog/resolve.js';
import { ClassifierCascade, loadSeedCorpus } from '../classify/index.js';
import { composeDirectives, loadSubagents, matchSubagent, type Subagent } from '../customize/index.js';
import { runHandoff } from '../handoff/workflow.js';
import { effortProfile } from '../routing/effort.js';
import { fastClassification } from '../routing/fast.js';
import { pick, pickStrong } from '../routing/policy.js';
import {
  changedFiles,
  commitWorktreeState,
  createWorktree,
  destroyWorktree,
  diffWorktree,
  ensureGitRepo,
  mergeWorktree,
  persistRunArtifact,
  type Worktree,
} from '../sandbox/worktree.js';
import { scanText as scanForInjection } from '../security/injection.js';
import type { Classification, Effort, RouteRef, TaskType, ValidatorResult } from '../types.js';
import { detectProject, type ProjectType } from '../validate/detect.js';
import { runValidators, summarize } from '../validate/run.js';
import { noopProgress } from './progress.js';
import type { ModeContext, ModeInput, ModeOutput, WorktreeHandle } from './types.js';

/**
 * Orchestrate mode: hierarchical plan -> delegate.
 *
 * A strong "lead" model decomposes the goal into typed sub-tasks; each
 * sub-task is then routed *independently* and executed by the most
 * appropriate model in a single shared worktree:
 *
 *   - architecture / design / feature / bugfix / refactor -> the big
 *     models (frontier, via the quality-first router at high/medium
 *     effort).
 *   - test / docs / mechanical boilerplate -> the cheap tier
 *     (force-cheap, still tools-capable so it can actually edit).
 *
 * Every execution route is constrained to `EDITABLE_ADAPTERS` so a
 * chat-only model is never handed a job that must write files. The
 * cumulative diff is validated once at the end (with an optional
 * handoff-fix pass), then applied/merged like agent mode.
 */
export type SubtaskKind =
  | 'architecture'
  | 'feature'
  | 'bugfix'
  | 'refactor'
  | 'test'
  | 'docs'
  | 'mechanical';

export type Subtask = {
  id: string;
  title: string;
  kind: SubtaskKind;
  details: string;
  dependsOn: string[];
  /** Optional subagent name the planner assigned to this sub-task. */
  subagent?: string;
};

export type SubtaskRun = {
  subtask: Subtask;
  route: RouteRef;
  effort: Effort;
  costUsd: number;
  status: 'success' | 'failed';
};

const ALL_KINDS: ReadonlySet<string> = new Set<SubtaskKind>([
  'architecture',
  'feature',
  'bugfix',
  'refactor',
  'test',
  'docs',
  'mechanical',
]);

/** Sub-task kinds that are mechanical enough to delegate to the cheap tier. */
const CHEAP_KINDS: ReadonlySet<SubtaskKind> = new Set<SubtaskKind>(['test', 'docs', 'mechanical']);

export async function runOrchestrateMode(input: ModeInput, ctx: ModeContext): Promise<ModeOutput> {
  const start = performance.now();
  const progress = input.progress ?? noopProgress;
  const runId = randomUUID().slice(0, 8);
  const effort = input.effort ?? 'high';
  const profile = effortProfile(effort);

  // Preflight: orchestrate executes real edits across many sub-tasks,
  // so we need at least one ready provider whose adapter can edit
  // files. Fail fast with a helpful message instead of decomposing and
  // then dying on the first sub-task.
  const hasEditable = ctx.registry
    .list()
    .some((p) => EDITABLE_ADAPTERS.has(p.adapter) && ctx.registry.isReady(p.name));
  if (!hasEditable) {
    throw new Error(
      'orchestrate mode needs a tools-capable coding provider (Claude Code or Codex on PATH, ' +
        'or any OpenRouter / OpenAI / etc. key that routes through the CodeRouter agent loop). ' +
        'Configure one with /setup.',
    );
  }

  // Security scan (same contract as agent mode).
  progress({ phase: 'orchestrate/security', stage: 'start' });
  const securityFindings = scanForInjection(input.prompt, { source: 'user-prompt' }).findings;
  progress({ phase: 'orchestrate/security', stage: 'done', data: { findings: securityFindings.length } });
  const injectionPolicy = input.injectionPolicy ?? 'warn';
  if (injectionPolicy === 'block' && securityFindings.some((f) => f.severity === 'high')) {
    return baseFailure(runId, start, securityFindings, 'blocked: prompt-injection policy=block');
  }

  // Classify the overall goal (used for handoff classification + memory).
  const corpus = await loadSeedCorpus();
  const classifier = new ClassifierCascade({ corpus });
  const classification = input.fast
    ? fastClassification(input.prompt)
    : await classifier.classify({ prompt: input.prompt, noLlm: !ctx.budget });

  // Load the user's customization assets once. Subagents drive
  // per-sub-task routing; directives (rules + skills) ride along on
  // every sub-task's system prompt. Read from the real repo so both
  // project + global scopes resolve.
  const subagents = input.fast ? [] : await loadSubagents(input.cwd).catch(() => []);
  const directives = input.fast ? '' : await composeDirectives(input.cwd).catch(() => '');

  // --- Phase 1: decompose (the "big model plans") ---------------------
  progress({ phase: 'orchestrate/plan', stage: 'start', message: 'decomposing' });
  const plannerRoute = pickPlannerRoute(classification, ctx);
  let plannerCost = 0;
  let subtasks: Subtask[];
  try {
    const planner = resolveAdapter(plannerRoute, ctx);
    const res = await (planner.plan ?? planner.run).call(planner, {
      prompt: decompositionPrompt(input.prompt, subagents),
      maxTokens: 4_000,
      reasoningEffort: profile.reasoningEffort,
      cwd: input.cwd,
      readOnly: true,
      signal: input.signal,
    });
    plannerCost = res.costUsd;
    subtasks = parseSubtasks(res.text) ?? [fallbackSubtask(input.prompt, classification.taskType)];
  } catch {
    // Planner failed (no plan adapter, transient error): fall back to a
    // single sub-task = the whole prompt, executed normally.
    subtasks = [fallbackSubtask(input.prompt, classification.taskType)];
  }
  subtasks = orderSubtasks(subtasks);
  progress({
    phase: 'orchestrate/plan',
    stage: 'done',
    data: { subtasks: subtasks.length },
  });

  // --- worktree (own it for the whole run) ---------------------------
  const reused = input.existingWorktree;
  let wt: Worktree;
  let createdThisTurn = false;
  if (reused) {
    wt = { ...reused };
  } else {
    await ensureGitRepo(input.cwd, { autoInit: true });
    wt = await createWorktree({ repoPath: input.cwd, runId, prefix: 'orchestrate' });
    createdThisTurn = true;
  }

  // --- Phase 2: execute each sub-task with its own route -------------
  const runs: SubtaskRun[] = [];
  const completed: Subtask[] = [];
  let execCost = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const texts: string[] = [];
  try {
    for (let i = 0; i < subtasks.length; i++) {
      const st = subtasks[i]!;
      const subagent = matchSubagent(subagents, { name: st.subagent, kind: st.kind });
      const { route, effort: stEffort } = routeForSubtask(st, ctx, subagent);
      const adapter = resolveAdapter(route, ctx);
      if (!adapter.capabilities.canEdit) {
        // Should not happen (requireEditable), but guard anyway.
        throw new Error(
          `orchestrate: sub-task '${st.id}' routed to chat-only '${route.provider}:${route.model}'`,
        );
      }
      progress({
        phase: 'orchestrate/subtask',
        stage: 'start',
        index: i + 1,
        total: subtasks.length,
        message: `${subagent ? `${subagent.name} · ` : ''}${st.kind}: ${st.title}`,
        data: {
          route: {
            provider: route.provider,
            model: route.model,
            via: route.via ?? route.provider,
            rationale: route.rationale,
          },
        },
      });
      const res = await adapter.run({
        prompt: subtaskPrompt(input.prompt, st, completed, subagent),
        systemPrompt: directives ? buildSystemPrompt({ append: directives }) : undefined,
        cwd: wt.path,
        reasoningEffort: effortProfile(stEffort).reasoningEffort,
        signal: input.signal,
        onChunk: input.onChunk,
        onActivity: input.onActivity,
        onUsage: input.onUsage,
      });
      execCost += res.costUsd;
      tokensIn += res.tokensIn;
      tokensOut += res.tokensOut;
      if (res.text?.trim()) texts.push(`### ${st.title}\n\n${res.text.trim()}`);
      runs.push({ subtask: st, route, effort: stEffort, costUsd: res.costUsd, status: 'success' });
      completed.push(st);
      progress({ phase: 'orchestrate/subtask', stage: 'done', index: i + 1, total: subtasks.length });

      if (input.signal?.aborted) break;
    }
  } catch (err) {
    if (createdThisTurn && !input.keepWorktree) await destroyWorktree(wt).catch(() => {});
    if (input.signal?.aborted) {
      return baseFailure(runId, start, securityFindings, 'aborted', 'aborted', [
        plannerRoute,
        ...runs.map((r) => r.route),
      ]);
    }
    throw err;
  }

  // --- cumulative diff (against the original base, never advanced) ---
  const files = await changedFiles(wt).catch(() => []);
  const diff = await diffWorktree(wt).catch(() => '');

  // --- Phase 3: validate the combined result + optional handoff fix --
  let validators: ValidatorResult[] = [];
  let handoffPasses = 0;
  const project = await detectProject(wt.path);
  const hasMatchingChanges = files.some((f) => isProjectSource(f, project.type));
  const hasDeps = await hasProjectDeps(wt.path, project.type);
  const shouldValidate = !input.fast && files.length > 0 && hasMatchingChanges && hasDeps;
  if (shouldValidate) {
    progress({ phase: 'orchestrate/validate', stage: 'start' });
    validators = await runValidators({ cwd: wt.path, signal: input.signal });
    progress({ phase: 'orchestrate/validate', stage: 'done' });
    if (summarize(validators).status === 'fail' && profile.maxHandoffPasses > 0) {
      progress({ phase: 'orchestrate/handoff', stage: 'start' });
      const handoff = await runHandoff({
        registry: ctx.registry,
        router: ctx.router,
        mode: 'fix',
        worktree: wt,
        classification,
        originalPrompt: input.prompt,
        fromRoute: runs[runs.length - 1]?.route ?? plannerRoute,
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
      execCost += handoff.totalCostUsd;
      progress({ phase: 'orchestrate/handoff', stage: 'done', data: { passes: handoffPasses } });
    }
  }

  // --- persist + apply + lifecycle (mirrors agent mode) --------------
  let artifactDir: string | undefined;
  if (files.length > 0) {
    const artifact = await persistRunArtifact(wt, { diff, files });
    if (artifact) artifactDir = artifact.dir;
  }

  let applied = false;
  let applyError: string | undefined;
  if (input.apply && files.length > 0) {
    try {
      await mergeWorktree(wt, { cleanup: false });
      applied = true;
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
    }
  }

  let outgoingWorktree: WorktreeHandle | undefined;
  if (input.keepWorktree) {
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
  } else {
    await destroyWorktree(wt).catch(() => {});
  }

  const status = shouldValidate && summarize(validators).status === 'fail' ? 'partial' : 'success';
  const routes = dedupeRoutes([plannerRoute, ...runs.map((r) => r.route)]);

  return {
    mode: 'orchestrate',
    status,
    runId,
    text: renderSummary(input.prompt, plannerRoute, runs, texts),
    diff,
    filesChanged: files,
    classification,
    routes,
    validators,
    costUsd: plannerCost + execCost,
    tokensIn,
    tokensOut,
    durationMs: performance.now() - start,
    rationale: `orchestrate: ${subtasks.length} sub-task(s); plan via ${plannerRoute.via ?? plannerRoute.provider}:${plannerRoute.model}${handoffPasses ? ` + ${handoffPasses} handoff pass(es)` : ''}`,
    securityFindings,
    applied,
    applyError,
    artifactDir,
    worktree: outgoingWorktree,
  };
}

// ---- routing -------------------------------------------------------

/** Strong planner route for decomposition (read-only; need not edit). */
function pickPlannerRoute(classification: Classification, ctx: ModeContext): RouteRef {
  const strong = pickStrong(classification, ctx.router, 'high');
  if (strong.length > 0) return strong[0]!;
  return pick(classification, ctx.router, { effort: 'high' });
}

/**
 * Route a single sub-task. Mechanical kinds (test/docs/boilerplate) go
 * to the cheap-but-editable tier; everything else gets a big model at
 * an effort scaled to the kind. Every route is constrained to an
 * edit-capable adapter.
 */
export function routeForSubtask(
  st: Subtask,
  ctx: ModeContext,
  subagent?: Subagent | null,
): { route: RouteRef; effort: Effort } {
  const cls = fastClassification(st.details || st.title);

  // A matched subagent that pins a model wins: route straight to it
  // (still requiring an edit-capable adapter). Effort comes from the
  // subagent, else the kind default.
  if (subagent?.model && subagent.provider) {
    const effort = subagent.effort ?? defaultEffortForKind(st.kind);
    const route: RouteRef = {
      provider: subagent.provider as RouteRef['provider'],
      model: subagent.model,
      via: subagent.provider,
      rationale: `subagent:${subagent.name}`,
    };
    if (EDITABLE_ADAPTERS.has(route.provider)) return { route, effort };
    // Pinned model isn't edit-capable — fall through to normal routing
    // but keep the subagent's effort.
    return {
      route: pick(cls, ctx.router, { effort, requireEditable: true }),
      effort,
    };
  }

  const effort = subagent?.effort ?? defaultEffortForKind(st.kind);
  if (CHEAP_KINDS.has(st.kind) && !subagent?.effort) {
    return {
      route: pick(cls, ctx.router, { forceCheap: true, requireEditable: true }),
      effort: 'low',
    };
  }
  return { route: pick(cls, ctx.router, { effort, requireEditable: true }), effort };
}

function defaultEffortForKind(kind: SubtaskKind): Effort {
  if (kind === 'architecture') return 'high';
  if (CHEAP_KINDS.has(kind)) return 'low';
  return 'medium';
}

// ---- decomposition parsing ----------------------------------------

/** The strong-model decomposition prompt. */
export function decompositionPrompt(goal: string, subagents: Subagent[] = []): string {
  const lines = [
    'You are the lead engineer planning a coding task. Break the GOAL into an',
    'ordered list of concrete, independently-executable sub-tasks for a team of',
    'coding agents. A strong model handles design/feature work; a cheap model',
    'handles mechanical work (tests, docs, boilerplate).',
    '',
    'GOAL:',
    goal,
    '',
    'Rules:',
    '- 1 to 8 sub-tasks. Fewer is better; only split when steps are genuinely separable.',
    '- "kind" must be one of: architecture, feature, bugfix, refactor, test, docs, mechanical.',
    '- Put architecture/design sub-tasks first.',
    '- "details" must be precise instructions an executor can follow WITHOUT seeing this plan.',
    '- "dependsOn" lists ids of sub-tasks that must finish first.',
  ];
  if (subagents.length > 0) {
    lines.push(
      '- Optionally set "subagent" to one of the specialists below when a sub-task fits its expertise:',
      ...subagents.map((s) => `    - ${s.name}: ${s.description || '(no description)'}`),
    );
  }
  lines.push(
    '',
    'Respond with ONLY a JSON object, no prose, in this exact shape:',
    '{"subtasks":[{"id":"s1","title":"...","kind":"feature","details":"...","dependsOn":[],"subagent":null}]}',
  );
  return lines.join('\n');
}

/**
 * Parse the planner's JSON decomposition. Tolerant of surrounding prose
 * / code fences: extracts the first balanced `{...}` and validates the
 * shape. Returns null when nothing usable is found.
 */
export function parseSubtasks(text: string): Subtask[] | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const arr = (parsed as { subtasks?: unknown })?.subtasks;
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const out: Subtask[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i] as Record<string, unknown>;
    if (!raw || typeof raw !== 'object') continue;
    const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : `Step ${i + 1}`;
    const details = typeof raw.details === 'string' && raw.details.trim() ? raw.details.trim() : title;
    let id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `s${i + 1}`;
    if (seen.has(id)) id = `${id}-${i + 1}`;
    seen.add(id);
    const kind: SubtaskKind = ALL_KINDS.has(String(raw.kind)) ? (raw.kind as SubtaskKind) : 'feature';
    const dependsOn = Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((d): d is string => typeof d === 'string')
      : [];
    const subagent = typeof raw.subagent === 'string' && raw.subagent.trim() ? raw.subagent.trim() : undefined;
    out.push({ id, title, kind, details, dependsOn, subagent });
  }
  return out.length > 0 ? out : null;
}

/** Topologically order sub-tasks by `dependsOn`; stable, cycle-safe. */
export function orderSubtasks(subtasks: Subtask[]): Subtask[] {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const indeg = new Map<string, number>();
  for (const s of subtasks) {
    indeg.set(s.id, 0);
  }
  for (const s of subtasks) {
    for (const dep of s.dependsOn) {
      if (byId.has(dep)) indeg.set(s.id, (indeg.get(s.id) ?? 0) + 1);
    }
  }
  const ready = subtasks.filter((s) => (indeg.get(s.id) ?? 0) === 0);
  const ordered: Subtask[] = [];
  const placed = new Set<string>();
  while (ready.length > 0) {
    const s = ready.shift()!;
    if (placed.has(s.id)) continue;
    ordered.push(s);
    placed.add(s.id);
    for (const other of subtasks) {
      if (placed.has(other.id)) continue;
      if (other.dependsOn.includes(s.id)) {
        const d = (indeg.get(other.id) ?? 1) - 1;
        indeg.set(other.id, d);
        if (d <= 0) ready.push(other);
      }
    }
  }
  // Append any leftovers (cycles / dangling deps) in declared order.
  for (const s of subtasks) if (!placed.has(s.id)) ordered.push(s);
  return ordered;
}

function fallbackSubtask(prompt: string, taskType: TaskType): Subtask {
  const kindByTask: Record<TaskType, SubtaskKind> = {
    feature: 'feature',
    bugfix: 'bugfix',
    refactor: 'refactor',
    test: 'test',
    docs: 'docs',
    investigation: 'feature',
    review: 'feature',
    trivial: 'mechanical',
  };
  return {
    id: 's1',
    title: 'Implement the request',
    kind: kindByTask[taskType] ?? 'feature',
    details: prompt,
    dependsOn: [],
  };
}

function extractJsonObject(text: string): string | null {
  const startsAt = text.indexOf('{');
  if (startsAt < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startsAt; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(startsAt, i + 1);
    }
  }
  return null;
}

// ---- prompts + rendering ------------------------------------------

function subtaskPrompt(
  goal: string,
  st: Subtask,
  completed: Subtask[],
  subagent?: Subagent | null,
): string {
  const done =
    completed.length > 0
      ? completed.map((c) => `- ${c.title} (${c.kind})`).join('\n')
      : '- (nothing yet)';
  const lines = [
    'You are executing ONE sub-task of a larger plan. The repository already',
    'contains the results of any completed sub-tasks below.',
    '',
    'OVERALL GOAL:',
    goal,
    '',
    'COMPLETED SO FAR:',
    done,
    '',
  ];
  if (subagent && subagent.body.trim()) {
    lines.push(`You are acting as the "${subagent.name}" specialist:`, subagent.body.trim(), '');
  }
  lines.push(
    `YOUR SUB-TASK [${st.kind}]: ${st.title}`,
    st.details,
    '',
    'Make the necessary file changes for THIS sub-task now. Do not redo completed work.',
  );
  return lines.join('\n');
}

function renderSummary(
  goal: string,
  plannerRoute: RouteRef,
  runs: SubtaskRun[],
  texts: string[],
): string {
  const lines = [
    `# Orchestrated: ${goal}`,
    '',
    `_Planned by ${plannerRoute.via ?? plannerRoute.provider}:${plannerRoute.model}_`,
    '',
    '## Sub-tasks',
  ];
  for (const r of runs) {
    const m = `${r.route.via ?? r.route.provider}:${r.route.model}`;
    lines.push(`- **${r.subtask.title}** _(${r.subtask.kind})_ → \`${m}\``);
  }
  if (texts.length > 0) {
    lines.push('', '## Notes', '', texts.join('\n\n'));
  }
  return lines.join('\n');
}

function dedupeRoutes(routes: RouteRef[]): RouteRef[] {
  const seen = new Set<string>();
  const out: RouteRef[] = [];
  for (const r of routes) {
    const k = `${r.via ?? r.provider},${r.model}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function resolveAdapter(route: RouteRef, ctx: ModeContext): Adapter {
  return ctx.resolveAdapter
    ? ctx.resolveAdapter(route)
    : ctx.registry.resolve(`${route.via ?? route.provider},${route.model}`).adapter;
}

function baseFailure(
  runId: string,
  start: number,
  securityFindings: ModeOutput['securityFindings'],
  rationale: string,
  status: ModeOutput['status'] = 'failed',
  routes: RouteRef[] = [],
): ModeOutput {
  return {
    mode: 'orchestrate',
    status,
    runId,
    routes,
    validators: [],
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    durationMs: performance.now() - start,
    rationale,
    securityFindings,
  };
}

// ---- validator gating helpers (mirrors agent mode) ----------------

const PROJECT_EXTS: Record<ProjectType, ReadonlySet<string>> = {
  node: new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json']),
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

async function hasProjectDeps(cwd: string, projectType: ProjectType): Promise<boolean> {
  const probe = (rel: string): Promise<boolean> => access(join(cwd, rel)).then(() => true, () => false);
  switch (projectType) {
    case 'node':
      return probe('node_modules');
    case 'python':
    case 'rust':
    case 'go':
      return true;
    default:
      return false;
  }
}
