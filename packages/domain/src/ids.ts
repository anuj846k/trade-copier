import type { CommandKind } from '@trade-copier/contracts';

/**
 * Deterministic identity helpers.
 *
 * Why determinism matters: the copy engine is at-least-once. A command that is
 * retried (agent timeout, reconnect, worker crash) must be recognised as the
 * *same* intent, and the slave position must carry a tag we can find again.
 */
export interface CopyRequestKey {
  readonly copierId: string;
  readonly followerId: string;
  /** Broker ticket of the master position/order. */
  readonly masterTicket: string;
  /** Monotonic intent counter for this master trade (open=1, modify=2, …). */
  readonly seq: number;
  readonly kind: CommandKind;
}

/** Readable, stable, collision-free id used in the DB, logs and agent protocol. */
export function copyRequestId(key: CopyRequestKey): string {
  return `cp:${key.copierId}:${key.followerId}:${key.masterTicket}:${key.seq}:${key.kind}`;
}

/** Intent sequence allocation — pure so planner decisions stay reproducible. */
export function nextIntentSeq(previous: readonly { seq: number }[]): number {
  return previous.reduce((max, entry) => (entry.seq > max ? entry.seq : max), 0) + 1;
}

/**
 * Comment tag written on the slave position. Kept short (MT4 caps comments at
 * 31 chars) and derived from the request id so reconciliation can find our
 * positions by tag even when the magic number is user-overridden.
 */
export function shortTag(requestId: string, maxLength = 31): string {
  const digest = fnv1a(requestId).toString(36).padStart(6, '0');
  return `TC-${digest}`.slice(0, maxLength);
}

/**
 * Magic number for a slave position.
 *   - `master` mode reuses the master magic (default, preserves user semantics),
 *   - `custom` mode uses the configured value,
 *   - when both are 0 we derive a stable per-follower magic so that
 *     reconciliation and Equity Protection can find copier-placed trades.
 */
export function resolveMagic(input: {
  magicMode: 'master' | 'custom';
  customMagic: number | null;
  masterMagic: number;
  followerId: string;
}): { magic: number; derived: boolean } {
  if (input.magicMode === 'custom' && input.customMagic !== null) {
    return { magic: input.customMagic, derived: false };
  }
  if (input.magicMode === 'custom') {
    return { magic: derivedMagic(input.followerId), derived: true };
  }
  if (input.masterMagic !== 0) return { magic: input.masterMagic, derived: false };
  return { magic: derivedMagic(input.followerId), derived: true };
}

/** Stable pseudo-magic (1..2_000_000_000) derived from the follower id. */
export function derivedMagic(followerId: string): number {
  return (fnv1a(`magic:${followerId}`) % 2_000_000_000) + 1;
}

/** FNV-1a 32-bit, unsigned. Deterministic across runtimes. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Trade delay: fixed when min === max, otherwise uniformly random in range. */
export function tradeDelayMs(min: number, max: number, random: () => number = Math.random): number {
  if (max <= min) return Math.max(0, min);
  return Math.round(min + random() * (max - min));
}

/** Cursor helpers for keyset pagination (opaque, monotonic by (createdAt, id)). */
export function encodeCursor(createdAt: string | Date, id: string): string {
  const iso = typeof createdAt === 'string' ? createdAt : createdAt.toISOString();
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const separator = decoded.lastIndexOf('|');
    if (separator <= 0) return null;
    return { createdAt: decoded.slice(0, separator), id: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}
