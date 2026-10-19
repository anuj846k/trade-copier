import type {
  AccountKind,
  AccountRole,
  EquityProtection,
  AccountStatus,
  AssetClass,
  CopierLogLevel,
  CopierStatus,
  FollowerSettings,
  NotificationChannelKind,
  Platform,
  Position,
  SymbolInfo,
  TradeSide,
} from '@trade-copier/contracts';

/**
 * Shapes returned by the API.
 *
 * These mirror the serialisers in `apps/api/src/modules/*.routes.ts`. They are
 * declared here rather than generated so the dashboard never has to import
 * server code; the shared enums still come from `@trade-copier/contracts`.
 */

export interface Account {
  id: string;
  label: string;
  platform: Platform;
  login: string;
  server: string;
  brokerName: string | null;
  kind: AccountKind;
  role: AccountRole;
  currency: string;
  leverage: number | null;
  status: AccountStatus;
  online: boolean;
  enabled: boolean;
  balance: number | null;
  equity: number | null;
  freeMargin: number | null;
  marginLevel: number | null;
  equityUpdatedAt: string | null;
  lastHeartbeatAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  agentId: string | null;
  agent: { id: string; name: string; status?: string } | null;
  referenceBalance: number | null;
  createdAt: string;
}

export interface AccountDetailResponse {
  account: Account;
  symbolCount: number;
  disabledSymbolCount: number;
  equityProtection: (EquityProtection & { id: string; lastTriggeredAt: string | null; lastTriggeredRule: string | null }) | null;
  credentials: { hasPassword: boolean; hasInvestorPassword: boolean; updatedAt: string | null };
}

export type { EquityProtection };

export interface EquityProtectionEvent {
  id: string;
  kind: string;
  rule: string;
  threshold: number;
  observed: number;
  actions: string[];
  createdAt: string;
}

export interface ClosedTradeRow {
  ticket: string;
  symbol: string;
  side: TradeSide;
  volume: number;
  openPrice: number;
  closePrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  profit: number;
  swap: number;
  commission: number;
  followerId: string | null;
  openedAt: string;
  closedAt: string;
}

export interface AccountShare {
  id: string;
  accountId: string;
  ownerUserId: string;
  granteeUserId: string;
  role: 'viewer' | 'manager' | 'copier';
  status: 'active' | 'revoked';
  permissions: { balance: boolean; equity: boolean; history: boolean; canCopy: boolean };
  createdAt: string;
}

export interface FollowerSummary {
  followerId: string;
  accountId: string;
  label: string;
  login: string | null;
  server: string | null;
  currency: string | null;
  balance: number | null;
  equity: number | null;
  online: boolean;
  enabled: boolean;
  riskType: string;
  riskValue: number;
  riskLabel: string;
  reverseTrade: boolean;
  suffixPreference: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  lastEventAt: string | null;
}

export interface Follower extends FollowerSummary {
  settings: FollowerSettings;
}

export interface SymbolMapping {
  masterSymbol: string;
  slaveSymbol: string;
  source: 'auto' | 'manual' | string;
  confidence: number;
}

