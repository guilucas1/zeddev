/**
 * The in-memory adapter.
 *
 * IMPLEMENTATION_PLAN.md §1 gives every port a real adapter and an in-memory
 * fake, so that services above the port can be tested without their
 * infrastructure. `@zeddev/db` is the deliberate exception — a fake database
 * would have to reimplement row-level security in order to test row-level
 * security — but the queue is not: a handler's correctness has nothing to do with
 * PostgreSQL, and making every conversation-worker test wait on a container would
 * make them slow enough that people stop running them.
 *
 * The danger with a fake queue is specific and worth naming. If the fake
 * dispatches in plain FIFO while the real one dispatches fairly, every test above
 * the port passes against a scheduler that does not exist, and the first thing
 * anyone learns about it is in production. So this is not a simplified queue. It
 * reproduces the same four guarantees — at-least-once, per-partition FIFO,
 * round-robin fairness, bounded attempts then dead-letter — using the same
 * ordering rules, and `conformance.ts` runs one suite against both implementations
 * so that a divergence is a test failure rather than a surprise.
 *
 * The one intended difference: time comes from the injected `Clock`, not from a
 * server. That is what lets a test drive a lease expiry or a backoff window
 * without waiting for it, and it is why `FakeClock` exists.
 */

import { DefectError, toDiagnostic } from '@zeddev/errors';
import { SystemClock, type Clock } from '@zeddev/time';
import type { Backoff } from '@zeddev/time';
import { DEFAULT_BACKOFF } from './backoff.ts';
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

interface StoredJob {
  readonly id: string;
  readonly tenantId: string;
  readonly kind: string;
  readonly seq: number;
  readonly partitionRef: string | undefined;
  readonly dedupeRef: string | undefined;
  readonly maxAttempts: number;
  readonly enqueuedAt: Date;
  payload: JsonValue;
  state: 'ready' | 'running' | 'succeeded' | 'dead';
  attempt: number;
  runAtMs: number;
  leasedUntilMs: number | undefined;
  finishedAtMs: number | undefined;
  lastErrorKind: string | undefined;
  lastErrorCode: string | undefined;
}

export interface InMemoryQueueOptions {
  readonly name: string;
  readonly backoff?: Backoff | undefined;
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
  readonly clock?: Clock | undefined;
}

export class InMemoryQueue implements Queue {
  readonly name: string;
  readonly #backoff: Backoff;
  readonly #maxAttempts: number;
  readonly #visibilityTimeoutMs: number;
  readonly #clock: Clock;

  #jobs: StoredJob[] = [];
  #cursors = new Map<string, number>();
  #nextSeq = 1;
  #nextDispatchSeq = 1;
  #nextId = 1;
  #waiters = new Set<() => void>();
  #woken = false;

  constructor(options: InMemoryQueueOptions) {
    assertQueueName(options.name);
    this.name = options.name;
    this.#backoff = options.backoff ?? DEFAULT_BACKOFF;
    this.#maxAttempts = options.maxAttempts ?? 5;
    this.#visibilityTimeoutMs = options.visibilityTimeoutMs ?? 60_000;
    this.#clock = options.clock ?? new SystemClock();
  }

