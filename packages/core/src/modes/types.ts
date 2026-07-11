import type { ActivityEvent, Adapter, AskUserQuestionPayload } from '../adapters/types.js';
import type { ChatMessage } from '../agent/transport/types.js';
import type { PlanClarifyAnswer, PlanClarifyQuestion } from '../clarify/planQuestions.js';
import type { Clarification } from '../clarify/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { RouterContext } from '../routing/policy.js';
import type { InjectionFinding } from '../security/injection.js';
import type { Store } from '../store/index.js';
import type {
  Citation,
  ContextManifest,
  Classification,
  Effort,
  RouteRef,
  RunBudget,
  RunOutcome,
  ValidatorResult,
} from '../types.js';
import type { ProgressNotifier } from './progress.js';
import type { PlanFile } from './planFile.js';

/**
 * How the agent executes shell commands and edits:
 *   - `sandboxed`   : run inside a throwaway `/tmp` git worktree (isolated,
 *                     clean diff, no real-file risk). Legacy default.
 *   - `allowlist`   : run in-place in the real project dir, but only
 *                     allowlisted command prefixes are permitted.
 *   - `unsandboxed` : run in-place in the real project dir with no command
 *                     restrictions (Cursor-style). Default.
 */
export type RunMode = 'sandboxed' | 'allowlist' | 'unsandboxed';

