import Link from 'next/link';
import { Activity, ArrowRight, Users, Wallet } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import type { DashboardOverview } from '@/lib/types';
import { money } from '@/lib/format';
import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/empty-state';
import { LiveAccountList } from '@/components/overview/live-account-list';
import { LiveLogFeed } from '@/components/overview/live-log-feed';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const data = await apiFetch<DashboardOverview>('/analytics/dashboard');

  return (
    <>
      <PageHeader
        title={`Welcome back${data.user?.firstName ? `, ${data.user.firstName}` : ''}`}
        description="A snapshot of every account, copier and copied position you run."
        actions={
          <>
            <Button asChild variant="outline">
              <Link href="/dashboard/accounts">Add an account</Link>
            </Button>
            <Button asChild>
              <Link href="/dashboard/copiers">
                New copier <ArrowRight className="size-4" />
              </Link>
            </Button>
          </>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Broker accounts" value={data.totals.accounts} hint={`${data.totals.masterAccounts} usable as master`} icon={<Users className="size-3.5" />} />
        <StatCard
          label="Copiers running"
          value={`${data.totals.runningCopiers}/${data.totals.copiers}`}
          hint="Enabled copiers out of all copiers"
          icon={<Activity className="size-3.5" />}
        />
        <StatCard label="Copied positions open" value={data.totals.openCopiedTrades} hint="Follower legs currently open" />
        <StatCard
          label="Total equity"
          value={money(data.totals.totalEquity, data.totals.currency)}
          hint="Sum across accounts in their own currency"
          icon={<Wallet className="size-3.5" />}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Accounts</CardTitle>
            <CardDescription>Balances and equity update live while the bridge agent is connected.</CardDescription>
          </CardHeader>
          <CardContent>
            {data.equityByAccount.length === 0 ? (
              <EmptyState
                title="No accounts connected yet"
                description="Add a broker account, then connect it with the bridge agent to start receiving balances and symbols."
                action={
                  <Button asChild size="sm">
                    <Link href="/dashboard/accounts">Add account</Link>
                  </Button>
                }
              />
            ) : (
              <LiveAccountList initial={data.equityByAccount} />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Every decision the engine makes lands here with a reason code.</CardDescription>
          </CardHeader>
          <CardContent>
            <LiveLogFeed initial={data.recentLog} />
            <div className="mt-3 text-right">
              <Link href="/dashboard/logs" className="text-xs underline-offset-4 hover:underline">
                Open the full execution log
              </Link>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
