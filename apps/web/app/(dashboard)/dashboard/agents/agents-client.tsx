'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Bot, Plus, Trash2 } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { titleCase } from '@/lib/format';
import type { Account, AgentsResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { EmptyState } from '@/components/empty-state';
import { StatusDot } from '@/components/status-dot';
import { Time } from '@/components/time';

export function AgentsClient({ data, accounts }: { data: AgentsResponse; accounts: Account[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const unassigned = accounts.filter((account) => !account.agentId);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">protocol v{data.protocolVersion}</Badge>
          <span>{data.agents.filter((agent) => agent.status === 'online').length} online</span>
          {unassigned.length > 0 ? <span>· {unassigned.length} account(s) without an agent</span> : null}
        </div>
        <Dialog
          open={creating}
          onOpenChange={(open) => {
            setCreating(open);
            if (!open) setIssued(null);
          }}
        >
          <DialogTrigger asChild>
            <Button size="sm">
              <Plus className="size-4" /> Create agent
            </Button>
          </DialogTrigger>
          <DialogContent>
            {issued ? (
              <div className="space-y-4">
                <DialogHeader>
                  <DialogTitle>Token for “{issued.name}”</DialogTitle>
                  <DialogDescription>This is the only time the token is shown — it is hashed at rest.</DialogDescription>
                </DialogHeader>
                <Alert variant="warning">
                  <AlertTriangle />
                  <AlertTitle>Store it now</AlertTitle>
                  <AlertDescription>
                    Paste it into the agent config (<span className="font-mono">agent.config.json</span>) or set{' '}
                    <span className="font-mono">AGENT_TOKEN</span>. Rotating means creating a new agent.
                  </AlertDescription>
                </Alert>
                <div className="flex items-center gap-2">
                  <Input readOnly value={issued.token} className="font-mono text-xs" />
                  <CopyButton value={issued.token} />
                </div>
                <DialogFooter>
                  <Button
                    onClick={() => {
                      setCreating(false);
                      setIssued(null);
                      router.refresh();
                    }}
                  >
                    Done
                  </Button>
                </DialogFooter>
              </div>
            ) : (
              <CreateAgentForm
                onCreated={(name, token) => setIssued({ name, token })}
              />
            )}
          </DialogContent>
        </Dialog>
      </div>

      {data.agents.length === 0 ? (
        <EmptyState
          icon={<Bot className="size-5" />}
          title="No bridge agent yet"
          description="An agent runs next to your trading terminals: the Expert Advisor polls its local endpoint, and it holds one outbound WebSocket to this server. No inbound port is opened."
          action={
            <Button size="sm" onClick={() => setCreating(true)}>
              Create the first agent
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {data.agents.map((agent) => (
            <Card key={agent.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="flex items-center gap-2">
                      <Bot className="size-4" /> {agent.name}
                    </CardTitle>
                    <CardDescription className="flex flex-wrap items-center gap-2">
                      <StatusDot tone={agent.status === 'online' ? 'online' : 'offline'} label={titleCase(agent.status)} />
                      {agent.version ? <Badge variant="muted">v{agent.version}</Badge> : null}
                      {agent.host ? <Badge variant="outline">{agent.host}</Badge> : null}
                    </CardDescription>
                  </div>
                  <ConfirmDialog
                    title={`Revoke ${agent.name}?`}
                    description="Its token stops working immediately and every account it serves goes offline until a new agent connects."
                    confirmLabel="Revoke agent"
                    onConfirm={async () => {
                      try {
                        await api(`/agents/${agent.id}`, { method: 'DELETE' });
                        toast.success('Agent revoked');
                        router.refresh();
                      } catch (error) {
                        const { message } = errorMessage(error);
                        toast.error(message);
                        throw error;
                      }
                    }}
                    trigger={
                      <Button variant="ghost" size="icon-sm" title="Revoke agent">
                        <Trash2 className="size-3.5" />
                      </Button>
                    }
                  />
                </div>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Last seen</span>
                  <Time value={agent.lastSeenAt} />
                </div>
                {agent.accounts.length === 0 ? (
                  <p className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
                    No account assigned. Assign one from the account page so the agent knows which terminal to serve.
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {agent.accounts.map((account) => (
                      <li key={account.id} className="flex items-center justify-between rounded-md border px-2 py-1.5 text-xs">
                        <span className="font-medium">{account.label}</span>
                        <span className="font-mono text-muted-foreground">
                          {account.login} · {account.server}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateAgentForm({ onCreated }: { onCreated: (name: string, token: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          const result = await api<{ agent: { name: string }; token: string }>('/agents', { method: 'POST', body: { name } });
          onCreated(result.agent.name, result.token);
        } catch (error) {
          const { message, hint } = errorMessage(error);
          toast.error(message, hint ? { description: hint } : undefined);
        } finally {
          setBusy(false);
        }
      }}
    >
      <DialogHeader>
        <DialogTitle>Create a bridge agent</DialogTitle>
        <DialogDescription>
          Name it after the machine or VPS it runs on — that is how you will tell them apart when one goes offline.
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="agent-name">Name</Label>
        <Input id="agent-name" required placeholder="VPS London / desk PC" value={name} onChange={(event) => setName(event.target.value)} />
      </div>
      <DialogFooter>
        <Button type="submit" disabled={busy || name.trim().length === 0}>
          {busy ? 'Creating…' : 'Create agent'}
        </Button>
      </DialogFooter>
    </form>
  );
}
