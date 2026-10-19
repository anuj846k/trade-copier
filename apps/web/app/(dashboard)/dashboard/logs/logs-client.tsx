'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Download, Filter, Search, X } from 'lucide-react';
import type { CopierLogLevel } from '@trade-copier/contracts';
import type { Account, CopierListItem, LogPage } from '@/lib/types';
import { titleCase } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CodeBadge, LevelBadge } from '@/components/code-badge';
import { EmptyState } from '@/components/empty-state';
import { Time } from '@/components/time';

const LEVELS: CopierLogLevel[] = ['debug', 'info', 'warn', 'error'];

/**
 * Filters live in the URL, so a view is shareable and the back button works.
 * The rows themselves come from the server component, which keeps pagination
 * honest against the API's own `total`.
 */
export function LogsClient({
  logs,
  accounts,
  copiers,
  filter,
  page,
  pageSize,
}: {
  logs: LogPage;
  accounts: Account[];
  copiers: CopierListItem[];
  filter: { accountId: string; copierId: string; levels: string[] };
  page: number;
  pageSize: number;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string | null>(null);

  const rows = useMemo(() => {
    const needle = search.trim().toUpperCase();
    if (!needle) return logs.entries;
    return logs.entries.filter((entry) => entry.message.toUpperCase().includes(needle) || entry.code.includes(needle));
  }, [logs.entries, search]);

  const totalPages = Math.max(1, Math.ceil(logs.total / pageSize));

  function update(changes: Record<string, string | string[] | null>) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      next.delete(key);
      if (value === null) continue;
      if (Array.isArray(value)) for (const entry of value) next.append(key, entry);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    router.push(`/dashboard/logs?${next.toString()}`);
  }

  const exportQuery = new URLSearchParams();
  if (filter.accountId) exportQuery.set('accountId', filter.accountId);
  if (filter.copierId) exportQuery.set('copierId', filter.copierId);
  for (const level of filter.levels) exportQuery.append('level', level);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label>Account</Label>
              <Select value={filter.accountId || 'all'} onValueChange={(value) => update({ accountId: value === 'all' ? null : value })}>
                <SelectTrigger size="sm" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {account.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Copier</Label>
              <Select value={filter.copierId || 'all'} onValueChange={(value) => update({ copierId: value === 'all' ? null : value })}>
                <SelectTrigger size="sm" className="w-52">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All copiers</SelectItem>
                  {copiers.map(({ copier }) => (
                    <SelectItem key={copier.id} value={copier.id}>
                      {copier.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="relative min-w-56 flex-1">
              <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-8" placeholder="Search this page of results…" value={search} onChange={(event) => setSearch(event.target.value)} />
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href={`/api/proxy/logs/export${exportQuery.size > 0 ? `?${exportQuery.toString()}` : ''}`}>
                <Download className="size-4" /> Export CSV
              </a>
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Filter className="size-3.5 text-muted-foreground" />
            {LEVELS.map((level) => {
              const active = filter.levels.includes(level);
              return (
                <Button
                  key={level}
                  type="button"
                  variant={active ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => update({ level: active ? filter.levels.filter((entry) => entry !== level) : [...filter.levels, level] })}
                >
                  {titleCase(level)}
                </Button>
              );
            })}
            {filter.levels.length > 0 || filter.accountId || filter.copierId ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => router.push('/dashboard/logs')}>
                <X className="size-3.5" /> Clear
              </Button>
            ) : null}
            <span className="ml-auto text-xs text-muted-foreground">
              {logs.total} entr{logs.total === 1 ? 'y' : 'ies'} matched
            </span>
          </div>
        </CardContent>
      </Card>

      {rows.length === 0 ? (
        <EmptyState
          title="No log entries for these filters"
          description="The engine logs a decision whenever it copies, skips or fails a trade. Widening the filters usually surfaces it."
        />
      ) : (
        <Card>
          <CardContent className="divide-y">
            {rows.map((entry) => (
              <div key={entry.id} className="py-2.5">
                <button
                  type="button"
                  className="flex w-full items-start gap-3 text-left"
                  onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}
                >
                  <LevelBadge level={entry.level} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm">{entry.message}</div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <CodeBadge code={entry.code} />
                      <Time value={entry.at} />
                      {entry.copierId ? <span className="text-xs text-muted-foreground">copier {entry.copierId.slice(0, 8)}</span> : null}
                      {entry.followerId ? <span className="text-xs text-muted-foreground">follower {entry.followerId.slice(0, 8)}</span> : null}
                    </div>
                  </div>
                </button>
                {expanded === entry.id && entry.context ? (
                  <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[11px]">
                    {JSON.stringify(entry.context, null, 2)}
                  </pre>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          Page {page} of {totalPages}
        </span>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>
            Newer
          </Button>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) })}>
            Older
          </Button>
        </div>
      </div>
    </div>
  );
}
