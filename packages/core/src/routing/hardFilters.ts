/**
 * Layer 1: deterministic hard filters.
 *
 * Removes models that are *impossible* for a subtask before any scoring, so
 * the scorer only ever ranks viable candidates. Every rejection carries at
 * least one stable reason code (never a silent drop) - this is what makes the
 * router explainable and lets the eval harness attribute misroutes.
 *
 * Privacy requirements (EU-only, zero-data-retention) are treated as
 * unconfirmable-by-default: OpenRouter's model list does not advertise
 * per-provider EU/ZDR, so a model is only kept when a provider explicitly
 * reports support. "Can't confirm" means "reject", which is the safe posture.
 */

import { EDITABLE_ADAPTERS } from '../catalog/resolve.js';
import type { FilterReasonCode } from './reasonCodes.js';
import type { CandidateModel, CodingSubtask, RejectedModel } from './types.js';

/** Default assumed completion length (tokens) when estimating per-call cost. */
const DEFAULT_COMPLETION_TOKENS = 2_000;

export type FilterOptions = {
  /** Estimated prompt tokens for the call (drives the cost-budget check). */
  promptTokensEst?: number;
  /** Estimated completion tokens for the call (default 2000). */
  completionTokensEst?: number;
  /** When true, only file-editing adapters survive (agent execution subtasks). */
  requireEditable?: boolean;
};

export type FilterResult = {
  candidates: CandidateModel[];
  rejected: RejectedModel[];
};

/** Estimated USD cost of one call to a model, given token estimates. */
export function estimateCallCostUsd(
  m: CandidateModel,
  promptTokens: number,
  completionTokens: number,
): number {
  return (
    (promptTokens / 1_000_000) * m.pricePromptPer1M +
    (completionTokens / 1_000_000) * m.priceCompletionPer1M
  );
}

/** Estimated latency (ms) for a model, taking the best (lowest) known provider latency. */
function knownLatencyMs(m: CandidateModel): number | undefined {
  const latencies = (m.providers ?? [])
    .map((p) => p.avgLatencyMs)
    .filter((n): n is number => typeof n === 'number');
  return latencies.length > 0 ? Math.min(...latencies) : undefined;
}

function confirmsEu(m: CandidateModel): boolean {
  return (m.providers ?? []).some((p) => p.supportsEu === true);
}
function confirmsZdr(m: CandidateModel): boolean {
  return (m.providers ?? []).some((p) => p.supportsZdr === true);
}

/**
 * Apply the deterministic hard filters. Returns surviving `candidates` and a
 * parallel `rejected` list where each entry lists every failed check.
 */
export function filterCandidates(
  task: CodingSubtask,
  models: CandidateModel[],
  opts: FilterOptions = {},
): FilterResult {
  const promptTokens = opts.promptTokensEst ?? Math.max(1, Math.ceil(task.prompt.length / 4));
  const completionTokens = opts.completionTokensEst ?? DEFAULT_COMPLETION_TOKENS;

  const candidates: CandidateModel[] = [];
  const rejected: RejectedModel[] = [];

  for (const m of models) {
    const reasons: FilterReasonCode[] = [];

    // Context length: the model must hold the required minimum context.
    const requiredContext = task.minContextTokens ?? 0;
    if (requiredContext > 0 && m.contextLength > 0 && m.contextLength < requiredContext) {
      reasons.push('context_too_small');
    }

    // Capability requirements.
    if (task.requiresTools && !m.supportsTools) reasons.push('tools_not_supported');
    if (task.requiresStructuredOutput && !m.supportsStructuredOutput) {
      reasons.push('structured_outputs_not_supported');
    }

    // Privacy: unconfirmable EU/ZDR support is a rejection.
    if (task.privacy?.euOnly && !confirmsEu(m)) reasons.push('eu_not_supported');
    if (task.privacy?.zdrRequired && !confirmsZdr(m)) reasons.push('zdr_not_supported');

    // Cost budget: estimated per-call cost must fit.
    if (typeof task.costBudgetUsd === 'number') {
      const est = estimateCallCostUsd(m, promptTokens, completionTokens);
      if (est > task.costBudgetUsd) reasons.push('over_cost_budget');
    }

    // Latency budget: only enforceable when a provider reports latency.
    if (typeof task.latencyBudgetMs === 'number') {
      const latency = knownLatencyMs(m);
      if (typeof latency === 'number' && latency > task.latencyBudgetMs) {
        reasons.push('over_latency_budget');
      }
    }

    // Editability (agent execution subtasks).
    if (opts.requireEditable && (!m.adapter || !EDITABLE_ADAPTERS.has(m.adapter))) {
      reasons.push('not_editable');
    }

    if (reasons.length > 0) rejected.push({ modelId: m.modelId, reasons });
    else candidates.push(m);
  }

  return { candidates, rejected };
}
