import { apiFetch } from '@/lib/api';
import type { Account, NotificationsResponse } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { NotificationsClient } from './notifications-client';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  const [data, accounts] = await Promise.all([
    apiFetch<NotificationsResponse>('/notifications?limit=100'),
    apiFetch<{ accounts: Account[] }>('/accounts'),
  ]);

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Where the engine tells you something went wrong. A channel can be enabled for some events only, and muted per account."
      />
      <NotificationsClient data={data} accounts={accounts.accounts} />
    </>
  );
}
