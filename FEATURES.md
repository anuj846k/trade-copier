# Feature Ledger — Trade Copier (reference: tradersconnect.com/copier)

Working method: **REA discipline** (evidence first, conclusions tagged by evidence type).
Every feature below is tagged:

| Tag | Meaning |
| --- | --- |
| **Observed** | Stated explicitly in a public first-party source (marketing page, docs page, FAQ). Source cited. |
| **Derived** | Direct consequence of an observed feature (e.g. "close events must be mirrored" follows from "trade mirroring"). |
| **Inferred** | Not stated publicly; a reasonable engineering requirement for this class of product. Flagged as unverified. |
| **Unknown** | Could not be verified from public sources; deliberately *not* guessed. |

Sources (first-party only):

| ID | Source |
| --- | --- |
| S1 | `https://tradersconnect.com/copier` (marketing page, fetched 2026-10-18) |
| S2 | `https://tradersconnect.com/faq` (public FAQ) |
| S3 | `https://docs.tradersconnect.com/` … `trade-copier/*`, `trading-accounts/*`, `notifications/*`, `account-management/*` (public Docusaurus docs, 18 pages retrieved) |
| S4 | `https://docs.tradersconnect.com/sitemap.xml` (document/page inventory) |

---

## 1. Product surface (what the reference product does)

### 1.1 Topology

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F1 | **Master → many Slaves** (source account → N destination accounts), slaves addable one-by-one to a copier config | S1 "One trade. Every account."; S3 `copier-management` "Add additional Slaves"; "you can have as many slave accounts as you like" | Observed |
| F2 | Same account cannot be added twice to one copier config | S3 `copier-management` | Observed |
| F3 | A copier row = one master + its slaves; per-slave enable/disable independent of master enable/disable | S3 `copier-management` "Copier status" | Observed |
| F4 | **Three master states**: `Enabled`, `Disabled – Monitor Existing` (ignore new opens, still mirror closes), `Disabled` | S3 `copier-management` | Observed |
| F5 | **Pause copier** for a fixed/custom duration (hours + minutes), at master or slave level | S3 `pause-copier` | Observed |
| F6 | Copying master may be a **demo or live** account; master may use **investor (read-only) password** | S3 `copier-management` FAQ | Observed |
| F7 | Slave must have trade permission (investor password not usable on slaves) | S3 `copier-management` FAQ | Observed |
| F8 | **Account Sharing** (share account with another user who configures a copier against it; revocable; granular data sharing: balance/equity/history) | S3 `account-sharing` | Observed (marked "coming soon" in docs) |
| F9 | Compounding/account-level services such as dedicated IP + hardware "environments" | S1 | Observed (infra, out of scope for this build) |

### 1.2 Platforms

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F10 | CFD platforms: **MetaTrader 4, MetaTrader 5, cTrader, Match-Trader, TradeLocker, DXtrade** | S1, S2 | Observed |
| F11 | Futures platforms: NinjaTrader, Tradovate, ProjectX, Rithmic | S1, S2 | Observed — *out of scope (forex/CFD build)* |
| F12 | 100% cloud, no EA/VPS/software install for the user; execution located near broker servers | S1 | Observed — *this build ships a cloud connector + bridge agent, see §6* |
| F13 | Mobile apps "coming soon" | S1, S2 | Observed — *out of scope* |

