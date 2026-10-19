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

export default function LoginPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [totpRequired, setTotpRequired] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', totp: '' });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: form.email,
          password: form.password,
          ...(totpRequired && form.totp ? { totp: form.totp } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | { error?: { code: string; message: string; hint?: string; details?: Record<string, unknown> } }
        | null;
      if (!response.ok) {
        const needsTotp = payload?.error?.details?.totpRequired === true;
        if (needsTotp) {
          setTotpRequired(true);
          toast.info('Enter the 6-digit code from your authenticator app');
          return;
        }
        throw Object.assign(new Error(payload?.error?.message ?? 'Sign-in failed'), {
          hint: payload?.error?.hint,
        });
      }
      toast.success('Signed in');
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
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the email and password for your Trade Copier account.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
            />
          </div>
          {totpRequired ? (
            <div className="space-y-1.5">
              <Label htmlFor="totp">Authenticator code</Label>
              <Input
                id="totp"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                autoFocus
                value={form.totp}
                onChange={(event) => setForm({ ...form, totp: event.target.value.replace(/\D/g, '') })}
              />
            </div>
          ) : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          No account yet?{' '}
          <Link href="/register" className="text-primary underline-offset-4 hover:underline">
            Create one
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
