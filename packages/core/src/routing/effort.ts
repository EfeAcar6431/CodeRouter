import type { Effort } from '../types.js';

/**
 * The effort knob.
 *
 * One first-class parameter shifts every policy threshold in the system,
 * so users never have to know which workflow it's wired into. It
 * controls dualPlan auto-promotion, tournament size, handoff passes,
 * cost ceilings, and reasoning effort.
 */
export type EffortProfile = {
  /** Reasoning effort passed to adapters that support it. */
  reasoningEffort: 'minimal' | 'low' | 'medium' | 'high';
  /** Auto-promote to dualPlan when shape exceeds this threshold. */
  dualPlanAutoThreshold: number;
  /** Auto-promote to tournament when shape exceeds this threshold. */
  tournamentAutoThreshold: number;
  /** Number of contenders for tournament workflow. */
  tournamentSize: number;
  /** Maximum handoff passes for the handoff workflow. */
  maxHandoffPasses: number;
  /** USD ceiling for a single workflow invocation. */
  maxCostUsd: number;
  /** Soft total duration budget. */
  maxDurationMs: number;
  /** Whether masterplan should include external research by default. */
  preferMasterplanResearch: boolean;
};

const PROFILES: Record<Effort, EffortProfile> = {
  low: {
    reasoningEffort: 'minimal',
    dualPlanAutoThreshold: 1.1,
    tournamentAutoThreshold: 1.1,
    tournamentSize: 1,
    maxHandoffPasses: 0,
    maxCostUsd: 0.25,
    maxDurationMs: 60_000,
    preferMasterplanResearch: false,
  },
  medium: {
    reasoningEffort: 'medium',
    dualPlanAutoThreshold: 0.95,
    tournamentAutoThreshold: 1.1,
    tournamentSize: 1,
    // Handoff fix-pass off by default. Empirically it spent more
    // time chasing flaky/environmental validator failures in the
    // worktree (stale dist, env-specific tests, etc.) than it did
    // making real improvements - and each pass adds 2-4 minutes
    // for a single LLM call + revalidation. Power users opt back
    // in via `/effort high`.
    maxHandoffPasses: 0,
    maxCostUsd: 1.5,
    // 90 seconds is a hard wall-clock cap on the handoff loop, NOT
    // on the agent run itself. Short enough that nothing hangs for
    // minutes; long enough for a single quick fixer pass when the
    // user explicitly wants one.
    maxDurationMs: 90_000,
    preferMasterplanResearch: true,
  },
  high: {
    reasoningEffort: 'high',
    dualPlanAutoThreshold: 0.75,
    tournamentAutoThreshold: 0.92,
    tournamentSize: 3,
    maxHandoffPasses: 1,
    maxCostUsd: 5,
    // 3 minute cap on the fix-pass loop at high effort. Down from
    // 10min - same reasoning as medium, just with a wider runway
    // for a single legitimate pass.
    maxDurationMs: 180_000,
    preferMasterplanResearch: true,
  },
  max: {
    reasoningEffort: 'high',
    dualPlanAutoThreshold: 0.6,
    tournamentAutoThreshold: 0.7,
    tournamentSize: 4,
    maxHandoffPasses: 2,
    maxCostUsd: 20,
    // 5 minute cap at max effort. Anything longer is almost always
    // an LLM stuck in a loop or a real-world hang we should bail
    // on, not a productive fix.
    maxDurationMs: 300_000,
    preferMasterplanResearch: true,
  },
};

export function effortProfile(effort: Effort = 'medium'): EffortProfile {
  return PROFILES[effort];
}
