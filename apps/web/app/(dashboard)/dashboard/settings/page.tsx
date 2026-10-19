import { apiFetch } from '@/lib/api';
import type { AuditEntry, Diagnostics, Session } from '@/lib/types';
import { PageHeader } from '@/components/page-header';
import { SettingsClient } from './settings-client';

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const [session, audit, diagnostics] = await Promise.all([
    apiFetch<Session>('/auth/me'),
    apiFetch<{ entries: AuditEntry[] }>('/audit?limit=100'),
    apiFetch<Diagnostics>('/diagnostics'),
  ]);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Your profile, how you sign in, and what the engine is doing right now. Auditing and diagnostics are read-only."
      />
      <SettingsClient session={session} audit={audit.entries} diagnostics={diagnostics} />
    </>
  );
}
