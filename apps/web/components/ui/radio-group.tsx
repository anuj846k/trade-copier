'use client';

import * as React from 'react';
import * as RadioGroupPrimitive from '@radix-ui/react-radio-group';
import { CircleIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

function RadioGroup({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return <RadioGroupPrimitive.Root className={cn('grid gap-3', className)} {...props} />;
}

function RadioGroupItem({ className, ...props }: React.ComponentProps<typeof RadioGroupPrimitive.Item>) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        'aspect-square size-4 rounded-full border text-primary shadow-xs outline-none transition-[color,box-shadow]',
        'focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
        'data-[state=checked]:border-primary',
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="relative flex items-center justify-center">
        <CircleIcon className="size-2 fill-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };
