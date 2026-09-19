/**
 * The conversation worker's environment schema.
 *
 * Two kinds of key live here. The aggregation window and maximum turn duration
 * are `message-burst-aggregation.md`'s "configurable duration with a sensible
 * platform default" — platform-wide for v1, per that spec's own assumption. The
 * rest size the consumer: how many jobs this process runs at once, and how many
 * of one tenant's may be in flight, which is what keeps one tenant's surge from
 * occupying every worker (`message-delivery-reliability.md` AC16).
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError } from '@zeddev/errors';

export const WORKER_CONFIG_SCHEMA = {
  WORKER_AGGREGATION_WINDOW: {
    type: 'duration',
    description:
      "How long the worker waits after an end-customer's latest message for another before answering them. Messages arriving within it of each other are one turn and get one reply (message-burst-aggregation.md). Longer lets a customer finish a thought split across messages; shorter answers sooner. Every reply waits at least this long.",
    default: 5_000,
    min: 500,
    max: 60_000,
  },
  WORKER_MAX_TURN_DURATION: {
    type: 'duration',
    description:
      'The longest one turn stays open after its first message, however quickly more keep arriving, so a customer who never pauses is still answered. Must be at least WORKER_AGGREGATION_WINDOW.',
    default: 30_000,
    min: 1_000,
    max: 300_000,
  },
  WORKER_CONCURRENCY: {
    type: 'integer',
    description:
      'Jobs this process runs at once. Most of a job is waiting on the AI provider, so this can exceed the CPU count; the database pool must have room for it plus one connection held for queue notifications.',
    default: 4,
    min: 1,
    max: 64,
  },
  WORKER_MAX_IN_FLIGHT_PER_TENANT: {
    type: 'integer',
    description:
      "How many of one tenant's jobs may run at once across every worker. Keeps one business's traffic surge, or a provider hang on its requests, from occupying every worker while other businesses' customers wait (message-delivery-reliability.md AC16). Set it below WORKER_CONCURRENCY times the number of worker processes.",
    default: 2,
    min: 1,
    max: 64,
  },
  WORKER_VISIBILITY_TIMEOUT: {
    type: 'duration',
    description:
      'How long a claimed job is held before another worker may take it over. The worker renews it while a job runs, so this bounds how long the job of a worker that died stays stuck, not how long a slow AI call may take.',
    default: 60_000,
    min: 10_000,
    max: 600_000,
  },
  WORKER_SHUTDOWN_GRACE: {
    type: 'duration',
    description:
      'On a stop signal, how long in-flight jobs are given to finish before the process exits. One cut short is not lost: its lease expires and it runs again, and a turn is answered at most once however many times its job runs.',
    default: 30_000,
    min: 0,
  },
} as const satisfies ConfigSchema;

export type WorkerConfig = Config<typeof WORKER_CONFIG_SCHEMA>;

export interface WorkerSettings {
  readonly aggregationWindowMs: number;
  readonly maxTurnDurationMs: number;
  readonly concurrency: number;
  readonly maxInFlightPerTenant: number;
  readonly visibilityTimeoutMs: number;
  readonly shutdownGraceMs: number;
}

export function loadWorkerSettings(env: RawEnv = process.env): WorkerSettings {
  const config = loadConfig(WORKER_CONFIG_SCHEMA, env);
  if (config.WORKER_MAX_TURN_DURATION < config.WORKER_AGGREGATION_WINDOW) {
    // Each value is valid alone; together a turn would have to close before its
    // first quiet period could end, which makes the window meaningless.
    throw new ConfigurationError([
      { key: 'WORKER_MAX_TURN_DURATION', reason: 'must be at least WORKER_AGGREGATION_WINDOW' },
    ]);
  }
  return {
    aggregationWindowMs: config.WORKER_AGGREGATION_WINDOW,
    maxTurnDurationMs: config.WORKER_MAX_TURN_DURATION,
    concurrency: config.WORKER_CONCURRENCY,
    maxInFlightPerTenant: config.WORKER_MAX_IN_FLIGHT_PER_TENANT,
    visibilityTimeoutMs: config.WORKER_VISIBILITY_TIMEOUT,
    shutdownGraceMs: config.WORKER_SHUTDOWN_GRACE,
  };
}
