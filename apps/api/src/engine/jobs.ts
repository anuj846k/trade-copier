import type { FastifyBaseLogger } from 'fastify';
import type { JobRecord, Repositories } from '@trade-copier/db';

/**
 * Durable job runner.
 *
 * Periodic work that must survive a restart (pruning, reconciliation, daily
 * resets) goes through the `jobs` table: rows are claimed with
 * `FOR UPDATE SKIP LOCKED`, retried with the job's own attempt budget and are
 * deduplicated by `dedupeKey`, so several worker processes can run the same
 * schedule without coordination.
 */
export type JobHandler = (job: JobRecord) => Promise<void>;

export interface JobRunnerDeps {
  readonly repos: Repositories;
  readonly log: FastifyBaseLogger;
  readonly workerId: string;
  readonly handlers: Readonly<Record<string, JobHandler>>;
  readonly now?: (() => Date) | undefined;
}

export class JobRunner {
  constructor(private readonly deps: JobRunnerDeps) {}

  /** Registers (or re-arms) a singleton job. Safe to call from any process. */
  async schedule(kind: string, runAt: Date, payload: Record<string, unknown> = {}): Promise<void> {
    await this.deps.repos.platform.enqueueJob({ kind, payload, runAt, dedupeKey: kind, replaceDedupe: true });
  }

  async tick(limit = 5): Promise<number> {
    const jobs = await this.deps.repos.platform.claimJobs(this.deps.workerId, limit);
    for (const job of jobs) {
      const handler = this.deps.handlers[job.kind];
      if (!handler) {
        await this.deps.repos.platform.completeJob(job.id, { failed: true, error: `no handler for job kind ${job.kind}` });
        this.deps.log.warn({ kind: job.kind }, 'unhandled job kind');
        continue;
      }
      try {
        await handler(job);
        await this.deps.repos.platform.completeJob(job.id, {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = job.attempts + 1;
        if (attempts >= job.maxAttempts) {
          await this.deps.repos.platform.completeJob(job.id, { failed: true, error: message });
          this.deps.log.error({ err: error, jobId: job.id, kind: job.kind }, 'job failed permanently');
        } else {
          const backoffMs = Math.min(15 * 60_000, 5_000 * 2 ** attempts);
          await this.deps.repos.platform.requeueJob(job.id, new Date(Date.now() + backoffMs), message);
          this.deps.log.warn({ err: error, jobId: job.id, kind: job.kind, attempts }, 'job requeued');
        }
      }
    }
    return jobs.length;
  }
}
