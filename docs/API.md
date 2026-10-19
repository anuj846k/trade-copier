# HTTP API

Base URL: `http://localhost:4000` by default (`API_PORT`). Every route below is
under **`/api/v1`** except the bridge agent socket (`/bridge/agent`) and the
service root.

Request and response shapes are defined once, as Zod schemas in
`packages/contracts/src/dto.ts`, and used by the routes, the Next.js BFF and the
browser client. Where this document and a schema disagree, the schema is right.

## Authentication

Two transport options for the same JWT access token:

| Caller | How |
| --- | --- |
| Dashboard | `tc_access` cookie, `httpOnly`, set by the BFF proxy |
| Tooling (agent, curl, scripts) | `Authorization: Bearer <accessToken>` |

The refresh token lives in its own cookie (`tc_refresh`, path
`/api/v1/auth`, so it is only ever sent to the auth endpoints) and is rotated on
every use. Only its SHA-256 hash is stored. Presenting a token that has already
been rotated revokes the whole rotation family — the standard refresh-replay
defence: if two parties hold the same refresh token, one of them is an attacker,
so both sessions die.

Rejected requests get `401` with

```json
{ "error": { "code": "UNAUTHENTICATED", "message": "Sign in to continue" } }
```

### `POST /auth/register`

```json
{ "email": "you@example.com", "password": "Correct-Horse-9", "firstName": "Ada", "lastName": "Lovelace", "timezone": "Europe/London" }
```

Password policy: ≥ 12 characters with lower case, upper case and a digit
(checked in the schema *and* against a weak-password list server-side). Returns
`201` with `{ user, accessTokenExpiresIn }` and sets both cookies. `409
CONFLICT` if the email exists. Rate limited per IP.

### `POST /auth/login`

`{ "email", "password" }` → `200 { user, accessTokenExpiresIn }` and cookies.
A wrong password and an unknown email both return `401 UNAUTHENTICATED` with the
same message, so the endpoint cannot be used to enumerate accounts.

### `POST /auth/refresh`

Uses the `tc_refresh` cookie, returns a fresh pair. `401` when the token is
expired, revoked, or has already been rotated.

### `POST /auth/logout` · `POST /auth/logout-all`

Revoke the current family (or every family for the user) and clear the cookies.

### `GET /auth/me`

```json
{
  "user": { "id": "usr_…", "email": "…", "firstName": "…", "lastName": "…", "timezone": "…", "totpEnabled": false },
  "usage": { "accounts": 3, "copiers": 1 },
  "subscription": null
}
```

`PATCH /auth/me` updates `firstName`, `lastName`, `timezone`.
`POST /auth/password` changes the password (requires the current one) and
revokes every other session.

### Two-factor

`POST /auth/2fa/setup` → `{ secret, otpauthUrl }` (TOTP, RFC 6238, implemented
with `node:crypto` — no third-party dependency). Then `POST /auth/2fa/enable`
with `{ secret, token }` to switch it on, and `POST /auth/2fa/disable` with a
current code. Recovery codes are deliberately not implemented; disabling 2FA
requires a live code.

