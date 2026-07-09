import {
  fetchOpenRouterModels,
  isToolCapable,
  pricePer1MIn,
  pricePer1MOut,
  type OpenRouterModel,
} from '../agent/providers/openrouter.js';
import { AnthropicAdapter } from '../adapters/anthropic.js';
import { ClaudeCodeAdapter } from '../adapters/claudeCode.js';
import { CodeRouterAgentAdapter } from '../adapters/coderouterAgent.js';
import { CodexAdapter } from '../adapters/codex.js';
import { GoogleAdapter } from '../adapters/google.js';
import { OllamaAdapter, isOllamaModelInstalled } from '../adapters/ollama.js';
import { OpenAIAdapter } from '../adapters/openai.js';
import { OpenAICompatAdapter } from '../adapters/openaiCompat.js';
import type { Adapter } from '../adapters/types.js';
import { whichSync } from '../sandbox/which.js';
import { applyTransformers } from '../transformers/index.js';
import type { ProviderConfig, ProviderModelConfig } from './types.js';

export type ResolvedRoute = {
  providerName: string;
  model: string;
  adapter: Adapter;
};

/**
 * In-memory registry of providers + lazy adapter construction.
 *
 * Resolution flow:
 *   route string "provider,model" -> registry lookup -> adapter factory
 *   -> wrap with declared transformers -> ResolvedRoute used by the
 *   router / handoff / tournament workflows.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, ProviderConfig>();
  private readonly adapterCache = new Map<string, Adapter>();
  /**
   * In-memory OpenRouter catalog, keyed by `model.id`. Populated by
   * `loadOpenRouterCatalog` (called once at startup by the runtime
   * when the OpenRouter key is configured). Stays empty if the
   * runtime never calls it; resolution then falls back to the
   * static `models` map only.
   */
  private openRouterCatalog: Map<string, OpenRouterModel> = new Map();

  constructor(providers: ProviderConfig[] = []) {
    for (const p of providers) this.providers.set(p.name, p);
  }

  set(provider: ProviderConfig): void {
    this.providers.set(provider.name, provider);
    for (const key of [...this.adapterCache.keys()]) {
      if (key.startsWith(`${provider.name},`)) this.adapterCache.delete(key);
    }
  }

  list(): ProviderConfig[] {
    return [...this.providers.values()];
  }

  has(name: string): boolean {
    return this.providers.has(name);
  }

  /**
   * Pull the OpenRouter `/v1/models` catalog into memory so
   * subsequent sync `resolve()` calls can synthesize configs for
   * arbitrary OpenRouter model ids (not just the curated handful
   * declared in the static catalog). Safe to call repeatedly;
   * cached on disk with a 24h TTL by default.
   */
  async loadOpenRouterCatalog(opts: { force?: boolean } = {}): Promise<OpenRouterModel[]> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    const all = await fetchOpenRouterModels({ apiKey, force: opts.force });
    this.openRouterCatalog = new Map(all.map((m) => [m.id, m]));
    // Flush adapter cache for providers using the dynamic catalog
    // - their resolved configs may now be different.
    for (const key of [...this.adapterCache.keys()]) {
      const [providerName] = key.split(',');
      if (!providerName) continue;
      const provider = this.providers.get(providerName);
      if (provider?.dynamicCatalog === 'openrouter') this.adapterCache.delete(key);
    }
    return all;
  }

  /**
   * Look up a model in the in-memory OpenRouter catalog. Returns
   * null when the catalog hasn't been loaded or the id is unknown.
   * Pure data accessor - no network calls.
   */
  getOpenRouterCatalogModel(id: string): OpenRouterModel | null {
    return this.openRouterCatalog.get(id) ?? null;
  }

  /**
   * All OpenRouter models currently in memory. Empty until
   * `loadOpenRouterCatalog` has been called.
   */
  listOpenRouterCatalogModels(): OpenRouterModel[] {
    return [...this.openRouterCatalog.values()];
  }

  /**
   * Returns true when the provider can actually make a call.
   *
   * - HTTP-API providers need a literal `apiKey` or an `apiKeyEnv` env
   *   var that's populated.
   * - Local-CLI providers (codex / claude_code / ollama) need the host
   *   binary on PATH. We probe with a sync PATH lookup so the router
   *   can filter unusable candidates without async work.
   *
   * Doesn't verify CLI auth state (e.g. `codex auth status`) - that's
   * one extra subprocess per startup we don't pay for here. If the bin
   * exists but isn't logged in the adapter will surface that at run
   * time.
   */
  isReady(name: string): boolean {
    const provider = this.providers.get(name);
    if (!provider) return false;
    if (provider.adapter === 'codex') {
      if (process.env.CODEROUTER_DISABLE_CODEX === '1') return false;
      return whichSync('codex') !== null;
    }
    if (provider.adapter === 'claude_code') {
      if (process.env.CODEROUTER_DISABLE_CLAUDE_CODE === '1') return false;
      return whichSync('claude') !== null;
    }
    if (provider.adapter === 'ollama') {
      if (process.env.CODEROUTER_DISABLE_OLLAMA === '1') return false;
      if (whichSync('ollama') === null) return false;
      // The binary being on PATH isn't enough - the configured model
      // must actually be pulled, or the local server 404s mid-run.
      return Object.keys(provider.models).some((m) => isOllamaModelInstalled(m));
    }
    // coderouter_agent providers piggy-back on the same API key as
    // their chat-only sibling - readiness is just "is the key set".
    if (provider.adapter === 'coderouter_agent') {
      if (provider.apiKey) return true;
      if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
      return false;
    }
    if (provider.apiKey) return true;
    if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return true;
    return false;
  }

  /**
   * Resolve a route string like 'deepseek,deepseek-reasoner' or
   * 'openrouter,anthropic/claude-sonnet-4'.
   */
  resolve(route: string): ResolvedRoute {
    const [providerName, ...modelParts] = route.split(',');
    if (!providerName || modelParts.length === 0) {
      throw new Error(`ProviderRegistry: invalid route '${route}' (want 'provider,model')`);
    }
    const model = modelParts.join(',');
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(
        `ProviderRegistry: unknown provider '${providerName}' (have: ${[...this.providers.keys()].join(', ')})`,
      );
    }
    const modelCfg = provider.models[model] ?? this.resolveDynamicModel(provider, model);
    if (!modelCfg) {
      throw new Error(
        `ProviderRegistry: unknown model '${model}' on provider '${providerName}' (have: ${Object.keys(provider.models).join(', ')})`,
      );
    }

    const cacheKey = `${providerName},${model}`;
    const cached = this.adapterCache.get(cacheKey);
    if (cached) {
      return { providerName, model, adapter: cached };
    }

    const adapter = this.buildAdapter(provider, model, modelCfg);
    const transformers = [...(provider.transformer ?? []), ...(modelCfg.transformer ?? [])];
    const wrapped = applyTransformers(adapter, transformers, providerName);
    this.adapterCache.set(cacheKey, wrapped);
    return { providerName, model, adapter: wrapped };
  }

  /**
   * Synthesize a `ProviderModelConfig` from a dynamic catalog entry
   * when the static `provider.models` map doesn't contain the
   * requested model id. Returns undefined to fall through to the
   * normal "unknown model" error.
   *
   * Today supports `openrouter`; other catalogs (e.g. Together's
   * `/models`) can be plugged in here as we add support for them.
   */
  private resolveDynamicModel(
    provider: ProviderConfig,
    modelId: string,
  ): ProviderModelConfig | undefined {
    if (provider.dynamicCatalog !== 'openrouter') return undefined;
    const m = this.openRouterCatalog.get(modelId);
    if (!m) return undefined;
    // For agent providers, only accept tool-capable models so we
    // don't dispatch an editing run at a model that'll silently
    // ignore the tool schema.
    const needsTools = provider.adapter === 'coderouter_agent';
    if (needsTools && !isToolCapable(m)) return undefined;
    const capabilities: ProviderModelConfig['capabilities'] =
      provider.adapter === 'coderouter_agent'
        ? { canEdit: true, tools: true }
        : {};
    return {
      pricePer1MIn: pricePer1MIn(m),
      pricePer1MOut: pricePer1MOut(m),
      contextWindow: m.context_length,
      capabilities,
    };
  }

  private buildAdapter(
    provider: ProviderConfig,
    model: string,
    cfg: ProviderModelConfig,
  ): Adapter {
    const apiKey =
      provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined);
    switch (provider.adapter) {
      case 'openai':
        return new OpenAIAdapter({
          model,
          apiKey,
          baseURL: provider.baseURL,
        });
      case 'anthropic':
        return new AnthropicAdapter({
          model,
          apiKey,
          baseURL: provider.baseURL,
        });
      case 'google':
        return new GoogleAdapter({
          model,
          apiKey,
          baseURL: provider.baseURL,
        });
      case 'openai_compat':
        if (!provider.baseURL)
          throw new Error(`openai_compat provider '${provider.name}' requires baseURL`);
        return new OpenAICompatAdapter({
          providerName: provider.name,
          model,
          baseURL: provider.baseURL,
          apiKey,
          apiKeyEnv: provider.apiKeyEnv,
          pricePer1MIn: cfg.pricePer1MIn,
          pricePer1MOut: cfg.pricePer1MOut,
          contextWindow: cfg.contextWindow,
          capabilities: cfg.capabilities,
          reasoningParam: cfg.reasoningParam,
          extraBody: cfg.extraBody,
        });
      case 'ollama':
        return new OllamaAdapter({
          model,
          baseURL: provider.baseURL,
          contextWindow: cfg.contextWindow,
        });
      case 'codex':
        return new CodexAdapter({ model });
      case 'claude_code':
        return new ClaudeCodeAdapter({ model });
      case 'coderouter_agent':
        if (!provider.baseURL)
          throw new Error(`coderouter_agent provider '${provider.name}' requires baseURL`);
        return new CodeRouterAgentAdapter({
          providerName: provider.name,
          model,
          baseURL: provider.baseURL,
          apiKey,
          apiKeyEnv: provider.apiKeyEnv,
          pricePer1MIn: cfg.pricePer1MIn,
          pricePer1MOut: cfg.pricePer1MOut,
          contextWindow: cfg.contextWindow,
          capabilities: cfg.capabilities,
          reasoningParam: cfg.reasoningParam,
        });
      default:
        throw new Error(`ProviderRegistry: unsupported adapter '${provider.adapter}'`);
    }
  }
}

