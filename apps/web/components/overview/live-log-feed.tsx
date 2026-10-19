'use client';

import { useEffect, useState } from 'react';
import type { CopierLogLevel } from '@trade-copier/contracts';
import { useRealtimeEvent } from '@/components/realtime-provider';
import { LevelBadge, CodeBadge } from '@/components/code-badge';
import { Time } from '@/components/time';

interface Entry {
  id: string;
  at: string;
  level: CopierLogLevel;
  code: string;
  message: string;
}

/**
 * Live tail. Realtime entries arrive without a database id, so they get a
 * locally unique key and are capped at 20 rows: this is a glance, not the log.
 */
export function LiveLogFeed({ initial, limit = 12 }: { initial: Entry[]; limit?: number }) {
  const [entries, setEntries] = useState(initial);

  useRealtimeEvent('log.appended', (message) => {
    // The realtime frame carries the log entry as a loose record (the canonical
    // shape lives in the log DTO), so narrow it here instead of trusting it.
    const raw = message.entry as { at?: unknown; level?: unknown; code?: unknown; message?: unknown };
    const level = raw.level === 'debug' || raw.level === 'info' || raw.level === 'warn' || raw.level === 'error' ? raw.level : 'info';
    const entry: Entry = {
      id: `live-${message.at}-${typeof raw.code === 'string' ? raw.code : 'LOG'}`,
      at: typeof raw.at === 'string' ? raw.at : message.at,
      level,
      code: typeof raw.code === 'string' ? raw.code : 'LOG',
      message: typeof raw.message === 'string' ? raw.message : '',
    };
    setEntries((current) => [entry, ...current].slice(0, limit));
  });

  // Re-sync when the server sends a fresh page of entries.
  useEffect(() => setEntries(initial), [initial]);

  if (entries.length === 0) {
    return <p className="py-6 text-center text-sm text-muted-foreground">Nothing logged yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {entries.map((entry) => (
        <li key={entry.id} className="flex items-start gap-2 text-sm">
          <LevelBadge level={entry.level} />
          <div className="min-w-0 flex-1">
            <div className="truncate">{entry.message}</div>
            <div className="mt-0.5 flex items-center gap-2">
              <CodeBadge code={entry.code} />
              <Time value={entry.at} />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
