'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, RefreshCw, Trash2 } from 'lucide-react';
import { PLATFORM_LABELS, type Platform } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import { money, relativeTime } from '@/lib/format';
import type { Account, Agent } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { StatusDot } from '@/components/status-dot';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Time } from '@/components/time';

const PLATFORMS: Platform[] = ['mt5', 'mt4', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock'];

export function AccountsClient({ accounts, agents }: { accounts: Account[]; agents: Agent[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function refresh(account: Account) {
    setBusyId(account.id);
    try {
      await api(`/accounts/${account.id}/refresh`, { method: 'POST' });
      toast.success('Snapshot requested', { description: 'The agent will push the latest state on its next poll.' });
    } catch (error) {
      const { message, hint } = errorMessage(error);
      toast.error(message, hint ? { description: hint } : undefined);
    } finally {
      setBusyId(null);
    }
  }

  const columns: Array<Column<Account>> = [
    {
      key: 'label',
      header: 'Account',
      cell: (account) => (
        <div className="space-y-0.5">
          <Link href={`/dashboard/accounts/${account.id}`} className="font-medium hover:underline">
            {account.label}
          </Link>
          <div className="text-xs text-muted-foreground">
            {account.login} · {account.server}
          </div>
        </div>
      ),
    },
    { key: 'platform', header: 'Platform', cell: (account) => <Badge variant="outline">{PLATFORM_LABELS[account.platform] ?? account.platform}</Badge> },
    { key: 'kind', header: 'Type', cell: (account) => <Badge variant="secondary">{account.kind}</Badge> },
    {
      key: 'status',
      header: 'Status',
      cell: (account) => (
        <div className="space-y-0.5">
          <StatusDot tone={account.online ? 'online' : account.status === 'error' ? 'error' : 'offline'} label={account.online ? 'Connected' : account.status} />
          {account.lastErrorCode ? <div className="font-mono text-[10px] text-destructive">{account.lastErrorCode}</div> : null}
        </div>
      ),
    },
    {
      key: 'balance',
      header: 'Balance',
      align: 'right',
      cell: (account) => <span className="tabular">{money(account.balance, account.currency)}</span>,
    },
    {
      key: 'equity',
      header: 'Equity',
      align: 'right',
      cell: (account) => <span className="tabular">{money(account.equity, account.currency)}</span>,
    },
    { key: 'updated', header: 'Updated', align: 'right', cell: (account) => <Time value={account.equityUpdatedAt ?? account.lastHeartbeatAt} /> },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (account) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="icon-sm" title="Request a fresh snapshot" disabled={busyId === account.id} onClick={() => void refresh(account)}>
            <RefreshCw className={busyId === account.id ? 'size-3.5 animate-spin' : 'size-3.5'} />
          </Button>
          <ConfirmDialog
            title={`Delete ${account.label}?`}
            description="The account, its symbol cache and its copier links are removed. Open copied positions are not closed at the broker."
            confirmLabel="Delete account"
            onConfirm={async () => {
              try {
                await api(`/accounts/${account.id}`, { method: 'DELETE' });
                toast.success('Account deleted');
                router.refresh();
              } catch (error) {
                const { message, hint } = errorMessage(error);
                toast.error(message, hint ? { description: hint } : undefined);
                throw error;
              }
            }}
            trigger={
              <Button variant="ghost" size="icon-sm" title="Delete account">
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
            <Button size="sm">
              <Plus className="size-4" /> Add account
            </Button>
          </DialogTrigger>
          <DialogContent>
            <CreateAccountForm
              agents={agents}
              onDone={() => {
                setCreating(false);
                router.refresh();
              }}
            />
          </DialogContent>
        </Dialog>
      </div>

      <DataTable
        columns={columns}
        rows={accounts}
        rowKey={(account) => account.id}
        emptyTitle="No accounts yet"
        emptyDescription="Add a broker account with its login and server, then connect a bridge agent so the engine can see its symbols and positions."
      />
    </div>
  );
}

function CreateAccountForm({ agents, onDone }: { agents: Agent[]; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    label: '',
    platform: 'mt5' as Platform,
    login: '',
    server: '',
    password: '',
    kind: 'live' as 'live' | 'demo',
    role: 'both' as 'master' | 'slave' | 'both',
    agentId: 'none',
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      await api('/accounts', {
        method: 'POST',
        body: {
          label: form.label,
          platform: form.platform,
          login: form.login,
          server: form.server,
          kind: form.kind,
          role: form.role,
          ...(form.password ? { password: form.password } : {}),
          ...(form.agentId !== 'none' ? { agentId: form.agentId } : {}),
        },
      });
      toast.success('Account added', { description: 'Connect a bridge agent to pull its symbol list.' });
      onDone();
    } catch (error) {
      const { message, hint } = errorMessage(error);
      toast.error(message, hint ? { description: hint } : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <DialogHeader>
        <DialogTitle>Add a broker account</DialogTitle>
        <DialogDescription>
          Credentials are encrypted with AES-256-GCM before they are stored and are only used by your own agent.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor="label">Label</Label>
        <Input id="label" required placeholder="Prop firm — master" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Platform</Label>
          <Select value={form.platform} onValueChange={(value) => setForm({ ...form, platform: value as Platform })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map((platform) => (
                <SelectItem key={platform} value={platform}>
                  {PLATFORM_LABELS[platform] ?? platform}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Account type</Label>
          <Select value={form.kind} onValueChange={(value) => setForm({ ...form, kind: value as 'live' | 'demo' })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="live">Live</SelectItem>
              <SelectItem value="demo">Demo</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="login">Login</Label>
          <Input id="login" required value={form.login} onChange={(event) => setForm({ ...form, login: event.target.value })} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="server">Server</Label>
          <Input id="server" required placeholder="Broker-Live01" value={form.server} onChange={(event) => setForm({ ...form, server: event.target.value })} />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="role">Role</Label>
          <Select value={form.role} onValueChange={(value) => setForm({ ...form, role: value as 'master' | 'slave' | 'both' })}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="both">Master and follower</SelectItem>
              <SelectItem value="master">Master only</SelectItem>
              <SelectItem value="slave">Follower only</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="password">Password (optional)</Label>
          <Input id="password" type="password" autoComplete="off" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Bridge agent</Label>
        <Select value={form.agentId} onValueChange={(value) => setForm({ ...form, agentId: value })}>
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Assign later" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">Assign later</SelectItem>
            {agents.map((agent) => (
              <SelectItem key={agent.id} value={agent.id}>
                {agent.name} {agent.status === 'connected' ? '· online' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {agents.length === 0
            ? 'No agent yet — create one under Bridge agents after saving.'
            : `Assigned accounts are served by that agent only. Last seen ${relativeTime(agents[0]?.lastSeenAt)}.`}
        </p>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={busy}>
          {busy ? 'Adding…' : 'Add account'}
        </Button>
      </DialogFooter>
    </form>
  );
}
