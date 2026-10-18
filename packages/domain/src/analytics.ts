import Decimal from 'decimal.js';
import { DateTime } from 'luxon';
import type { ClosedTrade, TradeSide } from '@trade-copier/contracts';

/**
 * Account analytics (FEATURES.md F59–F61). Pure functions over the trade
 * history so the dashboard, the API and tests all agree on definitions.
 *
 * Definitions used (documented metric list in `trading-accounts/analytics`):
 *   win%      = closed trades with net profit > 0 / all closed trades
 *   lots      = sum of volumes of closed trades
 *   best/worst% = profit relative to the account balance at the time of the trade
 *   drawdown  = peak-to-trough of the equity series (absolute + % of peak)
 */
export interface EquityPoint {
  readonly at: string;
  readonly balance: number;
  readonly equity: number;
}

export interface OpenPositionLike {
  readonly symbol: string;
  readonly side: TradeSide;
  readonly volume: number;
  readonly profit?: number | null;
}

export interface AnalyticsInput {
  readonly currency: string;
  readonly balance: number;
  readonly equity: number;
  readonly closedTrades: readonly ClosedTrade[];
  readonly openPositions: readonly OpenPositionLike[];
  readonly equitySeries: readonly EquityPoint[];
  /** IANA timezone used to bucket the heatmap (the user's profile timezone). */
  readonly timezone?: string | undefined;
  /** Starting balance used for growth %; falls back to the first equity point. */
  readonly startingBalance?: number | undefined;
}

export interface AnalyticsResult {
  readonly currency: string;
  readonly balance: number;
  readonly equity: number;
  readonly growth: number;
  readonly growthPercent: number;
  readonly openPositions: number;
  readonly openVolume: number;
  readonly tradesTaken: number;
  readonly lotsTraded: number;
  readonly winRate: number;
  readonly lossRate: number;
  readonly longsWonRate: number;
  readonly shortsWonRate: number;
  readonly bestTrade: { profit: number; percent: number };
  readonly worstTrade: { profit: number; percent: number };
  readonly averageWinPercent: number;
  readonly averageLossPercent: number;
  readonly profitFactor: number | null;
  readonly expectancy: number;
  readonly maxDrawdown: { absolute: number; percent: number };
  readonly netProfit: number;
  readonly equitySeries: EquityPoint[];
  readonly heatmap: Array<{ weekday: number; hour: number; trades: number; profit: number }>;
}

export function netProfitOf(trade: ClosedTrade): number {
  return new Decimal(trade.profit).plus(trade.swap ?? 0).plus(trade.commission ?? 0).toNumber();
}

