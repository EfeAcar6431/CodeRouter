/**
 * Quality tiers + per-intent selection policy.
 *
 * The router is quality-first: for real coding work it ranks candidates
 * by a benchmark-grounded coding score and lets cost only break ties.
 * Cost becomes the primary objective only for explicitly trivial work.
 *
 * A model's `coding` score lives in [0,100] (see `cards.ts`). Tiers are
 * coarse bands over that score, used for the per-task quality *floor*
 * (the minimum we'll accept before falling back) and for UI labels.
 */

import type { Intent } from '../catalog/types.js';
import type { Classification, Effort } from '../types.js';

export type QualityTier = 'frontier' | 'strong' | 'mid' | 'small';

/** Lower bound (inclusive) of each tier on the 0-100 coding scale. */
export const TIER_MIN: Record<QualityTier, number> = {
  frontier: 80,
  strong: 65,
  mid: 45,
  small: 0,
};

/** Order used when comparing tiers (higher index = better). */
export const TIER_ORDER: QualityTier[] = ['small', 'mid', 'strong', 'frontier'];

/** Map a 0-100 coding score to its coarse tier. */
export function tierForCoding(coding: number): QualityTier {
  if (coding >= TIER_MIN.frontier) return 'frontier';
  if (coding >= TIER_MIN.strong) return 'strong';
  if (coding >= TIER_MIN.mid) return 'mid';
  return 'small';
}

/** Minimum coding score required to clear a given floor tier. */
export function floorScore(tier: QualityTier): number {
  return TIER_MIN[tier];
}

/**
 * Selection objective:
 *   - `quality`: rank by coding score, cost only breaks ties. Used by
 *     tournaments / `pickStrong` where we deliberately want the top model.
 *   - `cost`: cheapest model that still clears the quality floor. Used for
 *     genuinely trivial work.
 *   - `value`: rank by a normalized weighted score across quality, price,
 *     speed and context (see `ValueWeights`). This is the default for real
 *     coding work - it keeps cost/speed first-class so a marginally weaker
 *     but far cheaper/faster model can win, instead of always defaulting to
 *     the single highest-scoring (and most expensive) frontier model.
 */
export type Objective = 'quality' | 'cost' | 'value';

/**
 * Feature weights for the `value` objective. Each feature is normalized to
 * [0,1] in the selector; weights typically sum to ~1 so scores stay
 * comparable across policies. The per-task policy table (`policies.ts`)
 * owns the concrete weight vectors.
 */
export type ValueWeights = {
  /** Coding quality (benchmark prior + local learning), normalized /100. */
  quality: number;
  /** Cheapness: 1 for free, decaying toward 0 as price climbs. */
  cheapness: number;
  /** Speed prior: faster for cheap/non-reasoning models. */
  speed: number;
  /** Context headroom, normalized against a 256k ceiling. */
  context: number;
  /** Whether the model is a reasoning ("thinking") model. */
  reasoning: number;
};

/** Sensible balanced default when a caller asks for `value` without weights. */
export const DEFAULT_VALUE_WEIGHTS: ValueWeights = {
  quality: 0.7,
  cheapness: 0.15,
  speed: 0.05,
  context: 0.07,
  reasoning: 0.03,
};

export type IntentDefaults = {
  /** Minimum coding tier we want before falling back to "best available". */
  floor: QualityTier;
  objective: Objective;
  /** Minimum context window in tokens. */
  minContextWindow: number;
};

/**
 * Per-intent defaults. Real coding work is quality-first with a high
 * floor (frontier-by-default falls out naturally: quality ranking picks
 * the best eligible model). Only `fast-cheap` / `local-offline` flip to
 * a cost objective for genuinely trivial tasks.
 */
export const INTENT_DEFAULTS: Record<Intent, IntentDefaults> = {
  'deep-reasoning': { floor: 'frontier', objective: 'quality', minContextWindow: 16_000 },
  'multi-file': { floor: 'frontier', objective: 'quality', minContextWindow: 60_000 },
  // Value (not raw quality) so Sonnet/GPT-class beats Opus on everyday work
  // when resolveIntent is called without an explicit policy override.
  'balanced-agent': { floor: 'strong', objective: 'value', minContextWindow: 16_000 },
  'huge-context': { floor: 'strong', objective: 'quality', minContextWindow: 200_000 },
  'fast-cheap': { floor: 'mid', objective: 'cost', minContextWindow: 8_000 },
  'local-offline': { floor: 'small', objective: 'cost', minContextWindow: 0 },
};

/**
 * Quality floor for a task, given its classification + effort. This is the
 * minimum tier we'll accept before falling back to "best available"; the
 * `value` objective then optimizes cost/speed *within* the eligible pool.
 *
 * Crucially this is only a floor, NOT a target: at medium effort everyday
 * work clears a `strong` floor and the value score is free to pick a
 * cheaper strong model over the priciest frontier one. Only explicit
 * high/max effort (or genuinely hard shapes, handled by the policy table)
 * raises the floor to `frontier`. Trivial/docs drop to `mid`.
 *
 * The per-task policy table (`policies.ts`) is the primary owner of the
 * floor for interactive routing; this remains the simple fallback.
 */
export function taskFloor(classification: Classification, effort: Effort): QualityTier {
  const { taskType } = classification;
  if (taskType === 'trivial' || taskType === 'docs') return 'mid';
  if (effort === 'high' || effort === 'max') return 'frontier';
  return 'strong';
}
