import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

/**
 * Password hashing with scrypt from `node:crypto`.
 *
 * Chosen over bcrypt/argon2 to keep the deployment dependency-free (no native
 * build step) while staying memory-hard. Parameters are stored alongside the
 * hash, so they can be raised later without invalidating existing hashes.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, keylen: 64 } as const;
const FORMAT = 'scrypt';

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password.normalize('NFKC'), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 128 * PARAMS.N * PARAMS.r * 2,
  });
  return [FORMAT, PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== FORMAT) return false;
  const [, nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  const salt = Buffer.from(saltRaw!, 'base64url');
  const expected = Buffer.from(hashRaw!, 'base64url');
  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N,
    r,
    p,
    maxmem: 128 * N * r * 2,
  });
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Cheap strength gate used by the register/reset endpoints. */
export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 10) problems.push('Use at least 10 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('Mix upper and lower case letters');
  if (!/\d/.test(password)) problems.push('Include at least one digit');
  return problems;
}
