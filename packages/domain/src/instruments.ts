import type { AssetClass } from '@trade-copier/contracts';

/**
 * Instrument reference data.
 *
 * Everything here is *derivable* from broker metadata (`SymbolInfo`), which is
 * authoritative. This table exists for three cases:
 *   1. the bridge adapter cannot report pip size (some platforms only give digits),
 *   2. auto-mapping needs to know that GOLD and XAUUSD are the same market,
 *   3. asset-class based market-hours rules need to classify a symbol.
 *
 * Conventions used for pip size (matches common MT4/MT5 practice):
 *   pip = 10 points on odd-digit quotes (5-digit EURUSD: 0.00010, 3-digit USDJPY: 0.010)
 *   pip =  1 point  on even-digit quotes (4-digit EURUSD: 0.0001, 2-digit XAUUSD: 0.01)
 */
export interface InstrumentSpec {
  readonly canonical: string;
  readonly assetClass: AssetClass;
  readonly digits: number;
  readonly point: number;
  readonly pipSize: number;
  readonly contractSize: number;
  readonly quoteCurrency: string;
  /** Broker-specific names that mean the same instrument. */
  readonly aliases: readonly string[];
}

const spec = (
  canonical: string,
  assetClass: AssetClass,
  digits: number,
  contractSize: number,
  quoteCurrency: string,
  aliases: readonly string[] = [],
): InstrumentSpec => {
  const point = Number((10 ** -digits).toFixed(10));
  const pipSize = Number(((digits % 2 === 0 ? point : point * 10)).toFixed(10));
  return { canonical, assetClass, digits, point, pipSize, contractSize, quoteCurrency, aliases };
};

/** Derived from digits only — used when a symbol is unknown to the table. */
export function derivePipSize(digits: number): number {
  const point = 10 ** -digits;
  return Number((digits % 2 === 0 ? point : point * 10).toFixed(10));
}

export function derivePoint(digits: number): number {
  return Number((10 ** -digits).toFixed(10));
}

const FX_MAJORS: ReadonlyArray<readonly [string, string, string]> = [
  ['EURUSD', 'EUR', 'USD'],
  ['GBPUSD', 'GBP', 'USD'],
  ['AUDUSD', 'AUD', 'USD'],
  ['NZDUSD', 'NZD', 'USD'],
  ['USDJPY', 'USD', 'JPY'],
  ['USDCHF', 'USD', 'CHF'],
  ['USDCAD', 'USD', 'CAD'],
  ['USDSEK', 'USD', 'SEK'],
  ['USDNOK', 'USD', 'NOK'],
  ['USDMXN', 'USD', 'MXN'],
  ['USDTRY', 'USD', 'TRY'],
  ['USDZAR', 'USD', 'ZAR'],
  ['USDHKD', 'USD', 'HKD'],
  ['USDSGD', 'USD', 'SGD'],
  ['USDCNH', 'USD', 'CNH'],
  ['EURGBP', 'EUR', 'GBP'],
  ['EURJPY', 'EUR', 'JPY'],
  ['EURCHF', 'EUR', 'CHF'],
  ['EURCAD', 'EUR', 'CAD'],
  ['EURAUD', 'EUR', 'AUD'],
  ['EURNZD', 'EUR', 'NZD'],
  ['EURSEK', 'EUR', 'SEK'],
  ['EURNOK', 'EUR', 'NOK'],
  ['EURPLN', 'EUR', 'PLN'],
  ['EURHUF', 'EUR', 'HUF'],
  ['EURCZK', 'EUR', 'CZK'],
  ['EURTRY', 'EUR', 'TRY'],
  ['GBPJPY', 'GBP', 'JPY'],
  ['GBPCHF', 'GBP', 'CHF'],
  ['GBPCAD', 'GBP', 'CAD'],
  ['GBPAUD', 'GBP', 'AUD'],
  ['GBPNZD', 'GBP', 'NZD'],
  ['GBPSEK', 'GBP', 'SEK'],
  ['AUDJPY', 'AUD', 'JPY'],
  ['AUDCHF', 'AUD', 'CHF'],
  ['AUDCAD', 'AUD', 'CAD'],
  ['AUDNZD', 'AUD', 'NZD'],
  ['AUDSEK', 'AUD', 'SEK'],
  ['NZDJPY', 'NZD', 'JPY'],
  ['NZDCHF', 'NZD', 'CHF'],
  ['NZDCAD', 'NZD', 'CAD'],
  ['CADJPY', 'CAD', 'JPY'],
  ['CADCHF', 'CAD', 'CHF'],
  ['CHFJPY', 'CHF', 'JPY'],
  ['SGDJPY', 'SGD', 'JPY'],
  ['ZARJPY', 'ZAR', 'JPY'],
  ['NOKSEK', 'NOK', 'SEK'],
  ['SEKJPY', 'SEK', 'JPY'],
];

