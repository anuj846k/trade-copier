import type { FastifyBaseLogger } from 'fastify';
import type { Position } from '@trade-copier/contracts';
import type { Repositories } from '@trade-copier/db';
import type { Env } from '../config/env.js';
import { marketSessionFromEnv } from '../config/env.js';
import type { UiHub } from '../realtime/hub.js';
import type { RateLimiter } from '../lib/ratelimit.js';
import type { TicketStore } from '../lib/tickets.js';
import { AgentHub, type ClosedTradeLike } from './agents.js';
import { ConnectorRegistry } from './connectors.js';
import { CopyPipeline } from './copy-pipeline.js';
import { CommandDispatcher } from './dispatcher.js';
import { EquityMonitor } from './equity-monitor.js';
import { SnapshotCollector } from './snapshot-collector.js';
import { MaintenanceMonitor } from './maintenance.js';
import { NotificationSender } from './notifications.js';
import { JobRunner } from './jobs.js';
import { Reconciler } from './reconciler.js';

/**
 * Copy engine composition root.
 *
 * The API process owns the engine by default (`RUN_WORKER_IN_PROCESS`), which
 * keeps a single-node deployment to one process. Setting the flag to false lets
 * the same code run as a separate worker while the API stays stateless — the
 * only shared state is the database.
 */
export interface EngineOptions {
  readonly env: Env;
  readonly repos: Repositories;
  readonly ui: UiHub;
  readonly log: FastifyBaseLogger;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly tickets?: TicketStore | undefined;
  readonly now?: (() => Date) | undefined;
}

export class CopyEngine {
  readonly hub: AgentHub;
  readonly registry: ConnectorRegistry;
  readonly pipeline: CopyPipeline;
  readonly dispatcher: CommandDispatcher;
  readonly equity: EquityMonitor;
  readonly snapshots: SnapshotCollector;
  readonly maintenance: MaintenanceMonitor;
  readonly notifier: NotificationSender;
  readonly jobs: JobRunner;
  readonly reconciler: Reconciler;

  private readonly timers: NodeJS.Timeout[] = [];
  private started = false;

  constructor(private readonly options: EngineOptions) {
    const { env, repos, ui, log } = options;

    this.hub = new AgentHub({
      repos,
      log,
      heartbeatIntervalMs: env.AGENT_HEARTBEAT_INTERVAL_MS,
      commandTimeoutMs: env.COMMAND_TIMEOUT_MS,
      onPositions: (accountId, positions, authoritative) => this.pipeline.onPositions(accountId, positions, authoritative),
      onClosedTrade: (accountId, trade) => this.pipeline.onClosedTrade(accountId, trade),
      onAccountState: (accountId, snapshot) => this.pipeline.onAccountState(accountId, snapshot),
      onSymbols: (accountId, symbols) => this.pipeline.onSymbols(accountId, symbols),
      onAgentStatus: (agentId, status) => this.handleAgentStatus(agentId, status),
    });

    this.registry = new ConnectorRegistry({ hub: this.hub, repos, log });
    this.pipeline = new CopyPipeline({
      env,
      repos,
      hub: this.hub,
      ui,
      log,
      marketSession: marketSessionFromEnv(env),
      now: options.now,
    });
    this.dispatcher = new CommandDispatcher({ env, repos, hub: this.hub, ui, registry: this.registry, log, now: options.now });
    this.equity = new EquityMonitor({ repos, ui, registry: this.registry, log, now: options.now });
    this.snapshots = new SnapshotCollector({ repos, hub: this.hub, log, now: options.now });
    this.maintenance = new MaintenanceMonitor({
      env,
      repos,
      hub: this.hub,
      ui,
      log,
      rateLimiter: options.rateLimiter,
      tickets: options.tickets,
      now: options.now,
    });
    this.notifier = new NotificationSender({ env, repos, log, workerId: this.dispatcher.workerId, now: options.now });
    this.reconciler = new Reconciler({ repos, hub: this.hub, ui, registry: this.registry, log, now: options.now });
    this.jobs = new JobRunner({
      repos,
      log,
      workerId: this.dispatcher.workerId,
      handlers: {
        prune: async () => {
          await this.maintenance.prune();
        },
        reconcile: async () => {
          await this.reconciler.tick();
        },
        daily_reset: async () => {
          await this.equity.dailyReset();
        },
      },
      now: options.now,
    });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.dispatcher.start();

    const every = (ms: number, run: () => Promise<unknown> | unknown) => {
      const tick = async () => {
        try {
          await run();
        } catch (error) {
          this.options.log.error({ err: error }, 'engine interval failed');
        }
      };
      void tick();
      const timer = setInterval(() => void tick(), ms);
      timer.unref?.();
      this.timers.push(timer);
    };

    every(this.options.env.EQUITY_PROTECTION_INTERVAL_MS, () => this.equity.tick());
    every(this.options.env.EQUITY_SNAPSHOT_INTERVAL_MS, () => this.snapshots.tick());
    every(5_000, () => this.notifier.tick());
    every(10_000, async () => {
      await this.maintenance.reapCommands();
      await this.maintenance.reapAgents();
      this.maintenance.reapEphemeral();
    });
    every(60_000, () => this.maintenance.reapStaleAccounts());
    every(60_000, () => this.jobs.tick());
    every(10 * 60_000, async () => {
      await this.jobs.schedule('daily_reset', new Date(Date.now() + 1_000));
      await this.jobs.schedule('prune', new Date(Date.now() + 5_000));
      await this.jobs.schedule('reconcile', new Date(Date.now() + 10_000));
    });
    every(this.options.env.AGENT_HEARTBEAT_INTERVAL_MS, () => this.hub.pingAll());

    this.options.log.info(
      {
        workerId: this.dispatcher.workerId,
        pollIntervalMs: this.options.env.WORKER_POLL_INTERVAL_MS,
        retryWindowMs: this.options.env.COPY_RETRY_WINDOW_MS,
      },
      'copy engine started',
    );
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
    await this.dispatcher.stop();
    this.options.log.info('copy engine stopped');
  }

  /** Exposed for the test callback used by integration tests and the simulator. */
  async feedMasterPositions(accountId: string, positions: readonly Position[]): Promise<void> {
    await this.pipeline.onPositions(accountId, positions, true);
  }

  async feedClosedTrade(accountId: string, trade: ClosedTradeLike): Promise<void> {
    await this.pipeline.onClosedTrade(accountId, trade);
  }

  private handleAgentStatus(agentId: string, status: 'connected' | 'disconnected'): void {
    this.options.log.info({ agentId, status }, 'agent status changed');
    if (status === 'connected') {
      // Reconnect is the moment the engine's view of the slave side may be
      // stale: reconcile shortly after the agent has pushed fresh state.
      void this.jobs.schedule('reconcile', new Date(Date.now() + 5_000)).catch(() => undefined);
    }
  }
}

export function createEngine(options: EngineOptions): CopyEngine {
  return new CopyEngine(options);
}
