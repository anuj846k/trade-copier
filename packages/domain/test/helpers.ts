import {
  followerSettingsSchema,
  type FollowerSettings,
  type SymbolInfo,
  type TradeFilters,
} from '@trade-copier/contracts';
import type { MasterEvent, MasterTradeSnapshot, PlanContext } from '../src/index.js';

/** Filter defaults identical to `tradeFiltersSchema.parse({})`. */
export const DEFAULT_TRADE_FILTERS: TradeFilters = {
  magic: { mode: 'all', values: [] },
  comment: { mode: 'all', values: [] },
  side: 'all',
  lot: { min: null, max: null },
  symbol: { mode: 'all', values: [] },
};

export function settings(overrides: Partial<FollowerSettings> = {}): FollowerSettings {
  return followerSettingsSchema.parse(overrides);
}

export function symbolInfo(overrides: Partial<SymbolInfo> = {}): SymbolInfo {
  const digits = overrides.digits ?? 5;
  const point = overrides.point ?? (digits === 5 ? 0.00001 : digits === 3 ? 0.001 : 0.01);
  return {
    name: 'EURUSD.a',
    canonical: 'EURUSD',
    assetClass: 'forex',
    digits,
    point,
    pipSize: overrides.pipSize ?? (digits === 5 || digits === 4 ? 0.0001 : 0.01),
    contractSize: 100_000,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    tradeMode: 'full',
    enabled: true,
    quoteCurrency: 'USD',
    maxLotPerOrder: null,
    swapLong: null,
    swapShort: null,
    ...overrides,
  };
}

export function masterSymbolInfo(overrides: Partial<SymbolInfo> = {}): Pick<SymbolInfo, 'digits' | 'point' | 'pipSize' | 'contractSize'> {
  const info = symbolInfo({ name: 'EURUSD', canonical: 'EURUSD', ...overrides });
  return { digits: info.digits, point: info.point, pipSize: info.pipSize, contractSize: info.contractSize };
}

export const FIXED_NOW = new Date('2026-03-04T10:00:00.000Z');

export function quote(overrides: { symbol?: string; bid?: number; ask?: number; at?: string } = {}) {
  return {
    symbol: overrides.symbol ?? 'EURUSD.a',
    bid: overrides.bid ?? 1.1,
    ask: overrides.ask ?? 1.10008,
    at: overrides.at ?? FIXED_NOW.toISOString(),
  };
}

export function masterSnapshot(overrides: Partial<MasterTradeSnapshot> = {}): MasterTradeSnapshot {
  return {
    ticket: '555000111',
    symbol: 'EURUSD',
    side: 'buy',
    volume: 0.1,
    closedVolume: 0,
    openPrice: 1.1,
    currentPrice: 1.1,
    stopLoss: null,
    takeProfit: null,
    magic: 42,
    comment: 'MyEA',
    kind: 'market',
    pendingType: null,
    expiry: null,
    openedAt: '2026-03-04T09:59:00.000Z',
    updatedAt: null,
    profit: null,
    swap: null,
    commission: null,
    ...overrides,
  };
}

export function openEvent(overrides: Partial<MasterTradeSnapshot> = {}): MasterEvent {
  return { kind: 'open', trade: masterSnapshot(overrides), at: FIXED_NOW };
}

export function closeEvent(overrides: Partial<MasterTradeSnapshot> = {}): MasterEvent {
  return { kind: 'close', trade: masterSnapshot({ ...overrides, volume: 0 }), at: FIXED_NOW };
}

export function partialCloseEvent(closedDelta: number, overrides: Partial<MasterTradeSnapshot> = {}): MasterEvent {
  return {
    kind: 'partial_close',
    trade: masterSnapshot(overrides),
    closedDeltaVolume: closedDelta,
    at: FIXED_NOW,
  };
}

export function modifyEvent(overrides: Partial<MasterTradeSnapshot> = {}): MasterEvent {
  return { kind: 'modify', trade: masterSnapshot(overrides), at: FIXED_NOW };
}

export function context(overrides: Partial<PlanContext> = {}): PlanContext {
  const slaveSymbol = 'slaveSymbol' in overrides ? (overrides.slaveSymbol ?? null) : symbolInfo();
  return {
    copierId: 'cop_1',
    copierStatus: 'enabled',
    followerId: 'fol_1',
    settings: settings(),
    account: {
      accountId: 'acc_slave',
      currency: 'USD',
      balance: 10_000,
      equity: 10_000,
      freeMargin: 10_000,
      leverage: 100,
      enabled: true,
      connected: true,
      disabledSymbols: [],
    },
    slaveSymbol,
    symbolResolution: {
      slaveSymbol: slaveSymbol?.name ?? null,
      strategy: slaveSymbol ? 'canonical' : 'unmapped',
      ambiguous: false,
      ...(slaveSymbol ? {} : { reason: 'No slave symbol resembles EURUSD' }),
    },
    masterSymbolInfo: masterSymbolInfo(),
    link: null,
    quotes: quote(),
    marketState: { open: true, reason: 'open', nextOpenAt: null, nextCloseAt: null },
    equityProtectionActive: false,
    now: FIXED_NOW,
    masterBalanceForRisk: 10_000,
    ...overrides,
  };
}
