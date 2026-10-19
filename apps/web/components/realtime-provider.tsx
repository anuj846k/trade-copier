'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RealtimeTopic, UiServerMessage } from '@trade-copier/contracts';
import { REALTIME_TOPICS, type RealtimeClient, type RealtimeStatus } from '@/lib/realtime';

/**
 * Dashboard realtime connection.
 *
 * The browser cannot put a bearer token on a WebSocket handshake, so it first
 * asks the BFF for a single-use ticket and then connects with `?ticket=…`. The
 * socket is reopened with exponential backoff; the ticket is re-issued each
 * time, because a ticket can only be redeemed once by construction.
 */
interface RealtimeContextValue extends RealtimeClient {
  reconnect(): void;
}

const RealtimeContext = createContext<RealtimeContextValue | null>(null);

const TOPIC_OF_TYPE: Record<string, RealtimeTopic> = {
  'account.status': 'accounts',
  'copier.updated': 'copiers',
  'trade.updated': 'trades',
  'log.appended': 'logs',
  'notification.queued': 'notifications',
  'equity_protection.triggered': 'equity_protection',
};

export function RealtimeProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<RealtimeStatus>('idle');
  const [lastMessageAt, setLastMessageAt] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const listeners = useRef(new Map<string, Set<(message: UiServerMessage) => void>>());
  const socket = useRef<WebSocket | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const closedByUs = useRef(false);

  const dispatch = useCallback((message: UiServerMessage) => {
    setLastMessageAt(new Date().toISOString());
    const topic = TOPIC_OF_TYPE[message.type];
    if (topic) {
      setRevisions((current) => ({ ...current, [topic]: (current[topic] ?? 0) + 1 }));
    }
    for (const handler of listeners.current.get(message.type) ?? []) handler(message);
    for (const handler of listeners.current.get('*') ?? []) handler(message);
  }, []);

  const connect = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (socket.current && socket.current.readyState <= WebSocket.OPEN) return;
    setStatus('connecting');
    try {
      const response = await fetch('/api/realtime/ticket', { method: 'POST', credentials: 'include' });
      if (!response.ok) {
        // Not signed in: stop retrying until the page is reloaded after login.
        setStatus(response.status === 401 ? 'closed' : 'connecting');
        if (response.status === 401) return;
        throw new Error(`ticket request failed with ${response.status}`);
      }
      const { wsUrl } = (await response.json()) as { wsUrl: string };
      const base = (process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/^http/, 'ws').replace(/\/$/, '');
      const url = wsUrl.startsWith('ws') ? wsUrl : `${base}${wsUrl}`;

      const ws = new WebSocket(url);
      socket.current = ws;

      ws.onopen = () => {
        attempt.current = 0;
        setStatus('open');
        ws.send(JSON.stringify({ type: 'subscribe', topics: REALTIME_TOPICS }));
      };
      ws.onmessage = (event) => {
        try {
          dispatch(JSON.parse(String(event.data)) as UiServerMessage);
        } catch {
          /* ignore malformed frames; the server validates its own output */
        }
      };
      ws.onclose = () => {
        socket.current = null;
        setStatus('closed');
        if (closedByUs.current) return;
        attempt.current += 1;
        const delay = Math.min(30_000, 1_000 * 1.8 ** Math.min(attempt.current, 6));
        retryTimer.current = setTimeout(() => void connect(), delay);
      };
      ws.onerror = () => {
        /* `onclose` handles the retry */
      };
    } catch {
      setStatus('closed');
      if (closedByUs.current) return;
      attempt.current += 1;
      retryTimer.current = setTimeout(() => void connect(), Math.min(30_000, 1_000 * 1.8 ** attempt.current));
    }
  }, [dispatch]);

  useEffect(() => {
    closedByUs.current = false;
    void connect();
    return () => {
      closedByUs.current = true;
      if (retryTimer.current) clearTimeout(retryTimer.current);
      socket.current?.close(1000, 'provider unmounted');
      socket.current = null;
    };
  }, [connect]);

  const value = useMemo<RealtimeContextValue>(
    () => ({
      status,
      lastMessageAt,
      onMessage(handler) {
        const set = listeners.current.get('*') ?? new Set();
        set.add(handler);
        listeners.current.set('*', set);
        return () => set.delete(handler);
      },
      on(type, handler) {
        const set = listeners.current.get(type) ?? new Set();
        set.add(handler as (message: UiServerMessage) => void);
        listeners.current.set(type, set);
        return () => set.delete(handler as (message: UiServerMessage) => void);
      },
      revision(topic) {
        return revisions[topic] ?? 0;
      },
      reconnect() {
        if (retryTimer.current) clearTimeout(retryTimer.current);
        socket.current?.close(1000, 'manual reconnect');
        socket.current = null;
        attempt.current = 0;
        void connect();
      },
    }),
    [connect, lastMessageAt, revisions, status],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

function useRealtimeContext(): RealtimeContextValue {
  const context = useContext(RealtimeContext);
  if (!context) throw new Error('RealtimeProvider is missing from the component tree');
  return context;
}

export function useRealtime(): RealtimeClient {
  return useRealtimeContext();
}

export function useRealtimeStatus(): RealtimeStatus {
  return useRealtimeContext().status;
}

/** Runs `handler` for one frame type; handlers are kept in a ref-safe set. */
export function useRealtimeEvent<T extends UiServerMessage['type']>(
  type: T,
  handler: (message: Extract<UiServerMessage, { type: T }>) => void,
): void {
  const context = useRealtimeContext();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(
    () =>
      context.on(type, (message) => {
        ref.current(message as Extract<UiServerMessage, { type: T }>);
      }),
    [context, type],
  );
}

/** Counter that increments whenever a frame for `topic` arrives. */
export function useTopicRevision(topic: RealtimeTopic): number {
  return useRealtimeContext().revision(topic);
}

export function RealtimeIndicator() {
  const status = useRealtimeStatus();
  const label = status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting' : 'Offline';
  const tone =
    status === 'open' ? 'bg-success' : status === 'connecting' ? 'bg-warning' : 'bg-muted-foreground';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" title={`Realtime: ${label.toLowerCase()}`}>
      <span className={`size-1.5 rounded-full ${tone}`} />
      {label}
    </span>
  );
}
