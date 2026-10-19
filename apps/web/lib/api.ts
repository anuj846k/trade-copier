import { cookies } from 'next/headers';
import { ACCESS_COOKIE } from './session';
import { API_BASE_URL, API_PREFIX } from './env';
import type { Session } from './types';

export type { Session };

/**
 * Server-side API client (React Server Components and route handlers).
 *
 * This module is server-only by construction: it imports `next/headers`.
 * Client components must use `lib/client.ts` (the BFF) instead.
 *
 * Every read in the dashboard goes through here: the httpOnly access cookie is
 * reopened on the server and attached as a bearer token, so the browser never
 * needs to hold a token in memory. A 401 means the access token expired — for
 * server components that is a redirect to the sign-in page, because only the
 * BFF route handlers are allowed to rotate the refresh cookie.
 */
export { API_BASE_URL };

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    hint?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Attaches the bearer token from the cookie jar (server-side only). */
export async function authHeaders(): Promise<Record<string, string>> {
  const jar = await cookies();
  const token = jar.get(ACCESS_COOKIE)?.value;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export interface ServerFetchOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Return `null` instead of throwing when the API answers 401. */
  allowUnauthorized?: boolean;
}

export async function apiFetch<T>(path: string, options: ServerFetchOptions = {}): Promise<T> {
  const { body, allowUnauthorized, ...init } = options;
  const response = await fetch(`${API_BASE_URL}${path.startsWith('/api/') ? '' : API_PREFIX}${path}`, {
    ...init,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(await authHeaders()),
      ...(init.headers ?? {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    cache: 'no-store',
  });

  const parsed = await readBody(response);
  if (!response.ok) {
    const envelope = parsed as ApiErrorBody | null;
    const status = response.status;
    const code = envelope?.error?.code ?? 'HTTP_ERROR';
    const message = envelope?.error?.message ?? `Request failed with status ${status}`;
    const error = new ApiError(status, code, message, envelope?.error?.hint, envelope?.error?.details);
    if (status === 401 && allowUnauthorized) return null as T;
    throw error;
  }
  return parsed as T;
}

/** Current session, or `null` when the visitor is not signed in. */
export async function getSession(): Promise<Session | null> {
  try {
    return await apiFetch<Session>('/auth/me', { allowUnauthorized: true });
  } catch {
    return null;
  }
}