## Accounts

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/accounts` | list accessible accounts (own or shared) |
| `POST` | `/accounts` | create an account (`label`, `platform`, `login`, `server`, `password?`, `investorPassword?`, `kind`, `agentToken?`) |
| `GET` | `/accounts/:accountId` | detail |
| `PATCH` | `/accounts/:accountId` | label, enabled flag, etc. |
| `DELETE` | `/accounts/:accountId` | remove (cascades to copiers that reference it) |
| `POST` | `/accounts/:accountId/refresh` | ask the agent to re-send snapshot, positions and symbols |
| `PUT` | `/accounts/:accountId/credentials` | replace the encrypted password |
| `GET` | `/accounts/:accountId/symbols` | instrument catalogue (`search`, `assetClass`, `mapped`, `limit`, `offset`) |
| `PATCH` | `/accounts/:accountId/symbols/:name` | enable/disable one instrument |
| `POST` | `/accounts/:accountId/symbols/bulk` | enable/disable by asset class or search |
| `GET`/`PUT` | `/accounts/:accountId/equity-protection` | drawdown rules |
| `GET` | `/accounts/:accountId/trades` | closed trades (realised P/L source, from the broker) |
| `GET`/`POST`/`DELETE` | `/accounts/:accountId/shares[/:shareId]` | share an account with another user (`viewer`, `copier`, `manager`) |
| `POST` | `/accounts/symbols/resolve` | resolve a list of symbol names against a broker's catalogue |
| `GET` | `/accounts/symbols/master-catalog` | instruments the user's master accounts report |

Credentials are encrypted at rest with AES-256-GCM (`ENCRYPTION_KEY`) and never
returned — not even masked in the detail response.

### Equity protection

```json
{
  "enabled": true,
  "rules": [
    { "type": "max_drawdown_percent", "value": 10, "action": "disable_copier" },
    { "type": "max_daily_loss_percent", "value": 5, "action": "close_copied_trades" }
  ]
}
```

Evaluated on `EQUITY_PROTECTION_INTERVAL_MS`; actions are `notify`,
`disable_copier`, `close_copied_trades` and `close_all_trades`. A rule that
fires writes an `equity_protection_events` row, a log line and a notification.

## Copiers

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/copiers` | list |
| `POST` | `/copiers` | create — `{ name, masterAccountId, copyExistingTrades, followers: [{ accountId, settings }] }` |
| `GET` | `/copiers/:copierId` | detail with followers |
| `PATCH` | `/copiers/:copierId` | rename, `status` (`enabled`, `disabled_monitor_existing`, `disabled`, `paused`), `pausedUntil` |
| `DELETE` | `/copiers/:copierId` | delete (closes nothing; use reconcile first if you care) |
| `POST` | `/copiers/:copierId/followers` | add a follower (upserts if it exists) |
| `PATCH` | `/copiers/:copierId/followers/:followerId` | `settings`, `enabled` |
| `DELETE` | `/copiers/:copierId/followers/:followerId` | remove |
| `GET`/`PUT` | `…/mappings` | symbol mapping (master → slave), one row per pair |
| `POST` | `…/mappings/auto` | match names automatically, honouring suffixes (`EURUSD` → `EURUSD.raw`); `overwrite` to replace manual rows |
| `DELETE` | `…/mappings`, `…/mappings/:masterSymbol` | clear all / one |
| `GET`/`PUT`/`DELETE` | `…/overrides[/:masterSymbol]` | per-symbol overrides of the follower settings (lot multiplier, stops, …) |
| `GET` | `/copiers/:copierId/trades` | copy links — the per-follower view of a master trade, with the decision trace |
| `GET` | `/copiers/:copierId/status` | live status: master/follower online state, open links, queue depth |
| `POST` | `/copiers/:copierId/reconcile` | compare master and slave positions and log/patch the differences now |

`copyExistingTrades` is a one-shot: it mirrors whatever the master holds at
creation time and is then irrelevant.

Follower `settings` (validated in `packages/contracts/src/settings.ts`, keys in
`UPPERCASE`):

| Key | Notes |
| --- | --- |
| `riskType` | `LOT_MULTIPLIER`, `FIXED_LOT`, `BALANCE_MULTIPLIER`, `FIXED_BALANCE_MULTIPLIER`, `FIXED_PERCENT_RISK` |
| `lotMultiplier`, `fixedLot`, `balanceMultiplier`, `fixedMasterBalance`, `percentRisk` | the value for the chosen risk type (multipliers are percentages: `LOT_MULTIPLIER` 100 = 1:1) |
| `maxLots`, `minLots` | clamp, with a warning on the log row when it bites |
| `sides` | `buy`, `sell` or both |
| `copyPendingOrders`, `pendingOrderMode` | pending-order handling |
| `stopLossMode`, `fixedStopLossPips`, `takeProfitMode`, `fixedTakeProfitPips` | stop/target policy |
| `maxSpreadPips`, `maxSlippagePips` | gate and execution tolerance |
| `tradingHours` | per-weekday windows in the account's timezone |
| `commentMode`, `customComment` | `none`, `master`, `custom` |

