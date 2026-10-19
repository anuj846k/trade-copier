import { NextRequest } from 'next/server';
import { callUpstream, relay, tokensFromRequest } from '@/lib/bff';

export async function POST(request: NextRequest): Promise<Response> {
  const { accessToken, refreshToken } = tokensFromRequest(request);
  const result = await callUpstream({ path: '/auth/refresh', method: 'POST', accessToken, refreshToken });
  return relay(result);
}
