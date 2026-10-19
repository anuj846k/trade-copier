'use client';

/**
 * Tiny inline trend line for stat cards.
 *
 * Colours itself by the direction of the series, so a glance is enough: no
 * axis, no tooltip, no interaction.
 */
export function Sparkline({
  values,
  width = 120,
  height = 32,
  className,
}: {
  values: readonly number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return <div className={className} style={{ height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const step = width / (values.length - 1);
  const path = values
    .map((value, index) => `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(2)},${(height - ((value - min) / span) * height).toFixed(2)}`)
    .join(' ');
  const rising = values[values.length - 1]! >= values[0]!;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className={className} aria-hidden>
      <path d={path} fill="none" stroke={rising ? 'var(--success)' : 'var(--destructive)'} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}
