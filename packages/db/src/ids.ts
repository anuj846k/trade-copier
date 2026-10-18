import { randomBytes } from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** URL-safe, sortable-ish, prefix-readable identifiers (`acc_9f3k2m…`). */
export function newId(prefix: string, size = 16): string {
  const bytes = randomBytes(size);
  let out = '';
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

const PREFIXES = {
  user: 'usr',
  refreshToken: 'rt',
  apiKey: 'key',
  agent: 'agt',
  account: 'acc',
  credential: 'cred',
  symbol: 'sym',
  copier: 'cop',
  follower: 'fol',
  override: 'ovr',
  mapping: 'map',
  masterTrade: 'mtr',
  link: 'lnk',
  command: 'cmd',
  log: 'log',
  snapshot: 'snp',
  closedTrade: 'ctr',
  protection: 'epr',
  protectionEvent: 'epe',
  channel: 'chn',
  notificationSetting: 'nst',
  notification: 'ntf',
  plan: 'plan',
  subscription: 'sub',
  share: 'shr',
  audit: 'aud',
  job: 'job',
  dailyReset: 'rst',
} as const;

export type IdKind = keyof typeof PREFIXES;

export function id(kind: IdKind): string {
  return newId(PREFIXES[kind]);
}

/** Opaque tokens for agents, API keys and refresh tokens. */
export function newToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}
