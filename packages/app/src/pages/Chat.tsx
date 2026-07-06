import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, Check, ClipboardList, Copy, FileDiff, Folder, HelpCircle, ListTodo, Loader2, Mic, Paperclip, Plus, Square, Target, X } from 'lucide-react';
import { api, sendChat, type ActivityEvent, type Clarification, type ProjectSummary } from '../lib/api';
import { Spinner, cls, money } from '../components/common';
import { Markdown } from '../components/Markdown';
import { DiffView } from '../components/DiffView';
import { Dropdown } from '../components/Dropdown';

export type ChatChanges = { diff: string | null; filesChanged: string[]; cwd: string | null; applied?: boolean };

/** A prompt + mode to pre-fill a fresh chat with (from the Plan workspace / CLI handoff). */
export type ChatSeed = { prompt: string; mode: string; nonce: number };

/**
 * One row in the live "what the agent is doing" feed. Mirrors the CLI
 * REPL's log: a `tool` entry (a tool_use, later resolved by its
 * tool_result) or a `thinking` reasoning summary.
 */
type ActivityItem =
  | { id: number; kind: 'thinking'; text: string }
  | {
      id: number;
      kind: 'tool';
      tool: string;
      description: string;
      ok?: boolean;
      body?: string;
      /** Set for file-editing tools → rendered as a per-file change card. */
      path?: string;
      /** Live `+`/`-` preview of the edit, streamed in at tool-use time. */
      patch?: string;
    };

type Msg = {
  role: 'user' | 'assistant' | 'system';
  text: string;
  route?: string | null;
  costUsd?: number;
  pending?: boolean;
  diff?: string | null;
  filesChanged?: string[];
  applied?: boolean;
  activity?: ActivityItem[];
  usage?: { tokensIn: number; tokensOut: number; costUsd: number };
  // Plan metadata (set for plan/masterplan turns)
  planId?: string | null;
  openQuestions?: string[];
  clarifications?: Clarification[];
  escalationHint?: string | null;
};

let activityIdSeq = 0;

/**
 * Fold an incoming activity event into an existing feed, mirroring the
 * CLI's `appendLogActivity`: `tool_use` pushes a fresh row; `tool_result`
 * resolves the most recent matching unresolved tool row; `thinking`
 * deltas merge into one growing dim block.
 */
function mergeActivity(list: ActivityItem[], event: ActivityEvent): ActivityItem[] {
  if (event.kind === 'tool_result') {
    for (let i = list.length - 1; i >= 0; i--) {
      const row = list[i];
      if (row.kind === 'tool' && row.tool === event.tool && row.ok === undefined) {
        const next = list.slice();
        next[i] = { ...row, ok: event.ok, body: event.body };
        return next;
      }
    }
    return [...list, { id: activityIdSeq++, kind: 'tool', tool: event.tool, description: event.tool, ok: event.ok, body: event.body }];
  }
  if (event.kind === 'tool_use') {
    return [
      ...list,
      { id: activityIdSeq++, kind: 'tool', tool: event.tool, description: event.description, path: event.path, patch: event.patch },
    ];
  }
  if (event.kind === 'process_started') {
    return [
      ...list,
      {
        id: activityIdSeq++,
        kind: 'tool',
        tool: 'bash',
        description: `Started ${event.command}${event.url ? ` — ${event.url}` : ''}`,
        ok: true,
      },
    ];
  }
  if (event.kind === 'open_preview') {
    return [
      ...list,
      {
        id: activityIdSeq++,
        kind: 'tool',
        tool: 'open_preview',
        description: `Opened ${event.url} in the browser`,
        ok: true,
      },
    ];
  }
  const last = list[list.length - 1];
  if (last && last.kind === 'thinking') {
    const next = list.slice();
    next[next.length - 1] = { ...last, text: last.text + event.text };
    return next;
  }
  return [...list, { id: activityIdSeq++, kind: 'thinking', text: event.text }];
}

/** Max composer height (px) before it stops growing and scrolls. */
const MAX_COMPOSER_PX = 240;

