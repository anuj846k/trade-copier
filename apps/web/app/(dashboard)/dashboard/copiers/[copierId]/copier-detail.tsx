'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowLeftRight, Link2, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import type { CopierStatus, FollowerSettings } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import { number, price } from '@/lib/format';
import type { Account, CopierDetailResponse, CopierStatusResponse, CopierTrade, SymbolMapping } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DataTable, type Column } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatCard } from '@/components/stat-card';
import { StatusDot } from '@/components/status-dot';
import { Time } from '@/components/time';
import { FollowerSettingsForm } from '@/components/follower-settings-form';

export function CopierDetail({
  detail,
  status,
  trades,
  candidates,
}: {
  detail: CopierDetailResponse;
  status: CopierStatusResponse;
  trades: CopierTrade[];
  candidates: Account[];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const openLinks = (detail.linkStateCounts.open ?? 0) + (detail.linkStateCounts.partial ?? 0);
  const failed = (detail.linkStateCounts.failed ?? 0) + (detail.linkStateCounts.skipped ?? 0);

  return (
    <Tabs defaultValue="status">
      <div className="flex flex-wrap items-center gap-2">
        <TabsList className="flex-wrap">
          <TabsTrigger value="status">Status</TabsTrigger>
          <TabsTrigger value="followers">
            Followers <span className="text-xs text-muted-foreground">({detail.followers.length})</span>
          </TabsTrigger>
          <TabsTrigger value="trades">
            Trades <span className="text-xs text-muted-foreground">({trades.length})</span>
          </TabsTrigger>
          <TabsTrigger value="log">Log</TabsTrigger>
        </TabsList>
        <div className="ml-auto flex items-center gap-2">
          <Select
            value={detail.copier.status}
            onValueChange={async (value) => {
              setBusy(true);
              try {
                await api(`/copiers/${detail.copier.id}`, { method: 'PATCH', body: { status: value as CopierStatus } });
                toast.success('Copier status updated');
                router.refresh();
              } catch (error) {
                const { message, hint } = errorMessage(error);
                toast.error(message, hint ? { description: hint } : undefined);
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            <SelectTrigger size="sm" className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enabled">Enabled</SelectItem>
              <SelectItem value="disabled">Disabled</SelectItem>
              <SelectItem value="disabled_monitor_existing">Disabled — monitor existing</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await api<{ message: string }>(`/copiers/${detail.copier.id}/reconcile`, { method: 'POST' });
                toast.success(result.message);
              } catch (error) {
                const { message } = errorMessage(error);
                toast.error(message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw className="size-4" /> Reconcile
          </Button>
        </div>
      </div>

      <TabsContent value="status" className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Open copied positions" value={openLinks} hint={`${detail.linkStateCounts.closed ?? 0} closed links`} />
          <StatCard label="Failed / skipped" value={failed} tone={failed > 0 ? 'negative' : 'default'} hint="Entries the engine refused or could not fill" />
          <StatCard
            label="Master"
            value={status.master?.label ?? '—'}
            hint={status.master ? (status.master.online ? 'connected' : 'offline') : 'missing'}
            tone={status.master?.online ? 'positive' : 'warning'}
          />
          <StatCard label="Last reconciled" value={<Time value={detail.copier.lastReconciledAt} />} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Follower status</CardTitle>
            <CardDescription>
              Computed from the copier state, both connection lights and the follower&apos;s own enabled flag — the same reason text the
              engine used to skip a decision.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {status.followers.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No followers yet.</p>
            ) : (
              status.followers.map((follower) => (
                <div key={follower.followerId} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
                  <div className="space-y-1">
                    <div className="font-medium">{follower.label}</div>
                    <div className="flex items-center gap-2">
                      <Badge variant={follower.effectiveStatus === 'active' ? 'success' : follower.effectiveStatus === 'blocked' ? 'destructive' : 'muted'}>
                        {follower.effectiveStatus}
                      </Badge>
                      {follower.blockedReason ? <span className="text-xs text-muted-foreground">{follower.blockedReason}</span> : null}
                    </div>
                  </div>
                  <div className="text-right text-xs text-muted-foreground">
                    {follower.lastErrorCode ? <div className="font-mono text-destructive">{follower.lastErrorCode}</div> : null}
                    <Time value={follower.lastEventAt} />
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="followers" className="space-y-4">
        <div className="flex justify-end">
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" disabled={candidates.length === 0}>
                <Plus className="size-4" /> Add follower
              </Button>
            </DialogTrigger>
            <DialogContent>
              <AddFollowerForm
                copierId={detail.copier.id}
                candidates={candidates}
                onDone={() => router.refresh()}
              />
            </DialogContent>
          </Dialog>
        </div>

        {detail.followers.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              No followers yet. Adding one auto-maps every master symbol the follower can trade.
            </CardContent>
          </Card>
        ) : (
          <Accordion type="multiple" className="rounded-lg border px-4">
            {detail.followers.map((follower) => (
              <AccordionItem key={follower.followerId} value={follower.followerId}>
                <AccordionTrigger>
                  <div className="flex flex-1 flex-wrap items-center gap-3">
                    <span className="font-medium">{follower.label}</span>
                    <StatusDot tone={follower.online ? 'online' : 'offline'} label={follower.online ? 'connected' : 'offline'} />
                    <Badge variant={follower.enabled ? 'secondary' : 'muted'}>{follower.enabled ? 'copying' : 'disabled'}</Badge>
                    <Badge variant="outline">{follower.riskLabel}</Badge>
                    {follower.reverseTrade ? <Badge variant="warning">reversed</Badge> : null}
                    {follower.lastErrorCode ? <Badge variant="destructive">{follower.lastErrorCode}</Badge> : null}
                  </div>
                </AccordionTrigger>
                <AccordionContent className="space-y-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={follower.enabled}
                        onCheckedChange={async (checked) => {
                          try {
                            await api(`/copiers/${detail.copier.id}/followers/${follower.followerId}`, { method: 'PATCH', body: { enabled: checked } });
                            toast.success(checked ? 'Copying enabled' : 'Copying disabled');
                            router.refresh();
                          } catch (error) {
                            const { message } = errorMessage(error);
                            toast.error(message);
                          }
                        }}
                      />
                      Copying enabled
                    </label>
                    <ConfirmDialog
                      title={`Remove ${follower.label}?`}
                      description="This follower stops mirroring immediately. Positions already open at its broker stay open."
                      confirmLabel="Remove follower"
                      onConfirm={async () => {
                        try {
                          await api(`/copiers/${detail.copier.id}/followers/${follower.followerId}`, { method: 'DELETE' });
                          toast.success('Follower removed');
                          router.refresh();
                        } catch (error) {
                          const { message } = errorMessage(error);
                          toast.error(message);
                          throw error;
                        }
                      }}
                      trigger={
                        <Button variant="outline" size="sm">
                          <Trash2 className="size-3.5" /> Remove
                        </Button>
                      }
                    />
                  </div>

                  <Tabs defaultValue="settings">
                    <TabsList>
                      <TabsTrigger value="settings">Settings</TabsTrigger>
                      <TabsTrigger value="mappings">Symbol mapping ({follower.mappings.length})</TabsTrigger>
                      <TabsTrigger value="overrides">Overrides ({Object.keys(follower.overrides).length})</TabsTrigger>
                    </TabsList>
                    <TabsContent value="settings" className="pt-2">
                      <FollowerSettingsForm
                        copierId={detail.copier.id}
                        followerId={follower.followerId}
                        settings={follower.settings as FollowerSettings}
                        onSaved={() => router.refresh()}
                      />
                    </TabsContent>
                    <TabsContent value="mappings" className="pt-2">
                      <MappingsPanel copierId={detail.copier.id} followerId={follower.followerId} mappings={follower.mappings} onChanged={() => router.refresh()} />
                    </TabsContent>
                    <TabsContent value="overrides" className="pt-2">
                      <OverridesPanel
                        copierId={detail.copier.id}
                        followerId={follower.followerId}
                        overrides={follower.overrides as Record<string, Record<string, unknown>>}
                        baseSettings={follower.settings as FollowerSettings}
                        onChanged={() => router.refresh()}
                      />
                    </TabsContent>
                  </Tabs>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </TabsContent>

      <TabsContent value="trades">
        <TradesPanel trades={trades} />
      </TabsContent>

      <TabsContent value="log">
        <Card>
          <CardHeader>
            <CardTitle>Execution log</CardTitle>
            <CardDescription>The last 50 decisions for this copier, newest first.</CardDescription>
          </CardHeader>
          <CardContent>
            {detail.logs.rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Nothing logged yet.</p>
            ) : (
              <ul className="space-y-2">
                {detail.logs.rows.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-2 border-b pb-2 text-sm last:border-0">
                    <Badge variant={entry.level === 'error' ? 'destructive' : entry.level === 'warn' ? 'warning' : 'muted'}>{entry.level}</Badge>
                    <div className="min-w-0 flex-1">
                      <div>{entry.message}</div>
                      <div className="mt-0.5 flex items-center gap-2">
                        <Badge variant="outline" className="font-mono text-[10px]">
                          {entry.code}
                        </Badge>
                        <Time value={entry.at} />
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function AddFollowerForm({ copierId, candidates, onDone }: { copierId: string; candidates: Account[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [accountId, setAccountId] = useState(candidates[0]?.id ?? '');
  const [suffix, setSuffix] = useState('');
  const [copyExisting, setCopyExisting] = useState(false);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const result = await api<{ automap: { mapped: number; stats: { total: number }; skipped: string[] } }>(
            `/copiers/${copierId}/followers`,
            { method: 'POST', body: { accountId, suffixPreference: suffix || null, settings: { enabled: copyExisting } } },
          );
          toast.success(`Follower added — auto-mapped ${result.automap.mapped}/${result.automap.stats.total} symbols`, {
            description: result.automap.skipped.length > 0 ? `${result.automap.skipped.length} symbol(s) need a manual mapping.` : undefined,
          });
          onDone();
        } catch (error) {
          const { message, hint } = errorMessage(error);
          toast.error(message, hint ? { description: hint } : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Add a follower</DialogTitle>
        <DialogDescription>
          Symbol mapping runs immediately with the same ladder the copy path uses: exact name, then the broker&apos;s suffix/prefix, then a
          normalised match.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label>Follower account</Label>
        <Select value={accountId} onValueChange={setAccountId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick an account" />
          </SelectTrigger>
          <SelectContent>
            {candidates.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label} · {account.login}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="suffix">Broker symbol suffix (optional)</Label>
        <Input id="suffix" placeholder=".raw / m / _ecn" value={suffix} onChange={(event) => setSuffix(event.target.value)} />
        <p className="text-xs text-muted-foreground">
          Helps disambiguate brokers that list both <span className="font-mono">EURUSD</span> and{' '}
          <span className="font-mono">EURUSD.raw</span>.
        </p>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
        <span className="space-y-0.5">
          <span className="block font-medium">Start copying immediately</span>
          <span className="block text-xs text-muted-foreground">Turn off to review the mapping first.</span>
        </span>
        <Switch checked={copyExisting} onCheckedChange={setCopyExisting} />
      </label>

      <DialogFooter>
        <Button type="submit" disabled={busy || !accountId}>
          {busy ? 'Adding…' : 'Add follower'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function MappingsPanel({
  copierId,
  followerId,
  mappings,
  onChanged,
}: {
  copierId: string;
  followerId: string;
  mappings: SymbolMapping[];
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const result = await api<{ automap: { stats: { matched: number; total: number } } }>(
                `/copiers/${copierId}/followers/${followerId}/mappings/auto`,
                { method: 'POST', body: { overwrite: false } },
              );
              toast.success(`Auto-mapped ${result.automap.stats.matched}/${result.automap.stats.total}`);
              onChanged();
            } catch (error) {
              const { message } = errorMessage(error);
              toast.error(message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Zap className="size-3.5" /> Auto-map missing
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/copiers/${copierId}/followers/${followerId}/mappings`, { method: 'DELETE' });
              toast.success('All mappings deleted');
              onChanged();
            } catch (error) {
              const { message } = errorMessage(error);
              toast.error(message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Trash2 className="size-3.5" /> Delete all
        </Button>
      </div>

      <DataTable
        columns={[
          { key: 'master', header: 'Master symbol', cell: (row) => <span className="font-mono text-xs">{row.masterSymbol}</span> },
          { key: 'slave', header: 'Follower symbol', cell: (row) => <span className="font-mono text-xs">{row.slaveSymbol}</span> },
          {
            key: 'source',
            header: 'Source',
            cell: (row) => <Badge variant={row.source === 'manual' ? 'secondary' : 'muted'}>{row.source}</Badge>,
          },
          { key: 'confidence', header: 'Confidence', align: 'right', cell: (row) => <span className="tabular">{number(row.confidence * 100, 0)}%</span> },
          {
            key: 'actions',
            header: '',
            align: 'right',
            cell: (row) => (
              <Button
                variant="ghost"
                size="icon-sm"
                title="Remove mapping"
                onClick={async () => {
                  try {
                    await api(`/copiers/${copierId}/followers/${followerId}/mappings/${encodeURIComponent(row.masterSymbol)}`, { method: 'DELETE' });
                    toast.success('Mapping removed');
                    onChanged();
                  } catch (error) {
                    const { message } = errorMessage(error);
                    toast.error(message);
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            ),
          },
        ]}
        rows={mappings}
        rowKey={(row) => row.masterSymbol}
        emptyTitle="No symbols mapped"
        emptyDescription="Nothing will be copied until at least one master symbol is mapped to a symbol on this follower."
      />

      <ManualMappingForm copierId={copierId} followerId={followerId} onChanged={onChanged} />
    </div>
  );
}

function ManualMappingForm({ copierId, followerId, onChanged }: { copierId: string; followerId: string; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [masterSymbol, setMasterSymbol] = useState('');
  const [slaveSymbol, setSlaveSymbol] = useState('');

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api(`/copiers/${copierId}/followers/${followerId}/mappings`, { method: 'PUT', body: { masterSymbol, slaveSymbol } });
          toast.success('Mapping saved');
          setMasterSymbol('');
          setSlaveSymbol('');
          onChanged();
        } catch (error) {
          const { message, hint } = errorMessage(error);
          toast.error(message, hint ? { description: hint } : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="space-y-1.5">
        <Label htmlFor="master-symbol">Master symbol</Label>
        <Input id="master-symbol" required placeholder="EURUSD" value={masterSymbol} onChange={(event) => setMasterSymbol(event.target.value.toUpperCase())} />
      </div>
      <ArrowLeftRight className="mb-2.5 size-4 text-muted-foreground" />
      <div className="space-y-1.5">
        <Label htmlFor="slave-symbol">Follower symbol</Label>
        <Input id="slave-symbol" required placeholder="EURUSD.raw" value={slaveSymbol} onChange={(event) => setSlaveSymbol(event.target.value.toUpperCase())} />
      </div>
      <Button type="submit" size="sm" disabled={busy || !masterSymbol || !slaveSymbol}>
        <Link2 className="size-3.5" /> Map
      </Button>
    </form>
  );
}

function OverridesPanel({
  copierId,
  followerId,
  overrides,
  baseSettings,
  onChanged,
}: {
  copierId: string;
  followerId: string;
  overrides: Record<string, Record<string, unknown>>;
  baseSettings: FollowerSettings;
  onChanged: () => void;
}) {
  const [masterSymbol, setMasterSymbol] = useState('');
  const [riskType, setRiskType] = useState<FollowerSettings['riskType']>(baseSettings.riskType);
  const [riskValue, setRiskValue] = useState(String(baseSettings.riskValue));
  const [reverse, setReverse] = useState(baseSettings.reverseTrade);
  const [busy, setBusy] = useState(false);

  const symbols = Object.keys(overrides);

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        An override replaces individual settings for one master symbol — a smaller size on a volatile pair, or the opposite direction on a
        hedge account. Everything not overridden keeps using the follower&rsquo;s own settings.
      </p>

      <form
        className="grid gap-3 sm:grid-cols-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            await api(`/copiers/${copierId}/followers/${followerId}/overrides`, {
              method: 'PUT',
              body: {
                masterSymbol,
                settings: {
                  riskType,
                  riskValue: Number(riskValue) || 0,
                  reverseTrade: reverse,
                },
              },
            });
            toast.success(`Override saved for ${masterSymbol}`);
            setMasterSymbol('');
            onChanged();
          } catch (error) {
            const { message, hint } = errorMessage(error);
            toast.error(message, hint ? { description: hint } : undefined);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="override-symbol">Master symbol</Label>
          <Input id="override-symbol" required placeholder="XAUUSD" value={masterSymbol} onChange={(event) => setMasterSymbol(event.target.value.toUpperCase())} />
        </div>
        <div className="space-y-1.5">
          <Label>Risk model</Label>
          <Select value={riskType} onValueChange={(value) => setRiskType(value as FollowerSettings['riskType'])}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="LOT_MULTIPLIER">Lot Multiplier</SelectItem>
              <SelectItem value="FIXED_LOT">Fixed Lot</SelectItem>
              <SelectItem value="BALANCE_MULTIPLIER">Balance Multiplier</SelectItem>
              <SelectItem value="FIXED_BALANCE_MULTIPLIER">Fixed Balance Multiplier</SelectItem>
              <SelectItem value="FIXED_PERCENT_RISK">Fixed % Risk</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="override-value">Value</Label>
          <Input id="override-value" inputMode="decimal" value={riskValue} onChange={(event) => setRiskValue(event.target.value)} />
        </div>
        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 pb-2 text-sm">
            <Switch checked={reverse} onCheckedChange={setReverse} /> Reversed
          </label>
          <Button type="submit" size="sm" disabled={busy || !masterSymbol}>
            Save
          </Button>
        </div>
      </form>

      {symbols.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No per-symbol overrides yet.</p>
      ) : (
        <div className="space-y-2">
          {symbols.map((symbol) => (
            <div key={symbol} className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="space-y-1">
                <div className="font-mono text-xs font-medium">{symbol}</div>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(overrides[symbol] ?? {}).map(([key, value]) => (
                    <Badge key={key} variant="secondary" className="text-[10px]">
                      {key}: {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                    </Badge>
                  ))}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                title="Remove override"
                onClick={async () => {
                  try {
                    await api(`/copiers/${copierId}/followers/${followerId}/overrides/${encodeURIComponent(symbol)}`, { method: 'DELETE' });
                    toast.success('Override removed');
                    onChanged();
                  } catch (error) {
                    const { message } = errorMessage(error);
                    toast.error(message);
                  }
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TradesPanel({ trades }: { trades: CopierTrade[] }) {
  const columns: Array<Column<CopierTrade>> = [
    { key: 'symbol', header: 'Symbol', cell: (trade) => <span className="font-mono text-xs">{trade.symbol}</span> },
    {
      key: 'side',
      header: 'Side',
      cell: (trade) => <Badge variant={trade.side === 'buy' ? 'success' : 'destructive'}>{trade.side}</Badge>,
    },
    { key: 'volume', header: 'Master lots', align: 'right', cell: (trade) => <span className="tabular">{number(trade.volume, 2)}</span> },
    { key: 'price', header: 'Open price', align: 'right', cell: (trade) => <span className="tabular">{price(trade.openPrice, 5)}</span> },
    {
      key: 'state',
      header: 'State',
      cell: (trade) => <Badge variant={trade.state === 'open' ? 'success' : trade.state === 'closed' ? 'muted' : 'warning'}>{trade.state}</Badge>,
    },
    { key: 'opened', header: 'Opened', align: 'right', cell: (trade) => <Time value={trade.openedAt} /> },
    {
      key: 'links',
      header: 'Follower legs',
      cell: (trade) => (
        <div className="space-y-1">
          {trade.links.length === 0 ? (
            <span className="text-xs text-muted-foreground">no legs recorded</span>
          ) : (
            trade.links.map((link) => (
              <div key={`${link.followerId}-${link.slaveTicket ?? link.state}`} className="flex items-center gap-2 text-xs">
                <span className="font-medium">{link.followerLabel}</span>
                <Badge variant={link.state === 'open' ? 'success' : link.state === 'failed' || link.state === 'skipped' ? 'destructive' : 'muted'}>
                  {link.state}
                </Badge>
                {link.filledVolume !== null ? <span className="tabular">{number(link.filledVolume, 2)} lots</span> : null}
                {link.lastErrorCode ? <span className="font-mono text-destructive">{link.lastErrorCode}</span> : null}
              </div>
            ))
          )}
        </div>
      ),
    },
  ];

  return (
    <DataTable
      columns={columns}
      rows={trades}
      rowKey={(trade) => trade.ticket}
      emptyTitle="No master trades recorded"
      emptyDescription="Master trades appear as soon as the agent reports a position change on the master account."
    />
  );
}
