import {
  KNOWN_SUFFIX_TOKENS,
  CANONICAL_SYMBOLS,
  classifyAssetClass,
  lookupInstrument,
} from './instruments.js';

export interface NormalizedSymbol {
  /** Symbol exactly as the broker reports it. Never mutated. */
  readonly raw: string;
  /** Broker-agnostic instrument key, e.g. `EURUSD`, `GER40`. */
  readonly canonical: string;
  /** The part before the suffix, upper-cased and separator-stripped. */
  readonly base: string;
  /** Detected suffix (kept verbatim, including any separator), if any. */
  readonly suffix: string | null;
  /** Detected prefix (e.g. `#`), if any. */
  readonly prefix: string | null;
}

const PREFIX_CHARS = /^[#.\-_*!]+/;

/**
 * Canonicalises a broker symbol name.
 *
 * Handles the naming variants that actually break copying:
 *   EURUSD, EURUSD.m, EURUSDm, EURUSD_raw, EUR/USD, #EURUSD, EURUSD-5,
 *   EUREUR.mini, GOLD.m, XAUUSD.pro, US30.cash, NAS100.i
 */
export function normalizeSymbol(raw: string): NormalizedSymbol {
  const original = raw;
  let work = raw.trim();
  let prefix: string | null = null;

  const prefixMatch = work.match(PREFIX_CHARS);
  if (prefixMatch) {
    prefix = prefixMatch[0];
    work = work.slice(prefix.length);
  }

  work = work.replace(/\s+/g, '');

  // Trailing decoration (`EURUSD#`) is a broker tag, not part of the name.
  let trailing: string | null = null;
  const trailingMatch = work.match(/[#*!]+$/);
  if (trailingMatch) {
    trailing = trailingMatch[0];
    work = work.slice(0, -trailing.length);
  }

  const upper = work.toUpperCase();

  // Split on an explicit separator first: EURUSD.m, EUR/USD, US30-cash
  const sepMatch = upper.match(/^([A-Z0-9]+)([._/\-])([A-Z0-9]+)$/);
  if (sepMatch) {
    const [, head = '', sep = '', tail = ''] = sepMatch;
    const candidate = head;
    // `EUR/USD` is one instrument split by a cosmetic separator: merge first.
    const merged = `${head}${tail}`;
    if (looksLikeInstrument(merged) && !isSuffixOnly(tail)) {
      return finish(original, merged, merged, trailing, prefix);
    }
    if (looksLikeInstrument(candidate) || looksLikeInstrument(tail)) {
      // Prefer the head when it is a valid instrument; otherwise treat the tail
      // as the instrument with a prefix-style namespace (e.g. `cash.US30`).
      if (looksLikeInstrument(candidate)) {
        return finish(original, candidate, candidate, `${sep}${tail}`, trailing ?? prefix);
      }
      return finish(original, tail, tail, trailing, prefix);
    }
    // Arbitrary instrument + known suffix token, e.g. an exotic pair on a
    // broker that appends `.pro`: the head is the instrument either way.
    if (isPlausibleSuffix(tail)) {
      return finish(original, candidate, candidate, `${sep}${tail}`, trailing ?? prefix);
    }
  }

  // No separator: try to peel a known suffix token (EURUSDm, GER40cash)
  const peeled = peelAttachedSuffix(upper);
  if (peeled) {
    return finish(original, peeled.base, peeled.base, peeled.suffix, trailing ?? prefix);
  }

  // Fall back: if the whole symbol is a known canonical/alias, or an FX pair.
  const canonical = canonicalFrom(upper);
  return finish(original, upper, upper, trailing, prefix, canonical);
}

function finish(
  raw: string,
  base: string,
  _lookupKey: string,
  suffix: string | null,
  prefix: string | null,
  canonicalOverride?: string,
): NormalizedSymbol {
  return {
    raw,
    canonical: canonicalOverride ?? canonicalFrom(base),
    base,
    // The separator is cosmetic: `EURUSD.a` and `EURUSDm` both yield `a` / `m`.
    suffix: suffix === null ? null : suffix.replace(/^[._/\-]+/, '').toLowerCase() || null,
    prefix,
  };
}

/** Maps a base name to its canonical instrument via alias table or FX shape. */
export function canonicalFrom(base: string): string {
  const key = base.toUpperCase();
  const instrument = lookupInstrument(key);
  if (instrument) return instrument.canonical;
  if (/^[A-Z]{6}$/.test(key)) return key; // arbitrary FX pair, e.g. EURNOK
  return key;
}

function looksLikeInstrument(candidate: string): boolean {
  if (!candidate) return false;
  if (candidate.length < 3) return false;
  if (lookupInstrument(candidate)) return true;
  if (/^[A-Z]{6}$/.test(candidate)) return true;
  if (CANONICAL_SYMBOLS.includes(candidate)) return true;
  return false;
}

/**
 * Peels a suffix glued to the instrument name. Longest-match against the known
 * canonical list wins so that `NAS100cash` survives, and `EURUSDm` splits into
 * `EURUSD` + `m`.
 */
function peelAttachedSuffix(candidate: string): { base: string; suffix: string } | null {
  // Longest canonical prefix that leaves a plausible suffix tail.
  const canonicalHit = CANONICAL_SYMBOLS.filter((symbol) => candidate.startsWith(symbol) && candidate !== symbol)
    .sort((a, b) => b.length - a.length)[0];
  if (canonicalHit) {
    const tail = candidate.slice(canonicalHit.length);
    if (tail.length <= 8 && /^[A-Z0-9]+$/.test(tail)) {
      return { base: canonicalHit, suffix: tail };
    }
  }

  // Generic FX pair + suffix: EURUSDXYZ -> EURUSD + XYZ (max 8 chars tail).
  const fxMatch = candidate.match(/^([A-Z]{6})([A-Z0-9]{1,8})$/);
  if (fxMatch) {
    const [, base = '', suffix = ''] = fxMatch;
    if (!looksLikeInstrument(candidate) && isPlausibleSuffix(suffix)) {
      return { base, suffix };
    }
  }
  return null;
}

function isPlausibleSuffix(suffix: string): boolean {
  const lowered = suffix.toLowerCase();
  if (KNOWN_SUFFIX_TOKENS.includes(lowered)) return true;
  // Numeric broker tags such as -5 (already handled) or 2 on `EURUSD2`.
  return /^\d{1,2}$/.test(suffix);
}

/** True when the token is only a broker suffix (e.g. `US30.cash`), not a pair leg. */
function isSuffixOnly(token: string): boolean {
  return isPlausibleSuffix(token) && !looksLikeInstrument(token);
}

export function suffixOf(raw: string): string | null {
  return normalizeSymbol(raw).suffix;
}

export function baseOf(raw: string): string {
  return normalizeSymbol(raw).base;
}

/** Groups broker symbols by canonical instrument (used for mismatch detection). */
export function groupByCanonical(symbols: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const symbol of symbols) {
    const { canonical } = normalizeSymbol(symbol);
    const list = out.get(canonical);
    if (list) list.push(symbol);
    else out.set(canonical, [symbol]);
  }
  return out;
}

export interface SymbolVariantReport {
  readonly canonical: string;
  /** Every broker symbol that maps to this instrument. */
  readonly variants: readonly string[];
  /** Distinct suffixes found (null = bare symbol). */
  readonly suffixes: readonly (string | null)[];
  /** True when the broker exposes more than one tradeable variant. */
  readonly ambiguous: boolean;
}

/**
 * Reference flow: "Mismatch Detected — your broker offers more than one symbol
 * option, select the suffix you trade" (docs `trade-copier/symbols`).
 */
export function detectVariants(symbols: readonly string[]): SymbolVariantReport[] {
  const grouped = groupByCanonical(symbols);
  const reports: SymbolVariantReport[] = [];
  for (const [canonical, variants] of grouped) {
    const suffixes = Array.from(new Set(variants.map((v) => normalizeSymbol(v).suffix)));
    reports.push({
      canonical,
      variants: [...variants].sort(),
      suffixes,
      ambiguous: variants.length > 1,
    });
  }
  return reports.sort((a, b) => a.canonical.localeCompare(b.canonical));
}

export function variantsFor(canonical: string, symbols: readonly string[]): string[] {
  return symbols.filter((s) => normalizeSymbol(s).canonical === canonical);
}

export function describeSymbol(raw: string): { canonical: string; assetClass: string; suffix: string | null } {
  const normalized = normalizeSymbol(raw);
  return {
    canonical: normalized.canonical,
    assetClass: classifyAssetClass(normalized.canonical),
    suffix: normalized.suffix,
  };
}
