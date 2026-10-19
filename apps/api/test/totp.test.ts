import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  generateTotp,
  generateTotpSecret,
  totpCodeForCounter,
  totpUri,
  verifyTotp,
} from '../src/lib/totp.js';

/**
 * TOTP (RFC 6238).
 *
 * The RFC's Appendix B publishes test vectors for the SHA-1 profile with the
 * ASCII secret "12345678901234567890" and 8 digits. Matching them exactly is
 * the only credible evidence that an authenticator app will agree with this
 * implementation, so they are asserted against the raw counter helper as well
 * as through `generateTotp`.
 */

const RFC_SECRET_ASCII = Buffer.from('12345678901234567890', 'ascii');
const RFC_SECRET_BASE32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC_VECTORS: ReadonlyArray<{ unixTime: number; code: string }> = [
  { unixTime: 59, code: '94287082' },
  { unixTime: 1_111_111_109, code: '07081804' },
  { unixTime: 1_111_111_111, code: '14050471' },
  { unixTime: 1_234_567_890, code: '89005924' },
  { unixTime: 2_000_000_000, code: '69279037' },
  { unixTime: 20_000_000_000, code: '65353130' },
];

describe('base32', () => {
  it('encodes to the RFC 4648 alphabet without padding', () => {
    expect(base32Encode(RFC_SECRET_ASCII)).toBe(RFC_SECRET_BASE32);
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = Buffer.from([0, 1, 2, 253, 254, 255, 128, 64, 32, 16, 8, 4, 2, 1]);
    expect(base32Decode(base32Encode(bytes)).equals(bytes)).toBe(true);
  });

  it('tolerates lowercase input, padding and whitespace', () => {
    expect(base32Decode('gezdgnbvgy3tqojq gezdgnbvgy3tqojq==').equals(RFC_SECRET_ASCII)).toBe(true);
  });

  it('rejects characters outside the alphabet', () => {
    expect(() => base32Decode('GEZD-GNBV')).toThrow(/Invalid base32/);
  });
});

describe('RFC 6238 test vectors (SHA-1, 8 digits, 30 s step)', () => {
  for (const vector of RFC_VECTORS) {
    it(`matches the published code at T=${vector.unixTime}`, () => {
      const counter = Math.floor(vector.unixTime / 30);
      expect(totpCodeForCounter(RFC_SECRET_ASCII, counter, 8)).toBe(vector.code);
    });
  }

  it('produces the same codes through the public API', () => {
    for (const vector of RFC_VECTORS) {
      expect(generateTotp(RFC_SECRET_BASE32, new Date(vector.unixTime * 1_000), { digits: 8 })).toBe(vector.code);
    }
  });

  it('returns six digits by default, zero padded', () => {
    const at = new Date(59 * 1_000);
    const code = generateTotp(RFC_SECRET_BASE32, at);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
    // 94287082 truncated to the low six digits is what modulo yields.
    expect(code).toBe('287082');
  });
});

describe('verifyTotp', () => {
  const at = new Date('2026-03-04T10:00:00.000Z');
  const secret = generateTotpSecret();
  const code = generateTotp(secret, at);

  it('accepts the current code', () => {
    expect(verifyTotp(code, secret, at)).toBe(true);
  });

  it('accepts one step of clock drift in either direction', () => {
    const previous = generateTotp(secret, new Date(at.getTime() - 30_000));
    const next = generateTotp(secret, new Date(at.getTime() + 30_000));
    expect(verifyTotp(previous, secret, at)).toBe(true);
    expect(verifyTotp(next, secret, at)).toBe(true);
  });

  it('rejects a code two steps away', () => {
    const stale = generateTotp(secret, new Date(at.getTime() - 90_000));
    expect(verifyTotp(stale, secret, at)).toBe(false);
  });

  it('rejects a code from a different secret', () => {
    expect(verifyTotp(generateTotp(generateTotpSecret(), at), secret, at)).toBe(false);
  });

  it('rejects malformed tokens without throwing', () => {
    expect(verifyTotp('abcdef', secret, at)).toBe(false);
    expect(verifyTotp('12345', secret, at)).toBe(false);
    expect(verifyTotp('', secret, at)).toBe(false);
    expect(verifyTotp('1234567', secret, at)).toBe(false);
  });

  it('ignores spaces that authenticator apps insert', () => {
    expect(verifyTotp(`${code.slice(0, 3)} ${code.slice(3)}`, secret, at)).toBe(true);
  });
});

describe('secret generation and enrolment URI', () => {
  it('generates a distinct 32-character base32 secret each time', () => {
    const first = generateTotpSecret();
    const second = generateTotpSecret();
    expect(first).toHaveLength(32);
    expect(first).toMatch(/^[A-Z2-7]+$/);
    expect(first).not.toBe(second);
  });

  it('builds an otpauth URI an authenticator app can consume', () => {
    const uri = totpUri(RFC_SECRET_BASE32, 'trader@example.test');
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    const url = new URL(uri);
    expect(url.searchParams.get('secret')).toBe(RFC_SECRET_BASE32);
    expect(url.searchParams.get('algorithm')).toBe('SHA1');
    expect(url.searchParams.get('digits')).toBe('6');
    expect(url.searchParams.get('period')).toBe('30');
    expect(decodeURIComponent(url.pathname)).toContain('trader@example.test');
  });
});
