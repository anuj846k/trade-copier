# MetaTrader 5 Expert Advisor

The terminal-side half of the bridge. `TradeCopierBridge.mq5` polls the local
bridge agent on a timer, pushes the account's state, and executes whatever
commands come back.

```
TradeCopierBridge.mq5 ──POST /ea──▶ bridge agent ──WebSocket──▶ API / engine
      (this folder)        (Node)
```

Protocol reference: `docs/BRIDGE.md`. The agent's local HTTP contract lives in
`packages/broker/src/bridge-connector.ts` (`EaPollMessage`); the cloud frames are
in `packages/contracts/src/realtime.ts`.

## Files

| File | Purpose |
| --- | --- |
| `TradeCopierBridge.mq5` | the Expert Advisor: poll loop, order execution, closed-trade events |
| `Json.mqh` | a small JSON parser/builder (MQL5 has none, and a full library is a large thing to audit) |

## Install

1. In MetaEditor, **File → Open Data Folder**, then copy both files into
   `MQL5/Experts/TradeCopier/`.
2. Compile `TradeCopierBridge.mq5` (F7). There should be no errors; warnings
   about unused inputs are harmless.
3. Start the agent first (see `docs/BRIDGE.md`) and confirm it is listening for
   this terminal.
4. **Tools → Options → Expert Advisors**: tick *Allow WebRequest for listed URL*
   and add `http://127.0.0.1:8787` (the host and port must match the inputs
   below and the agent's `accounts[]` entry).
5. Drag the EA onto **one chart per account**, with *Allow Algo Trading*
   enabled. The chart's symbol does not matter; the EA reads the whole account.

## Inputs

| Input | Default | Notes |
| --- | --- | --- |
| `InpEaHost` | `127.0.0.1` | the agent runs on the same machine — keep it loopback |
| `InpEaPort` | `8787` | must match `accounts[].eaPort` in the agent's config |
| `InpEaToken` | — | must match `accounts[].eaToken`; a mismatch is a 401 in the terminal's *Experts* log |
| `InpPollIntervalMs` | `250` | worst-case copy latency is roughly this plus broker execution |
| `InpSendSymbols` | `true` | send symbol metadata so the dashboard can map instruments |
| `InpSymbolsEveryPolls` | `40` | the catalogue is large and changes rarely; every ~10 s at the default poll rate |
| `InpSymbolWatchlist` | — | extra symbols, comma separated; they are added to Market Watch |
| `InpSendFullMarket` | `false` | `false` = Market Watch only (see *Known limits*) |
| `InpDeviationPoints` | `30` | fallback slippage tolerance, in points, used when the command does not specify one |
| `InpDryRun` | `false` | log commands instead of executing them — use this for the first run |

`InpDryRun = true` is the safe way to check the wiring: the engine will mark
everything as filled against a fake ticket (`dry-run`), so do it on a throwaway
account or a mock, and set it back to `false` before a real one.

## What it reports

Every poll sends:

* `snapshot` — balance, equity, margin, free margin, margin level, currency, leverage.
* `symbols` — occasionally: name, canonical key, asset class, digits, point, pip size, contract size, lot bounds, trade mode, quote currency, swaps.
* `positions` — market positions **and** pending orders, the complete set. The
  server derives opens, partial closes, modifies and closes by diffing
  consecutive sets, so a missed poll is never a missed event.
* `results` — the outcome of the commands handed out on previous polls.
* `events` — `trade_closed`, with profit, swap and commission from the terminal's
  history. This is the only place realised P/L exists.

## What it executes

`open`, `place_pending`, `modify`, `close`, `close_partial`, `cancel_pending` and
`close_all` (scoped by ticket list, by magic, or — with neither — the whole
account).

Two details that matter for correctness:

* **Volume is normalised here too.** The EA floors to `SYMBOL_VOLUME_STEP` and
  clamps to the symbol's bounds, and refuses a volume that rounds down to zero
  (`VOLUME_TOO_SMALL`) instead of sending an order the broker would reject.
* **Slippage is converted from pips to points** using the symbol's own pip size,
  because the command carries pips while `MqlTradeRequest.deviation` wants
  points.

## Known limits

* **Not compiled or run against a live terminal.** There is no MetaTrader in the
  environment this repository was built in, so the EA is written against the
  documented MQL5 API and the agent's own contract, and has been reviewed but not
  executed. Expect to fix a compile error or two. The agent side *is* tested
  (`packages/broker` and the bridge agent are covered by the type graph and unit
  tests), so the protocol is the stable part.
* **Symbol catalogue.** `SymbolInfoDouble` is not reliable for instruments the
  terminal has not downloaded, so by default only Market Watch symbols are
  reported (plus `InpSymbolWatchlist`). Set `InpSendFullMarket = true` if you
  want the broker's entire catalogue and can live with zeroes for symbols the
  terminal has never seen. The server needs the **master's** symbols to resolve
  symbol mapping, so make sure the instruments you copy are in Market Watch.
* **Timestamps are `TimeGMT()`.** If the terminal's clock is wrong, quote ages
  and market-hours checks are wrong, and the engine will (correctly) refuse
  stale quotes. Keep the VPS clock synced.
* **No `OnTradeTransaction` yet.** Results are queued and sent on the next poll,
  so they appear within one poll interval. A future revision can react to trade
  transactions directly for lower latency on the master side.
* **MT4 uses a different order API.** The polling contract is identical, but
  `OrderSend` and position enumeration differ enough that MT4 deserves its own
  `.mq4` rather than a pile of `#ifdef`s. It is not written here.
