/**
 * Running timer-driven work.
 *
 * Each task has its own loop, so a slow one cannot delay another: a recovery sweep
 * stuck behind a Meta outage must not also stop old jobs being purged.
 *
 * The wait starts when a run finishes rather than when it started, so a task can
 * never overlap itself however long a run takes.
 *
 * A failed run is logged and tried again at the next interval, because every task
 * here is a sweep: what it did not get to is still there next time, and a database
 * blip must not end a process nothing is watching.
 *
 * Tasks must tolerate running concurrently in other scheduler instances. That is
 * asked of the tasks rather than solved here with a leader lock, since a leader is
 * one more thing that has to fail over (`component-independence.md`).
 */

import type { Logger } from '@zeddev/logging';
import type { Clock } from '@zeddev/time';

export interface ScheduledTask {
  /** Names the task in logs. */
  readonly name: string;
  readonly intervalMs: number;
  run(signal: AbortSignal): Promise<void>;
}

/** Run every task at once on start, then each on its interval, until `signal` aborts. */
export async function runSchedule(options: {
  readonly tasks: readonly ScheduledTask[];
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly logger?: Logger | undefined;
}): Promise<void> {
  const { signal, clock, logger } = options;
  await Promise.all(
    options.tasks.map(async (task) => {
      while (!signal.aborted) {
        try {
          await task.run(signal);
        } catch (error) {
          logger?.error('scheduler.task.failed', error, { component: task.name });
        }
        await clock.sleep(task.intervalMs, { signal }).catch(() => undefined);
      }
    }),
  );
}
