/**
 * `@zeddev/scheduler` — the platform's timer-driven work. The domain rules live in
 * the libraries it calls; this package is configuration, the loop, startup, and
 * shutdown.
 */

export {
  loadSchedulerSettings,
  SCHEDULER_CONFIG_SCHEMA,
  type SchedulerConfig,
  type SchedulerSettings,
} from './config.ts';
export { runSchedule, type ScheduledTask } from './schedule.ts';
export { startScheduler, type RunningScheduler, type StartSchedulerOptions } from './start.ts';
