import { apiFetch } from '@/lib/api';
import type { Account, CopierListItem } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { CopiersClient } from './copiers-client';

export const dynamic = 'force-dynamic';

export default async function CopiersPage() {
  const [copiers, accounts] = await Promise.all([
    apiFetch<{ copiers: CopierListItem[] }>('/copiers'),
    apiFetch<{ accounts: Account[] }>('/accounts'),
  ]);

  return (
    <>
      <PageHeader
        title="Copiers"
        description="A copier pairs one master account with the follower accounts that mirror it. Each follower sizes and filters independently."
      />
      <CopiersClient copiers={copiers.copiers} accounts={accounts.accounts} />
    </>
  );
}
