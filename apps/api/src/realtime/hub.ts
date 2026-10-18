import type { RealtimeTopic, UiServerMessage } from '@trade-copier/contracts';

/**
 * Dashboard realtime hub.
 *
 * Fan-out is per-user and per-topic: a client only ever receives messages for
 * its own account, and only for topics it subscribed to, so a busy copier
 * cannot flood an idle tab. Messages are validated by the caller (the ws route
 * parses client frames with the shared schema).
 */
export interface UiClient {
  readonly id: string;
  readonly userId: string;
  readonly socket: {
    send(data: string): void;
    close(code?: number, reason?: string): void;
  };
  topics: Set<RealtimeTopic>;
  connectedAt: number;
  lastSeenAt: number;
}

export interface UiHubStats {
  readonly clients: number;
  readonly byTopic: Record<string, number>;
}

export class UiHub {
  private readonly clients = new Map<string, UiClient>();

  constructor(private readonly now: () => number = Date.now) {}

  add(client: Omit<UiClient, 'topics' | 'connectedAt' | 'lastSeenAt'>): UiClient {
    const entry: UiClient = { ...client, topics: new Set(), connectedAt: this.now(), lastSeenAt: this.now() };
    this.clients.set(entry.id, entry);
    return entry;
  }

  remove(clientId: string): void {
    this.clients.delete(clientId);
  }

  touch(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) client.lastSeenAt = this.now();
  }

  subscribe(clientId: string, topics: readonly RealtimeTopic[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const topic of topics) client.topics.add(topic);
  }

  unsubscribe(clientId: string, topics: readonly RealtimeTopic[]): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    for (const topic of topics) client.topics.delete(topic);
  }

  /** Sends to one user's subscribed clients; returns how many sockets got it. */
  publish(userId: string, topic: RealtimeTopic, message: UiServerMessage): number {
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue;
      if (!client.topics.has(topic)) continue;
      try {
        client.socket.send(payload);
        delivered += 1;
      } catch {
        this.clients.delete(client.id);
      }
    }
    return delivered;
  }

  /** Sends an unprompted message (heartbeats, forced sign-out) to a user. */
  sendToUser(userId: string, message: UiServerMessage): number {
    const payload = JSON.stringify(message);
    let delivered = 0;
    for (const client of this.clients.values()) {
      if (client.userId !== userId) continue;
      try {
        client.socket.send(payload);
        delivered += 1;
      } catch {
        this.clients.delete(client.id);
      }
    }
    return delivered;
  }

  /** Invalidates every live socket of a user (logout, password change, 2FA change). */
  disconnectUser(userId: string, reason = 'session invalidated'): number {
    let closed = 0;
    for (const client of [...this.clients.values()]) {
      if (client.userId !== userId) continue;
      try {
        client.socket.close(4001, reason);
      } catch {
        /* already gone */
      }
      this.clients.delete(client.id);
      closed += 1;
    }
    return closed;
  }

  stats(): UiHubStats {
    const byTopic: Record<string, number> = {};
    for (const client of this.clients.values()) {
      for (const topic of client.topics) byTopic[topic] = (byTopic[topic] ?? 0) + 1;
    }
    return { clients: this.clients.size, byTopic };
  }

  /** Drops sockets that stopped answering pings. */
  reap(maxIdleMs: number): number {
    const at = this.now();
    let reaped = 0;
    for (const client of [...this.clients.values()]) {
      if (at - client.lastSeenAt > maxIdleMs) {
        try {
          client.socket.close(4000, 'idle');
        } catch {
          /* already gone */
        }
        this.clients.delete(client.id);
        reaped += 1;
      }
    }
    return reaped;
  }
}
