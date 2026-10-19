import { withDatabase } from './db.js';
import { DEMO_EMAIL, DEMO_PASSWORD, seedDemoData } from './demo-data.js';

/**
 * `pnpm db:seed`
 *
 * Applies migrations (so it is always safe to run against an empty database),
 * then creates the demo user, three broker accounts, a copier with two
 * followers, their symbol mappings, an equity-protection rule and a plan.
 *
 * Sign in with the credentials printed at the end. Nothing here is secret and
 * nothing here is production data.
 */
async function main(): Promise<void> {
  const summary = await withDatabase(seedDemoData, { migrate: true });

  const line = '─'.repeat(72);
  console.log(`\n${line}`);
  console.log(summary.reused ? 'Demo data re-seeded (existing rows reused)' : 'Demo data created');
  console.log(line);
  console.log(`  sign in    ${DEMO_EMAIL}`);
  console.log(`  password   ${DEMO_PASSWORD}`);
  console.log(`  accounts   ${summary.accounts.length}`);
  for (const account of summary.accounts) {
    console.log(`             · ${account.label.padEnd(24)} ${account.role.padEnd(6)} ${account.symbols} symbols`);
  }
  console.log(`  copier     ${summary.copierId}`);
  for (const follower of summary.followers) {
    console.log(`             · ${follower.accountLabel.padEnd(24)} ${follower.mapped} mapped, ${follower.skipped} unresolved`);
  }
  console.log(line);
  console.log('  next steps');
  console.log('    pnpm sim          run a copy simulation against this data');
  console.log('    pnpm dev          API :4000 + dashboard :3000');
  console.log(`${line}\n`);
}

main().catch((error: unknown) => {
  console.error('\nSeed failed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
