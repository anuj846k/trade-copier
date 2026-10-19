import { NextRequest, NextResponse } from 'next/server';
import { callUpstream, extractCookie, tokensFromRequest } from '@/lib/bff';
import { ACCESS_COOKIE } from '@/lib/session';

/**
 * Issues a single-use WebSocket ticket.
 *
 * The ticket is what the browser puts in the query string, so the long-lived
 * access token never appears in a URL, a proxy log or browser history.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const { accessToken, refreshToken } = tokensFromRequest(request);
  const result = await callUpstream({ path: '/realtime/ticket', method: 'POST', accessToken, refreshToken });

  if (!result.response.ok) {
    const body = await result.response.text();
    const response = new NextResponse(body, { status: result.response.status, headers: { 'content-type': 'application/json' } });
    for (const cookie of result.cookies) response.headers.append('set-cookie', cookie);
    return response;
  }

  const payload = (await result.response.json()) as { ticket: string; expiresAt: string; wsUrl: string };
  const response = NextResponse.json({
    ...payload,
    // Hand the token back too, so the provider can refresh in the background.
    accessToken: result.accessToken ?? extractCookie(result.cookies, ACCESS_COOKIE) ?? null,
  });
  for (const cookie of result.cookies) response.headers.append('set-cookie', cookie);
  return response;
}
