import * as React from 'react';
import { cn } from '@/lib/utils';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'flex min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-sm shadow-xs outline-none transition-[color,box-shadow]',
        'placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
