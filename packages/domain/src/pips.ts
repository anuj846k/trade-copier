import Decimal from 'decimal.js';
import { derivePipSize, lookupInstrument } from './instruments.js';
import type { TradeSide } from '@trade-copier/contracts';

Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP });

/**
 * Pip / point / price helpers.
 *
 * A "pip" here always means 10 points on odd-digit quotes and 1 point on
 * even-digit quotes — the MT4/MT5 convention. Broker metadata wins: when the
 * bridge reports a `pipSize`, that value is used verbatim.
 */
export interface SymbolMath {
  readonly digits: number;
  readonly point: number;
  readonly pipSize: number;
  readonly contractSize: number;
}

export interface SymbolMathInput {
  readonly symbol: string;
  readonly digits: number;
  readonly point: number;
  readonly pipSize?: number | undefined;
  readonly contractSize: number;
}

export function symbolMath(input: SymbolMathInput): SymbolMath {
  const digits = input.digits;
  const point = input.point > 0 ? input.point : new Decimal(10).pow(-digits).toNumber();
  const pipSize = input.pipSize && input.pipSize > 0 ? input.pipSize : derivePipSize(digits);
  const contractSize = input.contractSize > 0 ? input.contractSize : (lookupInstrument(input.symbol)?.contractSize ?? 100_000);
  return { digits, point, pipSize, contractSize };
}

/** Price distance expressed in pips. */
/**
 * Signed distance from `a` to `b` in pips: positive when `b` is above `a`.
 * Use `pipDistance` when only the magnitude matters (risk, tolerances, stops
 * away from the market); the sign is used to validate that a stop sits on the
 * correct side of its entry price.
 */
export function priceToPips(a: number, b: number, pipSize: number): number {
  return new Decimal(b).minus(a).dividedBy(pipSize).toNumber();
}

/** Magnitude of the distance between two prices, in pips. */
export function pipDistance(a: number, b: number, pipSize: number): number {
  return new Decimal(b).minus(a).abs().dividedBy(pipSize).toNumber();
}

/** Pip distance expressed as a price offset. */
export function pipsToPrice(pips: number, pipSize: number): number {
  return new Decimal(pips).times(pipSize).toNumber();
}

/**
 * Broker "deviation" is expressed in points, not pips. This is the single
 * conversion used before sending a command to an adapter.
 */
export function pointsFromPips(pips: number, pipSize: number, point: number): number {
  const priceDistance = pipsToPrice(pips, pipSize);
  return Math.round(new Decimal(priceDistance).dividedBy(point).toNumber());
}

/** Truncates/rounds a price to the symbol's digits (brokers reject extra precision). */
export function normalizePrice(price: number, digits: number): number {
  return new Decimal(price).toDecimalPlaces(digits, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * Applies a pip distance to a reference price in the direction of the trade.
 * `direction` is where the resulting level sits relative to the reference:
 *   - 'below' for buy stop-loss / sell take-profit
 *   - 'above' for sell stop-loss / buy take-profit
 */
export function applyPipDistance(
  reference: number,
  pips: number,
  pipSize: number,
  direction: 'above' | 'below',
  digits = 5,
): number {
  const delta = pipsToPrice(Math.abs(pips), pipSize);
  const raw = direction === 'above' ? new Decimal(reference).plus(delta) : new Decimal(reference).minus(delta);
  return normalizePrice(raw.toNumber(), digits);
}

/** Where SL must sit for a side. Used to validate broker-side "invalid stops". */
export function stopLossSideFor(side: TradeSide): 'above' | 'below' {
  return side === 'buy' ? 'below' : 'above';
}

export function takeProfitSideFor(side: TradeSide): 'above' | 'below' {
  return side === 'buy' ? 'above' : 'below';
}

/**
 * Value of one pip for a given volume, expressed in the symbol's *quote*
 * currency. For EURUSD, 1 lot => 10 USD per pip. For USDJPY, 1 lot => 1000 JPY
 * per pip, which must be converted to the account currency separately.
 */
export function pipValuePerLot(contractSize: number, pipSize: number): number {
  return new Decimal(contractSize).times(pipSize).toNumber();
}

export function pipValueForVolume(volume: number, contractSize: number, pipSize: number): number {
  return new Decimal(volume).times(contractSize).times(pipSize).toNumber();
}

/**
 * Currency conversion for risk sizing. Rates come from the quote cache
 * (bridge agents stream broker quotes); the converter handles direct, inverse
 * and USD-cross conversions.
 */
export interface RateSource {
  /** Returns the rate to multiply `from` amounts by to reach `to`. */
  rate(from: string, to: string): number | null;
}

export class StaticRateSource implements RateSource {
  constructor(private readonly rates: Record<string, number>) {}

  rate(from: string, to: string): number | null {
    if (from === to) return 1;
    const direct = this.rates[`${from}${to}`];
    if (direct && direct > 0) return direct;
    const inverse = this.rates[`${to}${from}`];
    if (inverse && inverse > 0) return 1 / inverse;
    const fromUsd = from === 'USD' ? 1 : (this.rates[`${from}USD`] ?? null);
    const usdTo = to === 'USD' ? 1 : (this.rates[`USD${to}`] ?? null);
    if (fromUsd && usdTo) return fromUsd * usdTo;
    const usdFrom = from === 'USD' ? 1 : (this.rates[`USD${from}`] ?? null);
    const toUsd = to === 'USD' ? 1 : (this.rates[`${to}USD`] ?? null);
    if (usdFrom && toUsd) return (1 / usdFrom) * (1 / toUsd);
    return null;
  }
}

export function convert(amount: number, from: string, to: string, rates: RateSource): number | null {
  const rate = rates.rate(from, to);
  if (rate === null) return null;
  return new Decimal(amount).times(rate).toNumber();
}

/** Quotes as a spread in pips. */
export function spreadPips(bid: number, ask: number, pipSize: number): number {
  return new Decimal(ask).minus(bid).abs().dividedBy(pipSize).toNumber();
}

/** Mid price — used when a decision needs a single reference price. */
export function midPrice(bid: number, ask: number): number {
  return new Decimal(bid).plus(ask).dividedBy(2).toNumber();
}

export { Decimal };
