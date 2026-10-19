import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  bridgeInboundSchema,
  bridgeOutboundSchema,
  commandParamsSchema,
  uiClientMessageSchema,
  uiServerMessageSchema,
} from '../src/index.js';

/**
 * Realtime protocol tests.
 *
 * Both channels are parsed on the receiving end, so these tests pin the wire
 * format: an agent built against protocol v1 and a dashboard built against
 * protocol v1 must agree on every message, and a malformed frame must be
 * rejected rather than half-applied.
 */

describe('bridge protocol: agent → server', () => {
  it('accepts an agent.hello and fills in conservative capability defaults', () => {
    const message = bridgeInboundSchema.parse({
      type: 'agent.hello',
      protocolVersion: PROTOCOL_VERSION,
      agentToken: 'agent_abcdefghijklmnop',
      name: 'VPS London',
      version: '1.4.2',
      accounts: [
        {
          accountId: 'acc_1',
          login: '5012345',
          server: 'FTMO-Server',
          platform: 'mt5',
          currency: 'USD',
        },
      ],
    });

    expect(message.type).toBe('agent.hello');
    if (message.type !== 'agent.hello') return;
    // Defaults matter: an agent that omits capabilities gets the safe set.
    expect(message.accounts[0]?.capabilities).toMatchObject({ pendingOrders: true, modify: true, quotes: true });
    expect(message.accounts[0]?.kind).toBe('live');
  });

  it('rejects an unknown message type instead of ignoring it', () => {
    expect(bridgeInboundSchema.safeParse({ type: 'agent.something.new' }).success).toBe(false);
  });

  it('rejects a heartbeat with a non-ISO timestamp', () => {
    expect(bridgeInboundSchema.safeParse({ type: 'agent.heartbeat', at: 'yesterday' }).success).toBe(false);
  });

  it('treats a command result as advisory, defaulting every optional field', () => {
    const result = bridgeInboundSchema.parse({ type: 'command.result', requestId: 'req_1', status: 'rejected' });
    expect(result.type).toBe('command.result');
    if (result.type !== 'command.result') return;
    expect(result.ticket).toBeNull();
    expect(result.filledVolume).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it('carries a 64-bit slave ticket verbatim', () => {
    const message = bridgeInboundSchema.parse({
      type: 'closed_trade',
      accountId: 'acc_1',
      trade: {
        ticket: '90071992547409931',
        symbol: 'EURUSD',
        side: 'sell',
        volume: 0.5,
        openPrice: 1.085,
        closePrice: 1.083,
        profit: 100,
        openedAt: '2026-03-04T10:00:00.000Z',
        closedAt: '2026-03-04T11:00:00.000Z',
      },
    });
    expect(message.type).toBe('closed_trade');
    if (message.type !== 'closed_trade') return;
    expect(message.trade.ticket).toBe('90071992547409931');
    expect(message.trade.magic).toBe(0);
  });
});

describe('bridge protocol: server → agent', () => {
  const command = {
    type: 'server.command',
    requestId: 'req_1',
    accountId: 'acc_2',
    kind: 'open',
    params: { symbol: 'EURUSD.raw', side: 'buy', volume: 0.25, maxSlippagePips: 3 },
    timeoutMs: 3_000,
  };

  it('parses an open command and defaults the correlation trace', () => {
    const parsed = bridgeOutboundSchema.parse(command);
    expect(parsed.type).toBe('server.command');
    if (parsed.type !== 'server.command') return;
    expect(parsed.params.volume).toBe(0.25);
    // Every command carries a trace so a decision can be followed end to end.
    expect(parsed.trace).toEqual({ copierId: null, followerId: null, masterTradeId: null, masterTicket: null });
  });

  it('rejects a zero or negative volume', () => {
    expect(commandParamsSchema.safeParse({ symbol: 'EURUSD', side: 'buy', volume: 0 }).success).toBe(false);
    expect(commandParamsSchema.safeParse({ symbol: 'EURUSD', side: 'buy', volume: -1 }).success).toBe(false);
  });

  it('rejects a command with no timeout', () => {
    const { timeoutMs: _timeoutMs, ...withoutTimeout } = command;
    expect(bridgeOutboundSchema.safeParse(withoutTimeout).success).toBe(false);
  });

  it('accepts a close_all that is scoped to copier-placed tickets', () => {
    const parsed = bridgeOutboundSchema.parse({
      type: 'server.command',
      requestId: 'req_2',
      accountId: 'acc_2',
      kind: 'close_all',
      params: { originRequestIds: ['req_a', 'req_b'], filterMagic: 20_261_019 },
      timeoutMs: 3_000,
    });
    expect(parsed.type).toBe('server.command');
    if (parsed.type !== 'server.command') return;
    expect(parsed.params.originRequestIds).toEqual(['req_a', 'req_b']);
  });

  it('rejects an unknown command kind', () => {
    expect(bridgeOutboundSchema.safeParse({ ...command, kind: 'hedge' }).success).toBe(false);
  });
});

describe('dashboard protocol', () => {
  it('accepts a subscribe frame with known topics only', () => {
    const parsed = uiClientMessageSchema.parse({ type: 'subscribe', topics: ['copiers', 'logs', 'accounts'] });
    expect(parsed.type).toBe('subscribe');
    expect(uiClientMessageSchema.safeParse({ type: 'subscribe', topics: ['everything'] }).success).toBe(false);
    // An empty subscription is meaningless; the schema refuses it.
    expect(uiClientMessageSchema.safeParse({ type: 'subscribe', topics: [] }).success).toBe(false);
  });

  it('parses a trade update with its follower legs', () => {
    const message = uiServerMessageSchema.parse({
      type: 'trade.updated',
      masterTradeId: 'mt_1',
      ticket: 'sim-1',
      symbol: 'EURUSD',
      side: 'buy',
      volume: 1,
      state: 'open',
      links: [{ followerId: 'fol_1', accountId: 'acc_2', status: 'open', errorCode: null, filledVolume: 0.25 }],
      at: '2026-03-04T10:00:00.000Z',
    });
    expect(message.type).toBe('trade.updated');
    if (message.type !== 'trade.updated') return;
    expect(message.links[0]?.filledVolume).toBe(0.25);
  });

  it('rejects a trade update without a timestamp', () => {
    expect(
      uiServerMessageSchema.safeParse({
        type: 'trade.updated',
        masterTradeId: 'mt_1',
        ticket: '1',
        symbol: 'EURUSD',
        side: 'buy',
        volume: 1,
        state: 'open',
        links: [],
      }).success,
    ).toBe(false);
  });

  it('keeps the log payload open-ended, because the context column is `jsonb`', () => {
    const parsed = uiServerMessageSchema.parse({
      type: 'log.appended',
      entry: { id: 'log_1', level: 'warn', code: 'SPREAD_TOO_WIDE', message: 'spread 3.4 pips', context: { spread: 3.4 } },
      at: '2026-03-04T10:00:00.000Z',
    });
    expect(parsed.type).toBe('log.appended');
    if (parsed.type !== 'log.appended') return;
    // Deliberately a loose record: the shape of a log context is owned by the
    // engine, and pinning it here would make every new field a breaking change.
    expect(parsed.entry).toMatchObject({ code: 'SPREAD_TOO_WIDE' });
  });

  it('carries an error frame that a client can show without guessing', () => {
    const message = uiServerMessageSchema.parse({ type: 'error', code: 'TICKET_INVALID', message: 'Ticket expired' });
    expect(message).toEqual({ type: 'error', code: 'TICKET_INVALID', message: 'Ticket expired' });
  });
});
