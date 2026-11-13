/**
 * The consumer loop.
 *
 * Lives in the library rather than in each service because three of the things it
 * does are easy to get subtly wrong and expensive when they are.
 *
 * **It never polls when it can wait.** `cost-efficient-operation.md` AC6 wants an
 * idle platform to cost nothing, and a loop that asks the database for work once
 * a second is a small permanent cost paid by every deployment, including one with
 * no tenants. `waitForWork` blocks on `LISTEN` in the real adapter, so an idle
 * consumer performs no queries at all.
 *
 * **It heartbeats while a handler runs.** The single most damaging failure this
 * queue can produce is a lease expiring under a handler that is still working:
 * the job is handed to a second worker, and for a reply-generating handler that
 * is a duplicate reply to an end customer, which
 * `message-delivery-reliability.md` AC7 forbids. AI calls are slow and their
 * latency is not under this platform's control, so the visibility timeout cannot
 * simply be set high enough — raising it for everyone also raises how long a
 * genuinely dead worker's job sits stuck. Heartbeating decouples the two.
 *
 * **It routes a failure by the error's own retryability.** `@zeddev/errors` makes
 * retryability a property of the type, and honouring it here is what stops a
 * malformed job or a terminal upstream rejection from consuming its full retry
 * allowance to reach the conclusion its type already stated.
 */

import { DefectError } from '@zeddev/errors';
import type { Logger } from '@zeddev/logging';
import { SystemClock, type Clock } from '@zeddev/time';
import type { ClaimedJob, Queue } from './types.ts';

export type JobHandler = (job: ClaimedJob) => Promise<void>;

export interface ConsumerOptions {
  readonly queue: Queue;
  /** Keyed by `ClaimedJob.kind`. A job whose kind is absent is dead-lettered, not retried. */
  readonly handlers: Readonly<Record<string, JobHandler>>;
  /** Stops the loop. The loop drains in-flight work before returning. */
  readonly signal: AbortSignal;
  /** Jobs this process runs at once. */
  readonly concurrency?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  /** See `ClaimOptions.maxInFlightPerTenant` — the AC16 cap. */
  readonly maxInFlightPerTenant?: number | undefined;
  /**
   * Longest the loop sleeps with nothing to do.
   *
   * Not a poll interval in the usual sense: work normally arrives as a
   * notification and the sleep ends early. This is the backstop that reaches
   * delayed jobs, whose `run_at` is in the future and which therefore notify
   * nobody when they become due.
   */
  readonly idleWaitMs?: number | undefined;
  /**
   * How often a busy loop sweeps expired leases back into the ready pool. An idle
   * loop also sweeps before every sleep, and its sleep ends when the next lease
   * runs out, so a job whose worker died is taken over as soon as its lease ends.
   */
  readonly reclaimIntervalMs?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
}

/**
 * Run until `signal` aborts, then drain.
 *
 * Draining rather than abandoning matters for `component-independence.md` AC2: a
 * planned restart of the worker should not turn in-flight jobs into lease
 * expiries that a second worker then re-runs.
 */
