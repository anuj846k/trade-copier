import { describe, expect, it } from 'vitest';
import {
  autoMapSymbols,
  classifyAssetClass,
  describeSymbol,
  groupByCanonical,
  normalizeSymbol,
  resolveSymbol,
  suggestCandidates,
  symbolSimilarity,
  suffixOf,
  variantsFor,
} from '../src/index.js';

/**
 * Symbol handling oracles.
 *
 *  - the broker symbol name is the identity (never normalised away)
 *  - a canonical key groups variants: `EURUSD.a`, `EURUSDm`, `EURUSD.pro`
 *  - an unmapped symbol must produce an actionable, specific reason
 *  - an ambiguous mapping (several plausible variants) must NOT guess
 */

describe('symbol normalisation', () => {
  it('recognises the bare pair', () => {
    const normalized = normalizeSymbol('EURUSD');
    expect(normalized.canonical).toBe('EURUSD');
    expect(normalized.base).toBe('EURUSD');
    expect(normalized.suffix).toBeNull();
  });

  it.each([
    ['EURUSD.a', 'EURUSD', 'a'],
    ['EURUSDm', 'EURUSD', 'm'],
    ['EURUSD.pro', 'EURUSD', 'pro'],
    ['EURUSD_ecn', 'EURUSD', 'ecn'],
    ['EURUSD.i', 'EURUSD', 'i'],
    ['EURUSD#', 'EURUSD', '#'],
    ['#EURUSD', 'EURUSD', null],
    ['eurusd', 'EURUSD', null],
    ['EUR/USD', 'EURUSD', null],
  ])('normalises %s to %s (suffix %s)', (raw, canonical, suffix) => {
    const normalized = normalizeSymbol(raw);
    expect(normalized.canonical).toBe(canonical);
    if (suffix === null) expect(normalized.suffix).toBeNull();
    else expect(normalized.suffix).toBe(suffix);
  });

  it('strips the separator from the suffix and normalises its case', () => {
    expect(normalizeSymbol('EURUSD.a').suffix).toBe('a');
    expect(normalizeSymbol('EURUSD.PRO').suffix).toBe('pro');
    expect(normalizeSymbol('EURUSDm').suffix).toBe('m');
  });

  it('records decoration as a prefix when it leads the name', () => {
    const hash = normalizeSymbol('#EURUSD');
    expect(hash.prefix).toBe('#');
    expect(hash.suffix).toBeNull();
    expect(hash.canonical).toBe('EURUSD');
  });

  it('keeps trailing decoration as a distinguishing suffix', () => {
    const tagged = normalizeSymbol('EURUSD#');
    expect(tagged.canonical).toBe('EURUSD');
    expect(tagged.suffix).toBe('#');
    expect(suffixOf('EURUSD#')).toBe('#');
  });

  it('keeps metals, indices and crypto distinct', () => {
    expect(normalizeSymbol('XAUUSD').canonical).toBe('XAUUSD');
    expect(normalizeSymbol('XAUUSD.a').canonical).toBe('XAUUSD');
    expect(normalizeSymbol('US30.cash').canonical).toBe('US30');
    expect(normalizeSymbol('BTCUSD').canonical).toBe('BTCUSD');
  });

  it('classifies asset classes', () => {
    expect(classifyAssetClass('EURUSD')).toBe('forex');
    expect(classifyAssetClass('XAUUSD')).toBe('metal');
    expect(classifyAssetClass('US30')).toBe('index');
    expect(classifyAssetClass('USOIL')).toBe('energy');
    expect(classifyAssetClass('BTCUSD')).toBe('crypto');
    // No stock master list is shipped, so bare tickers stay `unknown` rather
    // than being guessed from their shape.
    expect(classifyAssetClass('AAPL')).toBe('unknown');
    // Six letters are read as a currency pair (the spot-FX shape) …
    expect(classifyAssetClass('WTFZZZ')).toBe('forex');
    // … and anything else stays unknown rather than being guessed.
    expect(classifyAssetClass('FOO')).toBe('unknown');
  });

  it('groups variants and flags ambiguous ones', () => {
    const symbols = ['EURUSD', 'EURUSD.a', 'EURUSDm', 'GBPUSD', 'GBPUSD.a'];
    const grouped = groupByCanonical(symbols);
    expect(grouped.get('EURUSD')).toEqual(['EURUSD', 'EURUSD.a', 'EURUSDm']);
    expect(variantsFor('GBPUSD', symbols)).toEqual(['GBPUSD', 'GBPUSD.a']);
    expect(describeSymbol('XAUUSD.pro')).toEqual({ canonical: 'XAUUSD', assetClass: 'metal', suffix: 'pro' });
  });
});

