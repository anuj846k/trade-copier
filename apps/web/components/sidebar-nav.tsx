'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  Bell,
  Bot,
  CreditCard,
  LayoutDashboard,
  LineChart,
  ScrollText,
  Settings,
  Users,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/accounts', label: 'Accounts', icon: Users },
  { href: '/dashboard/copiers', label: 'Copiers', icon: Activity },
  { href: '/dashboard/logs', label: 'Trade log', icon: ScrollText },
  { href: '/dashboard/analytics', label: 'Analytics', icon: LineChart },
  { href: '/dashboard/notifications', label: 'Notifications', icon: Bell },
  { href: '/dashboard/agents', label: 'Bridge agents', icon: Bot },
  { href: '/dashboard/billing', label: 'Plan', icon: CreditCard },
  { href: '/dashboard/settings', label: 'Settings', icon: Settings },
] as const;

export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-1">
      {NAV.map((item) => {
        const active = item.href === '/dashboard' ? pathname === item.href : pathname.startsWith(item.href);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
              active ? 'bg-sidebar-accent text-sidebar-accent-foreground' : 'text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground',
            )}
          >
            <Icon className="size-4 shrink-0" />
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
