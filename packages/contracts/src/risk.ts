import { z } from 'zod';

/**
 * Risk/sizing models. Values are percentages unless the type is absolute
 * (FIXED_LOT uses lots, FIXED_BALANCE_MULTIPLIER uses account currency).
 *
 * Reference behaviour (docs `trade-copier/risk-types`): 100% === 1:1.
 */
export const riskTypeSchema = z.enum([
  /** riskValue = % of master volume. 100 => 1:1. */
  'LOT_MULTIPLIER',
  /** riskValue = absolute lots placed on the slave for every copied trade. */
  'FIXED_LOT',
  /** riskValue = % multiplier applied to the balance-proportional size. */
  'BALANCE_MULTIPLIER',
  /** Like BALANCE_MULTIPLIER but the master balance is pinned to fixedMasterBalance. */
  'FIXED_BALANCE_MULTIPLIER',
  /** riskValue = % of slave balance risked per trade; requires a master stop loss. */
  'FIXED_PERCENT_RISK',
]);
export type RiskType = z.infer<typeof riskTypeSchema>;

export const RISK_TYPE_LABELS: Record<RiskType, string> = {
  LOT_MULTIPLIER: 'Lot Multiplier',
  FIXED_LOT: 'Fixed Lot',
  BALANCE_MULTIPLIER: 'Balance Multiplier',
  FIXED_BALANCE_MULTIPLIER: 'Fixed Balance Multiplier',
  FIXED_PERCENT_RISK: 'Fixed % Risk (requires master SL)',
};

export const RISK_TYPE_DESCRIPTIONS: Record<RiskType, string> = {
  LOT_MULTIPLIER: 'Percentage of the master volume. 100% copies the lot size exactly.',
  FIXED_LOT: 'Every copied trade uses this exact lot size.',
  BALANCE_MULTIPLIER:
    'Scales the master position to your slave balance. 100% replicates the master risk expressed as a % of balance.',
  FIXED_BALANCE_MULTIPLIER:
    'Same as Balance Multiplier but the master balance is pinned, so the slave position grows as the slave balance grows.',
  FIXED_PERCENT_RISK:
    'Risks a fixed percentage of the slave balance; position size is derived from the master stop-loss distance.',
};

/** Where SL/TP values come from where the master has none. */
export const sltpSourceSchema = z.enum(['master', 'fixed_pips', 'none']);
export type SltpSource = z.infer<typeof sltpSourceSchema>;
