import { NextRequest } from 'next/server';
import { callUpstream, proxyPath, relay, tokensFromRequest } from '@/lib/bff';

/**
 * Authenticated pass-through to the API.
 *
 * Client components never hold a token: they call `/api/proxy/<path>`, this
 * handler attaches the bearer header from the httpOnly cookie, transparently
 * rotates it on 401 and streams the answer — JSON or CSV — back unchanged.
 */
async function handle(request: NextRequest, context: { params: Promise<{ path: string[] }> }): Promise<Response> {
  const { path } = await context.params;
  const { accessToken, refreshToken } = tokensFromRequest(request);
  const search = request.nextUrl.searchParams.toString();
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';

  const result = await callUpstream({
    path: proxyPath(path),
    method: request.method,
    body: hasBody ? await request.text() : undefined,
    contentType: request.headers.get('content-type') ?? 'application/json',
    accessToken,
    refreshToken,
    search,
  });
  return relay(result);
}

export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
