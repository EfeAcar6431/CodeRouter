/**
 * Live agent routing: `routeSubtask` picks the model, logging stays on for
 * future training, and the existing agent tool loop still executes.
 *
 * Replaces the old shadow-only path (log decision, keep running `pick`).
 * Agent mode now *uses* the four-layer decision; the audit trail
 * (request / decision / later invocations) remains so we can train a
 * learned scorer later without changing the hot path again.
 */

import { EDITABLE_ADAPTERS } from '../catalog/resolve.js';
import { CATALOG } from '../catalog/entries.js';
import { resolveCard } from '../models/resolve.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RoutingStore } from '../store/routing.js';
import type { Classification, CognitiveShape, Effort, RouteRef } from '../types.js';
import { getModelCatalog } from './catalog.js';
import { isCreativeTask } from './difficulty.js';
import { taskTypeToKind } from './featureExtractor.js';
import { RoutingLogger } from './logger.js';
import { routeSubtaskDetailed, type RouteResult } from './router.js';
import type { CandidateModel, CodingSubtask, RiskTier } from './types.js';

export { isCreativeTask } from './difficulty.js';

const HARD_SHAPES: (keyof CognitiveShape)[] = ['deepReasoning', 'adversarial', 'algorithmic'];

function deriveRisk(classification: Classification, effort: Effort, prompt: string): RiskTier {
  // Creative / visual work must not escalate to frontier coding models.
  if (isCreativeTask(prompt)) return 'low';
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
  requiresVision?: boolean;
};

/** Build a `CodingSubtask` from a live agent run's classified prompt. */
export function classificationToSubtask(input: BuildSubtaskInput): CodingSubtask {
  return {
    subtaskId: input.subtaskId,
    kind: taskTypeToKind(input.classification.taskType),
    prompt: input.prompt,
    filesInScope: input.filesInScope,
    repoId: input.repoId,
    riskTier: deriveRisk(input.classification, input.effort, input.prompt),
    // Agent mode always edits files.
    requiresTools: true,
    requiresVision: input.requiresVision,
  };
}

/**
 * Candidate pool for agent execution: every model must be reachable via an
 * editable adapter (`coderouter_agent` / `claude_code` / `codex`).
 *
 * OpenRouter models are tagged `via: openrouter_agent` + `adapter:
 * coderouter_agent` so hard filters keep them. Static catalog entries for
 * local CLIs are included when those providers are ready on the registry.
 */
export async function collectAgentCandidates(
  registry: ProviderRegistry,
): Promise<CandidateModel[]> {
  const out: CandidateModel[] = [];
  const seen = new Set<string>();

  const push = (c: CandidateModel): void => {
    const key = `${c.via ?? ''},${c.modelId}`;
    if (seen.has(key)) return;
    // Skip OpenRouter floating aliases — they pollute route labels.
    if (c.modelId.startsWith('~')) return;
    seen.add(key);
    out.push(c);
  };

  if (registry.has('openrouter_agent') && registry.isReady('openrouter_agent')) {
    const live = await getModelCatalog({
      via: 'openrouter_agent',
      adapter: 'coderouter_agent',
    });
    for (const c of live) {
      if (!c.supportsTools) continue;
      push(c);
    }
  }

  // Local CLIs + curated openrouter_agent entries from the static catalog.
  for (const entry of CATALOG) {
    if (!registry.has(entry.provider) || !registry.isReady(entry.provider)) continue;
    const cfg = registry.list().find((p) => p.name === entry.provider);
    if (!cfg || !EDITABLE_ADAPTERS.has(cfg.adapter)) continue;
    const card = resolveCard(entry.model);
    push({
      modelId: entry.model,
      contextLength: entry.contextWindow || card.contextWindow || 0,
      supportedParameters: card.tools ? ['tools'] : [],
      pricePromptPer1M: entry.pricePer1MIn ?? card.pricePer1MIn ?? 0,
      priceCompletionPer1M: entry.pricePer1MOut ?? card.pricePer1MOut ?? 0,
      supportsTools: card.tools || cfg.adapter === 'coderouter_agent',
      supportsVision: card.inputs?.includes('image') ?? false,
      supportsStructuredOutput: false,
      via: entry.provider,
      adapter: cfg.adapter,
      codingScore: card.quality.coding,
    });
  }

  return out;
}

export type AgentRouteResult = {
  route: RouteRef;
  decisionId: string | null;
  result: RouteResult | null;
};

/**
 * Live-route an agent subtask through the four-layer router and log the
 * decision. Falls back to a caller-supplied RouteRef when the router
 * holds out or the catalog is empty.
 */
export async function routeAgentLive(opts: {
  task: CodingSubtask;
  registry: ProviderRegistry;
  store?: RoutingStore;
  /** Used when routeSubtask returns holdout / no primary. */
  fallback: RouteRef;
  candidates?: CandidateModel[];
}): Promise<AgentRouteResult> {
  try {
    const candidates = opts.candidates ?? (await collectAgentCandidates(opts.registry));
    if (candidates.length === 0) {
      return { route: opts.fallback, decisionId: null, result: null };
    }

    const result = await routeSubtaskDetailed(opts.task, {
      candidates,
      requireEditable: true,
    });

    let decisionId: string | null = null;
    if (opts.store) {
      try {
        const logger = new RoutingLogger(opts.store);
        decisionId = logger.logRoute(opts.task, result).decisionId;
      } catch {
        // Logging must never block the run.
      }
    }

    const { decision, score } = result;
    if (decision.strategy === 'holdout' || !decision.primaryModel) {
      return { route: opts.fallback, decisionId, result };
    }

    const best = score.ranked.find((s) => s.model.modelId === decision.primaryModel);
    const meta = best?.model;
    const via = meta?.via ?? 'openrouter_agent';
    const provider = (meta?.adapter ?? 'coderouter_agent') as RouteRef['provider'];
    const reasons = decision.reasonCodes.slice(0, 4).join(',');

    return {
      route: {
        provider,
        model: decision.primaryModel,
        via,
        rationale: `routeSubtask:${decision.strategy} [${reasons}] est=$${
          decision.estimatedCostUsd?.toFixed(4) ?? '?'
        }`,
      },
      decisionId,
      result,
    };
  } catch {
    return { route: opts.fallback, decisionId: null, result: null };
  }
}
