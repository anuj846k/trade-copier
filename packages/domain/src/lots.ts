import Decimal from 'decimal.js';
import type { CopierErrorCode } from '@trade-copier/contracts';

export interface VolumeConstraints {
  readonly minLot: number;
  readonly maxLot: number;
  readonly lotStep: number;
  /** Broker-imposed cap per single order (some brokers split large FX orders). */
  readonly maxLotPerOrder?: number | null;
}

export type RoundMode = 'down' | 'nearest' | 'up';

export interface NormalizeVolumeInput {
  readonly volume: number;
  readonly constraints: VolumeConstraints;
  /** Clamp to the symbol minimum instead of failing (reference: Force Minimum Lot Size). */
  readonly forceMin?: boolean;
  /** Clamp to the symbol maximum instead of failing (reference: Force Maximum Lot Size). */
  readonly forceMax?: boolean;
  readonly roundMode?: RoundMode;
}

export type NormalizeVolumeResult =
  | {
      readonly ok: true;
      readonly volume: number;
      /** Human-readable notes for the copier log ("0.005 rounded to 0.01"). */
      readonly adjustments: readonly string[];
    }
  | {
      readonly ok: false;
      readonly code: CopierErrorCode;
      readonly detail: string;
    };

export function roundToStep(value: number, step: number, mode: RoundMode = 'nearest'): number {
  if (!(step > 0)) return value;
  const decimalValue = new Decimal(value);
  const decimalStep = new Decimal(step);
  const ratio = decimalValue.dividedBy(decimalStep);
  const rounded =
    mode === 'down'
      ? ratio.floor()
      : mode === 'up'
        ? ratio.ceil()
        : ratio.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
  return rounded.times(decimalStep).toNumber();
}

export function roundToStepPrecision(value: number, step: number): number {
  const decimals = new Decimal(step).decimalPlaces();
  return new Decimal(value).toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * Turns a computed volume into something the broker will accept, or fails with
 * the same taxonomy the reference product shows its users
 * (`INVALID_VOLUME` — min not met / max exceeded).
 */
export function normalizeVolume(input: NormalizeVolumeInput): NormalizeVolumeResult {
  const { constraints, forceMin = false, forceMax = false, roundMode = 'nearest' } = input;
  const adjustments: string[] = [];
  const minLot = constraints.minLot > 0 ? constraints.minLot : 0.01;
  const maxLot = constraints.maxLot > 0 ? constraints.maxLot : Number.MAX_SAFE_INTEGER;
  const step = constraints.lotStep > 0 ? constraints.lotStep : 0.01;

  if (!Number.isFinite(input.volume) || input.volume <= 0) {
    return { ok: false, code: 'INVALID_VOLUME', detail: `Computed volume is ${input.volume}` };
  }

  let volume = roundToStep(input.volume, step, roundMode);

  if (volume < minLot) {
    if (!forceMin) {
      return {
        ok: false,
        code: 'INVALID_VOLUME',
        detail: `Volume ${volume} is below the symbol minimum ${minLot}. Enable Force Minimum Lot Size to clamp.`,
      };
    }
    adjustments.push(`raised to minimum ${minLot}`);
    volume = minLot;
  }

  if (volume > maxLot) {
    if (!forceMax) {
      return {
        ok: false,
        code: 'INVALID_VOLUME',
        detail: `Volume ${volume} exceeds the symbol maximum ${maxLot}. Enable Force Maximum Lot Size to clamp.`,
      };
    }
    adjustments.push(`capped at maximum ${maxLot}`);
    volume = maxLot;
  }

  if (roundMode !== 'nearest') {
    adjustments.push(`rounded ${roundMode} to lot step ${step}`);
  }

  return { ok: true, volume: roundToStepPrecision(volume, step), adjustments };
}

/**
 * Splits a volume that exceeds the per-order cap into several orders.
 * Returns volumes that are each a multiple of the lot step.
 */
export function splitVolume(volume: number, maxPerOrder: number, constraints: VolumeConstraints): number[] {
  const step = constraints.lotStep > 0 ? constraints.lotStep : 0.01;
  const cap = maxPerOrder > 0 ? Math.min(maxPerOrder, constraints.maxLot) : constraints.maxLot;
  if (volume <= cap) return [roundToStepPrecision(volume, step)];

  const parts: number[] = [];
  let remaining = new Decimal(volume);
  const decimalCap = new Decimal(roundToStep(cap, step, 'down'));
  while (remaining.greaterThan(decimalCap)) {
    parts.push(decimalCap.toNumber());
    remaining = remaining.minus(decimalCap);
    if (parts.length > 50) break; // hard safety bound
  }
  const tail = roundToStepPrecision(remaining.toNumber(), step);
  if (tail >= (constraints.minLot > 0 ? constraints.minLot : step)) parts.push(tail);
  else if (parts.length > 0) {
    // Fold a too-small remainder into the previous slice.
    const last = parts.pop()!;
    parts.push(roundToStepPrecision(last + tail, step));
  }
  return parts;
}

/**
 * Contract alignment factor.
 * Exposure on the master is `volume * contractSize`; to deliver the same
 * exposure on the slave we scale by `masterContract / slaveContract`.
 */
export function contractAlignmentFactor(masterContractSize: number, slaveContractSize: number): number {
  if (!(masterContractSize > 0) || !(slaveContractSize > 0)) return 1;
  return new Decimal(masterContractSize).dividedBy(slaveContractSize).toNumber();
}

/** Notional exposure of a position, in the base asset's units. */
export function notionalExposure(volume: number, contractSize: number): number {
  return new Decimal(volume).times(contractSize).toNumber();
}

/**
 * Proportional volume for a partial close. The master closed `closedVolume`
 * out of `masterTotalVolume`; the slave should close the same *fraction* of
 * whatever it actually filled (which may differ due to min-lot clamping).
 *
 * Assumption flagged in FEATURES.md (U5): reference does not document partial
 * close semantics.
 */
export function proportionalCloseVolume(
  masterClosedVolume: number,
  masterTotalVolume: number,
  slaveOpenVolume: number,
  constraints: VolumeConstraints,
): { volume: number; closeAll: boolean; note?: string } {
  if (!(masterTotalVolume > 0) || !(slaveOpenVolume > 0)) {
    return { volume: 0, closeAll: false, note: 'nothing to close' };
  }
  const fraction = new Decimal(masterClosedVolume).dividedBy(masterTotalVolume).toNumber();
  if (fraction >= 1) return { volume: slaveOpenVolume, closeAll: true };

  const raw = new Decimal(slaveOpenVolume).times(fraction).toNumber();
  const minLot = constraints.minLot > 0 ? constraints.minLot : 0.01;
  let volume = roundToStep(raw, constraints.lotStep, 'down');

  // If rounding leaves nothing, and there is more than one min-lot slice open,
  // close exactly one slice; otherwise close everything (remainder would be
  // uncloseable dust that the broker rejects).
  if (volume < minLot) {
    if (slaveOpenVolume > minLot + 1e-9) {
      volume = minLot;
      return { volume, closeAll: false, note: 'rounded up to the symbol minimum for a partial close' };
    }
    return { volume: slaveOpenVolume, closeAll: true, note: 'remainder below the symbol minimum — closing the full position' };
  }

  const remainder = new Decimal(slaveOpenVolume).minus(volume).toNumber();
  if (remainder > 1e-9 && remainder < minLot) {
    return { volume: slaveOpenVolume, closeAll: true, note: 'remainder would be below the symbol minimum — closing the full position' };
  }
  return { volume: roundToStepPrecision(volume, constraints.lotStep), closeAll: false };
}
