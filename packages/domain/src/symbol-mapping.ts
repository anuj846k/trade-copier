import { normalizeSymbol, detectVariants, variantsFor } from './symbols.js';

export type MappingStrategy =
  | 'manual'
  | 'exact'
  | 'canonical'
  | 'alias'
  | 'only_variant'
  | 'suffix_preference'
  | 'fuzzy';

export interface SymbolResolution {
  readonly masterSymbol: string;
  readonly slaveSymbol: string | null;
  readonly strategy: MappingStrategy | 'unmapped';
  /** 0..1 — how certain the resolver is. Auto-applied mappings require >= 0.9. */
  readonly confidence: number;
  /** Broker symbols that could have matched (for the UI suggestion list). */
  readonly candidates: readonly string[];
  readonly ambiguous: boolean;
  readonly reason?: string;
}

export interface ResolveSymbolInput {
  readonly masterSymbol: string;
  /** Symbols available on the slave account (broker names verbatim). */
  readonly slaveSymbols: readonly string[];
  /** Explicit user mapping: master symbol -> slave symbol. */
  readonly explicit?: Readonly<Record<string, string>> | undefined;
  /** User's chosen suffix for this account, e.g. `.mini` (mismatch flow). */
  readonly suffixPreference?: string | null | undefined;
  /** Minimum similarity for the fuzzy stage. */
  readonly fuzzyThreshold?: number;
}

const DEFAULT_FUZZY_THRESHOLD = 0.82;

/**
 * Resolves which slave symbol should receive a copy of `masterSymbol`.
 *
 * Order matters and mirrors the documented product behaviour:
 *   1. manual mapping wins (mapping screen),
 *   2. exact name equality (docs: "matching names sync automatically"),
 *   3. canonical equality (EURUSD.m on the slave == EURUSD on the master),
 *   4. unique suffix preference / single tradeable variant (mismatch flow),
 *   5. fuzzy similarity for index/other renames (DE40 -> GER40 handled by aliases).
 */
export function resolveSymbol(input: ResolveSymbolInput): SymbolResolution {
  const { masterSymbol, slaveSymbols } = input;
  const fuzzyThreshold = input.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;
  const manual = input.explicit?.[masterSymbol];
  if (manual) {
    const exists = slaveSymbols.some((s) => s.toLowerCase() === manual.toLowerCase());
    if (exists) {
      return resolution(masterSymbol, manual, 'manual', 1, [], false);
    }
    return resolution(masterSymbol, null, 'unmapped', 0, [], false, `Manual mapping "${manual}" does not exist on the slave account`);
  }

  const exact = slaveSymbols.find((s) => s.toLowerCase() === masterSymbol.toLowerCase());
  if (exact) return resolution(masterSymbol, exact, 'exact', 1, [exact], false);

  const canonical = normalizeSymbol(masterSymbol).canonical;
  const sameCanonical = variantsFor(canonical, slaveSymbols);
  const exactCanonical = sameCanonical.find((s) => s.toUpperCase() === canonical);
  if (exactCanonical) return resolution(masterSymbol, exactCanonical, 'canonical', 0.99, sameCanonical, false);

  if (sameCanonical.length === 1) {
    const only = sameCanonical[0]!;
    return resolution(masterSymbol, only, 'only_variant', 0.95, sameCanonical, false);
  }

  if (sameCanonical.length > 1) {
    const preferred = input.suffixPreference
      ? sameCanonical.find((s) => (normalizeSymbol(s).suffix ?? '') === input.suffixPreference)
      : undefined;
    if (preferred) {
      return resolution(masterSymbol, preferred, 'suffix_preference', 0.98, sameCanonical, false);
    }
    return resolution(
      masterSymbol,
      null,
      'unmapped',
      0,
      sameCanonical,
      true,
      `Broker offers ${sameCanonical.length} variants of ${canonical}: ${sameCanonical.join(', ')}. Select the suffix you trade.`,
    );
  }

  // Fuzzy stage — only reached when the canonical key found nothing. This is
  // where index renames that miss the alias table get picked up.
  const scored = slaveSymbols
    .map((candidate) => ({ candidate, score: symbolSimilarity(masterSymbol, candidate) }))
    .filter((entry) => entry.score >= fuzzyThreshold)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate));

  if (scored.length === 1) {
    return resolution(masterSymbol, scored[0]!.candidate, 'fuzzy', scored[0]!.score, [scored[0]!.candidate], false);
  }
  if (scored.length > 1) {
    const [first, second] = scored;
    if (first!.score - second!.score >= 0.05) {
      return resolution(masterSymbol, first!.candidate, 'fuzzy', first!.score, scored.map((s) => s.candidate), false);
    }
    return resolution(
      masterSymbol,
      null,
      'unmapped',
      0,
      scored.map((s) => s.candidate),
      true,
      `Several slave symbols are similar to ${masterSymbol}: ${scored.map((s) => s.candidate).join(', ')}`,
    );
  }

  return resolution(masterSymbol, null, 'unmapped', 0, [], false, `No slave symbol resembles ${masterSymbol}`);
}

