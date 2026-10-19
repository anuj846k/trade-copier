import { money, signedMoney } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * Money with an explicit profit/loss tone.
 *
 * Kept as its own component (not just a formatter) so every table column that
 * shows a P/L picks the same colour rule: green when positive, red when
 * negative, neutral when exactly zero.
 */
export function Money({
  value,
  currency = 'USD',
  signed = false,
  className,
}: {
  value: number | null | undefined;
  currency?: string;
  signed?: boolean;
  className?: string;
}) {
  const text = signed ? signedMoney(value, currency) : money(value, currency);
  return (
    <span
      className={cn(
        'tabular',
        value === null || value === undefined ? 'text-muted-foreground' : value > 0 ? 'text-success' : value < 0 ? 'text-destructive' : '',
        className,
      )}
    >
      {text}
    </span>
  );
}
