'use client';

import { useRouter } from 'next/navigation';
import { LogOut, User } from 'lucide-react';
import { toast } from 'sonner';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Link from 'next/link';

export function UserMenu({ email, name }: { email: string; name: string }) {
  const router = useRouter();
  const initials = (name || email)
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <Avatar>
            <AvatarFallback>{initials || 'TC'}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="space-y-0.5">
          <div className="text-sm font-medium">{name || 'Trader'}</div>
          <div className="truncate text-xs font-normal text-muted-foreground">{email}</div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard/settings">
            <User className="size-4" /> Profile &amp; security
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={async () => {
            const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
            if (response.ok) {
              toast.success('Signed out');
              router.replace('/login');
              router.refresh();
            } else {
              toast.error('Could not sign out — try again');
            }
          }}
        >
          <LogOut className="size-4" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
