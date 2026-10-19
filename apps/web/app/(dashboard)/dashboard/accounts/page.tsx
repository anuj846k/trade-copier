import { apiFetch } from '@/lib/api';
import type { Account, AgentsResponse } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { AccountsClient } from './accounts-client';

export const dynamic = 'force-dynamic';

export default async function AccountsPage() {
  const [accounts, agents] = await Promise.all([
    apiFetch<{ accounts: Account[] }>('/accounts'),
    apiFetch<AgentsResponse>('/agents'),
  ]);

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Every broker account you can trade from or copy to. Balances and symbols arrive once a bridge agent is connected."
      />
      <AccountsClient accounts={accounts.accounts} agents={agents.agents} />
    </>
  );
}
