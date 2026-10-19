/**
 * Cookie contract between this app and the API.
 *
 * The access and refresh tokens never touch JavaScript: the BFF route handlers
 * copy the API's `set-cookie` headers onto the web origin so the browser keeps
 * them httpOnly, and every server-side read attaches the access token as a
 * bearer header (see `lib/api.ts`).
 */
export const ACCESS_COOKIE = 'tc_access';
export const REFRESH_COOKIE = 'tc_refresh';
export const CSRF_COOKIE = 'tc_csrf';

/** Path the refresh cookie is scoped to on the API (mirrors the API's own scope). */
export const API_PREFIX = '/api/v1';

export interface CookieOptions {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge?: number;
}

export function sessionCookieOptions(maxAgeSeconds?: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    ...(maxAgeSeconds !== undefined ? { maxAge: maxAgeSeconds } : {}),
  };
}

/**
 * Rewrites a `Set-Cookie` string coming from the API so it binds to this host:
 * the `Domain` attribute would otherwise point at the API's domain.
 */
export function rewriteSetCookie(raw: string): string {
  const parts = raw.split(';');
  const kept = parts.filter((part) => !/^\s*domain=/i.test(part) && !/^\s*path=\/api\/v1\/auth\s*$/i.test(part));
  const normalized = kept.map((part) => (/^\s*path=/i.test(part) ? ' Path=/' : part));
  return normalized.join(';');
}

export function readSetCookies(headers: Headers): string[] {
  // `getSetCookie` is available in Node 20+/undici and in all supported browsers.
  const withRaw = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withRaw.getSetCookie === 'function') return withRaw.getSetCookie();
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

export function cookieValueFrom(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}