export function computeAnalytics(input: AnalyticsInput): AnalyticsResult {
  const trades = input.closedTrades.map((trade) => ({ trade, net: netProfitOf(trade) }));
  const tradesTaken = trades.length;
  const lotsTraded = trades.reduce((sum, entry) => sum + entry.trade.volume, 0);

  const wins = trades.filter((entry) => entry.net > 0);
  const losses = trades.filter((entry) => entry.net < 0);
  const winRate = tradesTaken === 0 ? 0 : (wins.length / tradesTaken) * 100;
  const lossRate = tradesTaken === 0 ? 0 : (losses.length / tradesTaken) * 100;

  const longs = trades.filter((entry) => entry.trade.side === 'buy');
  const shorts = trades.filter((entry) => entry.trade.side === 'sell');
  const longsWonRate = longs.length === 0 ? 0 : (longs.filter((entry) => entry.net > 0).length / longs.length) * 100;
  const shortsWonRate = shorts.length === 0 ? 0 : (shorts.filter((entry) => entry.net > 0).length / shorts.length) * 100;

  const startingBalance = input.startingBalance ?? input.equitySeries[0]?.balance ?? 0;
  const percentOf = (profit: number): number => (startingBalance > 0 ? (profit / startingBalance) * 100 : 0);

  const best = trades.reduce<{ trade: ClosedTrade; net: number } | null>(
    (acc, entry) => (acc === null || entry.net > acc.net ? entry : acc),
    null,
  );
  const worst = trades.reduce<{ trade: ClosedTrade; net: number } | null>(
    (acc, entry) => (acc === null || entry.net < acc.net ? entry : acc),
    null,
  );

  const grossProfit = wins.reduce((sum, entry) => sum + entry.net, 0);
  const grossLoss = Math.abs(losses.reduce((sum, entry) => sum + entry.net, 0));
  const netProfit = trades.reduce((sum, entry) => sum + entry.net, 0);

  const averageWinPercent = wins.length === 0 ? 0 : wins.reduce((sum, entry) => sum + percentOf(entry.net), 0) / wins.length;
  const averageLossPercent = losses.length === 0 ? 0 : losses.reduce((sum, entry) => sum + percentOf(entry.net), 0) / losses.length;

  const growth = new Decimal(input.balance).minus(startingBalance).toNumber();
  const growthPercent = startingBalance > 0 ? (growth / startingBalance) * 100 : 0;

  return {
    currency: input.currency,
    balance: input.balance,
    equity: input.equity,
    growth,
    growthPercent,
    openPositions: input.openPositions.length,
    openVolume: input.openPositions.reduce((sum, position) => sum + position.volume, 0),
    tradesTaken,
    lotsTraded,
    winRate,
    lossRate,
    longsWonRate,
    shortsWonRate,
    bestTrade: { profit: best?.net ?? 0, percent: percentOf(best?.net ?? 0) },
    worstTrade: { profit: worst?.net ?? 0, percent: percentOf(worst?.net ?? 0) },
    averageWinPercent,
    averageLossPercent,
    profitFactor: grossLoss === 0 ? null : grossProfit / grossLoss,
    expectancy: tradesTaken === 0 ? 0 : netProfit / tradesTaken,
    maxDrawdown: maxDrawdown(input.equitySeries),
    netProfit,
    equitySeries: [...input.equitySeries],
    heatmap: buildHeatmap(trades.map((entry) => ({ closedAt: entry.trade.closedAt, profit: entry.net })), input.timezone ?? 'UTC'),
  };
}

export function maxDrawdown(series: readonly EquityPoint[]): { absolute: number; percent: number } {
  let peak = 0;
  let worstAbsolute = 0;
  let worstPercent = 0;
  for (const point of series) {
    // Drawdown is measured on the equity curve (floating P/L included); the
    // balance is only a fallback for snapshots that carry no equity.
    const value = point.equity > 0 ? point.equity : point.balance;
    if (series.indexOf(point) === 0 || value > peak) {
      peak = value;
      continue;
    }
    if (peak <= 0) continue;
    const absolute = peak - value;
    if (absolute > worstAbsolute) worstAbsolute = absolute;
    const percent = (absolute / peak) * 100;
    if (percent > worstPercent) worstPercent = percent;
  }
  return { absolute: worstAbsolute, percent: worstPercent };
}

export function buildHeatmap(
  trades: readonly { closedAt: string; profit: number }[],
  timezone: string,
): Array<{ weekday: number; hour: number; trades: number; profit: number }> {
  const buckets = new Map<string, { weekday: number; hour: number; trades: number; profit: number }>();
  for (const trade of trades) {
    const local = DateTime.fromISO(trade.closedAt, { zone: 'utc' }).setZone(timezone);
    if (!local.isValid) continue;
    const key = `${local.weekday}-${local.hour}`;
    const bucket = buckets.get(key) ?? { weekday: local.weekday, hour: local.hour, trades: 0, profit: 0 };
    bucket.trades += 1;
    bucket.profit += trade.profit;
    buckets.set(key, bucket);
  }
  return Array.from(buckets.values()).sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
}

/** Rolling account-growth series used by the dashboard sparkline. */
export function cumulativeEquity(series: readonly EquityPoint[]): EquityPoint[] {
  return [...series].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}
