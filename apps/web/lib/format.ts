/**
 * Formatting helpers.
 *
 * Money and volume are formatted with `Intl` using the account's own currency,
 * because a copier can mix accounts in different deposit currencies and
 * inventing a base currency would silently lie about the numbers.
 */

export function money(value: number | null | undefined, currency = 'USD', options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: options.compact ? 0 : 2,
    maximumFractionDigits: options.compact ? 0 : 2,
    notation: options.compact ? 'compact' : 'standard',
  }).format(value);
}

/** Signed money, with an explicit `+` so profit direction is obvious. */
export function signedMoney(value: number | null | undefined, currency = 'USD'): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  const formatted = money(Math.abs(value), currency);
  if (value === 0) return formatted;
  return `${value > 0 ? '+' : '−'}${formatted}`;
}

export function number(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function percent(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${number(value, digits)}%`;
}

export function lots(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${number(value, 2)} lots`;
}

/** Prices keep the broker's own digit count, which we store per symbol. */
export function price(value: number | null | undefined, digits = 5): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function pips(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${number(value, digits)} pips`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const seconds = Math.round(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function dateTime(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export function shortDate(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: 'short', day: '2-digit' }).format(date);
}

/** "3s ago" / "in 2h" — used for heartbeat and staleness columns. */
export function relativeTime(value: string | Date | null | undefined, now: Date = new Date()): string {
  if (!value) return '—';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '—';
  const deltaSeconds = Math.round((date.getTime() - now.getTime()) / 1_000);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.348],
    ['month', 12],
    ['year', Number.POSITIVE_INFINITY],
  ];
  let remaining = Math.abs(deltaSeconds);
  let unitIndex = 0;
  let unit: Intl.RelativeTimeFormatUnit = 'second';
  for (const [candidate, divisor] of units) {
    unit = candidate;
    if (remaining < divisor) break;
    remaining /= divisor;
    unitIndex += 1;
    if (unitIndex >= units.length) break;
  }
  // Recompute the value in the chosen unit so the divisor chain stays honest.
  const value2 = signedRelativeValue(deltaSeconds, unit);
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(value2, unit);
}

function signedRelativeValue(deltaSeconds: number, unit: Intl.RelativeTimeFormatUnit): number {
  const divisors: Record<string, number> = {
    second: 1,
    minute: 60,
    hour: 3_600,
    day: 86_400,
    week: 604_800,
    month: 2_629_746,
    year: 31_556_952,
  };
  const divisor = divisors[unit] ?? 1;
  return Math.round(deltaSeconds / divisor);
}

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}