/**
 * Sensible default registry covering the providers we ship support for
 * out of the box. Users override / extend via `coderouter.config.ts`.
 */
export function defaultProviders(): ProviderConfig[] {
  return [
    {
      name: 'openai',
      adapter: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      transformer: ['maxTokens', 'reasoning', 'tooluse', 'streaming'],
      // OpenAI does not ship a separate "-reasoning" model; the
      // reasoning behaviour is selected via the `reasoning_effort`
      // request parameter (see `reasoningParam` on each entry).
      models: {
        'gpt-5.5': {
          contextWindow: 400_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { reasoning: true },
        },
        'gpt-5.5-pro': {
          contextWindow: 400_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { reasoning: true },
        },
        'gpt-5': {
          contextWindow: 400_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { reasoning: true },
        },
        'gpt-5-mini': { contextWindow: 400_000 },
        'gpt-4.1': { contextWindow: 1_000_000 },
        'gpt-4o': { contextWindow: 128_000 },
        'gpt-4o-mini': { contextWindow: 128_000 },
      },
    },
    {
      name: 'anthropic',
      adapter: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      transformer: ['maxTokens', 'tooluse', 'streaming'],
      models: {
        'claude-opus-4-5': { contextWindow: 200_000 },
        'claude-sonnet-4-5': { contextWindow: 200_000 },
        'claude-3-5-haiku-latest': { contextWindow: 200_000 },
      },
    },
    {
      name: 'google',
      adapter: 'google',
      apiKeyEnv: 'GOOGLE_API_KEY',
      transformer: ['maxTokens', 'tooluse', 'streaming'],
      models: {
        'gemini-2.5-pro': { contextWindow: 2_000_000 },
        'gemini-2.5-flash': { contextWindow: 1_000_000 },
      },
    },
    {
      name: 'deepseek',
      adapter: 'openai_compat',
      baseURL: 'https://api.deepseek.com/v1',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      transformer: ['maxTokens', 'reasoning', 'tooluse', 'streaming'],
      models: {
        'deepseek-chat': {
          pricePer1MIn: 0.27,
          pricePer1MOut: 1.1,
          contextWindow: 128_000,
        },
        'deepseek-reasoner': {
          pricePer1MIn: 0.55,
          pricePer1MOut: 2.19,
          contextWindow: 64_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { reasoning: true },
        },
      },
    },
    {
      name: 'openrouter',
      adapter: 'openai_compat',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      transformer: ['maxTokens', 'tooluse', 'streaming'],
      dynamicCatalog: 'openrouter',
      models: {
        'anthropic/claude-opus-4-5': {
          pricePer1MIn: 15,
          pricePer1MOut: 75,
          contextWindow: 200_000,
        },
        'anthropic/claude-sonnet-4-5': {
          pricePer1MIn: 3,
          pricePer1MOut: 15,
          contextWindow: 200_000,
        },
        'openai/gpt-5': {
          pricePer1MIn: 5,
          pricePer1MOut: 15,
          contextWindow: 400_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { reasoning: true },
        },
        'google/gemini-2.5-pro': {
          pricePer1MIn: 1.25,
          pricePer1MOut: 10,
          contextWindow: 2_000_000,
          capabilities: { longContext: true },
        },
        'deepseek/deepseek-chat': {
          pricePer1MIn: 0.27,
          pricePer1MOut: 1.1,
          contextWindow: 128_000,
        },
      },
    },
    // Tool-calling sibling of the openrouter chat provider above.
    // Same baseURL + same key env var, but hands off to
    // `CodeRouterAgentAdapter` (canEdit: true) so users with only
    // an OpenRouter key get a real coding agent for `/agent` runs
    // instead of just a chat reply. The router prefers this entry
    // for `balanced-agent` / `multi-file` intents via the catalog.
    {
      name: 'openrouter_agent',
      adapter: 'coderouter_agent',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      transformer: [],
      dynamicCatalog: 'openrouter',
      models: {
        'anthropic/claude-sonnet-4-5': {
          pricePer1MIn: 3,
          pricePer1MOut: 15,
          contextWindow: 200_000,
          capabilities: { canEdit: true, tools: true },
        },
        'anthropic/claude-opus-4-5': {
          pricePer1MIn: 15,
          pricePer1MOut: 75,
          contextWindow: 200_000,
          capabilities: { canEdit: true, tools: true },
        },
        'openai/gpt-5': {
          pricePer1MIn: 5,
          pricePer1MOut: 15,
          contextWindow: 400_000,
          reasoningParam: 'reasoning_effort',
          capabilities: { canEdit: true, tools: true, reasoning: true },
        },
        'openai/gpt-4o': {
          pricePer1MIn: 2.5,
          pricePer1MOut: 10,
          contextWindow: 128_000,
          capabilities: { canEdit: true, tools: true },
        },
        'anthropic/claude-3-5-haiku': {
          pricePer1MIn: 0.8,
          pricePer1MOut: 4,
          contextWindow: 200_000,
          capabilities: { canEdit: true, tools: true },
        },
      },
    },
    {
      name: 'groq',
      adapter: 'openai_compat',
      baseURL: 'https://api.groq.com/openai/v1',
      apiKeyEnv: 'GROQ_API_KEY',
      transformer: ['maxTokens', 'tooluse', 'streaming'],
      models: {
        'llama-3.3-70b-versatile': {
          pricePer1MIn: 0.59,
          pricePer1MOut: 0.79,
          contextWindow: 128_000,
        },
      },
    },
    {
      name: 'ollama',
      adapter: 'ollama',
      transformer: ['maxTokens', 'tooluse', 'streaming'],
      models: {
        'llama3.2': { contextWindow: 32_000 },
        'qwen2.5-coder:7b': { contextWindow: 32_000 },
        'qwen2.5-coder:14b': { contextWindow: 32_000 },
      },
    },
    {
      name: 'codex',
      adapter: 'codex',
      transformer: [],
      models: {
        default: {},
        'gpt-5-codex': {},
      },
    },
    {
      name: 'claude_code',
      adapter: 'claude_code',
      transformer: [],
      models: {
        default: {},
        opus: {},
        sonnet: {},
      },
    },
  ];
}
