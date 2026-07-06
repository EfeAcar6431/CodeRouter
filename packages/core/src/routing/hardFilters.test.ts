import { describe, expect, it } from 'vitest';
import { estimateCallCostUsd, filterCandidates } from './hardFilters.js';
import type { CandidateModel, CodingSubtask } from './types.js';

function model(partial: Partial<CandidateModel> & { modelId: string }): CandidateModel {
  return {
    contextLength: 128_000,
    supportedParameters: [],
    pricePromptPer1M: 1,
    priceCompletionPer1M: 2,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true,
    adapter: 'coderouter_agent',
    codingScore: 60,
    ...partial,
  };
}

function task(partial: Partial<CodingSubtask> = {}): CodingSubtask {
  return { subtaskId: 's', kind: 'bugfix', prompt: 'fix it', riskTier: 'low', ...partial };
}

describe('filterCandidates', () => {
  it('keeps a model that satisfies everything', () => {
    const { candidates, rejected } = filterCandidates(task(), [model({ modelId: 'ok' })]);
    expect(candidates.map((c) => c.modelId)).toEqual(['ok']);
    expect(rejected).toHaveLength(0);
  });

  it('rejects on context, tools, and structured output with explicit reasons', () => {
    const models = [
      model({ modelId: 'tiny', contextLength: 4_000 }),
      model({ modelId: 'notools', supportsTools: false }),
      model({ modelId: 'noschema', supportsStructuredOutput: false }),
    ];
    const t = task({
      minContextTokens: 32_000,
      requiresTools: true,
      requiresStructuredOutput: true,
    });
    const { candidates, rejected } = filterCandidates(t, models);
    expect(candidates).toHaveLength(0);
    expect(rejected.find((r) => r.modelId === 'tiny')?.reasons).toContain('context_too_small');
    expect(rejected.find((r) => r.modelId === 'notools')?.reasons).toContain('tools_not_supported');
    expect(rejected.find((r) => r.modelId === 'noschema')?.reasons).toContain(
      'structured_outputs_not_supported',
    );
  });

  it('rejects EU/ZDR when no provider confirms support', () => {
    const t = task({ privacy: { euOnly: true, zdrRequired: true } });
    const { candidates, rejected } = filterCandidates(t, [model({ modelId: 'm' })]);
    expect(candidates).toHaveLength(0);
    expect(rejected[0]?.reasons).toEqual(
      expect.arrayContaining(['eu_not_supported', 'zdr_not_supported']),
    );
  });

  it('keeps a model whose provider confirms EU + ZDR', () => {
    const t = task({ privacy: { euOnly: true, zdrRequired: true } });
    const m = model({
      modelId: 'eu',
      providers: [{ name: 'p', supportsEu: true, supportsZdr: true }],
    });
    const { candidates } = filterCandidates(t, [m]);
    expect(candidates.map((c) => c.modelId)).toEqual(['eu']);
  });

  it('rejects over the cost budget', () => {
    const t = task({ costBudgetUsd: 0.0001, prompt: 'x'.repeat(4000) });
    const m = model({ modelId: 'pricey', pricePromptPer1M: 100, priceCompletionPer1M: 100 });
    const { candidates, rejected } = filterCandidates(t, [m]);
    expect(candidates).toHaveLength(0);
    expect(rejected[0]?.reasons).toContain('over_cost_budget');
  });

  it('rejects over the latency budget only when latency is known', () => {
    const t = task({ latencyBudgetMs: 500 });
    const slow = model({ modelId: 'slow', providers: [{ name: 'p', avgLatencyMs: 900 }] });
    const unknown = model({ modelId: 'unknown' });
    const { candidates, rejected } = filterCandidates(t, [slow, unknown]);
    expect(candidates.map((c) => c.modelId)).toEqual(['unknown']);
    expect(rejected[0]?.reasons).toContain('over_latency_budget');
  });

  it('rejects non-editable adapters when requireEditable is set', () => {
    const chat = model({ modelId: 'chat', adapter: 'openai_compat' });
    const { candidates, rejected } = filterCandidates(task(), [chat], { requireEditable: true });
    expect(candidates).toHaveLength(0);
    expect(rejected[0]?.reasons).toContain('not_editable');
  });

  it('every rejected model has at least one reason', () => {
    const models = [
      model({ modelId: 'a', supportsTools: false }),
      model({ modelId: 'b', contextLength: 1000 }),
    ];
    const t = task({ requiresTools: true, minContextTokens: 8000 });
    const { rejected } = filterCandidates(t, models);
    expect(rejected.every((r) => r.reasons.length > 0)).toBe(true);
  });

  it('estimateCallCostUsd is linear in tokens and price', () => {
    const m = model({ modelId: 'm', pricePromptPer1M: 10, priceCompletionPer1M: 20 });
    expect(estimateCallCostUsd(m, 1_000_000, 0)).toBeCloseTo(10, 5);
    expect(estimateCallCostUsd(m, 0, 1_000_000)).toBeCloseTo(20, 5);
  });
});
