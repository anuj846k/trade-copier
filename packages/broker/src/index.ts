/**
 * Broker integration layer.
 *
 * The copy engine is platform-agnostic: it only sees `SymbolInfo`, `Position`,
 * `Quote`, `AccountSnapshot` and the request/response types in `types.ts`.
 *
 * Implementations shipped here:
 *  - `MockConnector`      — fully functional in-memory broker (tests, simulator).
 *  - `BridgeConnector`    — MetaTrader 4/5 via a polling Expert Advisor
 *                           (agent side, see `docs/BRIDGE.md`).
 *  - `RemoteConnector`    — drives a `BridgeConnector` through a bridge agent
 *                           over the realtime protocol (server side).
 *
 * Swapping in another platform (cTrader, Match-Trader, DXtrade, TradeLocker)
 * means writing one `BrokerConnector` and registering it; nothing else changes.
 */
export * from './types.js';
export * from './mock.js';
export * from './bridge-connector.js';
export * from './remote-connector.js';
export { classifyBrokerError } from '@trade-copier/contracts';
