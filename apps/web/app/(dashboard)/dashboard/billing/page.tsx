import { apiFetch } from '@/lib/api';
import type { Plan } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { BillingClient } from './billing-client';

export const dynamic = 'force-dynamic';

interface SubscriptionResponse {
  subscription: {
    planCode: string;
    status: string;
    currentPeriodStart: string | null;
    currentPeriodEnd: string | null;
    cancelAtPeriodEnd: boolean;
  } | null;
  usage: { activeAccounts: number };
}

export default async function BillingPage() {
  const [plans, subscription] = await Promise.all([
    apiFetch<{ plans: Plan[] }>('/billing/plans'),
    apiFetch<SubscriptionResponse>('/billing/subscription'),
  ]);

  return (
    <>
      <PageHeader
        title="Plan"
        description="Plans cap how many broker accounts one user can keep active. No payment provider is wired up in this build."
      />
      <BillingClient plans={plans.plans} subscription={subscription.subscription} usage={subscription.usage} />
    </>
  );
}
