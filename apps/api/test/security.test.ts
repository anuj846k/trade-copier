import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/lib/ratelimit.js';
import { SecretCipher, randomToken, safeEquals, sha256 } from '../src/lib/crypto.js';
import { TicketStore } from '../src/lib/tickets.js';

/**
 * Small security primitives.
 *
 * Each of these guards one specific failure mode: secret leakage at rest,
 * timing-based token comparison, replay of a realtime ticket and brute-force
 * password guessing. They are cheap to test and expensive to get wrong.
 */

describe('SecretCipher (AES-256-GCM)', () => {
  const cipher = new SecretCipher(Buffer.alloc(32, 9).toString('base64'));

  it('round-trips a broker password', () => {
    const encrypted = cipher.encrypt('hunter2-with-symbols-!@#');
    expect(encrypted).not.toContain('hunter2');
    expect(encrypted.startsWith('v1.')).toBe(true);
    expect(cipher.decrypt(encrypted)).toBe('hunter2-with-symbols-!@#');
  });

  it('uses a fresh nonce, so identical plaintexts differ', () => {
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('detects tampering instead of returning garbage', () => {
    const encrypted = cipher.encrypt('sensitive');
    const parts = encrypted.split('.');
    // Flip a byte in the payload.
    const payload = Buffer.from(parts[3]!, 'base64url');
    payload[0] = payload[0]! ^ 0xff;
    parts[3] = payload.toString('base64url');
    expect(cipher.decrypt(parts.join('.'))).toBeNull();
  });

  it('returns null for a wrong key rather than throwing', () => {
    const other = new SecretCipher(Buffer.alloc(32, 4).toString('base64'));
    expect(other.decrypt(cipher.encrypt('secret'))).toBeNull();
  });

  it('returns null for missing or malformed payloads', () => {
    expect(cipher.decrypt(null)).toBeNull();
    expect(cipher.decrypt(undefined)).toBeNull();
    expect(cipher.decrypt('')).toBeNull();
    expect(cipher.decrypt('v2.a.b.c')).toBeNull();
    expect(cipher.decrypt('not-encrypted-at-all')).toBeNull();
  });

  it('refuses a key that is not 32 bytes', () => {
    expect(() => new SecretCipher(Buffer.alloc(16, 1).toString('base64'))).toThrow(/32 bytes/);
  });

  it('fingerprints without revealing the secret', () => {
    const fingerprint = cipher.fingerprint('hunter2');
    expect(fingerprint).toHaveLength(12);
    expect('hunter2').not.toContain(fingerprint);
    expect(cipher.fingerprint('hunter2')).toBe(fingerprint);
    expect(cipher.fingerprint('hunter3')).not.toBe(fingerprint);
  });
});

describe('token helpers', () => {
  it('compares in constant time and rejects differing lengths', () => {
    expect(safeEquals('abc', 'abc')).toBe(true);
    expect(safeEquals('abc', 'abd')).toBe(false);
    expect(safeEquals('abc', 'abcd')).toBe(false);
    expect(safeEquals('', '')).toBe(true);
  });

  it('hashes deterministically for at-rest lookups', () => {
    expect(sha256('token')).toBe(sha256('token'));
    expect(sha256('token')).toHaveLength(64);
    expect(sha256('token')).not.toBe(sha256('token '));
  });

  it('mints prefixed, high-entropy tokens', () => {
    const token = randomToken('rt');
    expect(token.startsWith('rt_')).toBe(true);
    expect(token.length).toBeGreaterThan(30);
    expect(randomToken('rt')).not.toBe(token);
  });
});

describe('RateLimiter (fixed window)', () => {
  it('allows up to the limit and then blocks', () => {
    const limiter = new RateLimiter(3, 1_000, () => 0);
    expect(limiter.consume('ip').allowed).toBe(true);
    expect(limiter.consume('ip').allowed).toBe(true);
    const third = limiter.consume('ip');
    expect(third.allowed).toBe(true);
    expect(third.remaining).toBe(0);

    const fourth = limiter.consume('ip');
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
  });

  it('keys buckets independently', () => {
    const limiter = new RateLimiter(1, 1_000, () => 0);
    expect(limiter.consume('a').allowed).toBe(true);
    expect(limiter.consume('a').allowed).toBe(false);
    expect(limiter.consume('b').allowed).toBe(true);
  });

  it('resets when the window rolls over', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.consume('ip').allowed).toBe(true);
    expect(limiter.consume('ip').allowed).toBe(false);
    now = 1_000;
    expect(limiter.consume('ip').allowed).toBe(true);
  });

  it('prunes expired buckets so memory does not grow with traffic', () => {
    let now = 0;
    const limiter = new RateLimiter(5, 1_000, () => now);
    limiter.consume('a');
    limiter.consume('b');
    expect(limiter.size).toBe(2);
    now = 2_000;
    limiter.prune();
    expect(limiter.size).toBe(0);
  });
});

describe('TicketStore (single-use realtime tickets)', () => {
  it('issues an opaque ticket and consumes it exactly once', () => {
    const store = new TicketStore(60_000, () => 1_000);
    const issued = store.issue('user_1');
    expect(issued.userId).toBe('user_1');
    expect(issued.ticket.length).toBeGreaterThan(20);
    expect(issued.expiresAt).toBe(61_000);

    expect(store.consume(issued.ticket)?.userId).toBe('user_1');
    // Replay must fail: that is the whole point of a ticket.
    expect(store.consume(issued.ticket)).toBeNull();
  });

  it('refuses an expired ticket', () => {
    let now = 0;
    const store = new TicketStore(1_000, () => now);
    const issued = store.issue('user_1');
    now = 1_001;
    expect(store.consume(issued.ticket)).toBeNull();
  });

  it('refuses an unknown ticket', () => {
    const store = new TicketStore(1_000, () => 0);
    expect(store.consume('made-up')).toBeNull();
  });

  it('prunes expired tickets without removing live ones', () => {
    let now = 0;
    const store = new TicketStore(1_000, () => now);
    const live = store.issue('user_1');
    store.issue('user_2');
    now = 500;
    store.prune();
    expect(store.size).toBe(2);
    now = 1_500;
    store.prune();
    expect(store.size).toBe(0);
    expect(store.consume(live.ticket)).toBeNull();
  });
});
