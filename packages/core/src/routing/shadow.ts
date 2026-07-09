/**
 * Shadow routing (legacy incremental path).
 *
 * Agent mode now live-routes via `agentRoute.ts` (`routeAgentLive`). This
 * module remains for callers that want to log a counterfactual decision
 * without executing it (eval / future A-B). Prefer `routeAgentLive` for
 * production agent traffic.
 *
 * `classificationToSubtask` lives in `agentRoute.ts` (single source of truth).
 */

import type { RoutingStore } from '../store/routing.js';
import { getModelCatalog } from './catalog.js';
import { RoutingLogger } from './logger.js';
import { routeSubtaskDetailed } from './router.js';
import type { CandidateModel, CodingSubtask } from './types.js';

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
