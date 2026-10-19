'use client';

import { useEffect, useState } from 'react';
import { dateTime, relativeTime } from '@/lib/format';

/**
 * Timestamps are rendered absolute on the server and switch to a relative
 * phrase after hydration, which avoids a hydration mismatch while still giving
 * the useful "12s ago" reading.
 */
export function Time({ value, mode = 'relative' }: { value: string | Date | null | undefined; mode?: 'relative' | 'absolute' }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const absolute = dateTime(value);
  if (!mounted || mode === 'absolute') return <span className="tabular text-xs text-muted-foreground">{absolute}</span>;
  return (
    <span className="tabular text-xs text-muted-foreground" title={absolute}>
      {relativeTime(value)}
    </span>
  );
}
