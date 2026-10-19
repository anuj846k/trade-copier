# The bridge: agents, EAs and terminals

MetaTrader 4 and MT5 have **no supported server-side trading API**. Anything
that claims otherwise is either a compiled DLL injected into the terminal, a
screenshot-and-click robot, or an Expert Advisor that the user installs. This
project uses the last option, because it is the only one that needs no native
code, works the same on MT4 and MT5, and can be audited by the person whose
money is on the line.

```
  ┌──────────────────────┐   local HTTP    ┌───────────────────┐   WebSocket   ┌──────────┐
  │ MetaTrader terminal  │◀───────────────▶│  bridge agent     │◀─────────────▶│  API /   │
  │  + copier EA (.ex5)  │  POST /ea/poll  │  (Node process)   │ /bridge/agent │  engine  │
  └──────────────────────┘                 └───────────────────┘               └──────────┘
```

The agent is a small Node process that runs **on the same machine as the
terminal** (a Windows VPS, in practice). It owns a local HTTP endpoint the EA
polls, and a WebSocket to the API.

## Why polling

The EA cannot accept inbound connections on a normal terminal, and MQL has no
event loop that can wait on a socket. So the EA polls: **one HTTP round trip per
interval that both pushes state and pulls work**.

```
EA ──▶ POST /ea/poll  { token, account, snapshot, symbols, positions, results[], events[] }
EA ◀── 200            { serverTime, pollIntervalMs, commands: [{ requestId, kind, params }] }
```

Properties worth being explicit about:

* **One ordering point.** State and commands travel on the same connection, so
  a command result can never overtake the state it belongs to.
* **Latency is the poll interval.** `pollIntervalMs` defaults to 250 ms, so
  worst-case copy latency is *poll interval + broker execution*. The vendor
  figure of 20–30 ms is not achievable this way and is not claimed anywhere in
  this repository. If you need to shrink it, the honest levers are the poll
  interval and running the agent on a low-latency VPS next to the broker.
* **At-most-once normally, at-least-once on a lost poll.** A command is handed
  out once and re-sent only if it has not been sent for 5 s (`resendAfterMs`),
  so a slow EA is not double-executed by the next poll. Every command carries a
  deterministic `requestId`, and the engine's own links are keyed by it, so a
  duplicate is a no-op rather than a second position.
* **Back-pressure.** `maxCommandsPerPoll` caps a response; anything left waits
  in the agent's pending map.

### The EA contract

Requests are `POST /ea/...` (only the `/ea` prefix is served, everything else is
404). The token is the shared secret from the agent config (`eaToken`); a
mismatch is `401`.

Request body:

```json
{
  "token": "shared-secret",
  "account": "5012345",
  "version": "1.04",
  "platform": "mt5",
  "snapshot": { "balance": 100000, "equity": 100240, "margin": 1200, "freeMargin": 99040, "marginLevel": 8353.3, "currency": "USD", "leverage": 100, "at": "2026-10-19T09:00:00.000Z" },
  "symbols": [ { "name": "EURUSD.raw", "digits": 5, "pipSize": 0.0001, "contractSize": 100000, "minVolume": 0.01, "maxVolume": 50, "volumeStep": 0.01, "assetClass": "forex", "currency": "USD", "bid": 1.10004, "ask": 1.10016, "spreadPips": 1.2, "at": "2026-10-19T09:00:00.000Z" } ],
  "positions": [ { "ticket": "123456789", "symbol": "EURUSD.raw", "side": "buy", "volume": 0.5, "openPrice": 1.0987, "currentPrice": 1.10004, "stopLoss": 1.095, "takeProfit": null, "magic": 770001, "comment": "copy", "kind": "market", "openedAt": "2026-10-19T08:50:11.000Z" } ],
  "results": [ { "requestId": "req_…", "ok": true, "data": { "ticket": "123456790", "filledVolume": 0.5, "filledPrice": 1.10016 } } ],
  "events": [ { "kind": "trade_closed", "ticket": "123456700", "symbol": "EURUSD.raw", "side": "buy", "volume": 0.5, "price": 1.1012, "profit": 34.5, "at": "2026-10-19T09:05:00.000Z" } ]
}
```

Every field is optional except the ones the EA has: a poll with only `positions`
is fine, and so is one with only `results`. State is validated on arrival with
the same Zod schemas the rest of the system uses
(`packages/contracts/src/trade.ts`); an unparseable position is dropped rather
than trusted.

