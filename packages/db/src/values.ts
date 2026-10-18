/** Numeric columns come back from `pg` as strings; convert at the boundary. */
export function toNum(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function toNumOrNull(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Serialises a JS number for a numeric column without scientific notation. */
export function fromNum(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  return value.toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
}

export function fromNumRequired(value: number): string {
  return fromNum(value) ?? '0';
}

/** Rounds a timestamp down to the minute (snapshot bucketing). */
export function toMinute(date: Date): Date {
  const copy = new Date(date.getTime());
  copy.setSeconds(0, 0);
  return copy;
}

export function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function fromJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return value as T;
}
