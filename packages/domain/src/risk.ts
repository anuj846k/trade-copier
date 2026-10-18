import Decimal from 'decimal.js';
import type { CopierErrorCode, RiskType } from '@trade-copier/contracts';
import { contractAlignmentFactor } from './lots.js';
import type { RateSource } from './pips.js';
import { convert, pipValuePerLot } from './pips.js';

/**
 * Position sizing. Implements the five documented risk types
 * (FEATURES.md F14–F18) plus the additive Lot Refiner (F19) and Contract
 * Alignment (F20). Every computation returns its own trace so the copier log
 * and the UI can explain exactly how a slave volume was derived.
 */
export interface RiskContext {
  readonly riskType: RiskType;
  /** % for the multiplier types and %-risk; absolute lots for FIXED_LOT. */
  readonly riskValue: number;
  readonly masterVolume: number;
  readonly masterBalance: number;
  readonly slaveBalance: number;
  readonly fixedMasterBalance?: number | null;
  /** Master stop-loss distance in pips (required by FIXED_PERCENT_RISK). */
  readonly stopLossDistancePips?: number | null;
  readonly masterContractSize: number;
  readonly slaveContractSize: number;
  readonly masterPipSize: number;
  readonly slavePipSize: number;
  readonly slaveQuoteCurrency: string;
  readonly slaveAccountCurrency: string;
  /** null = "auto": enabled for balance multipliers, disabled otherwise. */
  readonly contractAlignment?: boolean | null;
  readonly lotRefiner?: number;
  readonly rates?: RateSource | undefined;
}

export interface RiskStep {
  readonly label: string;
  readonly value: string;
}

export interface RiskComputation {
  readonly volume: number;
  readonly steps: readonly RiskStep[];
  readonly warnings: readonly string[];
  /** True when the result must be treated as indicative (missing FX rate …). */
  readonly degraded: boolean;
}

export interface RiskFailure {
  readonly code: CopierErrorCode;
  readonly detail: string;
}

