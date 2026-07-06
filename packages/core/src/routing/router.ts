/**
 * `routeSubtask` - the composition root of the four-layer router.
 *
 *   extractFeatures -> filterCandidates -> scoreCandidates -> selectStrategy
 *
 * Turns a `CodingSubtask` into an explainable `RoutingDecision`: chosen
 * strategy, primary + verifier + fallback models, merged reason codes, cost/
 * latency estimates, and a logged propensity (1.0 - deterministic argmax, no
 * exploration yet). Candidates come from the OpenRouter-backed catalog unless
 * supplied directly (tests, eval baselines, shadow runs).
 */

import { randomUUID } from 'node:crypto';
import { type CatalogOptions, getModelCatalog } from './catalog.js';
import { extractFeatures } from './featureExtractor.js';
import { type FilterResult, filterCandidates } from './hardFilters.js';
import {
  DEFAULT_UTILITY_WEIGHTS,
  type UtilityWeights,
  completionTokensFor,
} from './policies/heuristicPolicy.js';
import type { ReasonCode } from './reasonCodes.js';
import { type ScoreResult, scoreCandidates } from './scorer.js';
import { type StrategyDecision, selectStrategy } from './strategySelector.js';
import type { CandidateModel, CodingSubtask, RoutingDecision, RoutingFeatures } from './types.js';

export type RouteOptions = {
  /** Candidate pool. When omitted, the OpenRouter-backed catalog is fetched. */
  candidates?: CandidateModel[];
  /** Utility weights override for the scorer. */
  weights?: UtilityWeights;
  /** Restrict to file-editing adapters (agent execution subtasks). */
  requireEditable?: boolean;
  /** Options forwarded to `getModelCatalog` when fetching candidates. */
  catalog?: CatalogOptions;
};

/** Full routing trace, for logging / eval / executor wiring. */
export type RouteResult = {
  decision: RoutingDecision;
  features: RoutingFeatures;
  filter: FilterResult;
  score: ScoreResult;
  strategy: StrategyDecision;
};

function mergeReasonCodes(strategy: StrategyDecision, score: ScoreResult): ReasonCode[] {
  const out: ReasonCode[] = [];
  const seen = new Set<string>();
  for (const c of [
    ...strategy.reasonCodes,
    ...(strategy.strategy === 'holdout' ? [] : score.reasonCodes),
  ]) {
    if (!seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }
  return out;
}

/** Route a subtask and return the full trace (decision + intermediate layers). */
export async function routeSubtaskDetailed(
  task: CodingSubtask,
  opts: RouteOptions = {},
): Promise<RouteResult> {
  const features = extractFeatures(task);
  const pool = opts.candidates ?? (await getModelCatalog(opts.catalog));

  const filter = filterCandidates(task, pool, {
    promptTokensEst: features.promptTokensEst,
    completionTokensEst: completionTokensFor(features),
    requireEditable: opts.requireEditable,
  });

  const score = scoreCandidates(
    features,
    filter.candidates,
    opts.weights ?? DEFAULT_UTILITY_WEIGHTS,
  );
  const strategy = selectStrategy(task, features, score.ranked);

  const best = score.best;
  const isHoldout = strategy.strategy === 'holdout';
  const decision: RoutingDecision = {
    decisionId: randomUUID(),
    strategy: strategy.strategy,
    primaryModel: strategy.primaryModel,
    verifierModel: strategy.verifierModel,
    fallbackModels: strategy.fallbackModels ?? [],
    reasonCodes: mergeReasonCodes(strategy, score),
    estimatedCostUsd: isHoldout ? 0 : (best?.predictedCostUsd ?? 0),
    estimatedLatencyMs: isHoldout ? 0 : (best?.predictedLatencyMs ?? 0),
    loggedPropensity: 1,
    explorationProbability: 0,
  };

  return { decision, features, filter, score, strategy };
}

/** Route a subtask into a `RoutingDecision`. */
export async function routeSubtask(
  task: CodingSubtask,
  opts: RouteOptions = {},
): Promise<RoutingDecision> {
  return (await routeSubtaskDetailed(task, opts)).decision;
}
