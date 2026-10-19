'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { XIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

function Dialog(props: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root {...props} />;
}

function DialogTrigger(props: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger {...props} />;
}

function DialogClose(props: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-black/60 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        className,
      )}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & { showCloseButton?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          'fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border bg-background p-6 shadow-lg sm:max-w-lg',
          'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
          'max-h-[calc(100dvh-2rem)] overflow-y-auto',
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton ? (
          <DialogPrimitive.Close className="absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-hidden">
            <XIcon className="size-4" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-2 text-center sm:text-left', className)} {...props} />;
}

function DialogFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn('text-lg leading-none font-semibold', className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

export { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogTitle, DialogTrigger };