export function computeRiskVolume(
  context: RiskContext,
): { ok: true; value: RiskComputation } | { ok: false; error: RiskFailure } {
  const steps: RiskStep[] = [];
  const warnings: string[] = [];
  let degraded = false;

  const alignmentEnabled =
    context.contractAlignment === null || context.contractAlignment === undefined
      ? context.riskType === 'BALANCE_MULTIPLIER' || context.riskType === 'FIXED_BALANCE_MULTIPLIER'
      : context.contractAlignment;
  const factor = alignmentEnabled
    ? contractAlignmentFactor(context.masterContractSize, context.slaveContractSize)
    : 1;

  steps.push({ label: 'master volume', value: format(context.masterVolume) });
  steps.push({ label: 'risk type', value: context.riskType });
  steps.push({ label: 'risk value', value: format(context.riskValue) });

  let volume: number;

  switch (context.riskType) {
    case 'FIXED_LOT': {
      volume = context.riskValue;
      steps.push({ label: 'fixed lot', value: format(volume) });
      if (context.masterContractSize !== context.slaveContractSize && !alignmentEnabled) {
        warnings.push(
          `Contract sizes differ (${context.masterContractSize} vs ${context.slaveContractSize}); enable Contract Alignment for equal exposure.`,
        );
      }
      break;
    }

    case 'LOT_MULTIPLIER': {
      const ratio = new Decimal(context.riskValue).dividedBy(100);
      volume = new Decimal(context.masterVolume).times(ratio).toNumber();
      steps.push({ label: `× ${format(ratio.toNumber())} (${format(context.riskValue)}%)`, value: format(volume) });
      if (factor !== 1) {
        volume = new Decimal(volume).times(factor).toNumber();
        steps.push({
          label: `contract alignment × ${format(factor)} (${context.masterContractSize}/${context.slaveContractSize})`,
          value: format(volume),
        });
      }
      break;
    }

    case 'BALANCE_MULTIPLIER':
    case 'FIXED_BALANCE_MULTIPLIER': {
      const referenceBalance =
        context.riskType === 'FIXED_BALANCE_MULTIPLIER'
          ? (context.fixedMasterBalance ?? 0)
          : context.masterBalance;
      if (!(referenceBalance > 0)) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION',
            detail:
              context.riskType === 'FIXED_BALANCE_MULTIPLIER'
                ? 'Fixed Balance Multiplier requires a fixed master balance'
                : 'Balance Multiplier requires the master balance',
          },
        };
      }
      if (!(context.slaveBalance > 0)) {
        return {
          ok: false,
          error: { code: 'VALIDATION', detail: 'Balance Multiplier requires the slave account balance' },
        };
      }
      const balanceRatio = new Decimal(context.slaveBalance).dividedBy(referenceBalance);
      const multiplier = new Decimal(context.riskValue).dividedBy(100);
      volume = new Decimal(context.masterVolume).times(balanceRatio).times(multiplier).toNumber();
      steps.push({
        label: `balance ratio ${format(context.slaveBalance)}/${format(referenceBalance)} = ${format(balanceRatio.toNumber())}`,
        value: format(new Decimal(context.masterVolume).times(balanceRatio).toNumber()),
      });
      steps.push({ label: `× ${format(context.riskValue)}%`, value: format(volume) });
      if (factor !== 1) {
        volume = new Decimal(volume).times(factor).toNumber();
        steps.push({ label: `contract alignment × ${format(factor)}`, value: format(volume) });
      }
      break;
    }

    case 'FIXED_PERCENT_RISK': {
      const slPips = context.stopLossDistancePips ?? 0;
      if (!(slPips > 0)) {
        return {
          ok: false,
          error: {
            code: 'VALIDATION',
            detail: 'Fixed % Risk requires a stop loss on the master trade (or a Fixed Stop Loss in pips)',
          },
        };
      }
      if (!(context.slaveBalance > 0)) {
        return { ok: false, error: { code: 'VALIDATION', detail: 'Fixed % Risk requires the slave account balance' } };
      }
      const riskMoney = new Decimal(context.slaveBalance).times(context.riskValue).dividedBy(100).toNumber();
      steps.push({ label: `risk ${format(context.riskValue)}% of ${format(context.slaveBalance)}`, value: format(riskMoney) });

      const pipValueInQuote = pipValuePerLot(context.slaveContractSize, context.slavePipSize);
      let pipValueInAccount = pipValueInQuote;
      if (context.slaveQuoteCurrency !== context.slaveAccountCurrency) {
        if (!context.rates) {
          degraded = true;
          warnings.push(
            `No FX rate available to convert ${context.slaveQuoteCurrency} pip value into ${context.slaveAccountCurrency}; sizing assumes 1:1.`,
          );
        } else {
          const converted = convert(pipValueInQuote, context.slaveQuoteCurrency, context.slaveAccountCurrency, context.rates);
          if (converted === null) {
            degraded = true;
            warnings.push(
              `No FX rate for ${context.slaveQuoteCurrency}->${context.slaveAccountCurrency}; sizing assumes 1:1.`,
            );
          } else {
            pipValueInAccount = converted;
          }
        }
      }
      steps.push({ label: `pip value / lot (${context.slaveAccountCurrency})`, value: format(pipValueInAccount) });
      volume = new Decimal(riskMoney).dividedBy(new Decimal(slPips).times(pipValueInAccount)).toNumber();
      steps.push({ label: `÷ (${format(slPips)} pips × pip value)`, value: format(volume) });
      break;
    }

    default: {
      return { ok: false, error: { code: 'VALIDATION', detail: `Unsupported risk type ${String(context.riskType)}` } };
    }
  }

  const refiner = context.lotRefiner ?? 0;
  if (refiner !== 0) {
    const before = volume;
    volume = new Decimal(volume).plus(refiner).toNumber();
    steps.push({ label: `lot refiner ${refiner > 0 ? '+' : ''}${format(refiner)}`, value: format(volume) });
    if (volume <= 0 && before > 0) {
      warnings.push('Lot refiner reduced the volume to zero or below; the trade will not be copied.');
    }
  }

  return { ok: true, value: { volume, steps, warnings, degraded } };
}

function format(value: number): string {
  return new Decimal(value).toSignificantDigits(10).toString();
}
