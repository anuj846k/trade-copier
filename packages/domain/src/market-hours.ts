import { DateTime, Interval } from 'luxon';
import type { AssetClass, TradingWindow } from '@trade-copier/contracts';
import { classifyAssetClass } from './instruments.js';

/**
 * Market-hours awareness.
 *
 * Two distinct rules that are easy to confuse and are therefore modelled
 * separately:
 *
 *  1. `isMarketOpen` — can the broker accept an order for this instrument at
 *     this instant? (FX week, daily rollover break, per-asset-class sessions.)
 *     Used to decide whether to send now or defer.
 *  2. `withinTradingHours` — has the *user* configured a copy window for this
 *     slave? (docs `trade-copier/trading-hours`.) Outside the window new trades
 *     are skipped, but modifications and closes still flow.
 */
export interface MarketSessionConfig {
  /** FX week open, as an ISO weekday + HH:mm in UTC. 7 = Sunday. */
  readonly fxWeekOpen: { readonly weekday: number; readonly time: string };
  /** FX week close. 5 = Friday. */
  readonly fxWeekClose: { readonly weekday: number; readonly time: string };
  /** Daily broker maintenance / rollover break. Set start === end to disable. */
  readonly dailyBreak: { readonly start: string; readonly end: string };
  /** Fixed dates (UTC `YYYY-MM-DD`) where FX is closed, e.g. New Year. */
  readonly holidays: readonly string[];
}

export const DEFAULT_MARKET_SESSION: MarketSessionConfig = {
  fxWeekOpen: { weekday: 7, time: '21:00' },
  fxWeekClose: { weekday: 5, time: '21:00' },
  dailyBreak: { start: '21:00', end: '22:00' },
  holidays: ['01-01', '12-25', '12-26'],
};

export interface MarketState {
  readonly open: boolean;
  /** When the venue is closed, the next instant it opens (ISO, UTC). */
  readonly nextOpenAt: string | null;
  /** When the venue closes next (ISO, UTC) — null when unknown. */
  readonly nextCloseAt: string | null;
  readonly reason: 'open' | 'weekend' | 'daily_break' | 'holiday' | 'asset_session_closed' | 'always_open';
}

export interface MarketHoursInput {
  readonly symbol: string;
  readonly at: Date;
  readonly config?: Partial<MarketSessionConfig> | undefined;
  readonly assetClass?: AssetClass | undefined;
}

/**
 * Session windows per asset class (UTC, ISO weekday 1-7). FX and metals run the
 * FX week; indices/energy/stocks have narrower windows; crypto is 24/7.
 * Broker schedules vary — this is a sane default that operators can override
 * per account via `MarketSessionConfig`.
 */
const ASSET_SESSIONS: Partial<Record<AssetClass, readonly { weekday: number; start: string; end: string }[]>> = {
  index: [
    { weekday: 1, start: '00:00', end: '21:15' },
    { weekday: 2, start: '00:00', end: '21:15' },
    { weekday: 3, start: '00:00', end: '21:15' },
    { weekday: 4, start: '00:00', end: '21:15' },
    { weekday: 5, start: '00:00', end: '21:15' },
  ],
  energy: [
    { weekday: 1, start: '22:00', end: '23:59' },
    { weekday: 2, start: '00:00', end: '21:59' },
    { weekday: 3, start: '00:00', end: '21:59' },
    { weekday: 4, start: '00:00', end: '21:59' },
    { weekday: 5, start: '00:00', end: '21:59' },
    { weekday: 7, start: '22:00', end: '23:59' },
  ],
  stock: [
    { weekday: 1, start: '13:30', end: '20:00' },
    { weekday: 2, start: '13:30', end: '20:00' },
    { weekday: 3, start: '13:30', end: '20:00' },
    { weekday: 4, start: '13:30', end: '20:00' },
    { weekday: 5, start: '13:30', end: '20:00' },
  ],
};

