'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { errorMessage } from '@/lib/client';

const TIMEZONES = ['UTC', 'Europe/London', 'Europe/Berlin', 'Europe/Moscow', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'America/New_York', 'America/Chicago', 'Australia/Sydney'];

export default function RegisterPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/auth/register', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...form, lastName: form.lastName || null }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { code: string; message: string; hint?: string } }
        | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Registration failed');
      toast.success('Account created');
      router.replace('/dashboard');
      router.refresh();
    } catch (error) {
      const { message, hint } = errorMessage(error);
      toast.error(message, hint ? { description: hint } : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>You can add broker accounts and build a copier straight after signing in.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="firstName">First name</Label>
              <Input id="firstName" required value={form.firstName} onChange={(event) => setForm({ ...form, firstName: event.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lastName">Last name</Label>
              <Input id="lastName" value={form.lastName} onChange={(event) => setForm({ ...form, lastName: event.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input id="email" type="email" autoComplete="email" required value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={10}
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">At least 10 characters. A passphrase beats a short random string.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              list="timezone-options"
              value={form.timezone}
              onChange={(event) => setForm({ ...form, timezone: event.target.value })}
            />
            <datalist id="timezone-options">
              {TIMEZONES.map((zone) => (
                <option key={zone} value={zone} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">Used for trading-hour windows, daily resets and the analytics heatmap.</p>
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already registered?{' '}
          <Link href="/login" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
