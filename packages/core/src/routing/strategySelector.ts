/**
 * Layer 3: strategy selector.
 *
 * Decides the *procedure*, not just the model - because the best model and the
 * best workflow are different questions. Given the scored candidates and the
 * task's risk/complexity, it picks one of:
 *
 *   single_shot     - one call to the best model (easy, low-risk, localized).
 *   draft_verify    - cheap draft then a stronger verifier (medium risk).
 *   bounded_cascade - primary then escalate through fallbacks (hard/long/
 *                     poorly-localized, high value of success).
 *   holdout         - make no model call (nothing viable, impossible budget,
 *                     safety-critical with no reliable model, or repeated
 *                     failures).
 *
 * Every choice carries reason codes so the decision is explainable.
 */

import type { DecisionReasonCode } from './reasonCodes.js';
import type { ScoredCandidate } from './scorer.js';
import type { CodingSubtask, RoutingFeatures, RoutingStrategy } from './types.js';

/** Context size that marks a task as long-context-bound. */
const LONG_CONTEXT_TOKENS = 100_000;
/** Prior failures at/above which we hold out instead of retrying blindly. */
const MAX_FAILURES = 3;
/** Below this predicted pass prob, a high-risk task has no safe model. */
const SAFETY_MIN_PASS = 0.4;
/** Max fallbacks to attach to a bounded cascade. */
const MAX_CASCADE_FALLBACKS = 2;

export type StrategyDecision = {
  strategy: RoutingStrategy;
  reasonCodes: DecisionReasonCode[];
  primaryModel?: string;
  verifierModel?: string;
  fallbackModels?: string[];
};

function isComplex(features: RoutingFeatures): boolean {
  return (
    features.localizationConfidence === 'low' ||
    features.expectedPatchSize === 'large' ||
    features.minContextTokens >= LONG_CONTEXT_TOKENS
  );
}

export function selectStrategy(
  task: CodingSubtask,
  features: RoutingFeatures,
  ranked: ScoredCandidate[],
): StrategyDecision {
  const best = ranked[0];

  // --- Holdout: no model call ---
  if (!best) {
    return { strategy: 'holdout', reasonCodes: ['strategy_holdout', 'no_viable_model'] };
  }
  if ((task.priorFailureCount ?? 0) >= MAX_FAILURES) {
    return { strategy: 'holdout', reasonCodes: ['strategy_holdout', 'repeated_failure'] };
  }
  if (typeof task.costBudgetUsd === 'number' && best.predictedCostUsd > task.costBudgetUsd) {
    return { strategy: 'holdout', reasonCodes: ['strategy_holdout', 'budget_impossible'] };
  }
  if (task.riskTier === 'high' && best.predictedPassProb < SAFETY_MIN_PASS) {
    return { strategy: 'holdout', reasonCodes: ['strategy_holdout', 'safety_critical'] };
  }

  // Strongest-by-reliability ordering, for verifier + cascade fallbacks.
  const byReliability = [...ranked].sort((a, b) => b.predictedPassProb - a.predictedPassProb);
  const strongest = byReliability[0]!;
  const complex = isComplex(features);

  // --- Bounded cascade: hard / long / poorly-localized, non-trivial risk ---
  if (complex && task.riskTier !== 'low') {
    const fallbacks = byReliability
      .map((c) => c.model.modelId)
      .filter((id) => id !== best.model.modelId)
      .slice(0, MAX_CASCADE_FALLBACKS);
    const codes: DecisionReasonCode[] = ['strategy_bounded_cascade'];
    if (features.localizationConfidence === 'low') codes.push('low_localization_confidence');
    if (features.minContextTokens >= LONG_CONTEXT_TOKENS) codes.push('long_context_required');
    if (task.riskTier === 'high') codes.push('high_risk_use_strong_model');
    return {
      strategy: 'bounded_cascade',
      reasonCodes: codes,
      primaryModel: best.model.modelId,
      fallbackModels: fallbacks,
    };
  }

  // --- Draft + verify: medium risk (or high-but-simple), verifier available ---
  const verifierAvailable = strongest.model.modelId !== best.model.modelId;
  if ((task.riskTier === 'medium' || task.riskTier === 'high') && verifierAvailable) {
    return {
      strategy: 'draft_verify',
      reasonCodes: ['strategy_draft_verify'],
      primaryModel: best.model.modelId,
      verifierModel: strongest.model.modelId,
    };
  }

  // --- Single shot: easy, low-risk, or nothing stronger to verify with ---
  const codes: DecisionReasonCode[] = ['strategy_single_shot'];
  if (task.riskTier === 'low') codes.push('cheap_model_sufficient');
  return { strategy: 'single_shot', reasonCodes: codes, primaryModel: best.model.modelId };
}
