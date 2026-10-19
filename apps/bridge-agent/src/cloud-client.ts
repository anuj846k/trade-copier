import { WebSocket } from 'ws';
import {
  PROTOCOL_VERSION,
  bridgeOutboundSchema,
  type BridgeInboundMessage,
  type ServerCommand,
} from '@trade-copier/contracts';
import type { AgentConfig } from './config.js';
import type { EaLink } from './ea-link.js';
import type { EaLinkLogger } from './ea-link.js';

/**
 * Cloud link.
 *
 * Owns exactly one WebSocket to `/bridge/agent`, reconnects with exponential
 * backoff, heartbeats on the cadence the server declares and keeps a bounded
 * outbound queue so a short network drop does not lose state updates.
 *
 * Inbound commands are dispatched to the matching `EaLink` and answered with a
 * `command.result` carrying the same `requestId`.
 */
export interface CloudClientDeps {
  readonly config: AgentConfig;
  readonly links: readonly EaLink[];
  readonly log: EaLinkLogger;
}

export interface CloudClientStatus {
  readonly connected: boolean;
  readonly reconnects: number;
  readonly queueDepth: number;
  readonly lastMessageAt: string | null;
  readonly serverTime: string | null;
}

export class CloudClient {
  private socket: WebSocket | null = null;
  private heartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private reconnects = 0;
  private lastMessageAt: number | null = null;
  private serverTime: string | null = null;
  private readonly queue: string[] = [];
  private stopping = false;
  private readonly linksByAccount = new Map<string, EaLink>();
  private readonly allowedAccounts = new Set<string>();
  private heartbeatIntervalMs: number;

  constructor(private readonly deps: CloudClientDeps) {
    this.backoffMs = deps.config.reconnectMinMs;
    this.heartbeatIntervalMs = deps.config.heartbeatIntervalMs;
    for (const link of deps.links) this.linksByAccount.set(link.accountId, link);
  }

