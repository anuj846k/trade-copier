'use client';

import Link from 'next/link';
import { useState } from 'react';
import { money } from '@/lib/format';
import { useRealtimeEvent } from '@/components/realtime-provider';
import { StatusDot } from '@/components/status-dot';

interface Row {
  accountId: string;
  label: string;
  currency: string;
  balance: number | null;
  equity: number | null;
  online: boolean;
}

/**
 * Balances and connection state, kept current from `account.status` frames —
 * the bridge agent pushes a snapshot as soon as the terminal reports one.
 */
export function LiveAccountList({ initial }: { initial: Row[] }) {
  const [rows, setRows] = useState(initial);

  useRealtimeEvent('account.status', (message) => {
    setRows((current) =>
      current.map((row) =>
        row.accountId === message.accountId
          ? {
              ...row,
              balance: message.balance,
              equity: message.equity,
              online: message.status === 'connected',
            }
          : row,
      ),
    );
  });

  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li key={row.accountId} className="flex items-center justify-between gap-3 py-2.5">
          <div className="min-w-0">
            <Link href={`/dashboard/accounts/${row.accountId}`} className="truncate text-sm font-medium hover:underline">
              {row.label}
            </Link>
            <StatusDot tone={row.online ? 'online' : 'offline'} label={row.online ? 'Connected' : 'Offline'} className="mt-0.5" />
          </div>
          <div className="text-right">
            <div className="tabular text-sm font-semibold">{money(row.equity ?? row.balance, row.currency)}</div>
            <div className="tabular text-xs text-muted-foreground">balance {money(row.balance, row.currency)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}
