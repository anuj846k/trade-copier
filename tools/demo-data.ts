import type { AssetClass, FollowerSettings, SymbolInfo } from '@trade-copier/contracts';
import { equityProtectionSchema, followerSettingsSchema } from '@trade-copier/contracts';
import { autoMapSymbols } from '@trade-copier/domain';
import type { SymbolUpsert } from '@trade-copier/db';
import type { ToolContext } from './db.js';
import { hashPassword } from '../apps/api/src/lib/passwords.js';

/**
 * Demo dataset.
 *
 * The shape is deliberately the awkward one, not the easy one: the master is an
 * MT5 prop account, one follower is an MT5 account whose broker suffixes every
 * instrument with `.raw`, and the other is an MT4 account with an `_ecn`
 * suffix. That exercises the symbol-mapping ladder (exact → suffix → canonical)
 * on real data instead of only in unit tests.
 *
 * Idempotent: running it twice reuses the user and accounts it finds and
 * re-applies the rest. `db:reset` drops everything first.
 */

export const DEMO_EMAIL = 'demo@trade-copier.dev';
export const DEMO_PASSWORD = 'demo-password-123';

export interface SeedSummary {
  readonly userId: string;
  readonly accounts: Array<{ id: string; label: string; role: string; symbols: number }>;
  readonly copierId: string;
  readonly followers: Array<{ accountLabel: string; mapped: number; skipped: number }>;
  readonly reused: boolean;
}

interface SymbolSpec {
  readonly name: string;
  readonly canonical: string;
  readonly assetClass: AssetClass;
  readonly digits: number;
  /** One pip in price terms. */
  readonly pip: number;
  readonly contractSize: number;
  readonly quoteCurrency: string;
}

/**
 * A miniature but realistic broker instrument set. Prices are irrelevant here
 * (the mock connector generates them); the *metadata* is what the sizing maths
 * reads, so digits/pip/contract size are the fields that matter.
 */
const INSTRUMENTS: readonly SymbolSpec[] = [
  { name: 'EURUSD', canonical: 'EURUSD', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'USD' },
  { name: 'GBPUSD', canonical: 'GBPUSD', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'USD' },
  { name: 'AUDUSD', canonical: 'AUDUSD', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'USD' },
  { name: 'NZDUSD', canonical: 'NZDUSD', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'USD' },
  { name: 'USDCAD', canonical: 'USDCAD', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'CAD' },
  { name: 'USDCHF', canonical: 'USDCHF', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'CHF' },
  { name: 'USDJPY', canonical: 'USDJPY', assetClass: 'forex', digits: 3, pip: 0.01, contractSize: 100_000, quoteCurrency: 'JPY' },
  { name: 'EURJPY', canonical: 'EURJPY', assetClass: 'forex', digits: 3, pip: 0.01, contractSize: 100_000, quoteCurrency: 'JPY' },
  { name: 'EURGBP', canonical: 'EURGBP', assetClass: 'forex', digits: 5, pip: 0.0001, contractSize: 100_000, quoteCurrency: 'GBP' },
  { name: 'XAUUSD', canonical: 'XAUUSD', assetClass: 'metal', digits: 2, pip: 0.1, contractSize: 100, quoteCurrency: 'USD' },
  { name: 'XAGUSD', canonical: 'XAGUSD', assetClass: 'metal', digits: 3, pip: 0.01, contractSize: 5_000, quoteCurrency: 'USD' },
  { name: 'US30', canonical: 'US30', assetClass: 'index', digits: 1, pip: 1, contractSize: 1, quoteCurrency: 'USD' },
  { name: 'NAS100', canonical: 'NAS100', assetClass: 'index', digits: 2, pip: 1, contractSize: 1, quoteCurrency: 'USD' },
  { name: 'GER40', canonical: 'GER40', assetClass: 'index', digits: 1, pip: 1, contractSize: 1, quoteCurrency: 'EUR' },
  { name: 'BTCUSD', canonical: 'BTCUSD', assetClass: 'crypto', digits: 2, pip: 1, contractSize: 1, quoteCurrency: 'USD' },
];

function toSymbolUpsert(spec: SymbolSpec, name: string): SymbolUpsert {
  return {
    name,
    canonical: spec.canonical,
    assetClass: spec.assetClass,
    digits: spec.digits,
    point: Number((1 / 10 ** spec.digits).toFixed(10)),
    pipSize: spec.pip,
    contractSize: spec.contractSize,
    minLot: 0.01,
    maxLot: 50,
    lotStep: 0.01,
    quoteCurrency: spec.quoteCurrency,
    tradeMode: 'full',
  };
}

