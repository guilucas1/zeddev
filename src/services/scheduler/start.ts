/**
 * Bringing the scheduler up, and taking it down again cleanly.
 *
 * The same contract as the other services' `start.ts`: every configuration key
 * reported at once, refuse a database role that bypasses row-level security, migrate
 * (advisory-locked, so the services converge whichever starts first), and only then
 * start working.
 *
 * It listens on no port and nothing depends on it being up. While it is down,
 * interrupted connections stay `reconnecting` (which keeps their bots on) and old
 * jobs wait to be deleted; both catch up when it returns
 * (`component-independence.md`). Running two is safe: see `schedule.ts`.
 */

import { loadAll, loadConfig, type RawEnv } from '@zeddev/config';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig, type Pool } from '@zeddev/db';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { purgeExpiredMetrics } from '@zeddev/monitoring';
import { PostgresQueue } from '@zeddev/queue';
import { migrateToLatest } from '@zeddev/schema';
import { exponentialBackoff, SystemClock, type Clock } from '@zeddev/time';
import { loadSealer } from '@zeddev/vault';
import {
  GraphWhatsAppCloud,
  INBOUND_QUEUE,
  loadGraphCloudSettings,
  sweepConnectionRecovery,
  type RecoveryPolicy,
  type WhatsAppCloud,
} from '@zeddev/whatsapp';
import { loadSchedulerSettings, type SchedulerSettings } from './config.ts';
import { runSchedule } from './schedule.ts';

/** Half of each recovery wait is randomised, so what was interrupted together does not retry together. */
const RECOVERY_JITTER = 0.5;

export interface StartSchedulerOptions {
  readonly sink?: LogSink | undefined;
  readonly clock?: Clock | undefined;
  /** Replaces the Cloud API. Tests only; the configuration is still required and validated. */
  readonly cloud?: WhatsAppCloud | undefined;
}

export interface RunningScheduler {
  readonly pool: Pool;
  readonly settings: SchedulerSettings;
  /** Stop starting work, let what is in flight finish within the grace period, release everything. Idempotent. */
  stop(): Promise<void>;
}

export async function startScheduler(
  env: RawEnv = process.env,
  options: StartSchedulerOptions = {},
): Promise<RunningScheduler> {
  const [database, settings, logging, sealer, cloudSettings] = loadAll([
    () => loadDatabaseConfig(env),
    () => loadSchedulerSettings(env),
    () => loadConfig(LOGGING_CONFIG_SCHEMA, env),
    () => loadSealer(env),
    () => loadGraphCloudSettings(env),
  ] as const);

  const logger = new Logger({
    level: logging.LOG_LEVEL,
    bindings: { service: 'scheduler' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  const clock = options.clock ?? new SystemClock();
  const pool = createPool(database, { applicationName: 'zeddev-scheduler' });

  try {
    await assertTenantIsolationEnforceable(pool, { logger });
    await migrateToLatest(pool, { logger });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const cloud = options.cloud ?? new GraphWhatsAppCloud(cloudSettings);
  const policy: RecoveryPolicy = {
    maxAttempts: settings.reconnectMaxAttempts,
    backoff: exponentialBackoff({
      baseMs: settings.reconnectBaseDelayMs,
      maxMs: settings.reconnectMaxDelayMs,
      jitter: RECOVERY_JITTER,
    }),
  };
  // Never waited on, so it holds no notification connection; `close` is a formality.
  const queue = new PostgresQueue({ name: INBOUND_QUEUE, pool, logger });

  const controller = new AbortController();
  const schedule = runSchedule({
    signal: controller.signal,
    clock,
    logger,
    tasks: [
      {
        name: 'connection-recovery',
        intervalMs: settings.reconnectIntervalMs,
        run: async (signal) => {
          await sweepConnectionRecovery({ pool, cloud, sealer, policy, logger, signal });
        },
      },
      {
        name: 'job-purge',
        intervalMs: settings.jobPurgeIntervalMs,
        run: async () => {
          const count = await queue.purgeSucceeded(settings.jobRetentionMs);
          if (count > 0) logger.info('scheduler.jobs.purged', { queue: queue.name, count });
        },
      },
      {
        name: 'metric-purge',
        intervalMs: settings.metricPurgeIntervalMs,
        run: async () => {
          const count = await purgeExpiredMetrics(pool, clock.now());
          if (count > 0) logger.info('scheduler.metrics.purged', { count });
        },
      },
    ],
  });
  logger.info('scheduler.started');

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('scheduler.stopping', { windowMs: settings.shutdownGraceMs });
      controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        schedule.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), settings.shutdownGraceMs);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) logger.warn('scheduler.stop.grace_expired', { windowMs: settings.shutdownGraceMs });
      await queue.close().catch((error: unknown) => logger.error('scheduler.stop.queue_failed', error));
      await pool.end().catch((error: unknown) => logger.error('scheduler.stop.pool_failed', error));
      logger.info('scheduler.stopped');
    })();
    return stopping;
  };

  return { pool, settings, stop };
}
