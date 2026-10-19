import * as React from 'react';
import { cn } from '@/lib/utils';

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-4 rounded-xl border bg-card py-5 text-card-foreground shadow-xs', className)} {...props} />;
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex flex-col gap-1 px-5', className)} {...props} />;
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('font-semibold leading-none tracking-tight', className)} {...props} />;
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('text-sm text-muted-foreground', className)} {...props} />;
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('px-5', className)} {...props} />;
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div className={cn('flex items-center px-5', className)} {...props} />;
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
