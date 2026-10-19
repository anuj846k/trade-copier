import { notFound } from 'next/navigation';
import { apiFetch, isApiError } from '@/lib/api';
import type { Account, CopierDetailResponse, CopierStatusResponse, CopierTrade } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { CopierDetail } from './copier-detail';

export const dynamic = 'force-dynamic';

export default async function CopierDetailPage({ params }: { params: Promise<{ copierId: string }> }) {
  const { copierId } = await params;

  let detail: CopierDetailResponse;
  try {
    detail = await apiFetch<CopierDetailResponse>(`/copiers/${copierId}`);
  } catch (error) {
    if (isApiError(error) && error.status === 404) notFound();
    throw error;
  }

  const [status, trades, accounts] = await Promise.all([
    apiFetch<CopierStatusResponse>(`/copiers/${copierId}/status`),
    apiFetch<{ trades: CopierTrade[] }>(`/copiers/${copierId}/trades?state=all&limit=100`),
    apiFetch<{ accounts: Account[] }>('/accounts'),
  ]);

  const followerAccountIds = new Set(detail.followers.map((follower) => follower.accountId));
  const candidates = accounts.accounts.filter(
    (account) => account.id !== detail.copier.masterAccountId && !followerAccountIds.has(account.id),
  );

  return (
    <>
      <PageHeader
        title={detail.copier.name}
        description={`Master: ${detail.copier.master?.label ?? 'unknown'} · ${detail.followers.length} follower(s)`}
      />
      <CopierDetail
        detail={detail}
        status={status}
        trades={trades.trades}
        candidates={candidates}
      />
    </>
  );
}
