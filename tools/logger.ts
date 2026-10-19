import type { EngineOptions } from '../apps/api/src/engine/worker.js';

type Logger = EngineOptions['log'];

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

/**
 * A pino-shaped logger for the tools.
 *
 * `pino` is a dependency of `apps/api`, not of the repo root, so importing it
 * here would drag a server dependency into the tooling layer for the sake of
 * five log lines. This implements the calling conventions the engine actually
 * uses — `info(msg)`, `info(obj, msg)`, `child(bindings)` — over `console`, and
 * is cast to the engine's logger type at the boundary.
 */
export function createConsoleLogger(options: { level?: Level; prefix?: string } = {}): Logger {
  const threshold = LEVELS[options.level ?? 'info'];

  const write = (level: Level, bindings: Record<string, unknown>, args: unknown[]): void => {
    if (LEVELS[level] < threshold) return;

    let context: Record<string, unknown> = { ...bindings };
    let message = '';

    if (typeof args[0] === 'string') {
      message = args[0];
    } else if (args[0] instanceof Error) {
      context = { ...context, err: args[0].message, stack: args[0].stack };
      message = typeof args[1] === 'string' ? args[1] : '';
    } else if (typeof args[0] === 'object' && args[0] !== null) {
      context = { ...context, ...(args[0] as Record<string, unknown>) };
      message = typeof args[1] === 'string' ? args[1] : '';
    }

    const rest = Object.entries(context)
      .map(([key, value]) => `${key}=${formatValue(value)}`)
      .join(' ');
    const line = [options.prefix, message || undefined, rest || undefined].filter(Boolean).join(' ');

    // The engine logs `err.stack` inside the context object; printing on the
    // right stream keeps `pnpm sim 2>/dev/null` readable.
    const target = LEVELS[level] >= LEVELS.error ? console.error : console.log;
    target(`[${level.toUpperCase()}] ${line}`);
  };

  const logger = {
    level: options.level ?? 'info',
    trace: (...args: unknown[]) => write('trace', {}, args),
    debug: (...args: unknown[]) => write('debug', {}, args),
    info: (...args: unknown[]) => write('info', {}, args),
    warn: (...args: unknown[]) => write('warn', {}, args),
    error: (...args: unknown[]) => write('error', {}, args),
    fatal: (...args: unknown[]) => write('fatal', {}, args),
    child: (bindings: Record<string, unknown>) =>
      createConsoleLogger({ level: options.level ?? 'info', prefix: [options.prefix, formatValue(bindings)].filter(Boolean).join(' ') }),
    silent: () => undefined,
  };

  return logger as unknown as Logger;
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
