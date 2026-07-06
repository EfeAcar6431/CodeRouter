import type { AdapterCapabilities, ProviderId } from '../types.js';

/**
 * Single observable agent action surfaced to the UI as it happens.
 *
 * Adapters that have visibility into the underlying agent's tool
 * calls (Claude Code's stream-json `tool_use` blocks, Codex's
 * `command_execution` / `file_change` items) emit one of these per
 * action. Adapters that don't (raw model APIs without a tool layer)
 * simply omit them.
 *
 * Two complementary channels:
 *   - `onChunk` carries the model's natural-language narration
 *   - `onActivity` carries the structural decisions (read X, edit Y,
 *     run shell command Z, ...) that the user wants to see in
 *     real time, separate from the prose
 *
 * The REPL renders activity events as a rolling gray-italic feed
 * below the streaming text, mirroring Claude Code's own UX.
 */
export type ActivityEvent =
  /**
   * Agent decided to invoke a tool. `tool` is the canonical tool
   * name (Read/Edit/Write/Bash/Grep/Glob/Task/...); `description`
   * is a one-line, human-readable summary suitable for the REPL
   * (e.g. `read packages/foo.ts`, `bash: git status`,
   * `edit src/bar.ts (3 lines)`).
   *
   * `toolUseId` is the agent's per-call id when available - the
   * matching `tool_result` carries the same id so the UI can pair
   * them if it wants.
   */
  | {
      kind: 'tool_use';
      tool: string;
      description: string;
      toolUseId?: string;
      /**
       * For file-editing tools (edit/write/multi-edit), the worktree-
       * relative path being changed. Lets the UI render a dedicated
       * per-file change card instead of a generic tool row.
       */
      path?: string;
      /**
       * A lightweight preview of the change as `+`/`-` prefixed lines
       * (not a real git diff — the authoritative diff is computed from
       * the worktree at end of run). Surfaced at tool-use time so the
       * UI can stream "what's changing" live, Cursor-style. Omitted by
       * adapters that don't have the edit content (e.g. Codex).
       */
      patch?: string;
      raw?: unknown;
    }
  /**
   * Tool finished. `ok=false` means the tool itself errored (e.g.
   * the bash command exited non-zero, the file path didn't exist),
   * not that the run failed.
   *
   * `body` is the captured multi-line output of the tool (bash
   * stdout/stderr, search results, error message, ...). Adapters
   * SHOULD send the full content; the UI is responsible for
   * truncating to fit on screen. Adapters MAY omit it for tools
   * whose result is structurally uninteresting (e.g. a Read tool
   * that just confirms it loaded a file).
   */
  | { kind: 'tool_result'; tool: string; ok: boolean; body?: string; toolUseId?: string }
  /**
   * A long-running / background process the agent started (e.g. a dev
   * server via `bash(background:true)`). Unlike a normal tool_use, the
   * process outlives the tool call, so the UI surfaces it as a running
   * process the user can open in a browser or stop. `url` is a detected
   * local server address (e.g. `http://localhost:5173`) when known.
   */
  | {
      kind: 'process_started';
      pid: number;
      command: string;
      cwd: string;
      url?: string;
      toolUseId?: string;
    }
  /**
   * The agent explicitly asked to show the user something in a browser -
   * a running dev server, or a standalone web page / game / HTML file it
   * produced. `url` is either an `http(s)://` address or a `file://` URL.
   * The desktop app opens it in the in-app browser panel; the CLI launches
   * the OS default browser. This is the deliberate "show it to me" signal,
   * distinct from `process_started` (which merely reports a spawned pid).
   */
  | { kind: 'open_preview'; url: string; toolUseId?: string }
  /**
   * Reasoning / thinking summary. Codex emits these between agent
   * messages; Claude Code rarely surfaces them directly. Optional -
   * the REPL may dim or hide them entirely depending on verbosity.
   */
  | { kind: 'thinking'; text: string };

