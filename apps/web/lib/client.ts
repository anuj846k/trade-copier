'use client';

/**
 * Browser-side API access.
 *
 * Client components never see a token: they call the BFF (`/api/proxy/...`),
 * which attaches the bearer header server-side and rotates the refresh cookie
 * when needed. This module only standardises request shape and error decoding.
 */
export interface ApiClientError {
  status: number;
  code: string;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

export class ClientApiError extends Error implements ApiClientError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ClientApiError';
  }
}

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export async function api<T>(path: string, options: { method?: Method; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const { method = 'GET', body, signal } = options;
  const response = await fetch(`/api/proxy${path.startsWith('/') ? path : `/${path}`}`, {
    method,
    credentials: 'include',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  });

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const envelope = parsed as { error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> } } | null;
    throw new ClientApiError(
      response.status,
      envelope?.error?.code ?? 'HTTP_ERROR',
      envelope?.error?.message ?? `Request failed with status ${response.status}`,
      envelope?.error?.hint,
      envelope?.error?.details,
    );
  }
  return parsed as T;
}

/** Human-readable form of whatever the API threw. */
export function errorMessage(error: unknown): { message: string; hint?: string } {
  if (error instanceof ClientApiError) return { message: error.message, ...(error.hint ? { hint: error.hint } : {}) };
  if (error instanceof Error) return { message: error.message };
  return { message: String(error) };
}
