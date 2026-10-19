'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Send, Trash2 } from 'lucide-react';
import type { NotificationChannelKind } from '@trade-copier/contracts';
import { api, errorMessage } from '@/lib/client';
import { titleCase } from '@/lib/format';
import type { Account, NotificationsResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type Column } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Time } from '@/components/time';

/** Config fields each channel kind needs, so the form asks for exactly those. */
const CHANNEL_FIELDS: Record<NotificationChannelKind, Array<{ key: string; label: string; placeholder: string }>> = {
  email: [{ key: 'to', label: 'Send to', placeholder: 'you@example.com' }],
  telegram: [{ key: 'chatId', label: 'Chat ID', placeholder: '123456789' }],
  webhook: [{ key: 'url', label: 'URL', placeholder: 'https://example.com/hook' }],
  slack: [{ key: 'webhookUrl', label: 'Slack webhook URL', placeholder: 'https://hooks.slack.com/services/…' }],
  discord: [{ key: 'webhookUrl', label: 'Discord webhook URL', placeholder: 'https://discord.com/api/webhooks/…' }],
};

export function NotificationsClient({ data, accounts }: { data: NotificationsResponse; accounts: Account[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);

  return (
    <Tabs defaultValue="channels">
      <TabsList>
        <TabsTrigger value="channels">
          Channels <span className="text-xs text-muted-foreground">({data.channels.length})</span>
        </TabsTrigger>
        <TabsTrigger value="events">Subscriptions</TabsTrigger>
        <TabsTrigger value="outbox">
          Delivery <span className="text-xs text-muted-foreground">({data.notifications.length})</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="channels" className="space-y-4">
        <div className="flex justify-end">
          <Dialog open={creating} onOpenChange={setCreating}>
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" /> Add channel
              </Button>
            </DialogTrigger>
            <DialogContent>
              <CreateChannelForm
                onDone={() => {
                  setCreating(false);
                  router.refresh();
                }}
              />
            </DialogContent>
          </Dialog>
        </div>

        {data.channels.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">
              No channel yet. Add one and use <span className="font-medium">Send test</span> before relying on it.
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {data.channels.map((channel) => (
              <Card key={channel.id}>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                      {titleCase(channel.kind)}
                      {channel.hasSecret ? <Badge variant="muted">secret stored</Badge> : null}
                    </CardTitle>
                    <Switch
                      checked={channel.enabled}
                      onCheckedChange={async (checked) => {
                        try {
                          await api(`/notifications/channels/${channel.id}`, { method: 'PATCH', body: { enabled: checked } });
                          toast.success(checked ? 'Channel enabled' : 'Channel disabled');
                          router.refresh();
                        } catch (error) {
                          const { message } = errorMessage(error);
                          toast.error(message);
                        }
                      }}
                    />
                  </div>
                  <CardDescription className="font-mono text-xs">
                    {Object.entries(channel.config).map(([key, value]) => (
                      <div key={key}>
                        {key}: {String(value)}
                      </div>
                    ))}
                  </CardDescription>
                </CardHeader>
                <CardContent className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        const result = await api<{ note: string }>('/notifications/test', { method: 'POST', body: { channelId: channel.id } });
                        toast.success(result.note);
                      } catch (error) {
                        const { message, hint } = errorMessage(error);
                        toast.error(message, hint ? { description: hint } : undefined);
                      }
                    }}
                  >
                    <Send className="size-3.5" /> Send test
                  </Button>
                  <ConfirmDialog
                    title={`Delete the ${channel.kind} channel?`}
                    description="Subscriptions that pointed at it stop delivering."
                    confirmLabel="Delete channel"
                    onConfirm={async () => {
                      try {
                        await api(`/notifications/channels/${channel.id}`, { method: 'DELETE' });
                        toast.success('Channel deleted');
                        router.refresh();
                      } catch (error) {
                        const { message } = errorMessage(error);
                        toast.error(message);
                        throw error;
                      }
                    }}
                    trigger={
                      <Button variant="ghost" size="sm">
                        <Trash2 className="size-3.5" /> Delete
                      </Button>
                    }
                  />
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </TabsContent>

      <TabsContent value="events">
        {data.channels.length === 0 ? (
          <Card>
            <CardContent className="py-10 text-center text-sm text-muted-foreground">Add a channel first — subscriptions point at channels.</CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Event subscriptions</CardTitle>
              <CardDescription>
                A row is one event. Toggle a channel column to subscribe it. Errors and equity-protection triggers are the ones worth
                keeping on.
              </CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs text-muted-foreground">
                    <th className="py-2 pr-4 font-medium">Event</th>
                    {data.channels.map((channel) => (
                      <th key={channel.id} className="px-2 py-2 text-center font-medium">
                        {titleCase(channel.kind)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.availableEvents.map((event) => (
                    <tr key={event} className="border-b last:border-0">
                      <td className="py-2 pr-4">
                        <div className="font-medium">{titleCase(event)}</div>
                        <div className="font-mono text-[10px] text-muted-foreground">{event}</div>
                      </td>
                      {data.channels.map((channel) => {
                        const setting = data.settings.find((entry) => entry.channelId === channel.id && entry.event === event);
                        return (
                          <td key={channel.id} className="px-2 py-2 text-center">
                            <Switch
                              checked={setting?.enabled ?? false}
                              onCheckedChange={async (checked) => {
                                try {
                                  await api('/notifications/settings', {
                                    method: 'PUT',
                                    body: { channelId: channel.id, event, enabled: checked },
                                  });
                                  router.refresh();
                                } catch (error) {
                                  const { message } = errorMessage(error);
                                  toast.error(message);
                                }
                              }}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {accounts.length > 0 ? (
                <p className="mt-3 text-xs text-muted-foreground">
                  Per-account muting is available on the API (<span className="font-mono">accountBlocklist</span>) and applies to every
                  channel subscribed to that event.
                </p>
              ) : null}
            </CardContent>
          </Card>
        )}
      </TabsContent>

      <TabsContent value="outbox">
        <DeliveryTable rows={data.notifications} />
      </TabsContent>
    </Tabs>
  );
}

function CreateChannelForm({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<NotificationChannelKind>('email');
  const [config, setConfig] = useState<Record<string, string>>({});
  const [secret, setSecret] = useState('');

  const fields = CHANNEL_FIELDS[kind];

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await api('/notifications/channels', {
            method: 'POST',
            body: { kind, enabled: true, config, secret: secret || null },
          });
          toast.success('Channel created', { description: 'Use “Send test” to confirm delivery.' });
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
        <DialogTitle>Add a notification channel</DialogTitle>
        <DialogDescription>
          Secrets are encrypted with the same AES-256-GCM key as broker credentials and are never returned by the API.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label>Kind</Label>
        <Select
          value={kind}
          onValueChange={(value) => {
            setKind(value as NotificationChannelKind);
            setConfig({});
            setSecret('');
          }}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="email">Email</SelectItem>
            <SelectItem value="telegram">Telegram</SelectItem>
            <SelectItem value="slack">Slack</SelectItem>
            <SelectItem value="discord">Discord</SelectItem>
            <SelectItem value="webhook">Webhook</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {fields.map((field) => (
        <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`config-${field.key}`}>{field.label}</Label>
          <Input
            id={`config-${field.key}`}
            required
            placeholder={field.placeholder}
            value={config[field.key] ?? ''}
            onChange={(event) => setConfig({ ...config, [field.key]: event.target.value })}
          />
        </div>
      ))}

      {kind === 'telegram' || kind === 'webhook' ? (
        <div className="space-y-1.5">
          <Label htmlFor="channel-secret">{kind === 'telegram' ? 'Bot token' : 'Signing secret (optional)'}</Label>
          <Input id="channel-secret" type="password" autoComplete="off" value={secret} onChange={(event) => setSecret(event.target.value)} />
        </div>
      ) : null}

      <DialogFooter>
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create channel'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function DeliveryTable({ rows }: { rows: NotificationsResponse['notifications'] }) {
  const columns: Array<Column<NotificationsResponse['notifications'][number]>> = [
    { key: 'event', header: 'Event', cell: (row) => <Badge variant="secondary">{row.event}</Badge> },
    {
      key: 'status',
      header: 'Status',
      cell: (row) => (
        <Badge variant={row.status === 'sent' ? 'success' : row.status === 'dead' || row.status === 'failed' ? 'destructive' : 'muted'}>{row.status}</Badge>
      ),
    },
    { key: 'attempts', header: 'Attempts', align: 'right', cell: (row) => <span className="tabular">{row.attempts}</span> },
    {
      key: 'channel',
      header: 'Channel',
      cell: (row) => <span className="font-mono text-[10px] text-muted-foreground">{row.channelId?.slice(0, 8) ?? '—'}</span>,
    },
    { key: 'error', header: 'Last error', cell: (row) => <span className="text-xs text-destructive">{row.lastError ?? ''}</span> },
    { key: 'created', header: 'Queued', align: 'right', cell: (row) => <Time value={row.createdAt} /> },
    { key: 'sent', header: 'Sent', align: 'right', cell: (row) => <Time value={row.sentAt} /> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      emptyTitle="Nothing has been sent yet"
      emptyDescription="Queued and delivered notifications appear here with their attempt count and any provider error."
    />
  );
}