export type ModeInput = {
  prompt: string;
  cwd: string;
  effort?: Effort;
  sessionId?: string;
  /**
   * How commands/edits execute this run. When absent the mode defaults to
   * `sandboxed` for backwards compatibility (one-shot CLI runs); the daemon
   * and REPL pass the user's global preference explicitly.
   */
  runMode?: RunMode;
  /** Validators to run. Falls back to project-detected defaults. */
  validatorsCommand?: string[];
  /** When set, mode runs the dryRun decision flow (no agent invocation). */
  dryRun?: boolean;
  /** Apply final diff to host repo when true (Agent/Masterplan execute). */
  apply?: boolean;
  /** Skip classifier/context/validators (--fast escape hatch). */
  fast?: boolean;
  /** Optional explicit route override. */
  route?: string;
  /** Optional MCP-shaped notifier. */
  progress?: ProgressNotifier;
  /**
   * Cancellation handle. When aborted, in-flight adapter calls bail
   * out and the mode returns `status: 'aborted'`. The REPL wires its
   * esc-to-interrupt key to this.
   */
  signal?: AbortSignal;
  /** Absolute paths to image files detected in the user's prompt. */
  images?: string[];
  /**
   * Optional streaming sink: every chunk the underlying adapter emits
   * is forwarded here so the REPL can render the response live.
   * Adapters that don't stream just call this once at the end with
   * the full response (or not at all - the report layer still has
   * the final text).
   */
  onChunk?: (chunk: string) => void;
  /**
   * Optional structured-action sink: every observable tool call /
   * tool result / reasoning summary the adapter can see is
   * forwarded here so the REPL can render a live activity feed.
   * Adapters that don't expose tool-level visibility simply never
   * fire this callback.
   */
  onActivity?: (event: ActivityEvent) => void;
  /**
   * Optional running-usage sink. Forwarded straight to the adapter
   * so the REPL can render a live token / cost counter as the
   * model streams. See AdapterCallInput.onUsage for semantics.
   */
  onUsage?: (usage: { tokensIn: number; tokensOut: number; costUsd: number }) => void;
  /**
   * What to do when prompt-injection scanning surfaces a `high`
   * severity finding:
   *   - `'warn'` (default): record findings on the output and run
   *     the adapter anyway. The user sees the warning in the report.
   *   - `'block'`: refuse to invoke the adapter; return early with
   *     `status: 'failed'` and the findings attached so the caller
   *     can show them to the operator.
   *
   * Lower severity findings (`info`, `warn`) never block regardless
   * of policy.
   */
  injectionPolicy?: 'warn' | 'block';
  /**
   * Per-provider session ids captured from earlier runs in this REPL
   * session. Used to give the agent conversational memory across
   * prompts: when the router picks a provider that has a stored
   * session id here, the mode forwards it as
   * `AdapterCallInput.resumeSessionId` so the adapter can rehydrate
   * the prior turn (Claude Code: `--resume <id>`).
   *
   * Keyed by `ProviderId`. An entry that doesn't match the routed
   * provider is just ignored - the mode silently starts a fresh
   * conversation rather than failing.
   */
  resumeSessions?: Partial<Record<RouteRef['provider'], string>>;
  /**
   * Prior conversation messages from earlier REPL turns for
   * first-party agent multi-turn memory. Passed through to the
   * adapter as-is; shell-based adapters ignore it.
   */
  priorMessages?: ChatMessage[];
  /**
   * Optional callback fired when the underlying adapter detects a
   * Claude Code `AskUserQuestion` tool call. Forwarded straight to
   * the adapter so the REPL can intercept, abort the run, and let
   * the user answer interactively (with `resumeSessions` carrying
   * the conversation forward).
   */
  onUserQuestion?: (payload: AskUserQuestionPayload) => void;
  /**
   * An existing worktree to reuse for this turn. When set, the mode
   * skips `createWorktree`/`ensureGitRepo`/`mirrorHostState` and
   * runs the agent directly inside this path. Critical for keeping
   * the agent's *cwd stable across REPL turns* - without it every
   * turn would spawn under a fresh `/tmp/coderouter-XXX/agent-YYY`
   * and the model would keep losing its bearings ("the directory
   * above this one" pointing somewhere different each time, files
   * created last turn invisible this turn).
   *
   * The REPL owns the lifecycle: it creates the worktree on the
   * first turn (via the mode's normal create path with this field
   * unset and `keepWorktree` set), captures the resulting
   * `ModeOutput.worktree`, and then passes the same handle on every
   * subsequent turn.
   */
  existingWorktree?: WorktreeHandle;
  /**
   * When true, the mode keeps the worktree alive past the end of
   * the run and returns its handle on `ModeOutput.worktree` so the
   * caller can reuse it. Set by the REPL on every turn so the same
   * worktree carries across the entire session; left false for
   * one-shot CLI invocations (`coderouter run …`) where there's no
   * follow-up turn to benefit from a preserved worktree.
   *
   * Independent of `apply`: with `keepWorktree=true && apply=true`
   * the mode advances the worktree's baseSha post-merge so the
   * next turn's diff is "net new" rather than a re-listing of every
   * change ever made in the session.
   */
  keepWorktree?: boolean;
  /**
   * When true (REPL), plan/masterplan may return early with
   * `clarifyQuestions` instead of drafting immediately — Claude-style
   * multi-choice Q&A before synthesis. One-shot CLI leaves this unset
   * so plans still draft in a single pass.
   */
  interactive?: boolean;
  /**
   * Answers to a prior `clarifyQuestions` round. When present (even
   * empty), plan mode skips the ask gate and injects the answers into
   * the planner prompt.
   */
  clarificationAnswers?: PlanClarifyAnswer[];
};

/**
 * Lightweight worktree descriptor passed across turn boundaries.
 * Mirrors the relevant subset of `Worktree` from the sandbox
 * module - kept here as a plain shape so the modes layer doesn't
 * have to import from sandbox just to type its own input.
 */
export type WorktreeHandle = {
  runId: string;
  branch: string;
  path: string;
  baseRef: string;
  baseSha: string;
  repoPath: string;
  createdAt: number;
};

