import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  bridgeInboundSchema,
  type AccountSnapshot,
  type BridgeInboundMessage,
  type BridgeOutboundMessage,
  type Platform,
  type Position,
  type Quote,
  type SymbolInfo,
} from '@trade-copier/contracts';
import { RemoteConnector, type RemoteStateCache } from '@trade-copier/broker';
import type { Repositories } from '@trade-copier/db';

/**
 * Bridge agent hub.
 *
 * Owns the live socket per agent, the per-account state cache that the engine
 * reads instead of round-tripping, and the `RemoteConnector` used to dispatch
 * commands. Everything the copy engine needs about a broker arrives through
 * this one object, so the engine never touches sockets directly.
 */

export interface ClosedTradeLike {
  ticket: string;
  symbol: string;
  side: 'buy' | 'sell';
  volume: number;
  openPrice: number;
  closePrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  magic: number;
  comment: string;
  profit: number;
  swap: number;
  commission: number;
  openedAt: string;
  closedAt: string;
}

export class AccountCache implements RemoteStateCache {
  private snapshotValue: AccountSnapshot | null = null;
  private symbolsValue: SymbolInfo[] = [];
  private positionsValue: Position[] = [];
  private readonly quotes = new Map<string, Quote>();
  updatedAt: number | null = null;

  constructor(readonly accountId: string, readonly platform: Platform) {}

  snapshot(): AccountSnapshot | null {
    return this.snapshotValue;
  }

  symbols(): readonly SymbolInfo[] {
    return this.symbolsValue;
  }

  positions(): readonly Position[] {
    return this.positionsValue;
  }

  quote(symbol: string): Quote | null {
    return this.quotes.get(symbol) ?? this.quotes.get(symbol.toUpperCase()) ?? null;
  }

  setSnapshot(snapshot: AccountSnapshot): void {
    this.snapshotValue = snapshot;
    this.updatedAt = Date.now();
  }

  setSymbols(symbols: readonly SymbolInfo[]): void {
    this.symbolsValue = [...symbols];
    this.updatedAt = Date.now();
  }

  setPositions(positions: readonly Position[]): void {
    this.positionsValue = [...positions];
    this.updatedAt = Date.now();
  }

  upsertPosition(position: Position): void {
    const index = this.positionsValue.findIndex((candidate) => candidate.ticket === position.ticket);
    if (index === -1) this.positionsValue.push(position);
    else this.positionsValue[index] = position;
    this.updatedAt = Date.now();
  }

  removePosition(ticket: string): void {
    this.positionsValue = this.positionsValue.filter((position) => position.ticket !== ticket);
    this.updatedAt = Date.now();
  }

  setQuotes(quotes: readonly Quote[]): void {
    for (const quote of quotes) this.quotes.set(quote.symbol, quote);
    this.updatedAt = Date.now();
  }

  get ageMs(): number | null {
    return this.updatedAt === null ? null : Date.now() - this.updatedAt;
  }
}

/** Minimal structural view of a `ws` socket, kept local to avoid a hard type coupling. */
const WS_OPEN = 1;

export type AgentHello = Extract<BridgeInboundMessage, { type: 'agent.hello' }>;

export interface AgentSession {
  readonly id: string;
  readonly agentId: string;
  readonly userId: string;
  readonly name: string;
  readonly version: string;
  readonly socket: WebSocket;
  readonly connectedAt: number;
  lastSeenAt: number;
  queueDepth: number;
  latencyMs: number | null;
  readonly accounts: Map<string, AccountCache>;
  readonly connectors: Map<string, RemoteConnector>;
  readonly allowedAccounts: Map<string, { accountId: string; login: string; server: string }>;
}

export interface AgentHubOptions {
  readonly repos: Repositories;
  readonly log: FastifyBaseLogger;
  readonly heartbeatIntervalMs: number;
  readonly commandTimeoutMs: number;
  /** Called for every position set the agent reports (snapshot or single change). */
  onPositions: (accountId: string, positions: readonly Position[], authoritative: boolean) => Promise<void>;
  onClosedTrade: (accountId: string, trade: ClosedTradeLike) => Promise<void>;
  onAccountState: (accountId: string, snapshot: AccountSnapshot) => Promise<void>;
  onSymbols: (accountId: string, symbols: readonly SymbolInfo[]) => Promise<void>;
  onAgentStatus: (agentId: string, status: 'connected' | 'disconnected') => void;
}

