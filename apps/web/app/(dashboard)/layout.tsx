import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/api';
import { RealtimeProvider } from '@/components/realtime-provider';
import { RealtimeIndicator } from '@/components/realtime-provider';
import { SidebarNav } from '@/components/sidebar-nav';
import { UserMenu } from '@/components/user-menu';
import { ThemeToggle } from '@/components/theme-toggle';
import { Badge } from '@/components/ui/badge';
import { MobileNav } from '@/components/mobile-nav';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');

  const name = [session.user.firstName, session.user.lastName].filter(Boolean).join(' ');

  return (
    <RealtimeProvider>
      <div className="grid min-h-dvh lg:grid-cols-[15rem_1fr]">
        <aside className="hidden border-r bg-sidebar lg:flex lg:flex-col lg:gap-4 lg:p-4">
          <Link href="/dashboard" className="flex items-center gap-2 px-1 font-semibold">
            <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">TC</span>
            Trade Copier
          </Link>
          <SidebarNav />
          <div className="mt-auto space-y-2 rounded-md border bg-background/60 p-3">
            <div className="text-xs font-medium text-muted-foreground">Plan</div>
            <div className="flex items-center justify-between">
              <Badge variant="secondary">{session.subscription?.planCode ?? 'free'}</Badge>
              <Link href="/dashboard/billing" className="text-xs underline-offset-4 hover:underline">
                Manage
              </Link>
            </div>
            <div className="text-xs text-muted-foreground">
              {session.usage.accounts} account(s) · {session.usage.copiers} copier(s)
            </div>
          </div>
        </aside>

        <div className="flex min-w-0 flex-col">
          <header className="flex items-center gap-3 border-b px-4 py-3">
            <MobileNav />
            <div className="flex items-center gap-2 lg:hidden">
              <span className="grid size-6 place-items-center rounded bg-primary text-[10px] font-bold text-primary-foreground">TC</span>
            </div>
            <div className="ml-auto flex items-center gap-3">
              <RealtimeIndicator />
              <ThemeToggle />
              <UserMenu email={session.user.email} name={name} />
            </div>
          </header>
          <main className="min-w-0 flex-1 space-y-6 p-4 sm:p-6">{children}</main>
        </div>
      </div>
    </RealtimeProvider>
  );
}
