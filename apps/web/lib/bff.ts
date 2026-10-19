import { NextResponse } from 'next/server';
import { API_BASE_URL, API_PREFIX } from './env';
import { ACCESS_COOKIE, REFRESH_COOKIE, cookieValueFrom, readSetCookies, rewriteSetCookie } from './session';

/**
 * Backend-for-frontend plumbing.
 *
 * Two rules make the dashboard safe:
 *
 *   1. Tokens live in httpOnly cookies on the web origin and are re-attached
 *      server-side, so no token is ever exposed to client JavaScript.
 *   2. Only route handlers rotate tokens. When the API answers 401 they call
 *      `/auth/refresh` once and replay the original request; RSC reads never
 *      write cookies (Next.js forbids it), they just redirect to sign-in.
 */

export interface UpstreamCall {
  readonly path: string;
  readonly method: string;
  readonly body?: string | undefined;
  readonly contentType?: string | undefined;
  readonly accessToken?: string | null | undefined;
  readonly refreshToken?: string | null | undefined;
  /** Raw query string, already URL-encoded, without the leading `?`. */
  readonly search?: string | undefined;
}

export interface UpstreamResult {
  readonly response: Response;
  /** Rewritten `Set-Cookie` values the caller must relay to the browser. */
  readonly cookies: string[];
  readonly accessToken: string | null;
}

export async function callUpstream(call: UpstreamCall): Promise<UpstreamResult> {
  const url = `${API_BASE_URL}${API_PREFIX}${call.path}${call.search ? `?${call.search}` : ''}`;
  const first = await send(url, call, call.accessToken ?? null);

  if (first.response.status !== 401 || !call.refreshToken) {
    return { response: first.response, cookies: first.cookies, accessToken: call.accessToken ?? null };
  }

  const refreshed = await send(`${API_BASE_URL}${API_PREFIX}/auth/refresh`, { method: 'POST' }, null, {
    cookie: `${REFRESH_COOKIE}=${call.refreshToken}`,
  });
  if (!refreshed.response.ok) {
    return { response: first.response, cookies: refreshed.cookies, accessToken: null };
  }

  const token = extractCookie(refreshed.cookies, ACCESS_COOKIE);
  const replay = await send(url, call, token);
  return {
    response: replay.response,
    cookies: [...refreshed.cookies, ...replay.cookies],
    accessToken: token ?? call.accessToken ?? null,
  };
}

async function send(
  url: string,
  call: Pick<UpstreamCall, 'method' | 'body' | 'contentType'>,
  accessToken: string | null,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; cookies: string[] }> {
  const response = await fetch(url, {
    method: call.method,
    headers: {
      ...(call.body !== undefined ? { 'content-type': call.contentType ?? 'application/json' } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      accept: 'application/json, text/csv;q=0.9, */*;q=0.8',
      ...extraHeaders,
    },
    ...(call.body !== undefined ? { body: call.body } : {}),
    cache: 'no-store',
    redirect: 'manual',
  });
  return { response, cookies: readSetCookies(response.headers).map(rewriteSetCookie) };
}

export function extractCookie(setCookies: readonly string[], name: string): string | null {
  for (const cookie of setCookies) {
    const value = cookieValueFrom(cookie.split(';')[0] ?? '', name);
    if (value) return value;
  }
  return null;
}

/** Relays an upstream response to the browser, preserving status and cookies. */
export async function relay(result: UpstreamResult, options: { clearCookies?: boolean } = {}): Promise<NextResponse> {
  const text = await result.response.text();
  const contentType = result.response.headers.get('content-type') ?? 'application/json';
  const disposition = result.response.headers.get('content-disposition');
  const response = new NextResponse(text, {
    status: result.response.status,
    headers: {
      'content-type': contentType,
      // Kept so `/api/proxy/logs/export` still downloads as a named CSV file.
      ...(disposition ? { 'content-disposition': disposition } : {}),
    },
  });
  for (const cookie of result.cookies) response.headers.append('set-cookie', cookie);
  if (options.clearCookies) {
    const expired = 'Max-Age=0; Path=/; HttpOnly; SameSite=Lax';
    response.headers.append('set-cookie', `${ACCESS_COOKIE}=; ${expired}`);
    response.headers.append('set-cookie', `${REFRESH_COOKIE}=; ${expired}`);
  }
  return response;
}

/** Reads the two auth cookies from an incoming browser request. */
export function tokensFromRequest(request: Request): { accessToken: string | null; refreshToken: string | null } {
  const header = request.headers.get('cookie');
  return {
    accessToken: cookieValueFrom(header, ACCESS_COOKIE),
    refreshToken: cookieValueFrom(header, REFRESH_COOKIE),
  };
}

export function proxyPath(segments: readonly string[]): string {
  return `/${segments.join('/')}`;
}
