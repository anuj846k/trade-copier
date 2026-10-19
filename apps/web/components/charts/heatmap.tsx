'use client';

/**
 * Weekday × hour performance heatmap.
 *
 * Intensity is derived from absolute profit relative to the best cell, so the
 * pattern (when the strategy actually works) is visible even when the values
 * are small. Cell tooltips are plain `title` attributes; anything fancier would
 * cost more code than it is worth here.
 */
export interface HeatmapCell {
  readonly weekday: number;
  readonly hour: number;
  readonly trades: number;
  readonly profit: number;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Heatmap({ cells, formatValue }: { cells: readonly HeatmapCell[]; formatValue?: (value: number) => string }) {
  const byKey = new Map(cells.map((cell) => [`${cell.weekday}-${cell.hour}`, cell]));
  const max = Math.max(1, ...cells.map((cell) => Math.abs(cell.profit)));
  const hours = Array.from({ length: 24 }, (_, hour) => hour);

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[620px]">
        <div className="flex gap-1 pl-10 text-[10px] text-muted-foreground">
          {hours.map((hour) => (
            <span key={hour} className="w-4 text-center">
              {hour % 3 === 0 ? hour : ''}
            </span>
          ))}
        </div>
        {WEEKDAYS.map((label, weekdayIndex) => (
          <div key={label} className="mt-1 flex items-center gap-1">
            <span className="w-9 text-[10px] text-muted-foreground">{label}</span>
            {hours.map((hour) => {
              const cell = byKey.get(`${weekdayIndex}-${hour}`);
              const intensity = cell ? Math.min(1, Math.abs(cell.profit) / max) : 0;
              const positive = (cell?.profit ?? 0) >= 0;
              return (
                <span
                  key={hour}
                  title={
                    cell
                      ? `${label} ${String(hour).padStart(2, '0')}:00 — ${cell.trades} trade(s), ${formatValue ? formatValue(cell.profit) : cell.profit}`
                      : `${label} ${String(hour).padStart(2, '0')}:00 — no trades`
                  }
                  className="h-4 w-4 rounded-[3px] border border-border/60"
                  style={{
                    backgroundColor:
                      !cell || cell.trades === 0
                        ? 'var(--muted)'
                        : positive
                          ? `color-mix(in oklab, var(--success) ${Math.round(intensity * 85) + 10}%, var(--muted))`
                          : `color-mix(in oklab, var(--destructive) ${Math.round(intensity * 85) + 10}%, var(--muted))`,
                  }}
                />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
