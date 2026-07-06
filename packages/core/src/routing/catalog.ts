/**
 * Routing model catalog.
 *
 * Thin normalization layer over the existing OpenRouter sync
 * (`agent/providers/openrouter.ts`, disk-cached, offline-friendly): it maps
 * the raw `OpenRouterModel` payload into the router's `CandidateModel` shape,
 * capturing the capability signals the legacy catalog dropped - structured
 * output support and (best-effort) per-provider EU/ZDR/latency metadata - and
 * folding in the benchmark-grounded coding score via `resolveCard`.
 *
 * Discovery, not hand-maintenance: `getModelCatalog` returns the cached
 * catalog (fetching once when stale); `refreshModelCatalog` forces a re-fetch.
 */

import {
  type FetchOptions,
  type OpenRouterModel,
  fetchOpenRouterModels,
  isToolCapable,
  isVisionCapable,
  pricePer1MIn,
  pricePer1MOut,
} from '../agent/providers/openrouter.js';
import { resolveCard } from '../models/resolve.js';
import type { ProviderId } from '../types.js';
import type { CandidateModel } from './types.js';

/** Coding/programming families we keep when filtering the raw OpenRouter list. */
const CODING_FAMILY_HINTS = [
  'coder',
  'code',
  'claude',
  'gpt',
  'o1',
  'o3',
  'gemini',
  'deepseek',
  'qwen',
  'glm',
  'grok',
  'mistral',
  'codestral',
  'llama',
  'command',
];

export type CatalogOptions = FetchOptions & {
  /** Registry provider name attached to each candidate (default `openrouter`). */
  via?: string;
  /** Adapter kind attached to each candidate (default `openai_compat`). */
  adapter?: ProviderId;
  /** When true, keep the full catalog instead of filtering to coding models. */
  includeAll?: boolean;
};

/** structured-output support: OpenRouter advertises it via supported_parameters. */
export function supportsStructuredOutput(m: OpenRouterModel): boolean {
  const params = m.supported_parameters;
  if (!Array.isArray(params)) return false;
  return params.includes('response_format') || params.includes('structured_outputs');
}

/** Heuristic: is this a coding/programming-relevant model worth routing to? */
export function isCodingModel(m: OpenRouterModel): boolean {
  const id = m.id.toLowerCase();
  return CODING_FAMILY_HINTS.some((h) => id.includes(h));
}

/**
 * Pure normalizer: `OpenRouterModel` -> `CandidateModel`. No network, so it's
 * directly unit-testable. Coding score comes from `resolveCard` (curated prior
 * + live merge), which keeps unknown models conservatively ranked.
 */
export function toCandidateModel(m: OpenRouterModel, opts: CatalogOptions = {}): CandidateModel {
  const card = resolveCard(m.id, m);
  return {
    modelId: m.id,
    contextLength: m.context_length ?? card.contextWindow ?? 0,
    supportedParameters: Array.isArray(m.supported_parameters) ? m.supported_parameters : [],
    pricePromptPer1M: pricePer1MIn(m),
    priceCompletionPer1M: pricePer1MOut(m),
    supportsTools: isToolCapable(m),
    supportsVision: isVisionCapable(m),
    supportsStructuredOutput: supportsStructuredOutput(m),
    via: opts.via ?? 'openrouter',
    adapter: opts.adapter ?? 'openai_compat',
    codingScore: card.quality.coding,
    // OpenRouter's /models list does not expose per-provider EU/ZDR flags;
    // left undefined so the hard filter treats "euOnly/zdrRequired" as
    // unconfirmable (and rejects) rather than silently passing.
    providers: undefined,
  };
}

/** Normalize a raw model list, optionally filtering to coding models. */
export function normalizeCatalog(
  models: OpenRouterModel[],
  opts: CatalogOptions = {},
): CandidateModel[] {
  const pool = opts.includeAll ? models : models.filter(isCodingModel);
  return pool.map((m) => toCandidateModel(m, opts));
}

/** Cached catalog as `CandidateModel[]` (fetches once when the cache is stale). */
export async function getModelCatalog(opts: CatalogOptions = {}): Promise<CandidateModel[]> {
  const models = await fetchOpenRouterModels(opts);
  return normalizeCatalog(models, opts);
}

/** Force a network re-fetch, then normalize. */
export async function refreshModelCatalog(opts: CatalogOptions = {}): Promise<CandidateModel[]> {
  const models = await fetchOpenRouterModels({ ...opts, force: true });
  return normalizeCatalog(models, opts);
}
