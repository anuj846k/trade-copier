# Architecture

## Shape

```
                    ┌──────────────────────────────────────────────┐
   browser ────────▶│  apps/web  (Next.js, BFF proxy)              │
                    │  httpOnly cookies, no token in JS            │
                    └───────────────┬──────────────────────────────┘
                                    │ /api/*  (rewritten to the API)
                    ┌───────────────▼──────────────────────────────┐
   bridge agent ───▶│  apps/api  (Fastify)                         │
   /bridge/agent    │   ├── HTTP routes                            │
   (WebSocket)      │   ├── copy engine  (in-process by default)    │
                    │   └── /ws dashboard channel                  │
                    └───────┬───────────────────────┬──────────────┘
                            │                       │
                    ┌───────▼───────┐       ┌───────▼───────┐
                    │ PostgreSQL    │       │ BrokerConnector│
                    │ (the only     │       │  Mock / Bridge │
                    │  shared state)│       │  / Remote      │
                    └───────────────┘       └───────────────┘
```

Two decisions drive everything else.

**The database is the only shared state.** There is no Redis, no in-memory
queue, no leader election. A command becomes durable the moment it is inserted
into `copy_commands`, and any number of API/worker processes can safely race for
it because claiming is a single atomic statement. That keeps a single-node
deployment to one process and makes horizontal scaling a configuration change
rather than a rewrite.

**Broker access is one interface.** `BrokerConnector`
(`packages/broker/src/types.ts`) is the only way the engine touches a terminal:
`connect`, `getAccount`, `getPositions`, `getSymbols`, `placeMarketOrder`,
`placePendingOrder`, `modifyPosition`, `closePosition`, `closeAll`, plus optional
`subscribe`. A mock, a bridge agent and a remote RPC connector are
interchangeable, which is what makes the copy path testable without a broker.

## Layers and the dependency rule

Dependencies flow inwards. Nothing in `contracts` or `domain` imports the
database, the network or a logger.

| Package | Depends on | Contains |
| --- | --- | --- |
| `packages/contracts` | zod | HTTP DTOs, realtime frames, platform enums, error codes |
| `packages/domain` | contracts | sizing, pips, lots, symbol matching, filters, market hours, the copy planner, equity rules, `Result` |
| `packages/db` | contracts, domain | Drizzle schema, SQL migrations, repositories |
| `packages/broker` | contracts, domain | the connector interface and its three implementations |
| `apps/api` | all of the above | routes, engine, worker, WebSocket hubs |
| `apps/bridge-agent` | broker, contracts, domain | terminal-side agent (cloud socket + local EA endpoint) |
| `apps/web` | contracts | dashboard (Next.js App Router) |

`packages` are consumed as **TypeScript source** (`exports` → `src/index.ts`),
not as build output: there is no "did you rebuild the package?" failure mode
during development. `apps/api` and `apps/bridge-agent` are bundled with tsup for
deployment; `apps/web` transpiles the packages with `transpilePackages`.

### `Result`, not exceptions, at the edges

Broker calls, database conflicts and rule refusals return
`Result<T, E>` (`packages/domain/src/result.ts`) — a discriminated union with
`ok`. The reason is that the copy path is a *decision pipeline*: almost every
step can legitimately decline (spread too wide, market closed, volume below the
broker minimum, symbol not found), and those declines are data, not errors. The
engine records them with a code and carries on. Exceptions are reserved for
programming faults and infrastructure failures, which the HTTP layer converts to
`INTERNAL` and the dispatcher retries.

## The copy path, end to end

```
agent / mock ──positions──▶ AgentHub ──▶ CopyPipeline.onPositions
                                              │
                                    diffPosition(previous, current)
                                              │  opens / closes / partials
                                              ▼
                                    planOpen / planClose (packages/domain)
                                              │  pure function, returns a decision
                                              │  + a rule-by-rule trace
                                              ▼
                              trade_links (state)   copy_commands (outbox)
                                              │
                                    CommandDispatcher.tick()
                                              │  claim → execute → apply state
                                              ▼
                                   BrokerConnector  ──▶  terminal
```

