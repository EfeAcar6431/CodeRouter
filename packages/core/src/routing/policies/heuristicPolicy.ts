/**
 * v0 heuristic policy: closed-form predictions for pass probability, cost,
 * latency, and utility. No training - this is the deterministic baseline the
 * learned scorer (roadmap) must beat.
 *
 * The quality term reuses the same benchmark-grounded coding score that the
 * existing value selector (`models/select.ts`) ranks on (surfaced on
 * `CandidateModel.codingScore` via `resolveCard`), so a cheap unverified model
 * can't out-predict a known frontier model on quality alone.
 */

import { UNKNOWN_CODING_PRIOR } from '../../models/resolve.js';
import { estimateCallCostUsd } from '../hardFilters.js';
import type { CandidateModel, RiskTier, RoutingFeatures } from '../types.js';

/** Weights for the utility objective. Success value scales with risk tier. */
export type UtilityWeights = {
  /** Value of a successful outcome (before the risk multiplier). */
  valueOfSuccess: number;
  /** USD penalty weight (utility units per dollar). */
  costWeight: number;
  /** Latency penalty weight (utility units per second). */
  latencyWeight: number;
};

export const DEFAULT_UTILITY_WEIGHTS: UtilityWeights = {
  valueOfSuccess: 1,
  costWeight: 2,
  latencyWeight: 0.01,
};

/** Higher-risk work makes success more valuable, pushing routing toward reliability. */
export function riskMultiplier(risk: RiskTier): number {
  return risk === 'high' ? 1.6 : risk === 'medium' ? 1 : 0.6;
}

/** Assumed completion length (tokens) by expected patch size. */
export function completionTokensFor(features: RoutingFeatures): number {
  switch (features.expectedPatchSize) {
    case 'small':
      return 800;
    case 'large':
      return 6_000;
    default:
      return 2_000;
  }
}

/**
 * Task hardness in [0,1] from deterministic features: risk, patch size, weak
 * localization, and stack-trace presence (bug hunts are harder to one-shot).
 */
export function taskHardness(features: RoutingFeatures): number {
  let h = features.riskTier === 'high' ? 0.55 : features.riskTier === 'medium' ? 0.35 : 0.15;
  if (features.expectedPatchSize === 'large') h += 0.2;
  else if (features.expectedPatchSize === 'medium') h += 0.1;
  if (features.localizationConfidence === 'low') h += 0.15;
  if (features.hasStackTrace) h += 0.05;
  return Math.max(0, Math.min(1, h));
}

/**
 * Predicted pass probability, linear in the model's quality gap scaled by task
 * hardness: `1 - (1-quality)*(0.5 + hardness)`. An easy task lifts even a weak
 * model to a decent pass rate; a hard task widens the gap so only strong models
 * stay reliable. Monotonic in both quality and (inverse) hardness.
 */
export function predictPassProb(model: CandidateModel, features: RoutingFeatures): number {
  const quality = Math.max(0, Math.min(1, (model.codingScore ?? UNKNOWN_CODING_PRIOR) / 100));
  const gap = 1 - quality;
  const passProb = 1 - gap * (0.5 + taskHardness(features));
  return Math.max(0, Math.min(1, passProb));
}

/**
 * Satisficing threshold: the pass probability beyond which extra reliability
 * adds no value for a given risk tier. Low-risk work is satisfied by a
 * "good enough" model (so a cheap one wins on cost); high-risk work is never
 * capped, so the most reliable model keeps winning.
 */
export function satisficePassProb(risk: RiskTier): number {
  return risk === 'high' ? 1 : risk === 'medium' ? 0.8 : 0.6;
}

export function predictCostUsd(model: CandidateModel, features: RoutingFeatures): number {
  return estimateCallCostUsd(model, features.promptTokensEst, completionTokensFor(features));
}

/**
 * Predicted latency (ms). Uses the best known provider latency when reported,
 * otherwise a coarse prior: a base plus a "thinking tax" for frontier-grade
 * models plus completion-length scaling.
 */
export function predictLatencyMs(model: CandidateModel, features: RoutingFeatures): number {
  const known = (model.providers ?? [])
    .map((p) => p.avgLatencyMs)
    .filter((n): n is number => typeof n === 'number');
  if (known.length > 0) return Math.min(...known);

  const quality = (model.codingScore ?? UNKNOWN_CODING_PRIOR) / 100;
  const thinkingTax = quality > 0.75 ? 1_500 : 0;
  const completionScale = completionTokensFor(features) * 0.4; // ~0.4ms/token
  return Math.round(1_200 + thinkingTax + completionScale);
}

export function utility(
  passProb: number,
  costUsd: number,
  latencyMs: number,
  risk: RiskTier,
  weights: UtilityWeights = DEFAULT_UTILITY_WEIGHTS,
): number {
  const effectivePass = Math.min(passProb, satisficePassProb(risk));
  const value = weights.valueOfSuccess * riskMultiplier(risk) * effectivePass;
  const costPenalty = weights.costWeight * costUsd;
  const latencyPenalty = weights.latencyWeight * (latencyMs / 1_000);
  return value - costPenalty - latencyPenalty;
}