export class AgentHub {
  private readonly sessionsByAgent = new Map<string, AgentSession>();
  private readonly agentByAccount = new Map<string, string>();

  constructor(private readonly options: AgentHubOptions) {}

  get onlineAgents(): number {
    return this.sessionsByAgent.size;
  }

  connectorFor(accountId: string): RemoteConnector | null {
    const agentId = this.agentByAccount.get(accountId);
    if (!agentId) return null;
    return this.sessionsByAgent.get(agentId)?.connectors.get(accountId) ?? null;
  }

  cacheFor(accountId: string): AccountCache | null {
    const agentId = this.agentByAccount.get(accountId);
    if (!agentId) return null;
    return this.sessionsByAgent.get(agentId)?.accounts.get(accountId) ?? null;
  }

  sessionFor(agentId: string): AgentSession | null {
    return this.sessionsByAgent.get(agentId) ?? null;
  }

  isAccountOnline(accountId: string): boolean {
    return this.agentByAccount.has(accountId);
  }

  isAgentOnline(agentId: string): boolean {
    return this.sessionsByAgent.has(agentId);
  }

  /** Counts for the system page: sessions, connected accounts, protocol versions. */
  stats(): {
    agents: number;
    accounts: number;
    versions: Record<string, number>;
    oldestSessionAgeMs: number | null;
  } {
    const versions: Record<string, number> = {};
    let oldest: number | null = null;
    const now = Date.now();
    for (const session of this.sessionsByAgent.values()) {
      versions[session.version] = (versions[session.version] ?? 0) + 1;
      const age = now - session.connectedAt;
      if (oldest === null || age > oldest) oldest = age;
    }
    return {
      agents: this.sessionsByAgent.size,
      accounts: this.agentByAccount.size,
      versions,
      oldestSessionAgeMs: oldest,
    };
  }

  /** Sends a frame to the agent that owns an account; false when offline. */
  send(accountId: string, frame: BridgeOutboundMessage): boolean {
    const agentId = this.agentByAccount.get(accountId);
    if (!agentId) return false;
    const session = this.sessionsByAgent.get(agentId);
    if (!session || session.socket.readyState !== WS_OPEN) return false;
    try {
      session.socket.send(JSON.stringify(frame));
      return true;
    } catch (error) {
      this.options.log.warn({ err: error, accountId }, 'failed to send frame to bridge agent');
      return false;
    }
  }

  /**
   * Attaches an upgraded socket. The first frame must be `agent.hello` with a
   * valid token; until then the socket is inert.
   */
  attach(socket: WebSocket, ip?: string | null): void {
    const handshakeTimeout = setTimeout(() => {
      if (!socket.__agentHubSession) socket.close(4401, 'hello timeout');
    }, 10_000);

    socket.on('message', (data) => {
      void this.onMessage(socket, data.toString(), ip ?? null);
    });
    socket.on('close', () => {
      clearTimeout(handshakeTimeout);
      this.detach(socket);
    });
    socket.on('error', (error) => {
      this.options.log.warn({ err: error }, 'bridge agent socket error');
    });
  }