## Insights

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/logs` | execution log (`copierId`, `followerId`, `accountId`, `level`, `code`, `from`, `to`, `limit`, cursor) |
| `GET` | `/logs/export` | CSV of the same filter |
| `GET` | `/analytics/dashboard` | headline numbers, equity curve, per-account summary |
| `GET` | `/analytics/accounts/:accountId` | one account: equity history, daily P/L, trades |
| `GET` | `/analytics/copiers/:copierId` | per-follower performance and skip reasons |
| `GET` | `/audit` | audit trail for the user |
| `GET` | `/notifications` | notification outbox history |
| `GET`/`POST`/`PATCH`/`DELETE` | `/notifications/channels[/:channelId]` | delivery channels (`webhook`, `email`, `telegram`) |
| `PUT` | `/notifications/settings` | which events to notify on |
| `POST` | `/notifications/test` | send a test message |
| `GET` | `/billing/plans` | public plan list |
| `GET` | `/billing/subscription` · `POST` `/billing/subscribe` | current plan, request a change |
| `GET` | `/diagnostics` | queue depth, dead commands, agent and realtime stats |

## Realtime

Two WebSocket channels with separate trust models
(`packages/contracts/src/realtime.ts` defines every frame):

* **`GET /bridge/agent`** — one socket per bridge agent, authenticated by an
  agent token in the hello frame. The agent pushes account state, position
  snapshots, symbol lists and closed trades, and receives commands.
* **`GET /api/v1/ws?ticket=…`** — the dashboard. The URL carries a **single-use
  ticket** obtained from `POST /api/v1/realtime/ticket` (60-second TTL), so the
  long-lived access token never appears in a URL — where it would end up in
  proxy logs and browser history.

Frames are `{ type, ... }` objects; every one is validated on receipt. A
protocol version mismatch (`PROTOCOL_VERSION`) closes the socket with
`AGENT_VERSION_MISMATCH` rather than misinterpreting a frame.

## Operations

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/health` | `{ status, version, uptimeSeconds, database, queue: { depth, oldestQueuedAgeMs }, agents, realtime, counters }`; `503` with `status: "degraded"` when the database is unreachable |
| `GET` | `/api/v1/health/ready` | readiness probe — `{ ready }`, `503` when not |
| `GET` | `/api/v1/version` | version and Node version |
| `GET` | `/` and `/api/v1/` | service index |

`queue.depth` and `queue.oldestQueuedAgeMs` are the two numbers worth alerting
on: a growing queue means the broker side is slow or unreachable.

## Errors

Every non-2xx response has the same envelope:

```json
{ "error": { "code": "SPREAD_TOO_WIDE", "message": "Spread 3.2 pips exceeds the 1.5 pip limit", "details": { "spreadPips": 3.2 } } }
```

Transport-level codes: `UNAUTHENTICATED` (401), `FORBIDDEN` (403), `NOT_FOUND`
(404), `CONFLICT` (409), `VALIDATION` (400, with per-field `details.validation`),
`RATE_LIMITED` (429), `INTERNAL` (500).

Everything else is a `CopierErrorCode` from `packages/contracts/src/errors.ts`,
the same vocabulary the engine uses in logs and notifications — so a code in a
log line, a code in a notification and a code in an HTTP response all mean the
same thing. `errors.ts` also carries metadata per code: whether the dispatcher
should retry it, a short user-facing message and an actionable hint. Notable
benign skips (not failures): `NOT_COPIED`, `PENDING_DEFERRED`,
`STRICT_CLOSE_IGNORED`, `RECONNECT_MISMATCH`.
