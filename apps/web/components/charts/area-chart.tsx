'use client';

import { useId, useMemo, useState } from 'react';

/**
 * Equity curve.
 *
 * Hand-rolled SVG on purpose: the dashboard needs one line chart and a heatmap,
 * and pulling in a charting library for that would add ~100 kB to every page
 * for features we do not use. Points are laid out in a normalised viewBox so
 * the chart scales with its container without a resize observer.
 */
export interface AreaChartPoint {
  readonly at: string;
  readonly value: number;
}

export interface AreaChartProps {
  readonly points: readonly AreaChartPoint[];
  readonly height?: number;
  readonly formatValue?: (value: number) => string;
  readonly formatTime?: (value: string) => string;
  readonly label?: string;
}

export function AreaChart({ points, height = 220, formatValue, formatTime, label }: AreaChartProps) {
  const gradientId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = (max - min) * 0.08 || Math.max(Math.abs(max) * 0.01, 1);
    const lower = min - padding;
    const upper = max + padding;
    const span = upper - lower || 1;
    const step = points.length > 1 ? width / (points.length - 1) : width;
    const coords = points.map((point, index) => ({
      x: points.length > 1 ? index * step : width / 2,
      y: height - ((point.value - lower) / span) * height,
      point,
    }));
    const line = coords.map((coord, index) => `${index === 0 ? 'M' : 'L'}${coord.x.toFixed(2)},${coord.y.toFixed(2)}`).join(' ');
    const area = `${line} L${width},${height} L0,${height} Z`;
    return { coords, line, area, min: lower, max: upper, first: points[0]!, last: points[points.length - 1]! };
  }, [height, points]);

  if (!geometry) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        Not enough history yet — the first snapshot arrives a few minutes after the account connects.
      </div>
    );
  }

  const rising = geometry.last.value >= geometry.first.value;
  const stroke = rising ? 'var(--success)' : 'var(--destructive)';
  const active = hover !== null ? geometry.coords[hover] : null;
  const format = formatValue ?? ((value: number) => value.toFixed(2));
  const formatLabel = formatTime ?? ((value: string) => new Date(value).toLocaleDateString());

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-[220px] w-full touch-none"
        preserveAspectRatio="none"
        role="img"
        aria-label={label ?? 'Equity curve'}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const ratio = (event.clientX - rect.left) / rect.width;
          const index = Math.round(ratio * (geometry.coords.length - 1));
          setHover(Math.max(0, Math.min(geometry.coords.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.28" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((ratio) => (
          <line
            key={ratio}
            x1={0}
            x2={width}
            y1={height * ratio}
            y2={height * ratio}
            stroke="var(--border)"
            strokeWidth={1}
            strokeDasharray="4 6"
          />
        ))}
        <path d={geometry.area} fill={`url(#${gradientId})`} />
        <path d={geometry.line} fill="none" stroke={stroke} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {active ? (
          <g>
            <line x1={active.x} x2={active.x} y1={0} y2={height} stroke="var(--muted-foreground)" strokeWidth={1} />
            <circle cx={active.x} cy={active.y} r={4} fill={stroke} stroke="var(--background)" strokeWidth={2} />
          </g>
        ) : null}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-between text-[10px] text-muted-foreground">
        <span className="tabular">{format(geometry.max)}</span>
        <span className="tabular">{format(geometry.min)}</span>
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
        <span>{formatLabel(geometry.first.at)}</span>
        {active ? (
          <span className="tabular font-medium text-foreground">
            {format(active.point.value)} · {formatLabel(active.point.at)}
          </span>
        ) : null}
        <span>{formatLabel(geometry.last.at)}</span>
      </div>
    </div>
  );
}
