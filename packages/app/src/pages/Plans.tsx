import React, { useCallback, useEffect, useState } from 'react';
import {
  BookOpen,
  CircleDot,
  FileText,
  HelpCircle,
  ListChecks,
  Pencil,
  Play,
  RefreshCw,
  Save,
  Sparkles,
  X,
} from 'lucide-react';
import { api, type PlanDetail, type PlanPhase, type PlanSummary } from '../lib/api';
import { Markdown } from '../components/Markdown';
import { EmptyState, Spinner, StatusBadge, cls, timeAgo } from '../components/common';

/**
 * Pull planner-flagged `OPEN:` lines out of a plan body so we can render a
 * highlighted "confirm before building" callout. Mirrors the core
 * `extractOpenQuestions` regex (the questions aren't stored in frontmatter,
 * only in the markdown body).
 */
function extractOpenQuestions(body: string): string[] {
  const re = /^\s*(?:[-*]\s*)?(?:\*\*|__)?\s*OPEN\s*(?:\*\*|__)?\s*:\s*(.+?)\s*$/gim;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null = re.exec(body);
  while (m !== null) {
    const q = (m[1] ?? '').replace(/\*\*|__/g, '').trim();
    if (q && !seen.has(q)) {
      seen.add(q);
      out.push(q);
    }
    m = re.exec(body);
  }
  return out;
}

export type PlanSelection = { id: string; nonce: number } | null;

/**
 * Compact "has this plan been built?" pill. A plan starts `draft`/`ready`
 * (not built), flips to `executing` once the user kicks off a build, and to
 * `done` when every phase is checked off (or the run reports completion).
 */
function BuildBadge({ status }: { status: string }): React.ReactElement {
  const map: Record<string, { label: string; cls: string; dot?: boolean }> = {
    done: { label: 'Built', cls: 'border-ok/40 bg-ok/10 text-ok' },
    executing: { label: 'Building', cls: 'border-accent/40 bg-accent/10 text-accent', dot: true },
    failed: { label: 'Failed', cls: 'border-bad/40 bg-bad/10 text-bad' },
  };
  const m = map[status] ?? { label: 'Not built', cls: 'border-border bg-panel2 text-muted' };
  return (
    <span className={cls('inline-flex items-center gap-1 rounded-full border px-1.5 py-[1px] text-[10px] font-medium', m.cls)}>
      {m.dot && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />}
      {m.label}
    </span>
  );
}

/**
 * Plan workspace: a full-window view over the plans saved under
 * `.coderouter/plans/*.plan.md`. Left rail lists plans; the main pane
 * renders the selected plan as a rich document with a phase checklist,
 * an open-questions callout, citations, inline editing, and actions to
 * refine the plan (plan-mode chat) or start building it (agent-mode chat).
 */
