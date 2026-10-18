import { ERROR_CATALOG, type CopierErrorCode } from '@trade-copier/contracts';

/**
 * HTTP error mapping.
 *
 * Every failure leaves the API with the same envelope — `{ error: { code,
 * message, details } }` — and an HTTP status derived from the machine-readable
 * code, so the dashboard never has to parse prose.
 */
export class ApiError extends Error {
  constructor(
    readonly code: CopierErrorCode | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'RATE_LIMITED' | 'INTERNAL',
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static badRequest(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('VALIDATION', message, 400, details);
  }

  static unauthenticated(message = 'Sign in to continue'): ApiError {
    return new ApiError('UNAUTHENTICATED', message, 401);
  }

  static forbidden(message = 'You do not have access to this resource'): ApiError {
    return new ApiError('FORBIDDEN', message, 403);
  }

  static notFound(message = 'Not found'): ApiError {
    return new ApiError('NOT_FOUND', message, 404);
  }

  static conflict(message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError('CONFLICT', message, 409, details);
  }

  static rateLimited(message = 'Too many requests, slow down'): ApiError {
    return new ApiError('RATE_LIMITED', message, 429);
  }

  /** A copy-engine failure surfaced through the HTTP API (e.g. test a symbol). */
  static fromCopierCode(code: CopierErrorCode, message: string, details?: Record<string, unknown>): ApiError {
    return new ApiError(code, message, statusForCode(code), details);
  }
}

const CLIENT_CODES: ReadonlySet<string> = new Set([
  'VALIDATION',
  'SYMBOL_NOT_MAPPED',
  'SYMBOL_DISABLED',
  'SYMBOL_MISMATCH',
  'ACCOUNT_DISABLED',
  'ACCOUNT_DISCONNECTED',
  'AGENT_OFFLINE',
  'COPIER_DISABLED',
  'FOLLOWER_DISABLED',
  'OUTSIDE_TRADING_HOURS',
  'EQUITY_PROTECTION',
  'INVALID_VOLUME',
  'INVALID_PRICE',
  'INVALID_SLTP',
  'TICKET_NOT_FOUND',
  'ORDER_NOT_FOUND',
  'NOT_COPIED',
  'PENDING_DEFERRED',
  'STRICT_CLOSE_IGNORED',
  'DUPLICATE_REQUEST',
  'MARKET_CLOSED',
  'FILTERED_MAGIC',
  'FILTERED_COMMENT',
  'FILTERED_SIDE',
  'FILTERED_LOT',
  'FILTERED_SYMBOL',
  'LINK_CLOSED',
]);

function statusForCode(code: CopierErrorCode | string): number {
  if (code === 'TICKET_NOT_FOUND' || code === 'ORDER_NOT_FOUND') return 404;
  if (CLIENT_CODES.has(code)) return 400;
  if (code === 'RATE_LIMIT' || code === 'TOO_MANY_REQUESTS') return 429;
  return 502;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly hint?: string;
    readonly retryable?: boolean;
    readonly details?: Record<string, unknown>;
  };
}

export function toErrorBody(error: unknown): { status: number; body: ErrorBody } {
  if (error instanceof ApiError) {
    const catalog = (ERROR_CATALOG as Record<string, { hint?: string; retryable?: boolean } | undefined>)[error.code];
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(catalog?.hint ? { hint: catalog.hint } : {}),
          ...(catalog?.retryable !== undefined ? { retryable: catalog.retryable } : {}),
          ...(error.details ? { details: error.details } : {}),
        },
      },
    };
  }

  // Fastify's own validation errors (routes declare JSON schemas).
  if (typeof error === 'object' && error !== null && 'validation' in error) {
    const validation = (error as { validation?: unknown }).validation;
    return {
      status: 400,
      body: { error: { code: 'VALIDATION', message: 'Request payload failed validation', details: { validation } } },
    };
  }

  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode: number }).statusCode) : 500;
  if (status === 401) {
    return { status, body: { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue' } } };
  }
  if (status === 429) {
    return { status, body: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } };
  }
  return {
    status: status >= 400 && status < 600 ? status : 500,
    body: { error: { code: 'INTERNAL', message: 'Something went wrong on our side' } },
  };
}
