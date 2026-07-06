import { describe, expect, it } from 'vitest';
import { FILTER_REASON_CODES, isReasonCode } from './reasonCodes.js';
import type {
  CandidateModel,
  CodingSubtask,
  ModelInvocationResult,
  RoutingDecision,
} from './types.js';

describe('routing types', () => {
  it('constructs a CodingSubtask', () => {
    const task: CodingSubtask = {
      subtaskId: 's1',
      kind: 'bugfix',
      prompt: 'fix the null deref',
      riskTier: 'medium',
      filesInScope: ['src/a.ts'],
      privacy: { euOnly: true, zdrRequired: false },
    };
    expect(task.kind).toBe('bugfix');
    expect(task.privacy?.euOnly).toBe(true);
  });

  it('constructs a CandidateModel with provider metadata', () => {
    const m: CandidateModel = {
      modelId: 'anthropic/claude-sonnet-4-5',
      contextLength: 200_000,
      supportedParameters: ['tools', 'reasoning'],
      pricePromptPer1M: 3,
      priceCompletionPer1M: 15,
      supportsTools: true,
      supportsVision: true,
      supportsStructuredOutput: false,
      via: 'openrouter',
      adapter: 'openai_compat',
      codingScore: 72,
      providers: [{ name: 'anthropic', supportsEu: true, supportsZdr: true, avgLatencyMs: 800 }],
    };
    expect(m.providers?.[0]?.supportsZdr).toBe(true);
  });

  it('constructs a RoutingDecision with deterministic propensity', () => {
    const d: RoutingDecision = {
      decisionId: 'd1',
      strategy: 'single_shot',
      primaryModel: 'gpt-5',
      fallbackModels: [],
      reasonCodes: ['strategy_single_shot', 'balanced_default'],
      estimatedCostUsd: 0.01,
      estimatedLatencyMs: 1200,
      loggedPropensity: 1,
      explorationProbability: 0,
    };
    expect(d.loggedPropensity).toBe(1);
    expect(d.reasonCodes.every((c) => isReasonCode(c))).toBe(true);
  });

  it('constructs a ModelInvocationResult', () => {
    const r: ModelInvocationResult = {
      modelId: 'gpt-5',
      status: 'ok',
      tokensIn: 100,
      tokensOut: 50,
      costUsd: 0.002,
      latencyMs: 1500,
      schemaValid: true,
    };
    expect(r.status).toBe('ok');
  });

  it('every filter reason code is a valid reason code', () => {
    expect(FILTER_REASON_CODES.every((c) => isReasonCode(c))).toBe(true);
  });
});
