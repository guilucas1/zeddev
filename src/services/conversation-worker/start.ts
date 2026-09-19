/**
 * Bringing the conversation worker up, and taking it down again cleanly.
 *
 * The same contract as the API's and the gateway's `start.ts`: every
 * configuration key reported at once (`environment-portability.md` AC7); refuse a
 * database role that bypasses row-level security, because every turn is read and
 * written under a tenant binding that such a role would ignore; migrate
 * (advisory-locked, so the three services converge whichever starts first); and
 * only then start claiming work.
 *
 * The worker listens on no port. Its only input is the queue, which is what makes
 * it independently deployable and scalable (`component-independence.md`): a
 * second worker process is a second consumer of the same queue, and the queue's
 * leases and the conversation lock keep them from answering anything twice.
 */

import { createAiProvider, loadAiSettings, type AiProvider } from '@zeddev/ai';
import { loadAll, loadConfig, type RawEnv } from '@zeddev/config';
import { conversationHandlers } from '@zeddev/conversation';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig, type Pool } from '@zeddev/db';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { PostgresQueue, runConsumer } from '@zeddev/queue';
import { migrateToLatest } from '@zeddev/schema';
import { SystemClock, type Clock } from '@zeddev/time';
import { INBOUND_QUEUE } from '@zeddev/whatsapp';
import { loadWorkerSettings, type WorkerSettings } from './config.ts';

export interface StartWorkerOptions {
  readonly sink?: LogSink | undefined;
  /** Replaces the configured provider. Tests only; the configuration is still required and validated. */
  readonly ai?: AiProvider | undefined;
  readonly clock?: Clock | undefined;
  /** Longest the consumer sleeps with nothing to do. Tests shorten it. */
  readonly idleWaitMs?: number | undefined;
}

export interface RunningWorker {
  readonly pool: Pool;
  readonly settings: WorkerSettings;
  /** Stop claiming, let in-flight jobs finish within the grace period, release everything. Idempotent. */
  stop(): Promise<void>;
}

export async function startWorker(env: RawEnv = process.env, options: StartWorkerOptions = {}): Promise<RunningWorker> {
  const [database, ai, settings, logging] = loadAll([
    () => loadDatabaseConfig(env),
    () => loadAiSettings(env),
    () => loadWorkerSettings(env),
    () => loadConfig(LOGGING_CONFIG_SCHEMA, env),
  ] as const);

  const logger = new Logger({
    level: logging.LOG_LEVEL,
    bindings: { service: 'conversation-worker' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  const clock = options.clock ?? new SystemClock();
  const pool = createPool(database, { applicationName: 'zeddev-conversation-worker' });

  try {
    await assertTenantIsolationEnforceable(pool, { logger });
    await migrateToLatest(pool, { logger });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const provider = options.ai ?? createAiProvider(ai);
  const queue = new PostgresQueue({
    name: INBOUND_QUEUE,
    pool,
    logger,
    visibilityTimeoutMs: settings.visibilityTimeoutMs,
  });
  const handlers = conversationHandlers({
    pool,
    provider,
    scheduler: queue,
    policy: { windowMs: settings.aggregationWindowMs, maxTurnMs: settings.maxTurnDurationMs },
    clock,
    logger,
  });

  const controller = new AbortController();
  const consumer = runConsumer({
    queue,
    handlers,
    signal: controller.signal,
    concurrency: settings.concurrency,
    maxInFlightPerTenant: settings.maxInFlightPerTenant,
    visibilityTimeoutMs: settings.visibilityTimeoutMs,
    ...(options.idleWaitMs === undefined ? {} : { idleWaitMs: options.idleWaitMs }),
    logger,
  }).catch((error: unknown) => {
    logger.error('worker.consumer.failed', error);
  });
  logger.info('worker.started', { provider: provider.descriptor.provider, model: provider.descriptor.model });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('worker.stopping', { windowMs: settings.shutdownGraceMs });
      controller.abort();
      let timer: NodeJS.Timeout | undefined;
      const drained = await Promise.race([
        consumer.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), settings.shutdownGraceMs);
        }),
      ]);
      clearTimeout(timer);
      if (!drained) logger.warn('worker.stop.grace_expired', { windowMs: settings.shutdownGraceMs });
      await queue.close().catch((error: unknown) => logger.error('worker.stop.queue_failed', error));
      await pool.end().catch((error: unknown) => logger.error('worker.stop.pool_failed', error));
      logger.info('worker.stopped');
    })();
    return stopping;
  };

  return { pool, settings, stop };
}