### 1.3 Risk / sizing (`risk-types`)

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F14 | **Fixed Lot** — same volume on every copied trade | S3 `risk-types` | Observed |
| F15 | **Lot Multiplier** — percentage of master volume (100% = 1:1, 50% = half, 150% = 1.5×) | S3 `risk-types` | Observed |
| F16 | **Balance Multiplier** — scales master's balance-% risk to slave balance: risk % replicated against slave balance | S3 `risk-types` | Observed |
| F17 | **Fixed Balance Multiplier** — pin a fixed "master balance" so slave compounds as its own balance grows | S3 `risk-types` | Observed |
| F18 | **Fixed % Risk** — risk a % of slave balance per trade; requires master SL to size the position | S3 `risk-types` | Observed |
| F19 | **Lot Refiner** — additive lot offset (positive or negative) applied after sizing | S3 `copier-options` | Observed |
| F20 | **Contract Alignment** — adjust for differing contract sizes between brokers; default-on for Balance Multiplier | S3 `copier-options` | Observed |
| F21 | **Force Minimum Lot Size** / **Force Maximum Lot Size** — clamp instead of failing | S3 `copier-options`, `common-errors` | Observed |
| F22 | Minimum/maximum lot and contract-size awareness (micro/mini/standard = 100×/10×/1×) documented as a user-facing concern | S3 `symbols` | Observed |

### 1.4 Stop-loss / take-profit handling

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F23 | Copy SL / Copy TP toggles (fallback semantics: master close always closes slave when not using Strict Close) | S3 `copier-options` | Observed |
| F24 | **Fixed SL / Fixed TP in pips**, applied when master has none | S3 `copier-options` | Observed |
| F25 | **SL/TP refinement in pips** (master 10 pips + refiner 5 → slave 15 pips) | S3 `copier-options` | Observed |
| F26 | **Strict Close** — ignore master close events; slave exits only on its own SL/TP or manual action | S3 `copier-options`, `common-errors` | Observed |
| F27 | **Reverse Trade** — flip buy↔sell; incompatible with Copy SL/TP | S3 `copier-options` | Observed |

### 1.5 Orders

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F28 | **Copy Pending Orders** toggle; when off, a master pending order is executed as a **market order** on the slave at fill time | S3 `copier-options` | Observed |
| F29 | **Copy Expiry Time** for pending orders (default on) | S3 `copier-options` | Observed |
| F30 | **Copy Existing Trades** at copier creation time only (one-shot backfill) | S3 `copier-options` | Observed |
| F31 | Partial closes / volume changes mirrored proportionally | — | Derived (F1 + F28 + "down to the fill") |
| F32 | Order modification (SL/TP) mirrored | S3 `trading-hours`: "Trade Modifications … applied to existing trades" | Observed |

### 1.6 Filters & scheduling

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F33 | **Filter by magic number** with Copy/Ignore mode + list | S3 `copier-options` | Observed |
| F34 | **Filter by comment** with Copy/Ignore mode + list | S3 `copier-options` | Observed |
| F35 | **Filter by trade side** (all / buys only / sells only) | S3 `copier-options` | Observed |
| F36 | **Filter by lot size** (min/max master lots) | S3 `copier-options` | Observed |
| F37 | **Trading Hours** — per-weekday windows in the user's timezone, multiple windows/day; outside hours new trades are skipped but existing trades stay managed (modify + close still applied) | S3 `trading-hours` | Observed |
| F38 | Per-account **symbol enable/disable** (disabled symbols are ignored) | S3 `common-errors`, `trading-accounts/symbols` | Observed |
| F39 | **Per-symbol overrides** of the whole follower config (e.g. EURUSD at 200% while default is 100%) | S3 `override-symbol-settings` | Observed |

### 1.7 Symbol handling

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F40 | Symbols are imported from the account; user maps master→slave symbol names (e.g. DE40 → GER40) | S3 `symbols`, `copier-management` | Observed |
| F41 | **Auto-mapping** attempted, "currently only for forex pairs", goal of near-total coverage | S3 `symbols` | Observed |
| F42 | Symbol **mismatch detection** when a broker offers multiple suffixes (EURUSD vs EURUSD.mini), user picks the suffix | S3 `symbols` | Observed |
| F43 | Advanced mapping screen: filter by asset group (Forex/CFD), search, edit, delete one/all mappings | S3 `symbols` | Observed |
| F44 | Unmapped symbol ⇒ copy fails with a symbol/symbol-disabled error | S3 `common-errors` | Observed |
| F45 | Symbol metadata that must be respected: min/max lot, lot step, contract size, digits, trade mode (disabled/long-only/short-only/close-only) | S3 `symbols`, `common-errors` | Observed |

