'use client';

import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

function Select(props: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectValue(props: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value {...props} />;
}

function SelectTrigger({ className, size = 'default', children, ...props }: React.ComponentProps<typeof SelectPrimitive.Trigger> & { size?: 'sm' | 'default' }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        'flex w-fit items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none',
        'data-[size=default]:h-9 data-[size=sm]:h-8 disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
        '[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
        className,
      )}
      data-size={size}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="size-4 opacity-50" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({ className, children, position = 'popper', ...props }: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        className={cn(
          'relative z-50 max-h-(--radix-select-content-available-height) min-w-[8rem] overflow-y-auto overflow-x-hidden rounded-md border bg-popover text-popover-foreground shadow-md',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          position === 'popper' && 'data-[side=bottom]:translate-y-1 data-[side=top]:-translate-y-1',
          className,
        )}
        position={position}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center py-1">
          <ChevronUpIcon className="size-4" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport
          className={cn('p-1', position === 'popper' && 'h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)] scroll-my-1')}
        >
          {children}
        </SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center py-1">
          <ChevronDownIcon className="size-4" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectItem({ className, children, ...props }: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      className={cn(
        'relative flex w-full cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-sm outline-hidden select-none',
        'focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50',
        className,
      )}
      {...props}
    >
      <span className="absolute right-2 flex size-3.5 items-center justify-center">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return <SelectPrimitive.Label className={cn('px-2 py-1.5 text-xs text-muted-foreground', className)} {...props} />;
}

function SelectSeparator({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} {...props} />;
}

export { Select, SelectContent, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue };
