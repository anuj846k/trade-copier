'use client';

import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import type { FollowerSettings, TradeSide } from '@trade-copier/contracts';
import { RISK_TYPE_DESCRIPTIONS, RISK_TYPE_LABELS, riskTypeSchema, type RiskType } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';

const RISK_HINTS: Record<RiskType, string> = RISK_TYPE_DESCRIPTIONS;

/**
 * The per-follower settings editor.
 *
 * Only the fields that decide behaviour in production are surfaced as controls;
 * the rest of `FollowerSettings` is sent back untouched, so opening this form
 * can never silently reset a value the user changed elsewhere.
 */
export function FollowerSettingsForm({
  copierId,
  followerId,
  settings,
  onSaved,
  compact = false,
}: {
  copierId: string;
  followerId: string;
  settings: FollowerSettings;
  onSaved: () => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<FollowerSettings>(settings);
  const [symbolInput, setSymbolInput] = useState('');

  const patch = (changes: Partial<FollowerSettings>) => setDraft((current) => ({ ...current, ...changes }));

  async function save() {
    setBusy(true);
    try {
      // The API takes a partial settings patch, so send only the fields we edit.
      await api(`/copiers/${copierId}/followers/${followerId}`, { method: 'PATCH', body: { settings: draft } });
      toast.success('Settings saved', { description: 'New trades use the updated settings immediately.' });
      onSaved();
    } catch (error) {
      const { message, hint } = errorMessage(error);
      toast.error(message, hint ? { description: hint } : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h4 className="text-sm font-medium">Position sizing</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Risk model</Label>
            <Select value={draft.riskType} onValueChange={(value) => patch({ riskType: value as RiskType })}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {riskTypeSchema.options.map((riskType) => (
                  <SelectItem key={riskType} value={riskType}>
                    {RISK_TYPE_LABELS[riskType]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{RISK_HINTS[draft.riskType]}</p>
          </div>
          <div className="space-y-1.5">
            <Label>{draft.riskType === 'FIXED_LOT' ? 'Lots' : 'Value (%)'}</Label>
            <Input
              inputMode="decimal"
              value={String(draft.riskValue)}
              onChange={(event) => patch({ riskValue: Number(event.target.value) || 0 })}
            />
          </div>
        </div>

        {draft.riskType === 'FIXED_BALANCE_MULTIPLIER' ? (
          <div className="space-y-1.5">
            <Label>Fixed master balance</Label>
            <Input
              inputMode="decimal"
              placeholder="e.g. 100000"
              value={draft.fixedMasterBalance === null ? '' : String(draft.fixedMasterBalance)}
              onChange={(event) => patch({ fixedMasterBalance: event.target.value === '' ? null : Number(event.target.value) })}
            />
          </div>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Lot refiner</Label>
            <Input
              inputMode="decimal"
              value={String(draft.lotRefiner)}
              onChange={(event) => patch({ lotRefiner: Number(event.target.value) || 0 })}
            />
            <p className="text-xs text-muted-foreground">Added after sizing; may be negative to shave size.</p>
          </div>
          <div className="space-y-3 pt-1">
            <ToggleRow label="Force minimum lot" checked={draft.forceMinLot} onChange={(checked) => patch({ forceMinLot: checked })} />
            <ToggleRow label="Force maximum lot" checked={draft.forceMaxLot} onChange={(checked) => patch({ forceMaxLot: checked })} />
          </div>
        </div>
      </section>

      <Separator />

      <section className="space-y-3">
        <h4 className="text-sm font-medium">Direction and stops</h4>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Copied direction</Label>
            <Select
              value={draft.reverseTrade ? 'reverse' : 'same'}
              onValueChange={(value) => patch({ reverseTrade: value === 'reverse' })}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="same">Same as master</SelectItem>
                <SelectItem value="reverse">Reversed (hedge)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-3 pt-1">
            <ToggleRow label="Copy stop loss" checked={draft.copyStopLoss} onChange={(checked) => patch({ copyStopLoss: checked })} />
            <ToggleRow label="Copy take profit" checked={draft.copyTakeProfit} onChange={(checked) => patch({ copyTakeProfit: checked })} />
            <ToggleRow label="Strict close (own SL/TP only)" checked={draft.strictClose} onChange={(checked) => patch({ strictClose: checked })} />
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>Fixed stop loss (pips)</Label>
            <Input
              inputMode="decimal"
              placeholder="off"
              value={draft.fixedStopLossPips === null ? '' : String(draft.fixedStopLossPips)}
              onChange={(event) => patch({ fixedStopLossPips: event.target.value === '' ? null : Number(event.target.value) })}
            />
            <p className="text-xs text-muted-foreground">Applied only when the master trade has no stop loss.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Fixed take profit (pips)</Label>
            <Input
              inputMode="decimal"
              placeholder="off"
              value={draft.fixedTakeProfitPips === null ? '' : String(draft.fixedTakeProfitPips)}
              onChange={(event) => patch({ fixedTakeProfitPips: event.target.value === '' ? null : Number(event.target.value) })}
            />
          </div>
        </div>
      </section>

      {compact ? null : (
        <>
          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-medium">Execution tolerances</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Max slippage (pips)</Label>
                <Input
                  inputMode="decimal"
                  value={String(draft.maxSlippagePips)}
                  onChange={(event) => patch({ maxSlippagePips: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Max spread (pips)</Label>
                <Input
                  inputMode="decimal"
                  placeholder="off"
                  value={draft.maxSpreadPips === null ? '' : String(draft.maxSpreadPips)}
                  onChange={(event) => patch({ maxSpreadPips: event.target.value === '' ? null : Number(event.target.value) })}
                />
                <p className="text-xs text-muted-foreground">Trades are skipped — and logged — when the live spread is wider.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Entry delay min (ms)</Label>
                <Input
                  inputMode="numeric"
                  value={String(draft.tradeDelayMsMin)}
                  onChange={(event) => patch({ tradeDelayMsMin: Number(event.target.value) || 0 })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Entry delay max (ms)</Label>
                <Input
                  inputMode="numeric"
                  value={String(draft.tradeDelayMsMax)}
                  onChange={(event) => patch({ tradeDelayMsMax: Number(event.target.value) || 0 })}
                />
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-medium">Filters</h4>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label>Copied sides</Label>
                <Select value={draft.filters.side} onValueChange={(value) => patch({ filters: { ...draft.filters, side: value as TradeSide | 'all' } })}>
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Both sides</SelectItem>
                    <SelectItem value="buy">Buys only</SelectItem>
                    <SelectItem value="sell">Sells only</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>Lot bounds</Label>
                <div className="flex items-center gap-2">
                  <Input
                    inputMode="decimal"
                    placeholder="min"
                    value={draft.filters.lot.min === null ? '' : String(draft.filters.lot.min)}
                    onChange={(event) =>
                      patch({
                        filters: {
                          ...draft.filters,
                          lot: { ...draft.filters.lot, min: event.target.value === '' ? null : Number(event.target.value) },
                        },
                      })
                    }
                  />
                  <Input
                    inputMode="decimal"
                    placeholder="max"
                    value={draft.filters.lot.max === null ? '' : String(draft.filters.lot.max)}
                    onChange={(event) =>
                      patch({
                        filters: {
                          ...draft.filters,
                          lot: { ...draft.filters.lot, max: event.target.value === '' ? null : Number(event.target.value) },
                        },
                      })
                    }
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Magic numbers</Label>
                <Select
                  value={draft.filters.magic.mode}
                  onValueChange={(value) => patch({ filters: { ...draft.filters, magic: { ...draft.filters.magic, mode: value as 'all' | 'copy' | 'ignore' } } })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Copy every magic</SelectItem>
                    <SelectItem value="copy">Only these magics</SelectItem>
                    <SelectItem value="ignore">Ignore these magics</SelectItem>
                  </SelectContent>
                </Select>
                <TagEditor
                  values={draft.filters.magic.values.map(String)}
                  onChange={(values) => patch({ filters: { ...draft.filters, magic: { ...draft.filters.magic, values: values.map(Number).filter((value) => Number.isFinite(value)) } } })}
                  placeholder="123456"
                  input={symbolInput}
                  setInput={setSymbolInput}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Symbol filter</Label>
                <Select
                  value={draft.filters.symbol.mode}
                  onValueChange={(value) => patch({ filters: { ...draft.filters, symbol: { ...draft.filters.symbol, mode: value as 'all' | 'include' | 'exclude' } } })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Copy all symbols</SelectItem>
                    <SelectItem value="include">Only these symbols</SelectItem>
                    <SelectItem value="exclude">Skip these symbols</SelectItem>
                  </SelectContent>
                </Select>
                <TagEditor
                  values={draft.filters.symbol.values}
                  onChange={(values) => patch({ filters: { ...draft.filters, symbol: { ...draft.filters.symbol, values } } })}
                  placeholder="EURUSD"
                  input={symbolInput}
                  setInput={setSymbolInput}
                />
              </div>
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-medium">Reconciliation after a reconnect</h4>
            <p className="text-xs text-muted-foreground">
              Not documented by the reference product, so it ships conservative: mismatches are logged and orphaned links are closed, but
              nothing is reopened on the follower unless you ask for it.
            </p>
            <div className="space-y-3">
              <ToggleRow
                label="Reconcile after reconnect"
                checked={draft.reconnectPolicy.enabled}
                onChange={(checked) => patch({ reconnectPolicy: { ...draft.reconnectPolicy, enabled: checked } })}
              />
              <ToggleRow
                label="Close follower positions the master no longer has"
                checked={draft.reconnectPolicy.closeOrphans}
                onChange={(checked) => patch({ reconnectPolicy: { ...draft.reconnectPolicy, closeOrphans: checked } })}
              />
              <ToggleRow
                label="Open follower positions missing from the follower (opt-in)"
                checked={draft.reconnectPolicy.reopenMissing}
                onChange={(checked) => patch({ reconnectPolicy: { ...draft.reconnectPolicy, reopenMissing: checked } })}
              />
            </div>
          </section>
        </>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save settings'}
        </Button>
        <Badge variant="muted">{settings.riskType}</Badge>
      </div>
    </div>
  );
}

function ToggleRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} />
    </label>
  );
}

function TagEditor({
  values,
  onChange,
  placeholder,
  input,
  setInput,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder: string;
  input: string;
  setInput: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {values.map((value) => (
          <Badge key={value} variant="secondary" className="gap-1">
            {value}
            <button type="button" onClick={() => onChange(values.filter((entry) => entry !== value))} aria-label={`Remove ${value}`}>
              <X className="size-3" />
            </button>
          </Badge>
        ))}
      </div>
      <div className="flex gap-2">
        <Input
          value={input}
          placeholder={placeholder}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            const next = input.trim();
            if (next && !values.includes(next)) onChange([...values, next]);
            setInput('');
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => {
            const next = input.trim();
            if (next && !values.includes(next)) onChange([...values, next]);
            setInput('');
          }}
        >
          <Plus className="size-4" />
        </Button>
      </div>
    </div>
  );
}
