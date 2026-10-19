import { Badge } from '@/components/ui/badge';
import { titleCase } from '@/lib/format';

const LEVEL_VARIANT = {
  debug: 'muted',
  info: 'secondary',
  warn: 'warning',
  error: 'destructive',
} as const;

export function LevelBadge({ level }: { level: string }) {
  const variant = LEVEL_VARIANT[level as keyof typeof LEVEL_VARIANT] ?? 'outline';
  return (
    <Badge variant={variant} className="uppercase">
      {level}
    </Badge>
  );
}

/**
 * Error codes are the shared vocabulary between the engine and the UI
 * (`packages/contracts/src/errors.ts`), so they are shown verbatim and only
 * title-cased for tooltips.
 */
export function CodeBadge({ code, title }: { code: string; title?: string }) {
  return (
    <Badge variant="outline" className="font-mono text-[10px] tracking-tight" title={title ?? titleCase(code)}>
      {code}
    </Badge>
  );
}
