'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import { api, errorMessage } from '@/lib/client';
import { duration, number, titleCase } from '@/lib/format';
import type { AuditEntry, Diagnostics, Session } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type Column } from '@/components/data-table';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CopyButton } from '@/components/copy-button';
import { StatCard } from '@/components/stat-card';
import { Time } from '@/components/time';

export function SettingsClient({ session, audit, diagnostics }: { session: Session; audit: AuditEntry[]; diagnostics: Diagnostics }) {
  return (
    <Tabs defaultValue="profile">
      <TabsList className="flex-wrap">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="security">Security</TabsTrigger>
        <TabsTrigger value="audit">Audit log</TabsTrigger>
        <TabsTrigger value="system">System</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <ProfileForm session={session} />
      </TabsContent>
      <TabsContent value="security">
        <SecurityPanel session={session} />
      </TabsContent>
      <TabsContent value="audit">
        <AuditTable entries={audit} />
      </TabsContent>
      <TabsContent value="system">
        <SystemPanel diagnostics={diagnostics} />
      </TabsContent>
    </Tabs>
  );
}

function ProfileForm({ session }: { session: Session }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    firstName: session.user.firstName,
    lastName: session.user.lastName ?? '',
    timezone: session.user.timezone,
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>The timezone decides trading-hour windows, daily resets and the analytics heatmap.</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await api('/auth/me', {
                  method: 'PATCH',
                  body: { firstName: form.firstName, ...(form.lastName ? { lastName: form.lastName } : {}), timezone: form.timezone },
                });
                toast.success('Profile updated');
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
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone (IANA)</Label>
              <Input id="timezone" required value={form.timezone} onChange={(event) => setForm({ ...form, timezone: event.target.value })} />
            </div>
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save profile'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
          <CardDescription>Read-only facts about this account.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Email</span>
            <span className="font-medium">{session.user.email}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Role</span>
            <Badge variant={session.user.role === 'admin' ? 'default' : 'secondary'}>{session.user.role}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Two-factor</span>
            <Badge variant={session.user.totpEnabled ? 'success' : 'warning'}>{session.user.totpEnabled ? 'enabled' : 'not enabled'}</Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Plan</span>
            <span className="font-medium">{session.subscription?.planCode ?? 'free'}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Usage</span>
            <span className="font-medium">
              {session.usage.accounts} account(s) · {session.usage.copiers} copier(s)
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Member since</span>
            <Time value={session.user.createdAt} mode="absolute" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function SecurityPanel({ session }: { session: Session }) {
  const router = useRouter();
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwords, setPasswords] = useState({ currentPassword: '', newPassword: '' });
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [twoFactorBusy, setTwoFactorBusy] = useState(false);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>
            Changing the password signs out every device, including this one — that is deliberate, so nobody keeps a session on an old
            credential.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              setPasswordBusy(true);
              try {
                const result = await api<{ message: string }>('/auth/password', { method: 'POST', body: passwords });
                toast.success(result.message);
                router.replace('/login');
                router.refresh();
              } catch (error) {
                const { message, hint } = errorMessage(error);
                toast.error(message, hint ? { description: hint } : undefined);
              } finally {
                setPasswordBusy(false);
              }
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="currentPassword">Current password</Label>
              <Input id="currentPassword" type="password" autoComplete="current-password" required value={passwords.currentPassword} onChange={(event) => setPasswords({ ...passwords, currentPassword: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="newPassword">New password</Label>
              <Input id="newPassword" type="password" autoComplete="new-password" required minLength={10} value={passwords.newPassword} onChange={(event) => setPasswords({ ...passwords, newPassword: event.target.value })} />
              <p className="text-xs text-muted-foreground">At least 10 characters; common and breached passwords are rejected.</p>
            </div>
            <Button type="submit" size="sm" disabled={passwordBusy}>
              <KeyRound className="size-3.5" /> {passwordBusy ? 'Changing…' : 'Change password'}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>A TOTP code from any authenticator app is asked for at sign-in once enabled.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {session.user.totpEnabled ? (
            <>
              <Alert>
                <ShieldCheck />
                <AlertTitle>Enabled</AlertTitle>
                <AlertDescription>Enter a current code to turn it off. Disabling asks for nothing else.</AlertDescription>
              </Alert>
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="disable-code">Code</Label>
                  <Input id="disable-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={twoFactorBusy || code.length !== 6}
                  onClick={async () => {
                    setTwoFactorBusy(true);
                    try {
                      await api('/auth/2fa/disable', { method: 'POST', body: { code } });
                      toast.success('Two-factor disabled');
                      setCode('');
                      router.refresh();
                    } catch (error) {
                      const { message } = errorMessage(error);
                      toast.error(message);
                    } finally {
                      setTwoFactorBusy(false);
                    }
                  }}
                >
                  <ShieldOff className="size-3.5" /> Disable
                </Button>
              </div>
            </>
          ) : setup ? (
            <>
              <div className="space-y-1.5">
                <Label>Secret</Label>
                <div className="flex items-center gap-2">
                  <Input readOnly value={setup.secret} className="font-mono text-xs" />
                  <CopyButton value={setup.secret} />
                </div>
                <p className="text-xs text-muted-foreground">
                  Add it to your authenticator, or open <span className="font-mono">otpauth://</span> from the QR your app can read: the URI
                  is <span className="font-mono break-all">{setup.uri}</span>
                </p>
              </div>
              <div className="flex items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="enable-code">Code from the app</Label>
                  <Input id="enable-code" inputMode="numeric" maxLength={6} value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
                </div>
                <Button
                  size="sm"
                  disabled={twoFactorBusy || code.length !== 6}
                  onClick={async () => {
                    setTwoFactorBusy(true);
                    try {
                      await api('/auth/2fa/enable', { method: 'POST', body: { code } });
                      toast.success('Two-factor enabled');
                      setSetup(null);
                      setCode('');
                      router.refresh();
                    } catch (error) {
                      const { message } = errorMessage(error);
                      toast.error(message);
                    } finally {
                      setTwoFactorBusy(false);
                    }
                  }}
                >
                  Enable
                </Button>
              </div>
            </>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={async () => {
                try {
                  const result = await api<{ secret: string; uri: string }>('/auth/2fa/setup', { method: 'POST' });
                  setSetup(result);
                } catch (error) {
                  const { message } = errorMessage(error);
                  toast.error(message);
                }
              }}
            >
              <ShieldCheck className="size-3.5" /> Start setup
            </Button>
          )}

          <div className="pt-2">
            <ConfirmDialog
              title="Sign out everywhere?"
              description="Every refresh token for this account is revoked and all realtime sockets are closed."
              confirmLabel="Sign out everywhere"
              onConfirm={async () => {
                try {
                  await api('/auth/logout-all', { method: 'POST' });
                  toast.success('Signed out of every device');
                  router.replace('/login');
                  router.refresh();
                } catch (error) {
                  const { message } = errorMessage(error);
                  toast.error(message);
                  throw error;
                }
              }}
              trigger={
                <Button variant="outline" size="sm">
                  Sign out of all devices
                </Button>
              }
            />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AuditTable({ entries }: { entries: AuditEntry[] }) {
  const columns: Array<Column<AuditEntry>> = [
    { key: 'action', header: 'Action', cell: (entry) => <span className="font-mono text-xs">{entry.action}</span> },
    {
      key: 'entity',
      header: 'Entity',
      cell: (entry) => (
        <span className="text-xs text-muted-foreground">
          {entry.entityType ? `${entry.entityType} ${entry.entityId?.slice(0, 8) ?? ''}` : '—'}
        </span>
      ),
    },
    { key: 'ip', header: 'IP', cell: (entry) => <span className="font-mono text-xs">{entry.ip ?? '—'}</span> },
    { key: 'meta', header: 'Details', cell: (entry) => <span className="font-mono text-[10px] text-muted-foreground">{entry.meta ? JSON.stringify(entry.meta).slice(0, 80) : ''}</span> },
    { key: 'at', header: 'When', align: 'right', cell: (entry) => <Time value={entry.at} /> },
  ];

  return (
    <DataTable
      columns={columns}
      rows={entries}
      rowKey={(entry) => entry.id}
      emptyTitle="No audit entries yet"
      emptyDescription="Creating accounts, changing settings, sharing accounts and agent actions are all recorded here."
    />
  );
}

function SystemPanel({ diagnostics }: { diagnostics: Diagnostics }) {
  const database = diagnostics.database;
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Queued commands" value={number(diagnostics.queue.depth, 0)} hint={diagnostics.queue.oldestQueuedAgeMs !== null ? `oldest ${duration(diagnostics.queue.oldestQueuedAgeMs)}` : 'queue empty'} />
        <StatCard label="Open links" value={number(database.open_links ?? 0, 0)} hint="copied positions currently open" />
        <StatCard
          label="Dead commands"
          value={number(database.dead_commands ?? 0, 0)}
          tone={(database.dead_commands ?? 0) > 0 ? 'negative' : 'default'}
          hint="retries exhausted — investigate"
        />
        <StatCard label="Log entries (1h)" value={number(diagnostics.logsLastHour, 0)} hint={`${diagnostics.realtime.clients} realtime client(s)`} />
        <StatCard label="Accounts" value={number(database.accounts ?? 0, 0)} hint={`${diagnostics.agents.accounts} served by agents`} />
        <StatCard label="Copiers" value={number(database.copiers ?? 0, 0)} hint={`${database.users ?? 0} user(s) on this deployment`} />
        <StatCard label="Connected agents" value={number(diagnostics.agents.agents, 0)} hint={diagnostics.agents.oldestSessionAgeMs !== null ? `oldest session ${duration(diagnostics.agents.oldestSessionAgeMs)}` : 'none connected'} />
        <StatCard label="Uptime" value={duration(diagnostics.uptimeSeconds * 1_000)} hint={`version ${diagnostics.version}`} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Engine cadence</CardTitle>
          <CardDescription>How often each background loop runs. Lower values react faster and cost more database round-trips.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(diagnostics.engine).map(([key, value]) => (
            <div key={key} className="rounded-md border p-3">
              <div className="text-xs text-muted-foreground">{titleCase(key)}</div>
              <div className="tabular text-sm font-medium">{duration(value)}</div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Realtime topics</CardTitle>
          <CardDescription>Subscribers per topic on this deployment. Useful when a page looks stale.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          {Object.entries(diagnostics.realtime.byTopic).length === 0 ? (
            <p className="text-sm text-muted-foreground">No subscribers right now.</p>
          ) : (
            Object.entries(diagnostics.realtime.byTopic).map(([topic, count]) => (
              <Badge key={topic} variant="secondary">
                {topic} {count}
              </Badge>
            ))
          )}
          <span className="ml-auto self-center text-xs text-muted-foreground">
            Agent versions:{' '}
            {Object.keys(diagnostics.agents.versions).length > 0
              ? Object.entries(diagnostics.agents.versions)
                  .map(([version, count]) => `${version}×${count}`)
                  .join(', ')
              : 'none connected'}
          </span>
        </CardContent>
      </Card>
    </div>
  );
}
