import React, { useState } from 'react';
import type { HeatmapDay } from '../lib/api';
import { cls } from './common';

type Hover = { day: HeatmapDay; x: number; y: number };

/**
 * GitHub-style contribution grid with a floating hover tooltip. When
 * `onSelect` is provided each cell is clickable and the `selectedDate` cell
 * is drawn with a bright accent ring so it's unmistakably "the selected day".
 */
export function Heatmap({
  days,
  selectedDate,
  onSelect,
}: {
  days: HeatmapDay[];
  selectedDate?: string | null;
  onSelect?: (date: string) => void;
}): React.ReactElement {
  const [hover, setHover] = useState<Hover | null>(null);

  if (!days || days.length === 0) return <div className="text-sm text-muted">No activity yet.</div>;

  const max = Math.max(1, ...days.map((d) => d.runs));
  const level = (runs: number): number => {
    if (runs === 0) return 0;
    const r = runs / max;
    if (r > 0.66) return 4;
    if (r > 0.33) return 3;
    if (r > 0.1) return 2;
    return 1;
  };
  const colors = ['bg-panel2', 'bg-accent/30', 'bg-accent/50', 'bg-accent/75', 'bg-accent'];

  const weeks: HeatmapDay[][] = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  const move = (e: React.MouseEvent, d: HeatmapDay): void => {
    setHover({ day: d, x: e.clientX, y: e.clientY });
  };

  return (
    <div className="relative">
      <div className="flex gap-[3px] overflow-x-auto">
        {weeks.map((w, wi) => (
          <div key={wi} className="flex flex-col gap-[3px]">
            {w.map((d) => {
              const selected = selectedDate === d.date;
              return (
                <div
                  key={d.date}
                  onMouseEnter={(e) => move(e, d)}
                  onMouseMove={(e) => move(e, d)}
                  onMouseLeave={() => setHover(null)}
                  onClick={onSelect ? () => onSelect(d.date) : undefined}
                  className={cls(
                    'h-[12px] w-[12px] rounded-[2px] transition-colors',
                    colors[level(d.runs)],
                    onSelect && 'cursor-pointer hover:ring-1 hover:ring-accent',
                    selected && 'ring-2 ring-accent ring-offset-1 ring-offset-panel',
                  )}
                />
              );
            })}
          </div>
        ))}
      </div>

      {hover && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-panel px-2.5 py-1.5 text-xs shadow-xl shadow-black/50"
          style={{ left: hover.x, top: hover.y - 8 }}
        >
          <div className="font-medium text-text">{formatDate(hover.day.date)}</div>
          <div className="text-muted">
            {hover.day.runs} run{hover.day.runs === 1 ? '' : 's'}
            {hover.day.tokens ? ` · ${fmtTokens(hover.day.tokens)} tok` : ''}
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
