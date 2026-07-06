import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Store, openStore } from '../store/index.js';
import { RoutingLogger } from './logger.js';
import { routeSubtaskDetailed } from './router.js';
import type { CandidateModel, CodingSubtask, ModelInvocationResult } from './types.js';

const POOL: CandidateModel[] = [
  {
    modelId: 'cheap',
    contextLength: 128_000,
    supportedParameters: ['tools'],
    pricePromptPer1M: 0.2,
    priceCompletionPer1M: 0.4,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true,
    via: 'openrouter',
    adapter: 'coderouter_agent',
    codingScore: 60,
  },
];

describe('RoutingLogger', () => {
  let dir: string;
  let store: Store;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cr-routing-log-'));
    store = await openStore(join(dir, 'memory.db'));
  });
  afterEach(async () => {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('migrates the v3 routing tables', () => {
    expect(store.db.userVersion()).toBeGreaterThanOrEqual(3);
  });

  it('persists a request + decision and reads it back', async () => {
    const task: CodingSubtask = {
      subtaskId: 'task-1',
      kind: 'bugfix',
      prompt: 'fix the parser',
      riskTier: 'low',
      filesInScope: ['p.ts'],
    };
    const result = await routeSubtaskDetailed(task, { candidates: POOL });
    const logger = new RoutingLogger(store.routing);
    const { decisionId } = logger.logRoute(task, result);

    const rows = store.routing.listDecisions();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.request.subtaskId).toBe('task-1');
    expect(rows[0]?.decision.id).toBe(decisionId);
    expect(rows[0]?.decision.strategy).toBe(result.decision.strategy);
    expect(rows[0]?.decision.loggedPropensity).toBe(1);
    expect(Array.isArray(rows[0]?.decision.reasonCodes)).toBe(true);
  });

  it('records invocations and an outcome against the decision', async () => {
    const task: CodingSubtask = {
      subtaskId: 'task-2',
      kind: 'refactor',
      prompt: 'tidy',
      riskTier: 'low',
    };
    const result = await routeSubtaskDetailed(task, { candidates: POOL });
    const logger = new RoutingLogger(store.routing);
    const { decisionId } = logger.logRoute(task, result);

    const inv: ModelInvocationResult = {
      modelId: 'cheap',
      via: 'openrouter',
      status: 'ok',
      tokensIn: 100,
      tokensOut: 40,
      costUsd: 0.0003,
      latencyMs: 900,
    };
    logger.logInvocation(decisionId, 'primary', inv);
    logger.attachOutcome(decisionId, { testPass: true, accepted: true });

    const invs = store.routing.invocationsFor(decisionId);
    expect(invs).toHaveLength(1);
    expect(invs[0]?.tokensIn).toBe(100);
    expect(invs[0]?.role).toBe('primary');
  });
});