export function isMarketOpen(input: MarketHoursInput): MarketState {
  const config: MarketSessionConfig = { ...DEFAULT_MARKET_SESSION, ...input.config };
  const utc = DateTime.fromJSDate(input.at, { zone: 'utc' });
  const assetClass = input.assetClass ?? classifyAssetClass(input.symbol);

  if (assetClass === 'crypto') {
    return { open: true, nextOpenAt: null, nextCloseAt: null, reason: 'always_open' };
  }

  const isoWeekday = utc.weekday; // 1=Mon … 7=Sun
  const hhmm = utc.toFormat('HH:mm');
  const monthDay = utc.toFormat('MM-dd');

  if (config.holidays.includes(monthDay)) {
    return {
      open: false,
      nextOpenAt: nextSessionStart(utc, config),
      nextCloseAt: null,
      reason: 'holiday',
    };
  }

  // --- FX / metals: the FX week with a daily rollover break ---------------
  if (assetClass === 'forex' || assetClass === 'metal' || assetClass === 'unknown') {
    if (!isWithinFxWeek(isoWeekday, hhmm, config)) {
      return { open: false, nextOpenAt: nextSessionStart(utc, config), nextCloseAt: null, reason: 'weekend' };
    }
    if (isDailyBreak(hhmm, config)) {
      return { open: false, nextOpenAt: endOfDailyBreak(utc, config), nextCloseAt: null, reason: 'daily_break' };
    }
    return { open: true, nextOpenAt: null, nextCloseAt: nextFxClose(utc, config), reason: 'open' };
  }

  // --- indices / energy / stocks: their own windows ----------------------
  const sessions = ASSET_SESSIONS[assetClass];
  if (!sessions) {
    return { open: true, nextOpenAt: null, nextCloseAt: null, reason: 'always_open' };
  }
  const active = sessions.find((session) => session.weekday === isoWeekday && hhmm >= session.start && hhmm < session.end);
  if (active) {
    const closeAt = utc.set({ hour: Number(active.end.slice(0, 2)), minute: Number(active.end.slice(3, 5)) });
    return { open: true, nextOpenAt: null, nextCloseAt: closeAt.toISO() ?? null, reason: 'open' };
  }
  return {
    open: false,
    nextOpenAt: nextAssetSessionStart(utc, sessions),
    nextCloseAt: null,
    reason: 'asset_session_closed',
  };
}

function isWithinFxWeek(weekday: number, hhmm: string, config: MarketSessionConfig): boolean {
  const open = config.fxWeekOpen;
  const close = config.fxWeekClose;
  if (open.weekday === close.weekday) return hhmm >= open.time && hhmm < close.time;
  if (open.weekday < close.weekday) {
    // Week entirely inside the 7-day cycle, e.g. Monday 00:00 → Friday 21:00.
    if (weekday < open.weekday || weekday > close.weekday) return false;
  } else if (weekday > close.weekday && weekday < open.weekday) {
    // Week wraps the end of the ISO cycle: Sun 21:00 → Fri 21:00 closes
    // Saturday and the hours before the Sunday open.
    return false;
  }
  if (weekday === open.weekday) return hhmm >= open.time;
  if (weekday === close.weekday) return hhmm < close.time;
  return true;
}

function isDailyBreak(hhmm: string, config: MarketSessionConfig): boolean {
  const { start, end } = config.dailyBreak;
  if (start === end) return false;
  if (start < end) return hhmm >= start && hhmm < end;
  return hhmm >= start || hhmm < end; // window crossing midnight
}

function endOfDailyBreak(from: DateTime, config: MarketSessionConfig): string | null {
  const [hour = '0', minute = '0'] = config.dailyBreak.end.split(':');
  const at = from.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
  const result = at <= from ? at.plus({ days: 1 }) : at;
  return result.toUTC().toISO();
}

function nextFxClose(from: DateTime, config: MarketSessionConfig): string | null {
  const [hour = '0', minute = '0'] = config.fxWeekClose.time.split(':');
  let candidate = from.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
  while (candidate.weekday !== config.fxWeekClose.weekday || candidate <= from) {
    candidate = candidate.plus({ days: 1 });
  }
  return candidate.toUTC().toISO();
}

function nextSessionStart(from: DateTime, config: MarketSessionConfig): string | null {
  const [hour = '0', minute = '0'] = config.fxWeekOpen.time.split(':');
  let candidate = from.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
  let guard = 0;
  while ((candidate.weekday !== config.fxWeekOpen.weekday || candidate <= from) && guard < 10) {
    candidate = candidate.plus({ days: 1 });
    guard += 1;
  }
  return candidate.toUTC().toISO();
}

