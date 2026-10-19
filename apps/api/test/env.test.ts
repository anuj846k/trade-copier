import { describe, expect, it } from 'vitest';
import { EnvValidationError, envSchema, loadEnv, marketSessionFromEnv } from '../src/config/env.js';

/**
 * Environment validation.
 *
 * A mis-set variable must fail loudly at boot with a message that names the
 * variable, because the alternative is a process that starts and then behaves
 * strangely (a wrong secret, a silent default).
 */

const VALID = {
  DATABASE_URL: 'postgres://localhost:5432/trade_copier',
  JWT_SECRET: 'a-secret-long-enough-to-pass-the-length-check',
  ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
} satisfies Record<string, string>;

function parse(source: Record<string, string | undefined>) {
  return envSchema.safeParse({ NODE_ENV: 'test', ...source });
}

describe('required variables', () => {
  it('accepts a minimal configuration and applies documented defaults', () => {
    const result = parse(VALID);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.API_PORT).toBe(4_000);
    expect(result.data.CORS_ORIGINS).toEqual(['http://localhost:3000']);
    expect(result.data.ACCESS_TOKEN_TTL).toBe(900_000);
    expect(result.data.RUN_WORKER_IN_PROCESS).toBe(true);
    expect(result.data.WORKER_BATCH_SIZE).toBe(25);
    expect(result.data.COPY_MAX_ATTEMPTS).toBe(24);
    expect(result.data.DEFAULT_MAX_SLIPPAGE_PIPS).toBe(2);
  });

  it('fails when DATABASE_URL is missing', () => {
    const { DATABASE_URL: _drop, ...rest } = VALID;
    expect(parse(rest).success).toBe(false);
  });

  it('fails when JWT_SECRET is too short and says so', () => {
    const result = parse({ ...VALID, JWT_SECRET: 'too-short' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some((issue) => issue.message.includes('JWT_SECRET must be at least 32 characters'))).toBe(true);
  });

  it('fails when ENCRYPTION_KEY is not 32 bytes of base64', () => {
    for (const key of ['', 'not-base64!!', Buffer.alloc(16, 1).toString('base64')]) {
      const result = parse({ ...VALID, ENCRYPTION_KEY: key });
      expect(result.success).toBe(false);
      if (result.success) continue;
      expect(result.error.issues.some((issue) => issue.message.includes('ENCRYPTION_KEY must be 32 bytes'))).toBe(true);
    }
  });
});

describe('coercions and transforms', () => {
  it('splits CORS_ORIGINS into a trimmed list', () => {
    const result = parse({ ...VALID, CORS_ORIGINS: 'https://app.test, https://staging.test ,' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.CORS_ORIGINS).toEqual(['https://app.test', 'https://staging.test']);
  });

  it('reads human durations', () => {
    const result = parse({ ...VALID, ACCESS_TOKEN_TTL: '15m', COMMAND_TIMEOUT_MS: '3000' });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.ACCESS_TOKEN_TTL).toBe(900_000);
    expect(result.data.COMMAND_TIMEOUT_MS).toBe(3_000);
  });

  it('accepts the boolean spellings a shell produces', () => {
    for (const [raw, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['false', false],
      ['0', false],
      ['no', false],
    ] as const) {
      const result = parse({ ...VALID, RUN_WORKER_IN_PROCESS: raw });
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.data.RUN_WORKER_IN_PROCESS).toBe(expected);
    }
  });

  it('rejects an out-of-range port instead of defaulting silently', () => {
    expect(parse({ ...VALID, API_PORT: '99999' }).success).toBe(false);
  });

  it('rejects an unknown log level', () => {
    expect(parse({ ...VALID, LOG_LEVEL: 'chatty' }).success).toBe(false);
  });
});

describe('loadEnv', () => {
  it('does not read .env when asked not to, and reports every problem at once', () => {
    expect(() => loadEnv({ loadDotEnv: false, source: { NODE_ENV: 'test' } })).toThrow(EnvValidationError);
    try {
      loadEnv({ loadDotEnv: false, source: { NODE_ENV: 'test' } });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('JWT_SECRET');
      expect(message).toContain('ENCRYPTION_KEY');
    }
  });

  it('returns a frozen, typed Env for a valid source', () => {
    const env = loadEnv({ loadDotEnv: false, source: { NODE_ENV: 'test', ...VALID } });
    expect(env.NODE_ENV).toBe('test');
    expect(env.CORS_ORIGINS).toBeInstanceOf(Array);
  });
});

describe('marketSessionFromEnv', () => {
  it('derives the FX week, daily break and holidays the domain expects', () => {
    const env = loadEnv({ loadDotEnv: false, source: { NODE_ENV: 'test', ...VALID } });
    const session = marketSessionFromEnv(env);
    // Weekday 5 = Friday; the FX week closes at 21:00 UTC.
    expect(session.fxWeekClose).toEqual({ weekday: 5, time: '21:00' });
    expect(session.fxWeekOpen).toEqual({ weekday: 7, time: '21:00' });
    expect(session.dailyBreak).toEqual({ start: '21:00', end: '22:00' });
    expect(session.holidays).toContain('12-25');
  });
});
