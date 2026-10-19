import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/server.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../src/plugins/auth.js';
import { hasTestDatabase, resetTestDatabase, type TestDatabase } from './helpers/database.js';
import { randomEmail, testEnv } from './helpers/env.js';

/**
 * The HTTP surface, exercised through `app.inject` against a real database.
 *
 * The routes are only useful if the pieces agree: the cookie names, the JWT
 * secret, the password hashing, the refresh-token rotation and the row that
 * gets written. Unit tests cover each primitive; this file covers the seam
 * between them, which is where a renamed cookie or a switched response shape
 * would otherwise slip through until the browser hit it.
 *
 * Skipped when `TEST_DATABASE_URL` is unset (see helpers/database.ts).
 */

const describeWithDatabase = hasTestDatabase() ? describe : describe.skip;

const PASSWORD = 'Copier-Test-42';

describeWithDatabase('auth HTTP flow (integration)', () => {
  let app: FastifyInstance;
  let db: TestDatabase;

  beforeAll(async () => {
    db = await resetTestDatabase();
    app = await buildServer({
      env: testEnv({ databaseUrl: process.env['TEST_DATABASE_URL'] }),
      // No background loops in the test process: the assertions decide when
      // something runs.
      runWorker: false,
    });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.handle.close();
  });

  const cookiesOf = (response: { cookies: Array<{ name: string; value: string }> }) =>
    Object.fromEntries(response.cookies.map((cookie) => [cookie.name, cookie.value]));

  async function register(email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: PASSWORD, firstName: 'Ada', lastName: 'Lovelace', timezone: 'Europe/London' },
    });
  }

  it('registers a user, sets both cookies, and never returns the hash', async () => {
    const email = randomEmail('register');
    const response = await register(email);
    expect(response.statusCode).toBe(201);

    const body = response.json();
    expect(body.user.email).toBe(email);
    expect(body.user.totpEnabled).toBe(false);
    expect(body.accessTokenExpiresIn).toBeGreaterThan(0);
    // The password hash must not leak into any response shape.
    expect(JSON.stringify(body)).not.toContain('scrypt');

    const cookies = cookiesOf(response);
    expect(cookies[ACCESS_COOKIE]).toBeTruthy();
    expect(cookies[REFRESH_COOKIE]).toBeTruthy();

    // The refresh token in the cookie is never the raw value stored in the
    // database — only its hash is, so a database leak does not grant sessions.
    const stored = await db.handle.pool.query<{ token_hash: string }>('select token_hash from refresh_tokens');
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_hash).not.toBe(cookies[REFRESH_COOKIE]);
  });

  it('rejects a duplicate email and a weak password', async () => {
    const email = randomEmail('dupe');
    expect((await register(email)).statusCode).toBe(201);

    const duplicate = await register(email);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('CONFLICT');

    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email: randomEmail('weak'), password: 'short', firstName: 'A', lastName: 'B', timezone: 'UTC' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe('VALIDATION');
  });

  it('protects /auth/me with the cookie and answers with the session summary', async () => {
    const email = randomEmail('me');
    const registered = await register(email);
    const cookies = cookiesOf(registered);

    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/auth/me' });
    expect(anonymous.statusCode).toBe(401);

    const authorised = await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies });
    expect(authorised.statusCode).toBe(200);
    const body = authorised.json();
    expect(body.user.email).toBe(email);
    expect(body.usage).toEqual({ accounts: 0, copiers: 0 });
    expect(body.subscription).toBeNull();
  });

  it('also accepts a bearer token, which is what the bridge tooling uses', async () => {
    const email = randomEmail('bearer');
    const registered = await register(email);
    const accessToken = cookiesOf(registered)[ACCESS_COOKIE];

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().user.email).toBe(email);
  });

  it('signs in with the right password and refuses the wrong one', async () => {
    const email = randomEmail('login');
    await register(email);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'Wrong-Password-1' },
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('UNAUTHENTICATED');

    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: randomEmail('ghost'), password: PASSWORD },
    });
    // Same code and status as a wrong password: no account enumeration.
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json().error.code).toBe('UNAUTHENTICATED');

    const right = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().user.email).toBe(email);
    expect(cookiesOf(right)[REFRESH_COOKIE]).toBeTruthy();
  });

  it('rotates the refresh token and treats a replayed one as theft', async () => {
    const email = randomEmail('refresh');
    const original = cookiesOf(await register(email));

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: original[REFRESH_COOKIE]! },
    });
    expect(refreshed.statusCode).toBe(200);
    const rotated = cookiesOf(refreshed);
    expect(rotated[REFRESH_COOKIE]).toBeTruthy();
    expect(rotated[REFRESH_COOKIE]).not.toBe(original[REFRESH_COOKIE]);

    // Replaying the consumed token means one of the two holders is an attacker,
    // so the whole family is revoked — including the freshly minted token.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: original[REFRESH_COOKIE]! },
    });
    expect(replay.statusCode).toBe(401);

    const afterRevocation = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: rotated[REFRESH_COOKIE]! },
    });
    expect(afterRevocation.statusCode).toBe(401);
  });

  it('logs out by revoking the refresh family and clearing the cookies', async () => {
    const email = randomEmail('logout');
    const cookies = cookiesOf(await register(email));

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [REFRESH_COOKIE]: cookies[REFRESH_COOKIE]! },
    });
    expect(response.statusCode).toBe(200);
    const cleared = response.cookies.map((cookie) => cookie.name);
    expect(cleared).toContain(ACCESS_COOKIE);
    expect(cleared).toContain(REFRESH_COOKIE);

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: cookies[REFRESH_COOKIE]! },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('exposes the API index without a session', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1' });
    expect(response.statusCode).toBe(200);
    expect(response.json().name).toBe('Trade Copier API');
  });
});