const EFFORTS = ['low', 'medium', 'high', 'max'] as const;
const MODES = ['agent', 'plan', 'masterplan', 'debug', 'review'] as const;

/** Per-mode accent colors so the selector reads like Cursor's mode picker. */
const MODE_META: Record<string, { label: string; dot: string; text: string; chip: string }> = {
  agent: { label: 'Agent', dot: 'bg-emerald-500', text: 'text-emerald-500', chip: 'border-emerald-500/40 bg-emerald-500/10' },
  plan: { label: 'Plan', dot: 'bg-sky-500', text: 'text-sky-500', chip: 'border-sky-500/40 bg-sky-500/10' },
  masterplan: { label: 'Masterplan', dot: 'bg-indigo-500', text: 'text-indigo-500', chip: 'border-indigo-500/40 bg-indigo-500/10' },
  debug: { label: 'Debug', dot: 'bg-amber-500', text: 'text-amber-500', chip: 'border-amber-500/40 bg-amber-500/10' },
  review: { label: 'Review', dot: 'bg-violet-500', text: 'text-violet-500', chip: 'border-violet-500/40 bg-violet-500/10' },
};
/** Sentinel option value: triggers the folder picker rather than selecting a project. */
const ADD_FOLDER = '__add_folder__';

const SUGGESTIONS = [
  'Fix the failing tests with minimal changes',
  'Explain how this codebase is structured',
  'Add tests for the most critical module',
];