export async function runConsumer(options: ConsumerOptions): Promise<void> {
  const { queue, handlers, signal } = options;
  const clock = options.clock ?? new SystemClock();
  const logger = options.logger;
  const concurrency = options.concurrency ?? 1;
  const idleWaitMs = options.idleWaitMs ?? 30_000;
  const reclaimIntervalMs = options.reclaimIntervalMs ?? 30_000;
  const visibilityTimeoutMs = options.visibilityTimeoutMs;

  const inFlight = new Set<Promise<void>>();
  let lastReclaimAt = -Infinity;

  const claimOptions = {
    ...(visibilityTimeoutMs === undefined ? {} : { visibilityTimeoutMs }),
    ...(options.maxInFlightPerTenant === undefined
      ? {}
      : { maxInFlightPerTenant: options.maxInFlightPerTenant }),
  };

  /** Returns how many jobs came back, so an idle loop can look again rather than sleep. */
  const sweep = async (): Promise<number> => {
    lastReclaimAt = clock.monotonicMs();
    try {
      return await queue.reclaimExpired();
    } catch (error) {
      logger?.error('queue.reclaim.failed', error, { queue: queue.name });
      return 0;
    }
  };

  while (!signal.aborted) {
    // Swept from the consumer rather than from a dedicated timer, so a deployment
    // with no consumer running also has nothing sweeping — there is no background
    // process whose only job is to exist.
    if (clock.monotonicMs() - lastReclaimAt >= reclaimIntervalMs) await sweep();

    if (inFlight.size >= concurrency) {
      await Promise.race(inFlight);
      continue;
    }

    let job: ClaimedJob | undefined;
    try {
      job = await queue.claim(claimOptions);
    } catch (error) {
      logger?.error('queue.claim.failed', error, { queue: queue.name });
      await sleepQuietly(clock, idleWaitMs, signal);
      continue;
    }

    if (job === undefined) {
      // Nothing claimable. Before sleeping, take back any job whose worker died:
      // `waitForWork` wakes this loop when a lease runs out, and the wake would be
      // wasted if the periodic sweep were not due yet — the job would sit until it
      // was, up to `reclaimIntervalMs` after its lease had already made a customer
      // wait (component-independence.md AC7). Only a look that found nothing pays this query.
      if ((await sweep()) > 0) continue;
      await waitForSomething(queue, inFlight, idleWaitMs, signal);
      continue;
    }

    const running = runJob(job).finally(() => inFlight.delete(running));
    inFlight.add(running);
  }

  await Promise.allSettled([...inFlight]);

  async function runJob(job: ClaimedJob): Promise<void> {
    const handler = handlers[job.kind];
    if (handler === undefined) {
      // Non-retryable by construction: a kind this process does not know will
      // still be unknown on the next attempt, so spending the retry allowance to
      // discover that is pure delay. `fail` reads the error's retryability and
      // dead-letters it immediately.
      const error = new DefectError('no handler registered for this job kind', {
        code: 'queue.unknown_kind',
        context: { queue: queue.name, tenantId: job.tenantId, jobId: job.id },
      });
      logger?.error('queue.handler.missing', error, {
        queue: queue.name,
        tenantId: job.tenantId,
        jobId: job.id,
      });
      await queue.fail(job, error);
      return;
    }

    const stopHeartbeat = startHeartbeat(job);
    const startedAt = clock.monotonicMs();
    try {
      await handler(job);
      await queue.complete(job);
      logger?.debug('queue.job.succeeded', {
        queue: queue.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
        durationMs: clock.monotonicMs() - startedAt,
      });
    } catch (error) {
      // Logged here as well as inside `fail`, because the two records answer
      // different questions: this one says a handler raised, that one says what
      // the queue decided to do about it.
      logger?.error('queue.handler.failed', error, {
        queue: queue.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
        durationMs: clock.monotonicMs() - startedAt,
      });
      try {
        await queue.fail(job, error);
      } catch (failure) {
        // Nothing further to do: the lease will expire and the job returns to the
        // ready pool on its own. Recorded so the double failure is visible.
        logger?.error('queue.fail.failed', failure, {
          queue: queue.name,
          tenantId: job.tenantId,
          jobId: job.id,
        });
      }
    } finally {
      stopHeartbeat();
    }
  }

  function startHeartbeat(job: ClaimedJob): () => void {
    // A third of the lease: two consecutive heartbeats can be lost — to a blip,
    // to event-loop starvation — before the lease is actually at risk.
    const interval = Math.max(Math.floor((visibilityTimeoutMs ?? 60_000) / 3), 1000);
    let cancel = (): void => {};
    let stopped = false;

    const schedule = (): void => {
      cancel = clock.setTimer(interval, () => {
        if (stopped) return;
        void queue
          .heartbeat(job)
          .then((held) => {
            if (!held) {
              // The lease is gone, so this job now belongs to another worker.
              // Nothing can be done about the duplicate work already in progress;
              // what matters is that it is visible, because a rising count of
              // these means the visibility timeout is set too short.
              logger?.warn('queue.heartbeat.lease_lost', {
                queue: queue.name,
                tenantId: job.tenantId,
                jobId: job.id,
                attempt: job.attempt,
              });
              return;
            }
            if (!stopped) schedule();
          })
          .catch((error: unknown) => {
            logger?.error('queue.heartbeat.failed', error, {
              queue: queue.name,
              tenantId: job.tenantId,
              jobId: job.id,
            });
          });
      });
    };
    schedule();

    return () => {
      stopped = true;
      cancel();
    };
  }
}

/**
 * Wait for either a notification or an in-flight job to finish.
 *
 * Both are reasons to look again: a notification means new work, and a finishing
 * job means a slot opened for work that was already there but capped out.
 */
async function waitForSomething(
  queue: Queue,
  inFlight: ReadonlySet<Promise<void>>,
  idleWaitMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (inFlight.size === 0) {
    await queue.waitForWork(idleWaitMs, signal);
    return;
  }
  // The wait is aborted once the race is decided, so its timer is released rather
  // than left to fire into a loop iteration that has long since moved on.
  const local = new AbortController();
  const linked = AbortSignal.any([signal, local.signal]);
  try {
    await Promise.race([...inFlight, queue.waitForWork(idleWaitMs, linked)]);
  } finally {
    local.abort();
  }
}

async function sleepQuietly(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  try {
    await clock.sleep(ms, { signal });
  } catch {
    // Aborted. The loop condition handles it.
  }
}