function resolution(
  masterSymbol: string,
  slaveSymbol: string | null,
  strategy: MappingStrategy | 'unmapped',
  confidence: number,
  candidates: readonly string[],
  ambiguous: boolean,
  reason?: string,
): SymbolResolution {
  return {
    masterSymbol,
    slaveSymbol,
    strategy,
    confidence,
    candidates: [...candidates],
    ambiguous,
    ...(reason === undefined ? {} : { reason }),
  };
}

export interface AutoMapInput {
  readonly masterSymbols: readonly string[];
  readonly slaveSymbols: readonly string[];
  readonly existing?: Readonly<Record<string, string>> | undefined;
  readonly suffixPreference?: string | null | undefined;
  /** Replace existing manual mappings too. */
  readonly overwrite?: boolean;
  readonly minConfidence?: number;
}

export interface AutoMapResult {
  readonly mappings: Record<string, string>;
  readonly skipped: Array<{ masterSymbol: string; reason: string; candidates: readonly string[] }>;
  readonly stats: { matched: number; byStrategy: Record<string, number>; total: number };
  /** Symbol-variant mismatches the user must resolve (docs: "Mismatch Detected"). */
  readonly ambiguousGroups: ReturnType<typeof detectVariants>;
}

/**
 * Auto-mapping. The reference product says auto-mapping is "currently only for
 * forex"; this implementation is stricter about *applying* (needs >= 0.9
 * confidence) but broader in *matching* (aliases + canonical + suffix + fuzzy),
 * and always reports what it skipped so the UI can ask the user.
 */
export function autoMapSymbols(input: AutoMapInput): AutoMapResult {
  const minConfidence = input.minConfidence ?? 0.9;
  const existing = input.existing ?? {};
  const mappings: Record<string, string> = { ...(input.overwrite ? {} : existing) };
  const skipped: AutoMapResult['skipped'] = [];
  const byStrategy: Record<string, number> = {};
  let matched = 0;

  for (const masterSymbol of input.masterSymbols) {
    if (!input.overwrite && existing[masterSymbol]) {
      byStrategy.manual = (byStrategy.manual ?? 0) + 1;
      continue;
    }
    const resolved = resolveSymbol({
      masterSymbol,
      slaveSymbols: input.slaveSymbols,
      suffixPreference: input.suffixPreference ?? null,
    });
    if (resolved.slaveSymbol && resolved.confidence >= minConfidence) {
      mappings[masterSymbol] = resolved.slaveSymbol;
      matched += 1;
      byStrategy[resolved.strategy] = (byStrategy[resolved.strategy] ?? 0) + 1;
    } else {
      skipped.push({
        masterSymbol,
        reason: resolved.reason ?? 'No confident match',
        candidates: resolved.candidates,
      });
    }
  }

  return {
    mappings,
    skipped,
    stats: { matched, byStrategy, total: input.masterSymbols.length },
    ambiguousGroups: detectVariants(input.slaveSymbols).filter((group) => group.ambiguous),
  };
}

/**
 * Similarity score in [0,1] combining:
 *  - normalised Levenshtein distance,
 *  - canonical prefix/suffix containment.
 * Deterministic, so mapping decisions are reproducible and auditable.
 */
export function symbolSimilarity(a: string, b: string): number {
  const normalizedA = normalizeSymbol(a);
  const normalizedB = normalizeSymbol(b);
  // Same instrument (optionally with different broker suffixes) is a full match.
  if (normalizedA.canonical === normalizedB.canonical) return 1;
  const na = normalizedA.base;
  const nb = normalizedB.base;
  if (na === nb) return 1;
  const distanceScore = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const containmentScore = na.includes(nb) || nb.includes(na) ? 0.9 : 0;
  return Math.max(distanceScore, containmentScore);
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + cost;
      current[j] = Math.min(insertion, deletion, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? Math.max(a.length, b.length);
}

/** Ranked suggestions for the manual mapping UI. */
export function suggestCandidates(
  masterSymbol: string,
  slaveSymbols: readonly string[],
  limit = 10,
): Array<{ symbol: string; score: number }> {
  return slaveSymbols
    .map((symbol) => ({ symbol, score: symbolSimilarity(masterSymbol, symbol) }))
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);
}
