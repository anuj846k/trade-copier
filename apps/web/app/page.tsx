import Link from 'next/link';
import { ArrowRight, BellRing, Bot, ChartLine, Filter, Layers, ShieldCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';

const FEATURES = [
  {
    icon: Layers,
    title: 'One master, many followers',
    body: 'Point a copier at your master account and add followers one by one. Each follower keeps its own risk model, filters and symbol mapping, so changing one never touches another.',
  },
  {
    icon: ChartLine,
    title: 'Five risk models',
    body: 'Lot multiplier, fixed lots, balance ratio, fixed-balance ratio or percent-risk sizing off the master stop. 100% percent-risk means a straight 1:1 copy.',
  },
  {
    icon: Filter,
    title: 'Symbol mapping that resolves itself',
    body: 'Suffixes, prefixes and names differ per broker. Mapping runs the same strategy ladder at configure time and at copy time, and tells you exactly what it could not match.',
  },
  {
    icon: ShieldCheck,
    title: 'Equity protection',
    body: 'Stop copying for an account when its equity, balance or drawdown crosses a threshold you set — or close what is already open, with a per-day reset time.',
  },
  {
    icon: Bot,
    title: 'Bridge agent, no open ports',
    body: 'A small agent sits next to your terminals, exposes a local endpoint the Expert Advisor polls and holds one outbound socket to the server.',
  },
  {
    icon: BellRing,
    title: 'Audit trail and alerts',
    body: 'Every decision is logged with a code and a reason, and failures can reach you over email, Telegram, Slack, Discord or a webhook.',
  },
];

export default function LandingPage() {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-6">
      <header className="flex items-center justify-between py-6">
        <div className="flex items-center gap-2 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">TC</span>
          Trade Copier
        </div>
        <div className="flex items-center gap-2">
          <ThemeToggle />
          <Button asChild variant="ghost" size="sm">
            <Link href="/login">Sign in</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/register">Create account</Link>
          </Button>
        </div>
      </header>

      <section className="grid gap-8 py-14 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
        <div className="space-y-5">
          <Badge variant="secondary">Forex &amp; CFD · MetaTrader-class platforms</Badge>
          <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            Mirror your trades across every account you manage.
          </h1>
          <p className="max-w-xl text-muted-foreground">
            A copier built for the details that decide whether copy trading works in production: broker-specific symbol
            resolution, per-account position sizing, spread and slippage tolerance, market-hours awareness, and an
            execution log that explains every skipped or failed leg.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link href="/register">
                Get started <ArrowRight className="size-4" />
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link href="/login">I already have an account</Link>
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Connect accounts through the bridge agent. Demo accounts work exactly like live ones — the engine cannot
            tell the difference.
          </p>
        </div>

        <Card className="bg-muted/40">
          <CardContent className="space-y-3 pt-1">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>EURUSD · master 0.50 lots</span>
              <span className="tabular">spread 0.9 pips</span>
            </div>
            {[
              { label: 'Follower A — fixed 0.10 lots', value: '0.10', note: 'EURUSD + suffix .raw' },
              { label: 'Follower B — 2× master', value: '1.00', note: 'EURUSD.raw, clamped to max lot' },
              { label: 'Follower C — 1% risk', value: '0.28', note: 'sized from master stop-loss' },
            ].map((row) => (
              <div key={row.label} className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{row.label}</div>
                  <div className="text-xs text-muted-foreground">{row.note}</div>
                </div>
                <div className="tabular text-sm font-semibold">{row.value}</div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground">
              Every copied leg is recorded with its requested and filled volume, fill price and — when something fails —
              the error code that explains it.
            </p>
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 pb-16 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((feature) => (
          <Card key={feature.title} className="h-full">
            <CardContent className="space-y-2">
              <feature.icon className="size-5 text-primary" />
              <h2 className="font-medium">{feature.title}</h2>
              <p className="text-sm text-muted-foreground">{feature.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <footer className="mt-auto border-t py-6 text-xs text-muted-foreground">
        Trade Copier — self-hostable. Your broker credentials are encrypted at rest and never leave your deployment.
      </footer>
    </div>
  );
}
