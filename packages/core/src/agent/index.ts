/**
 * @coderouter/core/agent — first-party coding-agent module.
 *
 * Public API kept intentionally small. Everything else (specific
 * tools, transports, model catalog) lives behind sub-namespaces
 * so we can iterate without breaking adapter callers.
 *
 * Quick start (typical wiring used by `CodeRouterAgentAdapter`):
 *
 *   import { runAgent, defaultTools, OpenAICompatTransport } from '@coderouter/core/agent';
 *
 *   const transport = new OpenAICompatTransport({ ... });
 *   const result = await runAgent({
 *     prompt, cwd, signal, transport,
 *     tools: defaultTools(),
 *   });
 */

export { runAgent } from './orchestrator/loop.js';
export { resolveBudget, DEFAULT_BUDGET } from './orchestrator/budget.js';

export { OpenAICompatTransport } from './transport/openaiCompat.js';
export type { OpenAICompatTransportOptions } from './transport/openaiCompat.js';

export {
  defaultTools,
  withTool,
  withoutTool,
  readFileTool,
  writeFileTool,
  editFileTool,
  multiEditTool,
  globTool,
  grepTool,
  bashTool,
  openPreviewTool,
  listDirTool,
  askUserQuestionTool,
} from './tools/index.js';

export { DEFAULT_SYSTEM_PROMPT, buildSystemPrompt } from './systemPrompt.js';

// OpenRouter model catalog: dynamic resolution + on-disk cache.
export * as openrouter from './providers/index.js';

export type {
  Tool,
  ToolArgs,
  ToolContext,
  ToolResult,
  JsonSchema,
  AgentRunInput,
  AgentRunResult,
  AgentBudget,
  AgentUsage,
  ChatTransport,
  ChatTurnRequest,
  ChatTurnResponse,
  ChatMessage,
  ToolCall,
  WireTool,
} from './types.js';
