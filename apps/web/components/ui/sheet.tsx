'use client';

import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

function Sheet(props: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root {...props} />;
}

function SheetTrigger(props: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger {...props} />;
}

function SheetClose(props: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close {...props} />;
}

function SheetContent({
  className,
  children,
  side = 'right',
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: 'top' | 'right' | 'bottom' | 'left' }) {
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0" />
      <SheetPrimitive.Content
        className={cn(
          'fixed z-50 flex flex-col gap-4 bg-background shadow-lg transition ease-in-out data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=open]:duration-300',
          side === 'right' && 'inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm',
          side === 'left' && 'inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm',
          side === 'top' && 'inset-x-0 top-0 h-auto border-b',
          side === 'bottom' && 'inset-x-0 bottom-0 h-auto border-t',
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100">
          <XIcon className="size-4" />
          <span className="sr-only">Close</span>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 p-4', className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return <SheetPrimitive.Title className={cn('font-semibold text-foreground', className)} {...props} />;
}

function SheetDescription({ className, ...props }: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return <SheetPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger };
