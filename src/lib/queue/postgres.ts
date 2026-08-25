/**
 * The real adapter: a job queue carried by the platform's own PostgreSQL.
 *
 * ## Why the dispatch query looks the way it does
 *
 * The naive dequeue — `SELECT ... WHERE state = 'ready' ORDER BY seq LIMIT 1 FOR
 * UPDATE SKIP LOCKED` — is three lines and violates a spec requirement outright.
 * `message-delivery-reliability.md` AC16 says one tenant's backlog must not
 * affect another tenant's latency, and a global FIFO puts ten thousand of one
 * tenant's queued jobs in front of everyone else's next message. So dispatch is
 * built in layers, each closing one requirement:
 *
 *   1. **Which tenants are eligible** — those with ready work in this queue, and
 *      (if a cap is configured) not already at their in-flight limit. Read from
 *      `queue_dispatch_cursors`, which has one row per active (queue, tenant), so
 *      this is a scan of tenants rather than of jobs.
 *   2. **Whose turn it is** — lowest `last_dispatch_seq` first. A tenant just
 *      served goes to the back of the line.
 *   3. **Which of that tenant's jobs** — lowest `seq` that is not blocked by an
 *      earlier unfinished job in the same partition. That anti-join is what makes
 *      per-end-customer ordering (AC5) a property of the queue rather than
 *      something every handler has to re-derive.
 *   4. **Which one we can actually have** — `FOR UPDATE ... SKIP LOCKED` over a
 *      shortlist rather than over a single row, so concurrent workers do not all
 *      contend for the same job and return empty-handed while work is waiting.
 *
 * The cost of step 1 is proportional to the number of tenants with active work,
 * not to queue depth. That is deliberate and it is the right trade for a platform
 * whose premise is low tenant volume; a deployment with thousands of active
 * tenants would want the cursor scan bounded, and that is a change to this query
 * alone.
 *
 * ## Why a claim is one transaction spanning two scopes
 *
 * A worker cannot bind a tenant it has not yet discovered, so the claim runs
 * under `app.dispatch_scope`, which sees routing metadata across tenants. The
 * payload is not routing metadata, so it lives in a table that scope cannot
 * reach; reading it requires binding the tenant the claim just revealed. Doing
 * both inside one transaction means a claimed job always arrives with its
 * payload — the alternative leaves a window where a job is marked running and
 * nobody ever read what it was, which the lease would eventually recover from at
 * the cost of a wasted attempt.
 */

import { DefectError, toDiagnostic } from '@zeddev/errors';
import {
  bindTenantContext,
  withDispatchScope,
  withTenant,
  type Connection,
  type Pool,
} from '@zeddev/db';
import type { Logger } from '@zeddev/logging';
import { SystemClock, type Clock } from '@zeddev/time';
import { DEFAULT_BACKOFF, type Backoff } from './backoff.ts';
import {
  assertQueueName,
  digestKey,
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

export interface PostgresQueueOptions {
  readonly pool: Pool;
  /** Must match `^[a-z][a-z0-9_]{0,39}$`; it becomes a NOTIFY channel identifier. */
  readonly name: string;
  readonly backoff?: Backoff | undefined;
  /** Default total attempts before dead-lettering. */
  readonly maxAttempts?: number | undefined;
  /** Default lease length for a claim. */
  readonly visibilityTimeoutMs?: number | undefined;
  /**
   * How many jobs the dispatch query shortlists before locking.
   *
   * Only affects contention, never fairness: the shortlist is ordered
   * fairness-first, so with one worker the first entry is always taken. Raising
   * it helps when many workers share a queue.
   */
  readonly shortlistSize?: number | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
}

const NOTIFY_CHANNEL_PREFIX = 'zeddev_queue_';

/**
 * Ordered fairness-first, then by enqueue order.
 *
 * `rank_in_tenant` leads so the shortlist is "every eligible tenant's next job,
 * in turn order" before it is "one tenant's next several jobs" — breadth across
 * tenants is what stops concurrent workers from piling onto one tenant's backlog
 * the moment contention appears.
 */
const CLAIM_SQL = `
WITH turn AS (
  SELECT c.tenant_id, c.last_dispatch_seq
    FROM queue_dispatch_cursors c
   WHERE c.queue = $1
     AND EXISTS (
           SELECT 1 FROM queue_jobs r
            WHERE r.queue = $1 AND r.tenant_id = c.tenant_id
              AND r.state = 'ready' AND r.run_at <= now())
     AND ($3::int IS NULL OR (
           SELECT count(*) FROM queue_jobs f
            WHERE f.queue = $1 AND f.tenant_id = c.tenant_id
              AND f.state = 'running') < $3::int)
),
candidate AS (
  SELECT t.last_dispatch_seq AS cursor_seq,
         q.id,
         q.seq,
         row_number() OVER (PARTITION BY t.tenant_id ORDER BY q.seq) AS rank_in_tenant
    FROM turn t
    CROSS JOIN LATERAL (
      SELECT j.id, j.seq
        FROM queue_jobs j
       WHERE j.queue = $1
         AND j.tenant_id = t.tenant_id
         AND j.state = 'ready'
         AND j.run_at <= now()
         AND (j.partition_ref IS NULL
              OR NOT EXISTS (
                    SELECT 1 FROM queue_jobs b
                     WHERE b.tenant_id = j.tenant_id
                       AND b.queue = j.queue
                       AND b.partition_ref = j.partition_ref
                       AND b.state IN ('ready', 'running')
                       AND b.seq < j.seq))
       ORDER BY j.seq
       LIMIT $4::int
    ) q
),
shortlist AS (
  SELECT id, cursor_seq, seq, rank_in_tenant
    FROM candidate
   ORDER BY rank_in_tenant, cursor_seq, seq
   LIMIT $4::int
),
locked AS (
  SELECT j.id
    FROM queue_jobs j
    JOIN shortlist s ON s.id = j.id
   ORDER BY s.rank_in_tenant, s.cursor_seq, s.seq
     FOR UPDATE OF j SKIP LOCKED
   LIMIT 1
)
UPDATE queue_jobs j
   SET state = 'running',
       attempt = j.attempt + 1,
       started_at = now(),
       leased_until = now() + make_interval(secs => $2::double precision)
  FROM locked
 WHERE j.id = locked.id AND j.state = 'ready'
RETURNING j.id, j.tenant_id, j.kind, j.attempt, j.max_attempts, j.enqueued_at`;

interface ClaimRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly kind: string;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly enqueued_at: Date;
}