export function PlansPage({
  project,
  selection,
  onStartBuild,
  onRefine,
}: {
  project: string | null;
  selection: PlanSelection;
  onStartBuild: (planId: string, body: string) => void;
  onRefine: (planId: string, body: string) => void;
}): React.ReactElement {
  const [plans, setPlans] = useState<PlanSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<PlanDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!project) {
      setPlans([]);
      return;
    }
    try {
      const r = await api.plans(project);
      setPlans(r.plans);
      setSelectedId((cur) => cur ?? r.plans[0]?.id ?? null);
    } catch {
      setPlans([]);
    }
  }, [project]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // External request to open a specific plan (chat "View plan" / CLI handoff).
  useEffect(() => {
    if (!selection) return;
    setSelectedId(selection.id);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.nonce]);

  // Load the selected plan's full body/frontmatter/citations.
  useEffect(() => {
    if (!project || !selectedId) {
      setDetail(null);
      return;
    }
    setLoading(true);
    setEditing(false);
    void api
      .plan(project, selectedId)
      .then((d) => {
        setDetail(d);
        setDraft(d.body);
      })
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [project, selectedId]);

  const saveBody = async (): Promise<void> => {
    if (!project || !detail) return;
    setSaving(true);
    try {
      await api.savePlan({ cwd: project, id: detail.frontmatter.planId, body: draft });
      setDetail({ ...detail, body: draft });
      setEditing(false);
      void refresh();
    } catch {
      /* surfaced by the disabled state; keep the editor open */
    } finally {
      setSaving(false);
    }
  };

  const togglePhase = async (phase: PlanPhase): Promise<void> => {
    if (!project || !detail) return;
    const next = detail.frontmatter.phases.map((p) =>
      p.id === phase.id ? { ...p, status: p.status === 'done' ? 'pending' : 'done' } : p,
    ) as PlanPhase[];
    // Reflect completion in the plan's build status: all phases done => Built,
    // otherwise keep it as an in-progress build (unless it was still a draft).
    const allDone = next.length > 0 && next.every((p) => p.status === 'done');
    const cur = detail.frontmatter.status;
    const nextStatus = allDone ? 'done' : cur === 'done' ? 'executing' : cur;
    setDetail({ ...detail, frontmatter: { ...detail.frontmatter, phases: next, status: nextStatus } });
    try {
      await api.savePlan({ cwd: project, id: detail.frontmatter.planId, phases: next, status: nextStatus });
      void refresh();
    } catch {
      void refresh();
    }
  };

  // Kick off a build: mark the plan as building so the list shows its state,
  // then hand the body to an agent-mode chat.
  const startBuild = (): void => {
    if (!detail) return;
    onStartBuild(detail.frontmatter.planId, detail.body);
    if (project && detail.frontmatter.status !== 'done') {
      setDetail({ ...detail, frontmatter: { ...detail.frontmatter, status: 'executing' } });
      void api
        .savePlan({ cwd: project, id: detail.frontmatter.planId, status: 'executing' })
        .then(() => refresh())
        .catch(() => {});
    }
  };

  if (!project) {
    return <EmptyState title="No project selected" hint="Pick a project to see its plans." />;
  }

  const openQuestions = detail ? extractOpenQuestions(detail.body) : [];

  return (
    <div className="flex h-full min-h-0 gap-6">
      {/* Left rail: saved plans */}
      <div className="flex w-72 shrink-0 flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Plans</h2>
          <button
            onClick={() => void refresh()}
            title="Refresh"
            className="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
          >
            <RefreshCw className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        </div>
        {plans.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted">
            No plans yet. Run a chat in Plan or Masterplan mode to create one.
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
            {plans.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedId(p.id)}
                className={cls(
                  'flex w-full flex-col gap-1 rounded-lg border px-3 py-2 text-left transition-colors',
                  selectedId === p.id
                    ? 'border-accent/50 bg-accent/10'
                    : 'border-border bg-panel hover:bg-panel2',
                )}
              >
                <div className="flex items-center gap-1.5">
                  {p.mode === 'masterplan' ? (
                    <Sparkles className="h-3.5 w-3.5 shrink-0 text-indigo-400" strokeWidth={2} />
                  ) : (
                    <FileText className="h-3.5 w-3.5 shrink-0 text-sky-400" strokeWidth={2} />
                  )}
                  <span className="truncate text-[13px] font-medium text-text">{p.title}</span>
                  <span className="ml-auto shrink-0"><BuildBadge status={p.status} /></span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="uppercase tracking-wide">{p.mode}</span>
                  {p.phaseCount > 0 && <span>{p.phaseCount} phases</span>}
                  <span className="ml-auto">{p.createdAt ? timeAgo(Date.parse(p.createdAt)) : ''}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Main pane: selected plan */}
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto pb-10">
        {loading && (
          <div className="flex items-center gap-2 py-10 text-muted">
            <Spinner /> Loading plan…
          </div>
        )}
        {!loading && !detail && (
          <EmptyState title="Select a plan" hint="Pick a plan from the list to view and refine it." />
        )}
        {!loading && detail && (
          <div className="mx-auto max-w-3xl">
            {/* Header + actions */}
            <div className="mb-4 flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h1 className="truncate text-xl font-semibold text-text">{detail.title}</h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <StatusBadge status={detail.frontmatter.status} />
                  <span className="uppercase tracking-wide">effort {detail.frontmatter.effort}</span>
                  <span className="truncate font-mono">{detail.frontmatter.route}</span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => onRefine(detail.frontmatter.planId, detail.body)}
                  className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text transition-colors hover:bg-panel2"
                  title="Iterate on this plan in a Plan-mode chat"
                >
                  <BookOpen className="h-4 w-4" strokeWidth={2} /> Refine
                </button>
                <button
                  onClick={startBuild}
                  className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-opacity hover:opacity-90"
                  title="Execute this plan in an Agent-mode chat"
                >
                  <Play className="h-4 w-4" strokeWidth={2} /> Start build
                </button>
              </div>
            </div>

            {/* Open questions callout */}
            {openQuestions.length > 0 && (
              <div className="mb-4 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold text-warn">
                  <HelpCircle className="h-4 w-4" strokeWidth={2} />
                  {openQuestions.length === 1 ? 'Open question' : `${openQuestions.length} open questions`} — confirm before building
                </div>
                <ul className="space-y-1 text-sm text-text">
                  {openQuestions.map((q, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="text-warn">?</span>
                      <span>{q}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Phases checklist */}
            {detail.frontmatter.phases.length > 0 && (
              <div className="mb-5 rounded-lg border border-border bg-panel">
                <div className="flex items-center gap-1.5 border-b border-border px-4 py-2 text-sm font-semibold text-text">
                  <ListChecks className="h-4 w-4 text-muted" strokeWidth={2} /> Phases
                </div>
                <ul>
                  {detail.frontmatter.phases.map((ph) => {
                    const done = ph.status === 'done';
                    return (
                      <li key={ph.id} className="flex items-start gap-2.5 border-b border-border/60 px-4 py-2.5 last:border-0">
                        <button
                          onClick={() => void togglePhase(ph)}
                          className={cls('mt-0.5 shrink-0 transition-colors', done ? 'text-ok' : 'text-muted hover:text-text')}
                          title={done ? 'Mark pending' : 'Mark done'}
                        >
                          <CircleDot className="h-4 w-4" strokeWidth={2} />
                        </button>
                        <span className={cls('text-sm', done ? 'text-muted line-through' : 'text-text')}>{ph.title}</span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {/* Plan document */}
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Plan</h2>
              {editing ? (
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => {
                      setEditing(false);
                      setDraft(detail.body);
                    }}
                    className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-text"
                  >
                    <X className="h-3.5 w-3.5" strokeWidth={2} /> Cancel
                  </button>
                  <button
                    onClick={() => void saveBody()}
                    disabled={saving || draft === detail.body}
                    className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                  >
                    <Save className="h-3.5 w-3.5" strokeWidth={2} /> {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted transition-colors hover:text-text"
                >
                  <Pencil className="h-3.5 w-3.5" strokeWidth={2} /> Edit
                </button>
              )}
            </div>
            {editing ? (
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="h-[420px] w-full resize-y rounded-lg border border-border bg-panel2 p-3 font-mono text-[13px] leading-relaxed text-text outline-none focus:border-accent"
              />
            ) : (
              <div className="rounded-lg border border-border bg-panel px-4 py-3">
                <Markdown text={detail.body} />
              </div>
            )}

            {/* Citations */}
            {detail.citations.length > 0 && (
              <div className="mt-5">
                <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-muted">Citations</h2>
                <ul className="space-y-1 text-xs">
                  {detail.citations.map((c) => (
                    <li key={c.id} className="flex gap-2">
                      <span className="text-muted">[{c.id}]</span>
                      {c.url ? (
                        <a href={c.url} target="_blank" rel="noreferrer" className="text-accent underline">
                          {c.title}
                        </a>
                      ) : (
                        <span className="text-text">{c.title}</span>
                      )}
                      <span className="text-muted">({c.source})</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
