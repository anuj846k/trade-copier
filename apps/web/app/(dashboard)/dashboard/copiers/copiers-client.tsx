'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CopierStatus } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import type { Account, CopierListItem } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { DataTable, type Column } from '@/components/data-table';
import { EmptyState } from '@/components/empty-state';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { StatusDot } from '@/components/status-dot';
import { Time } from '@/components/time';

const STATUS_LABELS: Record<CopierStatus, string> = {
  enabled: 'Enabled',
  disabled: 'Disabled',
  disabled_monitor_existing: 'Disabled — monitor existing',
  paused: 'Paused',
};

export function CopiersClient({ copiers, accounts }: { copiers: CopierListItem[]; accounts: Account[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const masterCandidates = accounts.filter((account) => account.role !== 'slave');

  async function setStatus(copierId: string, status: CopierStatus) {
    setBusyId(copierId);
    try {
      await api(`/copiers/${copierId}`, { method: 'PATCH', body: { status } });
      toast.success(`Copier ${STATUS_LABELS[status].toLowerCase()}`);
      router.refresh();
    } catch (error) {
      const { message, hint } = errorMessage(error);
      toast.error(message, hint ? { description: hint } : undefined);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Array<Column<CopierListItem>> = [
    {
      key: 'name',
      header: 'Copier',
      cell: ({ copier, followers }) => (
        <div className="space-y-1">
          <Link href={`/dashboard/copiers/${copier.id}`} className="font-medium hover:underline">
            {copier.name}
          </Link>
          <div className="flex items-center gap-2">
            {copier.master ? (
              <StatusDot tone={copier.master.online ? 'online' : 'offline'} label={`master ${copier.master.label}`} />
            ) : (
              <Badge variant="destructive">master missing</Badge>
            )}
          </div>
          {followers.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {followers.slice(0, 3).map((follower) => (
                <Badge key={follower.followerId} variant={follower.lastErrorCode ? 'destructive' : follower.enabled ? 'secondary' : 'muted'}>
                  {follower.label}
                </Badge>
              ))}
              {followers.length > 3 ? <Badge variant="muted">+{followers.length - 3}</Badge> : null}
            </div>
          ) : null}
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: ({ copier }) => (
        <Select value={copier.status} onValueChange={(value) => void setStatus(copier.id, value as CopierStatus)} disabled={busyId === copier.id}>
          <SelectTrigger size="sm" className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(STATUS_LABELS) as CopierStatus[]).map((status) => (
              <SelectItem key={status} value={status}>
                {STATUS_LABELS[status]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ),
    },
    {
      key: 'followers',
      header: 'Followers',
      align: 'right',
      cell: ({ followerCount, enabledFollowerCount }) => (
        <span className="tabular">
          {enabledFollowerCount}/{followerCount}
        </span>
      ),
    },
    {
      key: 'links',
      header: 'Links',
      cell: ({ linkStateCounts }) => {
        const entries = Object.entries(linkStateCounts).filter(([, count]) => count > 0);
        if (entries.length === 0) return <span className="text-xs text-muted-foreground">none</span>;
        return (
          <div className="flex flex-wrap gap-1">
            {entries.map(([state, count]) => (
              <Badge key={state} variant={state === 'open' ? 'success' : state === 'failed' || state === 'skipped' ? 'destructive' : 'muted'}>
                {state} {count}
              </Badge>
            ))}
          </div>
        );
      },
    },
    { key: 'reconciled', header: 'Reconciled', align: 'right', cell: ({ copier }) => <Time value={copier.lastReconciledAt} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: ({ copier }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            title="Reconcile now"
            disabled={busyId === copier.id}
            onClick={async () => {
              setBusyId(copier.id);
              try {
                const result = await api<{ message: string }>(`/copiers/${copier.id}/reconcile`, { method: 'POST' });
                toast.success(result.message);
              } catch (error) {
                const { message } = errorMessage(error);
                toast.error(message);
              } finally {
                setBusyId(null);
              }
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <Link href={`/dashboard/copiers/${copier.id}`}>
              Open <ArrowRight className="size-3.5" />
            </Link>
          </Button>
          <ConfirmDialog
            title={`Delete ${copier.name}?`}
            description="The copier and its follower list disappear. Positions already open at the brokers are not closed."
            confirmLabel="Delete copier"
            onConfirm={async () => {
              try {
                await api(`/copiers/${copier.id}`, { method: 'DELETE' });
                toast.success('Copier deleted');
                router.refresh();
              } catch (error) {
                const { message } = errorMessage(error);
                toast.error(message);
                throw error;
              }
            }}
            trigger={
              <Button variant="ghost" size="icon-sm" title="Delete copier">
                <Trash2 className="size-3.5" />
              </Button>
            }
          />
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Dialog open={creating} onOpenChange={setCreating}>
          <DialogTrigger asChild>
            <Button size="sm" disabled={masterCandidates.length === 0}>
              <Plus className="size-4" /> New copier
            </Button>
          </DialogTrigger>
          <DialogContent>
            <CreateCopierForm
              accounts={masterCandidates}
              onDone={() => {
                setCreating(false);
                router.refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      {masterCandidates.length === 0 ? (
        <EmptyState
          title="No account can act as a master yet"
          description="Add a broker account and make sure its role is not follower-only. Then you can pair it with followers."
          action={
            <Button asChild size="sm">
              <Link href="/dashboard/accounts">Add an account</Link>
            </Button>
          }
        />
      ) : (
        <DataTable
          columns={columns}
          rows={copiers}
          rowKey={({ copier }) => copier.id}
          emptyTitle="No copiers yet"
          emptyDescription="Create a copier, pick the master account, then add followers — each one gets its own risk model and symbol mapping."
        />
      )}
    </div>
  );
}

function CreateCopierForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [masterAccountId, setMasterAccountId] = useState(accounts[0]?.id ?? '');
  const [copyExisting, setCopyExisting] = useState(false);
  const [startEnabled, setStartEnabled] = useState(true);

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api('/copiers', {
            method: 'POST',
            body: { name, masterAccountId, copyExistingTrades: copyExisting, status: startEnabled ? 'enabled' : 'disabled' },
          });
          toast.success('Copier created', { description: 'Add followers next; symbols are auto-mapped on the way in.' });
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
        <DialogTitle>New copier</DialogTitle>
        <DialogDescription>The master account is the source of truth for symbols, sides and volumes.</DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor="copier-name">Name</Label>
        <Input id="copier-name" required placeholder="FTMO → prop accounts" value={name} onChange={(event) => setName(event.target.value)} />
      </div>

      <div className="space-y-1.5">
        <Label>Master account</Label>
        <Select value={masterAccountId} onValueChange={setMasterAccountId}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Pick an account" />
          </SelectTrigger>
          <SelectContent>
            {accounts.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.label} · {account.login} ({account.role})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
        <span className="space-y-0.5">
          <span className="block font-medium">Copy trades that are already open</span>
          <span className="block text-xs text-muted-foreground">
            Requests a fresh position snapshot from the master agent instead of waiting for the next new trade.
          </span>
        </span>
        <Switch checked={copyExisting} onCheckedChange={setCopyExisting} />
      </label>

      <label className="flex items-center justify-between gap-3 rounded-md border p-3 text-sm">
        <span className="space-y-0.5">
          <span className="block font-medium">Start enabled</span>
          <span className="block text-xs text-muted-foreground">
            Leave it off to finish configuring followers first. Enabling later requests a snapshot too.
          </span>
        </span>
        <Switch checked={startEnabled} onCheckedChange={setStartEnabled} />
      </label>

      <DialogFooter>
        <Button type="submit" disabled={busy || !masterAccountId || name.trim().length === 0}>
          {busy ? 'Creating…' : 'Create copier'}
        </Button>
      </DialogFooter>
    </form>
  );
}
