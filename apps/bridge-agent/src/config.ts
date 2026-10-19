import { readFileSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Agent configuration.
 *
 * One agent process can serve several terminals on the same machine (one
 * `accounts[]` entry each) because every MT terminal runs its own EA with its
 * own local port. Configuration comes from, in order of precedence:
 *
 *   1. environment variables (`BRIDGE_*`),
 *   2. `--config <file>` (or `agent.config.json` next to the process),
 *   3. built-in defaults.
 */

export const agentAccountConfigSchema = z.object({
  /** Server-side account id (copy it from the dashboard's account page). */
  accountId: z.string().min(1),
  /** Free-form label used in the agent's own logs. */
  label: z.string().min(1).default('terminal'),
  platform: z.enum(['mt4', 'mt5', 'ctrader', 'matchtrader', 'tradelocker', 'dxtrade', 'mock']).default('mt5'),
  /** Where the Expert Advisor polls (localhost only). */
  eaHost: z.string().default('127.0.0.1'),
  eaPort: z.coerce.number().int().min(1).max(65_535).default(8787),
  /** Shared secret the EA must echo back on every poll. */
  eaToken: z.string().min(8),
  /** How long the agent waits for the EA before failing a command. */
  commandTimeoutMs: z.coerce.number().int().min(500).default(15_000),
  /** Max commands handed to the EA per poll. */
  maxCommandsPerPoll: z.coerce.number().int().min(1).max(200).default(20),
  /** Advertised capabilities (kept so the server never sends impossible work). */
  capabilities: z
    .object({
      pendingOrders: z.boolean().default(true),
      partialClose: z.boolean().default(true),
      modify: z.boolean().default(true),
      quotes: z.boolean().default(true),
    })
    .default({}),
});

export const agentConfigSchema = z.object({
  /** `wss://api.example.com/bridge/agent` (or ws:// for local development). */
  serverUrl: z.string().min(1),
  /** Agent token created in the dashboard (Settings → Bridge Agents). */
  token: z.string().min(10),
  name: z.string().min(1).default(hostname()),
  /** Reported to the server for support; the machine the terminal runs on. */
  host: z.string().max(120).default(hostname()),
  version: z.string().min(1).default('0.1.0'),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Reconnect backoff bounds (ms). */
  reconnectMinMs: z.coerce.number().int().min(250).default(1_000),
  reconnectMaxMs: z.coerce.number().int().min(1_000).default(30_000),
  /** Heartbeat cadence; the server declares its own on welcome and wins. */
  heartbeatIntervalMs: z.coerce.number().int().min(1_000).default(10_000),
  /** Outbound queue cap while disconnected (events are dropped oldest-first). */
  maxQueueDepth: z.coerce.number().int().min(10).default(5_000),
  /** Optional local health endpoint so a VPS watchdog can check the agent. */
  healthPort: z.coerce.number().int().min(1).max(65_535).nullable().default(null),
  accounts: z.array(agentAccountConfigSchema).min(1),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentAccountConfig = z.infer<typeof agentAccountConfigSchema>;

export interface LoadConfigOptions {
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

export function loadAgentConfig(options: LoadConfigOptions = {}): AgentConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();

  const filePath = argValue(argv, '--config') ?? env.BRIDGE_CONFIG ?? defaultConfigPath(cwd);
  let fromFile: Record<string, unknown> = {};
  if (filePath && existsSync(filePath)) {
    try {
      fromFile = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    } catch (error) {
      throw new AgentConfigError(`Could not parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (argValue(argv, '--config')) {
    throw new AgentConfigError(`Config file not found: ${filePath}`);
  }

  const merged: Record<string, unknown> = { ...fromFile };
  if (env.BRIDGE_SERVER_URL) merged.serverUrl = env.BRIDGE_SERVER_URL;
  if (env.BRIDGE_TOKEN) merged.token = env.BRIDGE_TOKEN;
  if (env.BRIDGE_NAME) merged.name = env.BRIDGE_NAME;
  if (env.BRIDGE_LOG_LEVEL) merged.logLevel = env.BRIDGE_LOG_LEVEL;

  // Single-account shorthand: BRIDGE_ACCOUNT_ID + BRIDGE_EA_TOKEN.
  if (!merged.accounts && env.BRIDGE_ACCOUNT_ID && env.BRIDGE_EA_TOKEN) {
    merged.accounts = [
      {
        accountId: env.BRIDGE_ACCOUNT_ID,
        label: env.BRIDGE_ACCOUNT_LABEL ?? 'terminal',
        platform: env.BRIDGE_PLATFORM ?? 'mt5',
        eaPort: env.BRIDGE_EA_PORT ? Number(env.BRIDGE_EA_PORT) : 8787,
        eaToken: env.BRIDGE_EA_TOKEN,
        eaHost: env.BRIDGE_EA_HOST ?? '127.0.0.1',
      },
    ];
  }

  const parsed = agentConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `  • ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new AgentConfigError(
      `Bridge agent configuration is invalid:\n${issues}\n\n` +
        'Provide it with --config agent.config.json, the BRIDGE_* environment variables, ' +
        'or by copying agent.config.example.json.',
    );
  }
  return parsed.data;
}

function defaultConfigPath(cwd: string): string {
  return resolve(cwd, 'agent.config.json');
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}
