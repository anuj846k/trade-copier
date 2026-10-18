import Decimal from 'decimal.js';
import type { EquityProtection } from '@trade-copier/contracts';

/**
 * Equity Protection (FEATURES.md F46–F50). Evaluated against the account's
 * balance/equity pair, where the *reference balance* is the balance captured at
 * the most recent daily reset — this is what makes the percentage thresholds
 * move with deposits and realised profit, as documented:
 *
 *   "this is a percentage difference between your current Balance and floating
 *    Equity, therefore if your balance increases, so will your allowed Equity value"
 */
export interface EquityProtectionInput {
  readonly config: EquityProtection;
  readonly balance: number;
  readonly equity: number;
  /** Balance captured at the last daily reset (defaults to `balance`). */
  readonly referenceBalance?: number | undefined;
}

export type EquityProtectionTrigger =
  | { readonly triggered: false }
  | {
      readonly triggered: true;
      /** Which limit fired. */
      readonly kind: 'stop_loss' | 'take_profit';
      readonly rule:
        | 'max_drawdown_percent'
        | 'max_drawdown_value'
        | 'absolute_min_equity'
        | 'max_profit_percent'
        | 'max_profit_value'
        | 'absolute_max_equity';
      readonly threshold: number;
      readonly observed: number;
      readonly message: string;
      /** Actions to execute, resolved from the config. */
      readonly actions: readonly EquityProtectionAction[];
    };

export type EquityProtectionAction = 'notify' | 'disable_copier' | 'close_copied_trades' | 'close_all_trades';

export function evaluateEquityProtection(input: EquityProtectionInput): EquityProtectionTrigger {
  const { config, balance, equity } = input;
  if (!config.enabled) return { triggered: false };

  const reference = input.referenceBalance ?? balance;
  const actions = resolveActions(config);

  // --- stop-loss style (drawdown) ------------------------------------------
  if (config.maxDrawdownPercent !== null && reference > 0) {
    const floor = new Decimal(reference).times(1 - config.maxDrawdownPercent / 100).toNumber();
    if (equity <= floor) {
      return triggered('stop_loss', 'max_drawdown_percent', floor, equity, actions, config.maxDrawdownPercent);
    }
  }
  if (config.maxDrawdownValue !== null) {
    const floor = new Decimal(reference).minus(config.maxDrawdownValue).toNumber();
    if (equity <= floor) {
      return triggered('stop_loss', 'max_drawdown_value', floor, equity, actions, config.maxDrawdownValue);
    }
  }
  if (config.absoluteMinEquity !== null && equity <= config.absoluteMinEquity) {
    return triggered('stop_loss', 'absolute_min_equity', config.absoluteMinEquity, equity, actions, config.absoluteMinEquity);
  }

  // --- take-profit style (profit target) -----------------------------------
  if (config.maxProfitPercent !== null && reference > 0) {
    const ceiling = new Decimal(reference).times(1 + config.maxProfitPercent / 100).toNumber();
    if (equity >= ceiling) {
      return triggered('take_profit', 'max_profit_percent', ceiling, equity, actions, config.maxProfitPercent);
    }
  }
  if (config.maxProfitValue !== null) {
    const ceiling = new Decimal(reference).plus(config.maxProfitValue).toNumber();
    if (equity >= ceiling) {
      return triggered('take_profit', 'max_profit_value', ceiling, equity, actions, config.maxProfitValue);
    }
  }
  if (config.absoluteMaxEquity !== null && equity >= config.absoluteMaxEquity) {
    return triggered('take_profit', 'absolute_max_equity', config.absoluteMaxEquity, equity, actions, config.absoluteMaxEquity);
  }

  return { triggered: false };
}

function triggered(
  kind: 'stop_loss' | 'take_profit',
  rule: Extract<EquityProtectionTrigger, { triggered: true }>['rule'],
  threshold: number,
  observed: number,
  actions: readonly EquityProtectionAction[],
  configured: number,
): EquityProtectionTrigger {
  const direction = kind === 'stop_loss' ? 'dropped to' : 'reached';
  const limit = rule.startsWith('absolute')
    ? `${kind === 'stop_loss' ? 'the absolute minimum equity' : 'the absolute maximum equity'} ${threshold.toFixed(2)}`
    : `${kind === 'stop_loss' ? 'a drawdown limit of' : 'a profit target of'} ${configured} (${threshold.toFixed(2)})`;
  return {
    triggered: true,
    kind,
    rule,
    threshold,
    observed,
    message: `Equity ${direction} ${observed.toFixed(2)}, breaching ${limit}.`,
    actions,
  };
}

/**
 * Reference UI allows only one of {Disable Trade Copier, Manage Existing Trades}
 * and only one of {Close open copied trades, Close all open trades}. Validation
 * happens on the API; here we simply resolve the configured set.
 */
function resolveActions(config: EquityProtection): EquityProtectionAction[] {
  const actions: EquityProtectionAction[] = [];
  if (config.notify) actions.push('notify');
  if (config.disableCopier) actions.push('disable_copier');
  if (config.closeCopiedTrades) actions.push('close_copied_trades');
  if (config.closeAllTrades) actions.push('close_all_trades');
  return actions;
}

export interface EquityProtectionValidationIssue {
  readonly path: string;
  readonly message: string;
}

/** Cross-field rules the reference UI enforces (mutually exclusive actions). */
export function validateEquityProtection(config: EquityProtection): EquityProtectionValidationIssue[] {
  const issues: EquityProtectionValidationIssue[] = [];
  if (config.closeCopiedTrades && config.closeAllTrades) {
    issues.push({
      path: 'closeAllTrades',
      message: 'Enable either "Close open copied trades" or "Close all open trades", not both',
    });
  }
  if (!config.notify && !config.disableCopier && !config.closeCopiedTrades && !config.closeAllTrades) {
    issues.push({
      path: 'enabled',
      message: 'Equity Protection is enabled but no action is selected',
    });
  }
  if (
    config.maxDrawdownPercent === null &&
    config.maxDrawdownValue === null &&
    config.absoluteMinEquity === null &&
    config.maxProfitPercent === null &&
    config.maxProfitValue === null &&
    config.absoluteMaxEquity === null
  ) {
    issues.push({ path: 'enabled', message: 'Equity Protection is enabled but no limit is configured' });
  }
  return issues;
}

/** Reference balance bookkeeping for the daily reset. */
export interface DailyReference {
  readonly referenceBalance: number;
  readonly resetAt: Date;
}

export function referenceBalanceAt(resetAt: Date, balanceNow: number, lastKnown: DailyReference | null, now: Date): DailyReference {
  if (lastKnown && lastKnown.resetAt.getTime() >= resetAt.getTime() && lastKnown.resetAt.getTime() <= now.getTime()) {
    return lastKnown;
  }
  return { referenceBalance: balanceNow, resetAt };
}
