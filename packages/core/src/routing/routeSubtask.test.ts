import { describe, expect, it } from 'vitest';
import { routeSubtask, routeSubtaskDetailed } from './router.js';
import type { CandidateModel, CodingSubtask } from './types.js';

function model(partial: Partial<CandidateModel> & { modelId: string }): CandidateModel {
  return {
    contextLength: 200_000,
    supportedParameters: ['tools'],
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

const POOL: CandidateModel[] = [
  model({ modelId: 'cheap', pricePromptPer1M: 0.2, priceCompletionPer1M: 0.4, codingScore: 55 }),
  model({ modelId: 'balanced', pricePromptPer1M: 3, priceCompletionPer1M: 15, codingScore: 72 }),
  model({ modelId: 'frontier', pricePromptPer1M: 5, priceCompletionPer1M: 15, codingScore: 85 }),
];

describe('routeSubtask', () => {
  it('routes an easy low-risk task single-shot to a cheap model', async () => {
    const task: CodingSubtask = {
      subtaskId: 's',
      kind: 'cli_script',
      prompt: 'add --version',
      riskTier: 'low',
      filesInScope: ['cli.ts'],
    };
    const d = await routeSubtask(task, { candidates: POOL });
    expect(d.strategy).toBe('single_shot');
    expect(d.primaryModel).toBe('cheap');
    expect(d.loggedPropensity).toBe(1);
    expect(d.explorationProbability).toBe(0);
    expect(d.reasonCodes).toContain('strategy_single_shot');
    expect(d.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('holds out when the cost budget is impossible for all models', async () => {
    const task: CodingSubtask = {
      subtaskId: 's',
      kind: 'bugfix',
      prompt: 'x'.repeat(4000),
      riskTier: 'medium',
      costBudgetUsd: 1e-9,
    };
    const d = await routeSubtask(task, { candidates: POOL });
    expect(d.strategy).toBe('holdout');
    expect(d.primaryModel).toBeUndefined();
    expect(d.estimatedCostUsd).toBe(0);
  });

  it('escalates a hard, high-risk, poorly-localized task to a bounded cascade', async () => {
    const task: CodingSubtask = {
      subtaskId: 's',
      kind: 'bugfix',
      prompt: `${'analyze '.repeat(400)}\nTraceback: at f(x.js:1)`,
      riskTier: 'high',
      filesInScope: [],
    };
    const { decision, filter } = await routeSubtaskDetailed(task, { candidates: POOL });
    expect(decision.strategy).toBe('bounded_cascade');
    expect(decision.primaryModel).toBeDefined();
    expect(decision.fallbackModels?.length).toBeGreaterThanOrEqual(1);
    expect(filter.rejected).toHaveLength(0);
  });

  it('records reasons for filtered-out models', async () => {
    const task: CodingSubtask = {
      subtaskId: 's',
      kind: 'bugfix',
      prompt: 'fix',
      riskTier: 'low',
      requiresStructuredOutput: true,
    };
    const withNoSchema = [...POOL, model({ modelId: 'noschema', supportsStructuredOutput: false })];
    const { filter } = await routeSubtaskDetailed(task, { candidates: withNoSchema });
    expect(filter.rejected.find((r) => r.modelId === 'noschema')?.reasons).toContain(
      'structured_outputs_not_supported',
    );
  });
});
