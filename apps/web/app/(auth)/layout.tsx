import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-muted/30">
      <header className="flex items-center justify-between px-6 py-5">
        <Link href="/" className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">TC</span>
          Trade Copier
        </Link>
        <ThemeToggle />
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  );
}
