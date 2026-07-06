import { describe, expect, it } from 'vitest';
import type { Classification } from '../types.js';
import { estimateDifficulty } from './difficulty.js';

function classification(
  partial: Partial<Classification> & { taskType: Classification['taskType'] },
): Classification {
  return {
    hash: 'h',
    source: 'rules',
    confidence: 0.9,
    rationale: '',
    shape: {
      deepReasoning: 0.2,
      multiFileTaste: 0.2,
      hugeContext: 0.1,
      adversarial: 0.1,
      algorithmic: 0.1,
      exploratory: 0.2,
    },
    ...partial,
  };
}

describe('estimateDifficulty', () => {
  it('scores a trivial task as low', () => {
    const d = estimateDifficulty(classification({ taskType: 'trivial' }), 'medium');
    expect(d.band).toBe('low');
    expect(d.score).toBeLessThan(0.25);
  });

  it('scores a hard refactor with strong shapes as high or frontier', () => {
    const d = estimateDifficulty(
      classification({
        taskType: 'refactor',
        shape: {
          deepReasoning: 0.9,
          multiFileTaste: 0.85,
          hugeContext: 0.2,
          adversarial: 0.4,
          algorithmic: 0.6,
          exploratory: 0.4,
        },
      }),
      'medium',
    );
    expect(['high', 'frontier']).toContain(d.band);
  });

  it('max effort pushes difficulty to frontier', () => {
    const d = estimateDifficulty(classification({ taskType: 'feature' }), 'max');
    expect(d.band).toBe('frontier');
  });

  it('low confidence raises the score', () => {
    const sure = estimateDifficulty(
      classification({ taskType: 'feature', confidence: 0.95 }),
      'medium',
    );
    const unsure = estimateDifficulty(
      classification({ taskType: 'feature', confidence: 0.2 }),
      'medium',
    );
    expect(unsure.score).toBeGreaterThan(sure.score);
  });

  it('prompt features (stack trace + hard keywords) raise the score', () => {
    const plain = estimateDifficulty(
      classification({ taskType: 'bugfix' }),
      'medium',
      'fix the button',
    );
    const gnarly = estimateDifficulty(
      classification({ taskType: 'bugfix' }),
      'medium',
      'we have a race condition deadlock; Traceback (most recent call last):\n  at foo (bar.ts:42)',
    );
    expect(gnarly.score).toBeGreaterThan(plain.score);
  });
});
