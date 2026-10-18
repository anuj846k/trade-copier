import { createHmac, randomBytes } from 'node:crypto';

/**
 * TOTP (RFC 6238) implemented on `node:crypto`, so the API ships without a
 * native or heavyweight 2FA dependency. Verified against the RFC test vectors
 * in `apps/api/test/totp.test.ts`.
 */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function base32Decode(secret: string): Buffer {
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  /** Time step in seconds (RFC 6238 default). */
  readonly step?: number;
  /** Digits in the generated code. */
  readonly digits?: number;
  /** Accept codes from ±`window` steps to tolerate clock drift. */
  readonly window?: number;
}

/** The code for a specific counter (exported for the RFC test vectors). */
export function totpCodeForCounter(secret: Buffer, counter: number, digits = 6): string {
  const buffer = Buffer.alloc(8);
  buffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buffer.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return (binary % 10 ** digits).toString().padStart(digits, '0');
}

export function generateTotp(secretBase32: string, at: Date = new Date(), options: TotpOptions = {}): string {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor(at.getTime() / 1000 / step);
  return totpCodeForCounter(base32Decode(secretBase32), counter, digits);
}

export function verifyTotp(
  token: string,
  secretBase32: string,
  at: Date = new Date(),
  options: TotpOptions = {},
): boolean {
  const step = options.step ?? 30;
  const digits = options.digits ?? 6;
  const window = options.window ?? 1;
  const code = token.replace(/\s+/g, '');
  if (!new RegExp(`^\\d{${digits}}$`).test(code)) return false;
  const secret = base32Decode(secretBase32);
  const counter = Math.floor(at.getTime() / 1000 / step);
  for (let offset = -window; offset <= window; offset += 1) {
    if (totpCodeForCounter(secret, counter + offset, digits) === code) return true;
  }
  return false;
}

/** `otpauth://` URI for the enrolment QR code. */
export function totpUri(secretBase32: string, account: string, issuer = 'Trade Copier'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Single-use recovery codes, stored hashed by the caller. */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => randomBytes(5).toString('hex').match(/.{4}/g)!.join('-'));
}
