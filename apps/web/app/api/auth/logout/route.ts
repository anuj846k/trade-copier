import { NextRequest } from 'next/server';
import { callUpstream, relay, tokensFromRequest } from '@/lib/bff';

/** Revokes the refresh token server-side, then clears both cookies locally. */
export async function POST(request: NextRequest): Promise<Response> {
  const { accessToken, refreshToken } = tokensFromRequest(request);
  const result = await callUpstream({ path: '/auth/logout', method: 'POST', accessToken, refreshToken });
  return relay(result, { clearCookies: true });
}
