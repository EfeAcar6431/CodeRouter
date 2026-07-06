import { describe, expect, it } from 'vitest';
import { extractFeatures } from './featureExtractor.js';
import { scoreCandidates } from './scorer.js';
import type { CandidateModel, CodingSubtask } from './types.js';

function model(partial: Partial<CandidateModel> & { modelId: string }): CandidateModel {
  return {
    contextLength: 128_000,
    supportedParameters: [],
    pricePromptPer1M: 1,
    priceCompletionPer1M: 2,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false,
    adapter: 'coderouter_agent',
    codingScore: 60,
    ...partial,
  };
}

const cheapWeak = model({
  modelId: 'cheap-weak',
  pricePromptPer1M: 0.2,
  priceCompletionPer1M: 0.4,
  codingScore: 45,
});
const strongPricey = model({
  modelId: 'strong',
  pricePromptPer1M: 5,
  priceCompletionPer1M: 15,
  codingScore: 82,
});

describe('scoreCandidates', () => {
  it('prefers a cheap sufficient model for an easy, low-risk task', () => {
    const t: CodingSubtask = {
      subtaskId: 's',
      kind: 'cli_script',
      prompt: 'add a --version flag',
      riskTier: 'low',
      filesInScope: ['cli.ts'],
    };
    const { best, reasonCodes } = scoreCandidates(extractFeatures(t), [cheapWeak, strongPricey]);
    expect(best?.model.modelId).toBe('cheap-weak');
    expect(reasonCodes).toContain('cheap_model_sufficient');
  });

  it('prefers the strong model for a hard, high-risk task', () => {
    const t: CodingSubtask = {
      subtaskId: 's',
      kind: 'bugfix',
      prompt: `${'diagnose '.repeat(300)}\nTraceback: at x(y.js:1)`,
      riskTier: 'high',
      filesInScope: [],
    };
    const { best, reasonCodes } = scoreCandidates(extractFeatures(t), [cheapWeak, strongPricey]);
    expect(best?.model.modelId).toBe('strong');
    expect(reasonCodes).toContain('high_risk_use_strong_model');
    expect(reasonCodes).toContain('low_localization_confidence');
  });

  it('produces numeric predictions for every candidate', () => {
    const t: CodingSubtask = {
      subtaskId: 's',
      kind: 'refactor',
      prompt: 'tidy up',
      riskTier: 'medium',
    };
    const { ranked } = scoreCandidates(extractFeatures(t), [cheapWeak, strongPricey]);
    expect(ranked).toHaveLength(2);
    for (const r of ranked) {
      expect(r.predictedPassProb).toBeGreaterThanOrEqual(0);
      expect(r.predictedPassProb).toBeLessThanOrEqual(1);
      expect(Number.isFinite(r.predictedCostUsd)).toBe(true);
      expect(Number.isFinite(r.predictedUtility)).toBe(true);
    }
  });

  it('flags long-context requirement', () => {
    const t: CodingSubtask = {
      subtaskId: 's',
      kind: 'refactor',
      prompt: 'big',
      riskTier: 'low',
      minContextTokens: 150_000,
    };
    const { reasonCodes } = scoreCandidates(extractFeatures(t), [strongPricey]);
    expect(reasonCodes).toContain('long_context_required');
  });
});