  #now(): number {
    return this.#clock.now().getTime();
  }

  // -------------------------------------------------------------------------
  // Producing
  // -------------------------------------------------------------------------

  async enqueue(tenantId: string, request: EnqueueRequest): Promise<EnqueueResult> {
    const dedupeRef =
      request.dedupeKey === undefined ? undefined : digestKey(tenantId, request.dedupeKey);

    if (dedupeRef !== undefined) {
      // Spans terminal states, matching the real adapter's unique index: an
      // already-succeeded job must keep suppressing, not become re-runnable.
      const existing = this.#jobs.find(
        (job) => job.tenantId === tenantId && job.dedupeRef === dedupeRef,
      );
      if (existing !== undefined) return { jobId: existing.id, created: false };
    }

    const now = this.#now();
    const job: StoredJob = {
      id: `job-${this.#nextId++}`,
      tenantId,
      kind: request.kind,
      seq: this.#nextSeq++,
      partitionRef:
        request.partitionKey === undefined ? undefined : digestKey(tenantId, request.partitionKey),
      dedupeRef,
      maxAttempts: request.maxAttempts ?? this.#maxAttempts,
      enqueuedAt: new Date(now),
      // Cloned so a caller mutating the object it enqueued cannot change work
      // that is already scheduled — the real adapter serialises to JSON, and a
      // fake that shared a reference would hide the bug that difference causes.
      payload: JSON.parse(JSON.stringify(request.payload)) as JsonValue,
      state: 'ready',
      attempt: 0,
      runAtMs: now + (request.delayMs ?? 0),
      leasedUntilMs: undefined,
      finishedAtMs: undefined,
      lastErrorKind: undefined,
      lastErrorCode: undefined,
    };
    this.#jobs.push(job);
    if (!this.#cursors.has(tenantId)) this.#cursors.set(tenantId, 0);
    if (job.runAtMs <= now) this.#wake();
    return { jobId: job.id, created: true };
  }

  // -------------------------------------------------------------------------
  // Consuming
  // -------------------------------------------------------------------------

  /**
   * The same four-layer selection the real adapter's dispatch query performs, in
   * the same order. Kept structurally parallel on purpose: when one of them
   * changes, the resemblance is what makes it obvious the other must too.
   */
  async claim(options: ClaimOptions = {}): Promise<ClaimedJob | undefined> {
    const now = this.#now();
    const cap = options.maxInFlightPerTenant;

    const eligibleTenants = [...this.#cursors.entries()].filter(([tenantId]) => {
      const hasReady = this.#jobs.some(
        (job) => job.tenantId === tenantId && job.state === 'ready' && job.runAtMs <= now,
      );
      if (!hasReady) return false;
      if (cap === undefined) return true;
      const running = this.#jobs.filter(
        (job) => job.tenantId === tenantId && job.state === 'running',
      ).length;
      return running < cap;
    });

    const candidates: { job: StoredJob; cursorSeq: number; rankInTenant: number }[] = [];
    for (const [tenantId, cursorSeq] of eligibleTenants) {
      const unblocked = this.#jobs
        .filter((job) => job.tenantId === tenantId && job.state === 'ready' && job.runAtMs <= now)
        .filter((job) => !this.#isPartitionBlocked(job))
        .sort((a, b) => a.seq - b.seq);
      unblocked.forEach((job, index) => {
        candidates.push({ job, cursorSeq, rankInTenant: index + 1 });
      });
    }

    candidates.sort(
      (a, b) =>
        a.rankInTenant - b.rankInTenant || a.cursorSeq - b.cursorSeq || a.job.seq - b.job.seq,
    );

    const chosen = candidates[0];
    if (chosen === undefined) return undefined;

    const job = chosen.job;
    job.state = 'running';
    job.attempt += 1;
    job.leasedUntilMs = now + (options.visibilityTimeoutMs ?? this.#visibilityTimeoutMs);
    this.#cursors.set(job.tenantId, this.#nextDispatchSeq++);

    return this.#toClaimedJob(job);
  }

  /** An earlier unfinished job in the same partition holds the line. */
  #isPartitionBlocked(job: StoredJob): boolean {
    if (job.partitionRef === undefined) return false;
    return this.#jobs.some(
      (other) =>
        other.tenantId === job.tenantId &&
        other.partitionRef === job.partitionRef &&
        (other.state === 'ready' || other.state === 'running') &&
        other.seq < job.seq,
    );
  }

  #toClaimedJob(job: StoredJob): ClaimedJob {
    return {
      id: job.id,
      tenantId: job.tenantId,
      queue: this.name,
      kind: job.kind,
      payload: JSON.parse(JSON.stringify(job.payload)) as JsonValue,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      enqueuedAt: job.enqueuedAt,
    };
  }

  /** The lease-holder check both adapters apply: same job, same attempt, still running. */
  #held(job: ClaimedJob): StoredJob | undefined {
    const stored = this.#jobs.find((candidate) => candidate.id === job.id);
    if (stored === undefined) return undefined;
    if (stored.state !== 'running' || stored.attempt !== job.attempt) return undefined;
    return stored;
  }

  async heartbeat(job: ClaimedJob, extendByMs?: number): Promise<boolean> {
    const stored = this.#held(job);
    if (stored === undefined) return false;
    stored.leasedUntilMs = this.#now() + (extendByMs ?? this.#visibilityTimeoutMs);
    return true;
  }

  async complete(job: ClaimedJob): Promise<void> {
    const stored = this.#held(job);
    if (stored === undefined) return;
    stored.state = 'succeeded';
    stored.finishedAtMs = this.#now();
    stored.leasedUntilMs = undefined;
    // Mirrors the real adapter deleting the payload row: content lives exactly as
    // long as the work does.
    stored.payload = null;
    this.#wake();
  }

  async fail(job: ClaimedJob, error: unknown, options: FailOptions = {}): Promise<JobOutcome> {
    const stored = this.#held(job);
    if (stored === undefined) return 'retry';

    const diagnostic = toDiagnostic(error);
    stored.lastErrorKind = diagnostic.kind;
    stored.lastErrorCode = diagnostic.code;
    stored.leasedUntilMs = undefined;

    // See the real adapter: an error whose *type* says it is not retryable goes
    // straight to the dead-letter state rather than consuming an allowance that
    // cannot change the outcome.
    if (!diagnostic.retryable || stored.attempt >= stored.maxAttempts) {
      stored.state = 'dead';
      stored.finishedAtMs = this.#now();
      return 'dead';
    }

    stored.state = 'ready';
    stored.runAtMs = this.#now() + (options.retryDelayMs ?? this.#backoff(stored.attempt));
    if (stored.runAtMs <= this.#now()) this.#wake();
    return 'retry';
  }

  async reclaimExpired(): Promise<number> {
    const now = this.#now();
    let reclaimed = 0;
    for (const job of this.#jobs) {
      if (job.state !== 'running') continue;
      if (job.leasedUntilMs === undefined || job.leasedUntilMs >= now) continue;
      reclaimed += 1;
      job.lastErrorKind = 'internal';
      job.lastErrorCode = 'queue.lease_expired';
      job.leasedUntilMs = undefined;
      if (job.attempt >= job.maxAttempts) {
        job.state = 'dead';
        job.finishedAtMs = now;
      } else {
        job.state = 'ready';
        job.runAtMs = now;
      }
    }
    if (reclaimed > 0) this.#wake();
    return reclaimed;
  }

  // -------------------------------------------------------------------------
  // Waiting
  // -------------------------------------------------------------------------

  #wake(): void {
    this.#woken = true;
    const waiters = [...this.#waiters];
    this.#waiters.clear();
    for (const waiter of waiters) waiter();
  }

  async waitForWork(timeoutMs: number, signal?: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) return;
    if (this.#woken) {
      this.#woken = false;
      return;
    }
    // Same rule as the real adapter: a delayed job notifies nobody when it comes
    // due, so the wait ends no later than the next one does.
    const now = this.#now();
    const nextDue = this.#jobs
      .filter((job) => job.state === 'ready' && job.runAtMs > now)
      .reduce((soonest, job) => Math.min(soonest, job.runAtMs - now), Infinity);
    const waitMs = Math.min(timeoutMs, nextDue);
    await new Promise<void>((resolvePromise) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        this.#waiters.delete(finish);
        cancelTimer();
        signal?.removeEventListener('abort', finish);
        this.#woken = false;
        resolvePromise();
      };
      this.#waiters.add(finish);
      const cancelTimer = this.#clock.setTimer(waitMs, finish);
      signal?.addEventListener('abort', finish, { once: true });
    });
  }

  // -------------------------------------------------------------------------
  // Housekeeping
  // -------------------------------------------------------------------------

  async depth(): Promise<QueueDepth> {
    return {
      ready: this.#jobs.filter((job) => job.state === 'ready').length,
      running: this.#jobs.filter((job) => job.state === 'running').length,
      dead: this.#jobs.filter((job) => job.state === 'dead').length,
    };
  }

  async purgeSucceeded(olderThanMs: number): Promise<number> {
    const cutoff = this.#now() - olderThanMs;
    const before = this.#jobs.length;
    this.#jobs = this.#jobs.filter(
      (job) =>
        !(
          job.state === 'succeeded' &&
          job.finishedAtMs !== undefined &&
          job.finishedAtMs < cutoff
        ),
    );
    return before - this.#jobs.length;
  }

  async close(): Promise<void> {
    this.#wake();
  }

  // -------------------------------------------------------------------------
  // Test-only inspection
  // -------------------------------------------------------------------------

  /**
   * The classification recorded against a dead-lettered job.
   *
   * Exposed because AC8 requires the failure be *recorded* against the tenant,
   * and a test of that requirement has to be able to read what was recorded. Only
   * the classification is exposed, never a message — the same restriction the
   * real adapter's columns impose.
   */
  inspect(jobId: string): { state: string; attempt: number; errorCode: string | undefined } {
    const job = this.#jobs.find((candidate) => candidate.id === jobId);
    if (job === undefined) {
      throw new DefectError('no such job', { code: 'queue.unknown_job' });
    }
    return { state: job.state, attempt: job.attempt, errorCode: job.lastErrorCode };
  }
}
