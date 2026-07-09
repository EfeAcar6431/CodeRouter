/**
 * Per-task routing policies.
 *
 * This is the "Arch-Router" layer: it decouples *difficulty estimation*
 * (how hard is this query, derived from the classifier's taskType + shape +
 * effort) from *model assignment* (which concrete model the catalog picks).
 * Each policy declares a routing intent, a quality floor, a selection
 * objective, and - for the `value` objective - a feature weight vector.
 *
 * The router consults exactly one policy per request. Because the policy
 * only names an intent + objective + weights (never a concrete model), you
 * can add, swap, or re-price models in `cards.ts` without touching this
 * table. Tuning routing behavior is a single-file change here.
 *
 * Default posture: cost-aware balanced. Everyday chat and small edits go to
 * a strong-but-cheaper model (the `value` objective lets e.g. Sonnet beat
 * Opus once price + speed are weighed). Only genuinely hard work (deep
 * reasoning, adversarial, big refactors) or explicit high/max effort raises
 * the floor to `frontier` and shifts weights toward raw quality.
 */

import type { Intent } from '../catalog/types.js';
import type { Classification, CognitiveShape, Effort } from '../types.js';
import { type Objective, type QualityTier, type ValueWeights } from './tiers.js';

/**
 * Coarse difficulty band. Produced by the difficulty estimator
 * (`router/difficulty.ts`) and consumed here to decide how hard to push the
 * quality floor. Defined in the models layer so the estimator (router layer)
 * can import it without creating a cycle.
 */
export type DifficultyBand = 'low' | 'medium' | 'high' | 'frontier';

export type Difficulty = {
  /** 0..1 difficulty score. */
  score: number;
  band: DifficultyBand;
  /** Human-readable contributing factors, for --explain / rationales. */
  factors: string[];
};

export type RoutingPolicy = {
  /** Stable policy name, surfaced in route rationales + the --explain UX. */
  name: string;
  /** Catalog intent the selector resolves against. */
  intent: Intent;
  /** Minimum quality tier to accept before falling back to best-available. */
  floor: QualityTier;
  /** How to rank the eligible pool. */
  objective: Objective;
  /** Feature weights for the `value` objective (ignored otherwise). */
  weights: ValueWeights;
  /** Human-readable reason the policy was chosen. */
  rationale: string;
};

const SHAPES_NEED_REASONING: (keyof CognitiveShape)[] = [
  'deepReasoning',
  'algorithmic',
  'adversarial',
];

/**
 * Weight presets, named by the role they play. Quality is weighted heavily
 * enough that the default daily driver lands on a strong-but-cheaper model
 * (Sonnet / GPT-5 class) rather than the cheapest model that merely clears
 * the floor - cheapness/speed then separate models of comparable quality
 * and keep us off the priciest frontier model unless the task earns it.
 */
const WEIGHTS = {
  // Daily driver: quality-led, cost-aware. Lands ~strong/GPT-5-class.
  balanced: { quality: 0.7, cheapness: 0.15, speed: 0.05, context: 0.07, reasoning: 0.03 },
  // Big refactors: quality matters more, but price still separates peers.
  refactor: { quality: 0.62, cheapness: 0.22, speed: 0.06, context: 0.08, reasoning: 0.02 },
  // Hard thinking: reasoning + quality lead, price barely.
  reasoning: { quality: 0.65, cheapness: 0.1, speed: 0.03, context: 0.05, reasoning: 0.17 },
  // Long inputs: context window dominates, then cost.
  context: { quality: 0.3, cheapness: 0.12, speed: 0.05, context: 0.5, reasoning: 0.03 },
  // High/max effort: deliberately quality-heavy at a frontier floor.
  topQuality: { quality: 0.8, cheapness: 0.06, speed: 0.02, context: 0.07, reasoning: 0.05 },
} satisfies Record<string, ValueWeights>;

/**
 * Choose the routing policy for a classified request.
 *
 * Priority, highest first:
 *   1. Explicit high/max effort -> frontier, quality-heavy (user asked to
 *      spend for the best result).
 *   2. Deep-reasoning / algorithmic / adversarial shape -> frontier.
 *   3. Huge-context shape -> context-led.
 *   4. Multi-file-taste shape -> refactor (strong floor, quality-led value).
 *   5. Trivial / docs -> cheapest (cost objective, mid floor).
 *   6. Default -> balanced code edit (strong floor, value objective).
 */
