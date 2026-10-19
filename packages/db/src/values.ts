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

/**
 * Coerces a raw-SQL value into a `Date`.
 *
 * `db.execute(sql\`…\`)` hands back the driver's *unparsed* values — jsonb is
 * already an object, integers are numbers, but `timestamptz` arrives as
 * Postgres' text form (`2026-10-19 05:41:48.243+00`), which is not ISO-8601 and
 * which V8 would silently read as local time. Drizzle applies its own type
 * mapping only to schema-aware queries, so every raw claim/mapper goes through
 * here instead.
 */
export function toTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  if (typeof value === 'string' && value.length > 0) {
    // "2026-10-19 05:41:48.243+00" → "2026-10-19T05:41:48.243+00:00"
    const normalised = value.replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
    const parsed = new Date(normalised);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  throw new Error(`Cannot read ${JSON.stringify(value)} as a timestamp`);
}

/** Same as {@link toTimestamp}, for genuinely nullable columns. */
export function toTimestampOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return toTimestamp(value);
}
