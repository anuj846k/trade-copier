import Decimal from 'decimal.js';
import type { OrderKind, PendingOrderType, Position, TradeSide } from '@trade-copier/contracts';

/**
 * Master-side trade model.
 *
 * The bridge agent reports *position states*; the engine needs *events*. This
 * module owns that transformation (including the tricky partial-close case), so
 * the derivation is stated once and unit-tested once.
 */
export type MasterEventKind =
  | 'open'
  | 'modify'
  | 'close'
  | 'partial_close'
  | 'pending_placed'
  | 'pending_modified'
  | 'pending_cancelled'
  | 'pending_filled';

export interface MasterTradeSnapshot {
  readonly ticket: string;
  readonly symbol: string;
  readonly side: TradeSide;
  /** Current total volume still open on the master. */
  readonly volume: number;
  /** Cumulative volume closed via partial closes. */
  readonly closedVolume: number;
  readonly openPrice: number;
  readonly currentPrice: number | null;
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  readonly magic: number;
  readonly comment: string;
  readonly kind: OrderKind;
  readonly pendingType: PendingOrderType | null;
  readonly expiry: string | null;
  readonly openedAt: string;
  readonly updatedAt: string | null;
  readonly profit?: number | null;
  readonly swap?: number | null;
  readonly commission?: number | null;
}

export interface MasterEvent {
  readonly kind: MasterEventKind;
  readonly trade: MasterTradeSnapshot;
  /** Set for `partial_close`: the volume closed by this event. */
  readonly closedDeltaVolume?: number;
  readonly at: Date;
}

export function toSnapshot(position: Position): MasterTradeSnapshot {
  return {
    ticket: position.ticket,
    symbol: position.symbol,
    side: position.side,
    volume: position.volume,
    closedVolume: position.closedVolume ?? 0,
    openPrice: position.openPrice,
    currentPrice: position.currentPrice ?? null,
    stopLoss: position.stopLoss ?? null,
    takeProfit: position.takeProfit ?? null,
    magic: position.magic ?? 0,
    comment: position.comment ?? '',
    kind: position.kind,
    pendingType: position.pendingType ?? null,
    expiry: position.expiry ?? null,
    openedAt: position.openedAt,
    updatedAt: position.updatedAt ?? null,
    profit: position.profit ?? null,
    swap: position.swap ?? null,
    commission: position.commission ?? null,
  };
}

export interface PositionDiffResult {
  readonly events: readonly MasterEvent[];
  /** True when the two states are equivalent (no event emitted). */
  readonly unchanged: boolean;
}

/**
 * Derives the events implied by a state transition.
 *
 * - previous === null            → `open` (or `pending_placed` for pending orders)
 * - previous open, new closed    → `close`
 * - previous open, volume shrank → `partial_close` with the delta
 * - SL/TP/price changed          → `modify`
 * - pending order removed        → `pending_cancelled` (if it was never filled)
 */
export function diffPosition(previous: MasterTradeSnapshot | null, next: MasterTradeSnapshot, at: Date): PositionDiffResult {
  if (previous === null) {
    const kind: MasterEventKind = next.kind === 'pending' ? 'pending_placed' : 'open';
    return { events: [{ kind, trade: next, at }], unchanged: false };
  }

  const events: MasterEvent[] = [];

  const volumeChanged = !equal(previous.volume, next.volume);
  const closedDelta = new Decimal(previous.volume).minus(next.volume).toNumber();

  if (volumeChanged && closedDelta > 1e-9) {
    events.push({ kind: 'partial_close', trade: next, closedDeltaVolume: closedDelta, at });
  } else if (volumeChanged && closedDelta < -1e-9) {
    // Volume increased (add-on). Modelled as a modify: the engine tops up the
    // slave by the difference rather than opening a second position.
    events.push({ kind: 'modify', trade: next, at });
  }

  const stopsChanged =
    !equal(previous.stopLoss, next.stopLoss) || !equal(previous.takeProfit, next.takeProfit);
  if (stopsChanged) {
    const alreadyModify = events.some((event) => event.kind === 'modify');
    if (!alreadyModify) events.push({ kind: 'modify', trade: next, at });
  }

  return { events, unchanged: events.length === 0 };
}

/** Emitted when a position disappears from the master's snapshot. */
export function closeEvent(previous: MasterTradeSnapshot, at: Date, closePrice: number | null = null): MasterEvent {
  return {
    kind: 'close',
    trade: { ...previous, volume: 0, currentPrice: closePrice },
    at,
  };
}

/** Emitted when a pending order disappears without producing a position. */
export function pendingCancelledEvent(order: MasterTradeSnapshot, at: Date): MasterEvent {
  return { kind: 'pending_cancelled', trade: order, at };
}

/**
 * A pending order that has been filled shows up as a new market position with
 * its own ticket on most platforms. When the platform keeps the same ticket, we
 * synthesise a `pending_filled` event so the planner treats it as an entry.
 */
export function pendingFilledEvent(next: MasterTradeSnapshot, at: Date): MasterEvent {
  return { kind: 'pending_filled', trade: next, at: { ...at } };
}

function equal(a: number | null, b: number | null, tolerance = 1e-9): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= tolerance;
}