export type AdapterCallInput = {
  prompt: string;
  systemPrompt?: string;
  cwd?: string;
  /** Absolute paths to image files for vision-capable models. */
  images?: string[];
  /**
   * Read-only invocation: the adapter must not let the model write
   * files or run mutating commands. Local-CLI adapters map this to
   * their native read-only modes (Claude Code: `--permission-mode
   * plan`, Codex: `--sandbox read-only`). Used by plan / masterplan /
   * debug / review, which run directly in the user's cwd (no
   * sandboxing worktree) and therefore MUST NOT mutate anything.
   */
  readOnly?: boolean;
  /**
   * How the agent may run shell commands. Threaded to the first-party
   * agent's tool context so the `bash` tool can enforce the user's
   * chosen policy: `allowlist` restricts commands to a safe set;
   * `unsandboxed` runs anything; `sandboxed` (or unset) runs inside the
   * worktree with no extra gating. Shell-based adapters ignore it.
   */
  runMode?: import('../modes/types.js').RunMode;
  maxTokens?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  transformer?: string[];
  files?: string[];
  contextManifest?: import('../types.js').ContextManifest;
  signal?: AbortSignal;
  /**
   * Optional callback invoked with each output chunk as it streams in.
   * Adapters that don't support streaming (e.g. one-shot HTTP calls
   * without SSE) MAY simply emit the full result at the end. The UI
   * accumulates these into its scrollback buffer so the user sees
   * partial output instead of a sudden dump at completion.
   */
  onChunk?: (chunk: string) => void;
  /**
   * Optional structured-action sink. Called once per observable
   * tool_use/tool_result/thinking event for adapters that have
   * access to that information; never called for adapters that
   * don't. See the {@link ActivityEvent} doc for the channel
   * contract.
   */
  onActivity?: (event: ActivityEvent) => void;
  /**
   * Optional running-usage sink. Adapters call this whenever they
   * have updated cumulative token / cost numbers - typically once
   * per assistant message for streaming providers, once at end of
   * run for non-streaming. Used by the REPL to render a live
   * "X in · Y out · $0.0123" counter so the user can watch cost
   * accumulate in real time. Idempotent: each call carries the
   * cumulative total, not a delta.
   */
  onUsage?: (usage: { tokensIn: number; tokensOut: number; costUsd: number }) => void;
  /**
   * Optional notification when the underlying provider resolves the
   * actual model id (e.g. `claude --model sonnet` resolves to
   * `claude-sonnet-4-5-20250929` server-side). Fired at most once per
   * run, as soon as the adapter learns the resolved name. The REPL
   * uses it to upgrade the route label from the requested shorthand
   * to the real versioned identifier so the user knows exactly which
   * model produced the output.
   */
  onModelResolved?: (model: string) => void;
  /**
   * Optional opaque session id from a previous run with the same
   * adapter, captured via `AdapterCallResult.sessionId`. Adapters
   * that support conversational continuity (Claude Code's
   * `--resume <id>`, Codex's session continuation) MUST honour this
   * to give the model conversational memory across REPL turns. A
   * mismatched id (different provider, expired session) MUST be
   * tolerated by silently starting a fresh conversation rather
   * than failing - the REPL doesn't know which provider the router
   * will pick on the next turn until the call is dispatched.
   */
  resumeSessionId?: string;
  /**
   * Prior conversation messages from earlier REPL turns. The
   * first-party agent injects these between the system prompt and
   * the current user prompt so the model has multi-turn awareness.
   * Shell-based adapters (Claude Code, Codex) ignore this and rely
   * on their own session mechanism (`resumeSessionId`).
   */
  priorMessages?: import('../agent/transport/types.js').ChatMessage[];
  /**
   * Optional callback fired the moment the model invokes a built-in
   * "ask the user a clarifying question" tool (Claude Code's
   * `AskUserQuestion`). The headless `claude -p` subprocess can't
   * actually wait for an answer - it fails the tool call and the
   * model falls back to a guess. The callback gives the REPL a
   * chance to:
   *
   *   1. Surface the question to the operator,
   *   2. Abort the in-flight run before the model commits to a
   *      fallback decision,
   *   3. Capture the user's answer and dispatch it as the next
   *      prompt (with `resumeSessionId` so the agent has full
   *      context of what it just asked).
   *
   * Adapters that don't have an interactive-question tool simply
   * never fire this.
   */
  onUserQuestion?: (payload: AskUserQuestionPayload) => void;
};

/**
 * Structured form of a Claude Code `AskUserQuestion` tool call. We
 * preserve the original shape (questions[] with per-question
 * header / multiSelect / options) so the REPL can render a
 * faithful interactive picker. Each option carries an optional
 * description shown alongside the label.
 */
export type AskUserQuestionPayload = {
  questions: AskUserQuestionEntry[];
};

export type AskUserQuestionEntry = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string }>;
};

export type AdapterCallResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
  filesChanged?: string[];
  raw?: unknown;
  /**
   * Adapter-defined session id the caller can pass back via
   * `AdapterCallInput.resumeSessionId` on a subsequent run to
   * preserve conversational state. Only set by adapters that have
   * a real notion of a session (Claude Code, Codex). Treat as
   * opaque - never inspect the structure outside the adapter that
   * produced it.
   */
  sessionId?: string;
  /**
   * Full message history from this turn (system excluded). The REPL
   * appends these to ConversationHistory for multi-turn awareness.
   * Only set by the first-party agent adapter.
   */
  messages?: import('../agent/transport/types.js').ChatMessage[];
};

export type Adapter = {
  id: ProviderId;
  name: string;
  capabilities: AdapterCapabilities;
  run: (input: AdapterCallInput) => Promise<AdapterCallResult>;
  plan?: (input: AdapterCallInput) => Promise<AdapterCallResult>;
  score?: (input: AdapterCallInput) => Promise<number>;
  estimateCost: (tokensIn: number, tokensOut: number) => number;
};
