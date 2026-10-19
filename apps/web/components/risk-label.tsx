import { Badge } from '@/components/ui/badge';

const RISK_LABELS: Record<string, string> = {
  LOT_MULTIPLIER: 'Lot multiplier',
  FIXED_LOT: 'Fixed lots',
  BALANCE_MULTIPLIER: 'Balance multiplier',
  FIXED_BALANCE_MULTIPLIER: 'Fixed balance multiplier',
  FIXED_PERCENT_RISK: 'Percent risk',
};

export function riskTypeLabel(riskType: string): string {
  return RISK_LABELS[riskType] ?? riskType;
}

/** Risk model plus the value that actually decides the copied volume. */
export function RiskBadge({ riskType, riskValue, riskLabel }: { riskType: string; riskValue: number; riskLabel?: string }) {
  return (
    <Badge variant="secondary" title={riskLabel ?? undefined}>
      {riskTypeLabel(riskType)} · {riskValue}%
    </Badge>
  );
}
