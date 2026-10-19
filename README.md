# Trade Copier

A production-shaped **forex/CFD trade copier**: trades opened on a *master*
account are mirrored onto any number of *follower* accounts with independent
position sizing, symbol mapping and risk limits — the thing
[tradersconnect.com/copier](https://tradersconnect.com/copier) sells, rebuilt
from the outside in.

The interesting part is not the UI, it is the copy path: a decision engine that
turns a master position diff into a sized, mapped, filtered broker command, and
a durable outbox that survives restarts and retries the way a real one has to.

> **Scope, honestly.** Everything here is real, runnable code: the engine, the
> outbox, the broker boundary, the bridge agent, the dashboard and the test
> suites all work against a real PostgreSQL. What is *not* here is a licensed
> broker API. MT4/MT5 have no public server-side API, so the terminal side is an
> Expert Advisor that polls a local endpoint — see `docs/BRIDGE.md`. Where a
> vendor claim could not be verified (sub-50 ms copying, "zero slippage"), it is
> flagged in `FEATURES.md` §3 and in the walkthrough rather than silently
> assumed.

---

## What it does

| Area | Behaviour |
| --- | --- |
| Copying | Master position diffs → follower commands: open, close, partial close, modify stops, pending orders |
| Sizing | `LOT_MULTIPLIER`, `FIXED_LOT`, `BALANCE_MULTIPLIER`, `FIXED_BALANCE_MULTIPLIER`, `FIXED_PERCENT_RISK` |
| Symbols | Canonical instrument matching across broker suffixes (`EURUSD` → `EURUSD.raw`, `EURUSD_ecn`) with per-follower overrides |
| Filters | Side, symbol include/exclude, magic, lot bounds, max spread, max slippage, market-hours awareness |
| Safety | Per-follower equity protection (drawdown / daily loss) that disables copying and can flatten positions |
| Reliability | Durable command outbox, per-account serialisation, exponential backoff inside a retry window, dead-lettering |
| Observability | Rule-by-rule decision trace on every copy, execution log, analytics, live dashboard over WebSocket |
| Accounts | Multiple accounts per user, MT4/MT5-class platforms, encrypted credentials, account sharing with roles |

Forex-specific maths — pip value, lot steps, contract size, spread and slippage
in pips, the Sunday 21:00 → Friday 21:00 UTC trading week and the daily rollover
break — lives in `packages/domain` and is unit-tested, not sprinkled through the
API.

## Try it in one minute (no broker, no terminal)

Requires Node ≥ 20, pnpm ≥ 9 and Docker.

```bash
pnpm install
cp .env.example .env                     # then set JWT_SECRET and ENCRYPTION_KEY
docker compose up -d postgres            # PostgreSQL 16 + a test database
pnpm db:migrate                          # apply packages/db/drizzle/*.sql
pnpm db:seed                             # demo user: demo@trade-copier.dev / demo-password-123
pnpm sim                                 # run a real copy through the real engine
```

`pnpm sim` opens three master positions, lets the engine size them for two
followers with different risk models and different symbol suffixes, closes one
and reports the result — all through the production code path, with the broker
boundary mocked:

```
→ master opens buy 1 AUDUSD, sell 0.5 BTCUSD, buy 2 EURGBP
  6 command(s) dispatched

  follower legs
    IC Markets ECN 25k   EURGBP → EURGBP.raw   open   0.50 lots @ 1.10004
    IC Markets ECN 25k   AUDUSD → AUDUSD.raw   closed 0.25 lots @ 1.10004  P/L 55.87
    MT4 Prop 10k         EURGBP → EURGBP_ecn   open   0.39 lots @ 1.10004
    MT4 Prop 10k         AUDUSD → AUDUSD_ecn   closed 0.51 lots @ 1.10004  P/L 113.98
```

Then run the dashboard:

```bash
pnpm dev      # API on :4000, dashboard on :3000
```

Sign in as `demo@trade-copier.dev` / `demo-password-123` (or register a new
account) and open **Copiers → Trades** to see what the engine decided, with the
full decision trace per trade.

## Repository layout

```
apps/
  api/            Fastify API + copy engine + worker   (@trade-copier/api)
  web/            Next.js 15 App Router dashboard      (@trade-copier/web)
  bridge-agent/   Terminal-side agent (WebSocket + EA) (@trade-copier/bridge-agent)
packages/
  contracts/      Zod schemas: HTTP DTOs, realtime protocol, platform types
  domain/         Pure logic: sizing, pips, symbols, filters, planner, market hours
  db/             Drizzle schema, SQL migrations, repositories
  broker/         One connector interface + mock / bridge / remote implementations
integrations/mt5/ Expert Advisor skeleton that talks to the bridge agent
tools/            Seed, reset, copy simulator, dev database helpers
docs/             Architecture, API reference, bridge protocol, manual steps
FEATURES.md       Feature ledger: what was inferred, from where, and what is unknown
```

Dependencies flow inwards: `contracts` and `domain` know nothing about the
database or the network; `db` and `broker` depend on them; `apps/*` depend on
everything. That is why the planner can be tested exhaustively with plain
objects and why the engine cannot tell a mock connector from a real terminal.

## Commands

```bash
pnpm dev              # api + web in watch mode
pnpm dev:agent        # bridge agent in watch mode
pnpm build            # build api, web and agent
pnpm typecheck        # tsc -b across every project (packages, apps, tools)
pnpm test             # all 234 tests (integration suites skip without a test DB)
pnpm test:unit        # domain + contracts only, no database
pnpm test:integration # API suites against TEST_DATABASE_URL

pnpm db:migrate       # apply migrations
pnpm db:seed          # demo accounts, copiers, mappings
pnpm db:reset         # drop everything, optionally --seed
pnpm sim              # end-to-end copy simulation (--symbols, --verbose, --keep-open)
```

Type checking is one project graph (`pnpm exec tsc -b`), not a per-package
guess: a change in `domain` that breaks `apps/api` fails the same command.

## Tests

```bash
pnpm test                  # everything
pnpm test:integration      # needs TEST_DATABASE_URL, e.g. from docker compose
```

* **Unit** (`pnpm test:unit`) — the forex maths and the protocol, no I/O:
  128 domain + 33 contract tests.
* **API** (`pnpm test:integration`) — 73 tests in `apps/api/test`: API
  primitives (password hashing, TOTP, environment validation, security
  headers) plus 14 that run the real pipeline, dispatcher, repositories and
  HTTP surface against PostgreSQL with mock connectors. The database-backed
  ones skip automatically when `TEST_DATABASE_URL` is unset, and the harness
  refuses to reset any database whose name does not end in `_test`.

They were worth writing: running them the first time found four defects that
reading the code had not — a raw-SQL row mapping that made every retry throw, an
audit column whose enum no longer matched a single call site, a duplicated
cookie plugin that stopped the server from booting at all, and an engine that
could not price a mock account. They are the reason `pnpm sim` works.

## Documentation

| Document | Contents |
| --- | --- |
| `docs/ARCHITECTURE.md` | Layers, the copy path end to end, the outbox and its state machine, deployment shapes |
| `docs/API.md` | Every HTTP route, the WebSocket channels, error codes |
| `docs/BRIDGE.md` | Agent/EA protocol, the local EA HTTP contract, the MT5 integration |
| `docs/MANUAL-STEPS.md` | What you must do yourself: secrets, migrations, a real broker, going live |
| `FEATURES.md` | Feature ledger with sources and the list of unknowns |

## Requirements

* Node ≥ 20.11, pnpm ≥ 9
* PostgreSQL ≥ 14 (16 in `docker-compose.yml`)
* Docker only for the dev database — the API itself is a plain Node process
* A MetaTrader terminal only if you want to copy from a real account
