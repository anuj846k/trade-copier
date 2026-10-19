'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';

/** Copies a value that is shown exactly once (agent tokens, TOTP secret). */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2_000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  );
}
