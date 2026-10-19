# Manual steps

Everything the code cannot do for you. Nothing here is a workaround for a
half-finished feature: these are the places where a human must supply a secret,
a decision or a credential.

## 1. Secrets

`.env` is gitignored and generated from `.env.example`. Two values have no safe
default and the API refuses to boot without them:

```bash
cp .env.example .env
JWT_SECRET=$(openssl rand -base64 48)          # ≥ 32 chars
ENCRYPTION_KEY=$(openssl rand -base64 32)      # exactly 32 bytes, base64
# then edit .env and paste them in
```

* `JWT_SECRET` — signs access tokens. Rotating it logs everybody out.
* `ENCRYPTION_KEY` — AES-256-GCM for stored broker passwords. **Rotating it
  without re-encrypting makes existing credentials unreadable.**
* `apps/web/.env.local` needs `SESSION_COOKIE_SECRET` (≥ 32 chars) for the BFF
  cookie, plus `API_INTERNAL_URL` and `NEXT_PUBLIC_WS_URL`.

Never commit either file. The `origin` remote is public; check `git status`
before pushing.

## 2. Database

```bash
docker compose up -d postgres     # PostgreSQL 16 + trade_copier_test
pnpm db:migrate                   # apply packages/db/drizzle/*.sql
pnpm db:seed                      # optional demo data
```

The migrations are **generated, not applied, by the repository** — that is
deliberate: applying schema changes to somebody's database as a side effect of
`pnpm install` is how data gets lost. Run `pnpm db:migrate` yourself, in a
release step, before starting a new version of the API.

`pnpm db:reset --force` drops and recreates everything. It refuses to run
against a non-local host or with `NODE_ENV=production`, but read the output
before typing `--force` anyway.

For integration tests:

```bash
export TEST_DATABASE_URL=postgres://trade_copier:trade_copier@localhost:5432/trade_copier_test
pnpm test:integration
```

The test harness drops the `public` **and** `drizzle` schemas of that database
between suites, and refuses to touch a database whose name does not end in
`_test`. Never point `TEST_DATABASE_URL` at anything you care about.

## 3. Registering a real master account

You need, from the broker:

* the account login (number),
* the server name exactly as the terminal shows it (`ICMarketsSC-Live15`, not
  `IC Markets`),
* the **investor (read-only) password** for a master account, if the broker
  provides one. Use it: a copier needs to read the master, not trade it, and an
  investor password cannot withdraw or trade.

In the dashboard: **Accounts → Add account**. The password is encrypted with
`ENCRYPTION_KEY` and never returned by the API.

## 4. Putting an EA on the terminal

This is the part no API can do for you, and it must be done on each machine:

1. **Settings → Bridge Agents → New agent.** Copy the token now — it is shown
   once and stored only as a hash.
2. Install the agent on the same machine as the terminal (Windows VPS), with a
   config file or `BRIDGE_*` environment variables pointing `serverUrl` at your
   API (`wss://…` for anything but local development). See `docs/BRIDGE.md`.
