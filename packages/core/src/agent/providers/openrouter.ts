/**
 * OpenRouter model catalog.
 *
 * OpenRouter exposes hundreds of models with wildly different
 * capabilities, pricing, and tool-calling support. Hard-coding a
 * subset in the static registry catalog (as we do for routing
 * rankings) would be too restrictive for users who want to point
 * at a specific model. Instead we lazily fetch
 * `https://openrouter.ai/api/v1/models` and cache the response
 * on disk so subsequent runs are offline-friendly.
 *
 * Public surface:
 *   - `fetchOpenRouterModels({ apiKey, force })`     network + cache
 *   - `getOpenRouterModel(id, opts)`                 single lookup
 *   - `listOpenRouterToolCapableModels(opts)`        filtered + ranked
 *   - `isToolCapable(model)`                         capability check
 *
 * Cache:
 *   `~/.coderouter/cache/openrouter-models.json`, default TTL 24h.
 *   Stale data is still readable (`force: false` returns it) so
 *   the agent works offline; `force: true` always re-fetches.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const ENDPOINT = 'https://openrouter.ai/api/v1/models';

export type OpenRouterModel = {
  id: string;
  name: string;
  context_length: number;
  pricing: {
    /** USD per token (string per OpenRouter's API). */
    prompt: string;
    completion: string;
  };
  /** Capability hints OpenRouter exposes when the upstream advertises them. */
  supported_parameters?: string[];
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
    instruct_type?: string;
    tokenizer?: string;
  };
  top_provider?: { context_length?: number; max_completion_tokens?: number };
  /** Free-form description from OpenRouter. */
  description?: string;
};

export type OpenRouterCacheMeta = {
  fetchedAt: number;
  models: OpenRouterModel[];
};

export type FetchOptions = {
  apiKey?: string;
  /** Bypass the cache and re-fetch even if not expired. */
  force?: boolean;
  /** Cache file path override (mainly for tests). */
  cachePath?: string;
  /** TTL override (ms). */
  ttlMs?: number;
  /** HTTP timeout (ms). Defaults to 15s. */
  timeoutMs?: number;
};

/** Default cache location; honours `XDG_CACHE_HOME` when present. */
export function defaultCachePath(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const root = xdg ? join(xdg, 'coderouter') : join(homedir(), '.coderouter', 'cache');
  return join(root, 'openrouter-models.json');
}

/**
 * Fetch the OpenRouter model catalog with on-disk caching.
 *
 * Behaviour:
 *   - Cache fresh (within TTL) -> return cached.
 *   - Cache stale or missing -> fetch network. On failure, fall
 *     back to whatever's in the cache (even if stale) so an
 *     offline session still works.
 *   - `force: true` -> always re-fetch network; only fall back to
 *     cache on network error.
 */
export async function fetchOpenRouterModels(
  opts: FetchOptions = {},
): Promise<OpenRouterModel[]> {
  const cachePath = opts.cachePath ?? defaultCachePath();
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;

  if (!opts.force) {
    const fresh = await readFreshCache(cachePath, ttl);
    if (fresh) return fresh.models;
  }

  try {
    const models = await fetchFromNetwork(opts);
    await writeCache(cachePath, { fetchedAt: Date.now(), models });
    return models;
  } catch (err) {
    const stale = await readAnyCache(cachePath);
    if (stale) return stale.models;
    throw err;
  }
}

/**
 * Look up a single model by id (e.g. `anthropic/claude-sonnet-4-5`).
 * Returns null when the id isn't in the catalog.
 */
export async function getOpenRouterModel(
  id: string,
  opts: FetchOptions = {},
): Promise<OpenRouterModel | null> {
  const all = await fetchOpenRouterModels(opts);
  return all.find((m) => m.id === id) ?? null;
}

/**
 * Returns the subset of models that advertise tool-calling support.
 * Optionally filters by a substring search (matched against id +
 * name + description) to keep the list manageable in the UI.
 */
export async function listOpenRouterToolCapableModels(
  opts: FetchOptions & { search?: string } = {},
): Promise<OpenRouterModel[]> {
  const all = await fetchOpenRouterModels(opts);
  const tools = all.filter(isToolCapable);
  if (!opts.search) return tools;
  const q = opts.search.toLowerCase();
  return tools.filter((m) => {
    const haystack = `${m.id} ${m.name ?? ''} ${m.description ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Heuristic tool-calling capability check. OpenRouter exposes
 * `supported_parameters` for most models; presence of `tools` or
 * `tool_choice` is the strongest signal. Conservative: when the
 * field is absent we only allow models from providers/families
 * known to support tools so we don't dispatch agent runs at a
 * model that'll silently ignore the tool schema.
 */
export function isToolCapable(m: OpenRouterModel): boolean {
  const params = m.supported_parameters;
  if (Array.isArray(params)) {
    return params.includes('tools') || params.includes('tool_choice');
  }
  // Conservative allow-list when supported_parameters isn't reported.
  return KNOWN_TOOL_FAMILIES.some((prefix) => m.id.startsWith(prefix));
}

const KNOWN_TOOL_FAMILIES = [
  'anthropic/',
  'openai/',
  'google/gemini',
  'mistralai/mistral',
  'mistralai/mixtral',
  'deepseek/deepseek-r',
  'deepseek/deepseek-chat',
  'meta-llama/llama-3.3',
  'qwen/qwen-2.5',
  'qwen/qwen3',
  'x-ai/grok',
  'cohere/command',
];

/**
 * Whether the model advertises image input capability via
 * OpenRouter's `architecture.input_modalities` array.
 */
export function isVisionCapable(m: OpenRouterModel): boolean {
  return m.architecture?.input_modalities?.includes('image') === true;
}

/**
 * Whether the model can *generate* images (output modality includes
 * `image`). Distinct from {@link isVisionCapable}, which is about
 * accepting images as input.
 */
export function isImageOutputCapable(m: OpenRouterModel): boolean {
  return m.architecture?.output_modalities?.includes('image') === true;
}

/** USD per million prompt tokens, computed from OpenRouter's per-token string price. */
export function pricePer1MIn(m: OpenRouterModel): number {
  return safePrice(m.pricing?.prompt) * 1_000_000;
}

/** USD per million completion tokens. */
export function pricePer1MOut(m: OpenRouterModel): number {
  return safePrice(m.pricing?.completion) * 1_000_000;
}

function safePrice(v: string | undefined): number {
  if (!v) return 0;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// ----- private cache helpers --------------------------------------------

async function readFreshCache(path: string, ttl: number): Promise<OpenRouterCacheMeta | null> {
  try {
    const s = await stat(path);
    if (Date.now() - s.mtimeMs > ttl) return null;
    return await readAnyCache(path);
  } catch {
    return null;
  }
}

async function readAnyCache(path: string): Promise<OpenRouterCacheMeta | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as OpenRouterCacheMeta;
    if (!parsed || !Array.isArray(parsed.models)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(path: string, body: OpenRouterCacheMeta): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2), 'utf8');
}

async function fetchFromNetwork(opts: FetchOptions): Promise<OpenRouterModel[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 15_000);
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await fetch(ENDPOINT, { headers, signal: controller.signal });
    if (!res.ok) {
      throw new Error(`OpenRouter /models HTTP ${res.status}`);
    }
    const json = (await res.json()) as { data?: OpenRouterModel[] };
    if (!Array.isArray(json.data)) {
      throw new Error('OpenRouter /models: missing or malformed `data` array');
    }
    return json.data;
  } finally {
    clearTimeout(timeout);
  }
}