/** Instruments as the master's broker lists them. */
function masterSymbols(): SymbolUpsert[] {
  return INSTRUMENTS.map((spec) => toSymbolUpsert(spec, spec.name));
}

/**
 * Instruments as a follower's broker lists them.
 *
 * `suffix` is appended to every name except those in `untouched`, which stay
 * byte-identical to the master's so the exact-match branch of the mapper is
 * exercised too.
 */
function followerSymbols(suffix: string, untouched: readonly string[] = []): SymbolUpsert[] {
  return INSTRUMENTS.map((spec) =>
    toSymbolUpsert(spec, untouched.includes(spec.name) ? spec.name : `${spec.name}${suffix}`),
  );
}

export async function seedDemoData(context: ToolContext): Promise<SeedSummary> {
  const { repos } = context;

  let reused = false;
  let user = await repos.auth.findUserByEmail(DEMO_EMAIL);
  if (user) {
    reused = true;
  } else {
    user = await repos.auth.createUser({
      email: DEMO_EMAIL,
      passwordHash: await hashPassword(DEMO_PASSWORD),
      firstName: 'Demo',
      lastName: 'Trader',
      timezone: 'Europe/London',
    });
  }
  const userId = user.id;

  // --- plans and subscription ------------------------------------------------
  await repos.platform.upsertPlan({
    code: 'standard_monthly',
    name: 'Standard',
    priceCents: 4_900,
    interval: 'month',
    maxAccounts: 3,
    features: ['3 broker accounts', 'Copy engine included', 'Email notifications'],
  });
  await repos.platform.upsertPlan({
    code: 'premium_monthly',
    name: 'Premium',
    priceCents: 9_900,
    interval: 'month',
    maxAccounts: 10,
    features: ['10 broker accounts', 'Telegram + webhook notifications', 'Per-symbol overrides', 'Priority support'],
  });
  await repos.platform.upsertPlan({
    code: 'premium_annual',
    name: 'Premium Annual',
    priceCents: 99_000,
    interval: 'year',
    maxAccounts: 10,
    features: ['Everything in Premium', '2 months free', 'Onboarding call'],
  });

  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 14 * 24 * 60 * 60 * 1_000);
  await repos.platform.upsertSubscription({
    userId,
    planCode: 'premium_monthly',
    status: 'trialing',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });

  // --- notification channel --------------------------------------------------
  const channel = await repos.platform.upsertChannel({
    userId,
    kind: 'webhook',
    enabled: false,
    // Disabled and unauthenticated on purpose: it is a shape to look at, not a
    // working endpoint. Point it at a real URL and enable it to use it.
    config: { url: 'https://example.com/trade-copier-hook' },
    secretsEncrypted: null,
  });
  for (const event of ['trade_copy_failed', 'equity_protection_triggered', 'account_disconnected'] as const) {
    await repos.platform.upsertNotificationSetting({ userId, channelId: channel.id, event, enabled: true });
  }

  // --- accounts --------------------------------------------------------------
  const master = await ensureAccount(context, {
    userId,
    label: 'FTMO Challenge 100k',
    platform: 'mt5',
    login: '5012345',
    server: 'FTMO-Server',
    brokerName: 'FTMO',
    kind: 'demo',
    currency: 'USD',
    leverage: 100,
    role: 'both',
  });
  const followerA = await ensureAccount(context, {
    userId,
    label: 'IC Markets ECN 25k',
    platform: 'mt5',
    login: '8812345',
    server: 'ICMarketsSC-Live',
    brokerName: 'IC Markets',
    kind: 'live',
    currency: 'USD',
    leverage: 500,
    role: 'slave',
  });
  const followerB = await ensureAccount(context, {
    userId,
    label: 'MT4 Prop 10k',
    platform: 'mt4',
    login: '31234567',
    server: 'FTMO-Demo',
    brokerName: 'FTMO',
    kind: 'demo',
    currency: 'USD',
    leverage: 100,
    role: 'slave',
  });

  const symbolCounts = await Promise.all([
    repos.accounts.replaceSymbols(master.id, masterSymbols()),
    repos.accounts.replaceSymbols(followerA.id, followerSymbols('.raw', ['NAS100', 'BTCUSD'])),
    repos.accounts.replaceSymbols(followerB.id, followerSymbols('_ecn', ['XAUUSD', 'US30'])),
  ]);

  // Balances shown on the dashboard before the first real snapshot arrives.
  const now = new Date().toISOString();
  const balances: Array<[string, number, number]> = [
    [master.id, 100_000, 100],
    [followerA.id, 25_000, 500],
    [followerB.id, 10_000, 100],
  ];
  for (const [accountId, balance, leverage] of balances) {
    await repos.accounts.applySnapshot(accountId, {
      accountId,
      balance,
      equity: balance,
      margin: 0,
      freeMargin: balance,
      marginLevel: null,
      currency: 'USD',
      leverage,
      at: now,
    });
    await repos.accounts.setDailyReference(accountId, balance, new Date());
  }

  // Equity protection on the master: stop the copy, warn, do not close.
  await repos.platform.upsertEquityProtection(
    master.id,
    equityProtectionSchema.parse({
      enabled: true,
      resetTime: '00:00',
      resetTimezone: 'Europe/London',
      maxDrawdownPercent: 4,
      absoluteMinEquity: 90_000,
      disableCopier: true,
      closeCopiedTrades: false,
      closeAllTrades: false,
      notify: true,
    }),
  );

  // --- copier, followers, mappings ------------------------------------------
  const copier = await ensureCopier(context, {
    userId,
    name: 'FTMO → prop accounts',
    masterAccountId: master.id,
  });

  const followers: SeedSummary['followers'] = [];
  const existingFollowers = await repos.copiers.listFollowers(copier.id);

  const plans: Array<{ accountId: string; label: string; suffix: string; settings: Partial<FollowerSettings> }> = [
    {
      accountId: followerA.id,
      label: followerA.label,
      suffix: '.raw',
      settings: {
        // 25k against the master's 100k start: proportional sizing.
        riskType: 'BALANCE_MULTIPLIER',
        riskValue: 100,
        maxSlippagePips: 3,
        reverseTrade: false,
      },
    },
    {
      accountId: followerB.id,
      label: followerB.label,
      suffix: '_ecn',
      settings: {
        riskType: 'FIXED_PERCENT_RISK',
        riskValue: 1,
        maxSpreadPips: 2.5,
        copyStopLoss: true,
        copyTakeProfit: true,
      },
    },
  ];

  for (const plan of plans) {
    const existing = existingFollowers.find((follower) => follower.accountId === plan.accountId);
    const follower =
      existing ??
      (await repos.copiers.addFollower({
        copierId: copier.id,
        accountId: plan.accountId,
        settings: followerSettingsSchema.parse(plan.settings),
        suffixPreference: plan.suffix,
        enabled: true,
      }));

    // Same mapper the API runs on `POST /copiers/:id/followers`.
    const masterSymbols = (await repos.accounts.listSymbols(master.id)).map((symbol: SymbolInfo) => symbol.name);
    const slaveSymbols = (await repos.accounts.listSymbols(plan.accountId)).map((symbol: SymbolInfo) => symbol.name);
    const mapped = await repos.copiers.listMappings(follower.id);
    const result = autoMapSymbols({
      masterSymbols,
      slaveSymbols,
      existing: Object.fromEntries(mapped.map((mapping) => [mapping.masterSymbol, mapping.slaveSymbol])),
      suffixPreference: plan.suffix,
    });

    await repos.copiers.bulkUpsertMappings(
      follower.id,
      Object.entries(result.mappings).map(([masterSymbol, slaveSymbol]) => ({
        masterSymbol,
        slaveSymbol,
        source: 'auto' as const,
        confidence: 1,
      })),
    );

    followers.push({ accountLabel: plan.label, mapped: Object.keys(result.mappings).length, skipped: result.skipped.length });
  }

  return {
    userId,
    accounts: [
      { id: master.id, label: master.label, role: master.role, symbols: symbolCounts[0] ?? 0 },
      { id: followerA.id, label: followerA.label, role: followerA.role, symbols: symbolCounts[1] ?? 0 },
      { id: followerB.id, label: followerB.label, role: followerB.role, symbols: symbolCounts[2] ?? 0 },
    ],
    copierId: copier.id,
    followers,
    reused,
  };
}

interface AccountSeed {
  userId: string;
  label: string;
  platform: 'mt4' | 'mt5';
  login: string;
  server: string;
  brokerName: string;
  kind: 'demo' | 'live';
  currency: string;
  leverage: number;
  role: 'master' | 'slave' | 'both';
}

async function ensureAccount(context: ToolContext, seed: AccountSeed) {
  const { repos } = context;
  const existing = await repos.accounts.findByPlatformLogin(seed.platform, seed.login, seed.server);
  if (existing) return existing;
  return repos.accounts.create(seed);
}

async function ensureCopier(context: ToolContext, seed: { userId: string; name: string; masterAccountId: string }) {
  const { repos } = context;
  const existing = (await repos.copiers.listByUser(seed.userId)).find((copier) => copier.name === seed.name);
  if (existing) return existing;
  return repos.copiers.create({
    userId: seed.userId,
    name: seed.name,
    masterAccountId: seed.masterAccountId,
    status: 'enabled',
  });
}
