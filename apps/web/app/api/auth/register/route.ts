import { NextRequest } from 'next/server';
import { callUpstream, relay } from '@/lib/bff';

export async function POST(request: NextRequest): Promise<Response> {
  const body = await request.text();
  const result = await callUpstream({ path: '/auth/register', method: 'POST', body });
  return relay(result);
}
