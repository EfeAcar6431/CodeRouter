import { describe, expect, it } from 'vitest';
import { type InvokeModel, executeDecision } from './executor.js';
import type {
  CandidateModel,
  CodingSubtask,
  ModelInvocationResult,
  RoutingDecision,
} from './types.js';

const task: CodingSubtask = { subtaskId: 's', kind: 'bugfix', prompt: 'fix', riskTier: 'medium' };

function okResult(modelId: string): ModelInvocationResult {
  return {
    modelId,
    status: 'ok',
    tokensIn: 10,
    tokensOut: 5,
    costUsd: 0.001,
    latencyMs: 100,
    text: `out:${modelId}`,
  };
}
function errResult(modelId: string): ModelInvocationResult {
  return {
    modelId,
    status: 'error',
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
    latencyMs: 50,
    error: 'boom',
  };
}

const models: CandidateModel[] = [];

describe('executeDecision', () => {
  it('holdout makes no call', async () => {
    const invoke: InvokeModel = async () => okResult('never');
    const res = await executeDecision(
      task,
      { decisionId: 'd', strategy: 'holdout', reasonCodes: [], loggedPropensity: 1 },
      { invoke, models },
    );
    expect(res.status).toBe('held_out');
    expect(res.invocations).toHaveLength(0);
    expect(res.costUsd).toBe(0);
  });

  it('single_shot calls the primary once', async () => {
    const calls: string[] = [];
    const invoke: InvokeModel = async (r) => {
      calls.push(r.modelId);
      return okResult(r.modelId);
    };
    const d: RoutingDecision = {
      decisionId: 'd',
      strategy: 'single_shot',
      primaryModel: 'p',
      reasonCodes: [],
      loggedPropensity: 1,
    };
    const res = await executeDecision(task, d, { invoke, models });
    expect(calls).toEqual(['p']);
    expect(res.status).toBe('ok');
    expect(res.text).toBe('out:p');
  });

  it('draft_verify calls primary then verifier', async () => {
    const calls: { id: string; role: string }[] = [];
    const invoke: InvokeModel = async (r) => {
      calls.push({ id: r.modelId, role: r.role });
      return okResult(r.modelId);
    };
    const d: RoutingDecision = {
      decisionId: 'd',
      strategy: 'draft_verify',
      primaryModel: 'draft',
      verifierModel: 'verify',
      reasonCodes: [],
      loggedPropensity: 1,
    };
    const res = await executeDecision(task, d, { invoke, models });
    expect(calls).toEqual([
      { id: 'draft', role: 'primary' },
      { id: 'verify', role: 'verifier' },
    ]);
    expect(res.text).toBe('out:verify');
    expect(res.tokensIn).toBe(20);
  });

  it('bounded_cascade escalates to fallbacks until one succeeds', async () => {
    const calls: string[] = [];
    const invoke: InvokeModel = async (r) => {
      calls.push(r.modelId);
      return r.modelId === 'fb2' ? okResult('fb2') : errResult(r.modelId);
    };
    const d: RoutingDecision = {
      decisionId: 'd',
      strategy: 'bounded_cascade',
      primaryModel: 'p',
      fallbackModels: ['fb1', 'fb2'],
      reasonCodes: [],
      loggedPropensity: 1,
    };
    const res = await executeDecision(task, d, { invoke, models });
    expect(calls).toEqual(['p', 'fb1', 'fb2']);
    expect(res.status).toBe('ok');
    expect(res.text).toBe('out:fb2');
  });

  it('bounded_cascade stops at the first success', async () => {
    const calls: string[] = [];
    const invoke: InvokeModel = async (r) => {
      calls.push(r.modelId);
      return okResult(r.modelId);
    };
    const d: RoutingDecision = {
      decisionId: 'd',
      strategy: 'bounded_cascade',
      primaryModel: 'p',
      fallbackModels: ['fb1'],
      reasonCodes: [],
      loggedPropensity: 1,
    };
    await executeDecision(task, d, { invoke, models });
    expect(calls).toEqual(['p']);
  });

  it('a throwing invoke becomes an error result, not an exception', async () => {
    const invoke: InvokeModel = async () => {
      throw new Error('network down');
    };
    const d: RoutingDecision = {
      decisionId: 'd',
      strategy: 'single_shot',
      primaryModel: 'p',
      reasonCodes: [],
      loggedPropensity: 1,
    };
    const res = await executeDecision(task, d, { invoke, models });
    expect(res.status).toBe('error');
    expect(res.invocations[0]?.result.error).toContain('network down');
  });
});