/** Exotic-quote FX pairs are all 3- or 2-decimal; JPY quotes get 3 decimals. */
export const FX_MAJORS_TABLE: ReadonlyArray<InstrumentSpec> = FX_MAJORS.map(([canonical, _base, quote]) =>
  spec(canonical, 'forex', quote === 'JPY' || quote === 'HUF' ? 3 : 5, 100_000, quote),
);

export const METALS: ReadonlyArray<InstrumentSpec> = [
  spec('XAUUSD', 'metal', 2, 100, 'USD', ['GOLD', 'GOLDUSD', 'XAU', 'XAUUSD.']),
  spec('XAGUSD', 'metal', 3, 5_000, 'USD', ['SILVER', 'SILVERUSD', 'XAG']),
  spec('XPTUSD', 'metal', 2, 100, 'USD', ['PLATINUM']),
  spec('XPDUSD', 'metal', 2, 100, 'USD', ['PALLADIUM']),
];

export const INDICES: ReadonlyArray<InstrumentSpec> = [
  spec('US30', 'index', 1, 1, 'USD', ['DOW', 'DOW30', 'DJI', 'DJIA', 'WS30', 'YM', 'USA30', 'US30CASH']),
  spec('NAS100', 'index', 1, 1, 'USD', ['USTEC', 'US100', 'NDX', 'NAS100CASH', 'TECH100', 'USNAS100']),
  spec('SPX500', 'index', 1, 1, 'USD', ['US500', 'SP500', 'SPX', 'USA500', 'SPX500CASH']),
  spec('GER40', 'index', 1, 1, 'EUR', ['DE40', 'DAX', 'DAX40', 'GER30', 'DE30', 'GER40CASH']),
  spec('UK100', 'index', 1, 1, 'GBP', ['FTSE', 'FTSE100', 'UK100CASH', 'GB100']),
  spec('FRA40', 'index', 1, 1, 'EUR', ['CAC40', 'FR40', 'FRA40CASH']),
  spec('EU50', 'index', 1, 1, 'EUR', ['STOXX50', 'EUSTX50', 'ESTX50', 'EURO50']),
  spec('JP225', 'index', 1, 1, 'JPY', ['NIKKEI', 'JP225CASH', 'JPN225', 'NI225']),
  spec('HK50', 'index', 1, 1, 'HKD', ['HSI', 'HKG33', 'HK50CASH']),
  spec('AUS200', 'index', 1, 1, 'AUD', ['ASX200', 'AU200']),
  spec('CHINA50', 'index', 1, 1, 'USD', ['CN50', 'CHINA50CASH']),
  spec('US2000', 'index', 1, 1, 'USD', ['RUSSELL2000', 'US2000CASH']),
  spec('VIX', 'index', 2, 1, 'USD', ['VIXX']),
];

export const ENERGY: ReadonlyArray<InstrumentSpec> = [
  spec('WTI', 'energy', 2, 1_000, 'USD', ['USOIL', 'OIL', 'CRUDE', 'CL', 'WTIUSD', 'XTIUSD']),
  spec('BRENT', 'energy', 2, 1_000, 'USD', ['UKOIL', 'BRENTOIL', 'XBRUSD', 'BRN']),
  spec('NATGAS', 'energy', 3, 10_000, 'USD', ['NGAS', 'XNGUSD', 'NG']),
];

