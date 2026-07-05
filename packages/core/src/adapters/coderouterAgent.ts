/**
 * `CodeRouterAgentAdapter` - the first-party coding agent for any
 * tool-calling-capable chat/completions backend.
 *
 * Where Claude Code and Codex run their own loop inside a child
 * binary that we just shell out to, this adapter runs the loop
 * here in-process. That gives users with only an API key
 * (OpenRouter most commonly, but also raw OpenAI / Groq /
 * DeepSeek) an editing agent without depending on a local CLI.
 *
 * Design: thin wrapper. All real work lives in `core/agent/*`.
 * This file's job is to map between the adapter contract and the
 * agent module's contract; nothing else.
 */

import {
  OpenAICompatTransport,
  defaultTools,
  runAgent,
  type Tool,
} from '../agent/index.js';
import { buildSystemPrompt } from '../agent/systemPrompt.js';
import { getMcpToolsForCwd } from '../mcp/index.js';
import type { AdapterCapabilities, ContextManifest, ProviderId } from '../types.js';
import { BaseAdapter } from './base.js';
import type { AdapterCallInput, AdapterCallResult } from './types.js';

export type CodeRouterAgentAdapterOptions = {
  /** Display name for this provider, e.g. 'openrouter-agent'. */
  providerName: string;
  /** Wire-level model id sent to the backend. */
  model: string;
  /** Base URL up to but not including `/chat/completions`. */
  baseURL: string;
  /** Env var holding the API key (preferred). */
  apiKeyEnv?: string;
  /** Explicit API key (overrides apiKeyEnv). */
  apiKey?: string;
  /** Per-1M-token prices used for cost estimation. */
  pricePer1MIn?: number;
  pricePer1MOut?: number;
  /** Context window for router intent matching. */
  contextWindow?: number;
  /** Capability flag overrides (e.g. flip `reasoning: true` for o-series). */
  capabilities?: Partial<AdapterCapabilities>;
  /** Optional override for the reasoning effort param name. */
  reasoningParam?: string;
  /** Optional custom tool set. Defaults to the built-in CodeRouter toolbox. */
  tools?: Tool[];
  /** Per-HTTP-call timeout (ms). */
  timeoutMs?: number;
  /** Loop iteration cap. */
  maxIterations?: number;
  /** Loop wall-clock cap (ms). */
  maxDurationMs?: number;
};

export class CodeRouterAgentAdapter extends BaseAdapter {
  id: ProviderId = 'coderouter_agent';
  name: string;
  capabilities: AdapterCapabilities;

  private readonly tools: Tool[];

  constructor(public readonly opts: CodeRouterAgentAdapterOptions) {
    super();
    this.name = opts.providerName;
    this.tools = opts.tools ?? defaultTools();
    this.capabilities = {
      canEdit: true,
      canPlan: true,
      longContext: (opts.contextWindow ?? 128_000) >= 200_000,
      reasoning: false,
      tools: true,
      streaming: true,
      vision: false,
      pricePer1MIn: opts.pricePer1MIn ?? 0,
      pricePer1MOut: opts.pricePer1MOut ?? 0,
      contextWindow: opts.contextWindow ?? 128_000,
      family: 'agent-loop',
      ...opts.capabilities,
    };
  }

  override async run(input: AdapterCallInput): Promise<AdapterCallResult> {
    const apiKey =
      this.opts.apiKey ?? (this.opts.apiKeyEnv ? process.env[this.opts.apiKeyEnv] : undefined);
    if (!apiKey) {
      throw new Error(
        `CodeRouterAgentAdapter(${this.opts.providerName}): API key not set (env=${this.opts.apiKeyEnv ?? 'unset'})`,
      );
    }
    if (!input.cwd) {
      throw new Error(
        'CodeRouterAgentAdapter: requires `cwd` (the agent worktree path) - the mode normally fills this in',
      );
    }

    const transport = new OpenAICompatTransport({
      providerName: this.opts.providerName,
      model: this.opts.model,
      baseURL: this.opts.baseURL,
      apiKey,
      timeoutMs: this.opts.timeoutMs,
      pricePer1MIn: this.opts.pricePer1MIn,
      pricePer1MOut: this.opts.pricePer1MOut,
      reasoningParam: this.opts.reasoningParam,
    });

    const systemPrompt = input.systemPrompt ?? buildSystemPrompt({
      append: formatManifestForPrompt(input.contextManifest),
    });

    // Fold in tools from any configured external MCP servers (e.g. graphify's
    // knowledge-graph tools). Best-effort: a server that's down or misconfigured
    // is skipped so it can never block or fail an otherwise-valid run.
    let tools = this.tools;
    try {
      const mcpTools = await getMcpToolsForCwd(input.cwd);
      if (mcpTools.length > 0) tools = [...this.tools, ...mcpTools];
    } catch {
      /* MCP is additive; ignore discovery failures */
    }

    const result = await runAgent({
      prompt: input.prompt,
      systemPrompt,
      cwd: input.cwd,
      signal: input.signal,
      tools,
      transport,
      priorMessages: input.priorMessages,
      images: input.images,
      runMode: input.runMode,
      reasoningEffort: input.reasoningEffort,
      onChunk: input.onChunk,
      onReasoning: input.onActivity
        ? (chunk) => input.onActivity!({ kind: 'thinking', text: chunk })
        : undefined,
      onActivity: input.onActivity,
      onUsage: input.onUsage,
      onUserQuestion: input.onUserQuestion,
      budget: {
        maxIterations: this.opts.maxIterations,
        maxDurationMs: this.opts.maxDurationMs,
        perCallTimeoutMs: this.opts.timeoutMs,
      },
    });

    return {
      text: result.text,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      messages: result.messages,
    };
  }
}

/**
 * Turn a context manifest into a compact block the model can use to
 * orient itself. Tells the model which files are relevant (ranked by
 * importance) and why, so it knows what to read first.
 */
function formatManifestForPrompt(manifest?: ContextManifest): string | undefined {
  if (!manifest || manifest.entries.length === 0) return undefined;

  const lines = manifest.entries
    .slice(0, 30)
    .map((e) => `- ${e.path} (${e.reason})`)
    .join('\n');

  return [
    `The following files are likely relevant to this task (ranked by relevance):`,
    lines,
    manifest.truncated
      ? `\n(List was truncated; use grep/glob to find more files if needed.)`
      : '',
    `\nRead the most relevant ones before making changes.`,
  ].join('\n');
}
