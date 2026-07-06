/**
 * Layer 2: value scorer.
 *
 * Ranks the filtered candidates by predicted utility (quality-weighted
 * expected value minus cost and latency penalties) using the v0 heuristic
 * policy, and attaches explainable reason codes for why the winner was picked.
 */

import {
  DEFAULT_UTILITY_WEIGHTS,
  type UtilityWeights,
  predictCostUsd,
  predictLatencyMs,
  predictPassProb,
  utility,
} from './policies/heuristicPolicy.js';
import type { DecisionReasonCode } from './reasonCodes.js';
import type { CandidateModel, RoutingFeatures } from './types.js';

/** Price (prompt+completion per 1M) at or below which we call a model "cheap". */
const CHEAP_PRICE_THRESHOLD = 3;
/** Pass probability we consider "good enough" to prefer a cheap model. */
const ACCEPTABLE_PASS_PROB = 0.6;
/** Context size that flags a task as long-context-bound. */
const LONG_CONTEXT_TOKENS = 100_000;

export type ScoredCandidate = {
  model: CandidateModel;
  predictedPassProb: number;
  predictedCostUsd: number;
  predictedLatencyMs: number;
  predictedUtility: number;
};

export type ScoreResult = {
  ranked: ScoredCandidate[];
  best?: ScoredCandidate;
  reasonCodes: DecisionReasonCode[];
};

/** Score + rank candidates best-utility-first. */
export function scoreCandidates(
  features: RoutingFeatures,
  candidates: CandidateModel[],
  weights: UtilityWeights = DEFAULT_UTILITY_WEIGHTS,
): ScoreResult {
  const scored: ScoredCandidate[] = candidates.map((model) => {
    const predictedPassProb = predictPassProb(model, features);
    const predictedCostUsd = predictCostUsd(model, features);
    const predictedLatencyMs = predictLatencyMs(model, features);
    return {
      model,
      predictedPassProb,
      predictedCostUsd,
      predictedLatencyMs,
      predictedUtility: utility(
        predictedPassProb,
        predictedCostUsd,
        predictedLatencyMs,
        features.riskTier,
        weights,
      ),
    };
  });

  const ranked = scored.sort((a, b) => {
    if (b.predictedUtility !== a.predictedUtility) return b.predictedUtility - a.predictedUtility;
    // Tie-break: higher pass prob, then cheaper.
    if (b.predictedPassProb !== a.predictedPassProb)
      return b.predictedPassProb - a.predictedPassProb;
    return a.predictedCostUsd - b.predictedCostUsd;
  });

  const best = ranked[0];
  return { ranked, best, reasonCodes: best ? reasonsFor(best, features) : [] };
}

function reasonsFor(best: ScoredCandidate, features: RoutingFeatures): DecisionReasonCode[] {
  const codes: DecisionReasonCode[] = [];
  const totalPrice = best.model.pricePromptPer1M + best.model.priceCompletionPer1M;

  if (features.riskTier === 'high') codes.push('high_risk_use_strong_model');
  if (features.minContextTokens >= LONG_CONTEXT_TOKENS) codes.push('long_context_required');
  if (features.localizationConfidence === 'low') codes.push('low_localization_confidence');
  if (totalPrice <= CHEAP_PRICE_THRESHOLD && best.predictedPassProb >= ACCEPTABLE_PASS_PROB) {
    codes.push('cheap_model_sufficient');
  }
  if (codes.length === 0) codes.push('balanced_default');
  return codes;
}
