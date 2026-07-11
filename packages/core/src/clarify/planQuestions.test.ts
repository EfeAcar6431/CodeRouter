import { describe, expect, it } from 'vitest';
import {
  buildPlanClarifyQuestions,
  formatClarifyAnswers,
} from './planQuestions.js';

describe('buildPlanClarifyQuestions', () => {
  it('asks platform / features / art for an FPS greenfield prompt', () => {
    const qs = buildPlanClarifyQuestions({
      prompt: 'i want to build a first person shooter game',
      emptyRepo: false,
    });
    expect(qs.map((q) => q.header)).toEqual(['Platform', 'Features', 'Art style']);
    expect(qs[0]!.options.some((o) => /Browser/i.test(o.label))).toBe(true);
    expect(qs[0]!.options.every((o) => o.description)).toBe(true);
  });

  it('does not ask stack/scope for a generic build fix in a full repo', () => {
    const qs = buildPlanClarifyQuestions({
      prompt: 'build a fix for the routing scorer',
      emptyRepo: false,
    });
    expect(qs.length).toBe(0);
  });

  it('formats answers as hard constraints', () => {
    const text = formatClarifyAnswers([
      { questionId: 'platform', header: 'Platform', answer: 'Browser (Recommended)' },
    ]);
    expect(text).toContain('hard constraints');
    expect(text).toContain('**Platform**: Browser (Recommended)');
  });
});