Response:

```json
{
  "serverTime": "2026-10-19T09:00:00.250Z",
  "pollIntervalMs": 250,
  "commands": [
    {
      "requestId": "cmd_…",
      "kind": "open",
      "params": { "symbol": "EURUSD.raw", "side": "buy", "volume": 0.5, "stopLoss": 1.095, "takeProfit": null, "maxSlippagePips": 1.5, "magic": 770001, "comment": "copy" }
    }
  ]
}
```

`kind` is one of `open`, `place_pending`, `modify`, `close`, `close_partial`,
`cancel_pending`, `close_all`. `params` mirrors `commandParamsSchema` in
`packages/contracts/src/realtime.ts` — the EA should ignore fields it does not
understand rather than failing the command.

Results are reported on the *next* poll, matched by `requestId`:

```json
{ "requestId": "cmd_…", "ok": true, "data": { "ticket": "123456790", "filledVolume": 0.5, "filledPrice": 1.10016 } }
```

or, on failure, `{ "ok": false, "error": { "code": "OFF_QUOTES", "message": "…", "brokerCode": 136 } }`.

`data` depends on the kind, and the agent reads these names literally:

| Kind | `data` |
| --- | --- |
| `open`, `place_pending` | `{ "ticket": "123456790", "filledVolume": 0.5, "filledPrice": 1.10016 }` |
| `close`, `close_partial` | `{ "closedVolume": 0.5, "closePrice": 1.09996, "fullyClosed": true, "profit": 0, "at": "…" }` |
| `close_all` | `{ "closed": 3, "failed": 0 }` |
| `modify`, `cancel_pending` | `{}` — success is the `ok` flag |

`profit` on a close is left at 0 on purpose: the terminal does not know the
realised result until the deal reaches history, and that is what `trade_closed`
events are for. `fullyClosed: false` tells the engine the position is still
open with the rest of its volume, which is how partial closes stay consistent.

The `code` should be one of `CopierErrorCode` (`packages/contracts/src/errors.ts`).
MT5's `TRADE_RETCODE_*` values (and MT4's error codes) are mapped by the agent
onto that taxonomy; unknown ones become `BROKER_REJECTED` with the raw retcode
kept in the error details.

A skeleton EA with the MQL5 `OnTimer` loop, order-send wrappers and result
reporting is in [`integrations/mt5/`](../integrations/mt5/README.md).

## The agent

```bash
# from a checkout
BRIDGE_SERVER_URL=ws://localhost:4000/bridge/agent \
BRIDGE_TOKEN=<token from the dashboard> \
BRIDGE_ACCOUNT_ID=acc_… \
BRIDGE_EA_TOKEN=<shared secret> \
pnpm --filter @trade-copier/bridge-agent dev
```

Configuration comes from, in order of precedence: `BRIDGE_*` environment
variables, `--config agent.config.json`, built-in defaults. A config file is
usually clearer once there is more than one terminal:

```json
{
  "serverUrl": "wss://api.example.com/bridge/agent",
  "token": "paste-the-agent-token",
  "name": "vps-frankfurt-1",
  "healthPort": 9000,
  "accounts": [
    { "accountId": "acc_master", "label": "MT5 master", "platform": "mt5", "eaHost": "127.0.0.1", "eaPort": 8787, "eaToken": "…", "maxCommandsPerPoll": 20 },
    { "accountId": "acc_slave",  "label": "MT4 slave",  "platform": "mt4", "eaHost": "127.0.0.1", "eaPort": 8788, "eaToken": "…" }
  ]
}
```

One agent serves any number of terminals on the same machine — each MT terminal
runs its own EA on its own local port.

| Setting | Default | Notes |
| --- | --- | --- |
| `serverUrl` | — | `wss://…/bridge/agent`; `ws://` for local dev |
| `token` | — | agent token, shown once when created in the dashboard; the server stores only its hash |
| `name` / `host` | hostname | identifies the agent in the UI |
| `reconnectMinMs` / `reconnectMaxMs` | 1000 / 30000 | exponential reconnect backoff |
| `heartbeatIntervalMs` | 10000 | the server declares its own on `server.welcome` and wins |
| `maxQueueDepth` | 5000 | outbound buffer while disconnected; oldest events are dropped first |
| `healthPort` | off | serves `GET /health` and `/status` on `127.0.0.1`; `503` when the cloud socket is down, so a VPS watchdog can restart the agent |
| `accounts[].eaPort` | 8787 | local EA listener |
| `accounts[].eaToken` | — | shared secret; the EA must send it |
| `accounts[].commandTimeoutMs` | 15000 | per command |
| `accounts[].maxCommandsPerPoll` | 20 | back-pressure |