3. On the terminal: **Tools → Options → Expert Advisors** → allow WebRequest to
   `http://127.0.0.1:<eaPort>` (the EA's poll target) and enable algorithmic
   trading.
4. Compile the EA from `integrations/mt5/` and attach it to **one chart per
   account**. The EA's input parameters must match the agent's `accounts[]`
   entry: the local port and the `eaToken`.
5. Check the agent's local health endpoint (`http://127.0.0.1:9000/health`) and
   the dashboard: the account should flip to **connected** and start reporting
   symbols and positions.

Attach the EA to a chart of the account you registered. One terminal, one EA,
one agent `accounts[]` entry.

## 5. Choosing what to copy

* Add the master to a copier and pick followers. Follower **settings are
  independent per follower** — that is the whole product: same trades, different
  sizing.
* Check the **symbol mapping** before going live. Brokers name the same
  instrument differently (`EURUSD`, `EURUSD.raw`, `EURUSD_ecn`); the auto-mapper
  matches names and suffixes, but an exotic instrument may need a manual row.
  The dashboard shows unresolved master symbols explicitly rather than silently
  skipping them.
* Start with `copyExistingTrades` **off** on a live account unless you mean it:
  it mirrors whatever the master holds right now, immediately, at market.

## 6. Sizing, in one table

| Risk type | Formula | When |
| --- | --- | --- |
| `LOT_MULTIPLIER` | master lots × (`lotMultiplier` ÷ 100) | proportional to the master; 100 = 1:1 |
| `FIXED_LOT` | `fixedLot` | every copy the same size |
| `BALANCE_MULTIPLIER` | master lots × (`followerBalance` ÷ `masterBalance`) × (`balanceMultiplier` ÷ 100) | keeps risk proportional to capital |
| `FIXED_BALANCE_MULTIPLIER` | master lots × (`followerBalance` ÷ `fixedMasterBalance`) × (`balanceMultiplier` ÷ 100) | same, against a reference instead of the live master balance |
| `FIXED_PERCENT_RISK` | (`followerBalance` × `percentRisk` ÷ 100) ÷ (`stopLossPips` × pip value per lot) | needs a stop loss on the master (or `fixedStopLossPips`) |

Two modifiers sit on top of the result:

* **Contract Alignment** (default: on for the balance multipliers, off otherwise)
  multiplies by `masterContractSize / slaveContractSize`, so a 100 oz gold
  contract on the master and a 1 oz CFD on the follower do not produce 100× the
  exposure. A differing contract size with alignment off logs a warning.
* **Lot Refiner** is an additive offset applied last.

Volume is floored to the broker's `volumeStep` and clamped to
`minVolume`/`maxVolume`; a clamp writes a warning on the log row, and a volume
that would be zero is skipped as `VOLUME_BELOW_MIN` rather than rounded up into
a position the user did not ask for. Where a pip value cannot be converted into
the account currency the computation is marked *degraded* and says so — it does
not silently assume a rate.

## 7. Going live, in order

1. `pnpm db:migrate` on the production database.
2. Start the API with `RUN_WORKER_IN_PROCESS=true` (or a separate worker) and
   set `NODE_ENV=production`, a real `CORS_ORIGINS` list, and HTTPS in front.
3. `GET /api/v1/health` — expect `status: "ok"`, `database: "up"`,
   `queue.depth` near zero.
4. Register the master, map the symbols, add one follower with `FIXED_LOT` set
   to the broker minimum.
5. Open **one** trade on the master (0.01 lots) and watch the dashboard: the
   copy should appear with its decision trace; the log should show `COPIED`,
   then `COPIED_CLOSE` when you close it, then a realised P/L once the terminal
   reports the closed trade.
6. Only then raise the sizes. Set **Equity Protection** before a live account
   has anything to protect, not after.

`GET /api/v1/health` and `queue.oldestQueuedAgeMs` are the two things worth
alerting on: a growing queue means the broker side is slow or the agent is
offline, and it will not fix itself.

## 8. Known gaps you should not expect the code to fill

* **No payment provider.** Billing plans and a subscription record exist;
  `POST /billing/subscribe` records intent. No Stripe integration, no card
  data, no invoices.
* **No mobile app.** The dashboard is responsive but it is a web app.
* **No futures/FIX platform connectors.** The connector interface is generic;
  only the MT-class path (`bridge-agent` + EA), the in-process mock and the
  remote-RPC connector exist. A cTrader/Match-Trader adapter is a new
  `BrokerConnector`, not a rewrite.
* **Mock quotes are a one-shot snapshot.** A demo/mock account has no streaming
  feed, so a long running dev session eventually shows `STALE_QUOTE` skips. That
  is the quote-age rule working. Use a real agent, or restart the sim, if you
  need fresh quotes.
* **Nothing has been run against a real broker.** The engine, the outbox, the
  agent and the EA skeleton are exercised end to end with mock connectors and
  integration tests; the EA itself needs a terminal and a broker to prove out.
  Treat the first live copy as a test, with minimum volume.
