import { fastClassification } from '../routing/fast.js';
import { pick, pickStrong } from '../routing/policy.js';
import type { RouteRef } from '../types.js';
import { type LoopRunContext, resolveLoopAdapter } from './context.js';
import { discoverVerifiers, type DiscoveredVerifiers } from './discover.js';
import { applyPreset } from './presets.js';
import type { LoopModels, LoopPreset, LoopSpec } from './types.js';
import { validateLoopSpec } from './validate.js';

/**
 * Loop generator.
 *
 * Converts a plain-English request into a safe, bounded `LoopSpec`. It
 * discovers verifier commands first, then asks a strong model to fill in
 * the spec (goal, steps, model routing, safety), and finally normalizes
 * + applies the chosen preset so limits/safety are always present. If the
 * model is unavailable or returns junk, we fall back to a deterministic
 * spec built from discovery so the MVP still works.
 */

const GENERATOR_SYSTEM = `You are CodeRouter's Loop Generator.

Your job is to convert a user's coding goal into a safe executable loop spec.

A valid loop spec must include:
1. A clear goal.
2. Objective verifier commands.
3. A stop condition.
4. A max iteration limit.
5. A max cost limit.
6. Model routing per phase.
7. File safety rules.
8. A final reporting format.

Do not create loops for vague goals unless you can narrow them safely.
Prefer small, verifiable loops over large autonomous tasks.
Prefer existing repo commands over invented commands.
Never allow editing secrets, environment files, deployment configs, or lockfiles unless explicitly approved.

Return ONLY JSON matching this schema (no prose, no code fences):
{
  "name": string,
  "goal": string,
  "assumptions": string[],
  "verifier": { "commands": string[], "success_condition": string },
  "steps": string[],
  "models": { "planner": string, "executor": string, "reviewer": string, "summarizer": string },
  "limits": { "max_iterations": number, "max_cost_usd": number, "max_files_changed": number },
  "safety": { "require_user_approval_before_commit": boolean, "blocked_files": string[], "allowed_paths": string[], "allow_network": boolean },
  "on_success": string,
  "on_failure": string
}`;

export type GenerateOptions = {
  preset?: LoopPreset;
  /** Verifier commands the user supplied explicitly (override discovery). */
  verifierCommands?: string[];
  signal?: AbortSignal;
};

export type GenerateResult = {
  spec: LoopSpec;
  discovered: DiscoveredVerifiers;
  /** True when a model produced the spec; false when we used the fallback. */
  generated: boolean;
  costUsd: number;
};

export async function generateLoopSpec(
  request: string,
  ctx: LoopRunContext,
  opts: GenerateOptions = {},
): Promise<GenerateResult> {
  const preset = opts.preset ?? 'safe';
  const discovered = await discoverVerifiers(ctx.cwd);
  const discoveredCmds = opts.verifierCommands?.length
    ? opts.verifierCommands
    : discovered.commands.map((c) => c.command);

  const userPrompt = buildUserPrompt(request, discovered, discoveredCmds);

  let spec: LoopSpec | null = null;
  let generated = false;
  let costUsd = 0;

  try {
    const route = pickGeneratorRoute(request, ctx);
    const adapter = resolveLoopAdapter(route, ctx);
    const res = await (adapter.plan ?? adapter.run).call(adapter, {
      prompt: userPrompt,
      systemPrompt: GENERATOR_SYSTEM,
      cwd: ctx.cwd,
      readOnly: true,
      maxTokens: 2_000,
      reasoningEffort: 'high',
      signal: opts.signal,
    });
    costUsd = res.costUsd;
    spec = parseSpec(res.text);
    generated = spec != null;
  } catch {
    spec = null;
  }

  const finalSpec = applyPreset(spec ?? fallbackSpec(request, discoveredCmds), preset);
  // Discovery wins when the model omitted/hallucinated verifier commands
  // and we have real ones from the repo.
  if (finalSpec.verifier.commands.length === 0 && discoveredCmds.length > 0) {
    finalSpec.verifier.commands = discoveredCmds;
  }
  return { spec: finalSpec, discovered, generated, costUsd };
}

/** Strong, read-only route for spec generation. */
function pickGeneratorRoute(request: string, ctx: LoopRunContext): RouteRef {
  const cls = fastClassification(request);
  const strong = pickStrong(cls, ctx.router, 'high');
  if (strong.length > 0) return strong[0]!;
  return pick(cls, ctx.router, { effort: 'high' });
}

function buildUserPrompt(request: string, discovered: DiscoveredVerifiers, cmds: string[]): string {
  const lines = [
    'USER GOAL:',
    request,
    '',
    `REPO ECOSYSTEM: ${discovered.ecosystem}`,
    `PACKAGE MANAGER: ${discovered.packageManager ?? 'unknown'}`,
    '',
    'DETECTED VERIFIER COMMANDS (prefer these as the loop gate):',
    cmds.length > 0 ? cmds.map((c) => `- ${c}`).join('\n') : '- (none detected; infer safe ones or ask)',
    '',
    'Generate the loop spec now. Use the detected commands. Keep the loop small and bounded.',
  ];
  return lines.join('\n');
}