### 1.8 Safety & protection

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F46 | **Equity Protection**: daily reset time; % drawdown, $ drawdown, $ absolute-min equity; % profit, $ profit, $ absolute-max equity | S3 `trading-accounts/equity-protection` | Observed |
| F47 | EP actions: notify, disable copier, close only **copier-opened** trades, or close **all** trades; stop-loss vs take-profit protection groups are mutually exclusive for the close/disable choices | S3 `trading-accounts/equity-protection` | Observed |
| F48 | **Emergency Close All** button per account | S3 `trading-accounts/emergency-close-all` | Observed |
| F49 | 24/7 equity monitoring | S1 | Observed |
| F50 | Daily balance/equity snapshot for EP basis ("balance and equity updated daily") | S3 `trading-accounts/equity-protection` | Observed |
| F51 | Prop-firm oriented limits (max daily loss style protection, no cascade across portfolio) | S1 | Observed |

### 1.9 Observability, logging, notifications

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F52 | **Copier logs**: real-time records of executions, errors, status | S1, S3 `error-codes` | Observed |
| F53 | **Error code taxonomy** exposed to the user: e.g. symbol deactivated/mis-mapped, `MARKET_CLOSED`, invalid volume, `INVALID_PRICE`, invalid S/L or T/P, off quotes, requote, `NO_MONEY`, ticket not found, order not found | S3 `error-codes` | Observed |
| F54 | Retry policy for transient broker errors: "re-attempt multiple times over a 15 minute period, if all attempts fail the trade is a failure" (market closed); retries for off-quotes and requotes | S3 `error-codes` | Observed |
| F55 | **Connection status** per account, with broker connection error surfaced | S3 `notifications/email_configuration` (`%CONNECTION_STATUS%`, `%CONNECTION_ERROR%`) | Observed |
| F56 | **Notifications**: channels (Email beta, Telegram/WhatsApp/Discord/Slack/Webhook coming soon); per-event toggles; editable subject + template with `%VARIABLE%` tokens; per-account blocklist | S3 `notifications/*` | Observed |
| F57 | Notification events: account added/deleted/enabled/disabled, account connected/disconnected, trade copy failure, trade copied successfully, billing events, copier created/modified/deleted/enabled/disabled | S3 `notifications/introduction`, `notifications/email_configuration` | Observed |
| F58 | Dark mode | S3 `faq` | Observed — *UI polish, partially in scope* |

### 1.10 Analytics / reporting

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F59 | Per-account analytics: balance, account growth (P/L), open positions, best winning trade ($/%), balance & equity for the past week, trades taken, lots traded | S3 `trading-accounts/analytics` | Observed |
| F60 | Metrics: win %, loss %, longs won %, shorts won %, best trade %, worst trade %, average win %, average loss % | S3 `trading-accounts/analytics` | Observed |
| F61 | Separate "Analyzer" product: ROI, win rate, drawdown, heatmaps, per copied trade | S1 | Observed — *implemented here as the built-in analytics module* |

### 1.11 Accounts & billing

| # | Feature | Evidence | Tag |
| --- | --- | --- | --- |
| F62 | Multiple accounts per user; accounts added with platform + login + server + password; symbols/limits imported from the account | S3 `copier-management`, `symbols` | Observed |
| F63 | Billing is per connected account (Standard/Premium), cycles monthly/quarterly/6-month/annual, add-ons | S1 | Observed — *modelled as plans/entitlements, payment provider intentionally not wired* |
| F64 | No hard account-count limit (scales with subscription) | S3 `account-management/account-limits` | Observed |
| F65 | Account enabled/disabled toggle distinct from copier status | S3 `notifications/introduction` | Observed |
| F66 | Timezone is a user profile setting and drives trading-hours evaluation | S3 `trading-hours` | Observed |

---

## 2. Behavioural rules distilled from the docs (test oracles)