export interface Copier {
  id: string;
  name: string;
  masterAccountId: string;
  master: { label: string; status: string; online: boolean } | null;
  status: CopierStatus;
  pausedUntil: string | null;
  copyExistingTradesRequested: boolean;
  lastReconciledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CopierListItem {
  copier: Copier;
  followerCount: number;
  enabledFollowerCount: number;
  followers: FollowerSummary[];
  linkStateCounts: Record<string, number>;
}

export interface MasterTrade {
  ticket: string;
  accountLabel: string | null;
  symbol: string;
  side: TradeSide;
  volume: number;
  openPrice: number;
  stopLoss: number | null;
  takeProfit: number | null;
  state: string;
  comment: string | null;
  magic: number | null;
  openedAt: string;
  closedAt: string | null;
}

export interface TradeLink {
  followerId: string;
  followerLabel: string;
  slaveSymbol: string | null;
  slaveTicket: string | null;
  state: string;
  requestedVolume: number | null;
  filledVolume: number | null;
  filledPrice: number | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface CopierTrade extends MasterTrade {
  links: TradeLink[];
}

export interface CopierDetailResponse {
  copier: Copier;
  followers: Array<Follower & { overrides: Record<string, unknown>; mappings: SymbolMapping[] }>;
  masterTrades: MasterTrade[];
  logs: { rows: LogEntry[]; total: number };
  linkStateCounts: Record<string, number>;
}

export interface CopierStatusResponse {
  copierStatus: CopierStatus;
  master: { accountId: string; label: string; online: boolean; lastErrorCode: string | null } | null;
  followers: Array<{
    followerId: string;
    accountId: string;
    label: string;
    enabled: boolean;
    effectiveStatus: 'active' | 'inactive' | 'blocked';
    blockedReason: string | null;
    lastErrorCode: string | null;
    lastErrorMessage: string | null;
    lastEventAt: string | null;
  }>;
}

export interface LogEntry {
  id: string;
  at: string;
  level: CopierLogLevel;
  code: string;
  message: string;
  context: Record<string, unknown> | null;
  copierId: string | null;
  followerId: string | null;
  accountId: string | null;
}

export interface LogPage {
  entries: LogEntry[];
  total: number;
  limit: number;
  offset: number;
}

export interface NotificationRow {
  id: string;
  event: string;
  status: string;
  attempts: number;
  lastError: string | null;
  channelId: string | null;
  payload: Record<string, unknown>;
  sentAt: string | null;
  createdAt: string;
}

export interface NotificationChannel {
  id: string;
  kind: NotificationChannelKind;
  enabled: boolean;
  config: Record<string, unknown>;
  hasSecret: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationSetting {
  id: string;
  channelId: string;
  event: string;
  enabled: boolean;
  subject: string | null;
  template: string | null;
  accountBlocklist: string[];
}

export interface NotificationsResponse {
  notifications: NotificationRow[];
  channels: NotificationChannel[];
  settings: NotificationSetting[];
  availableEvents: string[];
}

export interface AnalyticsSummary {
  currency: string;
  balance: number;
  equity: number;
  growth: number;
  growthPercent: number;
  openPositions: number;
  openVolume: number;
  tradesTaken: number;
  lotsTraded: number;
  winRate: number;
  lossRate: number;
  longsWonRate: number;
  shortsWonRate: number;
  bestTrade: { profit: number; percent: number };
  worstTrade: { profit: number; percent: number };
  averageWinPercent: number;
  averageLossPercent: number;
  profitFactor: number;
  expectancy: number;
  maxDrawdown: { absolute: number; percent: number };
  netProfit: number;
  equitySeries: Array<{ at: string; balance: number; equity: number }>;
  heatmap: Array<{ weekday: number; hour: number; trades: number; profit: number }>;
}

export interface AccountAnalyticsResponse {
  account: { id: string; label: string; currency: string; online: boolean };
  from: string;
  to: string;
  followerIds: string[];
  analytics: AnalyticsSummary;
  openPositions: Position[];
}

export interface CopierAnalyticsResponse {
  copier: { id: string; name: string; status: CopierStatus };
  from: string;
  to: string;
  linkStateCounts: Record<string, number>;
  followers: Array<{
    followerId: string;
    accountId: string;
    label: string;
    copiedTrades: number;
    realisedProfit: number;
    links: Record<string, number>;
    lastErrorCode: string | null;
    lastErrorAt: string | null;
  }>;
  errorRate: { failed: number; total: number };
  recentLog: Array<{ id: string; at: string; level: CopierLogLevel; code: string; message: string; followerId: string | null }>;
}

export interface DashboardOverview {
  user: { id: string; firstName: string; email: string; timezone: string } | null;
  totals: {
    accounts: number;
    masterAccounts: number;
    copiers: number;
    runningCopiers: number;
    openCopiedTrades: number;
    totalEquity: number;
    currency: string;
  };
  equityByAccount: Array<{
    accountId: string;
    label: string;
    currency: string;
    balance: number | null;
    equity: number | null;
    online: boolean;
  }>;
  subscription: { planCode: string; status: string; currentPeriodEnd: string | null } | null;
  recentLog: Array<{ id: string; at: string; level: CopierLogLevel; code: string; message: string }>;
}

export interface Agent {
  id: string;
  name: string;
  status: string;
  version: string | null;
  host: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  accounts: Array<{ id: string; label: string; login: string; server: string }>;
}

export interface AgentsResponse {
  agents: Agent[];
  protocolVersion: number;
  connectHint: string;
}

export interface Plan {
  code: string;
  name: string;
  priceCents: number;
  interval: string;
  maxAccounts: number;
  features: string[];
  active: boolean;
}

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  meta: Record<string, unknown> | null;
  ip: string | null;
  at: string;
}

export interface Diagnostics {
  user: { id: string; role: string };
  database: Record<string, number>;
  queue: { depth: number; oldestQueuedAgeMs: number | null };
  logsLastHour: number;
  engine: Record<string, number>;
  agents: { agents: number; accounts: number; versions: Record<string, number>; oldestSessionAgeMs: number | null };
  realtime: { clients: number; byTopic: Record<string, number> };
  uptimeSeconds: number;
  version: string;
}

export interface SymbolListResponse {
  total: number;
  symbols: Array<SymbolInfo & { enabled: boolean; assetClass: AssetClass }>;
}

export interface ResolutionPreview {
  resolutions: Record<string, { slaveSymbol: string | null; strategy: string; confidence: number }>;
  automap: { mapped: number; stats: { total: number; matched: number; ambiguous: number }; skipped: string[]; ambiguousGroups: unknown[] };
  slaveSymbolCount: number;
}

/**
 * Session payload returned by `GET /auth/me`.
 *
 * Declared here (rather than only in `lib/api.ts`) so client components can
 * import the type without pulling in the server-only module.
 */
export interface Session {
  user: {
    id: string;
    email: string;
    firstName: string;
    lastName: string | null;
    timezone: string;
    role: 'user' | 'admin';
    totpEnabled: boolean;
    createdAt: string;
  };
  usage: { accounts: number; copiers: number };
  subscription: { planCode: string; status: string; currentPeriodEnd: string | null } | null;
}
