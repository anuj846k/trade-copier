import { describe, expect, it } from 'vitest';
import { hashPassword, passwordProblems, verifyPassword } from '../src/lib/passwords.js';

/**
 * Password hashing.
 *
 * scrypt parameters are stored *inside* the hash string, which is what lets
 * them be raised later without invalidating existing accounts. These tests pin
 * that format and the verification behaviour; they also assert that a stored
 * hash never contains the plaintext.
 */

const PASSWORD = 'correct-horse-battery-1';

describe('hashPassword', () => {
  it('produces a self-describing scrypt hash', async () => {
    const hash = await hashPassword(PASSWORD);
    const parts = hash.split('$');
    expect(parts).toHaveLength(6);
    expect(parts[0]).toBe('scrypt');
    // N, r, p are recorded so they can be changed without a migration.
    expect(Number(parts[1])).toBeGreaterThanOrEqual(2 ** 14);
    expect(Number(parts[2])).toBeGreaterThan(0);
    expect(Number(parts[3])).toBeGreaterThan(0);
    expect(hash).not.toContain(PASSWORD);
  });

  it('salts, so the same password hashes differently every time', async () => {
    const [first, second] = await Promise.all([hashPassword(PASSWORD), hashPassword(PASSWORD)]);
    expect(first).not.toBe(second);
    expect(await verifyPassword(PASSWORD, first)).toBe(true);
    expect(await verifyPassword(PASSWORD, second)).toBe(true);
  });

  it('normalises unicode, so a password can be typed on another keyboard layout', async () => {
    const hash = await hashPassword('pässwörd-with-ümlauts-1');
    expect(await verifyPassword('pa\u0308sswo\u0308rd-with-u\u0308mlauts-1', hash)).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('accepts the correct password and rejects everything else', async () => {
    const hash = await hashPassword(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword(`${PASSWORD} `, hash)).toBe(false);
    expect(await verifyPassword(PASSWORD.toUpperCase(), hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('returns false rather than throwing for missing or malformed stored hashes', async () => {
    expect(await verifyPassword(PASSWORD, null)).toBe(false);
    expect(await verifyPassword(PASSWORD, undefined)).toBe(false);
    expect(await verifyPassword(PASSWORD, '')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'bcrypt$not$ours')).toBe(false);
    expect(await verifyPassword(PASSWORD, 'scrypt$not-a-number$8$1$c2FsdA$aGFzaA')).toBe(false);
  });
});

describe('passwordProblems', () => {
  it('accepts a long mixed-case password with a digit', () => {
    expect(passwordProblems('Str0ngEnough!')).toEqual([]);
  });

  it('lists every unmet rule', () => {
    expect(passwordProblems('short')).toEqual(['Use at least 10 characters', 'Mix upper and lower case letters', 'Include at least one digit']);
  });

  it('accepts a password with no symbol, matching the API contract', () => {
    // The reference product does not require symbols, and requiring them
    // measurably pushes users towards weaker, more predictable patterns.
    expect(passwordProblems('LowerUppercase1')).toEqual([]);
  });

  it('requires a digit and mixed case independently', () => {
    expect(passwordProblems('alllowercaseonly')).toContain('Mix upper and lower case letters');
    expect(passwordProblems('AllUpperCaseOnlyX')).toContain('Include at least one digit');
  });
});