While the socket is down the agent keeps running: it buffers outbound state up
to `maxQueueDepth`, keeps polling the EA, and reconnects with backoff. Commands
are not invented locally — the server's outbox holds them, and a command whose
`timeoutMs` has passed is re-queued or dead-lettered by the engine.

## The cloud protocol

Full definitions: `packages/contracts/src/realtime.ts` (frames) and
`apps/api/src/engine/agents.ts` (`AgentHub`, the server side).

**Agent → server**

| Frame | Purpose |
| --- | --- |
| `agent.hello` | `protocolVersion`, `agentToken`, `name`, `version`, `host`, `accounts[]` with per-account capabilities |
| `agent.heartbeat` | liveness, local queue depth, measured latency |
| `account.state` | balance, equity, margin, free margin, margin level |
| `agent.symbols` | full replacement symbol set for an account |
| `agent.positions.snapshot` | **the whole position set**, optionally answering a `server.request.snapshot` |
| `agent.quote` | batched bid/ask (up to 200) for the accounts in use |
| `closed_trade` | realised P/L — the only source of truth for it |
| `command.result` | outcome of a command, matched by `requestId` |
| `position.*` / `order.*` events | informational; the snapshot is still authoritative |
| `agent.pong`, `agent.log` | heartbeat reply, diagnostics |

**Server → agent**

| Frame | Purpose |
| --- | --- |
| `server.welcome` | `agentId`, protocol version, heartbeat interval, the authoritative account list |
| `server.request.snapshot` | ask for `account`, `symbols` and/or `positions` |
| `server.command` | one command: `requestId`, `accountId`, `kind`, `params`, `timeoutMs`, `trace` |
| `server.ping` | liveness; the agent answers `agent.pong` |

A version mismatch closes the socket with `AGENT_VERSION_MISMATCH` instead of
guessing at an unfamiliar frame. Unknown *optional* fields are ignored, so a
newer server can talk to an older agent as long as the frame types match.

### Positions are diffs, not events

The agent sends the position set; the server calls `diffPosition` against the
last set it saw. `packages/domain` uses the same routine on both sides, so
"master opened", "master partially closed" and "master closed" cannot disagree
between the agent and the engine. Events are a convenience for the UI and for
`closed_trade` P/L — never the trigger for copying.

## Trust and secrets

* **Agent tokens** are created in the dashboard, shown once, and stored as a
  hash. They are per-agent, not per-account.
* **EA tokens** are a shared secret between the agent and the EA on the same
  machine. They never reach the cloud.
* The EA endpoint binds to `127.0.0.1` by default. Do not expose it: it can
  place trades.
* Broker credentials (when the user supplies them for an account) are encrypted
  with AES-256-GCM and never returned by the API.

## Reconciliation

Every reconnect schedules a `reconcile` job (~5 s later, once the agent has
pushed fresh state). Reconciliation compares open links against the slave's
actual positions and logs `RECONNECT_MISMATCH` for each difference. Reopening a
position the slave side lost (`reopenMissing`) is **off by default**: a broker
whose view is merely delayed would otherwise get a second position, which is
worse than a missing one. The dashboard's "Reconcile now" button runs the same
code on demand, and `POST /copiers/:id/reconcile` exposes it over HTTP.

## Limitations worth stating

* `close_all` is scoped three ways: an explicit `tickets` list (what Equity
  Protection's "close copied trades" uses — the engine resolves the slave
  tickets from its own links), a `filterMagic`, or neither, which flattens the
  account. An earlier revision expected the *agent* to resolve request ids into
  tickets, which it cannot: that mapping lives in the engine's outbox, so the
  scoping silently degraded to "close everything". The ticket list now travels
  as a ticket list.
* A partial close reports `fullyClosed: false` and the engine keeps the link
  open with the reduced volume; realised P/L for the closed part arrives later
  as a `trade_closed` event, exactly as a full close does.
* `pending` order support depends on what the EA implements; `expiry` is marked
  as a capability flag because not every build supports it.
* With MT4 there is no reliable per-position comment round-trip in some builds;
  the copier therefore relies on `magic` and the ticket map, not comments.