export function routingPolicy(
  classification: Classification,
  effort: Effort,
  difficulty?: Difficulty,
): RoutingPolicy {
  const { shape, taskType } = classification;
  const hardReasoning = SHAPES_NEED_REASONING.some((k) => shape[k] >= 0.7);

  // 0) Difficulty estimator can escalate medium-effort work to frontier when
  //    the combined signal (taskType + shape + confidence + prompt features)
  //    is high, even if no single shape crossed its threshold. Context-bound
  //    and trivial tasks are exempt - a long log dump isn't "hard", and a
  //    typo stays cheap.
  if (
    difficulty?.band === 'frontier' &&
    effort !== 'high' &&
    effort !== 'max' &&
    shape.hugeContext <= 0.7 &&
    taskType !== 'trivial' &&
    taskType !== 'docs'
  ) {
    const intent: Intent = shape.multiFileTaste > 0.75 ? 'multi-file' : 'deep-reasoning';
    return policy('hard-task', intent, 'frontier', 'value', WEIGHTS.topQuality, `difficulty=${difficulty.score.toFixed(2)} (frontier band)`);
  }

  // 1) Effort is the user's explicit "spend for quality" lever.
  if (effort === 'high' || effort === 'max') {
    // Still respect a huge-context need (a 1M-token task can't run on a
    // 200k frontier model), otherwise go top-quality frontier.
    if (shape.hugeContext > 0.7) {
      return policy('huge-context-effort', 'huge-context', 'strong', 'value', WEIGHTS.context, `effort=${effort}, hugeContext=${shape.hugeContext.toFixed(2)}`);
    }
    const intent: Intent = shape.multiFileTaste > 0.75 ? 'multi-file' : 'deep-reasoning';
    return policy('top-quality', intent, 'frontier', 'value', WEIGHTS.topQuality, `effort=${effort}: frontier quality`);
  }

  // 2) Genuinely hard reasoning -> frontier floor.
  if (hardReasoning) {
    return policy('deep-reasoning', 'deep-reasoning', 'frontier', 'value', WEIGHTS.reasoning, `hard reasoning shape (deepReasoning=${shape.deepReasoning.toFixed(2)})`);
  }

  // 3) Huge context dominates everything else.
  if (shape.hugeContext > 0.7) {
    return policy('huge-context', 'huge-context', 'strong', 'value', WEIGHTS.context, `hugeContext=${shape.hugeContext.toFixed(2)}`);
  }

  // 4) Multi-file refactor: strong floor, quality-led value.
  if (shape.multiFileTaste > 0.75) {
    return policy('refactor-multi', 'multi-file', 'strong', 'value', WEIGHTS.refactor, `multiFileTaste=${shape.multiFileTaste.toFixed(2)}`);
  }

  // 5) Trivial / docs: cheapest model that clears a mid floor.
  if (taskType === 'trivial' || taskType === 'docs') {
    return policy('chat-qa', 'fast-cheap', 'mid', 'cost', WEIGHTS.balanced, `cheap task (taskType=${taskType})`);
  }

  // 6) Default: balanced everyday code edit.
  return policy('code-edit', 'balanced-agent', 'strong', 'value', WEIGHTS.balanced, `balanced default (taskType=${taskType})`);
}

/**
 * Policy for creative / visual tasks (logo, icon, image generation).
 * Cheap tools-capable agent + `generate_image` tool — never frontier.
 */
export function creativeTaskPolicy(): RoutingPolicy {
  return policy(
    'creative-visual',
    'fast-cheap',
    'mid',
    'cost',
    WEIGHTS.balanced,
    'creative/visual task: cheap agent + generate_image',
  );
}

function policy(
  name: string,
  intent: Intent,
  floor: QualityTier,
  objective: Objective,
  weights: ValueWeights,
  rationale: string,
): RoutingPolicy {
  return { name, intent, floor, objective, weights, rationale };
}