1. **Ingest.** A bridge agent pushes the *whole position set* for an account,
   never individual events (`agent.positions.snapshot`). The engine calls
   `diffPosition` against the last known set, so "the master opened a trade",
   "the master partially closed" and "the master closed" are all derived the
   same way on both sides of the wire. A mock connector is mirrored into the
   same hub cache (`ConnectorRegistry.createMock`), so tests and `pnpm sim` run
   the identical code path, quote-age and spread checks included.

2. **Decide.** For each detected change the pipeline loads the copier, the
   follower's settings, the symbol mapping and the live quote, then calls the
   pure planner. `planOpen` returns either a command (`open`, `place_pending`)
   or a skip with a code such as `FILTERED_SIDE`, `SPREAD_TOO_WIDE`,
   `STALE_QUOTE`, `MARKET_CLOSED`, `NO_SYMBOL_MAPPING`, `VOLUME_BELOW_MIN`.
   Alongside the decision it returns a **trace**: one entry per rule with
   `pass`/`adjust`/`skip` and a human-readable detail. That trace is stored on
   the log row, which is why the dashboard can explain a copy rather than only
   report it.

   The planner is deliberately pure — it receives clocks, symbol specs and
   quotes as arguments. 45 of the domain tests call it with hand-built
   snapshots; no database is involved.

3. **Record.** The decision becomes a `master_trades` row and one `trade_links`
   row per follower, plus a `copy_commands` row per broker action. This is the
   commit point: once the transaction returns, the intent survives a crash.
   Re-delivering the same snapshot is a no-op because the link lookup is keyed
   by `(master trade, follower)` and volume changes are computed as deltas.

4. **Execute.** The dispatcher claims due commands and calls the connector. On
   success it writes the fill back to the link (`filledVolume`, `filledPrice`,
   `slaveTicket`) — which is what every later decision reads, so the engine's
   model of the slave is always "what the broker accepted", never "what we
   asked for". On failure it decides retry versus dead-letter.

5. **Report.** Every step writes an `execution_logs` row and publishes to the
   dashboard hub. Realised P/L arrives later, as a `closed_trade` from the
   broker: the trade is matched back to its link by `(account, ticket)` and the
   link's `realizedProfit` becomes gross P/L minus swap and commission, while
   the trade row keeps the three components apart.

## The outbox

`copy_commands` is a durable queue with a claim-based lease:

```
queued ──claim──▶ dispatched ──ack──▶ acked
   ▲                  │
   │                  ├── transient failure ──▶ queued (backoff, until the window closes)
   │                  ├── permanent failure ──▶ dead
   │                  └── lease expires ──────▶ queued
   └──── requeue on account offline / agent disconnect
```

Claiming is one statement:

```sql
UPDATE copy_commands SET status = 'dispatched', worker_id = $1, ...
WHERE id IN (
  SELECT id FROM copy_commands
  WHERE status = 'queued' AND available_at <= now()
  ORDER BY available_at
  FOR UPDATE SKIP LOCKED
  LIMIT $2
) RETURNING *;
```

`SKIP LOCKED` is what lets several workers share the table without a lock
manager; `RETURNING` is what makes the lease atomic. Two consequences shaped the
code:

* **Claiming is raw SQL**, which means drizzle's column mapping does not apply.
  Results come back with Postgres column names (`account_id`) and `timestamptz`
  as *text* (`2026-10-19 05:41:48.243+00`, which `new Date()` would read as
  local time). Every claim path therefore has an explicit snake_case mapper
  (`toClaimedCommand`, `toClaimedJob`, `toClaimedNotification`) and
  `values.ts` provides `toTimestamp`/`toTimestampOrNull`. Skipping this cost a
  day of debugging: `accountId` read as `undefined` and the dispatcher threw
  `Cannot read properties of undefined (reading 'getTime')` on the retry path.
