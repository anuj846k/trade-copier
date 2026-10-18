import type { CopierErrorCode, FollowerSettings, TradeFilters, TradeSide } from '@trade-copier/contracts';

/**
 * Trade filters (FEATURES.md F33–F36, F38, F39). Pure predicates so the exact
 * same rules run in the engine, in tests and in the "why was this skipped"
 * explainer shown in the logs UI.
 */
export interface FilterSubject {
  readonly masterSymbol: string;
  readonly slaveSymbol?: string | null;
  readonly side: TradeSide;
  readonly volume: number;
  readonly magic: number;
  readonly comment: string;
}

export interface FilterOutcome {
  readonly allowed: boolean;
  readonly code?: CopierErrorCode;
  readonly detail?: string;
}

const ALLOWED: FilterOutcome = { allowed: true };

export function evaluateFilters(subject: FilterSubject, filters: TradeFilters): FilterOutcome {
  return (
    checkMagic(subject, filters) ??
    checkComment(subject, filters) ??
    checkSide(subject, filters) ??
    checkLot(subject, filters) ??
    checkSymbol(subject, filters) ??
    ALLOWED
  );
}

/** Magic filter: `copy` = allow-list, `ignore` = deny-list. */
function checkMagic(subject: FilterSubject, filters: TradeFilters): FilterOutcome | null {
  const { mode, values } = filters.magic;
  if (mode === 'all' || values.length === 0) return null;
  const contains = values.includes(subject.magic);
  if (mode === 'copy' && !contains) {
    return {
      allowed: false,
      code: 'FILTERED_MAGIC',
      detail: `Magic ${subject.magic} is not in the copy list [${values.join(', ')}]`,
    };
  }
  if (mode === 'ignore' && contains) {
    return { allowed: false, code: 'FILTERED_MAGIC', detail: `Magic ${subject.magic} is in the ignore list` };
  }
  return null;
}

/** Comment filter: case-insensitive substring match, mirroring the reference. */
function checkComment(subject: FilterSubject, filters: TradeFilters): FilterOutcome | null {
  const { mode, values } = filters.comment;
  if (mode === 'all' || values.length === 0) return null;
  const haystack = subject.comment.toLowerCase();
  const hit = values.find((needle) => haystack.includes(needle.toLowerCase()));
  if (mode === 'copy' && !hit) {
    return {
      allowed: false,
      code: 'FILTERED_COMMENT',
      detail: `Comment "${subject.comment}" matches none of [${values.join(', ')}]`,
    };
  }
  if (mode === 'ignore' && hit) {
    return { allowed: false, code: 'FILTERED_COMMENT', detail: `Comment "${subject.comment}" matches ignored "${hit}"` };
  }
  return null;
}

function checkSide(subject: FilterSubject, filters: TradeFilters): FilterOutcome | null {
  if (filters.side === 'all') return null;
  if (filters.side !== subject.side) {
    return { allowed: false, code: 'FILTERED_SIDE', detail: `Trade side ${subject.side} excluded by the side filter` };
  }
  return null;
}

/** Lot filter applies to the MASTER lot size (documented behaviour). */
function checkLot(subject: FilterSubject, filters: TradeFilters): FilterOutcome | null {
  const { min, max } = filters.lot;
  if (min !== null && subject.volume < min) {
    return { allowed: false, code: 'FILTERED_LOT', detail: `Master volume ${subject.volume} is below the filter minimum ${min}` };
  }
  if (max !== null && subject.volume > max) {
    return { allowed: false, code: 'FILTERED_LOT', detail: `Master volume ${subject.volume} is above the filter maximum ${max}` };
  }
  return null;
}

function checkSymbol(subject: FilterSubject, filters: TradeFilters): FilterOutcome | null {
  const { mode, values } = filters.symbol;
  if (mode === 'all' || values.length === 0) return null;
  const normalized = values.map((value) => value.toUpperCase());
  // The picker lists master symbols, but users often paste the slave name they
  // see in the terminal, so either side matches the filter.
  const named = [subject.masterSymbol, subject.slaveSymbol ?? ''];
  const listed = named.some((symbol) => symbol !== '' && normalized.includes(symbol.toUpperCase()));
  if (mode === 'include' && !listed) {
    return { allowed: false, code: 'FILTERED_SYMBOL', detail: `${subject.masterSymbol} is not in the included symbols` };
  }
  if (mode === 'exclude' && listed) {
    return { allowed: false, code: 'FILTERED_SYMBOL', detail: `${subject.masterSymbol} is excluded by the copier filter` };
  }
  return null;
}

/**
 * Account-level symbol toggle (F38). Disabled symbols are ignored entirely —
 * this happens before any planning so no command is ever generated.
 */
export function symbolEnabledOnAccount(symbol: string, disabledSymbols: readonly string[]): boolean {
  return !disabledSymbols.some((disabled) => disabled.toLowerCase() === symbol.toLowerCase());
}

/** Effective filters for a symbol, after applying any per-symbol override. */
export function effectiveFilters(settings: FollowerSettings): TradeFilters {
  return settings.filters;
}