  private async onMessage(socket: WebSocket, raw: string, ip: string | null): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      socket.close(4400, 'invalid json');
      return;
    }

    const result = bridgeInboundSchema.safeParse(parsed);
    if (!result.success) {
      this.options.log.warn({ issues: result.error.issues }, 'bridge agent sent an invalid frame');
      return;
    }
    const message = result.data;

    if (message.type === 'agent.hello') {
      await this.handleHello(socket, message, ip);
      return;
    }

    const session = socket.__agentHubSession;
    if (!session) {
      socket.close(4401, 'hello required');
      return;
    }
    session.lastSeenAt = Date.now();

    switch (message.type) {
      case 'agent.heartbeat': {
        session.queueDepth = message.queueDepth;
        session.latencyMs = message.latencyMs;
        await this.options.repos.accounts.touchAgent(session.agentId, message.queueDepth, message.latencyMs);
        break;
      }
      case 'account.state': {
        const cache = session.accounts.get(message.accountId);
        const snapshot: AccountSnapshot = {
          accountId: message.accountId,
          balance: message.balance,
          equity: message.equity,
          margin: message.margin,
          freeMargin: message.freeMargin,
          marginLevel: message.marginLevel,
          currency: message.currency ?? 'USD',
          leverage: message.leverage ?? null,
          at: message.at,
        };
        cache?.setSnapshot(snapshot);
        await this.options.onAccountState(message.accountId, snapshot);
        break;
      }
      case 'agent.symbols': {
        session.accounts.get(message.accountId)?.setSymbols(message.symbols);
        await this.options.onSymbols(message.accountId, message.symbols);
        break;
      }
      case 'agent.positions.snapshot': {
        session.accounts.get(message.accountId)?.setPositions(message.positions);
        await this.options.onPositions(message.accountId, message.positions, true);
        break;
      }
      case 'position.opened':
      case 'position.modified': {
        session.accounts.get(message.accountId)?.upsertPosition(message.position);
        await this.options.onPositions(message.accountId, [message.position], false);
        break;
      }
      case 'position.closed': {
        session.accounts.get(message.accountId)?.removePosition(message.position.ticket);
        await this.options.onPositions(message.accountId, [{ ...message.position, volume: 0 }], false);
        break;
      }
      case 'order.placed':
      case 'order.modified': {
        session.accounts.get(message.accountId)?.upsertPosition(message.order);
        await this.options.onPositions(message.accountId, [message.order], false);
        break;
      }
      case 'order.cancelled': {
        session.accounts.get(message.accountId)?.removePosition(message.order.ticket);
        await this.options.onPositions(message.accountId, [{ ...message.order, kind: 'pending' }], false);
        break;
      }
      case 'agent.quote': {
        session.accounts.get(message.accountId)?.setQuotes(message.quotes);
        break;
      }
      case 'closed_trade': {
        await this.options.onClosedTrade(message.accountId, message.trade);
        break;
      }
      case 'agent.log': {
        if (message.level === 'error' || message.level === 'warn') {
          await this.options.repos.engine.log({
            accountId: message.accountId,
            level: message.level,
            code: 'BROKER_REJECTED',
            message: message.message,
            context: message.context ?? null,
          });
        }
        this.options.log.debug({ accountId: message.accountId, message: message.message }, 'agent log');
        break;
      }
      case 'agent.pong':
      case 'command.result': {
        // Command results are correlated by the RemoteConnector, which owns the
        // waiter map; the hub only needs to keep the session alive.
        break;
      }
      default:
        break;
    }
  }

  private async handleHello(socket: WebSocket, hello: AgentHello, ip: string | null): Promise<void> {
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      socket.close(4406, `protocol version ${hello.protocolVersion} not supported`);
      return;
    }

    const agent = await this.options.repos.accounts.findAgentByToken(hello.agentToken);
    if (!agent) {
      socket.close(4401, 'invalid agent token');
      return;
    }

    // Only accounts that belong to (or are shared with) this agent may be served.
    const owned = await this.options.repos.accounts.listByAgent(agent.id);
    const allowed = new Map(owned.map((account) => [account.id, { accountId: account.id, login: account.login, server: account.server }]));

    const previous = this.sessionsByAgent.get(agent.id);
    if (previous) {
      try {
        previous.socket.close(4409, 'replaced by a newer connection');
      } catch {
        /* already closed */
      }
      this.detach(previous.socket);
    }

    const session: AgentSession = {
      id: randomUUID(),
      agentId: agent.id,
      userId: agent.userId,
      name: hello.name,
      version: hello.version,
      socket,
      connectedAt: Date.now(),
      lastSeenAt: Date.now(),
      queueDepth: 0,
      latencyMs: null,
      accounts: new Map(),
      connectors: new Map(),
      allowedAccounts: allowed,
    };

    for (const descriptor of hello.accounts) {
      if (!allowed.has(descriptor.accountId)) {
        this.options.log.warn(
          { agentId: agent.id, accountId: descriptor.accountId },
          'agent offered an account it is not allowed to serve; ignoring',
        );
        continue;
      }
      const cache = new AccountCache(descriptor.accountId, descriptor.platform);
      const connector = new RemoteConnector({
        accountId: descriptor.accountId,
        platform: descriptor.platform,
        label: `${descriptor.login}@${descriptor.server}`,
        transport: {
          send: (frame) => this.send(descriptor.accountId, frame),
          onMessage: (handler) => {
            const listener = (inbound: unknown) => {
              const parsed = bridgeInboundSchema.safeParse(inbound);
              if (parsed.success) handler(parsed.data);
            };
            const listeners = socket.__agentHubListeners ?? new Set();
            listeners.add(listener);
            socket.__agentHubListeners = listeners;
            return () => listeners.delete(listener);
          },
          isConnected: () => socket.readyState === WS_OPEN,
        },
        cache,
        commandTimeoutMs: this.options.commandTimeoutMs,
      });
      connector.attach();
      session.accounts.set(descriptor.accountId, cache);
      session.connectors.set(descriptor.accountId, connector);
      this.agentByAccount.set(descriptor.accountId, agent.id);
    }

    socket.__agentHubSession = session;
    this.sessionsByAgent.set(agent.id, session);

    await this.options.repos.accounts.markAgentConnected(agent.id, {
      version: hello.version,
      host: hello.host ?? null,
      ip,
    });

    socket.send(
      JSON.stringify({
        type: 'server.welcome',
        agentId: agent.id,
        protocolVersion: PROTOCOL_VERSION,
        serverTime: new Date().toISOString(),
        heartbeatIntervalMs: this.options.heartbeatIntervalMs,
        accounts: [...allowed.values()],
      } satisfies BridgeOutboundMessage),
    );

    // Reconcile: ask for fresh state so the engine is never reasoning on stale data.
    for (const accountId of session.accounts.keys()) {
      this.requestSnapshot(accountId, ['account', 'symbols', 'positions']);
    }

    this.options.onAgentStatus(agent.id, 'connected');
    this.options.log.info(
      { agentId: agent.id, version: hello.version, accounts: session.accounts.size },
      'bridge agent connected',
    );
  }

  requestSnapshot(accountId: string, include: Array<'account' | 'symbols' | 'positions'> = ['account', 'positions']): boolean {
    return this.send(accountId, {
      type: 'server.request.snapshot',
      requestId: randomUUID(),
      accountId,
      include,
    });
  }

  pingAll(): void {
    for (const session of this.sessionsByAgent.values()) {
      if (session.socket.readyState !== WS_OPEN) continue;
      try {
        session.socket.send(JSON.stringify({ type: 'server.ping', ts: new Date().toISOString() } satisfies BridgeOutboundMessage));
      } catch {
        /* close hook will clean up */
      }
    }
  }

  /** Marks agents silent for longer than `graceMs` as disconnected. */
  async reapSilent(graceMs: number): Promise<string[]> {
    const at = Date.now();
    const stale: string[] = [];
    for (const session of [...this.sessionsByAgent.values()]) {
      if (at - session.lastSeenAt <= graceMs) continue;
      stale.push(session.agentId);
      try {
        session.socket.close(4408, 'heartbeat timeout');
      } catch {
        /* already closed */
      }
      this.detach(session.socket);
    }
    for (const agentId of stale) {
      await this.options.repos.accounts.markAgentDisconnected(agentId);
      this.options.onAgentStatus(agentId, 'disconnected');
    }
    return stale;
  }

  private detach(socket: WebSocket): void {
    const session = socket.__agentHubSession;
    if (!session) return;
    socket.__agentHubSession = undefined;
    this.sessionsByAgent.delete(session.agentId);
    for (const accountId of session.accounts.keys()) {
      if (this.agentByAccount.get(accountId) === session.agentId) this.agentByAccount.delete(accountId);
    }
    for (const connector of session.connectors.values()) connector.detach();
    this.options.onAgentStatus(session.agentId, 'disconnected');
    void this.options.repos.accounts.markAgentDisconnected(session.agentId);
    this.options.log.info({ agentId: session.agentId }, 'bridge agent disconnected');
  }
}

declare module 'ws' {
  interface WebSocket {
    __agentHubSession?: AgentSession | undefined;
    __agentHubListeners?: Set<(message: unknown) => void> | undefined;
  }
}
