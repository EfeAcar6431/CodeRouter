/**
 * Shadow routing: run the new four-layer router *alongside* live traffic and
 * log its decision, without changing what actually executes.
 *
 * This is the incremental wiring path. Agent mode keeps routing through the
 * legacy `pick`, but also calls `shadowRoute` so every real run produces a
 * logged `routeSubtask` decision (request + decision rows). That gives the
 * eval/replay harness real task traffic to compare policies on, and is the
 * foundation the roadmap's shadow-mode + bandit steps build on. It is strictly
 * best-effort: any failure (no catalog, no store, network hiccup) is swallowed
 * so it can never affect or slow the user's run.
 */

import type { RoutingStore } from '../store/routing.js';
import type { Effort } from '../types.js';
import type { Classification, CognitiveShape } from '../types.js';
import { getModelCatalog } from './catalog.js';
import { taskTypeToKind } from './featureExtractor.js';
import { RoutingLogger } from './logger.js';
import { routeSubtaskDetailed } from './router.js';
import type { CandidateModel, CodingSubtask, RiskTier } from './types.js';

const HARD_SHAPES: (keyof CognitiveShape)[] = ['deepReasoning', 'adversarial', 'algorithmic'];

function deriveRisk(classification: Classification, effort: Effort): RiskTier {
  if (effort === 'high' || effort === 'max') return 'high';
  if (classification.taskType === 'trivial' || classification.taskType === 'docs') return 'low';
  const shape = classification.shape;
  if (HARD_SHAPES.some((k) => shape[k] >= 0.7) || shape.multiFileTaste >= 0.75) return 'high';
  return 'medium';
}

export type BuildSubtaskInput = {
  subtaskId: string;
  prompt: string;
  classification: Classification;
  effort: Effort;
  filesInScope?: string[];
  repoId?: string;
};

/** Build a `CodingSubtask` from a live agent run's classified prompt. */
export function classificationToSubtask(input: BuildSubtaskInput): CodingSubtask {
  return {
    subtaskId: input.subtaskId,
    kind: taskTypeToKind(input.classification.taskType),
    prompt: input.prompt,
    filesInScope: input.filesInScope,
    repoId: input.repoId,
    riskTier: deriveRisk(input.classification, input.effort),
    // Agent mode always edits files, so a shadow decision requires tool use.
    requiresTools: true,
  };
}

export type ShadowOptions = {
  candidates?: CandidateModel[];
  requireEditable?: boolean;
};

/**
 * Route a subtask through the new router and log the decision. Never throws.
 * Returns the logged decisionId, or null when logging was skipped.
 */
export async function shadowRoute(
  store: RoutingStore,
  task: CodingSubtask,
  opts: ShadowOptions = {},
): Promise<string | null> {
  try {
    const candidates = opts.candidates ?? (await getModelCatalog());
    if (candidates.length === 0) return null;
    const result = await routeSubtaskDetailed(task, {
      candidates,
      requireEditable: opts.requireEditable ?? true,
    });
    const logger = new RoutingLogger(store);
    const { decisionId } = logger.logRoute(task, result);
    return decisionId;
  } catch {
    return null;
  }
}
