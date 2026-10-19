import { notFound } from 'next/navigation';
import { apiFetch, isApiError } from '@/lib/api';
import type {
  AccountAnalyticsResponse,
  AccountDetailResponse,
  AccountShare,
  ClosedTradeRow,
  EquityProtectionEvent,
  SymbolListResponse,
} from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { AccountTabs } from './account-tabs';

export const dynamic = 'force-dynamic';

/**
 * Some account sub-resources legitimately do not exist yet (a follower-only
 * account has no shares, a fresh account has no snapshot history). Those are
 * `null` sections, not page failures.
 */
async function optional<T>(promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (error) {
    if (isApiError(error) && (error.status === 403 || error.status === 404 || error.status === 400)) return null;
    throw error;
  }
}

export default async function AccountDetailPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;

  let detail: AccountDetailResponse;
  try {
    detail = await apiFetch<AccountDetailResponse>(`/accounts/${accountId}`);
  } catch (error) {
    if (isApiError(error) && error.status === 404) notFound();
    throw error;
  }

  const [symbols, protection, trades, shares, analytics] = await Promise.all([
    optional(apiFetch<SymbolListResponse>(`/accounts/${accountId}/symbols?limit=200`)),
    optional(
      apiFetch<{ protection: AccountDetailResponse['equityProtection']; events: EquityProtectionEvent[] }>(
        `/accounts/${accountId}/equity-protection`,
      ),
    ),
    optional(apiFetch<{ trades: ClosedTradeRow[]; from: string; to: string }>(`/accounts/${accountId}/trades?limit=200`)),
    optional(apiFetch<{ shares: AccountShare[] }>(`/accounts/${accountId}/shares`)),
    optional(apiFetch<AccountAnalyticsResponse>(`/analytics/accounts/${accountId}`)),
  ]);

  return (
    <>
      <PageHeader title={detail.account.label} description={`${detail.account.login} · ${detail.account.server}`} />
      <AccountTabs
        detail={detail}
        symbols={symbols?.symbols ?? []}
        symbolTotal={symbols?.total ?? 0}
        protection={protection?.protection ?? null}
        protectionEvents={protection?.events ?? []}
        trades={trades?.trades ?? []}
        shares={shares?.shares ?? null}
        analytics={analytics?.analytics ?? null}
      />
    </>
  );
}
