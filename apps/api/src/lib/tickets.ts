import { randomBytes } from 'node:crypto';

/**
 * Single-use realtime tickets.
 *
 * A WebSocket handshake cannot carry custom headers from the browser, and
 * putting a long-lived access token in the query string leaks it into logs and
 * history. Instead the dashboard asks the API (over authenticated HTTPS) for a
 * ticket, then opens `/ws?ticket=...`; the ticket is consumed on first use and
 * expires in seconds.
 *
 * Single-process by design; a clustered deployment should store tickets in
 * Redis or make the ticket a signed JWT with a `jti` denylist.
 */
export interface RealtimeTicket {
  readonly ticket: string;
  readonly userId: string;
  readonly expiresAt: number;
}

export class TicketStore {
  private readonly tickets = new Map<string, RealtimeTicket>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(userId: string): RealtimeTicket {
    const ticket: RealtimeTicket = {
      ticket: randomBytes(24).toString('base64url'),
      userId,
      expiresAt: this.now() + this.ttlMs,
    };
    this.tickets.set(ticket.ticket, ticket);
    return ticket;
  }

  /** Consumes the ticket; a ticket can never be used twice. */
  consume(ticket: string): RealtimeTicket | null {
    const found = this.tickets.get(ticket);
    if (!found) return null;
    this.tickets.delete(ticket);
    if (found.expiresAt <= this.now()) return null;
    return found;
  }

  prune(): void {
    const at = this.now();
    for (const [key, ticket] of this.tickets) {
      if (ticket.expiresAt <= at) this.tickets.delete(key);
    }
  }

  get size(): number {
    return this.tickets.size;
  }
}
