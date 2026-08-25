/**
 * `@zeddev/queue` — durable, tenant-fair background work.
 *
 * The queue is where three otherwise-unrelated spec requirements meet, which is
 * why it is a library rather than something each service arranges for itself.
 *
 * `message-delivery-reliability.md` requires that an inbound notification be
 * acknowledged "promptly and independently of how long generating a reply takes"
 * (AC1). That forces the split between accepting a message and processing it, and
 * the thing in the middle of that split is this. It then requires the message
 * survive a worker restart (AC6), be processed in the order the end-customer sent
 * it (AC5), be retried with backoff and eventually recorded as failed rather than
 * dropped (AC8), and — the requirement most easily missed — that one tenant's
 * backlog not delay another's (AC16).
 *
 * `cost-efficient-operation.md` rules out the two obvious ways to satisfy that
 * last one. A dedicated broker is tenant-independent fixed cost (AC6); a queue
 * per tenant is per-tenant fixed infrastructure. What is left is fair scheduling
 * inside shared capacity, on the store that already exists.
 *
 * `tenant-data-isolation.md` then constrains how that scheduling may be
 * implemented, because a worker must choose a job before it knows whose job it
 * is, and a cross-tenant context must not be able to read message content. The
 * answer is in the migration: routing metadata and payload are separate tables,
 * and only the first carries a policy the dispatch scope can satisfy.
 *
 * See `types.ts` for the guarantees, `postgres.ts` for how dispatch achieves
 * them, and `conformance.ts` for the suite that holds the fake to the same
 * standard.
 */

export {
  DEFAULT_BACKOFF,
  exponentialBackoff,
  type Backoff,
  type ExponentialBackoffOptions,
} from './backoff.ts';
export { runConsumer, type ConsumerOptions, type JobHandler } from './consumer.ts';
export { PostgresQueue, type PostgresQueueOptions } from './postgres.ts';
export {
  assertQueueName,
  digestKey,
  JOB_OUTCOMES,
  type ClaimedJob,
  type ClaimOptions,
  type EnqueueRequest,
  type EnqueueResult,
  type FailOptions,
  type JobOutcome,
  type JsonValue,
  type Queue,
  type QueueDepth,
} from './types.ts';
