/**
 * Public types for the four-layer routing module.
 *
 * The router's job is to turn a `CodingSubtask` into a `RoutingDecision`:
 * a chosen strategy, a primary model + fallbacks, explainable reason codes,
 * cost/latency estimates, and a logged propensity for later off-policy
 * evaluation. The layers that produce it:
 *
 *   featureExtractor -> hardFilters -> scorer -> strategySelector
 *
 * These types intentionally add the structured budget/privacy signals the
 * legacy `Classification`/`RouteRef` pair never modelled (cost + latency
 * budgets, EU-only, zero-data-retention, structured-output need), while
 * reusing `ProviderId` from the shared type surface for executor wiring.
 */

import type { ProviderId } from '../types.js';
import type { ReasonCode } from './reasonCodes.js';

/** Kind of coding subtask, as classified upstream or supplied by the caller. */
export type CodingSubtaskKind =
  | 'bugfix'
  | 'test_generation'
  | 'refactor'
  | 'localization'
  | 'code_search'
  | 'cli_script'
  | 'review'
  | 'doc_to_code';

export type RiskTier = 'low' | 'medium' | 'high';

/** A unit of coding work to be routed. Input to `routeSubtask`. */
export type CodingSubtask = {
  subtaskId: string;
  parentTaskId?: string;
  kind: CodingSubtaskKind;

  language?: string;
  repoId?: string;
  prompt: string;
  filesInScope?: string[];
  minContextTokens?: number;

  requiresTools?: boolean;
  requiresStructuredOutput?: boolean;
  /** When true, only vision-capable (image-input) models survive hard filters. */
  requiresVision?: boolean;

  riskTier: RiskTier;

  latencyBudgetMs?: number;
  costBudgetUsd?: number;

  privacy?: {
    euOnly?: boolean;
    zdrRequired?: boolean;
  };

  /**
   * How many times this subtask (or its parent) has already failed. Feeds the
   * strategy selector's holdout rule. Optional; defaults to 0.
   */
  priorFailureCount?: number;
};

/** Per-provider routing metadata OpenRouter exposes that we now capture. */
export type CandidateProvider = {
  name: string;
  supportsZdr?: boolean;
  supportsEu?: boolean;
  avgLatencyMs?: number;
  maxPrice?: {
    prompt?: number;
    completion?: number;
  };
};

/**
 * A normalized model the router can choose from. Superset of what the legacy
 * catalog tracked: adds structured-output support and per-provider EU/ZDR/
 * latency metadata, plus the routing wiring (`via`/`adapter`) and the
 * benchmark coding score so the scorer can reuse existing priors.
 */
export type CandidateModel = {
  modelId: string;
  contextLength: number;
  supportedParameters: string[];
  pricePromptPer1M: number;
  priceCompletionPer1M: number;

  supportsTools: boolean;
  supportsVision: boolean;
  supportsStructuredOutput: boolean;

  /** Registry provider name this candidate routes through (drives readiness + `via`). */
  via?: string;
  /** Adapter kind used to actually execute the call. */
  adapter?: ProviderId;
  /** Benchmark-grounded coding score in [0,100] when known (from ModelCard). */
  codingScore?: number;

  providers?: CandidateProvider[];
};

export type ExpectedPatchSize = 'small' | 'medium' | 'large';
export type Confidence = 'low' | 'medium' | 'high';

/** Deterministic features extracted from a `CodingSubtask`. */
export type RoutingFeatures = {
  promptTokensEst: number;
  filesCount: number;
  hasStackTrace: boolean;
  language?: string;
  taskKind: CodingSubtaskKind;
  riskTier: RiskTier;
  minContextTokens: number;
  expectedPatchSize: ExpectedPatchSize;
  localizationConfidence: Confidence;
  requiresTools: boolean;
  requiresStructuredOutput: boolean;
};

export type RoutingStrategy = 'single_shot' | 'draft_verify' | 'bounded_cascade' | 'holdout';

/** A model removed by the hard filters, with the reason(s) why. */
export type RejectedModel = {
  modelId: string;
  reasons: ReasonCode[];
};

/** The router's output for a subtask. */
export type RoutingDecision = {
  decisionId: string;
  strategy: RoutingStrategy;
  primaryModel?: string;
  verifierModel?: string;
  fallbackModels?: string[];
  reasonCodes: ReasonCode[];
  estimatedCostUsd?: number;
  estimatedLatencyMs?: number;
  /**
   * Probability the logging policy assigned to the chosen action. 1.0 for a
   * deterministic argmax router; < 1 once exploration is introduced. Required
   * for unbiased off-policy replay/learning.
   */
  loggedPropensity: number;
  /** Probability this decision was an exploration draw (0 in the deterministic MVP). */
  explorationProbability?: number;
};

export type InvocationStatus = 'ok' | 'error' | 'skipped';

/** Result of a single model call made by the executor. */
export type ModelInvocationResult = {
  modelId: string;
  via?: string;
  provider?: ProviderId;
  status: InvocationStatus;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  /** Time to first token (ms), when the transport reports it. */
  ttftMs?: number;
  /** End-to-end latency (ms). */
  latencyMs: number;
  /** Whether the output validated against the requested schema (structured output). */
  schemaValid?: boolean;
  text?: string;
  error?: string;
};
