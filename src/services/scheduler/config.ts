/**
 * The scheduler's environment schema.
 *
 * `whatsapp-number-connection.md` leaves the reconnection bound to implementation
 * ("a reasonable, bounded number of automatic reconnection attempts"), so the bound
 * is here. The defaults lean generous because of what the far side of it is: `error`
 * switches the client's bot off and stays that way until they reconnect by hand, so
 * giving up too early during an ordinary Meta incident costs far more than a few
 * extra read-only probes.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError } from '@zeddev/errors';

export const SCHEDULER_CONFIG_SCHEMA = {
  SCHEDULER_RECONNECT_INTERVAL: {
    type: 'duration',
    description:
      'How often the scheduler looks for interrupted WhatsApp connections that are due another recovery attempt. This is one indexed query, and it is the longest an interrupted connection waits for its first attempt.',
    default: 60_000,
    min: 1_000,
    max: 3_600_000,
  },
  SCHEDULER_RECONNECT_MAX_ATTEMPTS: {
    type: 'integer',
    description:
      "How many recovery attempts may fail for a recoverable reason before the connection falls to error, which switches the client's bot off until they reconnect the number (whatsapp-number-connection.md AC6). With the default delays, twelve attempts span roughly three hours, enough to ride out an ordinary Meta incident. A failure Meta says retrying cannot fix, such as a revoked token, goes to error immediately regardless.",
    default: 12,
    min: 1,
    max: 1_000,
  },
  SCHEDULER_RECONNECT_BASE_DELAY: {
    type: 'duration',
    description:
      'The wait after the first failed recovery attempt, doubling after each failure up to SCHEDULER_RECONNECT_MAX_DELAY. Half of each wait is randomised, so tenants interrupted together do not retry together. Keep it longer than an attempt can take (a few WHATSAPP_REQUEST_TIMEOUTs), or a second scheduler instance may start one while the last is still out.',
    default: 60_000,
    min: 1_000,
  },
  SCHEDULER_RECONNECT_MAX_DELAY: {
    type: 'duration',
    description: 'The longest wait between recovery attempts. Must be at least SCHEDULER_RECONNECT_BASE_DELAY.',
    default: 1_800_000,
    min: 1_000,
  },
  SCHEDULER_JOB_PURGE_INTERVAL: {
    type: 'duration',
    description: 'How often finished jobs past SCHEDULER_JOB_RETENTION are deleted from the job queue.',
    default: 3_600_000,
    min: 60_000,
  },
  SCHEDULER_JOB_RETENTION: {
    type: 'duration',
    description:
      'How long a job that succeeded is kept before deletion. Its enqueue deduplication ends with it, so this must comfortably exceed how long Meta may keep redelivering a webhook. Longer costs database space and shorter gains little: a job holds routing metadata only, its payload having gone when it finished. Jobs that exhausted their retries are never deleted by this; they are the record of a failure.',
    default: 604_800_000,
    min: 3_600_000,
  },
  SCHEDULER_SHUTDOWN_GRACE: {
    type: 'duration',
    description:
      'On a stop signal, how long in-flight work is given to finish before the process exits. Nothing cut short is lost: a recovery attempt that never reported back has spent none of the allowance and simply runs again.',
    default: 30_000,
    min: 0,
  },
} as const satisfies ConfigSchema;

export type SchedulerConfig = Config<typeof SCHEDULER_CONFIG_SCHEMA>;

export interface SchedulerSettings {
  readonly reconnectIntervalMs: number;
  readonly reconnectMaxAttempts: number;
  readonly reconnectBaseDelayMs: number;
  readonly reconnectMaxDelayMs: number;
  readonly jobPurgeIntervalMs: number;
  readonly jobRetentionMs: number;
  readonly shutdownGraceMs: number;
}

export function loadSchedulerSettings(env: RawEnv = process.env): SchedulerSettings {
  const config = loadConfig(SCHEDULER_CONFIG_SCHEMA, env);
  if (config.SCHEDULER_RECONNECT_MAX_DELAY < config.SCHEDULER_RECONNECT_BASE_DELAY) {
    throw new ConfigurationError([
      { key: 'SCHEDULER_RECONNECT_MAX_DELAY', reason: 'must be at least SCHEDULER_RECONNECT_BASE_DELAY' },
    ]);
  }
  return {
    reconnectIntervalMs: config.SCHEDULER_RECONNECT_INTERVAL,
    reconnectMaxAttempts: config.SCHEDULER_RECONNECT_MAX_ATTEMPTS,
    reconnectBaseDelayMs: config.SCHEDULER_RECONNECT_BASE_DELAY,
    reconnectMaxDelayMs: config.SCHEDULER_RECONNECT_MAX_DELAY,
    jobPurgeIntervalMs: config.SCHEDULER_JOB_PURGE_INTERVAL,
    jobRetentionMs: config.SCHEDULER_JOB_RETENTION,
    shutdownGraceMs: config.SCHEDULER_SHUTDOWN_GRACE,
  };
}
