import Link from 'next/link';
import { apiFetch, isApiError } from '@/lib/api';
import type { Account, AccountAnalyticsResponse } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { AnalyticsClient } from './analytics-client';

export const dynamic = 'force-dynamic';

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ accountId?: string; days?: string }> }) {
  const params = await searchParams;
  const days = Math.min(365, Math.max(1, Number(params.days ?? '30') || 30));
  const accounts = await apiFetch<{ accounts: Account[] }>('/accounts');
  const accountId = params.accountId ?? accounts.accounts.find((account) => account.role !== 'slave')?.id ?? accounts.accounts[0]?.id;

  if (!accountId) {
    return (
      <>
        <PageHeader title="Analytics" description="Win rate, expectancy, drawdown and when the strategy actually works." />
        <EmptyState
          title="No accounts to analyse"
          description="Analytics are computed per account from its closed trades and equity snapshots."
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/accounts">Add an account</Link>
            </Button>
          }
        />
      </>
    );
  }

  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  let data: AccountAnalyticsResponse | null = null;
  try {
    data = await apiFetch<AccountAnalyticsResponse>(`/analytics/accounts/${accountId}?from=${encodeURIComponent(from)}`);
  } catch (error) {
    if (!isApiError(error)) throw error;
  }

  return (
    <>
      <PageHeader
        title="Analytics"
        description="Computed from closed copied trades and equity snapshots. Followers can be filtered once a copier has more than one."
      />
      <AnalyticsClient accounts={accounts.accounts} accountId={accountId} days={days} data={data} />
    </>
  );
}