* **Commands are serialised per account** and parallel across accounts
  (`WORKER_ACCOUNT_CONCURRENCY`). Position order matters within one account;
  between accounts it does not.

Retries are bounded by time, not by count: `COPY_RETRY_WINDOW_MS` (15 minutes
by default, matching the documented expectation for a copier to keep trying
through a broker hiccup) with exponential backoff capped at
`COPY_RETRY_MAX_MS`. When the window closes, the command is dead-lettered with a
code the user can act on and a notification is queued. A leaked lease (worker
died mid-command) is requeued on expiry, which is safe because every command
carries a deterministic idempotency `requestId`.

## Periodic work

All background loops live in `CopyEngine.start()` (`apps/api/src/engine/worker.ts`)
and are `unref`'d so they never hold the process open:

| Every | Component | Work |
| --- | --- | --- |
| `WORKER_POLL_INTERVAL_MS` | `CommandDispatcher` | claim and execute commands |
| `EQUITY_PROTECTION_INTERVAL_MS` | `EquityMonitor` | evaluate drawdown rules, fire actions |
| `EQUITY_SNAPSHOT_INTERVAL_MS` | `SnapshotCollector` | balance/equity history for charts |
| 5 s | `NotificationSender` | deliver the notification outbox |
| 10 s | `MaintenanceMonitor` | reap expired leases, stale agents, ephemeral tickets |
| 60 s | `MaintenanceMonitor` | mark long-gone accounts offline |
| 60 s | `JobRunner` | claim due rows from the `jobs` table |
| 10 min | `JobRunner` | schedule `daily_reset`, `prune`, `reconcile` |
| `AGENT_HEARTBEAT_INTERVAL_MS` | `AgentHub` | ping agents, mark the silent ones offline |

The `jobs` table is the multi-process-safe scheduler: rows are claimed the same
way commands are, so two API replicas never both run the same daily reset.
Reconnects enqueue a reconciliation rather than running one inline
(`handleAgentStatus`), because the agent has not pushed fresh state yet at the
instant the socket opens.

## Deployment shapes

* **Single node (default).** `RUN_WORKER_IN_PROCESS=true`, one API process, the
  engine inside it. Simplest thing that works.
* **Split.** `RUN_WORKER_IN_PROCESS=false` and a second process running
  `createEngine(...).start()` only. The API becomes stateless and can be scaled
  behind a load balancer; workers scale independently. Nothing else changes:
  the lease and the `jobs` table were designed for it.
* **Database.** PostgreSQL ≥ 14. `docker compose up -d postgres` is for
  development only; production wants a managed instance with backups, because
  `copy_commands` *is* the queue.

## Where the design stops

* **No licensed broker API.** MT4/MT5 expose no supported server-side API, so
  the terminal side is an EA polling a local endpoint owned by the bridge
  agent. The vendor's "20–30 ms" figure is treated as a claim to verify, not a
  property to inherit — see `FEATURES.md` §3 and `docs/BRIDGE.md`.
* **Mock quotes are a snapshot.** A mock account has no streaming feed, so
  quotes are seeded once at creation. A long dev session therefore produces
  `STALE_QUOTE` skips; that is the engine working correctly (a real agent
  refreshes quotes continuously), not a bug to work around.
* **`close_all` by request id** is refused by the bridge agent rather than
  widened to "close everything" (see `apps/bridge-agent/src/ea-link.ts`),
  because the request-id → ticket lookup lives in the engine's outbox.
* **Recovery of unknown broker state is opt-in.** `RECONNECT_MISMATCH` is
  logged on every reconcile; reopening a position the slave side lost
  (`reopenMissing`) is a setting, because it can double a position if the
  broker's view is merely delayed.
