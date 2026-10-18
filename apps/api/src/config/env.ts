import { existsSync, readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Environment validation.
 *
 * A trade copier that silently starts with a missing secret or a bad TTL is
 * worse than one that refuses to start, so every variable is parsed and
 * coerced here and `loadEnv` throws with a readable report on failure.
 */

const WEEKDAYS: Record<string, number> = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => (typeof value === 'boolean' ? value : ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())));

/** `15m`, `900`, `2h`, `1d` → milliseconds. */
const duration = z
  .union([z.number(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === 'number') return value;
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i);
    if (!match) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid duration "${value}"` });
      return z.NEVER;
    }
    const amount = Number(match[1]);
    const unit = (match[2] ?? 'ms').toLowerCase();
    const factor = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit] ?? 1;
    return Math.round(amount * factor);
  });

/** `Sunday 21:00` / `21:00` → `{ weekday, time }` in UTC. */
const fxBoundary = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value, ctx) => {
  const match = value.trim().match(/^(?:([A-Za-z]+)\s+)?(\d{1,2}):(\d{2})$/);
  if (!match) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Expected "Sunday 21:00" or "21:00", got "${value}"` });
    return z.NEVER;
  }
  const [, weekdayName, hour, minute] = match;
  return {
    weekday: weekdayName ? (WEEKDAYS[weekdayName.toLowerCase()] ?? 7) : 7,
    time: `${hour!.padStart(2, '0')}:${minute}`,
  };
});

const hhmm = z.string().regex(/^\d{1,2}:\d{2}$/, 'Expected HH:mm');

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:3000')
    .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean)),
  APP_VERSION: z.string().default('0.1.0'),

  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().optional(),
  DB_POOL_SIZE: z.coerce.number().int().min(1).max(200).default(10),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: duration.default(900_000),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          return Buffer.from(value, 'base64').length === 32;
        } catch {
          return false;
        }
      },
      { message: 'ENCRYPTION_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)' },
    ),

  RUN_WORKER_IN_PROCESS: booleanish.default(true),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(10).default(250),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  WORKER_ACCOUNT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(1),
  COMMAND_TIMEOUT_MS: z.coerce.number().int().min(100).default(3_000),
  COPY_RETRY_WINDOW_MS: duration.default(900_000),
  COPY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(200).default(24),
  COPY_RETRY_BASE_MS: z.coerce.number().int().min(10).default(500),
  COPY_RETRY_MAX_MS: z.coerce.number().int().min(100).default(30_000),
  AGENT_HEARTBEAT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(10_000),
  AGENT_HEARTBEAT_GRACE_MS: z.coerce.number().int().min(1_000).default(35_000),
  EQUITY_SNAPSHOT_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
  EQUITY_PROTECTION_INTERVAL_MS: z.coerce.number().int().min(1_000).default(5_000),

  FX_WEEK_OPEN_UTC: fxBoundary('Sunday 21:00'),
  FX_WEEK_CLOSE_UTC: fxBoundary('Friday 21:00'),
  FX_DAILY_BREAK_START_UTC: hhmm.default('21:00'),
  FX_DAILY_BREAK_END_UTC: hhmm.default('22:00'),
  QUOTE_MAX_AGE_MS: z.coerce.number().int().min(100).default(5_000),
  DEFAULT_MAX_SLIPPAGE_PIPS: z.coerce.number().min(0).default(2),

  SMTP_HOST: z.string().optional().default(''),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: booleanish.default(false),
  SMTP_USER: z.string().optional().default(''),
  SMTP_PASSWORD: z.string().optional().default(''),
  MAIL_FROM: z.string().default('Trade Copier <no-reply@example.com>'),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  NOTIFICATION_WEBHOOK_SECRET: z.string().optional().default(''),

  ENABLED_PLAN_CODES: z
    .string()
    .default('standard_monthly,premium_monthly,premium_annual')
    .transform((value) => value.split(',').map((code) => code.trim()).filter(Boolean)),
  FALLBACK_ACCOUNT_LIMIT: z.coerce.number().int().min(1).default(10),

  REALTIME_TICKET_TTL_SECONDS: z.coerce.number().int().min(5).max(600).default(60),
  BRIDGE_PING_INTERVAL_MS: z.coerce.number().int().min(1_000).default(15_000),
});

export type Env = z.infer<typeof envSchema>;

export interface LoadEnvOptions {
  /** Defaults to `process.env`; tests pass an explicit object. */
  readonly source?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Skip filesystem `.env` loading (tests always skip it). */
  readonly loadDotEnv?: boolean;
}

/**
 * Reads a `.env` file into the environment without adding a dependency.
 * Later files do not override variables already present in the environment.
 */
function loadDotEnvFile(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export class EnvValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

export function loadEnv(options: LoadEnvOptions = {}): Env {
  if (options.loadDotEnv !== false) {
    loadDotEnvFile('.env');
    loadDotEnvFile('../../.env');
  }
  const parsed = envSchema.safeParse(options.source ?? process.env);
  if (!parsed.success) {
    throw new EnvValidationError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return parsed.data;
}

/** Market-session config derived from the environment (see domain/market-hours). */
export function marketSessionFromEnv(env: Env) {
  return {
    fxWeekOpen: env.FX_WEEK_OPEN_UTC,
    fxWeekClose: env.FX_WEEK_CLOSE_UTC,
    dailyBreak: { start: env.FX_DAILY_BREAK_START_UTC, end: env.FX_DAILY_BREAK_END_UTC },
    holidays: ['01-01', '12-25', '12-26'],
  };
}
