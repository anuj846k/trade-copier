import type { ReactNode } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * KPI tile. `tone` colours the value so profit/loss reads at a glance without
 * adding a chart for a single number.
 */
export function StatCard({
  label,
  value,
  hint,
  tone = 'default',
  icon,
  footer,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'default' | 'positive' | 'negative' | 'warning';
  icon?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <Card className="gap-2 py-4">
      <CardContent className="space-y-1">
        <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
          <span>{label}</span>
          {icon}
        </div>
        <div
          className={cn(
            'tabular text-2xl font-semibold tracking-tight',
            tone === 'positive' && 'text-success',
            tone === 'negative' && 'text-destructive',
            tone === 'warning' && 'text-warning',
          )}
        >
          {value}
        </div>
        {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
        {footer}
      </CardContent>
    </Card>
  );
}
