'use client';

import { ThemeProvider as NextThemesProvider } from 'next-themes';
import type { ReactNode } from 'react';

/** Light/dark switching via the `class` attribute on `<html>`. */
export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemesProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      {children}
    </NextThemesProvider>
  );
}