export class PostgresQueue implements Queue {
  readonly name: string;
  readonly #pool: Pool;
  readonly #backoff: Backoff;
  readonly #maxAttempts: number;
  readonly #visibilityTimeoutMs: number;
  readonly #shortlistSize: number;
  readonly #clock: Clock;
  readonly #logger: Logger | undefined;

  /**
   * A connection held out of the pool for the lifetime of the consumer.
   *
   * `LISTEN` registers against a session, so the connection cannot go back to the
   * pool — the next borrower would inherit the registration and, worse, this
   * consumer would stop hearing about work. One connection per consuming process
   * is the price of not polling, and `pool.ts` sizing must account for it.
   */
  #listener: Connection | undefined;
  /**
   * Set when a notification arrives, cleared when a wait consumes it.
   *
   * Without it there is a lost-wakeup race: a job enqueued after a claim returned
   * empty but before the wait begins would notify nobody, and the consumer would
   * sleep until its timeout with work sitting ready. Recording the edge rather
   * than waiting for one makes the wait safe to enter at any moment.
   */
  #woken = false;

  constructor(options: PostgresQueueOptions) {
    assertQueueName(options.name);
    this.name = options.name;
    this.#pool = options.pool;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
    this.#shortlistSize = options.shortlistSize ?? 8;
    this.#clock = options.clock ?? new SystemClock();
    this.#logger = options.logger;
  }

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  async enqueue(tenantId: string, request: EnqueueRequest): Promise<EnqueueResult> {
    return withTenant(this.#pool, tenantId, (tx) => this.enqueueWithin(tx, request));
  }

  /**
   * Enqueue inside a transaction the caller already opened and already bound.
   *
   * Not on the port, because it is not something a handler needs — but it is
   * exactly what the gateway needs. `message-delivery-reliability.md` AC1 and AC4
   * together require that an inbound message be recorded *and* scheduled for
   * processing as one indivisible act: record without enqueue loses the message,
   * enqueue without record loses the duplicate suppression. Sharing the caller's
   * transaction is the only way to get both.
   */
  async enqueueWithin(connection: Connection, request: EnqueueRequest): Promise<EnqueueResult> {
    const tenantId = connection.boundTenantId;
    if (tenantId === undefined) {
      throw new DefectError('enqueueWithin requires a transaction already bound to a tenant', {
        code: 'queue.unbound_enqueue',
        context: { queue: this.name },
      });
    }

    const partitionRef =
      request.partitionKey === undefined ? null : digestKey(tenantId, request.partitionKey);
    const dedupeRef = request.dedupeKey === undefined ? null : digestKey(tenantId, request.dedupeKey);

    // Created before the job rather than at first dispatch, so a tenant that has
    // never been served still appears in the fairness ordering — with a cursor of
    // zero, which puts it first in line rather than last.
    await connection.query(
      `INSERT INTO queue_dispatch_cursors (queue, tenant_id) VALUES ($1, $2)
         ON CONFLICT (queue, tenant_id) DO NOTHING`,
      [this.name, tenantId],
    );

    const inserted = await connection.query<{ id: string }>(
      `INSERT INTO queue_jobs
         (tenant_id, queue, kind, partition_ref, dedupe_ref, max_attempts, run_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::double precision))
       ON CONFLICT (tenant_id, queue, dedupe_ref) WHERE dedupe_ref IS NOT NULL DO NOTHING
       RETURNING id`,
      [
        tenantId,
        this.name,
        request.kind,
        partitionRef,
        dedupeRef,
        request.maxAttempts ?? this.#maxAttempts,
        (request.delayMs ?? 0) / 1000,
      ],
    );

    const created = inserted.rows[0];
    if (created === undefined) {
      // The only way to insert nothing is a dedupe collision. The existing job is
      // returned rather than an error thrown, because the caller's intent —
      // "ensure this work is scheduled" — is already satisfied.
      const existing = await connection.query<{ id: string }>(
        'SELECT id FROM queue_jobs WHERE tenant_id = $1 AND queue = $2 AND dedupe_ref = $3',
        [tenantId, this.name, dedupeRef],
      );
      const row = existing.rows[0];
      if (row === undefined) {
        throw new DefectError('enqueue inserted no row and found no duplicate', {
          code: 'queue.enqueue_lost',
          context: { queue: this.name, tenantId },
        });
      }
      this.#logger?.debug('queue.enqueue.deduplicated', {
        queue: this.name,
        tenantId,
        jobId: row.id,
        deduplicated: true,
      });
      return { jobId: row.id, created: false };
    }

