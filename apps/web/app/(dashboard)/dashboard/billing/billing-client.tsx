'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { money, shortDate } from '@/lib/format';
import type { Plan } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { StatCard } from '@/components/stat-card';

export function BillingClient({
  plans,
  subscription,
  usage,
}: {
  plans: Plan[];
  subscription: { planCode: string; status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null;
  usage: { activeAccounts: number };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const current = plans.find((plan) => plan.code === subscription?.planCode);

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Current plan" value={current?.name ?? subscription?.planCode ?? 'Free'} hint={subscription ? `status: ${subscription.status}` : 'no subscription row'} />
        <StatCard
          label="Active accounts"
          value={usage.activeAccounts}
          hint={current ? `plan allows ${current.maxAccounts === 0 ? 'unlimited' : current.maxAccounts}` : 'plan limit unknown'}
        />
        <StatCard label="Renews" value={subscription?.currentPeriodEnd ? shortDate(subscription.currentPeriodEnd) : '—'} hint={subscription?.cancelAtPeriodEnd ? 'cancels at period end' : 'auto-renewing'} />
        <StatCard label="Billing" value="Manual" hint="no provider connected in this build" tone="warning" />
      </div>

      <Alert variant="warning">
        <AlertTitle>No payment provider is wired up</AlertTitle>
        <AlertDescription>
          Choosing a plan records the intent and marks the subscription <span className="font-mono">trialing</span>. Connecting Stripe or
          Paddle means adding the checkout call and confirming the subscription from the provider&apos;s webhook — see{' '}
          <span className="font-mono">docs/MANUAL-STEPS.md</span>.
        </AlertDescription>
      </Alert>

      <div className="grid gap-4 lg:grid-cols-3">
        {plans.map((plan) => {
          const isCurrent = subscription?.planCode === plan.code;
          return (
            <Card key={plan.code} className={isCurrent ? 'border-primary' : undefined}>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>{plan.name}</CardTitle>
                  {isCurrent ? <Badge>Current</Badge> : null}
                </div>
                <CardDescription>
                  <span className="tabular text-2xl font-semibold text-foreground">{money(plan.priceCents / 100, 'USD', { compact: true })}</span>{' '}
                  / {plan.interval}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1.5 text-sm">
                  <li className="flex items-center gap-2">
                    <Check className="size-4 text-success" />
                    {plan.maxAccounts === 0 ? 'Unlimited accounts' : `${plan.maxAccounts} active account(s)`}
                  </li>
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-2">
                      <Check className="size-4 text-success" /> {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className="w-full"
                  variant={isCurrent ? 'outline' : 'default'}
                  disabled={busy !== null || isCurrent}
                  onClick={async () => {
                    setBusy(plan.code);
                    try {
                      const result = await api<{ note: string }>('/billing/subscribe', { method: 'POST', body: { planCode: plan.code } });
                      toast.success('Plan selected', { description: result.note });
                      router.refresh();
                    } catch (error) {
                      const { message, hint } = errorMessage(error);
                      toast.error(message, hint ? { description: hint } : undefined);
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {isCurrent ? 'Current plan' : busy === plan.code ? 'Selecting…' : `Choose ${plan.name}`}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
