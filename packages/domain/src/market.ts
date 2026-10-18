import type { CopierErrorCode, TradeSide } from '@trade-copier/contracts';
import { midPrice, pipDistance, pointsFromPips, spreadPips } from './pips.js';

/**
 * Market-quality gates applied before an order is sent (FEATURES.md §1.2/§1.6
 * reasoning + documented OFF_QUOTES / REQUOTE / INVALID_PRICE behaviour).
 *
 * These are deliberately conservative: a stale or absurdly wide quote is a
 * worse outcome than a slightly late copy.
 */
export interface QuoteLike {
  readonly bid: number;
  readonly ask: number;
  readonly at: string;
}

export interface QuoteCheckInput {
  readonly quote: QuoteLike | null | undefined;
  readonly side: TradeSide;
  readonly pipSize: number;
  readonly point: number;
  readonly now: Date;
  readonly maxQuoteAgeMs: number;
  readonly maxSpreadPips: number | null;
}

export type QuoteCheckResult =
  | {
      readonly ok: true;
      /** Price we can realistically get: ask for buys, bid for sells. */
      readonly price: number;
      readonly mid: number;
      readonly spreadPips: number;
      readonly quoteAgeMs: number;
      /** Broker deviation (points) derived from the follower's pip tolerance. */
      readonly deviationPoints: number;
    }
  | { readonly ok: false; readonly code: CopierErrorCode; readonly detail: string };

export function checkQuote(input: QuoteCheckInput, maxSlippagePips: number): QuoteCheckResult {
  const { quote } = input;
  if (!quote || !(quote.bid > 0) || !(quote.ask > 0) || quote.ask < quote.bid) {
    return { ok: false, code: 'STALE_QUOTE', detail: 'No usable quote for the symbol' };
  }
  const age = input.now.getTime() - new Date(quote.at).getTime();
  if (!Number.isFinite(age) || age > input.maxQuoteAgeMs) {
    return {
      ok: false,
      code: 'STALE_QUOTE',
      detail: `Quote is ${Number.isFinite(age) ? `${age}ms` : 'invalid'} old (limit ${input.maxQuoteAgeMs}ms)`,
    };
  }
  const spread = spreadPips(quote.bid, quote.ask, input.pipSize);
  if (input.maxSpreadPips !== null && spread > input.maxSpreadPips) {
    return {
      ok: false,
      code: 'SPREAD_TOO_WIDE',
      detail: `Spread ${spread.toFixed(2)} pips exceeds the ${input.maxSpreadPips} pip limit`,
    };
  }
  return {
    ok: true,
    price: executablePrice(input.side, quote.bid, quote.ask),
    mid: midPrice(quote.bid, quote.ask),
    spreadPips: spread,
    quoteAgeMs: Math.max(0, age),
    deviationPoints: pointsFromPips(maxSlippagePips, input.pipSize, input.point),
  };
}

export function executablePrice(side: TradeSide, bid: number, ask: number): number {
  return side === 'buy' ? ask : bid;
}

/** How far a fill drifted from the intended price, in pips. */
export function fillSlippagePips(desired: number, filled: number, pipSize: number): number {
  // Deviation is a magnitude: brokers accept a buy filled above and a sell
  // filled below the request within the same tolerance.
  return pipDistance(desired, filled, pipSize);
}

export function slippageWithinTolerance(
  desired: number,
  filled: number,
  pipSize: number,
  tolerancePips: number,
): boolean {
  return fillSlippagePips(desired, filled, pipSize) <= tolerancePips + 1e-9;
}

/**
 * Validate a stop-loss / take-profit combination against the current market,
 * catching the documented `INVALID_SLTP` case before we bother the broker.
 */
export function validateStops(input: {
  side: TradeSide;
  stopLoss: number | null;
  takeProfit: number | null;
  referencePrice: number;
  /** Minimum broker stop distance in pips (0 for "not enforced"). */
  minStopDistancePips?: number | null;
  pipSize: number;
}): { ok: true } | { ok: false; code: CopierErrorCode; detail: string } {
  const { side, stopLoss, takeProfit, referencePrice, pipSize } = input;
  const minDistance = input.minStopDistancePips ?? 0;

  if (stopLoss !== null) {
    if (side === 'buy' && stopLoss >= referencePrice) {
      return { ok: false, code: 'INVALID_SLTP', detail: `Buy stop loss ${stopLoss} is at or above the market ${referencePrice}` };
    }
    if (side === 'sell' && stopLoss <= referencePrice) {
      return { ok: false, code: 'INVALID_SLTP', detail: `Sell stop loss ${stopLoss} is at or below the market ${referencePrice}` };
    }
    if (minDistance > 0 && pipDistance(referencePrice, stopLoss, pipSize) < minDistance - 1e-9) {
      return {
        ok: false,
        code: 'INVALID_SLTP',
        detail: `Stop loss is ${pipDistance(referencePrice, stopLoss, pipSize).toFixed(1)} pips away; broker requires ${minDistance}`,
      };
    }
  }

  if (takeProfit !== null) {
    if (side === 'buy' && takeProfit <= referencePrice) {
      return { ok: false, code: 'INVALID_SLTP', detail: `Buy take profit ${takeProfit} is at or below the market ${referencePrice}` };
    }
    if (side === 'sell' && takeProfit >= referencePrice) {
      return { ok: false, code: 'INVALID_SLTP', detail: `Sell take profit ${takeProfit} is at or above the market ${referencePrice}` };
    }
    if (minDistance > 0 && pipDistance(referencePrice, takeProfit, pipSize) < minDistance - 1e-9) {
      return {
        ok: false,
        code: 'INVALID_SLTP',
        detail: `Take profit is ${pipDistance(referencePrice, takeProfit, pipSize).toFixed(1)} pips away; broker requires ${minDistance}`,
      };
    }
  }

  return { ok: true };
}

/** Free-margin sanity check used to avoid the documented NO_MONEY rejection. */
export function hasSufficientMargin(input: {
  freeMargin: number;
  volume: number;
  contractSize: number;
  price: number;
  leverage: number | null;
  /** Extra buffer, e.g. 0.1 for 10% headroom. */
  bufferRatio?: number;
}): boolean {
  const leverage = input.leverage && input.leverage > 0 ? input.leverage : 100;
  const notional = input.volume * input.contractSize * input.price;
  const required = notional / leverage;
  const buffer = 1 + (input.bufferRatio ?? 0);
  return input.freeMargin + 1e-9 >= required * buffer;
}

/** Broker "trade mode" gate for a side. */
export function sideAllowedByTradeMode(
  tradeMode: 'full' | 'long_only' | 'short_only' | 'close_only' | 'disabled',
  side: TradeSide,
): boolean {
  switch (tradeMode) {
    case 'full':
      return true;
    case 'long_only':
      return side === 'buy';
    case 'short_only':
      return side === 'sell';
    case 'close_only':
    case 'disabled':
      return false;
    default:
      return true;
  }
}
