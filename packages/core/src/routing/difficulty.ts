/**
 * Difficulty estimator.
 *
 * Collapses the many routing signals (task type, cognitive shape, classifier
 * confidence, and - when available - cheap prompt features) into a single
 * 0..1 difficulty score + coarse band. The band feeds `routingPolicy`
 * (`models/policies.ts`), which uses it to decide how hard to push the
 * quality floor. This generalizes the old per-shape thresholds: a task can
 * earn a frontier model from the *combination* of signals even when no
 * single shape crosses its individual threshold.
 *
 * It is deterministic and prompt-optional: `pick()` only has the
 * Classification, but callers that still hold the raw prompt can pass it for
 * a few extra features (length, code fences, stack traces, hard keywords).
 */

import type { Difficulty, DifficultyBand } from '../models/index.js';
import type { Classification, Effort, TaskType } from '../types.js';

/** Intrinsic difficulty prior per task type, in [0,1]. */
const TASK_BASE: Record<TaskType, number> = {
  trivial: 0.05,
  docs: 0.12,
  test: 0.38,
  review: 0.45,
  bugfix: 0.48,
  feature: 0.52,
  investigation: 0.55,
  refactor: 0.62,
};

const EFFORT_BUMP: Record<Effort, number> = {
  low: -0.12,
  medium: 0,
  high: 0.28,
  max: 0.45,
};

const HARD_KEYWORDS =
  /\b(architecture|refactor|redesign|concurren|race condition|deadlock|distributed|algorithm|complexity|optimi[sz]e|migrat|threading|async|invariant|proof)\b/i;
const STACK_TRACE = /(\bat\s+.+\(.+:\d+\)|Traceback \(most recent call last\)|Exception in thread)/;
const CODE_FENCE = /```/;

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function bandFor(score: number): DifficultyBand {
  if (score < 0.25) return 'low';
  if (score < 0.5) return 'medium';
  if (score < 0.75) return 'high';
  return 'frontier';
}

/**
 * Estimate task difficulty from a classification (+ optional raw prompt).
 */
export function estimateDifficulty(
  classification: Classification,
  effort: Effort,
  prompt?: string,
): Difficulty {
  const { shape, taskType, confidence } = classification;
  const factors: string[] = [];

  const taskBase = TASK_BASE[taskType] ?? 0.5;
  const reasoningMax = Math.max(
    shape.deepReasoning,
    shape.algorithmic,
    shape.adversarial,
    shape.multiFileTaste,
  );

  // Core: blend the intrinsic task prior with the strongest "hard" shape.
  let score = 0.5 * taskBase + 0.5 * reasoningMax;
  factors.push(`task=${taskType}(${taskBase.toFixed(2)})`, `shapeMax=${reasoningMax.toFixed(2)}`);

  // Uncertainty: a low-confidence classification leans us slightly harder so
  // ambiguous prompts don't get under-served.
  if (confidence < 0.6) {
    const bump = (0.6 - confidence) * 0.4;
    score += bump;
    factors.push(`lowConfidence+${bump.toFixed(2)}`);
  }

  // Effort is the explicit spend lever.
  const effortBump = EFFORT_BUMP[effort] ?? 0;
  if (effortBump !== 0) {
    score += effortBump;
    factors.push(`effort=${effort}${effortBump > 0 ? '+' : ''}${effortBump.toFixed(2)}`);
  }

  // Optional cheap prompt features.
  if (prompt) {
    const len = prompt.length;
    if (len > 12_000) {
      score += 0.12;
      factors.push('longPrompt+0.12');
    } else if (len > 4_000) {
      score += 0.06;
      factors.push('mediumPrompt+0.06');
    }
    if (STACK_TRACE.test(prompt)) {
      score += 0.1;
      factors.push('stackTrace+0.10');
    }
    if (CODE_FENCE.test(prompt)) {
      score += 0.04;
      factors.push('codeBlock+0.04');
    }
    if (HARD_KEYWORDS.test(prompt)) {
      score += 0.08;
      factors.push('hardKeyword+0.08');
    }
  }

  score = clamp(score, 0, 1);
  return { score, band: bandFor(score), factors };
}
