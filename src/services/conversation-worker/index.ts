/**
 * `@zeddev/conversation-worker` — consumes stored inbound messages, groups them
 * into turns, and records one answer per turn. The domain rules live in
 * `@zeddev/conversation`; this package is configuration, startup, and shutdown.
 */

export { loadWorkerSettings, WORKER_CONFIG_SCHEMA, type WorkerConfig, type WorkerSettings } from './config.ts';
export { startWorker, type RunningWorker, type StartWorkerOptions } from './start.ts';
