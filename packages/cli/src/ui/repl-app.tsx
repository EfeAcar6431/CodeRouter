import { randomUUID } from 'node:crypto';
import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Static, Text, measureElement, render, useApp, useInput, useStdin, useStdout } from 'ink';
import type {
  ActivityEvent,
  AskUserQuestionPayload,
  InjectionFinding,
  Mode,
  PlanClarifyAnswer,
  PlanClarifyQuestion,
  ProgressNotifier,
  ProviderId,
  RouteRef,
} from '@coderouter/core';
import {
  agent,
  ConversationHistory,
  detectPromptImages,
  graphifyPreset,
  listMcpServers,
  probeMcpServer,
  renderReportFooterText,
  renderReportText,
  sandbox,
  saveMcpServer,
  scanForInjection,
  summarizeInjectionScan,
} from '@coderouter/core';
import {
  applyArtifact,
  discardArtifact,
  findArtifact,
  listArtifacts,
  loadArtifact,
  type FileStats,
  type RecordedRun,
} from './artifacts.js';
import { isDirectoryTrusted, trustDirectory } from './trust.js';
import { activeMention, listWorkspaceFiles, rankFiles } from './fileIndex.js';
import { buildExecutionEnv, executeRun } from '../runtime.js';
import { runAppCommand } from '../commands/app.js';
import { ensureDaemon } from '../daemon/lockfile.js';
import { generateLoopSpec, validateLoopSpec } from '@coderouter/core';
import { startDashboardServer, type DashboardServer } from '../dashboard/server.js';
import { spawn } from 'node:child_process';
import {
  BRAND_GLYPH,
  BRAND_NAME,
  WORDMARK_PIXEL,
  WORDMARK_SMALL,
  WORDMARK_TAGLINE,
} from '../branding/index.js';
import { CLI_VERSION } from '../version.js';
import {
  CREDENTIALS_PATH,
  SEARCH_PROVIDERS,
  SETUP_PROVIDERS,
  type SetupProvider,
  detectConfiguredProviders,
  getPreviewInApp,
  loadCredentialsIntoEnv,
  removeCredential,
  saveCredential,
  setHostEnabled,
} from './setup.js';
import type { DetectedHost } from './hosts.js';

/**
 * One row in the unified /setup manager. Local CLI rows toggle on/off
 * with space; provider rows take an API key via enter, drop one via
 * delete/backspace. Each row knows its own affordances so the input
 * handler stays a flat dispatch table.
 */
type ManagerRow =
  | { kind: 'host'; host: DetectedHost }
  | { kind: 'provider'; provider: SetupProvider; hasKey: boolean; group: 'cloud' | 'search' };

type Effort = 'low' | 'medium' | 'high' | 'max';

type CommandDef = {
  name: string;
  hint: string;
  desc: string;
};

const COMMANDS: CommandDef[] = [
  { name: 'plan', hint: '<prompt>', desc: 'quick planning (Cursor-style)' },
  { name: 'masterplan', hint: '<prompt>', desc: '6-phase research-grade plan' },
  { name: 'agent', hint: '<prompt>', desc: 'decisive execution' },
  { name: 'orchestrate', hint: '<prompt>', desc: 'plan → delegate sub-tasks (big plans, cheap executes)' },
  { name: 'debug', hint: '<prompt>', desc: 'investigation + hypothesis tree' },
  { name: 'review', hint: '', desc: 'review the current diff' },
  { name: 'route', hint: '<prompt>', desc: 'classify a prompt (no execution)' },
  { name: 'setup', hint: '', desc: 'manage local CLIs + cloud API keys' },
  { name: 'effort', hint: 'low|medium|high|max', desc: 'set planner/agent effort' },
  { name: 'apply', hint: '', desc: 'toggle: apply diff on success' },
  { name: 'fast', hint: '', desc: 'toggle: skip classifier/context' },
  { name: 'scan', hint: '<text>', desc: 'check text for prompt-injection markers' },
  { name: 'security', hint: 'warn|block', desc: 'set prompt-injection policy' },
  { name: 'models', hint: '[search]', desc: 'browse OpenRouter tool-capable models' },
  { name: 'mcp', hint: '[list|add-graphify]', desc: 'manage external MCP servers (e.g. graphify)' },
  { name: 'dashboard', hint: '', desc: 'open the usage + settings dashboard' },
  { name: 'loop', hint: '<goal>', desc: 'build + run a verified AI loop for a goal' },
  { name: 'app', hint: '', desc: 'launch CodeRouter Studio (desktop app)' },
  { name: 'runs', hint: '', desc: 'list saved run patches' },
  { name: 'accept', hint: '[runId]', desc: 'apply a saved run (latest if omitted)' },
  { name: 'reject', hint: '[runId]', desc: 'discard a saved run' },
  { name: 'trust', hint: '', desc: "trust edits for this session (don't ask again)" },
  { name: 'tui', hint: 'fullscreen|classic', desc: 'toggle the fixed-input fullscreen renderer' },
  { name: 'clear', hint: '', desc: 'clear scrollback' },
  { name: 'help', hint: '', desc: 'show this help' },
  { name: 'exit', hint: '', desc: 'quit the REPL' },
];

const MODE_COMMANDS = new Set(['plan', 'masterplan', 'agent', 'orchestrate', 'debug', 'review']);

/** Best-effort cross-platform "open this URL in the default browser". */
function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // The URL is already printed; the user can open it manually.
  }
}

/**
 * Honor the preview-in-app preference for an `open_preview` from a CLI run.
 * When on, try to route the URL to a running CodeRouter Studio (via the
 * daemon broadcast); if no app is listening (or the pref is off), fall back
 * to the OS default browser so the user always sees the result.
 */
async function routePreview(url: string, cwd: string): Promise<void> {
  if (!getPreviewInApp()) {
    openBrowser(url);
    return;
  }
  try {
    const daemon = await ensureDaemon({ cwd });
    const res = await fetch(`http://127.0.0.1:${daemon.port}/api/preview/app`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (res.ok) {
      const body = (await res.json()) as { delivered?: number };
      if ((body.delivered ?? 0) > 0) return; // Studio is showing it in-app.
    }
  } catch {
    // daemon unreachable — fall through to the external browser
  }
  openBrowser(url);
}

/**
 * Best-effort "open this file in the user's editor". Prefers a GUI editor
 * (Cursor, then VS Code) so it detaches cleanly instead of fighting Ink
 * for the terminal like vim/nano would; falls back to the OS default
 * handler. The path is always printed so the user can open it manually.
 */
function openPathDetached(target: string): void {
  const trySpawn = (cmd: string, args: string[]): void => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    } catch {
      // ignore — caller printed the path
    }
  };
  const platform = process.platform;
  const opener = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', target] : [target];
  trySpawn(opener, args);
}

type HistoryItem =
  | { id: number; kind: 'welcome' }
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'system'; text: string; tone?: 'info' | 'warn' | 'error' | 'success' }
  | { id: number; kind: 'report'; text: string }
  | { id: number; kind: 'log'; entries: LogEntry[] }
  | { id: number; kind: 'changes'; stats: FileStats[] }
  | { id: number; kind: 'question'; payload: AskUserQuestionPayload }
  | { id: number; kind: 'open-questions'; questions: string[] };

type WizardStep =
  | 'idle'
  | 'trust'
  | 'confirm'
  | 'pick'
  | 'key'
  | 'review'
  | 'plan-approve'
  | 'plan-clarify';

/** What to build/refine after a plan run, captured for the approval prompt. */
type PlanApproveState = { planPath?: string; planId?: string; body: string; mode: string };

/** Pre-plan Claude-style multi-choice clarify wizard. */
type PlanClarifyState = {
  prompt: string;
  mode: Mode;
  questions: PlanClarifyQuestion[];
  /** Selected option label keyed by question id. */
  answers: Record<string, string>;
};

const PLAN_APPROVE_OPTIONS = [
  'build now (auto-apply)',
  'build, approve edits',
  'refine in app',
  'edit plan file',
  'give feedback',
];

function defaultClarifyOptionIndex(q: PlanClarifyQuestion): number {
  if (!q.defaultOption) return 0;
  const i = q.options.findIndex((o) => o.label === q.defaultOption);
  return i >= 0 ? i : 0;
}

/**
 * One entry in the unified live log: text spoken by the model and
 * tool calls it makes are appended to the *same* array in arrival
 * order, so the rendered output reads as one continuous narration
 * instead of a split-pane "text up here, activity over there".
 *
 * Three kinds:
 *   - `text`      a stretch of natural-language model output
 *                 (deltas from the streaming adapter accumulate
 *                 into the trailing entry of this kind so we don't
 *                 explode the array with one row per token)
 *   - `tool`      a tool_use, optionally merged with its matching
 *                 tool_result (`ok` flips from undefined -> true/false
 *                 once the result lands)
 *   - `thinking`  reasoning summaries from codex; rendered dim
 */
type LogEntry =
  | { id: number; kind: 'text'; text: string; routeLabel?: string }
  | {
      id: number;
      kind: 'tool';
      tool: string;
      description: string;
      ok?: boolean;
      body?: string;
      routeLabel?: string;
    }
  | { id: number; kind: 'thinking'; text: string };

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Human-readable label for each progress phase emitted by the core
 * pipeline. Keys are the `phase` strings the core's notifier sends;
 * unknown keys fall through to the raw phase name so we don't lie
 * about progress.
 */
const PHASE_LABELS: Record<string, string> = {
  'agent/instant': 'matching instant patterns',
  'agent/security': 'scanning prompt',
  'agent/route': 'routing model',
  'agent/worktree': 'preparing worktree',
  'agent/context': 'scanning context',
  'agent/run': 'running model',
  'agent/validate': 'validating changes',
  'agent/handoff': 'handing off to fix-pass',
  'plan/phase1': 'clarifying',
  'plan/phase4': 'drafting plan',
  'plan/phase6': 'emitting plan',
  'plan/classify': 'classifying prompt',
  'plan/research': 'researching',
  'plan/draft': 'drafting plan',
  'plan/validate': 'validating plan',
  'masterplan/phase1': 'scoping (clarify)',
  'masterplan/phase2': 'gathering internal evidence',
  'masterplan/phase3': 'researching (deep)',
  'masterplan/phase4': 'synthesizing plan',
  'masterplan/phase5': 'self-critique pass',
  'masterplan/phase6': 'emitting plan',
  'orchestrate/plan': 'decomposing into sub-tasks',
  'orchestrate/subtask': 'executing sub-task',
  'orchestrate/validate': 'validating combined result',
  'orchestrate/handoff': 'handing off to fix-pass',
  'debug/evidence': 'gathering evidence',
  'debug/hypothesis': 'building hypotheses',
  'debug/hypothesize': 'building hypothesis tree',
  'debug/test': 'testing hypothesis',
  'review/diff': 'collecting diff',
  'review/judge': 'reviewing changes',
  'review/scan': 'scanning diff',
  'review/critique': 'reviewing changes',
};

