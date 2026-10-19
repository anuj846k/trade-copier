import { apiFetch } from '@/lib/api';
import type { Account, AgentsResponse } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { AgentsClient } from './agents-client';

export const dynamic = 'force-dynamic';

export default async function AgentsPage() {
  const [agents, accounts] = await Promise.all([
    apiFetch<AgentsResponse>('/agents'),
    apiFetch<{ accounts: Account[] }>('/accounts'),
  ]);

  return (
    <>
      <PageHeader title="Bridge agents" description={agents.connectHint} />
      <AgentsClient data={agents} accounts={accounts.accounts} />
    </>
  );
}
