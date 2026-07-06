/**
 * Routing logger: persists the audit trail for every routing decision.
 *
 * Writes one `routing_requests` + one `routing_decisions` row per
 * `routeSubtask`, one `model_invocations` row per model call the executor
 * makes, and (later, once validators/review finish) an `execution_outcomes`
 * row. Everything the eval/replay harness and any future off-policy learner
 * needs - features, reason codes, logged propensity, exact token/cost/latency,
 * outcomes - is captured here. Logging is intentionally best-effort and never
 * throws into the routing hot path.
 */

import { randomUUID } from 'node:crypto';
import type {
  ExecutionOutcomeRecord,
  ModelInvocationRecord,
  RoutingStore,
} from '../store/routing.js';
import type { RouteResult } from './router.js';
import type { CodingSubtask, ModelInvocationResult } from './types.js';

export type InvocationRole = 'primary' | 'verifier' | 'fallback';

export type LoggerClock = {
  now?: () => number;
  id?: () => string;
};

export class RoutingLogger {
  private readonly now: () => number;
  private readonly id: () => string;

  constructor(
    private readonly store: RoutingStore,
    clock: LoggerClock = {},
  ) {
    this.now = clock.now ?? (() => Date.now());
    this.id = clock.id ?? (() => randomUUID());
  }

  /**
   * Persist a route result (request + decision). Returns the decisionId so the
   * caller can attach invocations and an outcome. The decisionId is the one the
   * router already minted, so decisions are stable across logging and replay.
   */
  logRoute(task: CodingSubtask, result: RouteResult): { requestId: string; decisionId: string } {
    const requestId = this.id();
    const at = this.now();
    const { decision, features, filter, score } = result;

    this.store.insertRequest({
      id: requestId,
      subtaskId: task.subtaskId,
      parentTaskId: task.parentTaskId,
      repoId: task.repoId,
      taskKind: task.kind,
      language: task.language,
      riskTier: task.riskTier,
      promptTokensEst: features.promptTokensEst,
      features,
      createdAt: at,
    });

    this.store.insertDecision({
      id: decision.decisionId,
      requestId,
      strategy: decision.strategy,
      primaryModel: decision.primaryModel,
      verifierModel: decision.verifierModel,
      fallbackModels: decision.fallbackModels ?? [],
      reasonCodes: decision.reasonCodes,
      rejected: filter.rejected,
      scores: score.ranked.map((s) => ({
        modelId: s.model.modelId,
        passProb: s.predictedPassProb,
        costUsd: s.predictedCostUsd,
        latencyMs: s.predictedLatencyMs,
        utility: s.predictedUtility,
      })),
      estimatedCostUsd: decision.estimatedCostUsd,
      estimatedLatencyMs: decision.estimatedLatencyMs,
      loggedPropensity: decision.loggedPropensity,
      explorationProbability: decision.explorationProbability ?? 0,
      createdAt: at,
    });

    return { requestId, decisionId: decision.decisionId };
  }

  logInvocation(decisionId: string, role: InvocationRole, inv: ModelInvocationResult): void {
    const rec: ModelInvocationRecord = {
      id: this.id(),
      decisionId,
      modelId: inv.modelId,
      via: inv.via,
      provider: inv.provider,
      role,
      status: inv.status,
      tokensIn: inv.tokensIn,
      tokensOut: inv.tokensOut,
      costUsd: inv.costUsd,
      ttftMs: inv.ttftMs,
      latencyMs: inv.latencyMs,
      schemaValid: inv.schemaValid ?? null,
      error: inv.error,
      createdAt: this.now(),
    };
    this.store.insertInvocation(rec);
  }

  attachOutcome(
    decisionId: string,
    outcome: Omit<ExecutionOutcomeRecord, 'id' | 'decisionId' | 'createdAt'>,
  ): void {
    this.store.attachOutcome({ id: this.id(), decisionId, createdAt: this.now(), ...outcome });
  }
}
