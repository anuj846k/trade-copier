'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, RefreshCw, Search, Share2, TrendingDown, TrendingUp, Users } from 'lucide-react';
import type { AssetClass, EquityProtection, SymbolInfo } from '@trade-copier/contracts';
import { PLATFORM_LABELS } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import { money, number, percent, price, shortDate, signedMoney } from '@/lib/format';
import type { AccountAnalyticsResponse, AccountDetailResponse, AccountShare, ClosedTradeRow, EquityProtectionEvent } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DataTable, type Column } from '@/components/data-table';
import { StatCard } from '@/components/stat-card';
import { StatusDot } from '@/components/status-dot';
import { Time } from '@/components/time';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Money } from '@/components/money';

type SymbolRow = SymbolInfo & { enabled: boolean; assetClass: AssetClass };

export function AccountTabs({
  detail,
  symbols,
  symbolTotal,
  protection,
  protectionEvents,
  trades,
  shares,
  analytics,
}: {
  detail: AccountDetailResponse;
  symbols: SymbolRow[];
  symbolTotal: number;
  protection: (EquityProtection & { lastTriggeredAt?: string | null; lastTriggeredRule?: string | null }) | null;
  protectionEvents: EquityProtectionEvent[];
  trades: ClosedTradeRow[];
  shares: AccountShare[] | null;
  analytics: AccountAnalyticsResponse['analytics'] | null;
}) {
  const { account } = detail;
  const realised = trades.reduce((sum, trade) => sum + trade.profit + trade.swap + trade.commission, 0);

  return (
    <Tabs defaultValue="overview">
      <TabsList className="flex-wrap">
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="symbols">
          Symbols <span className="text-xs text-muted-foreground">({symbolTotal})</span>
        </TabsTrigger>
        <TabsTrigger value="protection">Equity protection</TabsTrigger>
        <TabsTrigger value="trades">
          Closed trades <span className="text-xs text-muted-foreground">({trades.length})</span>
        </TabsTrigger>
        {shares ? <TabsTrigger value="sharing">Sharing</TabsTrigger> : null}
      </TabsList>

      <TabsContent value="overview" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Balance" value={money(account.balance, account.currency)} hint={account.referenceBalance ? `Reference ${money(account.referenceBalance, account.currency)}` : 'No reference balance set'} />
          <StatCard label="Equity" value={money(account.equity, account.currency)} hint={account.equityUpdatedAt ? `Updated ${shortDate(account.equityUpdatedAt)}` : 'Waiting for the first snapshot'} />
          <StatCard label="Free margin" value={money(account.freeMargin, account.currency)} hint={account.marginLevel !== null ? `Margin level ${number(account.marginLevel, 1)}%` : 'Margin level unknown'} />
          <StatCard
            label="Realised (window)"
            value={signedMoney(realised, account.currency)}
            tone={realised >= 0 ? 'positive' : 'negative'}
            hint={`${trades.length} closed trade(s) in range`}
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Connection</CardTitle>
              <CardDescription>Balances and symbols arrive from the bridge agent that owns this terminal.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Platform" value={PLATFORM_LABELS[account.platform] ?? account.platform} />
              <Row label="Type" value={`${account.kind} · ${account.currency}${account.leverage ? ` · 1:${account.leverage}` : ''}`} />
              <Row label="Role" value={account.agent ? `Agent: ${account.agent.name}` : 'No agent assigned'} />
              <Row
                label="Status"
                value={<StatusDot tone={account.online ? 'online' : account.status === 'error' ? 'error' : 'offline'} label={account.online ? 'Connected' : account.status} />}
              />
              <Row label="Last heartbeat" value={<Time value={account.lastHeartbeatAt} />} />
              {account.lastErrorCode ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-xs">
                  <span className="font-mono font-medium">{account.lastErrorCode}</span>
                  {account.lastErrorMessage ? <span className="text-muted-foreground"> — {account.lastErrorMessage}</span> : null}
                </div>
              ) : null}
              <RefreshButton accountId={account.id} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Credentials</CardTitle>
              <CardDescription>
                Stored with AES-256-GCM. Only your own agent decrypts them, and only to log the terminal in.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <CredentialsForm accountId={account.id} hasPassword={detail.credentials.hasPassword} hasInvestor={detail.credentials.hasInvestorPassword} updatedAt={detail.credentials.updatedAt} />
            </CardContent>
          </Card>
        </div>

        {analytics ? (
          <Card>
            <CardHeader>
              <CardTitle>Performance snapshot</CardTitle>
              <CardDescription>Computed from closed copied trades and equity snapshots in the selected window.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Win rate" value={percent(analytics.winRate)} hint={`${analytics.tradesTaken} trades · ${number(analytics.lotsTraded, 2)} lots`} />
              <StatCard label="Profit factor" value={analytics.profitFactor === Number.POSITIVE_INFINITY ? '∞' : number(analytics.profitFactor)} hint={`Expectancy ${number(analytics.expectancy)}`} />
              <StatCard label="Max drawdown" value={money(analytics.maxDrawdown.absolute, analytics.currency)} hint={percent(analytics.maxDrawdown.percent)} tone="negative" />
              <StatCard
                label="Net profit"
                value={signedMoney(analytics.netProfit, analytics.currency)}
                tone={analytics.netProfit >= 0 ? 'positive' : 'negative'}
                hint={`Growth ${signedMoney(analytics.growth, analytics.currency)}`}
              />
            </CardContent>
          </Card>
        ) : null}
      </TabsContent>

      <TabsContent value="symbols">
        <SymbolTable accountId={account.id} symbols={symbols} total={symbolTotal} />
      </TabsContent>

      <TabsContent value="protection">
        <ProtectionPanel accountId={account.id} currency={account.currency} protection={protection} events={protectionEvents} />
      </TabsContent>

      <TabsContent value="trades">
        <TradesTable trades={trades} currency={account.currency} />
      </TabsContent>

      {shares ? (
        <TabsContent value="sharing">
          <SharingPanel accountId={account.id} shares={shares} />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </div>
  );
}

function RefreshButton({ accountId }: { accountId: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await api(`/accounts/${accountId}/refresh`, { method: 'POST' });
          toast.success('Snapshot requested');
        } catch (error) {
          const { message } = errorMessage(error);
          toast.error(message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <RefreshCw className={busy ? 'size-4 animate-spin' : 'size-4'} /> Request snapshot
    </Button>
  );
}

function CredentialsForm({ accountId, hasPassword, hasInvestor, updatedAt }: { accountId: string; hasPassword: boolean; hasInvestor: boolean; updatedAt: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [investorPassword, setInvestorPassword] = useState('');

  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api(`/accounts/${accountId}/credentials`, {
            method: 'PUT',
            body: {
              ...(password ? { password } : {}),
              ...(investorPassword ? { investorPassword } : {}),
            },
          });
          toast.success('Credentials saved');
          setPassword('');
          setInvestorPassword('');
          router.refresh();
        } catch (error) {
          const { message, hint } = errorMessage(error);
          toast.error(message, hint ? { description: hint } : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge variant={hasPassword ? 'success' : 'muted'}>
          <KeyRound className="size-3" /> {hasPassword ? 'Password on file' : 'No password'}
        </Badge>
        <Badge variant={hasInvestor ? 'success' : 'muted'}>{hasInvestor ? 'Investor password' : 'No investor password'}</Badge>
        {updatedAt ? <span>updated <Time value={updatedAt} /></span> : null}
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Master password</Label>
        <Input id="password" type="password" autoComplete="off" placeholder="Leave empty to keep the current one" value={password} onChange={(event) => setPassword(event.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="investorPassword">Investor password</Label>
        <Input id="investorPassword" type="password" autoComplete="off" placeholder="Read-only password (optional)" value={investorPassword} onChange={(event) => setInvestorPassword(event.target.value)} />
      </div>
      <Button type="submit" size="sm" disabled={busy || (!password && !investorPassword)}>
        {busy ? 'Saving…' : 'Save credentials'}
      </Button>
    </form>
  );
}

function SymbolTable({ accountId, symbols, total }: { accountId: string; symbols: SymbolRow[]; total: number }) {
  const router = useRouter();
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return needle ? symbols.filter((symbol) => symbol.name.toUpperCase().includes(needle)) : symbols;
  }, [search, symbols]);

  async function bulk(enabled: boolean) {
    setBusy(true);
    try {
      const names = filtered.map((symbol) => symbol.name);
      await api(`/accounts/${accountId}/symbols/bulk`, { method: 'POST', body: { names, enabled } });
      toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${names.length} symbol(s)`);
      router.refresh();
    } catch (error) {
      const { message } = errorMessage(error);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  const columns: Array<Column<SymbolRow>> = [
    { key: 'name', header: 'Symbol', cell: (symbol) => <span className="font-mono text-xs">{symbol.name}</span> },
    { key: 'asset', header: 'Class', cell: (symbol) => <Badge variant="outline">{symbol.assetClass}</Badge> },
    { key: 'digits', header: 'Digits', align: 'right', cell: (symbol) => <span className="tabular">{symbol.digits}</span> },
    { key: 'pip', header: 'Pip size', align: 'right', cell: (symbol) => <span className="tabular">{price(symbol.pipSize, symbol.digits)}</span> },
    { key: 'contract', header: 'Contract', align: 'right', cell: (symbol) => <span className="tabular">{number(symbol.contractSize, 0)}</span> },
    {
      key: 'lots',
      header: 'Lots',
      align: 'right',
      cell: (symbol) => (
        <span className="tabular text-xs">
          {number(symbol.minLot, 2)}–{number(symbol.maxLot, 2)} step {number(symbol.lotStep, 2)}
        </span>
      ),
    },
    { key: 'mode', header: 'Trade mode', cell: (symbol) => <Badge variant={symbol.tradeMode === 'disabled' ? 'destructive' : 'muted'}>{symbol.tradeMode}</Badge> },
    {
      key: 'enabled',
      header: 'Copied',
      align: 'right',
      cell: (symbol) => (
        <Switch
          checked={symbol.enabled}
          disabled={busy}
          onCheckedChange={async (checked) => {
            try {
              await api(`/accounts/${accountId}/symbols/${encodeURIComponent(symbol.name)}`, { method: 'PATCH', body: { enabled: checked } });
              router.refresh();
            } catch (error) {
              const { message } = errorMessage(error);
              toast.error(message);
            }
          }}
        />
      ),
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-8" placeholder="Filter symbols…" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <Button variant="outline" size="sm" disabled={busy || filtered.length === 0} onClick={() => void bulk(true)}>
          Enable shown
        </Button>
        <Button variant="outline" size="sm" disabled={busy || filtered.length === 0} onClick={() => void bulk(false)}>
          Disable shown
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {symbols.length} loaded ({total} cached on the account). Disabled symbols are never traded, even when
        the master opens them.
      </p>
      <DataTable
        columns={columns}
        rows={filtered}
        rowKey={(symbol) => symbol.name}
        emptyTitle="No symbols cached"
        emptyDescription="A bridge agent caches the instrument list the first time the terminal connects. Enable symbols to allow copying them."
      />
    </div>
  );
}

const RULES: Array<{ key: keyof ProtectionFormState; label: string; hint: string; kind: 'percent' | 'money' }> = [
  { key: 'maxDrawdownPercent', label: 'Stop copying at drawdown', hint: '% of the daily reference balance', kind: 'percent' },
  { key: 'maxDrawdownValue', label: 'Stop copying at drawdown (value)', hint: 'in account currency', kind: 'money' },
  { key: 'absoluteMinEquity', label: 'Stop below equity', hint: 'absolute equity floor', kind: 'money' },
  { key: 'maxProfitPercent', label: 'Stop at profit', hint: '% of the daily reference balance', kind: 'percent' },
  { key: 'maxProfitValue', label: 'Stop at profit (value)', hint: 'in account currency', kind: 'money' },
  { key: 'absoluteMaxEquity', label: 'Stop above equity', hint: 'absolute equity ceiling', kind: 'money' },
];

interface ProtectionFormState {
  enabled: boolean;
  resetTime: string;
  resetTimezone: string;
  maxDrawdownPercent: string;
  maxDrawdownValue: string;
  absoluteMinEquity: string;
  maxProfitPercent: string;
  maxProfitValue: string;
  absoluteMaxEquity: string;
  disableCopier: boolean;
  closeCopiedTrades: boolean;
  closeAllTrades: boolean;
  notify: boolean;
}

function toForm(protection: EquityProtection | null, timezone: string): ProtectionFormState {
  const value = (input: number | null | undefined) => (input === null || input === undefined ? '' : String(input));
  return {
    enabled: protection?.enabled ?? false,
    resetTime: protection?.resetTime ?? '00:00',
    resetTimezone: protection?.resetTimezone ?? timezone,
    maxDrawdownPercent: value(protection?.maxDrawdownPercent),
    maxDrawdownValue: value(protection?.maxDrawdownValue),
    absoluteMinEquity: value(protection?.absoluteMinEquity),
    maxProfitPercent: value(protection?.maxProfitPercent),
    maxProfitValue: value(protection?.maxProfitValue),
    absoluteMaxEquity: value(protection?.absoluteMaxEquity),
    disableCopier: protection?.disableCopier ?? true,
    closeCopiedTrades: protection?.closeCopiedTrades ?? false,
    closeAllTrades: protection?.closeAllTrades ?? false,
    notify: protection?.notify ?? true,
  };
}

function ProtectionPanel({
  accountId,
  currency,
  protection,
  events,
}: {
  accountId: string;
  currency: string;
  protection: EquityProtection | null;
  events: EquityProtectionEvent[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<ProtectionFormState>(() => toForm(protection, 'UTC'));

  const numeric = (input: string) => (input.trim() === '' ? null : Number(input));

  return (
    <div className="grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
      <Card>
        <CardHeader>
          <CardTitle>Equity protection</CardTitle>
          <CardDescription>
            Evaluated on every equity update and against the balance at the daily reset time. Rules are checked in the order shown; the
            first one that fires applies its actions.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="protection-enabled">Protection enabled</Label>
              <p className="text-xs text-muted-foreground">Disabling keeps the thresholds but stops evaluating them.</p>
            </div>
            <Switch id="protection-enabled" checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="resetTime">Daily reset time</Label>
              <Input id="resetTime" type="time" value={form.resetTime} onChange={(event) => setForm({ ...form, resetTime: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="resetTimezone">Reset timezone</Label>
              <Input id="resetTimezone" value={form.resetTimezone} onChange={(event) => setForm({ ...form, resetTimezone: event.target.value })} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {RULES.map((rule) => (
              <div key={rule.key} className="space-y-1.5">
                <Label htmlFor={rule.key}>
                  {rule.label} {rule.kind === 'percent' ? '(%)' : `(${currency})`}
                </Label>
                <Input
                  id={rule.key}
                  inputMode="decimal"
                  placeholder="off"
                  value={form[rule.key] as string}
                  onChange={(event) => setForm({ ...form, [rule.key]: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">{rule.hint}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">When a rule fires</p>
            {(
              [
                ['disableCopier', 'Stop copying for this account'],
                ['closeCopiedTrades', 'Close the copied positions'],
                ['closeAllTrades', 'Close every position on the account'],
                ['notify', 'Send a notification'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center justify-between gap-3 text-sm">
                <span>{label}</span>
                <Switch checked={form[key]} onCheckedChange={(checked) => setForm({ ...form, [key]: checked })} />
              </label>
            ))}
          </div>

          <Button
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api(`/accounts/${accountId}/equity-protection`, {
                  method: 'PUT',
                  body: {
                    enabled: form.enabled,
                    resetTime: form.resetTime,
                    resetTimezone: form.resetTimezone,
                    maxDrawdownPercent: numeric(form.maxDrawdownPercent),
                    maxDrawdownValue: numeric(form.maxDrawdownValue),
                    absoluteMinEquity: numeric(form.absoluteMinEquity),
                    maxProfitPercent: numeric(form.maxProfitPercent),
                    maxProfitValue: numeric(form.maxProfitValue),
                    absoluteMaxEquity: numeric(form.absoluteMaxEquity),
                    disableCopier: form.disableCopier,
                    closeCopiedTrades: form.closeCopiedTrades,
                    closeAllTrades: form.closeAllTrades,
                    notify: form.notify,
                  },
                });
                toast.success('Equity protection saved');
                router.refresh();
              } catch (error) {
                const { message, hint } = errorMessage(error);
                toast.error(message, hint ? { description: hint } : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Saving…' : 'Save protection'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trigger history</CardTitle>
          <CardDescription>The last 25 times a rule fired, with the observed value and threshold.</CardDescription>
        </CardHeader>
        <CardContent>
          {events.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No rule has fired yet.</p>
          ) : (
            <ul className="space-y-3">
              {events.map((event) => (
                <li key={event.id} className="rounded-md border p-3 text-sm">
                  <div className="flex items-center justify-between gap-2">
                    <Badge variant={event.kind === 'profit' ? 'success' : 'destructive'}>{event.rule}</Badge>
                    <Time value={event.createdAt} />
                  </div>
                  <div className="tabular mt-1 text-xs text-muted-foreground">
                    observed {money(event.observed, currency)} against threshold {money(event.threshold, currency)}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {event.actions.map((action) => (
                      <Badge key={action} variant="outline" className="text-[10px]">
                        {action}
                      </Badge>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function TradesTable({ trades, currency }: { trades: ClosedTradeRow[]; currency: string }) {
  const columns: Array<Column<ClosedTradeRow>> = [
    { key: 'ticket', header: 'Ticket', cell: (trade) => <span className="font-mono text-xs">{trade.ticket}</span> },
    { key: 'symbol', header: 'Symbol', cell: (trade) => <span className="font-mono text-xs">{trade.symbol}</span> },
    {
      key: 'side',
      header: 'Side',
      cell: (trade) => (
        <Badge variant={trade.side === 'buy' ? 'success' : 'destructive'}>
          {trade.side === 'buy' ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
          {trade.side}
        </Badge>
      ),
    },
    { key: 'volume', header: 'Volume', align: 'right', cell: (trade) => <span className="tabular">{number(trade.volume, 2)}</span> },
    { key: 'open', header: 'Open', align: 'right', cell: (trade) => <span className="tabular">{price(trade.openPrice, 5)}</span> },
    { key: 'close', header: 'Close', align: 'right', cell: (trade) => <span className="tabular">{price(trade.closePrice, 5)}</span> },
    { key: 'profit', header: 'Profit', align: 'right', cell: (trade) => <Money value={trade.profit + trade.swap + trade.commission} currency={currency} signed /> },
    { key: 'copied', header: 'Copied', cell: (trade) => <Badge variant={trade.followerId ? 'secondary' : 'muted'}>{trade.followerId ? 'yes' : 'manual'}</Badge> },
    { key: 'closed', header: 'Closed', align: 'right', cell: (trade) => <Time value={trade.closedAt} /> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={trades}
      rowKey={(trade) => `${trade.ticket}-${trade.closedAt}`}
      emptyTitle="No closed trades in the last 30 days"
      emptyDescription="Closed trades are pushed by the agent when the terminal reports them; the analytics page uses the same data."
    />
  );
}

function SharingPanel({ accountId, shares }: { accountId: string; shares: AccountShare[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'viewer' | 'manager' | 'copier'>('copier');

  return (
    <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
      <Card>
        <CardHeader>
          <CardTitle>Share this account</CardTitle>
          <CardDescription>
            The other person needs a Trade Copier account already. <span className="font-medium">Viewer</span> sees balances only,{' '}
            <span className="font-medium">manager</span> can also change settings, <span className="font-medium">copier</span> can use it
            as a follower.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await api(`/accounts/${accountId}/shares`, { method: 'POST', body: { email, role } });
                toast.success('Account shared');
                setEmail('');
                router.refresh();
              } catch (error) {
                const { message, hint } = errorMessage(error);
                toast.error(message, hint ? { description: hint } : undefined);
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="share-email">Their email</Label>
              <Input id="share-email" type="email" required value={email} onChange={(event) => setEmail(event.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={role} onValueChange={(value) => setRole(value as typeof role)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="viewer">Viewer</SelectItem>
                  <SelectItem value="manager">Manager</SelectItem>
                  <SelectItem value="copier">Copier</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              <Share2 className="size-4" /> {busy ? 'Sharing…' : 'Share account'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>People with access</CardTitle>
          <CardDescription>Revoking takes effect immediately.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {shares.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              <Users className="mx-auto mb-2 size-4" />
              Nobody else can see this account.
            </p>
          ) : (
            shares.map((share) => (
              <div key={share.id} className="flex items-center justify-between gap-3 rounded-md border p-3">
                <div className="min-w-0 space-y-0.5">
                  <div className="truncate font-mono text-xs">{share.granteeUserId}</div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant="secondary">{share.role}</Badge>
                    <Badge variant={share.status === 'active' ? 'success' : 'muted'}>{share.status}</Badge>
                    <span>{shortDate(share.createdAt)}</span>
                  </div>
                </div>
                <ConfirmDialog
                  title="Revoke access?"
                  description="They lose access on their next request. Copiers that depend on this account stop copying."
                  confirmLabel="Revoke"
                  onConfirm={async () => {
                    try {
                      await api(`/accounts/${accountId}/shares/${share.id}`, { method: 'DELETE' });
                      toast.success('Access revoked');
                      router.refresh();
                    } catch (error) {
                      const { message } = errorMessage(error);
                      toast.error(message);
                      throw error;
                    }
                  }}
                  trigger={
                    <Button variant="ghost" size="sm">
                      Revoke
                    </Button>
                  }
                />
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
