import { NextRequest } from 'next/server';
import { callUpstream, relay } from '@/lib/bff';

/** Sign-in: the API sets the token cookies, which we re-bind to this origin. */
export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.text();
  const result = await callUpstream({ path: '/auth/login', method: 'POST', body });
  return relay(result);
}
