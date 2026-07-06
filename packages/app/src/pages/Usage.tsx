import React, { useEffect, useState } from 'react';
import { api, type Breakdown, type UsageReport } from '../lib/api';
import { Heatmap } from '../components/Heatmap';
import { DayDetail } from '../components/DayDetail';
import { Section, Spinner, money, timeAgo } from '../components/common';
import { ModelBadges } from '../components/ModelBadges';

export function UsagePage(): React.ReactElement {
  const [data, setData] = useState<UsageReport | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  useEffect(() => {
    void api.usage().then(setData).catch(() => {});
  }, []);
  if (!data) return <Spinner />;
  const t = data.totals;

  return (
    <div>
      <div className="mb-4 text-sm text-muted">
        Aggregated across {data.project.projectCount} project{data.project.projectCount === 1 ? '' : 's'} on this machine.
      </div>
      <div className="mb-6 grid grid-cols-4 gap-3">
        <Metric label="Runs" value={String(t.runs)} />
        <Metric label="Total cost" value={money(t.costUsd)} />
        <Metric label="This month" value={money(t.monthCostUsd)} />
        <Metric label="Success" value={`${Math.round(t.successRate * 100)}%`} />
      </div>

      <Section title="Activity">
        <div className="card">
          <Heatmap
            days={data.heatmap}
            selectedDate={selectedDate}
            onSelect={(d) => setSelectedDate((cur) => (cur === d ? null : d))}
          />
          {selectedDate ? (
            <DayDetail
              date={selectedDate}
              day={data.heatmap.find((x) => x.date === selectedDate)}
              runs={data.recentRuns}
              onClear={() => setSelectedDate(null)}
            />
          ) : (
            <div className="mt-3 text-xs text-muted/70">Click a day to see that day's chats and cost.</div>
          )}
        </div>
      </Section>

      <div className="grid gap-6 md:grid-cols-3">
        <BreakdownTable title="By mode" nameLabel="Mode" rows={data.byMode} />
        <BreakdownTable title="By provider" nameLabel="Provider · model" rows={data.byProvider} />
        <BreakdownTable title="By task type" nameLabel="Task type" rows={data.byTaskType} />
      </div>

      <Section title="Recent runs">
        <div className="card p-0 text-sm">
          <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">
            <span className="w-16 shrink-0">Mode</span>
            <span className="min-w-0 flex-1">Prompt</span>
            <span className="hidden w-64 shrink-0 lg:block">Models</span>
            <span className="w-16 shrink-0 text-right">Cost</span>
            <span className="w-16 shrink-0 text-right">When</span>
          </div>
          <div className="divide-y divide-border">
            {data.recentRuns.slice(0, 25).map((r) => (
              <div key={r.id} className="flex items-center gap-3 px-3 py-2">
                <span className="w-16 shrink-0 truncate text-xs text-muted">{r.mode}</span>
                <span className="min-w-0 flex-1 truncate" title={r.prompt}>{r.prompt}</span>
                <span className="hidden w-64 shrink-0 lg:flex">
                  <ModelBadges routes={r.routes?.length ? r.routes : r.route ? [r.route] : []} max={3} />
                </span>
                <span className="w-16 shrink-0 text-right text-xs tabular-nums">{money(r.costUsd)}</span>
                <span className="w-16 shrink-0 text-right text-xs text-muted">{timeAgo(r.createdAt)}</span>
              </div>
            ))}
          </div>
        </div>
      </Section>
    </div>
  );
}

/**
 * Split a route/provider label into its provider and model parts.
 * `byProvider` uses `provider · model`; recent-run routes use `provider,model`.
 */
function splitRoute(label: string): { provider: string; model: string } {
  const sep = label.includes(' · ') ? ' · ' : label.includes(',') ? ',' : '';
  if (!sep) return { provider: '', model: label };
  const idx = label.indexOf(sep);
  return { provider: label.slice(0, idx).trim(), model: label.slice(idx + sep.length).trim() };
}

/**
 * Renders a route so the model name is always legible: the provider is a
 * dim, shrinkable prefix while the model takes priority for width and only
 * ellipsizes as a last resort.
 */
function RouteLabel({ value }: { value: string }): React.ReactElement {
  const { provider, model } = splitRoute(value);
  if (!model) return <span className="min-w-0 flex-1 truncate" title={value}>{value || '—'}</span>;
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={value}>
      {provider && <span className="max-w-[6rem] shrink truncate text-[11px] text-muted/80">{provider}</span>}
      <span className="min-w-0 flex-1 truncate font-mono text-xs">{model}</span>
    </span>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="card">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
    </div>
  );
}

function BreakdownTable({ title, nameLabel, rows }: { title: string; nameLabel: string; rows: Breakdown[] }): React.ReactElement {
  const maxCost = Math.max(1e-9, ...rows.map((r) => r.costUsd));
  return (
    <Section title={title}>
      <div className="card p-0 text-sm">
        <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-muted">
          <span className="min-w-0 flex-1 truncate">{nameLabel}</span>
          <span className="w-10 shrink-0 text-right">Runs</span>
          <span className="w-16 shrink-0 text-right">Cost</span>
        </div>
        {rows.length === 0 && <div className="px-3 py-3 text-muted">No data yet.</div>}
        <div className="divide-y divide-border/60">
          {rows.map((r) => (
            <div key={r.key} className="px-3 py-2">
              <div className="flex items-center gap-3">
                <RouteLabel value={r.label} />
                <span className="w-10 shrink-0 text-right tabular-nums text-muted">{r.runs}</span>
                <span className="w-16 shrink-0 text-right tabular-nums">{money(r.costUsd)}</span>
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-panel2">
                <div className="h-full rounded-full bg-accent/70" style={{ width: `${(r.costUsd / maxCost) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </Section>
  );
}
