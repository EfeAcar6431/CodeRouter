import { describe, expect, it } from 'vitest';
import type { ScoredCandidate } from './scorer.js';
import { selectStrategy } from './strategySelector.js';
import type { CandidateModel, CodingSubtask, RoutingFeatures } from './types.js';

function scored(modelId: string, passProb: number, cost = 0.01): ScoredCandidate {
  const model = {
    modelId,
    contextLength: 128_000,
    supportedParameters: [],
    pricePromptPer1M: 1,
    priceCompletionPer1M: 2,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false,
    codingScore: Math.round(passProb * 100),
  } as CandidateModel;
  return {
    model,
    predictedPassProb: passProb,
    predictedCostUsd: cost,
    predictedLatencyMs: 1500,
    predictedUtility: passProb - cost,
  };
}

function features(partial: Partial<RoutingFeatures> = {}): RoutingFeatures {
  return {
    promptTokensEst: 100,
    filesCount: 1,
    hasStackTrace: false,
    taskKind: 'bugfix',
    riskTier: 'low',
    minContextTokens: 8_000,
    expectedPatchSize: 'small',
    localizationConfidence: 'high',
    requiresTools: false,
    requiresStructuredOutput: false,
    ...partial,
  };
}

const task = (partial: Partial<CodingSubtask> = {}): CodingSubtask => ({
  subtaskId: 's',
  kind: 'bugfix',
  prompt: 'x',
  riskTier: 'low',
  ...partial,
});

describe('selectStrategy', () => {
  it('easy low-risk -> single_shot', () => {
    const d = selectStrategy(task({ riskTier: 'low' }), features({ riskTier: 'low' }), [
      scored('a', 0.7),
      scored('b', 0.8),
    ]);
    expect(d.strategy).toBe('single_shot');
    expect(d.primaryModel).toBe('a');
  });

  it('medium risk with a stronger verifier -> draft_verify', () => {
    const d = selectStrategy(
      task({ riskTier: 'medium' }),
      features({ riskTier: 'medium', localizationConfidence: 'medium' }),
      [scored('draft', 0.65), scored('verifier', 0.9)],
    );
    expect(d.strategy).toBe('draft_verify');
    expect(d.primaryModel).toBe('draft');
    expect(d.verifierModel).toBe('verifier');
  });

  it('hard, poorly-localized, high-risk -> bounded_cascade with fallbacks', () => {
    const d = selectStrategy(
      task({ riskTier: 'high' }),
      features({
        riskTier: 'high',
        localizationConfidence: 'low',
        expectedPatchSize: 'large',
        filesCount: 0,
      }),
      [scored('primary', 0.7), scored('fb1', 0.85), scored('fb2', 0.6)],
    );
    expect(d.strategy).toBe('bounded_cascade');
    expect(d.primaryModel).toBe('primary');
    expect(d.fallbackModels?.length).toBeGreaterThanOrEqual(1);
    expect(d.reasonCodes).toContain('low_localization_confidence');
  });

  it('impossible task (no candidates) -> holdout', () => {
    const d = selectStrategy(task(), features(), []);
    expect(d.strategy).toBe('holdout');
    expect(d.reasonCodes).toContain('no_viable_model');
  });

  it('repeated failures -> holdout', () => {
    const d = selectStrategy(task({ priorFailureCount: 3 }), features(), [scored('a', 0.9)]);
    expect(d.strategy).toBe('holdout');
    expect(d.reasonCodes).toContain('repeated_failure');
  });

  it('high-risk with only an unreliable model -> holdout (safety_critical)', () => {
    const d = selectStrategy(task({ riskTier: 'high' }), features({ riskTier: 'high' }), [
      scored('weak', 0.2),
    ]);
    expect(d.strategy).toBe('holdout');
    expect(d.reasonCodes).toContain('safety_critical');
  });

  it('cost-impossible best candidate -> holdout (budget_impossible)', () => {
    const d = selectStrategy(task({ costBudgetUsd: 0.001 }), features(), [scored('a', 0.9, 0.5)]);
    expect(d.strategy).toBe('holdout');
    expect(d.reasonCodes).toContain('budget_impossible');
  });
});