export function ChatPage({
  chatId,
  project,
  projects,
  insertText,
  seed,
  onProjectChange,
  onAddFolder,
  onSessionCreated,
  onChanges,
  onServerUrl,
  onViewPlan,
}: {
  chatId: string | null;
  project: string | null;
  projects: ProjectSummary[];
  /** Text to append to the composer (e.g. an @file mention); re-applied whenever `nonce` changes. */
  insertText?: { text: string; nonce: number } | null;
  /** Pre-fill a fresh chat with a prompt + mode (Plan workspace / CLI handoff). */
  seed?: ChatSeed | null;
  onProjectChange: (cwd: string) => void;
  onAddFolder?: () => void;
  onSessionCreated: (id: string) => void;
  onChanges?: (c: ChatChanges | null) => void;
  /** Open the in-app browser preview at a detected dev-server URL. */
  onServerUrl?: (url: string) => void;
  /** Open the Plan workspace focused on a plan id (from a plan/masterplan turn). */
  onViewPlan?: (planId: string) => void;
}): React.ReactElement {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<string>('agent');
  const [effort, setEffort] = useState<string>('medium');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const sessionRef = useRef<string>(chatId && chatId !== 'new' ? chatId : crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setError(null);
    if (chatId && chatId !== 'new') {
      sessionRef.current = chatId;
      if (!project) return;
      setLoadingHistory(true);
      void api
        .chat(project, chatId)
        .then((r) =>
          setMessages(
            r.messages.map((m) => ({
              role: m.role,
              text: m.text,
              route: m.route,
              costUsd: m.costUsd,
              diff: m.diff,
              filesChanged: m.filesChanged,
            })),
          ),
        )
        .catch(() => setMessages([]))
        .finally(() => setLoadingHistory(false));
    } else {
      sessionRef.current = crypto.randomUUID();
      setMessages([]);
    }
  }, [chatId, project]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Append an @file mention (or other text) from the file explorer to
  // the composer whenever a new insert request arrives.
  useEffect(() => {
    if (!insertText) return;
    setInput((v) => {
      const sep = v && !v.endsWith(' ') ? ' ' : '';
      return `${v}${sep}${insertText.text} `;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [insertText?.nonce]);

  // Pre-fill the composer + switch mode when a plan seed arrives (from the
  // Plan workspace "Refine"/"Start build" or a CLI handoff). We don't
  // auto-send so the user can review before spending a run.
  useEffect(() => {
    if (!seed) return;
    setMode(seed.mode);
    setInput(seed.prompt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed?.nonce]);

  // Report the most recent assistant changes upward so the Changes side
  // panel can mirror them.
  useEffect(() => {
    if (!onChanges) return;
    const lastWithDiff = [...messages].reverse().find((m) => m.role === 'assistant' && (m.diff || m.filesChanged?.length));
    onChanges(
      lastWithDiff
        ? { diff: lastWithDiff.diff ?? null, filesChanged: lastWithDiff.filesChanged ?? [], cwd: project, applied: lastWithDiff.applied }
        : null,
    );
  }, [messages, onChanges, project]);

  const send = async (): Promise<void> => {
    const prompt = input.trim();
    if (!prompt || busy || !project) return;
    setInput('');
    setError(null);
    setBusy(true);
    const wasNew = !chatId || chatId === 'new';
    setMessages((m) => [...m, { role: 'user', text: prompt }, { role: 'assistant', text: '', pending: true }]);

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await sendChat(
        { cwd: project, sessionId: sessionRef.current, prompt, mode, effort },
        (e) => {
          if (e.type === 'start') sessionRef.current = e.sessionId;
          else if (e.type === 'chunk') {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') last.text += e.text;
              return next;
            });
          } else if (e.type === 'activity') {
            // Auto-open the in-app browser when a dev server URL is detected,
            // or when the agent explicitly asks to show something (open_preview).
            if (e.event.kind === 'process_started' && e.event.url) onServerUrl?.(e.event.url);
            else if (e.event.kind === 'open_preview') onServerUrl?.(e.event.url);
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') last.activity = mergeActivity(last.activity ?? [], e.event);
              return next;
            });
          } else if (e.type === 'usage') {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') last.usage = { tokensIn: e.tokensIn, tokensOut: e.tokensOut, costUsd: e.costUsd };
              return next;
            });
          } else if (e.type === 'done') {
            setMessages((m) => {
              const next = [...m];
              const last = next[next.length - 1];
              if (last && last.role === 'assistant') {
                last.text = e.text || last.text;
                last.route = e.route;
                last.costUsd = e.costUsd;
                last.diff = e.diff;
                last.filesChanged = e.filesChanged;
                last.applied = e.applied;
                last.planId = e.planId ?? null;
                last.openQuestions = e.openQuestions ?? [];
                last.clarifications = e.clarifications ?? [];
                last.escalationHint = e.escalationHint ?? null;
                last.pending = false;
              }
              return next;
            });
          } else if (e.type === 'error') {
            setError(e.error);
            setMessages((m) => m.filter((x) => !(x.role === 'assistant' && x.pending)));
          }
        },
        ctrl.signal,
      );
      if (wasNew) onSessionCreated(sessionRef.current);
    } catch (err) {
      if (!ctrl.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      setMessages((m) => m.map((x) => (x.pending ? { ...x, pending: false } : x)));
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  };

  const stop = (): void => abortRef.current?.abort();

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const composer = (
    <Composer
      input={input}
      setInput={setInput}
      onSend={send}
      onStop={stop}
      onKeyDown={onKeyDown}
      busy={busy}
      mode={mode}
      setMode={setMode}
      effort={effort}
      setEffort={setEffort}
      project={project}
      projects={projects}
      onProjectChange={onProjectChange}
      onAddFolder={onAddFolder}
      placeholder={messages.length ? 'Ask for follow-up changes…' : 'Do anything…'}
    />
  );

  const empty = messages.length === 0 && !loadingHistory;

  // Empty state: heading + composer centered together, Codex-style.
  if (empty) {
    return (
      <div className="mx-auto flex h-full max-w-2xl flex-col items-center justify-center px-4">
        <h2 className="mb-6 text-3xl font-semibold tracking-tight">What should we build?</h2>
        <div className="w-full"><ProcessBar cwd={project} active={busy} onPreview={onServerUrl} /></div>
        <div className="w-full">{composer}</div>
        {error && <div className="mt-3 w-full rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        <div className="mt-4 w-full divide-y divide-border/60 border-t border-border/60">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => setInput(s)}
              className="flex w-full items-center gap-2 px-1 py-2.5 text-left text-sm text-muted transition-colors hover:text-text"
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Full-width scroll container so the scrollbar rides the right edge;
          the conversation itself stays centered at a readable width. */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-6 pb-6 pt-6">
          {loadingHistory && <Spinner />}
          {messages.map((m, i) => (
            <MessageRow
              key={i}
              msg={m}
              cwd={project}
              onAccept={project ? (diff) => api.applyChanges(project, diff) : undefined}
              onRevert={project ? (diff) => api.revertChanges(project, diff) : undefined}
              onOpenFile={project ? (path) => api.openPath(project, path) : undefined}
              onViewPlan={onViewPlan}
            />
          ))}
        </div>
      </div>
      <div className="mx-auto w-full max-w-2xl px-6 pb-4">
        <ProcessBar cwd={project} active={busy} onPreview={onServerUrl} />
        {error && <div className="mb-2 rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad">{error}</div>}
        <div className="pt-1">{composer}</div>
      </div>
    </div>
  );
}

/**
 * Shows background processes (dev servers) the agent started for this
 * project. Polls the daemon so it reflects processes from earlier turns and
 * prunes ones that have exited. Each row can be opened in the browser or
 * stopped.
 */
function ProcessBar({
  cwd,
  active,
  onPreview,
}: {
  cwd: string | null;
  active: boolean;
  onPreview?: (url: string) => void;
}): React.ReactElement | null {
  const [procs, setProcs] = useState<import('../lib/api').RunningProcess[]>([]);
  const [stopping, setStopping] = useState<number | null>(null);

  useEffect(() => {
    if (!cwd) {
      setProcs([]);
      return;
    }
    let alive = true;
    const load = (): void => {
      void api
        .processes(cwd)
        .then((r) => {
          if (alive) setProcs(r.processes);
        })
        .catch(() => {});
    };
    load();
    // Poll faster while a run is active (a server may spin up mid-turn).
    const interval = window.setInterval(load, active ? 2000 : 5000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [cwd, active]);

  if (procs.length === 0) return null;

  const stop = async (pid: number): Promise<void> => {
    setStopping(pid);
    try {
      await api.stopProcess(pid);
      setProcs((p) => p.filter((x) => x.pid !== pid));
    } finally {
      setStopping(null);
    }
  };

  return (
    <div className="mb-2 space-y-1.5">
      {procs.map((p) => (
        <div key={p.pid} className="flex items-center gap-2 rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-ok/60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-ok" />
          </span>
          <span className="truncate font-mono text-[11px] text-text" title={p.command}>
            {p.command}
          </span>
          {p.url && <span className="truncate font-mono text-[11px] text-muted" title={p.url}>{p.url}</span>}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            {p.url && onPreview && (
              <button
                onClick={() => onPreview(p.url as string)}
                className="inline-flex items-center gap-1 rounded-md bg-accent px-2 py-0.5 font-medium text-white transition-colors hover:bg-accent/80"
                title={`Preview ${p.url} in the app`}
              >
                Preview
              </button>
            )}
            {p.url && (
              <button
                onClick={() => void api.openUrl(p.url as string)}
                className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-muted transition-colors hover:text-text"
                title={`Open ${p.url} in your external browser`}
              >
                Open in browser
              </button>
            )}
            <button
              onClick={() => void stop(p.pid)}
              disabled={stopping === p.pid}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 font-medium text-muted transition-colors hover:border-bad/50 hover:text-bad disabled:opacity-60"
              title="Stop this process"
            >
              {stopping === p.pid ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
              Stop
            </button>
          </span>
        </div>
      ))}
    </div>
  );
}

function MessageRow({
  msg,
  cwd,
  onAccept,
  onRevert,
  onOpenFile,
  onViewPlan,
}: {
  msg: Msg;
  cwd?: string | null;
  onAccept?: (diff: string) => Promise<unknown>;
  onRevert?: (diff: string) => Promise<unknown>;
  onOpenFile?: (path: string) => void;
  onViewPlan?: (planId: string) => void;
}): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard.writeText(msg.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl bg-panel2 px-4 py-2.5 text-sm">{msg.text}</div>
      </div>
    );
  }
  const hasActivity = (msg.activity?.length ?? 0) > 0;
  return (
    <div className="group">
      {hasActivity && <ActivityFeed items={msg.activity as ActivityItem[]} live={Boolean(msg.pending)} />}
      {msg.text ? (
        <Markdown text={msg.text} />
      ) : msg.pending && !hasActivity ? (
        <span className="inline-flex items-center gap-2 text-sm text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Thinking…
        </span>
      ) : null}
      {msg.pending && msg.usage && (msg.usage.tokensIn > 0 || msg.usage.tokensOut > 0) && (
        <div className="mt-1 text-[11px] text-muted/70">
          {msg.usage.tokensIn.toLocaleString()} tokens in · {msg.usage.tokensOut.toLocaleString()} tokens out
          {msg.usage.costUsd ? ` · ${money(msg.usage.costUsd)}` : ''}
        </div>
      )}
      {!msg.pending && (msg.diff || msg.filesChanged?.length) ? (
        <div className="mt-2">
          <DiffView
            diff={msg.diff}
            filesChanged={msg.filesChanged}
            cwd={cwd}
            applied={msg.applied}
            onAccept={msg.diff && onAccept ? () => onAccept(msg.diff as string).then(() => undefined) : undefined}
            onRevert={msg.diff && onRevert ? () => onRevert(msg.diff as string).then(() => undefined) : undefined}
            onOpenFile={onOpenFile}
          />
        </div>
      ) : null}
      {!msg.pending && msg.planId ? (
        <PlanCallout msg={msg} onViewPlan={onViewPlan} />
      ) : null}
      {!msg.pending && msg.text && (
        <div className="mt-1.5 flex items-center gap-3 text-[11px] text-muted opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={copy} className="inline-flex items-center gap-1 hover:text-text">
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? 'Copied' : 'Copy'}
          </button>
          {msg.route && <span>{msg.route}</span>}
          {msg.costUsd ? <span>{money(msg.costUsd)}</span> : null}
        </div>
      )}
    </div>
  );
}

/**
 * Post-plan callout under a plan/masterplan turn: highlights the planner's
 * open questions (and any pre-plan clarifications / escalation nudge) and
 * offers a button to open the saved plan in the Plan workspace.
 */
function PlanCallout({ msg, onViewPlan }: { msg: Msg; onViewPlan?: (planId: string) => void }): React.ReactElement {
  const questions = [
    ...(msg.openQuestions ?? []),
    ...((msg.clarifications ?? []).map((c) => c.question)),
  ];
  return (
    <div className="mt-2 rounded-lg border border-sky-500/40 bg-sky-500/10 px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-sm font-semibold text-sky-500">
          <ClipboardList className="h-4 w-4" strokeWidth={2} /> Plan ready
        </div>
        {msg.planId && onViewPlan && (
          <button
            onClick={() => onViewPlan(msg.planId as string)}
            className="rounded-md bg-sky-500 px-2.5 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90"
          >
            Open in Plan workspace
          </button>
        )}
      </div>
      {questions.length > 0 && (
        <div className="mt-2">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-warn">
            <HelpCircle className="h-3.5 w-3.5" strokeWidth={2} />
            {questions.length === 1 ? 'Open question' : `${questions.length} open questions`} — confirm before building
          </div>
          <ul className="space-y-1 text-sm text-text">
            {questions.map((q, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-warn">?</span>
                <span>{q}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {msg.escalationHint && (
        <div className="mt-2 text-xs text-muted">{msg.escalationHint}</div>
      )}
    </div>
  );
}

/**
 * Live "actions" feed shown under a streaming assistant reply — the app
 * mirror of the CLI REPL's log. Each tool call renders with a status
 * glyph (spinner while running, check/✗ once resolved) and an optional
 * captured-output body; thinking summaries render as dim italic lines.
 */
function ActivityFeed({ items, live }: { items: ActivityItem[]; live: boolean }): React.ReactElement {
  return (
    <div className="mb-2 space-y-1.5">
      {items.map((it) => {
        if (it.kind === 'thinking') {
          return (
            <div key={it.id} className="whitespace-pre-wrap text-xs italic leading-relaxed text-muted">
              {it.text}
            </div>
          );
        }
        // File-editing tools render as a Cursor-style per-file change
        // card; everything else is a compact one-line tool row.
        if (it.path || it.patch) return <FileEditCard key={it.id} item={it} live={live} />;
        return <ToolRow key={it.id} item={it} live={live} />;
      })}
    </div>
  );
}

/**
 * Per-file change card shown live during a run: a header with the file
 * path and a status glyph (spinner while the edit is in flight, ✓/✗ once
 * resolved), plus a streamed `+`/`-` preview of what's changing. The
 * authoritative diff still appears in the DiffView once the run finishes.
 */
function FileEditCard({ item, live }: { item: Extract<ActivityItem, { kind: 'tool' }>; live: boolean }): React.ReactElement {
  const pending = item.ok === undefined;
  const lines = item.patch ? item.patch.split('\n') : [];
  const add = lines.filter((l) => l.startsWith('+')).length;
  const del = lines.filter((l) => l.startsWith('-')).length;
  const path = item.path || item.description.replace(/^(Edited|Wrote|Editing)\s+/i, '');
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border/70 px-2.5 py-1.5 text-xs">
        {pending ? (
          <Loader2 className={cls('h-3.5 w-3.5 shrink-0 text-accent', live && 'animate-spin')} />
        ) : item.ok ? (
          <Check className="h-3.5 w-3.5 shrink-0 text-ok" />
        ) : (
          <X className="h-3.5 w-3.5 shrink-0 text-bad" />
        )}
        <FileDiff className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="truncate font-mono text-[12px] text-text" title={path}>{path}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {(add > 0 || del > 0) && (
            <span className="font-mono text-[11px]">
              <span className="text-ok">+{add}</span> <span className="text-bad">−{del}</span>
            </span>
          )}
          {pending && <span className="text-[11px] text-muted">{live ? 'editing…' : 'queued'}</span>}
        </span>
      </div>
      {lines.length > 0 && (
        <pre className="max-h-56 overflow-auto bg-bg/40 px-2.5 py-1.5 text-[11px] leading-[1.5]">
          <code>
            {lines.map((line, i) => (
              <div
                key={i}
                className={cls(
                  'whitespace-pre',
                  line.startsWith('+') && 'bg-ok/10 text-ok',
                  line.startsWith('-') && 'bg-bad/10 text-bad',
                  line.startsWith('@@') && 'text-accent',
                  line.startsWith('…') && 'text-muted italic',
                  !line.startsWith('+') && !line.startsWith('-') && !line.startsWith('@@') && !line.startsWith('…') && 'text-muted',
                )}
              >
                {line || ' '}
              </div>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}

function ToolRow({ item, live }: { item: Extract<ActivityItem, { kind: 'tool' }>; live: boolean }): React.ReactElement {
  const pending = item.ok === undefined;
  return (
    <div className="text-xs">
      <div className="flex items-center gap-1.5">
        {pending ? (
          live ? (
            <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted" />
          ) : (
            <span className="h-3 w-3 shrink-0 text-center text-muted">›</span>
          )
        ) : item.ok ? (
          <Check className="h-3 w-3 shrink-0 text-ok" />
        ) : (
          <X className="h-3 w-3 shrink-0 text-bad" />
        )}
        <span className="font-medium text-muted">{item.tool}</span>
        <span className="truncate text-muted/80">{item.description !== item.tool ? item.description : ''}</span>
      </div>
      {item.body ? (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border/60 bg-bg/40 px-2 py-1 text-[11px] leading-[1.5] text-muted">
          {item.body.split('\n').slice(0, 12).join('\n')}
          {item.body.split('\n').length > 12 ? `\n…and ${item.body.split('\n').length - 12} more lines` : ''}
        </pre>
      ) : null}
    </div>
  );
}

function Composer({
  input,
  setInput,
  onSend,
  onStop,
  onKeyDown,
  busy,
  mode,
  setMode,
  effort,
  setEffort,
  project,
  projects,
  onProjectChange,
  onAddFolder,
  placeholder,
}: {
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  busy: boolean;
  mode: string;
  setMode: (v: string) => void;
  effort: string;
  setEffort: (v: string) => void;
  project: string | null;
  projects: ProjectSummary[];
  onProjectChange: (cwd: string) => void;
  onAddFolder?: () => void;
  placeholder: string;
}): React.ReactElement {
  const [menuOpen, setMenuOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const { supported: voiceSupported, listening, toggle: toggleVoice } = useVoiceInput((t) =>
    setInput(input ? `${input} ${t}` : t),
  );

  // Auto-grow the composer to fit its content, capped at MAX_COMPOSER_PX
  // (then it scrolls). Reset to `auto` first so it can also shrink when
  // the user deletes lines or the input is cleared after sending.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`;
  }, [input]);

  const append = (text: string): void => setInput(input ? `${input}${text}` : text);

  return (
    <div className="rounded-2xl border border-border bg-panel shadow-sm transition-colors focus-within:border-accent/60">
      <textarea
        ref={taRef}
        className="min-h-[72px] w-full resize-none overflow-y-auto bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed outline-none placeholder:text-muted"
        style={{ maxHeight: MAX_COMPOSER_PX }}
        placeholder={placeholder}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
      />
      <div className="flex items-center gap-2 px-3 pb-3 pt-1">
        <div className="relative">
          <button
            onClick={() => setMenuOpen((o) => !o)}
            className="flex h-8 w-8 items-center justify-center rounded-full border border-border text-muted transition-colors hover:text-text"
            title="Add"
          >
            <Plus className={cls('h-4 w-4 transition-transform', menuOpen && 'rotate-45')} />
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-10 left-0 z-20 w-60 overflow-hidden rounded-xl border border-border bg-panel py-1 shadow-lg">
                <MenuItem
                  icon={Paperclip}
                  label="Attach file or folder"
                  hint="Reference a path with @"
                  onClick={() => {
                    setMenuOpen(false);
                    const p = window.prompt('Path to attach (added as @path):');
                    if (p && p.trim()) append(`${input && !input.endsWith(' ') ? ' ' : ''}@${p.trim()} `);
                  }}
                />
                <MenuItem
                  icon={Target}
                  label="Add a goal"
                  hint="Prefix the prompt with a goal"
                  onClick={() => {
                    setMenuOpen(false);
                    if (!input.toLowerCase().startsWith('goal:')) setInput(`Goal: ${input}`);
                  }}
                />
                <MenuItem
                  icon={ListTodo}
                  label={mode === 'plan' ? 'Plan mode: on' : 'Turn on plan mode'}
                  hint="Plan before editing"
                  active={mode === 'plan'}
                  onClick={() => {
                    setMenuOpen(false);
                    setMode(mode === 'plan' ? 'agent' : 'plan');
                  }}
                />
              </div>
            </>
          )}
        </div>

        <Pill
          value={project ?? ''}
          onChange={(v) => (v === ADD_FOLDER ? onAddFolder?.() : onProjectChange(v))}
          placeholder="no folder"
          title="Working folder"
          icon={<Folder className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />}
          options={[
            ...projects.map((p) => ({ value: p.cwd, label: p.name })),
            ...(onAddFolder ? [{ value: ADD_FOLDER, label: '+ Add folder…' }] : []),
          ]}
        />
        <ModePill value={mode} onChange={setMode} />
        <Pill value={effort} onChange={setEffort} title="Reasoning effort" capitalize options={EFFORTS.map((e) => ({ value: e, label: e }))} />

        <div className="ml-auto flex items-center gap-1.5">
          {voiceSupported && (
            <button
              onClick={toggleVoice}
              className={cls(
                'flex h-8 w-8 items-center justify-center rounded-full border transition-colors',
                listening ? 'border-bad bg-bad/10 text-bad' : 'border-border text-muted hover:text-text',
              )}
              title={listening ? 'Stop dictation' : 'Dictate'}
            >
              <Mic className="h-4 w-4" />
            </button>
          )}
          {busy ? (
            <button onClick={onStop} className="flex h-8 w-8 items-center justify-center rounded-full bg-panel2 text-text hover:bg-border" title="Stop">
              <Square className="h-3.5 w-3.5" />
            </button>
          ) : (
            <button
              onClick={onSend}
              disabled={!input.trim() || !project}
              className={cls(
                'flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                input.trim() && project ? 'bg-accent text-white hover:bg-accent/80' : 'bg-panel2 text-muted',
              )}
              title="Send"
            >
              <ArrowUp className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  hint,
  active,
  onClick,
}: {
  icon: typeof Plus;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}): React.ReactElement {
  return (
    <button onClick={onClick} className="flex w-full items-start gap-2.5 px-3 py-2 text-left text-sm hover:bg-panel2">
      <Icon className={cls('mt-0.5 h-4 w-4 shrink-0', active ? 'text-accent' : 'text-muted')} />
      <span>
        <span className={cls('block', active && 'text-accent')}>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}

/**
 * Browser SpeechRecognition wrapper for dictation. Returns supported=false
 * when the API is unavailable so the mic button can hide itself.
 */
function useVoiceInput(onText: (t: string) => void): { supported: boolean; listening: boolean; toggle: () => void } {
  const recognitionRef = useRef<any>(null);
  const [listening, setListening] = useState(false);
  const Ctor: any =
    typeof window !== 'undefined' ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : undefined;
  const supported = Boolean(Ctor);

  const toggle = (): void => {
    if (!supported) return;
    if (listening) {
      recognitionRef.current?.stop();
      return;
    }
    const rec = new Ctor();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = false;
    rec.continuous = false;
    rec.onresult = (e: any) => {
      const t = Array.from(e.results)
        .map((r: any) => r[0]?.transcript ?? '')
        .join(' ')
        .trim();
      if (t) onText(t);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    setListening(true);
    rec.start();
  };

  return { supported, listening, toggle };
}

/** Mode selector where each mode carries its own color, Cursor-style. */
function ModePill({ value, onChange }: { value: string; onChange: (v: string) => void }): React.ReactElement {
  const meta = MODE_META[value] ?? MODE_META.agent;
  return (
    <Dropdown
      value={value}
      onChange={onChange}
      title="Mode"
      size="sm"
      menuWidth="w-44"
      options={MODES.map((m) => {
        const mm = MODE_META[m];
        return {
          value: m,
          searchText: m,
          label: (
            <span className="flex items-center gap-2">
              <span className={cls('h-2 w-2 shrink-0 rounded-full', mm.dot)} />
              <span className={cls('font-medium', mm.text)}>{mm.label}</span>
            </span>
          ),
          buttonLabel: (
            <span className="flex items-center gap-1.5">
              <span className={cls('h-2 w-2 shrink-0 rounded-full', mm.dot)} />
              <span className={cls('font-medium', mm.text)}>{mm.label}</span>
            </span>
          ),
        };
      })}
      className={cls(
        'flex items-center justify-between gap-1.5 rounded-md border px-2 py-1 text-xs outline-none transition-colors',
        meta.chip,
      )}
    />
  );
}

function Pill({
  value,
  onChange,
  options,
  placeholder,
  capitalize,
  icon,
  title,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  placeholder?: string;
  capitalize?: boolean;
  icon?: React.ReactNode;
  title?: string;
}): React.ReactElement {
  return (
    <Dropdown
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      title={title}
      leadingIcon={icon}
      options={options.map((o) => ({ value: o.value, label: o.label }))}
      size="sm"
      menuWidth="w-56"
      className={cls(
        'flex items-center justify-between gap-1.5 rounded-md border border-border bg-panel2 px-2 py-1 text-xs text-muted outline-none transition-colors hover:border-accent hover:text-text',
        capitalize && 'capitalize',
      )}
    />
  );
}