// ---- parsing + normalization --------------------------------------

function parseSpec(text: string): LoopSpec | null {
  const json = extractJsonObject(text);
  if (!json) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  return normalizeSpec(raw);
}

const VALID_ROLES = new Set(['frontier', 'strong', 'coding', 'reviewer', 'cheap']);

function asRole(v: unknown, fallback: LoopModels[keyof LoopModels]): LoopModels[keyof LoopModels] {
  if (typeof v !== 'string') return fallback;
  const s = v.toLowerCase();
  if (VALID_ROLES.has(s)) return s as LoopModels[keyof LoopModels];
  // Map common synonyms from the model.
  if (/front|gpt-5|opus|frontier/.test(s)) return 'frontier';
  if (/strong|reason|sonnet|review/.test(s)) return 'strong';
  if (/cod|exec|edit/.test(s)) return 'coding';
  if (/cheap|fast|mini|haiku|small|summar/.test(s)) return 'cheap';
  return fallback;
}

function strArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim());
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Accept snake_case (from the model) or camelCase and produce a LoopSpec. */
function normalizeSpec(raw: Record<string, unknown>): LoopSpec {
  const get = (a: string, b: string): unknown => raw[a] ?? raw[b];
  const verifierRaw = (get('verifier', 'verifier') ?? {}) as Record<string, unknown>;
  const limitsRaw = (get('limits', 'limits') ?? {}) as Record<string, unknown>;
  const modelsRaw = (get('models', 'models') ?? {}) as Record<string, unknown>;
  const safetyRaw = (get('safety', 'safety') ?? {}) as Record<string, unknown>;

  return {
    name: typeof raw.name === 'string' && raw.name.trim() ? slugify(raw.name) : 'coderouter-loop',
    goal: typeof raw.goal === 'string' ? raw.goal.trim() : '',
    assumptions: strArray(raw.assumptions),
    verifier: {
      commands: strArray(verifierRaw.commands),
      successCondition:
        (verifierRaw.success_condition as string) ||
        (verifierRaw.successCondition as string) ||
        'All verifier commands exit with code 0.',
    },
    steps: strArray(raw.steps),
    models: {
      planner: asRole(modelsRaw.planner, 'strong'),
      executor: asRole(modelsRaw.executor, 'coding'),
      reviewer: asRole(modelsRaw.reviewer, 'strong'),
      summarizer: asRole(modelsRaw.summarizer, 'cheap'),
    },
    limits: {
      maxIterations: num(limitsRaw.max_iterations ?? limitsRaw.maxIterations, 6),
      maxCostUsd: num(limitsRaw.max_cost_usd ?? limitsRaw.maxCostUsd, 2.5),
      maxFilesChanged: num(limitsRaw.max_files_changed ?? limitsRaw.maxFilesChanged, 6),
    },
    safety: {
      requireApprovalBeforeCommit: Boolean(
        safetyRaw.require_user_approval_before_commit ?? safetyRaw.requireApprovalBeforeCommit ?? true,
      ),
      blockedFiles: strArray(safetyRaw.blocked_files ?? safetyRaw.blockedFiles),
      allowedPaths: strArray(safetyRaw.allowed_paths ?? safetyRaw.allowedPaths),
      allowNetwork: Boolean(safetyRaw.allow_network ?? safetyRaw.allowNetwork ?? false),
    },
    onSuccess:
      (raw.on_success as string) ||
      (raw.onSuccess as string) ||
      'Show final diff, commands passed, files changed, and explanation.',
    onFailure:
      (raw.on_failure as string) ||
      (raw.onFailure as string) ||
      'Show what was tried, remaining failures, and recommended next step.',
  };
}

/** Deterministic spec when no model is available — keyed off discovery. */
function fallbackSpec(request: string, cmds: string[]): LoopSpec {
  return {
    name: slugify(request.split(/\s+/).slice(0, 4).join('-') || 'loop'),
    goal: request.trim(),
    assumptions: [
      'Use the existing test/lint/typecheck commands from the repo.',
      'Make the smallest safe change that satisfies the verifier.',
    ],
    verifier: { commands: cmds, successCondition: 'All verifier commands exit with code 0.' },
    steps: [
      'Run verifier commands.',
      'Analyze failures.',
      'Choose the single highest-impact failure.',
      'Plan the smallest fix.',
      'Edit only relevant files.',
      'Review the patch.',
      'Run verifier again.',
      'Repeat until success or limits are reached.',
    ],
    models: { planner: 'strong', executor: 'coding', reviewer: 'strong', summarizer: 'cheap' },
    limits: { maxIterations: 6, maxCostUsd: 2.5, maxFilesChanged: 6 },
    safety: {
      requireApprovalBeforeCommit: true,
      blockedFiles: [],
      allowedPaths: [],
      allowNetwork: false,
    },
    onSuccess: 'Show final diff, commands passed, files changed, and explanation.',
    onFailure: 'Show what was tried, remaining failures, and recommended next step.',
  };
}

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'loop'
  );
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

export { validateLoopSpec };