describe('symbol resolution', () => {
  const slaveSymbols = ['EURUSD.a', 'GBPUSD.a', 'USDJPY.a', 'XAUUSD.a'];

  it('prefers an exact name match', () => {
    const result = resolveSymbol({ masterSymbol: 'GBPUSD.a', slaveSymbols });
    expect(result.strategy).toBe('exact');
    expect(result.slaveSymbol).toBe('GBPUSD.a');
    expect(result.confidence).toBe(1);
  });

  it('matches the single available variant when the suffix differs', () => {
    const result = resolveSymbol({ masterSymbol: 'EURUSD', slaveSymbols });
    expect(result.strategy).toBe('only_variant');
    expect(result.slaveSymbol).toBe('EURUSD.a');
    expect(result.ambiguous).toBe(false);
  });

  it('honours an explicit (manual) mapping', () => {
    const result = resolveSymbol({ masterSymbol: 'EURUSD', slaveSymbols, explicit: { EURUSD: 'EURUSD.a' } });
    expect(result.strategy).toBe('manual');
    expect(result.slaveSymbol).toBe('EURUSD.a');
  });

  it('reports a manual mapping that no longer exists instead of silently falling back', () => {
    const result = resolveSymbol({ masterSymbol: 'EURUSD', slaveSymbols, explicit: { EURUSD: 'EURUSD.removed' } });
    expect(result.slaveSymbol).toBeNull();
    expect(result.reason).toMatch(/does not exist/i);
  });

  it('uses the suffix preference when several variants exist', () => {
    const symbols = ['EURUSD.a', 'EURUSDm', 'EURUSD.pro'];
    const result = resolveSymbol({ masterSymbol: 'EURUSD', slaveSymbols: symbols, suffixPreference: 'pro' });
    expect(result.strategy).toBe('suffix_preference');
    expect(result.slaveSymbol).toBe('EURUSD.pro');
  });

  it('refuses to guess when several variants exist and none is preferred', () => {
    const symbols = ['EURUSD.a', 'EURUSDm', 'EURUSD.pro'];
    const result = resolveSymbol({ masterSymbol: 'EURUSD', slaveSymbols: symbols });
    expect(result.slaveSymbol).toBeNull();
    expect(result.ambiguous).toBe(true);
    expect(result.candidates).toHaveLength(3);
    expect(result.reason).toMatch(/select the suffix/i);
  });

  it('maps index aliases through the instrument table (USTEC == NAS100)', () => {
    const single = resolveSymbol({ masterSymbol: 'NAS100', slaveSymbols: ['USTEC.pro', 'GER40.pro'] });
    expect(single.slaveSymbol).toBe('USTEC.pro');
    expect(single.strategy).toBe('only_variant');

    // Two NAS100 variants and no preference → the user must choose.
    const ambiguous = resolveSymbol({ masterSymbol: 'NAS100', slaveSymbols: ['USTEC.pro', 'NAS100.pro'] });
    expect(ambiguous.slaveSymbol).toBeNull();
    expect(ambiguous.ambiguous).toBe(true);
    expect(ambiguous.candidates).toHaveLength(2);
  });

  it('falls back to fuzzy matching for renames that miss the alias table', () => {
    const fuzzy = resolveSymbol({ masterSymbol: 'FOOBAR400', slaveSymbols: ['FOOBAR401.pro', 'ZZZZZZ.pro'] });
    expect(fuzzy.slaveSymbol).toBe('FOOBAR401.pro');
    expect(fuzzy.strategy).toBe('fuzzy');
    expect(fuzzy.confidence).toBeGreaterThan(0.85);

    const nothing = resolveSymbol({ masterSymbol: 'ZARJPY', slaveSymbols });
    expect(nothing.slaveSymbol).toBeNull();
    expect(nothing.reason).toMatch(/resembles/i);
  });

  it('returns an actionable reason when nothing matches', () => {
    const result = resolveSymbol({ masterSymbol: 'ZARJPY', slaveSymbols });
    expect(result.slaveSymbol).toBeNull();
    expect(result.ambiguous).toBe(false);
    expect(result.strategy).toBe('unmapped');
    expect(result.reason).toBeTruthy();
  });

  it('scores similarity and suggests ranked candidates for the UI picker', () => {
    expect(symbolSimilarity('US30', 'US30.cash')).toBe(1);
    const suggestions = suggestCandidates('XAUUSD', ['EURUSD.a', 'XAUUSD.a', 'XAUEUR.a'], 3);
    expect(suggestions[0]!.symbol).toBe('XAUUSD.a');
    expect(suggestions[0]!.score).toBeGreaterThan(suggestions[1]!.score);
  });
});

describe('auto-mapping', () => {
  it('maps unambiguously and skips ambiguous pairs', () => {
    const result = autoMapSymbols({
      masterSymbols: ['EURUSD', 'GBPUSD', 'NAS100'],
      slaveSymbols: ['EURUSD.a', 'GBPUSD.a', 'GBPUSD.b', 'NAS100.cash'],
      minConfidence: 0.9,
    });
    expect(result.mappings.EURUSD).toBe('EURUSD.a');
    expect(result.mappings.NAS100).toBe('NAS100.cash');
    // GBPUSD has two equally good variants → must be left for the user
    expect(result.mappings.GBPUSD).toBeUndefined();
    expect(result.skipped.map((entry) => entry.masterSymbol)).toContain('GBPUSD');
  });

  it('does not overwrite existing mappings unless asked', () => {
    const existing = { EURUSD: 'EURUSD.manual' };
    const kept = autoMapSymbols({ masterSymbols: ['EURUSD'], slaveSymbols: ['EURUSD.a'], existing });
    expect(kept.mappings.EURUSD).toBe('EURUSD.manual');

    const overwritten = autoMapSymbols({ masterSymbols: ['EURUSD'], slaveSymbols: ['EURUSD.a'], existing, overwrite: true });
    expect(overwritten.mappings.EURUSD).toBe('EURUSD.a');
  });
});
