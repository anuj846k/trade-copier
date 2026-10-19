# Security

What the system actually does today, in the order an attacker would meet it.
Where a control is a known limitation it says so rather than implying otherwise.

## Threat model, briefly

The assets are **broker credentials** and the **ability to place orders**. The
attacker is anyone on the internet with the API's URL; the user's own machine is
trusted (the bridge agent runs there by design). So the interesting boundaries
are:

```
internet ──▶ API ──(tokens, rate limits, validation)──▶ engine ──▶ agent ──▶ terminal
                │                                                      ▲
                └──(encrypted credentials at rest)──────────────────────┘
```

## Passwords

* Hashed with **scrypt** from `node:crypto` — no third-party crypto dependency
  in the auth path (`apps/api/src/lib/passwords.ts`). Parameters `N = 2^15,
  r = 8, p = 1`, 64-byte output, 16-byte random salt.
* The stored format is self-describing
  (`scrypt$32768$8$1$<salt>$<hash>`) so parameters can be raised without
  invalidating existing hashes.
* Verification is `timingSafeEqual` over fixed-length buffers, so a wrong
  password cannot be found byte by byte.
* Policy: ≥ 12 characters with upper case, lower case and a digit — enforced in
  the request schema *and* checked against a weak-password list server-side, so
  a caller cannot skip validation by posting directly.
* Input is NFKC-normalised before hashing, so a password typed with a
  compatibility character still matches later.

## Sessions

Two tokens, each with a different job:

| Token | Where | Lifetime | Storage |
| --- | --- | --- | --- |
| Access (JWT, HS256) | `tc_access` cookie **or** `Authorization: Bearer` | `ACCESS_TOKEN_TTL` (default 15 min) | not stored |
| Refresh | `tc_refresh` cookie, path `/api/v1/auth` | `REFRESH_TOKEN_TTL_DAYS` (default 30) | SHA-256 hash only |

* Refresh tokens **rotate on every use**. Presenting one that has already been
  rotated revokes the whole family — the standard refresh-replay defence: two
  holders of one refresh token means one of them is an attacker, so both
  sessions die.
* Cookies are `httpOnly` and `SameSite=Lax`, and `Secure` when
  `NODE_ENV=production`. The refresh cookie is scoped to the auth path so it is
  never attached to ordinary requests.
* The dashboard never handles a token in JavaScript: Next.js runs a BFF proxy
  and the browser only ever holds cookies.
* `POST /auth/password` requires the current password and revokes every other
  session.
* `JWT_SECRET` is validated to be ≥ 32 characters at boot.

## Two-factor authentication

TOTP (RFC 6238) implemented with `node:crypto` — HMAC-SHA1, 30-second step,
6 digits, ±1 step of drift. The secret is generated server-side and confirmed
with a live code before the flag flips. Disabling requires a live code; there
are **no recovery codes**, which is a deliberate trade: a recovery-code store is
another credential store to protect, and the alternative — an email reset — is a
weaker second factor than the one being removed.

## Credentials at rest

* Broker passwords: **AES-256-GCM**, key from `ENCRYPTION_KEY` (validated as
  exactly 32 bytes, base64). Ciphertext is self-describing
  (`v1.<iv>.<tag>.<payload>`), so a future format change is a version bump
  rather than a migration guess.
* A fresh nonce per encryption, so identical plaintexts produce different
  ciphertext.
* GCM authentication means tampering is *detected*, not silently decrypted into
  garbage. A wrong key returns `null` instead of throwing, so a misconfigured
  deployment fails closed and loudly rather than corrupting data.
* Credentials are **never returned** by the API — not in account detail, not
  masked, not as a fingerprint.
* Agent tokens are stored as hashes and shown exactly once, at creation.
* Bridge/notification secrets use the same cipher.

## Transport and browser surface

* CORS is a closed list (`CORS_ORIGINS`) with credentials enabled; it defaults
  to permissive **only in development**.
* The API sends its own security headers; the dashboard adds
  `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin` and `X-Frame-Options: DENY`
  (`apps/web/next.config.ts`).
* WebSocket authentication does not put a token in a URL. The dashboard asks
  for a **single-use ticket** (`POST /realtime/ticket`, 60 s TTL, consumed on
  first use) and opens `/ws?ticket=…`. A leaked URL is worthless after one use
  and after a minute.
* Every request body, query and realtime frame is parsed with a Zod schema
  before it reaches business logic; unknown fields are rejected rather than
  passed along.
* Access-token TTLs are short, so a stolen access token has a small window; the
  refresh cookie it would need is scoped and rotated.

## Abuse

* Fixed-window rate limiting in front of `register` (per IP) and `login` (per
  IP **and** email), 60 requests/minute per key
  (`apps/api/src/plugins/engine.ts`).
* Login returns the same `401 UNAUTHENTICATED` for an unknown email and a wrong
  password, with the same message and timing, so the endpoint cannot be used to
  enumerate accounts. Registration is the one endpoint that reveals whether an
  email exists (409 `CONFLICT`) — unavoidable if sign-up is to be usable.
* WebSocket payloads are capped at 8 MB; the bridge protocol sends whole
  position snapshots, which for a few hundred tickets is far below that.
* `close_all`, `close_copied_trades` and equity actions are scoped explicitly
  (ticket list or magic) rather than "close everything" by default, so a bug in
  a filter cannot liquidate an account's manual trades.

## Known limitations

These are real and stated rather than hidden:

* **The rate limiter and ticket store are in-process** (`Map`-backed). A
  multi-instance deployment must replace them with a shared store — Redis, or
  a signed ticket with a `jti` denylist. The interfaces are already narrow
  enough for that (`apps/api/src/lib/ratelimit.ts`, `tickets.ts`).
* **No email verification and no password reset flow.** A reset flow needs an
  outbound mail provider and a single-use token store; neither is built. This
  is the largest gap between "runs" and "operable by strangers".
* **No audit-log tamper-evidence.** `audit_logs` is append-only by convention
  and contains no secrets, but a database administrator can rewrite it.
* **`TRUST_PROXY` matters.** Behind a reverse proxy without it, `request.ip` is
  the proxy's address and per-IP rate limits collapse into one bucket.
* **The bridge EA endpoint is loopback-only and unauthenticated beyond a shared
  secret.** That is a deliberate boundary: it can place trades, so it must not
  be reachable from the network. Do not bind it to `0.0.0.0`.
* **Nothing has been pen-tested**, and no live broker has been driven with it.
  See `docs/MANUAL-STEPS.md` § 8.

## Verified by tests

`apps/api/test/security.test.ts` (18 tests) covers the pieces an attacker would
try to break: AES-GCM round-trip and tamper detection, key-length validation,
constant-time comparison, rate-limit windows and pruning, and single-use ticket
issuance/expiry. `apps/api/test/auth-flow.test.ts` (8 tests, real PostgreSQL)
covers registration, duplicate email, wrong password vs unknown email, refresh
rotation and replay revocation.
