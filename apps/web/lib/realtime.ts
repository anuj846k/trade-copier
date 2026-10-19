'use client';

import type { RealtimeTopic, UiServerMessage } from '@trade-copier/contracts';

/**
 * Dashboard realtime contract (client half).
 *
 * The server sends `UiServerMessage` frames for the topics a client subscribed
 * to. Components register handlers by *message type* and a revision counter per
 * topic so a page can refetch its own data when something it cares about moved.
 */
export type RealtimeStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface RealtimeClient {
  readonly status: RealtimeStatus;
  readonly lastMessageAt: string | null;
  /** Subscribe to every frame, regardless of type. */
  onMessage(handler: (message: UiServerMessage) => void): () => void;
  /** Subscribe to one frame type (narrowed by the discriminant). */
  on<T extends UiServerMessage['type']>(
    type: T,
    handler: (message: Extract<UiServerMessage, { type: T }>) => void,
  ): () => void;
  /** Bumping counters used to trigger refetches. */
  revision(topic: RealtimeTopic): number;
}

export const REALTIME_TOPICS: readonly RealtimeTopic[] = [
  'accounts',
  'copiers',
  'trades',
  'logs',
  'notifications',
  'equity_protection',
];