    await connection.query(
      'INSERT INTO queue_job_payloads (job_id, tenant_id, payload) VALUES ($1, $2, $3::jsonb)',
      [created.id, tenantId, JSON.stringify(request.payload)],
    );

    this.#logger?.debug('queue.enqueue.accepted', {
      queue: this.name,
      tenantId,
      jobId: created.id,
    });
    return { jobId: created.id, created: true };
  }

  // -------------------------------------------------------------------------
  // Consuming
  // -------------------------------------------------------------------------

  async claim(options: ClaimOptions = {}): Promise<ClaimedJob | undefined> {
    const leaseMs = options.visibilityTimeoutMs ?? this.#visibilityTimeoutMs;

    return withDispatchScope(this.#pool, async (tx) => {
      const claimed = await tx.query<ClaimRow>(CLAIM_SQL, [
        this.name,
        leaseMs / 1000,
        options.maxInFlightPerTenant ?? null,
        this.#shortlistSize,
      ]);
      const row = claimed.rows[0];
      if (row === undefined) return undefined;

      // Bumped in the same transaction as the claim, so a rollback un-takes the
      // tenant's turn as well as the job. Two claims that both committed can
      // never share a cursor value, because `nextval` is outside transactional
      // rollback and strictly increasing.
      await tx.query(
        `UPDATE queue_dispatch_cursors
            SET last_dispatch_seq = nextval('queue_dispatch_seq')
          WHERE queue = $1 AND tenant_id = $2`,
        [this.name, row.tenant_id],
      );

      // From here the transaction is also bound to the job's tenant, which is the
      // only context in which the payload table is readable at all.
      await bindTenantContext(tx, row.tenant_id);
      const payload = await tx.query<{ payload: JsonValue }>(
        'SELECT payload FROM queue_job_payloads WHERE job_id = $1',
        [row.id],
      );
      const stored = payload.rows[0];
      if (stored === undefined) {
        throw new DefectError('claimed a job whose payload row is missing', {
          code: 'queue.payload_missing',
          context: { queue: this.name, jobId: row.id, tenantId: row.tenant_id },
        });
      }

      this.#logger?.debug('queue.claim.taken', {
        queue: this.name,
        tenantId: row.tenant_id,
        jobId: row.id,
        attempt: row.attempt,
      });

      return {
        id: row.id,
        tenantId: row.tenant_id,
        queue: this.name,
        kind: row.kind,
        payload: stored.payload,
        attempt: row.attempt,
        maxAttempts: row.max_attempts,
        enqueuedAt: row.enqueued_at,
      };
    });
  }

  async heartbeat(job: ClaimedJob, extendByMs?: number): Promise<boolean> {
    const result = await withDispatchScope(this.#pool, (tx) =>
      tx.query(
        `UPDATE queue_jobs
            SET leased_until = now() + make_interval(secs => $3::double precision)
          WHERE id = $1 AND state = 'running' AND attempt = $2`,
        [job.id, job.attempt, (extendByMs ?? this.#visibilityTimeoutMs) / 1000],
      ),
    );
    return result.rowCount > 0;
  }

  async complete(job: ClaimedJob): Promise<void> {
    const updated = await withDispatchScope(this.#pool, async (tx) => {
      // Matching on `attempt` as well as state is what makes a lost lease safe. A
      // worker whose lease expired while it was working has had its job taken by
      // someone else at a higher attempt number; without this clause its
      // completion would mark succeeded a job that is actively running elsewhere,
      // and the second execution's result would be silently discarded.
      const result = await tx.query(
        `UPDATE queue_jobs
            SET state = 'succeeded', finished_at = now(), leased_until = NULL
          WHERE id = $1 AND state = 'running' AND attempt = $2`,
        [job.id, job.attempt],
      );
      if (result.rowCount === 0) return false;

      // The payload dies with the work. Nothing downstream needs it, and a
      // succeeded job is retained only so `dedupeKey` keeps suppressing — which
      // needs the digest, never the content.
      await bindTenantContext(tx, job.tenantId);
      await tx.query('DELETE FROM queue_job_payloads WHERE job_id = $1', [job.id]);
      return true;
    });

    if (!updated) {
      this.#logger?.warn('queue.complete.lease_lost', {
        queue: this.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
      });
    }
  }

  async fail(job: ClaimedJob, error: unknown, options: FailOptions = {}): Promise<JobOutcome> {
    const diagnostic = toDiagnostic(error);
    const delayMs = options.retryDelayMs ?? this.#backoff(job.attempt);

    // `retryable` comes from the error's *type*, which IMPLEMENTATION_PLAN.md §4c
    // records as the taxonomy's central invariant. Honouring it here is what
    // stops a malformed job or a terminal upstream rejection from burning its
    // whole retry allowance to reach a conclusion its class already stated —
    // and, for an outbound send, from delaying the AC8 failure record by minutes.
    const terminal = !diagnostic.retryable;

    const result = await withDispatchScope(this.#pool, (tx) =>
      tx.query<{ state: string }>(
        `UPDATE queue_jobs
            SET state       = CASE WHEN $6::boolean OR attempt >= max_attempts
                                   THEN 'dead' ELSE 'ready' END,
                leased_until = NULL,
                finished_at = CASE WHEN $6::boolean OR attempt >= max_attempts
                                   THEN now() ELSE NULL END,
                run_at      = CASE WHEN $6::boolean OR attempt >= max_attempts
                                   THEN run_at
                                   ELSE now() + make_interval(secs => $3::double precision) END,
                last_error_kind = $4,
                last_error_code = $5
          WHERE id = $1 AND state = 'running' AND attempt = $2
        RETURNING state`,
        [job.id, job.attempt, delayMs / 1000, diagnostic.kind, diagnostic.code, terminal],
      ),
    );

    const row = result.rows[0];
    if (row === undefined) {
      // The lease was lost, so the job is already someone else's problem. Report
      // `retry`, because it truthfully describes what will happen to the job.
      this.#logger?.warn('queue.fail.lease_lost', {
        queue: this.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
      });
      return 'retry';
    }

    const outcome: JobOutcome = row.state === 'dead' ? 'dead' : 'retry';
    // Logged at `error` for the dead-letter case because AC8 requires the failure
    // be recorded against the tenant rather than silently discarded, and this is
    // the record. The error object is passed through `toDiagnostic` by the
    // logger, so no upstream error prose reaches the line.
    if (outcome === 'dead') {
      this.#logger?.error('queue.job.dead_lettered', error, {
        queue: this.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
        retryCount: job.attempt - 1,
      });
    } else {
      this.#logger?.warn('queue.job.retry_scheduled', {
        queue: this.name,
        tenantId: job.tenantId,
        jobId: job.id,
        attempt: job.attempt,
        retryAfterMs: delayMs,
        errorKind: diagnostic.kind,
        errorCode: diagnostic.code,
      });
    }
    return outcome;
  }

  async reclaimExpired(): Promise<number> {
    const result = await withDispatchScope(this.#pool, (tx) =>
      tx.query(
        `UPDATE queue_jobs
            SET state       = CASE WHEN attempt >= max_attempts THEN 'dead' ELSE 'ready' END,
                leased_until = NULL,
                finished_at = CASE WHEN attempt >= max_attempts THEN now() ELSE NULL END,
                run_at      = CASE WHEN attempt >= max_attempts THEN run_at ELSE now() END,
                last_error_kind = 'internal',
                last_error_code = 'queue.lease_expired'
          WHERE queue = $1 AND state = 'running' AND leased_until < now()`,
        [this.name],
      ),
    );
    if (result.rowCount > 0) {
      // Worth a log line at warn: a nonzero count means a worker died holding
      // work, or a handler outran its visibility timeout without heartbeating.
      // Both are conditions an operator should be able to see rising.
      this.#logger?.warn('queue.lease.reclaimed', { queue: this.name, count: result.rowCount });
    }
    return result.rowCount;
  }

  // -------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------

  async waitForWork(timeoutMs: number, signal?: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return;

    const listener = await this.#ensureListener();
    if (listener === 'established') {
      // The registration was not in place when the caller last looked for work,
      // so anything enqueued in between produced a notification nobody heard.
      // Returning immediately makes the caller look again under the registration
      // rather than sleep through work that is already ready.
      return;
    }
    if (this.#woken) {
      this.#woken = false;
      return;
    }

    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        cancelTimer();
        unsubscribe();
        signal?.removeEventListener('abort', finish);
        resolvePromise();
      };
      const unsubscribe = this.#listener?.onNotification(() => finish()) ?? ((): void => {});
      const cancelTimer = this.#clock.setTimer(timeoutMs, finish);
      signal?.addEventListener('abort', finish, { once: true });
      // Re-checked after subscribing, because a notification that arrived between
      // the check above and this subscription would otherwise be lost.
      if (this.#woken) {
        this.#woken = false;
        finish();
      }
    });
  }

  async #ensureListener(): Promise<'established' | 'present'> {
    const existing = this.#listener;
    if (existing !== undefined && !existing.isClosed) return 'present';

    const connection = await this.#pool.acquire();
    connection.onNotification(() => {
      this.#woken = true;
    });
    // The channel name is interpolated because LISTEN takes no parameters. It is
    // safe because `assertQueueName` ran in the constructor and the same pattern
    // is a CHECK constraint on the column, so there is no path by which this
    // string is anything but an identifier.
    await connection.simpleQuery(`LISTEN ${NOTIFY_CHANNEL_PREFIX}${this.name}`);
    this.#listener = connection;
    return 'established';
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  async depth(): Promise<QueueDepth> {
    const result = await withDispatchScope(this.#pool, (tx) =>
      tx.query<{ state: string; n: number }>(
        'SELECT state, count(*)::int AS n FROM queue_jobs WHERE queue = $1 GROUP BY state',
        [this.name],
      ),
    );
    const counts = new Map(result.rows.map((row) => [row.state, row.n]));
    return {
      ready: counts.get('ready') ?? 0,
      running: counts.get('running') ?? 0,
      dead: counts.get('dead') ?? 0,
    };
  }

  /**
   * Delete succeeded jobs past the given age.
   *
   * Retention is a cost requirement, not tidiness: an unbounded table on a
   * free-tier database is the fixed cost `cost-efficient-operation.md` AC6 is
   * about. The age is a parameter rather than a constant because it is really the
   * enqueue-idempotency window — purging sooner than the upstream's redelivery
   * interval would let a duplicate through.
   *
   * Dead jobs are deliberately out of scope here. They are the record AC8
   * requires be kept, and destroying them on a schedule would destroy the
   * evidence of the failure along with the job.
   */
  async purgeSucceeded(olderThanMs: number): Promise<number> {
    const result = await withDispatchScope(this.#pool, (tx) =>
      tx.query(
        `DELETE FROM queue_jobs
          WHERE queue = $1 AND state = 'succeeded'
            AND finished_at < now() - make_interval(secs => $2::double precision)`,
        [this.name, olderThanMs / 1000],
      ),
    );
    return result.rowCount;
  }

  async close(): Promise<void> {
    const listener = this.#listener;
    this.#listener = undefined;
    if (listener === undefined) return;
    if (!listener.isClosed) {
      // Cleared before the connection goes back, or the next borrower inherits a
      // subscription it never asked for.
      await listener.simpleQuery('UNLISTEN *');
    }
    await this.#pool.release(listener);
  }
}
