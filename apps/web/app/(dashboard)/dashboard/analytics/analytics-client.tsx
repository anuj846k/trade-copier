'use client';

import { useRouter } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { StatCard } from '@/components/stat-card';
import { Badge } from '@/components/ui/badge';
import { AreaChart } from '@/components/charts/area-chart';
import { Heatmap, type HeatmapCell } from '@/components/charts/heatmap';
import { money, number, percent, price, signedMoney } from '@/lib/format';
import type { Account, AccountAnalyticsResponse } from '@/lib/types';

type OpenPosition = AccountAnalyticsResponse['openPositions'][number];

const RANGES = [
  { days: 7, label: 'Last 7 days' },
  { days: 30, label: 'Last 30 days' },
  { days: 90, label: 'Last 90 days' },
  { days: 365, label: 'Last 12 months' },
];

export function AnalyticsClient({
  accounts,
  accountId,
  days,
  data,
}: {
  accounts: Account[];
  accountId: string;
  days: number;
  data: AccountAnalyticsResponse | null;
}) {
  const router = useRouter();

  function navigate(changes: { accountId?: string; days?: string }) {
    const next = new URLSearchParams({ accountId, days: String(days), ...changes });
    router.push(`/dashboard/analytics?${next.toString()}`);
  }

  const analytics = data?.analytics ?? null;
  const openPositions = data?.openPositions ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label>Account</Label>
          <Select value={accountId} onValueChange={(value) => navigate({ accountId: value })}>
            <SelectTrigger size="sm" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {account.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Range</Label>
          <Select value={String(days)} onValueChange={(value) => navigate({ days: value })}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGES.map((range) => (
                <SelectItem key={range.days} value={String(range.days)}>
                  {range.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {analytics ? (
          <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>{analytics.openPositions} position(s) open</span>
            <Badge variant="secondary">{analytics.currency}</Badge>
          </div>
        ) : null}
      </div>

      {!analytics ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            No analytics for this account yet — the first equity snapshot arrives a few minutes after the agent connects.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label="Net profit"
              value={signedMoney(analytics.netProfit, analytics.currency)}
              tone={analytics.netProfit >= 0 ? 'positive' : 'negative'}
              hint={`Growth ${percent(analytics.growthPercent)} on ${money(analytics.balance, analytics.currency)}`}
            />
            <StatCard label="Win rate" value={percent(analytics.winRate)} hint={`${analytics.tradesTaken} trades · ${number(analytics.lotsTraded, 2)} lots`} />
            <StatCard
              label="Profit factor"
              value={analytics.profitFactor === Number.POSITIVE_INFINITY ? '∞' : number(analytics.profitFactor)}
              hint={`Expectancy ${number(analytics.expectancy)} per trade`}
              tone={analytics.profitFactor >= 1 ? 'positive' : 'negative'}
            />
            <StatCard
              label="Max drawdown"
              value={money(analytics.maxDrawdown.absolute, analytics.currency)}
              hint={percent(analytics.maxDrawdown.percent)}
              tone="negative"
            />
            <StatCard label="Best trade" value={signedMoney(analytics.bestTrade.profit, analytics.currency)} hint={percent(analytics.bestTrade.percent)} tone="positive" />
            <StatCard label="Worst trade" value={signedMoney(analytics.worstTrade.profit, analytics.currency)} hint={percent(analytics.worstTrade.percent)} tone="negative" />
            <StatCard label="Average win" value={percent(analytics.averageWinPercent)} hint="relative to balance" tone="positive" />
            <StatCard label="Average loss" value={percent(analytics.averageLossPercent)} hint="relative to balance" tone="negative" />
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Equity curve</CardTitle>
              <CardDescription>
                Snapshots taken on the engine&apos;s own cadence. Empty stretches mean the account was not connected, not that the balance
                did not move.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <AreaChart
                points={analytics.equitySeries.map((point) => ({ at: point.at, value: point.equity }))}
                formatValue={(value) => money(value, analytics.currency, { compact: true })}
                formatTime={(value) => new Date(value).toLocaleDateString()}
                label={`Equity curve for the last ${days} days`}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>When the strategy works</CardTitle>
                <CardDescription>Realised profit per weekday and hour, in the account&apos;s own timezone.</CardDescription>
              </CardHeader>
              <CardContent>
                <Heatmap cells={analytics.heatmap as HeatmapCell[]} formatValue={(value) => money(value, analytics.currency)} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Open positions</CardTitle>
                <CardDescription>Live floating profit as the agent last reported it.</CardDescription>
              </CardHeader>
              <CardContent>
                {openPositions.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    No positions open. They appear here as soon as the master or a follower has one.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {openPositions.map((position: OpenPosition) => (
                      <li key={position.ticket} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-medium">{position.symbol}</span>
                          <Badge variant={position.side === 'buy' ? 'success' : 'destructive'}>{position.side}</Badge>
                        </div>
                        <div className="flex items-center gap-4 text-xs">
                          <span className="tabular text-muted-foreground">{number(position.volume, 2)} lots @ {price(position.openPrice, 5)}</span>
                          <span className={`tabular font-medium ${(position.profit ?? 0) >= 0 ? 'text-success' : 'text-destructive'}`}>
                            {signedMoney(position.profit, analytics.currency)}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