export const CRYPTO: ReadonlyArray<InstrumentSpec> = [
  spec('BTCUSD', 'crypto', 2, 1, 'USD', ['BITCOIN', 'BTC', 'BTCUSDT', 'XBTUSD']),
  spec('ETHUSD', 'crypto', 2, 1, 'USD', ['ETHEREUM', 'ETH', 'ETHUSDT']),
  spec('LTCUSD', 'crypto', 2, 1, 'USD', ['LITECOIN', 'LTC']),
  spec('XRPUSD', 'crypto', 4, 1, 'USD', ['RIPPLE', 'XRP']),
  spec('SOLUSD', 'crypto', 2, 1, 'USD', ['SOLANA', 'SOL']),
  spec('ADAUSD', 'crypto', 4, 1, 'USD', ['CARDANO', 'ADA']),
  spec('DOGEUSD', 'crypto', 5, 1, 'USD', ['DOGECOIN', 'DOGE']),
];

export const INSTRUMENTS: ReadonlyArray<InstrumentSpec> = [
  ...FX_MAJORS_TABLE,
  ...METALS,
  ...INDICES,
  ...ENERGY,
  ...CRYPTO,
];

const BY_CANONICAL = new Map<string, InstrumentSpec>(INSTRUMENTS.map((i) => [i.canonical, i]));
const BY_ALIAS = new Map<string, InstrumentSpec>();
for (const instrument of INSTRUMENTS) {
  BY_ALIAS.set(instrument.canonical, instrument);
  for (const alias of instrument.aliases) BY_ALIAS.set(alias.toUpperCase(), instrument);
}

export function lookupInstrument(canonicalOrAlias: string): InstrumentSpec | undefined {
  const key = canonicalOrAlias.trim().toUpperCase();
  return BY_ALIAS.get(key) ?? BY_CANONICAL.get(key);
}

export function isKnownCanonical(symbol: string): boolean {
  return BY_CANONICAL.has(symbol.trim().toUpperCase());
}

/** All canonical names, used by the auto-mapper for prefix matching. */
export const CANONICAL_SYMBOLS: readonly string[] = INSTRUMENTS.map((i) => i.canonical);

/** True for `AAABBB` shapes where both halves look like ISO currency codes. */
export function looksLikeFxPair(symbol: string): boolean {
  return /^[A-Z]{6}$/.test(symbol.trim().toUpperCase()) && !isKnownCanonical(symbol);
}

export function classifyAssetClass(canonical: string): AssetClass {
  const instrument = lookupInstrument(canonical);
  if (instrument) return instrument.assetClass;
  if (looksLikeFxPair(canonical)) return 'forex';
  // Indices/cash CFDs carry a digit tag (`US30`, `GER40`, `SPX500`). A bare
  // letter code like `AAPL` is NOT assumed to be an index — with no stock
  // master list to consult, `unknown` is the honest answer, and the engine
  // treats unknown instruments as FX-week products in `isMarketOpen`.
  if (/^[A-Z]{2,5}\d{1,4}(CASH)?$/.test(canonical)) return 'index';
  return 'unknown';
}

/**
 * Broker suffixes seen in the wild. Used by auto-mapping when the slave broker
 * offers several variants of the same instrument (reference docs: the
 * "mismatch detected" flow, e.g. EURUSD.mini).
 */
export const KNOWN_SUFFIX_TOKENS: readonly string[] = [
  '.mini',
  '.micro',
  '.pro',
  '.raw',
  '.ecn',
  '.std',
  '.standard',
  '.prime',
  '.zero',
  '.r',
  '.m',
  '.c',
  '.e',
  '.i',
  '.a',
  '.b',
  '.d',
  'm',
  'c',
  'z',
  'r',
  'pro',
  'ecn',
  'raw',
  'micro',
  'mini',
  'std',
];
