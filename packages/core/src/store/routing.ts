/**
 * Persistence for the routing audit trail.
 *
 * Four tables mirroring the router's lifecycle: `routing_requests` (the task
 * + features), `routing_decisions` (strategy, models, reason codes, scores,
 * logged propensity), `model_invocations` (per-call token/cost/latency), and
 * `execution_outcomes` (attached after validators/review run). This is the
 * substrate replay + eval + future off-policy learning read from - logging
 * comes before intelligence.
 */

import type { Database } from './db.js';

export type RoutingRequestRecord = {
  id: string;
  subtaskId: string;
  parentTaskId?: string | null;
  repoId?: string | null;
  taskKind: string;
  language?: string | null;
  riskTier: string;
  promptTokensEst: number;
  features: unknown;
  createdAt: number;
};

export type RoutingDecisionRecord = {
  id: string;
  requestId: string;
  strategy: string;
  primaryModel?: string | null;
  verifierModel?: string | null;
  fallbackModels: string[];
  reasonCodes: string[];
  rejected: unknown;
  scores: unknown;
  estimatedCostUsd?: number | null;
  estimatedLatencyMs?: number | null;
  loggedPropensity: number;
  explorationProbability: number;
  createdAt: number;
};

export type ModelInvocationRecord = {
  id: string;
  decisionId: string;
  modelId: string;
  via?: string | null;
  provider?: string | null;
  role: 'primary' | 'verifier' | 'fallback';
  status: 'ok' | 'error' | 'skipped';
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  ttftMs?: number | null;
  latencyMs: number;
  schemaValid?: boolean | null;
  error?: string | null;
  createdAt: number;
};

export type ExecutionOutcomeRecord = {
  id: string;
  decisionId: string;
  testPass?: boolean | null;
  verifierPass?: boolean | null;
  patchApplied?: boolean | null;
  accepted?: boolean | null;
  rolledBack?: boolean | null;
  notes?: string | null;
  createdAt: number;
};

function bool(v: boolean | null | undefined): number | null {
  return v === null || v === undefined ? null : v ? 1 : 0;
}

export class RoutingStore {
  constructor(private readonly db: Database) {}

  insertRequest(rec: RoutingRequestRecord): void {
    this.db
      .prepare(
        `INSERT INTO routing_requests (id, subtask_id, parent_task_id, repo_id, task_kind, language,
          risk_tier, prompt_tokens_est, features_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.subtaskId,
        rec.parentTaskId ?? null,
        rec.repoId ?? null,
        rec.taskKind,
        rec.language ?? null,
        rec.riskTier,
        rec.promptTokensEst,
        JSON.stringify(rec.features ?? {}),
        rec.createdAt,
      );
  }

  insertDecision(rec: RoutingDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO routing_decisions (id, request_id, strategy, primary_model, verifier_model,
          fallback_models_json, reason_codes_json, rejected_json, scores_json, estimated_cost_usd,
          estimated_latency_ms, logged_propensity, exploration_probability, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.requestId,
        rec.strategy,
        rec.primaryModel ?? null,
        rec.verifierModel ?? null,
        JSON.stringify(rec.fallbackModels ?? []),
        JSON.stringify(rec.reasonCodes ?? []),
        JSON.stringify(rec.rejected ?? []),
        JSON.stringify(rec.scores ?? []),
        rec.estimatedCostUsd ?? null,
        rec.estimatedLatencyMs ?? null,
        rec.loggedPropensity,
        rec.explorationProbability,
        rec.createdAt,
      );
  }

  insertInvocation(rec: ModelInvocationRecord): void {
    this.db
      .prepare(
        `INSERT INTO model_invocations (id, decision_id, model_id, via, provider, role, status,
          tokens_in, tokens_out, cost_usd, ttft_ms, latency_ms, schema_valid, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.decisionId,
        rec.modelId,
        rec.via ?? null,
        rec.provider ?? null,
        rec.role,
        rec.status,
        rec.tokensIn,
        rec.tokensOut,
        rec.costUsd,
        rec.ttftMs ?? null,
        rec.latencyMs,
        bool(rec.schemaValid),
        rec.error ?? null,
        rec.createdAt,
      );
  }

  attachOutcome(rec: ExecutionOutcomeRecord): void {
    this.db
      .prepare(
        `INSERT INTO execution_outcomes (id, decision_id, test_pass, verifier_pass, patch_applied,
          accepted, rolled_back, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        rec.id,
        rec.decisionId,
        bool(rec.testPass),
        bool(rec.verifierPass),
        bool(rec.patchApplied),
        bool(rec.accepted),
        bool(rec.rolledBack),
        rec.notes ?? null,
        rec.createdAt,
      );
  }

  /** Read decisions joined with their request, newest first. For replay/eval. */
  listDecisions(limit = 500): { request: RoutingRequestRecord; decision: RoutingDecisionRecord }[] {
    const rows = this.db
      .prepare(
        `SELECT d.*, r.subtask_id, r.parent_task_id, r.repo_id, r.task_kind, r.language,
                r.risk_tier, r.prompt_tokens_est, r.features_json, r.created_at AS req_created_at
         FROM routing_decisions d JOIN routing_requests r ON r.id = d.request_id
         ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      request: {
        id: String(row.request_id),
        subtaskId: String(row.subtask_id),
        parentTaskId: (row.parent_task_id as string | null) ?? null,
        repoId: (row.repo_id as string | null) ?? null,
        taskKind: String(row.task_kind),
        language: (row.language as string | null) ?? null,
        riskTier: String(row.risk_tier),
        promptTokensEst: Number(row.prompt_tokens_est ?? 0),
        features: JSON.parse(String(row.features_json ?? '{}')),
        createdAt: Number(row.req_created_at ?? 0),
      },
      decision: {
        id: String(row.id),
        requestId: String(row.request_id),
        strategy: String(row.strategy),
        primaryModel: (row.primary_model as string | null) ?? null,
        verifierModel: (row.verifier_model as string | null) ?? null,
        fallbackModels: JSON.parse(String(row.fallback_models_json ?? '[]')),
        reasonCodes: JSON.parse(String(row.reason_codes_json ?? '[]')),
        rejected: JSON.parse(String(row.rejected_json ?? '[]')),
        scores: JSON.parse(String(row.scores_json ?? '[]')),
        estimatedCostUsd: (row.estimated_cost_usd as number | null) ?? null,
        estimatedLatencyMs: (row.estimated_latency_ms as number | null) ?? null,
        loggedPropensity: Number(row.logged_propensity ?? 1),
        explorationProbability: Number(row.exploration_probability ?? 0),
        createdAt: Number(row.created_at ?? 0),
      },
    }));
  }

  invocationsFor(decisionId: string): ModelInvocationRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM model_invocations WHERE decision_id = ? ORDER BY created_at ASC')
      .all(decisionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      decisionId: String(row.decision_id),
      modelId: String(row.model_id),
      via: (row.via as string | null) ?? null,
      provider: (row.provider as string | null) ?? null,
      role: String(row.role) as ModelInvocationRecord['role'],
      status: String(row.status) as ModelInvocationRecord['status'],
      tokensIn: Number(row.tokens_in ?? 0),
      tokensOut: Number(row.tokens_out ?? 0),
      costUsd: Number(row.cost_usd ?? 0),
      ttftMs: (row.ttft_ms as number | null) ?? null,
      latencyMs: Number(row.latency_ms ?? 0),
      schemaValid:
        row.schema_valid === null || row.schema_valid === undefined ? null : row.schema_valid === 1,
      error: (row.error as string | null) ?? null,
      createdAt: Number(row.created_at ?? 0),
    }));
  }
}
