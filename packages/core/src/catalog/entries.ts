import type { Catalog } from './types.js';

/**
 * Curated catalog of routable models, grouped by routing intent.
 *
 * This is intentionally hand-maintained right now (rather than fetched
 * from LiteLLM at startup) so:
 *   1. The CLI works offline / on a fresh install with no network.
 *   2. We can verify that every entry is actually a model name a
 *      provider's API still accepts. LiteLLM's full catalog has 1k+
 *      entries including deprecated ones; most of them aren't useful
 *      for the router.
 *
 * To add a new model:
 *   - Confirm the wire-level model id from the provider's docs.
 *   - Pick the smallest set of intents it fits. Don't tag a fast/cheap
 *     model with `deep-reasoning` "just in case" - the router uses the
 *     ranks to break ties between providers, not to grade models.
 *   - Rank 1 = best-in-class for that intent; rank 5 = "usable but
 *     we'd rather route elsewhere if available".
 *
 * The router prefers low ranks but always honors provider readiness
 * first - a rank-5 entry on a configured provider wins over a rank-1
 * entry on a provider whose key is missing.
 */
export const CATALOG: Catalog = [
  // -----------------------------------------------------------------
  // Local host CLIs - always tried first when on PATH because they
  // ride the user's existing Codex / Claude Code / Ollama setup.
  // -----------------------------------------------------------------
  {
    provider: 'codex',
    model: 'gpt-5-codex',
    capabilities: { reasoning: true, tooluse: true },
    intents: [
      { intent: 'deep-reasoning', rank: 1 },
      { intent: 'balanced-agent', rank: 2 },
      { intent: 'multi-file', rank: 2 },
    ],
  },
  {
    provider: 'claude_code',
    model: 'sonnet',
    capabilities: { tooluse: true, visionInput: true },
    intents: [
      { intent: 'balanced-agent', rank: 1 },
      { intent: 'multi-file', rank: 2 },
    ],
  },
  {
    provider: 'claude_code',
    model: 'opus',
    capabilities: { tooluse: true, visionInput: true },
    intents: [
      { intent: 'multi-file', rank: 1 },
      { intent: 'deep-reasoning', rank: 3 },
    ],
  },
  {
    provider: 'ollama',
    model: 'qwen2.5-coder:7b',
    intents: [
      { intent: 'local-offline', rank: 1 },
      { intent: 'fast-cheap', rank: 4 },
    ],
  },
  {
    provider: 'ollama',
    model: 'llama3.2',
    intents: [
      { intent: 'local-offline', rank: 2 },
      { intent: 'fast-cheap', rank: 5 },
    ],
  },

  // -----------------------------------------------------------------
  // OpenAI native API
  // -----------------------------------------------------------------
  {
    provider: 'openai',
    model: 'gpt-5',
    contextWindow: 400_000,
    pricePer1MIn: 5,
    pricePer1MOut: 15,
    capabilities: { reasoning: true, tooluse: true, visionInput: true },
    intents: [
      { intent: 'deep-reasoning', rank: 2 },
      { intent: 'balanced-agent', rank: 3 },
    ],
  },
  {
    provider: 'openai',
    model: 'gpt-5.5',
    contextWindow: 400_000,
    capabilities: { reasoning: true, tooluse: true, visionInput: true },
    intents: [
      { intent: 'deep-reasoning', rank: 2 },
      { intent: 'balanced-agent', rank: 3 },
    ],
  },
  {
    provider: 'openai',
    model: 'gpt-5-mini',
    contextWindow: 400_000,
    capabilities: { tooluse: true, visionInput: true },
    intents: [
      { intent: 'balanced-agent', rank: 4 },
      { intent: 'fast-cheap', rank: 2 },
    ],
  },
  {
    provider: 'openai',
    model: 'gpt-4.1',
    contextWindow: 1_000_000,
    capabilities: { longContext: true, tooluse: true, visionInput: true },
    intents: [
      { intent: 'huge-context', rank: 2 },
      { intent: 'balanced-agent', rank: 4 },
    ],
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    contextWindow: 128_000,
    pricePer1MIn: 0.15,
    pricePer1MOut: 0.6,
    capabilities: { tooluse: true, visionInput: true },
    intents: [{ intent: 'fast-cheap', rank: 1 }],
  },

  // -----------------------------------------------------------------
  // Anthropic native API
  // -----------------------------------------------------------------
  {
    provider: 'anthropic',
    model: 'claude-opus-4-5',
    contextWindow: 200_000,
    pricePer1MIn: 15,
    pricePer1MOut: 75,
    capabilities: { tooluse: true, visionInput: true },
    intents: [
      { intent: 'multi-file', rank: 1 },
      { intent: 'deep-reasoning', rank: 3 },
    ],
  },
  {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    contextWindow: 200_000,
    pricePer1MIn: 3,
    pricePer1MOut: 15,
    capabilities: { tooluse: true, visionInput: true },
    intents: [
      { intent: 'balanced-agent', rank: 1 },
      { intent: 'multi-file', rank: 3 },
    ],
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    contextWindow: 200_000,
    pricePer1MIn: 0.8,
    pricePer1MOut: 4,
    capabilities: { tooluse: true, visionInput: true },
    intents: [{ intent: 'fast-cheap', rank: 2 }],
  },

  // -----------------------------------------------------------------
  // Google native API
  // -----------------------------------------------------------------
  {
    provider: 'google',
    model: 'gemini-2.5-pro',
    contextWindow: 2_000_000,
    pricePer1MIn: 1.25,
    pricePer1MOut: 10,
    capabilities: { longContext: true, tooluse: true, visionInput: true },
    intents: [
      { intent: 'huge-context', rank: 1 },
      { intent: 'balanced-agent', rank: 4 },
    ],
  },
  {
    provider: 'google',
    model: 'gemini-2.5-flash',
    contextWindow: 1_000_000,
    pricePer1MIn: 0.075,
    pricePer1MOut: 0.3,
    capabilities: { longContext: true, tooluse: true, visionInput: true },
    intents: [
      { intent: 'fast-cheap', rank: 3 },
      { intent: 'huge-context', rank: 3 },
    ],
  },

  // -----------------------------------------------------------------
  // DeepSeek native API
  // -----------------------------------------------------------------
  {
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    contextWindow: 64_000,
    pricePer1MIn: 0.55,
    pricePer1MOut: 2.19,
    capabilities: { reasoning: true },
    intents: [{ intent: 'deep-reasoning', rank: 4 }],
  },
  {
    provider: 'deepseek',
    model: 'deepseek-chat',
    contextWindow: 128_000,
    pricePer1MIn: 0.27,
    pricePer1MOut: 1.1,
    intents: [
      { intent: 'fast-cheap', rank: 3 },
      { intent: 'balanced-agent', rank: 5 },
    ],
  },

  // -----------------------------------------------------------------
  // Groq native API
  // -----------------------------------------------------------------
  {
    provider: 'groq',
    model: 'llama-3.3-70b-versatile',
    contextWindow: 128_000,
    intents: [
      { intent: 'fast-cheap', rank: 4 },
      { intent: 'balanced-agent', rank: 5 },
    ],
  },

  // -----------------------------------------------------------------
  // OpenRouter (aggregator) - chat-only entries used for plan / debug
  // / non-editing flows. Ranked slightly worse than native APIs for
  // the same backing model so we prefer native when keys are
  // configured for both.
  // -----------------------------------------------------------------
  {
    provider: 'openrouter',
    model: 'openai/gpt-5',
    contextWindow: 400_000,
    capabilities: { reasoning: true, tooluse: true },
    intents: [{ intent: 'deep-reasoning', rank: 3 }],
  },
  {
    provider: 'openrouter',
    model: 'google/gemini-2.5-pro',
    contextWindow: 2_000_000,
    capabilities: { longContext: true, tooluse: true },
    intents: [{ intent: 'huge-context', rank: 2 }],
  },

  // -----------------------------------------------------------------
  // OpenRouter via the first-party CodeRouter coding agent loop
  // (`coderouter_agent` adapter). These are what the router picks
  // for `balanced-agent` / `multi-file` intents when the user has
  // only an OpenRouter API key - they implement the same
  // Read/Write/Edit/Bash/Grep/Glob/AskUserQuestion tool surface as
  // Claude Code, just driven by the chosen OpenRouter model.
  //
  // Ranked just below the local-CLI shell agents (Claude Code,
  // Codex) so a user with both still gets the local-first flow,
  // but a user with only an OpenRouter key gets a real editing
  // agent instead of a Q&A reply.
  // -----------------------------------------------------------------
  {
    provider: 'openrouter_agent',
    model: 'anthropic/claude-sonnet-4-5',
    contextWindow: 200_000,
    pricePer1MIn: 3,
    pricePer1MOut: 15,
    capabilities: { tooluse: true },
    intents: [
      { intent: 'balanced-agent', rank: 2 },
      { intent: 'multi-file', rank: 3 },
    ],
  },
  {
    provider: 'openrouter_agent',
    model: 'anthropic/claude-opus-4-5',
    contextWindow: 200_000,
    pricePer1MIn: 15,
    pricePer1MOut: 75,
    capabilities: { tooluse: true },
    intents: [
      { intent: 'multi-file', rank: 2 },
      { intent: 'deep-reasoning', rank: 3 },
    ],
  },
  {
    provider: 'openrouter_agent',
    model: 'openai/gpt-5',
    contextWindow: 400_000,
    pricePer1MIn: 5,
    pricePer1MOut: 15,
    capabilities: { reasoning: true, tooluse: true },
    intents: [
      { intent: 'deep-reasoning', rank: 3 },
      { intent: 'balanced-agent', rank: 3 },
    ],
  },
  {
    provider: 'openrouter_agent',
    model: 'openai/gpt-4o',
    contextWindow: 128_000,
    pricePer1MIn: 2.5,
    pricePer1MOut: 10,
    capabilities: { tooluse: true },
    intents: [
      { intent: 'balanced-agent', rank: 4 },
      { intent: 'fast-cheap', rank: 3 },
    ],
  },
  {
    // Cheap tools-capable agent for creative / visual tasks (logo, icon)
    // that need generate_image + light file edits — not a frontier coder.
    provider: 'openrouter_agent',
    model: 'anthropic/claude-3-5-haiku',
    contextWindow: 200_000,
    pricePer1MIn: 0.8,
    pricePer1MOut: 4,
    capabilities: { tooluse: true },
    intents: [
      { intent: 'fast-cheap', rank: 2 },
    ],
  },
];
