/**
 * Canonical routing reason codes.
 *
 * Every routing decision - which models were filtered out, why a strategy
 * was chosen, why a model won the score - is explained with a stable code
 * from this file rather than an ad-hoc string. Deterministic + explainable
 * is a hard requirement of the hard-filter and strategy layers: a rejected
 * model always carries at least one reason code, and the eval/replay harness
 * groups on these codes.
 */

/** Reasons a candidate model is removed by the deterministic hard filters. */
export const FILTER_REASON_CODES = [
  'context_too_small',
  'tools_not_supported',
  'structured_outputs_not_supported',
  'zdr_not_supported',
  'eu_not_supported',
  'over_cost_budget',
  'over_latency_budget',
  'not_editable',
] as const;

export type FilterReasonCode = (typeof FILTER_REASON_CODES)[number];

/** Reasons the scorer / strategy selector attach to a decision. */
export const DECISION_REASON_CODES = [
  // scorer
  'cheap_model_sufficient',
  'long_context_required',
  'high_risk_use_strong_model',
  'low_localization_confidence',
  'balanced_default',
  // strategy
  'strategy_single_shot',
  'strategy_draft_verify',
  'strategy_bounded_cascade',
  'strategy_holdout',
  // holdout causes
  'no_viable_model',
  'budget_impossible',
  'safety_critical',
  'repeated_failure',
] as const;

export type DecisionReasonCode = (typeof DECISION_REASON_CODES)[number];

export type ReasonCode = FilterReasonCode | DecisionReasonCode;

const ALL: ReadonlySet<string> = new Set<string>([
  ...FILTER_REASON_CODES,
  ...DECISION_REASON_CODES,
]);

/** Type guard: is a raw string one of the canonical reason codes? */
export function isReasonCode(s: string): s is ReasonCode {
  return ALL.has(s);
}