function describeProgress(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.replace(/^[a-z]+\//, '').replace(/_/g, ' ');
}

type AppProps = {
  cwd: string;
  initialMode?: Mode;
  /** Start in the alternate-screen fullscreen renderer (opt-in). */
  fullscreen?: boolean;
};

function App({ cwd, initialMode, fullscreen: fullscreenInit }: AppProps): React.ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const { stdin } = useStdin();

  // Fullscreen (alternate-screen) renderer: input is pinned in reserved
  // bottom rows and the transcript is an app-owned viewport, so output
  // never pushes the chatbox down. Off by default (classic renderer
  // keeps everything in native terminal scrollback). Toggle at runtime
  // with `/tui fullscreen|classic`.
  const [fullscreen, setFullscreen] = useState(Boolean(fullscreenInit));
  // Lines scrolled UP from the bottom in the fullscreen viewport. 0 =
  // follow the latest output. PgUp/PgDn adjust it; new activity resets
  // it so the newest content is always shown.
  const [scrollUp, setScrollUp] = useState(0);
  // Live terminal dimensions; re-read on SIGWINCH so the viewport and
  // the alt-screen grid track resizes.
  const [termSize, setTermSize] = useState<{ rows: number; cols: number }>({
    rows: stdout?.rows ?? 40,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setTermSize({ rows: stdout.rows ?? 40, cols: stdout.columns ?? 80 });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  // Enter/leave the alternate screen buffer around fullscreen mode.
  // ESC[?1049h switches to the alt buffer (like vim/less); ESC[?1049l
  // restores the user's shell scrollback on exit or when toggling back
  // to classic. The alt buffer disables the terminal's OWN scrollback,
  // so we also turn on mouse reporting (?1000 button events + ?1006 SGR
  // coordinates) and drive the viewport scroll from wheel events - the
  // same trick Claude Code's fullscreen uses. Guard on a process-exit
  // hook so a crash still restores the user's terminal.
  useEffect(() => {
    if (!fullscreen || !stdout) return;
    stdout.write('\x1b[?1049h\x1b[H\x1b[?1000h\x1b[?1006h');
    const restore = (): void => {
      stdout.write('\x1b[?1000l\x1b[?1006l\x1b[?1049l');
    };
    process.on('exit', restore);
    return () => {
      restore();
      process.off('exit', restore);
    };
  }, [fullscreen, stdout]);

  // Parse mouse-wheel events (SGR: ESC[<64;x;yM = wheel up, 65 = wheel
  // down) and scroll the viewport. A second stdin 'data' listener runs
  // alongside Ink's own keypress parser; Ink ignores these escape
  // sequences so they don't leak into the input box.
  useEffect(() => {
    if (!fullscreen || !stdin) return;
    const onData = (data: Buffer): void => {
      const s = data.toString('utf8');
      const re = /\x1b\[<(\d+);\d+;\d+[Mm]/g;
      let delta = 0;
      let m: RegExpExecArray | null = re.exec(s);
      while (m !== null) {
        const button = Number(m[1]);
        if (button === 64) delta += 3;
        else if (button === 65) delta -= 3;
        m = re.exec(s);
      }
      if (delta !== 0) setScrollUp((v) => Math.max(0, v + delta));
    };
    stdin.on('data', onData);
    return () => {
      stdin.off('data', onData);
    };
  }, [fullscreen, stdin]);

  // Hydrate env from the credentials file once on mount. We do it inside
  // useState's initializer so the very first detectConfiguredProviders()
  // call sees the loaded keys (no "Setup required" flash for users who
  // already saved their keys).
  const [setupState, setSetupState] = useState(() => {
    loadCredentialsIntoEnv();
    return detectConfiguredProviders();
  });

  // Sweep stale worktrees once on launch. Any session that crashed or
  // got SIGKILL'd before destroyWorktree could run would leak `cr/<id>`
  // refs into the host repo's `git worktree list`; left unchecked they
  // accumulate over weeks of usage. Best-effort: errors are swallowed.
  useEffect(() => {
    void sandbox.pruneStaleWorktrees(cwd).catch(() => {
      // best-effort; we never want pruning failure to fail the REPL.
    });
  }, [cwd]);

  // Tear down the session-wide worktree when the REPL exits cleanly
  // (e.g. user types `/exit` or hits ctrl+c). Without this the
  // worktree leaks under /tmp/coderouter-*; the next launch's
  // `pruneStaleWorktrees` sweep eventually catches it but there's
  // no reason to wait. Wired through process-level signals because
  // useApp's `exit()` runs synchronously and react cleanup phases
  // can fire after the Ink renderer is torn down.
  useEffect(() => {
    const cleanup = (): void => {
      // Shut down the background dashboard server if `/dashboard` was
      // used this session, so the port is released on exit.
      const dash = dashboardRef.current;
      if (dash) {
        dashboardRef.current = null;
        void dash.close().catch(() => {});
      }
      const wt = currentWorktreeRef.current;
      if (!wt) return;
      // Use `git worktree remove --force` directly via the sandbox
      // module - we can't await async work from a process-exit
      // hook, so this is fire-and-forget. `pruneStaleWorktrees` on
      // next launch is the safety net.
      currentWorktreeRef.current = undefined;
      void sandbox.destroyWorktree(wt).catch(() => {
        // best-effort; pruneStaleWorktrees on next launch will mop up.
      });
    };
    process.on('beforeExit', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    return () => {
      process.off('beforeExit', cleanup);
      process.off('SIGINT', cleanup);
      process.off('SIGTERM', cleanup);
    };
  }, []);

  // The welcome item is seeded at id=-1 so it lives above everything
  // else: real history items use ids handed out by idRef (starting at
  // 0) and therefore sort and key cleanly below it. Once <Static>
  // commits the welcome row to scrollback it stays there for the
  // whole session - new user prompts and answers just stack below.
  const [history, setHistory] = useState<HistoryItem[]>([
    { id: -1, kind: 'welcome' },
  ]);
  const idRef = useRef(0);
  const [input, setInput] = useState('');
  const [cursor, setCursor] = useState(0);
  const [mode, setMode] = useState<Mode>(initialMode ?? 'agent');
  const [effort, setEffort] = useState<Effort>(
    initialMode === 'masterplan' || initialMode === 'orchestrate' ? 'high' : 'medium',
  );
  // Auto-apply by default: the user almost always wants additions and
  // modifications to land in their tree without a confirmation step.
  // We still pause for explicit approval whenever the patch *deletes*
  // a file, since that's the one case where surprise is destructive.
  // Setting `/apply off` re-introduces the universal review panel for
  // users who want to inspect every patch.
  const [apply, setApply] = useState(true);
  const [fast, setFast] = useState(false);
  // Prompt-injection enforcement policy. 'warn' (default) records
  // findings on the report but still runs the model; 'block' refuses
  // to run when any high-severity finding is present.
  const [securityPolicy, setSecurityPolicy] = useState<'warn' | 'block'>('warn');
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  // Set to true the moment the user presses ESC during a run so the
  // spinner row immediately swaps to "aborting…" - subprocesses can
  // take a couple of seconds to actually exit even with SIGTERM, and
  // that lag was reading as "ESC did nothing".
  const [aborting, setAborting] = useState(false);
  // Tracks the in-flight AbortController so esc-while-busy can cancel
  // the run. Held in a ref so updates don't re-render the spinner.
  const abortRef = useRef<AbortController | null>(null);
  // Unified live log for the in-flight run: every text chunk and
  // every tool call lands here in arrival order, so the rendered
  // output reads as one continuous narration. The mutable canonical
  // copy lives on `liveLogRef` so successive React renders never
  // race chunk callbacks; the state value is set after each push so
  // the tree re-renders with the latest content. Cleared between
  // runs and committed to scrollback as a single 'log' history item.
  const [liveLog, setLiveLog] = useState<LogEntry[]>([]);
  const liveLogRef = useRef<LogEntry[]>([]);
  const logIdRef = useRef(0);
  // Pending prompt queued while a previous run was still in flight.
  // Submitted automatically once the current run finishes; mirrors
  // Claude Code's "type ahead" behaviour. Held in a ref to avoid
  // racing with dispatch's finally block, plus mirrored into state
  // so the UI can render an inline "queued ↑" chip above the
  // chatbox - without that, the only confirmation was a system
  // message in scrollback that often got pushed off-screen during
  // a long run, making the keystroke feel like a no-op.
  const queuedRef = useRef<string | null>(null);
  const [queuedPrompt, setQueuedPrompt] = useState<string | null>(null);
  const [suggIdx, setSuggIdx] = useState(0);
  // Workspace file list backing the `@`-mention picker. Loaded once on
  // mount and refreshed whenever a run finishes (so files the agent
  // just created show up). `git ls-files` is cheap; the manual-walk
  // fallback is bounded.
  const [fileIndex, setFileIndex] = useState<string[]>([]);
  // Pending review (approve/discard/trust) artifact shown
  // automatically after a run that produced changes when apply=off
  // and the user hasn't already trusted edits for this session.
  const [reviewRun, setReviewRun] = useState<RecordedRun | null>(null);
  const [reviewChoice, setReviewChoice] = useState<'approve' | 'discard' | 'trust'>('approve');
  // Post-plan approval prompt (Claude-Code-style): what to do with a plan
  // once it's produced — build it, refine in the app, edit, or give feedback.
  const [planApprove, setPlanApprove] = useState<PlanApproveState | null>(null);
  const [planApproveChoice, setPlanApproveChoice] = useState(0);
  // Pre-plan clarifying questions (Claude Code–style tabs + options).
  const [planClarify, setPlanClarify] = useState<PlanClarifyState | null>(null);
  const [clarifyQIdx, setClarifyQIdx] = useState(0);
  const [clarifyOptIdx, setClarifyOptIdx] = useState(0);
  // Currently-routed model + provider, populated by the agent
  // mode's progress notifier the moment the router picks. The REPL
  // stamps every log entry with a short label (e.g. `claude:opus-4`)
  // so the user can see at a glance which engine is running each
  // action - especially useful when handoffs swap models mid-run.
  // Held in both state (for spinner-row rendering) and a ref (so
  // log entries pushed from streaming callbacks don't race the
  // setState commit).
  const [currentRoute, setCurrentRoute] = useState<RouteRef | null>(null);
  const currentRouteRef = useRef<RouteRef | null>(null);
  // Last route whose rationale we surfaced, so we announce the
  // quality-first reasoning once per distinct route (incl. handoffs).
  const announcedRouteRef = useRef<string | null>(null);
  // Running cumulative token / cost counter. Updated on every
  // onUsage callback from the adapter; resets at the start of each
  // dispatch. Keeps the user's bill visible as it accumulates
  // rather than springing a number on them at the end.
  const [runningUsage, setRunningUsage] = useState<{
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
  // Session-cumulative usage across every run since the REPL
  // launched. Adds up the ending counters of completed runs; the
  // status row shows it when idle so the user knows what they've
  // burned this session.
  const [sessionUsage, setSessionUsage] = useState<{
    tokensIn: number;
    tokensOut: number;
    costUsd: number;
  }>({ tokensIn: 0, tokensOut: 0, costUsd: 0 });

  // Has the user trusted this directory? Persisted across sessions
  // in `~/.coderouter/trust.json`. When false on launch we open the
  // 'trust' wizard step before anything else; the user can either
  // grant trust (we store the path and proceed) or quit. Mirrors how
  // Cursor / Claude Code gate first-time access to a workspace so
  // CodeRouter never silently runs an agent in a directory the user
  // didn't explicitly opt into.
  const [trusted, setTrusted] = useState(() => isDirectoryTrusted(cwd));
  // First-run setup is forced when there's no usable provider key.
  // Wizard order on launch: trust -> confirm (yes/no setup) -> pick
  // (manage hosts/keys) -> idle. Each step gates input so we can't
  // accidentally route an agent run through an empty registry or an
  // untrusted directory.
  const [wizardStep, setWizardStep] = useState<WizardStep>(
    !trusted
      ? 'trust'
      : setupState.configured
        ? 'idle'
        : 'confirm',
  );
  // True after the user picks "trust this session" in the post-run
  // approve panel. Until set, every change-producing run pauses on
  // an inline approve prompt; once set we auto-apply silently for
  // the rest of the REPL session (effectively `/apply on`).
  const [sessionTrustEdits, setSessionTrustEdits] = useState(false);
  // Per-provider session ids captured from prior turns. We replay
  // the entry that matches the routed provider on the next dispatch
  // so the agent gets conversational memory across prompts (e.g.
  // Claude Code rehydrates the prior conversation via `--resume`).
  // A ref shadows the state so dispatch reads the freshest map even
  // when fired from a stale closure (queued prompts, finally
  // handlers).
  const [resumeSessions, setResumeSessions] = useState<
    Partial<Record<ProviderId, string>>
  >({});
  const resumeSessionsRef = useRef<Partial<Record<ProviderId, string>>>({});
  // Stable conversation id for the whole REPL session so every turn is
  // persisted into one browsable chat (see store/chats + the desktop app).
  const chatSessionIdRef = useRef<string>(randomUUID());
  // Conversation history for first-party agent multi-turn memory.
  // Persists across REPL turns, condensed when approaching the
  // context window limit.
  const conversationHistoryRef = useRef(new ConversationHistory());
  // Background dashboard server, started on demand by `/dashboard` and
  // reused across invocations so we never bind a second port.
  const dashboardRef = useRef<DashboardServer | null>(null);
  // Long-lived agent worktree, kept alive across REPL turns. Without
  // this every prompt would spin up a fresh `/tmp/coderouter-XXX/`
  // worktree, which means (a) the model's cwd is different every
  // turn so "the directory above this one" stops meaning anything,
  // and (b) files the agent created in turn N are invisible in
  // turn N+1 because turn N's worktree has been destroyed. Stored
  // in a ref so dispatch reads the latest value even when fired
  // from a stale closure (queued prompts, abort handlers).
  const [currentWorktree, setCurrentWorktree] = useState<
    import('@coderouter/core').WorktreeHandle | undefined
  >(undefined);
  const currentWorktreeRef = useRef<
    import('@coderouter/core').WorktreeHandle | undefined
  >(undefined);
  // Pending interactive question from the model. When set, the
  // previous run was aborted because Claude invoked
  // `AskUserQuestion`; the REPL renders an answer panel and the
  // user's next prompt is dispatched as the answer (with session
  // resume). Held in a ref so the dispatch's onUserQuestion
  // callback can stash it synchronously before aborting (state
  // setters race the abort otherwise).
  const [pendingQuestion, setPendingQuestion] = useState<AskUserQuestionPayload | null>(null);
  const pendingQuestionRef = useRef<AskUserQuestionPayload | null>(null);
  // Highlighted row in the unified /setup manager. Indexes into the
  // flattened `managerRows` list (hosts first, then API providers).
  const [wizardPick, setWizardPick] = useState(0);
  const [wizardKey, setWizardKey] = useState('');
  // The provider whose key the user is currently entering. Set when
  // transitioning from the picker into the key step so we don't have
  // to dig through `managerRows` from the input handler.
  const [wizardProvider, setWizardProvider] = useState<SetupProvider | null>(null);
  // Highlighted button in the yes/no confirm. Arrows move between
  // 'yes' and 'no'; enter activates the highlighted one. 'y' / 'n' also
  // work as direct shortcuts for users who already know the answer.
  const [confirmChoice, setConfirmChoice] = useState<'yes' | 'no'>('yes');
  // Trust dialog highlight state, identical UX to the confirm wizard:
  // arrows move between yes/no, enter commits the highlighted choice.
  const [trustChoice, setTrustChoice] = useState<'yes' | 'no'>('yes');

  // Flattened list of rows shown in /setup. Recomputed whenever the
  // user toggles a host or saves/removes a key so the checkboxes /
  // "key set" markers stay in sync without a manual refresh.
  const managerRows = useMemo<ManagerRow[]>(() => {
    const apiKeySet = new Set(setupState.apiKeys);
    const searchKeySet = new Set(setupState.searchKeys);
    const hostRows: ManagerRow[] = setupState.hosts.map((host) => ({ kind: 'host', host }));
    const providerRows: ManagerRow[] = SETUP_PROVIDERS.map((provider) => ({
      kind: 'provider',
      provider,
      hasKey: apiKeySet.has(provider.name),
      group: 'cloud',
    }));
    const searchRows: ManagerRow[] = SEARCH_PROVIDERS.map((provider) => ({
      kind: 'provider',
      provider,
      hasKey: searchKeySet.has(provider.name),
      group: 'search',
    }));
    return [...hostRows, ...providerRows, ...searchRows];
  }, [setupState]);

  // Keep wizardPick in range when the list shrinks (e.g. host newly
  // disabled removes it from view? - currently it doesn't, but this
  // future-proofs the guard).
  useEffect(() => {
    if (wizardPick >= managerRows.length && managerRows.length > 0) {
      setWizardPick(managerRows.length - 1);
    }
  }, [managerRows.length, wizardPick]);

  // Slash-command palette: visible while the user is typing the command
  // name (no space yet). Once they hit space, we switch to "arg entry" and
  // hide the menu so the prompt area is unobstructed.
  const showSuggestions =
    wizardStep === 'idle' && input.startsWith('/') && !input.includes(' ');
  const filter = showSuggestions ? input.slice(1).toLowerCase() : '';
  const suggestions = useMemo(
    () => (showSuggestions ? COMMANDS.filter((c) => c.name.startsWith(filter)) : []),
    [filter, showSuggestions],
  );

  // `@`-mention file picker: active when the cursor sits inside an
  // `@token` (Claude-style). Mutually exclusive with the slash palette
  // since one needs a leading `/` and the other an `@`.
  const mention = useMemo(
    () => (wizardStep === 'idle' && !input.startsWith('/') ? activeMention(input, cursor) : null),
    [input, cursor, wizardStep],
  );
  const mentionSuggestions = useMemo(
    () => (mention ? rankFiles(fileIndex, mention.query) : []),
    [mention, fileIndex],
  );
  const showMentions = !busy && wizardStep === 'idle' && mention !== null && mentionSuggestions.length > 0;

  // Clamp the shared selection index to whichever palette is active.
  const activeSuggestCount = showMentions ? mentionSuggestions.length : suggestions.length;
  useEffect(() => {
    if (suggIdx >= activeSuggestCount) setSuggIdx(0);
  }, [activeSuggestCount, suggIdx]);

  // Load the workspace file list on mount and refresh it whenever a run
  // finishes (busy -> idle), so newly-created files appear in the picker.
  useEffect(() => {
    if (!busy) setFileIndex(listWorkspaceFiles(cwd));
  }, [busy, cwd]);

  /**
   * Complete the active `@`-mention with the highlighted file: splice
   * the relative path in place of the typed query and drop a trailing
   * space (which also closes the picker).
   */
  function completeMention(): void {
    if (!mention) return;
    const sel = mentionSuggestions[suggIdx] ?? mentionSuggestions[0];
    if (!sel) return;
    const before = input.slice(0, mention.start);
    const after = input.slice(cursor);
    const insert = `@${sel} `;
    setInput(before + insert + after);
    setCursor((before + insert).length);
    setSuggIdx(0);
  }

  /**
   * Short, terminal-friendly label for a route. Combines the
   * "via" (typically the orchestrator: codex, claudeCode,
   * anthropic, etc.) with the underlying model name so the user
   * can tell apart `claudeCode:opus-4.1` and `anthropic:opus-4.1`
   * at a glance. Returns undefined when the route hasn't been
   * picked yet.
   */
  function formatRouteLabel(route: RouteRef | null): string | undefined {
    if (!route) return undefined;
    const via = route.via ?? route.provider;
    // Anthropic / Claude Code resolved-model ids carry an 8-digit
    // release-date suffix (`claude-sonnet-4-5-20250929`). The user
    // wants the exact identifier on the right edge of every block,
    // but the date noise pushes longer block names off-screen and
    // doesn't disambiguate runs in any useful way (the version
    // already does). Strip it for display only - the underlying
    // route still carries the full string for the report.
    const trimmed = route.model.replace(/-\d{8}$/, '');
    return `${via}:${trimmed}`;
  }

  /**
   * Append a streaming text chunk to the live log. Consecutive
   * chunks coalesce into the trailing `text` entry so the rendered
   * markdown stays stable; a new `text` entry only starts when an
   * activity event has interrupted in between (which guarantees
   * arrival order in the visual log).
   *
   * Each text block carries a `routeLabel` so the UI can stamp
   * which model produced it on the right edge - useful when a run
   * hands off mid-stream (the new entry inherits the new route
   * while existing ones keep their original stamp).
   */
  function appendLogText(chunk: string): void {
    if (!chunk) return;
    const log = liveLogRef.current;
    const last = log.length > 0 ? log[log.length - 1] : undefined;
    const routeLabel = formatRouteLabel(currentRouteRef.current);
    if (last && last.kind === 'text') {
      const merged: LogEntry = {
        id: last.id,
        kind: 'text',
        text: last.text + chunk,
        routeLabel: last.routeLabel ?? routeLabel,
      };
      liveLogRef.current = [...log.slice(0, -1), merged];
    } else {
      liveLogRef.current = [
        ...log,
        { id: logIdRef.current++, kind: 'text', text: chunk, routeLabel },
      ];
    }
    flushLiveOverflowToHistory();
    setLiveLog(liveLogRef.current);
  }

  /**
   * Append (or merge) an activity event into the live log. tool_use
   * always pushes a fresh `tool` entry. tool_result finds the most
   * recent unresolved `tool` row with the same tool name and folds
   * the outcome into it; if there isn't one, we still append a
   * standalone row so the user sees something rather than dropping
   * the event silently.
   */
  function appendLogActivity(event: ActivityEvent): void {
    const log = liveLogRef.current;
    const routeLabel = formatRouteLabel(currentRouteRef.current);
    if (event.kind === 'tool_result') {
      let target = -1;
      for (let i = log.length - 1; i >= 0; i--) {
        const row = log[i]!;
        if (row.kind === 'tool' && row.tool === event.tool && row.ok === undefined) {
          target = i;
          break;
        }
      }
      if (target >= 0) {
        const orig = log[target]! as Extract<LogEntry, { kind: 'tool' }>;
        const updated: LogEntry = { ...orig, ok: event.ok, body: event.body };
        liveLogRef.current = [...log.slice(0, target), updated, ...log.slice(target + 1)];
      } else {
        liveLogRef.current = [
          ...log,
          {
            id: logIdRef.current++,
            kind: 'tool',
            tool: event.tool,
            description: event.tool,
            ok: event.ok,
            body: event.body,
            routeLabel,
          },
        ];
      }
    } else if (event.kind === 'tool_use') {
      liveLogRef.current = [
        ...log,
        {
          id: logIdRef.current++,
          kind: 'tool',
          tool: event.tool,
          description: event.description,
          routeLabel,
        },
      ];
    } else if (event.kind === 'process_started') {
      liveLogRef.current = [
        ...log,
        {
          id: logIdRef.current++,
          kind: 'tool',
          tool: 'bash',
          description: `Started ${event.command}${event.url ? ` — ${event.url}` : ''}`,
          routeLabel,
        },
      ];
    } else if (event.kind === 'open_preview') {
      // Route to CodeRouter Studio's built-in browser when the preview-in-app
      // pref is on and the app is running; otherwise open the OS browser.
      const inApp = getPreviewInApp();
      void routePreview(event.url, cwd);
      liveLogRef.current = [
        ...log,
        {
          id: logIdRef.current++,
          kind: 'tool',
          tool: 'open_preview',
          description: `Opened ${event.url}${inApp ? ' in CodeRouter Studio (or your browser)' : ' in your browser'}`,
          ok: true,
          routeLabel,
        },
      ];
    } else {
      // Merge consecutive thinking deltas into one growing entry so
      // streamed reasoning forms a single dim block rather than one
      // line per token.
      const last = log.length > 0 ? log[log.length - 1] : undefined;
      if (last && last.kind === 'thinking') {
        const merged: LogEntry = { id: last.id, kind: 'thinking', text: last.text + event.text };
        liveLogRef.current = [...log.slice(0, -1), merged];
      } else {
        liveLogRef.current = [
          ...log,
          { id: logIdRef.current++, kind: 'thinking', text: event.text },
        ];
      }
    }
    flushLiveOverflowToHistory();
    setLiveLog(liveLogRef.current);
  }

  /**
   * Incrementally commit the OLDEST live entries to Static history
   * whenever the live log is about to exceed the visible viewport.
   *
   * Why: Ink's `<Static>` is the only render path that's safe for
   * scrollback. Anything in the dynamic area (everything below
   * `<Static>`) is rendered using cursor manipulation. If that
   * dynamic content grows tall enough to scroll past the viewport,
   * the scrolled-out lines become permanent terminal scrollback -
   * but they're NOT in Ink's Static, so when we later try to commit
   * the same content via Static, the same lines get printed AGAIN
   * (= the duplicate-paragraph bug).
   *
   * The cure: actively pop from the front of the live log into
   * Static whenever total visible height threatens to exceed
   * `rows - margin`. Keep at least the LAST entry in live so the
   * appendLogText merge-into-last-text-entry path keeps working.
   */
  function flushLiveOverflowToHistory(): void {
    const rows = process.stdout.rows ?? 40;
    // Reserve room for: spinner row, esc-hint row, blank line,
    // chatbox (3 lines), status row. Conservative on small
    // terminals, generous on large ones.
    const reserved = 8;
    const maxLines = Math.max(8, rows - reserved);

    // Cheap height estimate. Doesn't account for terminal width
    // wrapping, but the conservative `reserved` budget absorbs that.
    let total = 0;
    for (const e of liveLogRef.current) {
      total += estimateLogEntryLines(e);
    }
    if (total <= maxLines) return;

    const popped: LogEntry[] = [];
    let i = 0;
    while (
      total > maxLines &&
      i < liveLogRef.current.length - 1 // always keep the last entry alive
    ) {
      popped.push(liveLogRef.current[i]!);
      total -= estimateLogEntryLines(liveLogRef.current[i]!);
      i++;
    }
    if (popped.length === 0) return;
    liveLogRef.current = liveLogRef.current.slice(i);
    pushLog(popped);
  }

  function appendHistory(item: HistoryItem): void {
    setHistory((h) => [...h, item]);
  }
  function pushUser(text: string): void {
    appendHistory({ id: idRef.current++, kind: 'user', text });
  }
  function pushSystem(text: string, tone?: 'info' | 'warn' | 'error' | 'success'): void {
    appendHistory({ id: idRef.current++, kind: 'system', text, tone });
  }
  function pushReport(text: string): void {
    if (!text.trim()) return;
    appendHistory({ id: idRef.current++, kind: 'report', text });
  }
  /**
   * Promote the entire live log (text + tool calls in arrival
   * order) to a frozen history item so it stays in scrollback after
   * the run completes. Snapshots the array so the next run's
   * mutations don't reach back into existing scrollback.
   */
  function pushLog(entries: LogEntry[]): void {
    if (entries.length === 0) return;
    appendHistory({ id: idRef.current++, kind: 'log', entries: [...entries] });
  }
  /**
   * Compact per-file diff summary appended after a run that produced
   * changes. Lives in scrollback so the user can scroll up and see
   * what each run touched without re-running `/runs`.
   */
  function pushChanges(stats: FileStats[]): void {
    if (stats.length === 0) return;
    appendHistory({ id: idRef.current++, kind: 'changes', stats: [...stats] });
  }

  /**
   * Persist the model's interactive question to scrollback as a
   * styled history item so the user can read it (and reference it)
   * even after the next prompt is dispatched and pushes the live
   * area down. The accompanying inline hint above the chatbox is
   * what tells the user "your reply is the answer"; this is the
   * record of what was asked.
   */
  function pushQuestion(payload: AskUserQuestionPayload): void {
    if (payload.questions.length === 0) return;
    appendHistory({ id: idRef.current++, kind: 'question', payload });
  }

  /**
   * Highlight the open questions a plan flagged in a bordered callout so
   * they don't get lost in the streamed plan body. These are decisions the
   * user should confirm before executing the plan.
   */
  function pushOpenQuestions(questions: string[]): void {
    if (questions.length === 0) return;
    appendHistory({ id: idRef.current++, kind: 'open-questions', questions: [...questions] });
  }

  /**
   * Push a multi-line system block summarising security findings.
   * Worst severity drives the tone (high → red, warn → yellow,
   * info → gray) so the user can spot trouble at a glance.
   */
  function pushFindingsBanner(findings: InjectionFinding[]): void {
    if (findings.length === 0) return;
    const head = findings.slice(0, 5);
    const lines = [
      `  ! ${findings.length} prompt-injection finding(s):`,
      ...head.map((f) => {
        const src = f.source ? ` (${f.source})` : '';
        return `    - ${f.severity.toUpperCase()} [${f.ruleId}]${src} ${f.excerpt}`;
      }),
    ];
    if (findings.length > head.length) {
      lines.push(`    ... and ${findings.length - head.length} more`);
    }
    const worst = findings.some((f) => f.severity === 'high')
      ? 'error'
      : findings.some((f) => f.severity === 'warn')
        ? 'warn'
        : 'info';
    pushSystem(lines.join('\n'), worst);
  }

  async function dispatch(
    prompt: string,
    modeOverride?: Mode,
    applyOverride?: boolean,
    clarificationAnswers?: PlanClarifyAnswer[],
  ): Promise<void> {
    const m = modeOverride ?? mode;
    setBusy(true);
    setPhase('preparing');
    // Snap the fullscreen viewport back to the latest output.
    setScrollUp(0);
    liveLogRef.current = [];
    setLiveLog([]);
    // Each dispatch starts with a fresh per-run usage counter so the
    // displayed numbers represent THIS turn, not the session total
    // (which we track separately and show on idle).
    setRunningUsage({ tokensIn: 0, tokensOut: 0, costUsd: 0 });
    // Re-announce the routing rationale for this turn even if the same
    // route ends up chosen.
    announcedRouteRef.current = null;
    // Don't blank `currentRoute` here - the previous route is still a
    // good default for any text we render before agent/run/start
    // arrives (e.g. a quick error or the spinner row). The notifier
    // will overwrite it as soon as the router picks for this turn.
    const controller = new AbortController();
    abortRef.current = controller;
    // ALWAYS run the agent with apply=false so the diff is persisted
    // to .coderouter/runs/<id>/changes.patch and the worktree is
    // discarded cleanly. We then decide what to do with the artifact
    // here in the REPL (auto-apply / show approve panel) using the
    // patch contents - this lets us peek at the patch and
    // conditionally pause for deletions before anything lands in
    // the host repo. The user-facing `/apply` toggle still controls
    // intent; it just no longer drives the underlying merge.
    const userIntendsAutoApply = applyOverride ?? (apply || sessionTrustEdits);
    const notifier: ProgressNotifier = (u) => {
      // Friendly label per phase; ignore the `stage` (`start`/`done`)
      // because the animated spinner already conveys "still running"
      // and bouncing between "running ✓" / "running" reads as flicker.
      setPhase(describeProgress(u.phase));
      // Capture route info from the agent mode's first progress beat
      // so we can stamp every log entry with the model that produced
      // it. The shape matches RouteRef but we duck-type defensively
      // since `data` is a free-form Record.
      const data = u.data;
      if (data && typeof data === 'object' && 'route' in data) {
        const r = (data as { route?: Partial<RouteRef> }).route;
        if (r && r.provider && r.model) {
          const next: RouteRef = {
            provider: r.provider,
            model: r.model,
            rationale: r.rationale ?? '',
            via: r.via ?? r.provider,
          };
          currentRouteRef.current = next;
          setCurrentRoute(next);
          // Surface *why* this model was picked, once per distinct
          // route. The rationale now explains the quality-first choice
          // (e.g. "balanced-agent: frontier coding=93, top quality").
          const key = `${next.via ?? next.provider},${next.model}`;
          if (next.rationale && announcedRouteRef.current !== key) {
            announcedRouteRef.current = key;
            pushSystem(`→ ${formatRouteLabel(next)} · ${next.rationale}`, 'info');
          }
        }
      }
    };
    // Condense conversation history if over threshold. Best-effort:
    // failures are swallowed and the history just stays un-condensed
    // (or oldest messages get dropped).
    try {
      const history = conversationHistoryRef.current;
      const contextWindow = 128_000; // conservative default
      if (history.tokenCount() > contextWindow * 0.75) {
        const transport = buildCondensationTransport();
        if (transport) {
          await history.condense(transport, contextWindow);
        }
      }
    } catch {
      // Condensation is best-effort.
    }

    try {
      const { report, store } = await executeRun({
        prompt,
        cwd,
        mode: m,
        effort,
        apply: false,
        fast,
        sessionId: chatSessionIdRef.current,
        injectionPolicy: securityPolicy,
        // Replay session ids captured from prior turns. The agent
        // mode picks the entry that matches the routed provider and
        // forwards it as `resumeSessionId`, giving the model
        // continuity across REPL prompts. Read via ref so a queued
        // prompt that fires after this turn's session id was
        // recorded still picks it up.
        resumeSessions: resumeSessionsRef.current,
        // Hand the prior turn's worktree back so the agent runs in
        // the *same* cwd it ran in last turn, with its earlier edits
        // still visible. Critical for conversational coding: without
        // it the agent's filesystem state resets between every
        // prompt and follow-up questions like "do task 1" hit a
        // pristine tmpdir that has no idea what task 1 is.
        existingWorktree: currentWorktreeRef.current,
        // Prior conversation messages for multi-turn memory.
        priorMessages: conversationHistoryRef.current.getMessages(),
        // Signal the mode that this is an interactive REPL session,
        // so it preserves the worktree past the end of the run and
        // hands the (post-snapshot) handle back via
        // `Report.worktree` for the next turn to pick up.
        keepWorktree: true,
        // Interactive REPL: plan mode may pause for Claude-style Q&A.
        interactive: true,
        clarificationAnswers,
        progress: { notifier, close: () => {} },
        signal: controller.signal,
        onChunk: (chunk) => {
          // Coalesce consecutive text chunks into the trailing log
          // entry so the rendered narration stays stable; an
          // intervening tool_use breaks the run automatically.
          appendLogText(chunk);
        },
        onActivity: (event) => {
          appendLogActivity(event);
        },
        onUsage: (usage) => {
          setRunningUsage(usage);
        },
        // The model fired `AskUserQuestion`. Stash the payload and
        // abort the run immediately - the headless `claude -p`
        // subprocess can't accept an answer back, and if we let it
        // run to completion it just makes a fallback guess. We
        // surface the question via an inline panel below; the
        // user's next prompt is dispatched as the answer with
        // session resume so Claude sees the answer in context.
        onUserQuestion: (payload) => {
          pendingQuestionRef.current = payload;
          setPendingQuestion(payload);
          abortRef.current?.abort();
        },
      });

      // Persist the adapter's session id (Claude Code's `session_id`,
      // etc.) keyed by provider so the next dispatch can replay it
      // via `--resume <id>`. We update the ref synchronously so a
      // typed-ahead prompt that fires immediately after this run
      // picks up the new id without waiting for React to flush
      // setState.
      if (report.sessionId && report.sessionProvider) {
        const next = {
          ...resumeSessionsRef.current,
          [report.sessionProvider]: report.sessionId,
        };
        resumeSessionsRef.current = next;
        setResumeSessions(next);
      }

      // Capture the post-turn worktree handle so the next prompt
      // continues in the same cwd / branch. Always use the report's
      // value when present (its baseSha has been advanced past the
      // turn's edits, so the next diff doesn't re-list everything).
      if (report.worktree) {
        currentWorktreeRef.current = report.worktree;
        setCurrentWorktree(report.worktree);
      }

      // Append this turn's messages to conversation history for
      // multi-turn memory. Only fires for the first-party agent
      // adapter which populates `messages`.
      if (report.messages && report.messages.length > 0) {
        conversationHistoryRef.current.append(report.messages);
      }

      // Surface prompt-injection findings before rendering the answer
      // so the operator sees them clearly even if they later scroll
      // past the report footer.
      if (report.securityFindings && report.securityFindings.length > 0) {
        pushFindingsBanner(report.securityFindings);
        if (report.status === 'failed' && report.rationale.startsWith('blocked:')) {
          pushSystem(
            '  run blocked by /security policy (block). use `/security warn` to override.',
            'error',
          );
        }
      }

      // Commit the unified live log (text + tool calls in arrival
      // order) to scrollback as a single ordered entry.
      //
      // ORDERING IS LOAD-BEARING here. We must clear `liveLog` and
      // flip `busy` to false BEFORE pushing the frozen copy to
      // history; otherwise React can paint an intermediate frame
      // where both the live `<LogStream>` (still rendering because
      // busy=true and liveLog is non-empty) AND the freshly
      // appended history item (the same entries) are visible at
      // once. Ink's `<Static>` commits whatever it sees that frame
      // to scrollback permanently, leaving a duplicate copy of the
      // entire activity log pinned in the terminal.
      const finalLog = liveLogRef.current;
      // Best-effort route label for the synthetic fallback: prefer
      // the live route the agent emitted, fall back to whatever the
      // report's `routes` array carries (modes that don't stream
      // still fill that in at the end).
      const fallbackRouteLabel =
        formatRouteLabel(currentRouteRef.current) ??
        (report.routes && report.routes.length > 0
          ? formatRouteLabel(report.routes[0]!)
          : undefined);

      liveLogRef.current = [];
      setLiveLog([]);
      setBusy(false);
      setPhase('');

      if (controller.signal.aborted) {
        if (finalLog.length > 0) pushLog(finalLog);
        // If we aborted because the model asked a question, the
        // panel below is doing the user-facing work; don't
        // double-message with a plain "interrupted" line.
        if (pendingQuestionRef.current) {
          pushQuestion(pendingQuestionRef.current);
        } else {
          pushSystem('  interrupted', 'warn');
        }
      } else if (finalLog.length > 0) {
        pushLog(finalLog);
      } else if (report.text && report.text.trim()) {
        pushLog([
          {
            id: logIdRef.current++,
            kind: 'text',
            text: report.text,
            routeLabel: fallbackRouteLabel,
          },
        ]);
      }

      // Claude-style pre-plan Q&A: pause here and open the clarify
      // wizard instead of drafting. Re-dispatch with answers later.
      if (
        !controller.signal.aborted &&
        report.status === 'partial' &&
        report.clarifyQuestions &&
        report.clarifyQuestions.length > 0
      ) {
        const qs = report.clarifyQuestions;
        setPlanClarify({
          prompt,
          mode: m,
          questions: qs,
          answers: {},
        });
        setClarifyQIdx(0);
        setClarifyOptIdx(defaultClarifyOptionIndex(qs[0]!));
        setWizardStep('plan-clarify');
        pushSystem('  clarifying before drafting — pick an option for each question', 'info');
      } else {
      // Compact per-file change summary, plus a deletion check used
      // below to decide whether we can auto-apply silently.
      let postRunArtifact: RecordedRun | null = null;
      if (report.artifactDir) {
        postRunArtifact = loadArtifact(report.artifactDir);
      }
      if (postRunArtifact && postRunArtifact.fileStats.length > 0) {
        pushChanges(postRunArtifact.fileStats);
      }
      const hasDeletions = postRunArtifact?.fileStats.some((f) => f.deleted) ?? false;

      // Validators / citations / escalation hints still live in the
      // report footer; the answer body has already been streamed.
      const footer = renderReportFooterText(
        {
          ...report,
          // Strip filesChanged so the renderer doesn't re-emit a
          // textual list - the `changes` history item now owns that.
          filesChanged: undefined,
        } as typeof report,
        // Open questions + the plan-saved path get their own highlighted
        // history items below, so keep them out of the dim footer.
        { includePlanExtras: false },
      );
      if (footer.trim()) pushReport(footer);

      // Surface any pre-plan clarifications the detector flagged (the
      // assumptions the planner made), distinct from planner OPEN: lines.
      if (report.clarifications && report.clarifications.length > 0) {
        pushSystem(
          `  clarifications the planner assumed:\n${report.clarifications
            .map((c) => `    • ${c.question}`)
            .join('\n')}`,
          'info',
        );
      }

      // Highlight the planner's open questions in a bordered callout, then
      // point the user at the saved, editable plan file.
      if (report.openQuestions && report.openQuestions.length > 0) {
        pushOpenQuestions(report.openQuestions);
      }
      if (report.planPath) {
        pushSystem(`  plan saved to ${report.planPath}`, 'success');
      }

      // After a plan/masterplan run, offer the Claude-Code-style approval
      // prompt: build it, refine in the app, edit, or give feedback.
      const isPlanRun = report.mode === 'plan' || report.mode === 'masterplan';
      if (!controller.signal.aborted && isPlanRun && report.status === 'success') {
        setPlanApprove({
          planPath: report.planPath,
          planId: report.planId,
          body: report.text ?? '',
          mode: report.mode,
        });
        setPlanApproveChoice(0);
        setWizardStep('plan-approve');
      }

      // Decide what to do with the changes:
      //   1. No artifact / no files → nothing to do.
      //   2. Aborted → leave artifact on disk, user can `/accept`.
      //   3. User intends auto-apply AND no deletions → apply
      //      silently and tell the user via a banner.
      //   4. Otherwise (deletions present, or `/apply off`) → show
      //      the inline approve panel so the user explicitly
      //      consents before anything destructive happens.
      if (
        !controller.signal.aborted &&
        postRunArtifact &&
        postRunArtifact.fileStats.length > 0
      ) {
        if (userIntendsAutoApply && !hasDeletions) {
          const result = applyArtifact(cwd, postRunArtifact);
          if (result.ok) {
            const note = result.strategy === '3way' ? ' (with 3-way merge)' : '';
            pushSystem(
              `  applied ${postRunArtifact.fileStats.length} file(s)${note}`,
              'success',
            );
            const overwrote = result.overwrote ?? [];
            if (overwrote.length > 0) {
              pushSystem(
                `  overwrote ${overwrote.length} pre-existing file(s): ${overwrote.join(', ')}\n  originals backed up at ${postRunArtifact.dir}/overwritten`,
                'warn',
              );
            } else {
              // Keep the artifact (with its backups) when we had to
              // overwrite existing files, so the user can recover them.
              try {
                discardArtifact(postRunArtifact);
              } catch {
                // best-effort
              }
            }
          } else {
            // Apply failed (context drift, conflict, etc.) - keep the
            // artifact on disk and surface the approve panel so the
            // user can either retry manually or discard.
            pushSystem(
              `  could not auto-apply: ${result.error}\n  patch is preserved at ${postRunArtifact.patchPath}`,
              'warn',
            );
            setReviewRun(postRunArtifact);
            setReviewChoice('approve');
            setWizardStep('review');
          }
        } else {
          if (hasDeletions && userIntendsAutoApply) {
            const deleted = postRunArtifact.fileStats
              .filter((f) => f.deleted)
              .map((f) => f.file);
            const head = deleted.slice(0, 3).join(', ');
            const more = deleted.length > 3 ? ` +${deleted.length - 3} more` : '';
            pushSystem(
              `  pause: this run deletes ${deleted.length} file(s) - ${head}${more}`,
              'warn',
            );
          }
          setReviewRun(postRunArtifact);
          setReviewChoice('approve');
          setWizardStep('review');
        }
      }
      } // end else (not pre-plan clarify)

      // Roll this run's authoritative numbers (from the final
      // report - more accurate than the streaming estimate the
      // adapter fed us) into the session-cumulative counter we
      // show in the idle status row.
      setSessionUsage((s) => ({
        tokensIn: s.tokensIn + (report.tokensIn || 0),
        tokensOut: s.tokensOut + (report.tokensOut || 0),
        costUsd: s.costUsd + (report.costUsd || 0),
      }));

      try {
        store.db.close();
      } catch {
        // best-effort
      }
    } catch (err) {
      // Whatever we've already streamed is committed to scrollback so
      // the user still sees what the model said before failing.
      if (liveLogRef.current.length > 0) {
        pushLog(liveLogRef.current);
      }
      if (controller.signal.aborted) {
        // Same interrupted-vs-question distinction as the success
        // branch above: when the abort came from `AskUserQuestion`
        // the panel does the talking, so don't push a generic
        // "interrupted" line on top of it.
        if (pendingQuestionRef.current) {
          pushQuestion(pendingQuestionRef.current);
        } else {
          pushSystem('  interrupted', 'warn');
        }
      } else {
        pushSystem(`  error: ${(err as Error).message}`, 'error');
      }
    } finally {
      abortRef.current = null;
      liveLogRef.current = [];
      setLiveLog([]);
      setBusy(false);
      setPhase('');
      setAborting(false);
      // If the user typed-ahead while the previous run was in flight,
      // fire it now. setTimeout ensures the in-flight setState calls
      // above have committed before we start the next dispatch. We
      // also clear the visible queue chip in the same tick so the
      // user sees their typed-ahead prompt transition cleanly into
      // a fresh run rather than briefly flashing both states.
      const queued = queuedRef.current;
      queuedRef.current = null;
      setQueuedPrompt(null);
      if (queued) {
        setTimeout(() => {
          void submit(queued);
        }, 0);
      }
    }
  }

  /**
   * Apply or discard the pending review artifact. Three choices:
   *   - `approve`: git apply this run only; keep prompting on
   *                future runs so the user retains per-run veto.
   *   - `discard`: delete the artifact; nothing lands in the repo.
   *   - `trust`:   apply this run AND flip session trust on so we
   *                stop prompting for the rest of the REPL session
   *                (effectively `/apply on` going forward). This
   *                is what the user wants once they've decided
   *                CodeRouter is doing the right thing.
   *
   * In every case we close the review wizard and return to idle so
   * the user can keep typing immediately.
   */
  /**
   * Persist trust for the current directory and advance the wizard
   * to the next step (or `idle` if the user already has a provider
   * configured). Tolerates persistence failures - the user just gets
   * re-prompted next time, no need to block the session.
   */
  function commitTrust(): void {
    try {
      trustDirectory(cwd);
    } catch {
      // best-effort
    }
    setTrusted(true);
    setWizardStep(setupState.configured ? 'idle' : 'confirm');
    pushSystem(`  trusted ${cwd}`, 'success');
  }

  function resolveReview(choice: 'approve' | 'discard' | 'trust'): void {
    const run = reviewRun;
    if (!run) {
      setWizardStep('idle');
      return;
    }
    if (choice === 'approve' || choice === 'trust') {
      const result = applyArtifact(cwd, run);
      if (result.ok) {
        const note = result.strategy === '3way' ? ' (with 3-way merge)' : '';
        pushSystem(`  applied ${run.files.length} file(s)${note}`, 'success');
        const overwrote = result.overwrote ?? [];
        if (overwrote.length > 0) {
          pushSystem(
            `  overwrote ${overwrote.length} pre-existing file(s): ${overwrote.join(', ')}\n  originals backed up at ${run.dir}/overwritten`,
            'warn',
          );
        }
        try {
          discardArtifact(run);
        } catch {
          // best-effort
        }
        if (choice === 'trust') {
          setSessionTrustEdits(true);
          setApply(true);
          pushSystem(
            '  trusted edits for this session - future runs will auto-apply (toggle off with /apply off)',
            'info',
          );
        }
      } else {
        pushSystem(
          `  failed to apply run ${run.runId}: ${result.error}\n  patch is preserved at ${run.patchPath}`,
          'error',
        );
      }
    } else {
      try {
        discardArtifact(run);
        pushSystem(`  discarded ${run.files.length} file(s)`, 'warn');
      } catch (err) {
        pushSystem(`  failed to discard artifact: ${(err as Error).message}`, 'error');
      }
    }
    setReviewRun(null);
    setWizardStep('idle');
  }

  /**
   * Act on the post-plan approval prompt. Indexes match
   * `PLAN_APPROVE_OPTIONS`: build now / build+approve / refine in app /
   * edit plan file / give feedback.
   */
  async function resolvePlanApprove(choice: number): Promise<void> {
    const pa = planApprove;
    setPlanApprove(null);
    setWizardStep('idle');
    if (!pa) return;

    if (choice === 0 || choice === 1) {
      const where = pa.planPath ? ` (saved at ${pa.planPath})` : '';
      const buildPrompt = `Implement the plan we just made${where}. Follow it step by step and make all the changes it describes.`;
      pushUser(buildPrompt);
      // choice 0 → auto-apply; choice 1 → keep the review panel so the
      // user approves edits before they land.
      void dispatch(buildPrompt, 'agent', choice === 0);
      return;
    }

    if (choice === 2) {
      // Refine in app: push the draft to the daemon and open Studio.
      try {
        const daemon = await ensureDaemon({ cwd });
        const res = await fetch(`http://127.0.0.1:${daemon.port}/api/plans/handoff`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd, planId: pa.planId, body: pa.body }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        pushSystem('  pushed plan to the app — opening CodeRouter Studio to refine it', 'success');
        void runAppCommand({ cwd }).catch(() => {});
      } catch (err) {
        pushSystem(`  failed to hand off to app: ${(err as Error).message}`, 'error');
      }
      return;
    }

    if (choice === 3) {
      if (!pa.planPath) {
        pushSystem('  no plan file on disk to edit', 'warn');
        return;
      }
      openPathDetached(pa.planPath);
      pushSystem(`  opening ${pa.planPath}`, 'info');
      return;
    }

    // choice 4: give feedback → switch to plan mode; the prior plan is
    // already in the conversation, so the next message refines it.
    setMode('plan');
    pushSystem("  plan mode — type what you'd like to change and I'll refine the plan", 'info');
  }

  /** Lock the current option and advance (or submit on last / Submit tab). */
  function advancePlanClarify(selectedLabel?: string): void {
    const state = planClarify;
    if (!state) return;
    const questions = state.questions;
    const submitIdx = questions.length; // virtual "Submit" tab
    const onSubmitTab = clarifyQIdx >= submitIdx;

    let answers = { ...state.answers };
    if (!onSubmitTab) {
      const q = questions[clarifyQIdx];
      if (!q) return;
      const label =
        selectedLabel ??
        q.options[clarifyOptIdx]?.label ??
        q.defaultOption ??
        q.options[0]?.label ??
        '';
      answers = { ...answers, [q.id]: label };
      setPlanClarify({ ...state, answers });
    }

    if (!onSubmitTab && clarifyQIdx < questions.length - 1) {
      const next = clarifyQIdx + 1;
      setClarifyQIdx(next);
      setClarifyOptIdx(defaultClarifyOptionIndex(questions[next]!));
      return;
    }

    // Move to Submit tab after last question, or submit from Submit tab.
    if (!onSubmitTab && clarifyQIdx === questions.length - 1) {
      setClarifyQIdx(submitIdx);
      return;
    }

    // Fill any unanswered with defaults, then re-dispatch.
    const filled: PlanClarifyAnswer[] = questions.map((q) => {
      const answer =
        answers[q.id] ??
        q.defaultOption ??
        q.options[0]?.label ??
        '';
      return { questionId: q.id, header: q.header, answer };
    });
    const summary = filled.map((a) => `  • ${a.header}: ${a.answer}`).join('\n');
    pushSystem(`  clarifications:\n${summary}`, 'success');
    const prompt = state.prompt;
    const modeForRun = state.mode;
    setPlanClarify(null);
    setWizardStep('idle');
    void dispatch(prompt, modeForRun, undefined, filled);
  }

  function cancelPlanClarify(): void {
    setPlanClarify(null);
    setWizardStep('idle');
    pushSystem('  clarify cancelled — type a prompt to try again', 'warn');
  }

  function startSetupWizard(): void {
    // Skip the yes/no confirm when the user opts in explicitly via /setup -
    // go straight to the picker.
    setWizardStep('pick');
    setWizardPick(0);
    setWizardKey('');
    setInput('');
    setCursor(0);
  }

  function toggleHostRow(host: DetectedHost): void {
    const next = !host.enabled;
    try {
      setHostEnabled(host.provider, next);
      setSetupState(detectConfiguredProviders());
      pushSystem(
        `  ${host.cli} ${next ? 'enabled' : 'disabled'}${next ? '' : ' (router will skip it)'}`,
        next ? 'success' : 'warn',
      );
    } catch (err) {
      pushSystem(`  failed to toggle ${host.cli}: ${(err as Error).message}`, 'error');
    }
  }

  function removeProviderRow(provider: SetupProvider): void {
    try {
      const { wasInShellEnv } = removeCredential(provider);
      setSetupState(detectConfiguredProviders());
      if (wasInShellEnv) {
        pushSystem(
          `  ${provider.label} key cleared from credentials.json, but $${provider.envVar} is still set by your shell - unset it there to fully remove.`,
          'warn',
        );
      } else {
        pushSystem(`  ${provider.label} key removed`, 'success');
      }
    } catch (err) {
      pushSystem(`  failed to remove ${provider.label} key: ${(err as Error).message}`, 'error');
    }
  }

  function skipSetup(): void {
    setWizardStep('idle');
    setWizardKey('');
    pushSystem(
      '  ok - skipped setup. run /setup any time to configure a provider key.',
      'warn',
    );
  }

  function cancelWizard(): void {
    setWizardStep('idle');
    setWizardKey('');
    pushSystem('  setup cancelled');
  }

  function finishWizard(): void {
    const provider = wizardProvider;
    if (!provider) {
      setWizardStep('idle');
      return;
    }
    try {
      saveCredential(provider, wizardKey);
      setSetupState(detectConfiguredProviders());
      pushSystem(
        `  ${provider.label} key saved (~/.coderouter/credentials.json) and exported as $${provider.envVar}`,
        'success',
      );
    } catch (err) {
      pushSystem(`  failed to save key: ${(err as Error).message}`, 'error');
    }
    // Return to the manager so the user can configure more providers
    // in one /setup session. Esc still closes from there.
    setWizardStep('pick');
    setWizardKey('');
    setWizardProvider(null);
  }

  async function handleSlash(cmd: string, arg: string): Promise<void> {
    switch (cmd) {
      case 'exit':
      case 'quit':
        exit();
        return;
      case 'help':
        pushSystem(renderHelp());
        return;
      case 'clear':
        setHistory([]);
        conversationHistoryRef.current.reset();
        return;
      case 'tui': {
        const want = arg.trim().toLowerCase();
        if (want === 'fullscreen' || want === 'full' || want === 'on') {
          setFullscreen(true);
          pushSystem('  fullscreen renderer on — input pinned at the bottom (/tui classic to revert)', 'success');
        } else if (want === 'classic' || want === 'off') {
          setFullscreen(false);
          pushSystem('  classic renderer on — output flows into terminal scrollback', 'success');
        } else {
          setFullscreen((f) => !f);
          pushSystem('  toggled TUI renderer (usage: /tui fullscreen|classic)', 'info');
        }
        return;
      }
      case 'setup':
        startSetupWizard();
        return;
      case 'effort':
        if (['low', 'medium', 'high', 'max'].includes(arg)) {
          setEffort(arg as Effort);
          pushSystem(`  effort set to ${arg}`);
        } else {
          pushSystem('  usage: /effort low|medium|high|max', 'warn');
        }
        return;
      case 'apply': {
        const next = !apply;
        setApply(next);
        pushSystem(`  apply ${next ? 'on' : 'off'}`);
        return;
      }
      case 'fast': {
        const next = !fast;
        setFast(next);
        pushSystem(`  fast ${next ? 'on' : 'off'}`);
        return;
      }
      case 'route':
        pushSystem('  use `coderouter route <prompt>` from your shell');
        return;
      case 'mcp': {
        const sub = arg.trim().split(/\s+/)[0] || 'list';
        if (sub === 'add-graphify') {
          const cfg = graphifyPreset();
          pushSystem('  probing graphify --mcp…', 'info');
          const probe = await probeMcpServer({ ...cfg, cwd });
          saveMcpServer(cwd, cfg, 'project');
          if (probe.ok) {
            pushSystem(
              `  graphify connected — ${probe.tools?.length ?? 0} tool(s): ${(probe.tools ?? []).join(', ')}. saved to this project.`,
              'success',
            );
          } else {
            pushSystem(
              `  graphify not reachable (${probe.error}). saved anyway; install it (pip install graphifyy) and run \`graphify .\`, then it connects on the next run.`,
              'warn',
            );
          }
          return;
        }
        // default: list configured servers
        const servers = [...listMcpServers(cwd, 'project'), ...listMcpServers(cwd, 'global')];
        if (servers.length === 0) {
          pushSystem('  no MCP servers configured. add graphify with `/mcp add-graphify` (or `coderouter mcp add …`).', 'info');
          return;
        }
        const lines = servers.map((s) => `    • ${s.name}  ${[s.command, ...(s.args ?? [])].join(' ')}${s.enabled === false ? ' [disabled]' : ''}`);
        pushSystem(`  MCP servers (exposed to the agent loop):\n${lines.join('\n')}`, 'info');
        return;
      }
      case 'scan': {
        if (!arg) {
          pushSystem(
            '  usage: /scan <text>  (checks the text for prompt-injection markers)',
            'warn',
          );
          return;
        }
        const result = scanForInjection(arg, { source: 'user-scan' });
        if (result.findings.length === 0) {
          pushSystem('  scan: clean — no injection markers found', 'success');
          return;
        }
        pushFindingsBanner(result.findings);
        const summary = summarizeInjectionScan(result);
        if (summary) pushSystem(`  scan: ${summary}`, 'warn');
        return;
      }
      case 'models': {
        if (!process.env.OPENROUTER_API_KEY) {
          pushSystem(
            '  /models browses the OpenRouter catalog. set OPENROUTER_API_KEY (or run /setup) first.',
            'warn',
          );
          return;
        }
        try {
          const apiKey = process.env.OPENROUTER_API_KEY;
          const search = arg.trim() || undefined;
          const all = await agent.openrouter.listOpenRouterToolCapableModels({
            apiKey,
            search,
          });
          if (all.length === 0) {
            pushSystem(
              search
                ? `  no tool-capable models match '${search}'`
                : '  no tool-capable models found in the OpenRouter catalog',
              'warn',
            );
            return;
          }
          const head = all.slice(0, 30);
          const lines = [
            `  openrouter tool-capable models${search ? ` matching '${search}'` : ''} (showing ${head.length}/${all.length}):`,
          ];
          for (const m of head) {
            const inP = agent.openrouter.pricePer1MIn(m).toFixed(2);
            const outP = agent.openrouter.pricePer1MOut(m).toFixed(2);
            const ctx =
              m.context_length >= 1_000_000
                ? `${(m.context_length / 1_000_000).toFixed(1)}M`
                : `${Math.round(m.context_length / 1000)}k`;
            lines.push(`    ${m.id.padEnd(48)} ${ctx.padEnd(6)} $${inP}/$${outP} per 1M`);
          }
          lines.push(
            `  use any id with: coderouter agent --route openrouter_agent,<model> ...`,
          );
          if (all.length > head.length) {
            lines.push(`  ... +${all.length - head.length} more (refine with /models <search>)`);
          }
          pushSystem(lines.join('\n'));
        } catch (err) {
          pushSystem(
            `  failed to fetch openrouter catalog: ${(err as Error).message}`,
            'warn',
          );
        }
        return;
      }
      case 'dashboard': {
        try {
          if (!dashboardRef.current) {
            dashboardRef.current = await startDashboardServer({ cwd });
          }
          const url = dashboardRef.current.url;
          openBrowser(url);
          pushSystem(`  dashboard running at ${url} (opening in your browser)`, 'success');
        } catch (err) {
          pushSystem(`  failed to start dashboard: ${(err as Error).message}`, 'warn');
        }
        return;
      }
      case 'loop': {
        if (!arg.trim()) {
          pushSystem('  usage: /loop <goal>   e.g. /loop fix the failing auth tests', 'info');
          return;
        }
        pushSystem('  building loop spec…', 'info');
        try {
          const { registry, router } = await buildExecutionEnv(cwd);
          const { spec, discovered, generated } = await generateLoopSpec(
            arg,
            { registry, router, cwd },
            { preset: 'safe' },
          );
          const validation = validateLoopSpec(spec);
          const lines = [
            `  loop: ${spec.name}`,
            `  goal: ${spec.goal}`,
            `  verifier: ${spec.verifier.commands.join(', ') || '(none detected)'}`,
            `  limits: ${spec.limits.maxIterations} iters · $${spec.limits.maxCostUsd} · ${spec.limits.maxFilesChanged} files`,
            `  models: planner=${spec.models.planner} executor=${spec.models.executor} reviewer=${spec.models.reviewer}`,
          ];
          if (!generated) lines.push('  (generated from repo heuristics — no model was available)');
          if (discovered.commands.length === 0)
            lines.push('  ⚠ no verifier commands detected; add one before running');
          pushSystem(lines.join('\n'), validation.valid ? 'success' : 'warn');
          if (!validation.valid) {
            pushSystem(`  not runnable:\n${validation.issues.map((i) => `    - ${i}`).join('\n')}`, 'warn');
          } else {
            pushSystem(
              `  run it: coderouter loop "${arg}" --run   ·   or open the app: /app`,
              'info',
            );
          }
        } catch (err) {
          pushSystem(`  failed to build loop: ${(err as Error).message}`, 'warn');
        }
        return;
      }
      case 'app': {
        try {
          await runAppCommand({ cwd });
          pushSystem('  launching CodeRouter Studio…', 'success');
        } catch (err) {
          pushSystem(`  failed to launch app: ${(err as Error).message}`, 'warn');
        }
        return;
      }
      case 'security': {
        if (arg === 'warn' || arg === 'block') {
          setSecurityPolicy(arg);
          pushSystem(
            arg === 'block'
              ? '  security: high-severity findings will block runs (use /security warn to relax)'
              : '  security: findings are recorded as warnings, runs continue',
            arg === 'block' ? 'success' : 'info',
          );
        } else {
          pushSystem(
            `  prompt-injection policy: ${securityPolicy}.  usage: /security warn|block`,
          );
        }
        return;
      }
      case 'runs': {
        const all = listArtifacts(cwd);
        if (all.length === 0) {
          pushSystem('  no saved runs found in .coderouter/runs/', 'info');
          return;
        }
        const lines = ['  saved runs (newest first):'];
        for (const run of all.slice(0, 20)) {
          const when = new Date(run.completedAt).toLocaleString();
          const stats = `+${run.stats.insertions}/-${run.stats.deletions}`;
          const files = `${run.files.length} file${run.files.length === 1 ? '' : 's'}`;
          lines.push(`    ${run.runId}  ${when}  ${files}  ${stats}`);
        }
        if (all.length > 20) lines.push(`    ... and ${all.length - 20} more`);
        lines.push('  use /accept <runId> to apply or /reject <runId> to discard');
        pushSystem(lines.join('\n'));
        return;
      }
      case 'accept': {
        const run = arg ? findArtifact(cwd, arg) : (listArtifacts(cwd)[0] ?? null);
        if (!run) {
          pushSystem(
            arg
              ? `  no saved run matches '${arg}' - try /runs to see what's available`
              : '  no saved runs to accept - try /runs to see what is available',
            'warn',
          );
          return;
        }
        setReviewRun(run);
        setReviewChoice('approve');
        setWizardStep('review');
        return;
      }
      case 'reject': {
        const run = arg ? findArtifact(cwd, arg) : (listArtifacts(cwd)[0] ?? null);
        if (!run) {
          pushSystem(
            arg
              ? `  no saved run matches '${arg}'`
              : '  no saved runs to reject',
            'warn',
          );
          return;
        }
        setReviewRun(run);
        setReviewChoice('discard');
        setWizardStep('review');
        return;
      }
      case 'trust': {
        if (sessionTrustEdits) {
          pushSystem('  edits already trusted for this session', 'info');
        } else {
          setSessionTrustEdits(true);
          setApply(true);
          pushSystem(
            '  trusted edits for this session - future runs will auto-apply (toggle off with /apply off)',
            'success',
          );
        }
        return;
      }
    }
    if (MODE_COMMANDS.has(cmd)) {
      const nextMode = cmd as Mode;
      setMode(nextMode);
      if ((nextMode === 'masterplan' || nextMode === 'orchestrate') && effort === 'medium')
        setEffort('high');
      if (arg) await dispatch(arg, nextMode);
      else pushSystem(`  mode set to ${nextMode}`);
      return;
    }
    pushSystem(`  unknown command: /${cmd}`, 'warn');
  }

  async function submit(line: string): Promise<void> {
    pushUser(line);
    // Show a dim hint when images are detected in the prompt.
    const detectedImgs = detectPromptImages(line, cwd);
    if (detectedImgs.length > 0) {
      pushSystem(`  attached ${detectedImgs.length} image${detectedImgs.length > 1 ? 's' : ''}`, 'info');
    }
    // Once the user types their next reply, the prior question is
    // resolved (regardless of whether the reply explicitly answered
    // it - the model will see it in the resumed conversation either
    // way). Clear synchronously via the ref so the dispatched
    // `onUserQuestion` for THIS turn (if any) starts from a clean
    // slate, and via setState so the inline hint disappears.
    pendingQuestionRef.current = null;
    setPendingQuestion(null);
    if (line.startsWith('/')) {
      const parts = line.slice(1).split(' ');
      const cmd = parts[0] ?? '';
      const arg = parts.slice(1).join(' ').trim();
      await handleSlash(cmd, arg);
    } else {
      await dispatch(line);
    }
  }

  useInput((char, key) => {
    // Ctrl+C is the only globally-overriding shortcut: aborts any
    // running adapter call and tears the REPL down regardless of
    // mode/wizard state.
    if (key.ctrl && char === 'c') {
      if (busy) abortRef.current?.abort();
      // Release the dashboard port right away. The server is already
      // unref'd so it won't block exit, but closing here frees the port
      // promptly for the next launch.
      const dash = dashboardRef.current;
      if (dash) {
        dashboardRef.current = null;
        void dash.close().catch(() => {});
      }
      exit();
      return;
    }

    // Fullscreen viewport scrollback: PgUp/PgDn page through the
    // transcript; the input keeps focus. Only meaningful in fullscreen
    // (classic uses the terminal's own scrollback).
    if (fullscreen && (key.pageUp || key.pageDown)) {
      const page = Math.max(1, (termSize.rows ?? 40) - 8);
      setScrollUp((s) => Math.max(0, s + (key.pageUp ? page : -page)));
      return;
    }

    // Wizard: directory trust (shown on first launch in a new
    // directory). Yes/Enter grants trust + persists to
    // ~/.coderouter/trust.json; No/Esc/Ctrl+C exits the REPL since
    // we refuse to operate in an untrusted directory.
    if (wizardStep === 'trust') {
      // Arrows + tab toggle the highlighted choice; enter commits it.
      // Single-letter shortcuts (y/n) skip the highlight step and act
      // immediately so power users don't have to navigate.
      if (key.leftArrow || key.upArrow) {
        setTrustChoice('yes');
        return;
      }
      if (key.rightArrow || key.downArrow) {
        setTrustChoice('no');
        return;
      }
      if (key.tab) {
        setTrustChoice((c) => (c === 'yes' ? 'no' : 'yes'));
        return;
      }
      if (char === 'y' || char === 'Y') {
        commitTrust();
        return;
      }
      if (char === 'n' || char === 'N' || key.escape) {
        exit();
        return;
      }
      if (key.return) {
        if (trustChoice === 'yes') commitTrust();
        else exit();
        return;
      }
      return;
    }

    // Wizard: yes/no confirm (shown automatically on first run when no
    // provider key is configured).
    if (wizardStep === 'confirm') {
      if (key.escape) {
        skipSetup();
        return;
      }
      if (key.leftArrow) {
        setConfirmChoice('yes');
        return;
      }
      if (key.rightArrow) {
        setConfirmChoice('no');
        return;
      }
      if (key.tab) {
        setConfirmChoice((c) => (c === 'yes' ? 'no' : 'yes'));
        return;
      }
      if (char === 'y' || char === 'Y') {
        setConfirmChoice('yes');
        setWizardStep('pick');
        setWizardPick(0);
        return;
      }
      if (char === 'n' || char === 'N') {
        setConfirmChoice('no');
        skipSetup();
        return;
      }
      if (key.return) {
        if (confirmChoice === 'yes') {
          setWizardStep('pick');
          setWizardPick(0);
        } else {
          skipSetup();
        }
        return;
      }
      if (key.ctrl && char === 'c') {
        exit();
        return;
      }
      return;
    }

    // Wizard: unified manager. Rows are either a detected host CLI
    // (toggle with space) or an API provider (enter to add/replace
    // key, delete/backspace to remove). Esc closes without a "save"
    // step because every mutation is persisted immediately.
    if (wizardStep === 'pick') {
      if (key.escape) {
        setWizardStep('idle');
        return;
      }
      if (managerRows.length === 0) return;
      if (key.upArrow) {
        setWizardPick((i) => (i - 1 + managerRows.length) % managerRows.length);
        return;
      }
      if (key.downArrow) {
        setWizardPick((i) => (i + 1) % managerRows.length);
        return;
      }
      const row = managerRows[wizardPick];
      if (!row) return;
      if (row.kind === 'host') {
        if (char === ' ' || key.return) {
          toggleHostRow(row.host);
        }
        return;
      }
      // provider row
      if (key.return) {
        setWizardProvider(row.provider);
        setWizardStep('key');
        setWizardKey('');
        return;
      }
      if (key.delete || key.backspace) {
        if (row.hasKey) removeProviderRow(row.provider);
        return;
      }
      if (key.ctrl && char === 'c') {
        setWizardStep('idle');
        return;
      }
      return;
    }

    // Wizard: post-run approve / discard / trust-this-session.
    // Compact three-button panel (no big modal). Single-letter
    // shortcuts (`a`, `d`, `t`) match Cursor's accept-edit pattern.
    if (wizardStep === 'review') {
      if (key.escape) {
        // Esc treats as discard - the safer default so an accidental
        // dismiss never silently lands changes the user didn't see.
        // The patch artifact is already on disk if they change their
        // mind; they can rerun `/accept` to recover.
        resolveReview('discard');
        return;
      }
      if (key.leftArrow) {
        setReviewChoice((c) => (c === 'approve' ? 'trust' : c === 'discard' ? 'approve' : 'discard'));
        return;
      }
      if (key.rightArrow || key.tab) {
        setReviewChoice((c) => (c === 'approve' ? 'discard' : c === 'discard' ? 'trust' : 'approve'));
        return;
      }
      if (char === 'a' || char === 'A' || char === 'y' || char === 'Y') {
        resolveReview('approve');
        return;
      }
      if (char === 'd' || char === 'D' || char === 'n' || char === 'N') {
        resolveReview('discard');
        return;
      }
      if (char === 't' || char === 'T') {
        resolveReview('trust');
        return;
      }
      if (key.return) {
        resolveReview(reviewChoice);
        return;
      }
      return;
    }

    // Wizard: post-plan approval prompt. Vertical list; ↑/↓ to move,
    // 1-5 shortcuts, enter to confirm, esc to dismiss.
    if (wizardStep === 'plan-approve') {
      if (key.escape) {
        setPlanApprove(null);
        setWizardStep('idle');
        return;
      }
      if (key.upArrow) {
        setPlanApproveChoice((c) => (c + PLAN_APPROVE_OPTIONS.length - 1) % PLAN_APPROVE_OPTIONS.length);
        return;
      }
      if (key.downArrow || key.tab) {
        setPlanApproveChoice((c) => (c + 1) % PLAN_APPROVE_OPTIONS.length);
        return;
      }
      if (char && char >= '1' && char <= '5') {
        void resolvePlanApprove(Number(char) - 1);
        return;
      }
      if (key.return) {
        void resolvePlanApprove(planApproveChoice);
        return;
      }
      // Any other printable keystroke means the user would rather type a
      // follow-up than pick from the list (e.g. "tweak phase 2 to ..." or
      // "go ahead and build it"). Dismiss the panel and seed the input so
      // no keystroke is lost; the text then lands as a normal prompt in the
      // current mode, refining the plan in place.
      if (char && !key.ctrl && !key.meta && !key.tab && !key.escape) {
        setPlanApprove(null);
        setWizardStep('idle');
        setInput((prev) => prev + char);
        setCursor((c) => c + char.length);
        return;
      }
      return;
    }

    // Wizard: pre-plan clarifying questions (Claude Code–style).
    // Tabs = questions + Submit; ↑↓ options; Enter selects / advances;
    // Tab cycles tabs; 1-N shortcuts; Esc cancels.
    if (wizardStep === 'plan-clarify') {
      const state = planClarify;
      if (!state) {
        setWizardStep('idle');
        return;
      }
      const questions = state.questions;
      const submitIdx = questions.length;
      const onSubmit = clarifyQIdx >= submitIdx;
      const q = onSubmit ? null : questions[clarifyQIdx];
      const optCount = q?.options.length ?? 0;

      if (key.escape) {
        cancelPlanClarify();
        return;
      }
      if (key.upArrow && q && optCount > 0) {
        setClarifyOptIdx((i) => (i + optCount - 1) % optCount);
        return;
      }
      if (key.downArrow && q && optCount > 0) {
        setClarifyOptIdx((i) => (i + 1) % optCount);
        return;
      }
      if (key.tab && key.shift) {
        const next = (clarifyQIdx + submitIdx) % (submitIdx + 1);
        setClarifyQIdx(next);
        if (next < questions.length) {
          setClarifyOptIdx(defaultClarifyOptionIndex(questions[next]!));
        }
        return;
      }
      if (key.tab) {
        const next = (clarifyQIdx + 1) % (submitIdx + 1);
        setClarifyQIdx(next);
        if (next < questions.length) {
          setClarifyOptIdx(defaultClarifyOptionIndex(questions[next]!));
        }
        return;
      }
      if (q && char && char >= '1' && char <= String(optCount)) {
        const idx = Number(char) - 1;
        const label = q.options[idx]?.label;
        if (label) {
          setClarifyOptIdx(idx);
          advancePlanClarify(label);
        }
        return;
      }
      if (key.return) {
        advancePlanClarify();
        return;
      }
      return;
    }

    // Wizard: api key entry (masked)
    if (wizardStep === 'key') {
      if (key.escape) {
        // Back out to the manager rather than fully cancelling, so the
        // user can pick a different provider without re-running /setup.
        setWizardStep('pick');
        setWizardKey('');
        setWizardProvider(null);
        return;
      }
      if (key.return) {
        if (wizardKey.trim().length < 8) {
          pushSystem('  key looks too short - try again or press esc to cancel', 'warn');
          return;
        }
        finishWizard();
        return;
      }
      if (key.backspace || key.delete) {
        setWizardKey((s) => s.slice(0, -1));
        return;
      }
      if (key.ctrl && char === 'u') {
        setWizardKey('');
        return;
      }
      if (key.ctrl && char === 'c') {
        cancelWizard();
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        setWizardKey((s) => s + char);
      }
      return;
    }

    // Normal command/prompt input. Enter submits when idle; while busy
    // it queues the prompt to fire after the in-flight run finishes
    // (so the chatbox below the streaming output reads like a real
    // follow-up entry, not a dead element). The queued prompt is
    // mirrored into state so a visible chip renders right above the
    // chatbox - the previous "queued: ..." system message kept
    // getting pushed out of view during long runs and made it feel
    // like the keystroke vanished.
    // When the `@`-mention picker is open, Enter inserts the selected
    // file (like Claude) instead of submitting the prompt.
    if (key.return && showMentions) {
      completeMention();
      return;
    }

    if (key.return) {
      const line = input.trim();
      if (!line) return;
      setInput('');
      setCursor(0);
      if (busy) {
        queuedRef.current = line;
        setQueuedPrompt(line);
      } else {
        void submit(line);
      }
      return;
    }

    if (!busy && showMentions && (key.upArrow || key.downArrow)) {
      const max = mentionSuggestions.length;
      if (max === 0) return;
      setSuggIdx((i) => (key.upArrow ? (i - 1 + max) % max : (i + 1) % max));
      return;
    }

    if (!busy && showSuggestions && (key.upArrow || key.downArrow)) {
      const max = suggestions.length;
      if (max === 0) return;
      setSuggIdx((i) => (key.upArrow ? (i - 1 + max) % max : (i + 1) % max));
      return;
    }

    if (!busy && key.tab) {
      if (showMentions && mentionSuggestions.length > 0) {
        completeMention();
        return;
      }
      if (showSuggestions && suggestions.length > 0) {
        const sel = suggestions[suggIdx];
        if (sel) {
          const next = `/${sel.name}${sel.hint ? ' ' : ''}`;
          setInput(next);
          setCursor(next.length);
        }
      }
      return;
    }

    // Escape semantics, in priority order:
    //   1. If there's a queued prompt waiting, ESC clears the queue
    //      first - that way the user can cancel a typo/mistake
    //      without also killing the run that's currently producing
    //      useful work.
    //   2. Otherwise during a busy run ESC aborts the in-flight
    //      subprocess (SIGTERM, escalated to SIGKILL after 2s).
    //   3. Idle ESC clears the input buffer.
    if (key.escape) {
      if (queuedRef.current !== null) {
        queuedRef.current = null;
        setQueuedPrompt(null);
        return;
      }
      if (busy) {
        // Flip the UI to "aborting…" right away so the user sees
        // their keystroke land. Actual subprocess exit is async -
        // SIGTERM then SIGKILL after 2s grace - so without this
        // feedback ESC felt like a no-op for several seconds.
        setAborting(true);
        abortRef.current?.abort();
      } else {
        setInput('');
        setCursor(0);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (cursor > 0) {
        setInput(input.slice(0, cursor - 1) + input.slice(cursor));
        setCursor(cursor - 1);
      }
      return;
    }

    if (key.leftArrow) {
      setCursor(Math.max(0, cursor - 1));
      return;
    }
    if (key.rightArrow) {
      setCursor(Math.min(input.length, cursor + 1));
      return;
    }

    if (key.ctrl && char === 'u') {
      setInput('');
      setCursor(0);
      return;
    }
    if (key.ctrl && char === 'a') {
      setCursor(0);
      return;
    }
    if (key.ctrl && char === 'e') {
      setCursor(input.length);
      return;
    }
    if (key.ctrl && char === 'c') {
      exit();
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      // Insert character(s) at the cursor. Ink may batch multi-byte input
      // into a single `char` payload, so handle length > 1 as well.
      setInput(input.slice(0, cursor) + char + input.slice(cursor));
      setCursor(cursor + char.length);
    }
  });

  // Bottom-pin the chatbox (Claude-style): estimate how much vertical
  // space the committed transcript + any in-flight thread already use,
  // then insert a filler that pushes the footer to the terminal floor.
  // When content overflows the screen the filler collapses to 0 and the
  // transcript scrolls naturally into terminal scrollback via <Static>.
  const termRows = process.stdout.rows ?? 40;
  const termCols = process.stdout.columns ?? 80;
  const committedLines = history.reduce(
    (n, it) => n + estimateHistoryItemLines(it, termCols) + 1,
    0,
  );
  const liveThreadLines = busy
    ? liveLog.reduce((n, e) => n + estimateLogEntryLines(e) + 1, 0) + 3
    : 0;
  // chatbox (3) + status row (2) + breathing room.
  const footerLines = 6;
  // Lines printed ABOVE Ink's frame that we can't measure (the shell
  // prompt that launched `cr`, any stray stdout). Bias the filler LOW by
  // reserving for these so we never overflow and clip the wordmark - a
  // small gap under the input is fine, a cropped title is not.
  const preFrameReserve = 4;
  const bottomFiller = Math.max(
    0,
    termRows - committedLines - liveThreadLines - footerLines - preFrameReserve,
  );

  // The live in-flight thread (streamed text/tools + spinner). Shared
  // between both renderers.
  const liveThread = (
    <>
      {busy && liveLog.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <LogStream entries={liveLog} />
        </Box>
      )}
      {busy && (
        <Box flexDirection="column" marginBottom={1}>
          <ProgressLine
            phase={aborting ? 'aborting…' : phase}
            routeLabel={formatRouteLabel(currentRoute) ?? undefined}
            usage={runningUsage}
            aborting={aborting}
          />
          <Box paddingX={1}>
            <Text color="gray" dimColor>
              {aborting ? 'sending SIGTERM, force-kill in 2s' : 'esc to interrupt'}
            </Text>
          </Box>
        </Box>
      )}
    </>
  );

  // Wizards + chatbox + status row. Shared footer for both renderers;
  // in fullscreen it lives in the reserved bottom rows.
  const footer = (
    <>
      {wizardStep === 'trust' && <TrustPanel cwd={cwd} choice={trustChoice} />}
      {wizardStep === 'confirm' && <WizardConfirmPanel choice={confirmChoice} />}
      {wizardStep === 'pick' && (
        <SetupManagerPanel rows={managerRows} selectedIdx={wizardPick} />
      )}
      {wizardStep === 'key' && wizardProvider && (
        <WizardKeyPanel provider={wizardProvider} maskedKey={mask(wizardKey)} />
      )}
      {wizardStep === 'review' && reviewRun && (
        <ApprovePromptPanel run={reviewRun} choice={reviewChoice} />
      )}
      {wizardStep === 'plan-approve' && planApprove && (
        <PlanApprovePanel state={planApprove} choice={planApproveChoice} />
      )}
      {wizardStep === 'plan-clarify' && planClarify && (
        <PlanClarifyPanel
          state={planClarify}
          questionIndex={clarifyQIdx}
          optionIndex={clarifyOptIdx}
        />
      )}

      {showSuggestions && !busy && suggestions.length > 0 && (
        <SuggestionsList items={suggestions} selectedIdx={suggIdx} />
      )}

      {showMentions && (
        <MentionsList items={mentionSuggestions} selectedIdx={suggIdx} />
      )}

      {/* Chatbox is last so it stays under the thread; wizards hide it. */}
      {wizardStep === 'idle' && (
        <>
          {!setupState.configured && !busy && <NoProviderReminder />}
          {pendingQuestion && !busy && (
            <Box paddingX={1}>
              <Text color="yellow" bold>{'? answering: '}</Text>
              <Text>{truncateOneLine(pendingQuestion.questions[0]?.question ?? '', 80)}</Text>
            </Box>
          )}
          {queuedPrompt && (
            <Box paddingX={1}>
              <Text color="cyan" bold>{'↑ queued '}</Text>
              <Text>{truncateOneLine(queuedPrompt, 80)}</Text>
              <Text color="gray" dimColor>{'   esc to clear'}</Text>
            </Box>
          )}
          <InputBox
            value={input}
            cursor={cursor}
            busy={busy}
            configured={setupState.configured}
          />
          {!busy && (
            <Box marginTop={1} paddingX={1} flexDirection="column">
              <StatusRow
                mode={mode}
                effort={effort}
                apply={apply}
                fast={fast}
                security={securityPolicy}
                apiKeys={setupState.apiKeys}
                hosts={setupState.hosts}
                fullscreen={fullscreen}
              />
              {(sessionUsage.tokensIn > 0 || sessionUsage.tokensOut > 0) && (
                <Text color="gray">{`session ${formatUsage(sessionUsage)}`}</Text>
              )}
            </Box>
          )}
        </>
      )}
    </>
  );

  // Fullscreen renderer: alt-screen grid. The transcript is an
  // app-owned viewport pinned to the bottom (justifyContent=flex-end +
  // overflow hidden), so new output fills upward and the footer never
  // moves. No <Static> here - we own the whole surface.
  if (fullscreen) {
    // Estimate content vs. viewport height to clamp scroll-up so we
    // never scroll past the top (which would show a blank viewport).
    const fsContentLines =
      history.reduce((n, it) => n + estimateHistoryItemLines(it, termSize.cols) + 1, 0) +
      liveThreadLines;
    const fsFooterLines = wizardStep === 'idle' ? 6 : 12;
    const fsViewportH = Math.max(3, termSize.rows - fsFooterLines);
    const fsMaxScroll = Math.max(0, fsContentLines - fsViewportH);
    const fsScroll = Math.min(scrollUp, fsMaxScroll);
    return (
      <Box flexDirection="column" width={termSize.cols} height={termSize.rows}>
        <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" overflow="hidden">
          {/* marginBottom pushes content up by `fsScroll` lines inside the
              bottom-anchored, clipped viewport — that's how scroll-up works
              without needing exact measurement. */}
          <Box flexDirection="column" marginBottom={fsScroll}>
            {history.map((item) => (
              <Box key={item.id} flexDirection="column" marginBottom={1}>
                <HistoryItemBody item={item} setupState={setupState} mode={mode} />
              </Box>
            ))}
            {liveThread}
          </Box>
        </Box>
        <Box flexDirection="column" flexShrink={0}>
          {fsScroll > 0 && (
            <Text color="magenta" dimColor>
              {`  ↑ scrolled up ${fsScroll} line${fsScroll === 1 ? '' : 's'} · PgDn to catch up`}
            </Text>
          )}
          {footer}
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Static items={history}>
        {(item) => (
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <HistoryItemBody item={item} setupState={setupState} mode={mode} />
          </Box>
        )}
      </Static>

      {/* Filler pushes everything below to the terminal floor so the
          chatbox reads as pinned. Collapses to 0 once real content
          fills the screen (then <Static> handles scrollback). Do NOT
          swap this for height=rows / flexGrow — Ink + <Static> renders
          that as a full-viewport frame and leaves a hollow split. */}
      {bottomFiller > 0 && <Box height={bottomFiller} flexShrink={0} />}

      {liveThread}
      {footer}
    </Box>
  );
}

/**
 * Renders the body of one transcript item. Shared by the classic
 * (<Static>) renderer and the fullscreen viewport so both stay in sync.
 */
function HistoryItemBody({
  item,
  setupState,
  mode,
}: {
  item: HistoryItem;
  setupState: ReturnType<typeof detectConfiguredProviders>;
  mode: Mode;
}): React.ReactElement | null {
  switch (item.kind) {
    case 'welcome':
      return (
        <Box flexDirection="column">
          <WordmarkPanel />
          {!setupState.configured && setupState.hosts.length > 0 && (
            <DetectedHostsPanel hosts={setupState.hosts} />
          )}
          <TipsPanel mode={mode} />
        </Box>
      );
    case 'user':
      return (
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text>
            <Text color="green" bold>{'▸ '}</Text>
            <Text bold>{item.text}</Text>
          </Text>
        </Box>
      );
    case 'system':
      return (
        <Text
          color={
            item.tone === 'error' ? 'red'
              : item.tone === 'warn' ? 'yellow'
                : item.tone === 'success' ? 'green'
                  : 'gray'
          }
        >
          {item.text}
        </Text>
      );
    case 'log':
      return <LogStream entries={item.entries} frozen />;
    case 'changes':
      return <ChangesPanel stats={item.stats} />;
    case 'question':
      return <QuestionPanel payload={item.payload} />;
    case 'open-questions':
      return <OpenQuestionsPanel questions={item.questions} />;
    case 'report':
      return (
        <Box flexDirection="column">
          {item.text.split('\n').map((l, i) => (
            <Text key={`${item.id}-${i}`}>{colorizeReportLine(l)}</Text>
          ))}
        </Box>
      );
    default:
      return null;
  }
}

/**
 * Unified live log rendered as a sequence of self-contained blocks
 * separated by a single blank line, mirroring how Codex renders
 * the agent's narration in its own UI.
 *
 * Each entry kind becomes one block:
 *   - `text`      a markdown-rendered paragraph (or many) of model
 *                 narration. No leading glyph - the surrounding
 *                 margin is enough separation since adjacent tool
 *                 blocks all start with `›`/`✓`/`✗`.
 *   - `tool`      a header line ("`› Ran git status`") + an
 *                 optional indented body showing the captured
 *                 output. Status of the leading glyph encodes
 *                 progress: `›` pending, `✓` ok, `✗` error.
 *   - `thinking`  a single dim-italic line ("`… <summary>`").
 *
 * `frozen` slightly tones down dynamic colors when the block is
 * being committed to scrollback (vs. the live in-flight feed), so
 * the user's eye gravitates to the active run rather than older
 * blocks above it.
 */
function LogStream({
  entries,
  frozen,
}: {
  entries: LogEntry[];
  frozen?: boolean;
}): React.ReactElement {
  return (
    <Box flexDirection="column">
      {entries.map((entry, idx) => (
        <Box
          key={entry.id}
          flexDirection="column"
          marginTop={idx === 0 ? 0 : 1}
        >
          {entry.kind === 'text' && (
            <Box flexDirection="column">
              {entry.routeLabel && (
                <Box justifyContent="flex-end">
                  <Text color="gray" dimColor>{entry.routeLabel}</Text>
                </Box>
              )}
              <MarkdownBlock text={entry.text} />
            </Box>
          )}
          {entry.kind === 'thinking' && (
            <Text color="gray" italic dimColor={frozen}>
              {`  … ${entry.text}`}
            </Text>
          )}
          {entry.kind === 'tool' && <ToolBlock entry={entry} frozen={frozen} />}
        </Box>
      ))}
    </Box>
  );
}

/**
 * Maximum body lines we render inline per tool block. Anything
 * beyond gets truncated with a `...and N more lines` footer; the
 * full output is still on disk in the run artifact for any
 * post-mortem the user wants.
 */
const MAX_BODY_LINES = 12;

/**
 * Approximate line count for a single log entry. Used by
 * `flushLiveOverflowToHistory` to decide when the dynamic area is
 * about to overflow the viewport. Doesn't try to be exact - the
 * caller leaves a generous margin to absorb wrapping.
 */
function estimateLogEntryLines(e: LogEntry): number {
  if (e.kind === 'text') {
    const lines = e.text.split('\n').length;
    return lines + (e.routeLabel ? 1 : 0);
  }
  if (e.kind === 'tool') {
    const bodyLines = e.body ? e.body.split('\n').length : 0;
    return 2 + Math.min(bodyLines, MAX_BODY_LINES);
  }
  return 1;
}

/**
 * Rough rendered-height estimate for one committed history item.
 * Used only to compute the bottom-filler that pins the chatbox to the
 * terminal floor - it doesn't need to be exact (a line or two off just
 * nudges the input slightly), so we stay conservative and cheap.
 */
function estimateHistoryItemLines(item: HistoryItem, width: number): number {
  switch (item.kind) {
    case 'welcome': {
      const wordmark = width >= 102 ? WORDMARK_PIXEL : WORDMARK_SMALL;
      // wordmark + margins/tagline (~4) + tips box (~13, incl. border,
      // padding, and the optional detected-hosts panel).
      return wordmark.split('\n').length + 4 + 13;
    }
    case 'user':
      return item.text.split('\n').length + 2;
    case 'system':
      return item.text.split('\n').length;
    case 'report':
      return item.text.split('\n').length;
    case 'log':
      return item.entries.reduce((n, e) => n + estimateLogEntryLines(e) + 1, 0);
    case 'changes':
      return item.stats.length + 2;
    case 'question':
      return 6;
    case 'open-questions':
      return item.questions.length + 3;
    default:
      return 1;
  }
}

function ToolBlock({
  entry,
  frozen,
}: {
  entry: Extract<LogEntry, { kind: 'tool' }>;
  frozen?: boolean;
}): React.ReactElement {
  const pending = entry.ok === undefined;
  const glyph = pending ? '›' : entry.ok ? '›' : '✗';
  // Use cyan for in-flight (catch the eye), default for completed
  // ok blocks (so they recede into the log), red for failures.
  const glyphColor = pending ? 'cyan' : entry.ok ? 'gray' : 'red';
  const headerColor = entry.ok === false ? 'red' : undefined;
  return (
    <Box flexDirection="column">
      <Box justifyContent="space-between">
        <Text dimColor={frozen}>
          <Text color={glyphColor} bold>{`${glyph} `}</Text>
          <Text bold color={headerColor}>{entry.description}</Text>
        </Text>
        {entry.routeLabel && (
          <Text color="gray" dimColor>{entry.routeLabel}</Text>
        )}
      </Box>
      {entry.body && entry.body.trim().length > 0 && (
        <ToolBlockBody body={entry.body} ok={entry.ok !== false} />
      )}
    </Box>
  );
}

function ToolBlockBody({
  body,
  ok,
}: {
  body: string;
  ok: boolean;
}): React.ReactElement {
  // Strip ANSI escape sequences so styled bash output (colors etc.)
  // doesn't double-render through Ink's own pipeline. Cheap regex
  // covers the common CSI sequences models actually emit.
  const stripped = body.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
  const lines = stripped.split('\n');
  const shown = lines.slice(0, MAX_BODY_LINES);
  const truncated = lines.length - shown.length;
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Text key={i} color={ok ? 'gray' : 'red'}>
          {`  ${line}`}
        </Text>
      ))}
      {truncated > 0 && (
        <Text color="gray" dimColor>
          {`  ... and ${truncated} more line${truncated === 1 ? '' : 's'}`}
        </Text>
      )}
    </Box>
  );
}

/**
 * Compact per-file change summary. Replaces the old "render the
 * entire raw patch" review panel with a tabular view: one line per
 * file, path on the left, green +N and red -M counts on the right,
 * binary patches flagged inline. Lives in scrollback so the user
 * can scroll up and see what each run touched without re-running
 * `/runs`.
 */
function ChangesPanel({ stats }: { stats: FileStats[] }): React.ReactElement {
  const widest = Math.max(...stats.map((s) => s.file.length), 12);
  const total = stats.reduce(
    (acc, s) => ({
      ins: acc.ins + s.insertions,
      del: acc.del + s.deletions,
    }),
    { ins: 0, del: 0 },
  );
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>
        {`changes (${stats.length} file${stats.length === 1 ? '' : 's'})`}
      </Text>
      {stats.map((s) => (
        <Text key={s.file}>
          {'  '}
          <Text>{s.file.padEnd(widest)}</Text>
          {'  '}
          {s.binary ? (
            <Text color="gray">binary</Text>
          ) : (
            <>
              <Text color="green">{`+${s.insertions}`}</Text>
              {'  '}
              <Text color="red">{`-${s.deletions}`}</Text>
            </>
          )}
        </Text>
      ))}
      {stats.length > 1 && (
        <Text color="gray">
          {`  total  `}
          <Text color="green">{`+${total.ins}`}</Text>
          {`  `}
          <Text color="red">{`-${total.del}`}</Text>
        </Text>
      )}
    </Box>
  );
}

/**
 * Renders a paused-on-question panel. When Claude Code fires its
 * `AskUserQuestion` tool, the headless `claude -p` subprocess can't
 * accept the answer back over its own channel, so we abort the run
 * and surface the question here instead. The user's next prompt is
 * dispatched as the answer (with `--resume <session_id>` so Claude
 * sees it in context). Numbered options are listed for readability,
 * but the user is free to type a free-form reply too.
 */
function QuestionPanel({
  payload,
}: {
  payload: AskUserQuestionPayload;
}): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {payload.questions.length === 1
          ? 'the agent has a question:'
          : `the agent has ${payload.questions.length} questions:`}
      </Text>
      {payload.questions.map((q, qi) => (
        <Box key={`q-${qi}`} flexDirection="column" marginTop={qi > 0 ? 1 : 0}>
          <Text bold>
            {payload.questions.length > 1 ? `Q${qi + 1}. ` : ''}
            {q.question}
          </Text>
          {q.options && q.options.length > 0 && (
            <Box flexDirection="column" paddingLeft={2}>
              {q.options.map((opt, oi) => (
                <Text key={`o-${qi}-${oi}`}>
                  <Text color="cyan">{`${oi + 1}. `}</Text>
                  <Text bold>{opt.label}</Text>
                  {opt.description ? (
                    <Text color="gray">{`  — ${opt.description}`}</Text>
                  ) : null}
                </Text>
              ))}
            </Box>
          )}
          {q.multiSelect && (
            <Text color="gray" italic>
              {'  (select one or more)'}
            </Text>
          )}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray">
          {'reply with your answer; the conversation will resume with full context'}
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Highlighted callout for the open questions a plan flagged. Rendered as a
 * bordered box so the decisions the plan couldn't make on its own stand out
 * from the streamed plan body and the user knows to confirm them before
 * executing.
 */
function OpenQuestionsPanel({ questions }: { questions: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>
        {questions.length === 1 ? 'open question — confirm before executing:' : `open questions (${questions.length}) — confirm before executing:`}
      </Text>
      {questions.map((q, qi) => (
        <Text key={`oq-${qi}`}>
          <Text color="yellow" bold>{'  ? '}</Text>
          <Text>{q}</Text>
        </Text>
      ))}
    </Box>
  );
}

/**
 * Compact post-run approve panel. Three inline buttons; the
 * selected one is highlighted. Replaces the giant raw-diff modal
 * the previous version used so users can't fall into "just smash
 * accept" autopilot. The "trust" choice flips session-wide auto-
 * apply, mirroring how Claude Code / Cursor stop prompting once a
 * user has signed off on the agent.
 */
function ApprovePromptPanel({
  run,
  choice,
}: {
  run: RecordedRun;
  choice: 'approve' | 'discard' | 'trust';
}): React.ReactElement {
  const filesLine = `${run.files.length} file${run.files.length === 1 ? '' : 's'}`;
  const stats = `+${run.stats.insertions} / -${run.stats.deletions}`;
  return (
    <Box
      borderStyle="round"
      borderColor="green"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color="green">{`apply changes? (${filesLine}, ${stats})`}</Text>
      <Box marginTop={1}>
        <ApproveButton label="approve" selected={choice === 'approve'} />
        <Text>  </Text>
        <ApproveButton label="discard" selected={choice === 'discard'} />
        <Text>  </Text>
        <ApproveButton label="trust this session" selected={choice === 'trust'} />
      </Box>
      <Text color="gray">
        ← → to choose · enter to confirm · a / d / t for shortcuts · esc discards
      </Text>
    </Box>
  );
}

function ApproveButton({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}): React.ReactElement {
  if (selected) {
    return (
      <Text backgroundColor="green" color="black" bold>
        {`  ${label}  `}
      </Text>
    );
  }
  return <Text color="gray">{`  ${label}  `}</Text>;
}

/**
 * Post-plan approval prompt, Claude-Code style. After a plan/masterplan
 * run the user chooses what happens next: build it (auto-apply or with a
 * review pass), refine it in the desktop app, edit the plan file, or give
 * feedback to refine it in place.
 */
function PlanApprovePanel({
  state,
  choice,
}: {
  state: PlanApproveState;
  choice: number;
}): React.ReactElement {
  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} marginBottom={1} flexDirection="column">
      <Text bold color="cyan">{`${state.mode === 'masterplan' ? 'masterplan' : 'plan'} ready — what next?`}</Text>
      <Box marginTop={1} flexDirection="column">
        {PLAN_APPROVE_OPTIONS.map((label, i) => {
          const selected = i === choice;
          return (
            <Text key={label} color={selected ? 'cyan' : 'gray'} bold={selected}>
              {selected ? '❯ ' : '  '}
              {`${i + 1}. ${label}`}
            </Text>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">↑ ↓ to choose · 1-5 shortcuts · enter to confirm · type to refine · esc to dismiss</Text>
      </Box>
    </Box>
  );
}

/**
 * Claude Code–style plan clarifying questions: horizontal tabs for
 * each question (+ Submit), numbered options with descriptions.
 */
function PlanClarifyPanel({
  state,
  questionIndex,
  optionIndex,
}: {
  state: PlanClarifyState;
  questionIndex: number;
  optionIndex: number;
}): React.ReactElement {
  const questions = state.questions;
  const submitIdx = questions.length;
  const onSubmit = questionIndex >= submitIdx;
  const q = onSubmit ? null : questions[questionIndex];

  return (
    <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1} marginBottom={1} flexDirection="column">
      {/* Tab bar: active tab is an inverse pill, answered ones are
          checked, and "Submit →" trails at the end - mirrors Claude. */}
      <Box>
        {questions.map((qq, i) => {
          const active = i === questionIndex;
          const answered = Boolean(state.answers[qq.id]);
          const label = answered ? `✓ ${qq.header}` : qq.header;
          return (
            <Box key={qq.id} marginRight={2}>
              {active ? (
                <Text backgroundColor="cyan" color="black" bold>{` ${label} `}</Text>
              ) : (
                <Text color={answered ? 'green' : 'gray'}>{` ${label} `}</Text>
              )}
            </Box>
          );
        })}
        {onSubmit ? (
          <Text backgroundColor="cyan" color="black" bold>{' Submit → '}</Text>
        ) : (
          <Text color="gray">{' Submit → '}</Text>
        )}
      </Box>

      {q && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>{q.question}</Text>
          <Box marginTop={1} flexDirection="column">
            {q.options.map((opt, i) => {
              const selected = i === optionIndex;
              return (
                <Box key={opt.label} flexDirection="column">
                  <Text color={selected ? 'cyan' : 'white'} bold={selected}>
                    {selected ? '❯ ' : '  '}
                    {`${i + 1}. ${opt.label}`}
                  </Text>
                  {opt.description && (
                    <Text color="gray" dimColor>{`     ${opt.description}`}</Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      )}

      {onSubmit && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Ready to draft the plan with:</Text>
          {questions.map((qq) => (
            <Text key={qq.id} color="gray">
              {`  • ${qq.header}: ${state.answers[qq.id] ?? qq.defaultOption ?? qq.options[0]?.label ?? '…'}`}
            </Text>
          ))}
          <Box marginTop={1}>
            <Text color="cyan" bold>❯ Enter to build the plan</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Enter to select · Tab / arrows to navigate · Esc to cancel
        </Text>
      </Box>
    </Box>
  );
}

/**
 * Directory-trust prompt shown on first launch in a workspace the
 * user hasn't explicitly opted into. Mirrors Cursor/Claude Code's
 * "Do you trust this folder?" dialog but rendered as a plain inline
 * paragraph rather than a bordered modal - the surrounding REPL
 * already has too many boxes and the ergonomics are the same: y
 * grants and persists, n / esc quits.
 */
function TrustPanel({
  cwd,
  choice,
}: {
  cwd: string;
  choice: 'yes' | 'no';
}): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Text bold color="yellow">{'!  Trust this directory?'}</Text>
      <Text>{`   ${cwd}`}</Text>
      <Text color="gray">
        {'   CodeRouter will read files here and (when you approve) run agents that edit them.'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Box>
          <Text>   </Text>
          <ConfirmButton label="Yes, trust" selected={choice === 'yes'} />
        </Box>
        <Box marginTop={1}>
          <Text>   </Text>
          <ConfirmButton label="No, quit " selected={choice === 'no'} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          ↑ ↓ to choose · enter to confirm · y / n for shortcut · esc to quit
        </Text>
      </Box>
    </Box>
  );
}

function WordmarkPanel(): React.ReactElement {
  const width = process.stdout.columns ?? 80;
  // Pixel-block wordmark needs ~96 cols once you account for the Box's
  // border + padding; fall back to the compact ANSI wordmark below that.
  const wordmark = width >= 102 ? WORDMARK_PIXEL : WORDMARK_SMALL;
  const wordmarkLines = wordmark.split('\n');
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {wordmarkLines.map((line, i) => (
        <Text key={`wm-${i}`} color="green" bold>
          {line}
        </Text>
      ))}
      <Box marginTop={1}>
        <Text color="green">
          {'  '}{BRAND_GLYPH}{'  '}
        </Text>
        <Text color="gray">{WORDMARK_TAGLINE}</Text>
        <Text color="gray">{`   ${BRAND_NAME} v${CLI_VERSION}`}</Text>
      </Box>
    </Box>
  );
}

function TipsPanel({ mode }: { mode: Mode }): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Box flexDirection="column">
        <Text bold>Tips for getting started</Text>
        <Text>
          <Text color="gray">{'  Type '}</Text>
          <Text bold color="green">/</Text>
          <Text color="gray">{' to browse all commands'}</Text>
        </Text>
        <Text>
          <Text color="gray">{'  Type '}</Text>
          <Text bold color="green">/help</Text>
          <Text color="gray">{' for the full reference'}</Text>
        </Text>
        <Text>
          <Text color="gray">{'  Plain text runs in the current mode ('}</Text>
          <Text bold>{mode}</Text>
          <Text color="gray">{')'}</Text>
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text bold>Modes</Text>
        <Text color="gray">  /plan · /masterplan · /agent · /debug · /review</Text>
      </Box>
    </Box>
  );
}

function DetectedHostsPanel({ hosts }: { hosts: DetectedHost[] }): React.ReactElement | null {
  // Blue-bordered callout (distinct from the green wordmark / yellow
  // warnings) shown above the tips when at least one local CLI is on
  // PATH. Lead copy is in the *active* voice so the user immediately
  // understands these CLIs are already being used as primary routes -
  // they're not a passive "detected" notice.
  //
  // Each row is a single <Text> so Ink can wrap it as one block; an
  // earlier version used sibling <Text> elements which made ink wrap
  // mid-word ("/setu" + "p", "API" / "keys" on different lines).
  //
  // Disabled hosts (toggled off via /hosts) are still detected but
  // shown with a dim "skipped" marker so the user can see *why* their
  // local CLI isn't being used.
  const enabled = hosts.filter((h) => h.enabled);
  const disabled = hosts.filter((h) => !h.enabled);
  if (enabled.length === 0 && disabled.length === 0) return null;
  const headline = enabled.length > 0
    ? 'Using your local CLIs to route — no API keys needed'
    : 'All local CLIs are disabled — routing will use cloud APIs only';
  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      paddingX={2}
      paddingY={0}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color="blue">{headline}</Text>
      {enabled.map((h) => (
        <Text key={h.provider}>
          <Text color="blue" bold>{'  ✓ '}</Text>
          <Text bold>{h.cli}</Text>
          <Text color="gray">{`  —  ${h.label} · ${h.blurb}`}</Text>
        </Text>
      ))}
      {disabled.map((h) => (
        <Text key={h.provider} color="gray" dimColor>
          {`  · ${h.cli}  —  ${h.label} (disabled)`}
        </Text>
      ))}
      <Text color="gray">
        {'  '}
        <Text bold color="blue">/setup</Text>
        {' to toggle CLIs or add cloud API keys'}
      </Text>
    </Box>
  );
}

function SetupManagerPanel({
  rows,
  selectedIdx,
}: {
  rows: ManagerRow[];
  selectedIdx: number;
}): React.ReactElement {
  // One unified panel for both kinds of routing source. The split is
  // visual only (a "Local CLIs" subheader above the host rows and a
  // "Cloud API providers" subheader above the provider rows) - the
  // underlying selection cursor walks the flat list so up/down feels
  // like a single coherent menu.
  const hostRows = rows.filter((r): r is Extract<ManagerRow, { kind: 'host' }> => r.kind === 'host');
  const providerRows = rows.filter(
    (r): r is Extract<ManagerRow, { kind: 'provider' }> => r.kind === 'provider' && r.group === 'cloud',
  );
  const searchRows = rows.filter(
    (r): r is Extract<ManagerRow, { kind: 'provider' }> => r.kind === 'provider' && r.group === 'search',
  );
  const selectedRow = rows[selectedIdx];

  // Column widths chosen to keep names + labels aligned across both
  // sections (longest cli is 'claude' = 6; longest provider is
  // 'openrouter' = 10).
  const nameWidth = 11;

  const hintForSelection = (): string => {
    if (!selectedRow) return '';
    if (selectedRow.kind === 'host') {
      return selectedRow.host.enabled
        ? 'space to disable this CLI'
        : 'space to re-enable this CLI';
    }
    return selectedRow.hasKey
      ? 'enter to replace key · del to remove'
      : 'enter to add API key';
  };

  return (
    <Box
      borderStyle="round"
      borderColor="blue"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color="blue">Manage routing sources</Text>
      <Text color="gray">
        {'  Toggle local CLIs, add cloud API keys, and set optional web-search keys.'}
      </Text>

      {hostRows.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="gray">{'  LOCAL CLIs'}</Text>
          {hostRows.map((row) => {
            const flatIdx = rows.indexOf(row);
            const isSel = flatIdx === selectedIdx;
            const box = row.host.enabled ? '[x]' : '[ ]';
            return (
              <Text key={`h-${row.host.provider}`} color={isSel ? 'blue' : undefined} bold={isSel}>
                {isSel ? '  ▸ ' : '    '}
                <Text color={row.host.enabled ? 'green' : 'gray'}>{box}</Text>
                {'  '}
                <Text bold={row.host.enabled} dimColor={!row.host.enabled}>
                  {row.host.cli.padEnd(nameWidth)}
                </Text>
                <Text color="gray">{row.host.label}</Text>
                {!row.host.enabled && <Text color="gray" dimColor>{'  (disabled)'}</Text>}
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text bold color="gray">{'  CLOUD API PROVIDERS'}</Text>
        {providerRows.map((row) => {
          const flatIdx = rows.indexOf(row);
          const isSel = flatIdx === selectedIdx;
          const box = row.hasKey ? '[✓]' : '[ ]';
          return (
            <Text key={`p-${row.provider.name}`} color={isSel ? 'blue' : undefined} bold={isSel}>
              {isSel ? '  ▸ ' : '    '}
              <Text color={row.hasKey ? 'green' : 'gray'}>{box}</Text>
              {'  '}
              <Text bold={row.hasKey}>{row.provider.name.padEnd(nameWidth)}</Text>
              <Text color="gray">{row.provider.label}</Text>
              {row.hasKey && <Text color="green">{'  key set'}</Text>}
            </Text>
          );
        })}
      </Box>

      {searchRows.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          <Text bold color="gray">{'  WEB SEARCH (optional)'}</Text>
          <Text color="gray" dimColor>
            {'    Web search works keyless via DuckDuckGo; add a key for better results.'}
          </Text>
          {searchRows.map((row) => {
            const flatIdx = rows.indexOf(row);
            const isSel = flatIdx === selectedIdx;
            const box = row.hasKey ? '[✓]' : '[ ]';
            return (
              <Text key={`s-${row.provider.name}`} color={isSel ? 'blue' : undefined} bold={isSel}>
                {isSel ? '  ▸ ' : '    '}
                <Text color={row.hasKey ? 'green' : 'gray'}>{box}</Text>
                {'  '}
                <Text bold={row.hasKey}>{row.provider.name.padEnd(nameWidth)}</Text>
                <Text color="gray">{row.provider.label}</Text>
                {row.hasKey && <Text color="green">{'  key set'}</Text>}
              </Text>
            );
          })}
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text color="blue">{`  ${hintForSelection()}`}</Text>
        <Text color="gray">
          ↑ ↓ to move · esc to close
        </Text>
      </Box>
    </Box>
  );
}

function WizardConfirmPanel({ choice }: { choice: 'yes' | 'no' }): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="yellow"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color="yellow">! No provider API key detected</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          {'CodeRouter needs at least one provider key to run agent, planner, debug, or review modes.'}
        </Text>
        <Box marginTop={1}>
          <Text>Would you like to configure a provider now?</Text>
        </Box>
        <Box marginTop={1}>
          <Text>  </Text>
          <ConfirmButton label="Yes" selected={choice === 'yes'} />
          <Text>   </Text>
          <ConfirmButton label="No" selected={choice === 'no'} />
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          ← → to choose · enter to confirm · y / n for shortcut · esc to skip
        </Text>
      </Box>
    </Box>
  );
}

function ConfirmButton({
  label,
  selected,
}: {
  label: string;
  selected: boolean;
}): React.ReactElement {
  // Selected button is shown inverse-on-green so it pops against the
  // yellow panel; unselected is plain text with brackets so it still
  // reads as a clickable choice.
  if (selected) {
    return (
      <Text backgroundColor="green" color="black" bold>
        {`  ${label}  `}
      </Text>
    );
  }
  return <Text color="gray">{`  ${label}  `}</Text>;
}

function WizardKeyPanel({
  provider,
  maskedKey,
}: {
  provider: SetupProvider;
  maskedKey: string;
}): React.ReactElement {
  return (
    <Box
      borderStyle="round"
      borderColor="green"
      paddingX={2}
      paddingY={1}
      marginBottom={1}
      flexDirection="column"
    >
      <Text bold color="green">Paste your {provider.label} API key</Text>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">
          {'  expected format: '}
          <Text>{provider.example}</Text>
        </Text>
        <Box marginTop={1}>
          <Text color="green" bold>{'  > '}</Text>
          <Text>{maskedKey || ' '}</Text>
          <Text inverse> </Text>
        </Box>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">{`will be saved to ${CREDENTIALS_PATH} (chmod 600)`}</Text>
        <Text color="gray">enter to save · esc to cancel</Text>
      </Box>
    </Box>
  );
}

function SuggestionsList({
  items,
  selectedIdx,
}: {
  items: CommandDef[];
  selectedIdx: number;
}): React.ReactElement {
  const nameWidth = Math.max(...items.map((i) => i.name.length), 10);
  const hintWidth = Math.max(...items.map((i) => i.hint.length), 0);
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      {items.map((s, i) => {
        const isSel = i === selectedIdx;
        // Unselected items use the terminal's default foreground (white-ish
        // on dark themes) so they read like Claude Code; only descriptions
        // stay dimmed. Selected item gets the brand-green accent.
        return (
          <Box key={s.name}>
            <Text color={isSel ? 'green' : undefined} bold={isSel}>
              {isSel ? '▸ ' : '  '}
              {'/' + s.name.padEnd(nameWidth + 1)}
            </Text>
            <Text color="gray">
              {s.hint.padEnd(hintWidth + 2)}
              {s.desc}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

function MentionsList({
  items,
  selectedIdx,
}: {
  items: string[];
  selectedIdx: number;
}): React.ReactElement {
  return (
    <Box flexDirection="column" marginBottom={1} paddingX={1}>
      <Text color="gray" dimColor>{'  files · ↑↓ select · tab/↵ insert'}</Text>
      {items.map((f, i) => {
        const isSel = i === selectedIdx;
        const slash = f.lastIndexOf('/');
        const dir = slash >= 0 ? f.slice(0, slash + 1) : '';
        const base = slash >= 0 ? f.slice(slash + 1) : f;
        return (
          <Box key={f}>
            <Text color={isSel ? 'green' : undefined} bold={isSel}>
              {isSel ? '▸ ' : '  '}
            </Text>
            <Text color="gray" dimColor={!isSel}>{dir}</Text>
            <Text color={isSel ? 'green' : undefined} bold={isSel}>{base}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

function InputBox({
  value,
  cursor,
  busy,
  configured,
}: {
  value: string;
  cursor: number;
  busy: boolean;
  configured: boolean;
}): React.ReactElement {
  // Border color encodes session health: green while a run is in
  // flight, yellow when no provider is configured (so the user can't
  // miss it sitting in the chat), gray otherwise.
  const borderColor = busy ? 'green' : configured ? 'gray' : 'yellow';
  // The placeholder copy adapts to context. While a run is streaming we
  // hint that typing here will queue a follow-up; while idle we point
  // at /setup if no provider is configured, otherwise the standard
  // prompt-or-slash hint.
  const placeholder = busy
    ? 'type a follow-up to queue it (or esc to interrupt)'
    : configured
      ? 'prompt the agent — / for commands, @ for files'
      : 'no provider configured — type /setup to add one (or / for commands)';
  return (
    <Box borderStyle="round" borderColor={borderColor} paddingX={1}>
      <Text color="green" bold>{'> '}</Text>
      {value.length === 0 ? (
        <Text>
          <Text inverse> </Text>
          <Text color="gray">{`  ${placeholder}`}</Text>
        </Text>
      ) : (
        renderInputWithCursor(value, cursor)
      )}
    </Box>
  );
}

function NoProviderReminder(): React.ReactElement {
  return (
    <Box marginBottom={1} paddingX={1}>
      <Text bold color="yellow">! </Text>
      <Text color="yellow">no provider configured</Text>
      <Text color="gray">{'  —  agent / plan / debug / review runs will fail until you '}</Text>
      <Text bold color="green">/setup</Text>
      <Text color="gray"> a provider key</Text>
    </Box>
  );
}

function StatusRow({
  mode,
  effort,
  apply,
  fast,
  security,
  apiKeys,
  hosts,
  fullscreen,
}: {
  mode: Mode;
  effort: Effort;
  apply: boolean;
  fast: boolean;
  security: 'warn' | 'block';
  apiKeys: string[];
  hosts: DetectedHost[];
  fullscreen?: boolean;
}): React.ReactElement {
  const Sep = (): React.ReactElement => <Text color="gray">{'     '}</Text>;
  // Local CLIs come first because they're "free" routes the user
  // already paid for via their Codex/Claude subscriptions; the API
  // keys are the cloud fallback layer. Disabled hosts are hidden -
  // they're shown separately in the welcome panel + /hosts picker.
  const labels = [
    ...hosts.filter((h) => h.enabled).map((h) => h.cli),
    ...apiKeys,
  ];
  // Color-coordinated values - each param gets a distinct hue so the
  // eye can find a specific setting without reading labels:
  //   mode      -> yellow  (the primary axis: agent / plan / debug)
  //   effort    -> cyan    (intensity-ish; same family for low/med/high)
  //   apply     -> green on,   gray off
  //   fast      -> blue on,    gray off
  //   security  -> yellow warn, red block (warn = relaxed, block = strict)
  //   providers -> green when something is configured, yellow when none
  // Labels stay gray (dim) so the bold value chips pop.
  return (
    <Box>
      <Text color="gray">mode </Text>
      <Text bold color="yellow">{mode}</Text>
      <Sep />
      <Text color="gray">effort </Text>
      <Text bold color="cyan">{effort}</Text>
      <Sep />
      <Text color="gray">apply </Text>
      <Text bold color={apply ? 'green' : 'gray'}>{apply ? 'on' : 'off'}</Text>
      <Sep />
      <Text color="gray">fast </Text>
      <Text bold color={fast ? 'blue' : 'gray'}>{fast ? 'on' : 'off'}</Text>
      {/* Security only shows when the policy is something other
          than the default (`warn`). Most users never touch it, and
          rendering "security warn" on every line was just noise.
          When they flip to `/security block` the chip pops back in
          (red) so they know they're in strict mode. */}
      {security !== 'warn' && (
        <>
          <Sep />
          <Text color="gray">security </Text>
          <Text bold color="red">{security}</Text>
        </>
      )}
      <Sep />
      <Text color="gray">providers </Text>
      <Text bold color={labels.length > 0 ? 'green' : 'yellow'}>
        {labels.length > 0 ? labels.join(', ') : 'none'}
      </Text>
      {fullscreen && (
        <>
          <Sep />
          <Text bold color="magenta">fullscreen</Text>
        </>
      )}
    </Box>
  );
}

function ProgressLine({
  phase,
  routeLabel,
  usage,
  aborting,
}: {
  phase: string;
  routeLabel?: string;
  usage?: { tokensIn: number; tokensOut: number };
  aborting?: boolean;
}): React.ReactElement {
  // Spinner + elapsed timers live HERE, not in App. Previously App
  // re-rendered ~12×/sec on every spin/elapsed tick, which forced Ink
  // to redraw the entire live log + Static region and made the
  // wordmark flash. Isolating the animation to this leaf keeps the
  // rest of the tree stable while the run is in flight.
  const [frame, setFrame] = useState(0);
  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const spinId = setInterval(() => {
      setFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    const timeId = setInterval(() => {
      setElapsedMs(Date.now() - start);
    }, 200);
    return () => {
      clearInterval(spinId);
      clearInterval(timeId);
    };
  }, []);

  // Single dim line sitting directly under the input box. Mirrors the
  // Claude Code spinner: rotating braille frame + a verb + an elapsed
  // counter that ticks up while the run is in flight, plus optional
  // model + token/cost segments that the adapters populate as the
  // turn progresses. Everything stays inline (no Box border) so the
  // layout doesn't shift when the spinner appears/disappears.
  const label = phase || 'thinking';
  const showUsage = usage && (usage.tokensIn > 0 || usage.tokensOut > 0);
  // While aborting, swap the green spinner glyph for a yellow one
  // so the user gets an unmistakable "we heard you, shutting down"
  // signal even before the subprocess has finished exiting.
  const spinnerColor = aborting ? 'yellow' : 'green';
  const labelColor = aborting ? 'yellow' : 'gray';
  return (
    <Box paddingX={1}>
      <Text color={spinnerColor}>{SPINNER_FRAMES[frame % SPINNER_FRAMES.length]}</Text>
      <Text color={labelColor}>{`  ${label}`}</Text>
      <Text color="gray" dimColor>{`   ·   ${formatElapsed(elapsedMs)}`}</Text>
      {routeLabel && !aborting && (
        <Text color="gray" dimColor>{`   ·   ${routeLabel}`}</Text>
      )}
      {showUsage && !aborting && (
        <Text color="gray" dimColor>{`   ·   ${formatUsage(usage!)}`}</Text>
      )}
    </Box>
  );
}

/**
 * Compact "tokens · <in> in · <out> out" format used in the spinner
 * row and idle status row. Cost is intentionally omitted - the
 * shell-agent providers (Codex, Claude Code) don't bill us per
 * token anyway (they consume the user's existing subscription) so
 * a $-figure here was misleading at best. Token counts use comma
 * separators above 999 so the user can read them at a glance.
 */
function formatUsage(usage: {
  tokensIn: number;
  tokensOut: number;
}): string {
  const fmt = (n: number) => n.toLocaleString('en-US');
  return `tokens  ·  ${fmt(usage.tokensIn)} in  ·  ${fmt(usage.tokensOut)} out`;
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem.toString().padStart(2, '0')}s`;
}

/**
 * Squashes a multi-line prompt to a single line and clips to a max
 * length so the queued-prompt chip above the chatbox doesn't blow
 * up the layout when the user pastes a paragraph. Newlines become
 * `↵` so it's still visible something multi-line is queued.
 */
function truncateOneLine(s: string, max: number): string {
  const flat = s.replace(/\s*\n\s*/g, ' ↵ ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, max - 1)}…`;
}

function renderInputWithCursor(value: string, cursor: number): React.ReactElement {
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? ' ';
  const after = value.slice(cursor + 1);
  return (
    <Text>
      {before}
      <Text inverse>{at}</Text>
      {after}
    </Text>
  );
}

function mask(s: string): string {
  if (s.length === 0) return '';
  if (s.length <= 4) return '•'.repeat(s.length);
  // Show a short prefix so the user can spot a typo at the start of
  // their key without exposing the secret in scrollback.
  const prefix = s.slice(0, 4);
  return `${prefix}${'•'.repeat(s.length - 4)}`;
}

function renderHelp(): string {
  const nameW = Math.max(...COMMANDS.map((c) => c.name.length));
  const hintW = Math.max(...COMMANDS.map((c) => c.hint.length));
  const lines = ['commands:'];
  for (const c of COMMANDS) {
    lines.push(`  /${c.name.padEnd(nameW + 1)} ${c.hint.padEnd(hintW + 1)} ${c.desc}`);
  }
  return lines.join('\n');
}

function colorizeReportLine(line: string): React.ReactElement {
  // The metadata lines (run/cost/classified/route) no longer come out
  // of renderReportText - we only need to style the side-effect
  // sections (validators, files changed) and any escalation hint.
  if (line.startsWith('files changed') || line.startsWith('validators:')) {
    return <Text bold>{line}</Text>;
  }
  if (line.startsWith('hint:')) return <Text color="yellow">{line}</Text>;
  if (line.includes('PASS')) {
    const [pre, post] = line.split('PASS');
    return (
      <Text>
        {pre}
        <Text color="green" bold>PASS</Text>
        {post}
      </Text>
    );
  }
  if (line.includes('FAIL')) {
    const [pre, post] = line.split('FAIL');
    return (
      <Text>
        {pre}
        <Text color="red" bold>FAIL</Text>
        {post}
      </Text>
    );
  }
  if (line.includes('SKIP')) {
    const [pre, post] = line.split('SKIP');
    return (
      <Text>
        {pre}
        <Text color="yellow">SKIP</Text>
        {post}
      </Text>
    );
  }
  return <Text>{line}</Text>;
}

/**
 * Lightweight markdown renderer for streamed/finished model answers.
 * Recognises:
 *   - fenced code blocks (```...```), rendered as cyan plain text
 *   - ATX headers (#, ##, ###), bold cyan with underline for h1/h2
 *   - unordered list bullets (-, *) with a styled bullet glyph
 *   - inline **bold** and `code` runs
 * Anything else falls through as plain text. Intentionally tolerant -
 * malformed markdown never throws, we just render the literal source.
 */
function MarkdownBlock({ text }: { text: string }): React.ReactElement {
  const lines = text.split('\n');
  // Track whether we're inside a fenced code block as we walk lines top
  // to bottom; flipped on every ``` we encounter. Local mutable state
  // is fine here because each render is a fresh pass over `lines`.
  let inCode = false;
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        if (line.trimStart().startsWith('```')) {
          inCode = !inCode;
          return (
            <Text key={i} color="gray">
              {line}
            </Text>
          );
        }
        if (inCode) {
          return (
            <Text key={i} color="cyan">
              {line}
            </Text>
          );
        }
        return <MarkdownLine key={i} line={line} />;
      })}
    </Box>
  );
}

function MarkdownLine({ line }: { line: string }): React.ReactElement {
  const trimmed = line.trimStart();
  const leading = line.slice(0, line.length - trimmed.length);

  if (trimmed.startsWith('### ')) {
    return (
      <Text bold color="cyan">
        {leading}
        {trimmed.slice(4)}
      </Text>
    );
  }
  if (trimmed.startsWith('## ')) {
    return (
      <Text bold color="cyan" underline>
        {leading}
        {trimmed.slice(3)}
      </Text>
    );
  }
  if (trimmed.startsWith('# ')) {
    return (
      <Text bold color="cyan" underline>
        {leading}
        {trimmed.slice(2)}
      </Text>
    );
  }
  // Unordered bullet (-, *, +). Doesn't match e.g. **bold** at line start
  // because that needs whitespace after the marker.
  const bulletMatch = /^(\s*)[-*+]\s+(.*)$/.exec(line);
  if (bulletMatch) {
    return (
      <Text>
        {bulletMatch[1]}
        <Text color="cyan">{'• '}</Text>
        {renderInline(bulletMatch[2] ?? '')}
      </Text>
    );
  }
  // Ordered list - render as-is but with inline formatting.
  if (/^\s*\d+\.\s/.test(line)) {
    return <Text>{renderInline(line)}</Text>;
  }
  // Blockquote.
  if (trimmed.startsWith('> ')) {
    return (
      <Text color="gray" italic>
        {line}
      </Text>
    );
  }
  return <Text>{renderInline(line)}</Text>;
}

/**
 * Walk an inline-markdown string left to right, peeling off **bold**
 * and `code` runs into styled <Text> nodes. We intentionally don't
 * support nested emphasis (e.g. `**bold *with italic***`) because real
 * model output almost never uses it and a proper parser would dwarf
 * this file. Unclosed markers (`**foo` without a closing `**`) fall
 * through to plain text so partially-streamed lines render cleanly.
 */
function renderInline(text: string): React.ReactNode {
  if (!text) return text;
  const nodes: React.ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < text.length) {
    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end === -1) {
        nodes.push(text.slice(i));
        break;
      }
      nodes.push(
        <Text key={key++} bold>
          {text.slice(i + 2, end)}
        </Text>,
      );
      i = end + 2;
      continue;
    }
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end === -1) {
        nodes.push(text.slice(i));
        break;
      }
      nodes.push(
        <Text key={key++} color="cyan">
          {text.slice(i + 1, end)}
        </Text>,
      );
      i = end + 1;
      continue;
    }
    // Skip ahead to the next markup marker (or end of string).
    let next = text.length;
    const b = text.indexOf('**', i);
    const c = text.indexOf('`', i);
    if (b !== -1) next = Math.min(next, b);
    if (c !== -1) next = Math.min(next, c);
    nodes.push(text.slice(i, next));
    i = next;
  }
  if (nodes.length === 0) return text;
  if (nodes.length === 1) return nodes[0];
  return <Fragment>{nodes}</Fragment>;
}

/**
 * Build a lightweight transport for conversation history condensation.
 * Prefers OpenRouter (cheapest), falls back to OpenAI. Returns null
 * when no API key is available (condensation will gracefully degrade
 * to dropping old messages instead).
 */
function buildCondensationTransport(): InstanceType<typeof agent.OpenAICompatTransport> | null {
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    return new agent.OpenAICompatTransport({
      providerName: 'openrouter-condense',
      model: 'openai/gpt-4.1-mini',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKey: orKey,
      pricePer1MIn: 0.4,
      pricePer1MOut: 1.6,
    });
  }
  const oaiKey = process.env.OPENAI_API_KEY;
  if (oaiKey) {
    return new agent.OpenAICompatTransport({
      providerName: 'openai-condense',
      model: 'gpt-4.1-mini',
      baseURL: 'https://api.openai.com/v1',
      apiKey: oaiKey,
      pricePer1MIn: 0.4,
      pricePer1MOut: 1.6,
    });
  }
  return null;
}

export async function runInkRepl(opts: AppProps): Promise<void> {
  const instance = render(<App {...opts} />);
  await instance.waitUntilExit();
}