export type ModeOutput = {
  mode: 'plan' | 'masterplan' | 'agent' | 'debug' | 'review' | 'orchestrate';
  status: RunOutcome['status'];
  runId: string;
  /** Final rendered text artifact (plan markdown, debug hypothesis tree, etc). */
  text?: string;
  /** Plan file when relevant. */
  planFile?: PlanFile;
  /**
   * Open questions the planner flagged (lines it marked `OPEN:`). Surfaced
   * separately from the plan body so the UI can highlight them and prompt
   * the user to confirm before execution. Empty/undefined when the plan had
   * no open decisions.
   */
  openQuestions?: string[];
  /** Resolved diff for the run, if any. */
  diff?: string;
  filesChanged?: string[];
  classification?: Classification;
  contextManifest?: ContextManifest;
  routes?: RouteRef[];
  validators?: ValidatorResult[];
  clarifications?: Clarification[];
  /**
   * Structured multi-choice questions the REPL should ask before the
   * planner drafts. Set when `interactive` is on and answers haven't
   * been supplied yet; status is `partial` and no `planFile` is
   * produced.
   */
  clarifyQuestions?: PlanClarifyQuestion[];
  citations?: Citation[];
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
  rationale: string;
  /**
   * Prompt-injection findings flagged during the run. Populated by
   * the mode pipeline before the adapter is invoked. An empty list
   * means the scan ran but came up clean; `undefined` means the
   * scanner wasn't run at all (e.g. `--fast`).
   */
  securityFindings?: InjectionFinding[];
  /**
   * True when the worktree was merged back into the host repo
   * (i.e. `apply` was on AND there were changes). False means the
   * changes either landed only in `artifactDir` (recoverable) or
   * the run produced no changes.
   */
  applied?: boolean;
  /**
   * When `apply` was requested but the merge back into the host repo
   * failed, the underlying git error. Lets the renderer distinguish
   * "apply was off" from "apply was on and broke" - the patch is
   * still recoverable from `artifactDir` either way.
   */
  applyError?: string;
  /**
   * Filesystem path under `<repo>/.coderouter/runs/<runId>/` where
   * the diff + a small manifest were persisted before the worktree
   * was destroyed. Set when there were changes to keep around for
   * later inspection / manual `git apply`.
   */
  artifactDir?: string;
  /**
   * When validators didn't run, the structured reason (mirrors
   * `Report.validatorsSkippedReason`).
   */
  validatorsSkippedReason?: string;
  /**
   * Adapter-reported session id for this run, if the underlying
   * provider exposes one (Claude Code emits a `session_id` on its
   * `system/init` event). The REPL stores this keyed by provider
   * and replays it on the next turn via `ModeInput.resumeSessions`
   * so the agent retains conversational memory.
   */
  sessionId?: string;
  /**
   * Provider that produced `sessionId`. Stored alongside the id so
   * the REPL can route session resume to the correct adapter even
   * when the router would otherwise pick a different one.
   */
  sessionProvider?: RouteRef['provider'];
  /**
   * The worktree the mode just ran in (whether it was created this
   * turn or reused from `ModeInput.existingWorktree`). The REPL
   * captures this and feeds it back as `existingWorktree` on the
   * next turn so the agent's cwd stays stable across the whole
   * session.
   *
   * `baseSha` here is the *post-turn* sha (i.e. after we snapshot
   * the turn's edits as a commit on the worktree branch), so the
   * next turn's `diffWorktree` produces only the next turn's net
   * changes rather than re-listing everything the session has ever
   * touched. `null` here means we couldn't safely advance the
   * baseSha (commit failed, etc.) - callers can fall back to the
   * input's baseSha.
   */
  worktree?: WorktreeHandle;
  /**
   * Full message history from this turn (system excluded). The REPL
   * appends these to ConversationHistory for first-party agent
   * multi-turn memory. Only populated by the coderouter_agent adapter.
   */
  messages?: ChatMessage[];
};

export type ModeContext = {
  registry: ProviderRegistry;
  router: RouterContext;
  store?: Store;
  budget?: RunBudget;
  /** Override adapter resolution at the mode level (used by eval harness). */
  resolveAdapter?: (route: RouteRef) => Adapter;
};
