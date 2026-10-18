import type { Config } from 'drizzle-kit';

/**
 * Drizzle Kit configuration. The user runs migrations explicitly:
 *
 *   npm run db:generate   # (re)create SQL from the schema — already committed
 *   npm run db:migrate    # apply pending migrations
 *
 * `drizzle-kit push` is available for throwaway databases only.
 */
export default {
  // Drizzle Kit loads the schema as CommonJS, which cannot follow the `.js`
  // specifiers our TypeScript sources use for ESM. Pointing at the compiled
  // schema removes that mismatch; `db:generate` builds the package first.
  schema: './dist/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://trade_copier:trade_copier@localhost:5432/trade_copier',
  },
  strict: true,
  verbose: true,
  casing: 'snake_case',
} satisfies Config;
