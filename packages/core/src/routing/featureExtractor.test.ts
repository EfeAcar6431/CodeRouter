import { describe, expect, it } from 'vitest';
import { extractFeatures, kindToTaskType, subtaskToClassification } from './featureExtractor.js';
import type { CodingSubtask } from './types.js';

function task(partial: Partial<CodingSubtask> & { prompt: string }): CodingSubtask {
  return { subtaskId: 's', kind: 'bugfix', riskTier: 'low', ...partial };
}

describe('extractFeatures', () => {
  it('is deterministic for the same task', () => {
    const t = task({ prompt: 'fix the parser', filesInScope: ['src/parse.ts'] });
    expect(extractFeatures(t)).toEqual(extractFeatures(t));
  });

  it('easy task: one file, short prompt -> high localization, small patch', () => {
    const f = extractFeatures(task({ prompt: 'rename x to y', filesInScope: ['a.ts'] }));
    expect(f.localizationConfidence).toBe('high');
    expect(f.expectedPatchSize).toBe('small');
  });

  it('medium task: a few files -> medium localization', () => {
    const f = extractFeatures(
      task({ prompt: 'refactor these', filesInScope: ['a.ts', 'b.ts', 'c.ts'] }),
    );
    expect(f.localizationConfidence).toBe('medium');
  });

  it('hard task: no files + long prompt + stack trace -> low localization, large patch', () => {
    const f = extractFeatures(
      task({
        prompt: `${'context '.repeat(300)}\nTraceback (most recent call last):\n  at foo(bar.js:10)`,
        filesInScope: [],
      }),
    );
    expect(f.localizationConfidence).toBe('low');
    expect(f.expectedPatchSize).toBe('large');
    expect(f.hasStackTrace).toBe(true);
  });

  it('maps kinds to legacy task types', () => {
    expect(kindToTaskType('test_generation')).toBe('test');
    expect(kindToTaskType('localization')).toBe('investigation');
    expect(kindToTaskType('refactor')).toBe('refactor');
  });

  it('synthesizes a classification a high-risk bugfix rates harder than a low-risk one', () => {
    const low = task({ prompt: 'fix', filesInScope: ['a.ts'], riskTier: 'low' });
    const high = task({ prompt: 'fix', filesInScope: ['a.ts'], riskTier: 'high' });
    const cl = subtaskToClassification(low, extractFeatures(low));
    const ch = subtaskToClassification(high, extractFeatures(high));
    expect(ch.shape.deepReasoning).toBeGreaterThan(cl.shape.deepReasoning);
  });
});
