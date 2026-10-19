'use client';

import { Menu } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { SidebarNav } from '@/components/sidebar-nav';

/** Sidebar collapsed into a sheet on small screens. */
export function MobileNav() {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>
      </SheetTrigger>
      <SheetContent side="left" className="bg-sidebar">
        <SheetHeader>
          <SheetTitle>Trade Copier</SheetTitle>
        </SheetHeader>
        <div className="px-2">
          <SidebarNav onNavigate={() => setOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
