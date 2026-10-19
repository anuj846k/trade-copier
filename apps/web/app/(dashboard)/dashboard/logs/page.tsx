import { apiFetch } from '@/lib/api';
import type { Account, CopierListItem, LogPage } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { LogsClient } from './logs-client';

export const dynamic = 'force-dynamic';

interface LogsSearchParams {
  accountId?: string;
  copierId?: string;
  level?: string | string[];
  page?: string;
}

const PAGE_SIZE = 50;

export default async function LogsPage({ searchParams }: { searchParams: Promise<LogsSearchParams> }) {
  const params = await searchParams;
  const page = Math.max(1, Number(params.page ?? '1') || 1);
  const levels = params.level === undefined ? [] : Array.isArray(params.level) ? params.level : [params.level];

  const query = new URLSearchParams();
  query.set('limit', String(PAGE_SIZE));
  query.set('offset', String((page - 1) * PAGE_SIZE));
  if (params.accountId) query.set('accountId', params.accountId);
  if (params.copierId) query.set('copierId', params.copierId);
  for (const level of levels) query.append('level', level);

  const [logs, accounts, copiers] = await Promise.all([
    apiFetch<LogPage>(`/logs?${query.toString()}`),
    apiFetch<{ accounts: Account[] }>('/accounts'),
    apiFetch<{ copiers: CopierListItem[] }>('/copiers'),
  ]);

  return (
    <>
      <PageHeader
        title="Execution log"
        description="Every decision the engine made, with the reason code that explains it. This is the first place to look when a trade was not copied."
      />
      <LogsClient
        logs={logs}
        accounts={accounts.accounts}
        copiers={copiers.copiers}
        filter={{ accountId: params.accountId ?? '', copierId: params.copierId ?? '', levels }}
        page={page}
        pageSize={PAGE_SIZE}
      />
    </>
  );
}
