import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret handling for data at rest.
 *
 * Broker passwords, agent tokens and notification secrets are encrypted with
 * AES-256-GCM using a key that only lives in the environment. Ciphertext is
 * self-describing: `v1.<iv>.<tag>.<payload>` (all base64url), so the format can
 * be rotated later without guessing.
 */
const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;

export class SecretCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must decode to exactly 32 bytes');
    }
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  /** Returns null when the payload cannot be decrypted (wrong key, tampering). */
  decrypt(payload: string | null | undefined): string | null {
    if (!payload) return null;
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== VERSION) return null;
    try {
      const [, iv, tag, data] = parts;
      const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(iv!, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag!, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(data!, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  /** Non-secret fingerprint so the UI can show "which password is stored". */
  fingerprint(plaintext: string): string {
    return createHash('sha256').update(plaintext).digest('hex').slice(0, 12);
  }
}

/** Constant-time comparison for tokens and signatures. */
export function safeEquals(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}
