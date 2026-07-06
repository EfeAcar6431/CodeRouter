import React from 'react';
import { X } from 'lucide-react';
import type { HeatmapDay, RecentRun } from '../lib/api';
import { ModelBadges } from './ModelBadges';
import { cls, money } from './common';

/** Local `YYYY-MM-DD` for a unix-ms timestamp (matches the daemon's heatmap keys). */
function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function prettyDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

/**
 * Panel shown when a heatmap day is selected: the day's headline totals plus
 * the runs recorded that day (filtered from the report's recent runs). Makes
 * the selection explicit with a labeled header and a clear button.
 */
export function DayDetail({
  date,
  day,
  runs,
  onClear,
}: {
  date: string;
  day: HeatmapDay | undefined;
  runs: RecentRun[];
  onClear: () => void;
}): React.ReactElement {
  const dayRuns = runs.filter((r) => localDateKey(r.createdAt) === date);
  const totalCost = day?.costUsd ?? dayRuns.reduce((s, r) => s + r.costUsd, 0);
  const totalRuns = day?.runs ?? dayRuns.length;
  const tokens = day?.tokens ?? 0;

  return (
    <div className="mt-3 rounded-lg border border-accent/40 bg-accent/5 p-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="rounded-full border border-accent/50 bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
          Selected
        </span>
        <span className="text-sm font-semibold text-text">{prettyDate(date)}</span>
        <span className="text-xs text-muted">
          {totalRuns} run{totalRuns === 1 ? '' : 's'} · {money(totalCost)}
          {tokens ? ` · ${fmtTokens(tokens)} tok` : ''}
        </span>
        <button
          onClick={onClear}
          title="Clear selection"
          className="ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-panel2 hover:text-text"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      {dayRuns.length === 0 ? (
        <div className="px-1 py-2 text-xs text-muted">
          {totalRuns > 0
            ? 'This day is outside the recent-runs window, so per-run detail is unavailable — totals above are still accurate.'
            : 'No activity on this day.'}
        </div>
      ) : (
        <div className="divide-y divide-border/60 overflow-hidden rounded-md border border-border/60 bg-panel">
          {dayRuns.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className="w-14 shrink-0 truncate text-xs text-muted">{r.mode}</span>
              <span className="min-w-0 flex-1 truncate" title={r.prompt}>{r.prompt}</span>
              <span className={cls('hidden shrink-0 lg:flex', 'w-56')}>
                <ModelBadges routes={r.routes?.length ? r.routes : r.route ? [r.route] : []} max={2} />
              </span>
              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">{money(r.costUsd)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
