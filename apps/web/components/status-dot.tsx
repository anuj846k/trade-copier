import { cn } from '@/lib/utils';

export type DotTone = 'online' | 'offline' | 'warning' | 'error' | 'idle';

const TONES: Record<DotTone, string> = {
  online: 'bg-success',
  offline: 'bg-muted-foreground/50',
  warning: 'bg-warning',
  error: 'bg-destructive',
  idle: 'bg-muted-foreground/40',
};

/** Connection/health light with an accessible label. */
export function StatusDot({ tone, label, className }: { tone: DotTone; label: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs', className)}>
      <span className={cn('size-2 shrink-0 rounded-full', TONES[tone])} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
    </span>
  );
}