  start(): void {
    this.stopping = false;
    this.connect();
    this.refreshTimer = setInterval(() => {
      for (const link of this.deps.links) {
        void link.refresh().catch(() => undefined);
      }
    }, 60_000);
    this.refreshTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState === WebSocket.OPEN) {
      await new Promise<void>((resolve) => {
        socket.once('close', () => resolve());
        socket.close(1000, 'agent shutting down');
        setTimeout(resolve, 1_000).unref?.();
      });
    }
  }

  status(): CloudClientStatus {
    return {
      connected: this.socket?.readyState === WebSocket.OPEN,
      reconnects: this.reconnects,
      queueDepth: this.queue.length,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      serverTime: this.serverTime,
    };
  }

  /** Entry point used by the EA links for every protocol message. */
  send = (message: BridgeInboundMessage): void => {
    const payload = JSON.stringify(message);
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      this.enqueue(payload);
      return;
    }
    try {
      socket.send(payload);
    } catch {
      this.enqueue(payload);
    }
  };

  // --- internals -----------------------------------------------------------

  private connect(): void {
    if (this.stopping) return;
    const { serverUrl } = this.deps.config;
    this.deps.log.info('connecting to the copier server', { serverUrl });
    const socket = new WebSocket(serverUrl, {
      headers: { 'user-agent': `trade-copier-agent/${this.deps.config.version}` },
      handshakeTimeout: 15_000,
    });
    this.socket = socket;

    socket.on('open', () => {
      this.backoffMs = this.deps.config.reconnectMinMs;
      this.deps.log.info('connected to the copier server');
      this.sendHello();
      this.flushQueue();
      this.startHeartbeat();
    });

    socket.on('message', (data) => {
      this.lastMessageAt = Date.now();
      void this.onMessage(String(data));
    });

    socket.on('close', (code, reason) => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.socket === socket) this.socket = null;
      if (this.stopping) return;
      this.reconnects += 1;
      this.deps.log.warn('connection closed; reconnecting', {
        code,
        reason: reason.toString(),
        retryInMs: this.backoffMs,
      });
      this.scheduleReconnect();
    });

    socket.on('error', (error) => {
      this.deps.log.warn('websocket error', { message: error instanceof Error ? error.message : String(error) });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.deps.config.reconnectMaxMs, Math.round(this.backoffMs * 1.8));
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  private sendHello(): void {
    this.send({
      type: 'agent.hello',
      protocolVersion: PROTOCOL_VERSION,
      agentToken: this.deps.config.token,
      name: this.deps.config.name,
      version: this.deps.config.version,
      host: this.deps.config.host,
      accounts: this.deps.links.map((link) => link.descriptor()),
    });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    const tick = () => {
      this.send({
        type: 'agent.heartbeat',
        at: new Date().toISOString(),
        queueDepth: this.queue.length,
        latencyMs: this.lastMessageAt ? Date.now() - this.lastMessageAt : null,
      });
    };
    tick();
    this.heartbeat = setInterval(tick, this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  private async onMessage(raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.deps.log.warn('server sent malformed JSON');
      return;
    }
    const frame = bridgeOutboundSchema.safeParse(parsed);
    if (!frame.success) {
      this.deps.log.warn('unsupported server frame', { issues: frame.error.issues.map((issue) => issue.message).slice(0, 3) });
      return;
    }

    const message = frame.data;
    switch (message.type) {
      case 'server.welcome':
        this.serverTime = message.serverTime;
        this.heartbeatIntervalMs = message.heartbeatIntervalMs;
        this.startHeartbeat();
        this.allowedAccounts.clear();
        for (const account of message.accounts) this.allowedAccounts.add(account.accountId);
        this.deps.log.info('server welcomed the agent', {
          agentId: message.agentId,
          accounts: message.accounts.length,
          heartbeatIntervalMs: message.heartbeatIntervalMs,
        });
        break;
      case 'server.request.snapshot': {
        const link = this.linksByAccount.get(message.accountId);
        if (!link) {
          this.deps.log.warn('snapshot requested for an unknown account', { accountId: message.accountId });
          return;
        }
        await link.sendSnapshot(message.include, message.requestId);
        break;
      }
      case 'server.command':
        await this.execute(message);
        break;
      case 'server.ping':
        this.send({ type: 'agent.pong', ts: new Date().toISOString() });
        break;
    }
  }

  private async execute(command: ServerCommand): Promise<void> {
    const link = this.linksByAccount.get(command.accountId);
    if (!link) {
      this.send({
        type: 'command.result',
        requestId: command.requestId,
        status: 'error',
        ticket: null,
        filledVolume: null,
        filledPrice: null,
        closedVolume: null,
        errorCode: 'ACCOUNT_DISCONNECTED',
        errorMessage: `No terminal is configured for account ${command.accountId} on this agent`,
        latencyMs: 0,
        message: null,
      });
      return;
    }

    const result = await link.execute({
      requestId: command.requestId,
      kind: command.kind,
      params: command.params as unknown as Record<string, unknown>,
    });
    this.send(result);
    // The EA mutates state on its next poll; push a fresh snapshot promptly so
    // the server's view converges without waiting for the regular cadence.
    setTimeout(() => {
      void link.sendSnapshot(['account', 'positions'], null).catch(() => undefined);
    }, 400).unref?.();
  }

  private enqueue(payload: string): void {
    this.queue.push(payload);
    const max = this.deps.config.maxQueueDepth;
    while (this.queue.length > max) this.queue.shift();
  }

  private flushQueue(): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const pending = this.queue.splice(0, this.queue.length);
    for (const payload of pending) {
      try {
        socket.send(payload);
      } catch {
        this.enqueue(payload);
      }
    }
    if (pending.length > 0) this.deps.log.info('flushed queued messages', { count: pending.length });
  }
}