function nextAssetSessionStart(from: DateTime, sessions: readonly { weekday: number; start: string }[]): string | null {
  for (let offset = 0; offset < 8; offset += 1) {
    const day = from.plus({ days: offset });
    const candidates = sessions
      .filter((session) => session.weekday === day.weekday)
      .map((session) => {
        const [hour = '0', minute = '0'] = session.start.split(':');
        return day.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
      })
      .filter((candidate) => candidate > from)
      .sort((a, b) => a.toMillis() - b.toMillis());
    const first = candidates[0];
    if (first) return first.toUTC().toISO();
  }
  return null;
}

// ---------------------------------------------------------------------------
// User-configured trading hours
// ---------------------------------------------------------------------------

export interface TradingHoursInput {
  readonly windows: readonly TradingWindow[];
  readonly timezone: string;
  readonly at: Date;
}

/**
 * True when `at` falls inside one of the configured windows in the user's
 * timezone (docs: "trading hours are based on your configured timezone").
 * DST is handled by resolving the local wall-clock time with Luxon.
 */
export function withinTradingHours(input: TradingHoursInput): boolean {
  if (input.windows.length === 0) return true;
  const local = DateTime.fromJSDate(input.at, { zone: input.timezone });
  if (!local.isValid) return true; // unknown timezone: fail open, never block copying silently
  const hhmm = local.toFormat('HH:mm');
  const weekday = local.weekday;
  const previousWeekday = ((weekday + 5) % 7) + 1; // Mon -> Sun, Tue -> Mon, …
  return input.windows.some((window) => {
    if (window.start === window.end) return window.day === weekday; // full-day window
    if (window.start < window.end) {
      return window.day === weekday && hhmm >= window.start && hhmm < window.end;
    }
    // Window crossing midnight: its own day covers [start, 24:00) and the
    // following day covers [00:00, end) — Monday 22:00–02:00 includes
    // Tuesday 01:00.
    if (window.day === weekday && hhmm >= window.start) return true;
    if (window.day === previousWeekday && hhmm < window.end) return true;
    return false;
  });
}

/** Next instant the user's window opens, in the given timezone (ISO). */
export function nextTradingWindowStart(input: Omit<TradingHoursInput, 'at'> & { at: Date }): string | null {
  if (input.windows.length === 0) return null;
  const local = DateTime.fromJSDate(input.at, { zone: input.timezone });
  if (!local.isValid) return null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const day = local.plus({ days: offset });
    const candidates = input.windows
      .filter((window) => window.day === day.weekday)
      .map((window) => {
        const [hour = '0', minute = '0'] = window.start.split(':');
        return day.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
      })
      .filter((candidate) => candidate > local)
      .sort((a, b) => a.toMillis() - b.toMillis());
    const first = candidates[0];
    if (first) return first.toUTC().toISO();
  }
  return null;
}

/**
 * Daily reset instant used by Equity Protection (docs: "the time in which your
 * balance and equity values are updated daily").
 */
export function dailyResetInstant(resetTime: string, timezone: string, at: Date): Date {
  const local = DateTime.fromJSDate(at, { zone: timezone });
  const [hour = '0', minute = '0'] = resetTime.split(':');
  let candidate = local.set({ hour: Number(hour), minute: Number(minute), second: 0, millisecond: 0 });
  if (candidate > local) candidate = candidate.minus({ days: 1 });
  return candidate.toUTC().toJSDate();
}

export function tradingHoursIntervalFor(days: readonly number[]): Interval | null {
  if (days.length === 0) return null;
  const sorted = [...days].sort((a, b) => a - b);
  const start = DateTime.fromObject({ year: 2024, month: 1, day: 1 }).plus({ days: (sorted[0] ?? 1) - 1 });
  const end = DateTime.fromObject({ year: 2024, month: 1, day: 1 }).plus({ days: (sorted[sorted.length - 1] ?? 1) - 1 });
  return Interval.fromDateTimes(start, end.plus({ days: 1 }));
}
