/**
 * Environment surface of the dashboard.
 *
 * `API_BASE_URL` is used by the server half (RSC + route handlers);
 * `NEXT_PUBLIC_API_URL` is what the browser needs to open the realtime
 * WebSocket, which cannot be proxied through the Next.js server.
 */
export const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const PUBLIC_API_URL = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const API_PREFIX = '/api/v1';