| Rule | Source |
| --- | --- |
| 100% = 1:1 volume; 50% halves; 150% = 1.5× | F15 |
| Balance Multiplier: slave volume scales with `slaveBalance / masterBalance` (or a pinned fixed master balance) | F16, F17 |
| Fixed % Risk sizing requires a master SL; volume = `riskMoney / (slDistancePips × pipValuePerLot)` | F18 |
| Refiners are additive and may be negative; SL/TP refiners widen/narrow in **pips** | F19, F25 |
| Min-lot clamp only affects trades below the min; max-lot clamp only above the max | F21 |
| Strict Close ⇒ slave ignores master close events but (per docs) must not be combined with reverse/sltp copying caveats | F26 |
| Reverse ⇒ must not also copy SL/TP | F27 |
| Pending-off ⇒ copy as market on fill; pending-on ⇒ replicate pending (risk of `INVALID_PRICE` across brokers) | F28 |
| Trading hours gate **new entries only**; modification and close always flow | F37 |
| Disabled symbol ⇒ ignore trade (log reason) | F38 |
| Unmapped symbol ⇒ fail with actionable error code | F44 |
| Outside market hours ⇒ retry for up to 15 minutes before failing | F54 |
| Every failure must be retrievable as a log row with a machine-readable code | F52, F53 |

---

## 3. Not verified from the reference site (explicit unknowns — not silently guessed)

| # | Unknown | Note on how this build handles it |
| --- | --- | --- |
| U1 | Exact latency claim ("20–30 ms") and its measurement methodology | Not reproduced. Our engine measures and logs per-command latency; no marketing claim. |
| U2 | Internal architecture, queueing, DB, and worker topology | Replaced by the architecture in `docs/ARCHITECTURE.md`. |
| U3 | Whether execution is routed by a cloud host with broker-side colocation | Not implemented. Bridge agent connects out to the API; deployment topology is the operator's choice. |
| U4 | Exact semantics of `Balance Multiplier` when master and slave have different contract sizes (docs only say "align contract sizes") | Implemented as an explicit, documented formula with contract alignment (§ `packages/domain/src/risk.ts`). |
| U5 | Whether partial closes on the master are proportional, FIFO, or unsupported | Implemented proportionally; flagged in README as an assumption. |
| U6 | Exact "Hold/Expiry" semantics of `Copy Expiry Time` across platforms | Modelled as absolute UTC expiry carried to the slave; platform adapters may drop unsupported values. |
| U7 | Whether they reconcile slave state after a disconnect (orphan close / missing reopen) | Not documented → implemented as an **optional, off-by-default** feature with explicit settings and logs. |
| U8 | Subscription/payment internals, proration, refunds | Not implemented; plans/entitlements are data + enforcement only, no payment provider. |
| U9 | Mobile apps, Rooms (community), Analyzer's exact metric definitions | Out of scope; the analytics module covers the documented metric list (F59–F60). |
| U10 | Security internals (2FA, session policy, encryption) | Not documented publicly → standard hardening applied (see `docs/SECURITY.md`). |
| U11 | Their exact notification-template rendering engine | Reproduced the documented `%TOKEN%` substitution behaviour. |

---

## 4. Scope decision for this build

**In scope (forex/CFD copier, single-tenant-per-user SaaS):** F1–F9 (except infra provisioning), F10 (MT4/MT5 + generic adapter seam for cTrader/Match-Trader/TradeLocker/DXtrade), F14–F61, F62–F66 (F63 enforcement without a payment gateway).

**Explicitly out of scope:** futures platforms (F11), cloud/VPS provisioning (F9), mobile apps (F13), Rooms/community, payment provider integration (U8).

**Adapter seam (credential-gated, ships with mock):** all broker connectivity goes through `packages/broker` — `BrokerConnector` interface + `MockBrokerConnector` (fully working simulator) + `Mt5BridgeConnector` (real one that the operator wires to an MT5 EA or the MT5 Python bridge) + documented MQL5 EA skeleton. See `docs/BRIDGE.md`.
