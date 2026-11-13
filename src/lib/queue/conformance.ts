/**
 * One test suite, run against every implementation of the queue port.
 *
 * The reason this exists rather than two separate test files is the failure mode
 * a fake creates. A service tested against a fake queue is really tested against
 * the fake's scheduler, and if that scheduler is a plain FIFO while production's
 * is fair, the tests are evidence about a system nobody deploys. Divergence is
 * also silent — nothing fails, the fake just gradually stops describing reality.
 *
 * So the guarantees in `types.ts` are asserted here, once, and both adapters have
 * to satisfy them. A change to the real dispatch query that the fake does not
 * follow fails this suite, which is exactly when it should fail.
 *
 * Time is the one thing that genuinely differs: the real adapter takes it from
 * the database server, because a worker with a fast clock must not be able to
 * expire its own lease early, while the fake takes it from an injectable clock so
 * a test can drive a lease expiry without waiting for one. The harness absorbs
 * that difference behind `advance` and `timeUnitMs`, and nothing else in this
 * file knows about it.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TerminalTransportError, TransientTransportError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import type { Queue } from './types.ts';

export interface HarnessQueueOptions {
  readonly maxAttempts?: number | undefined;
  readonly visibilityTimeoutMs?: number | undefined;
}

export interface QueueFixture {
  readonly queue: Queue;
  /** At least three distinct tenant ids, isolated from any other fixture's. */
  readonly tenants: readonly string[];
  /**
   * The unit time-based assertions are written in.
   *
   * Small and real for the database adapter, large and simulated for the fake.
   * Tests express durations as multiples of it so the same assertion is
   * meaningful under both.
   */
  readonly timeUnitMs: number;
  /** Move time forward — by simulation or by actually waiting. */
  advance(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

export interface QueueHarness {
  readonly label: string;
  create(options?: HarnessQueueOptions): Promise<QueueFixture>;
}

const PAYLOAD = { messageId: 'm-1', text: 'hello' };

/**
 * Let a consumer started just now reach its sleep before time moves. Without it,
 * a simulated clock can be advanced past the deadline before the consumer first
 * looks, and a test of "wakes by the deadline" passes with no wake at all.
 */
async function asleep(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
}

/** Declares the shared suite. Call once per implementation. */
export function runQueueConformance(harness: QueueHarness): void {
  describe(`queue conformance: ${harness.label}`, () => {
    const withFixture = async (
      options: HarnessQueueOptions,
      body: (fixture: QueueFixture) => Promise<void>,
    ): Promise<void> => {
      const fixture = await harness.create(options);
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    };

    // -----------------------------------------------------------------------
    // At-least-once and durability
    // -----------------------------------------------------------------------

    unitTest(`[${harness.label}] a claimed job carries its payload back intact`, async () => {
      await withFixture({}, async ({ queue, tenants }) => {
        const enqueued = await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        assert.equal(enqueued.created, true);

        const job = await queue.claim();
        assert.ok(job !== undefined);
        assert.equal(job.id, enqueued.jobId);
        assert.equal(job.tenantId, tenants[0]);
        assert.equal(job.kind, 'reply');
        assert.deepEqual(job.payload, PAYLOAD);
        assert.equal(job.attempt, 1);
      });
    });

    unitTest(`[${harness.label}] a completed job is not claimed again`, async () => {
      await withFixture({}, async ({ queue, tenants }) => {
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        const job = await queue.claim();
        assert.ok(job !== undefined);
        await queue.complete(job);
        assert.equal(await queue.claim(), undefined);
        assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 0 });
      });
    });

    specTest(
      'message-delivery-reliability.md',
      'AC6 an acknowledged message is still processed after the worker restarts',
      `[${harness.label}] a job whose worker died is returned to the ready pool and re-run`,
      async () => {
        await withFixture({}, async (fixture) => {
          const { queue, tenants, timeUnitMs } = fixture;
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });

          // Claimed and then abandoned — the shape of a process that was killed
          // between taking the work and finishing it.
          const first = await queue.claim({ visibilityTimeoutMs: timeUnitMs });
          assert.ok(first !== undefined);
          assert.equal(await queue.claim(), undefined, 'a leased job is not claimable');

          await fixture.advance(timeUnitMs * 2);
          assert.equal(await queue.reclaimExpired(), 1);

          const second = await queue.claim();
          assert.ok(second !== undefined);
          assert.equal(second.id, first.id);
          // The attempt counter advances across the reclaim, which is what stops a
          // job that reliably kills its worker from being retried forever.
          assert.equal(second.attempt, 2);
        });
      },
    );

    unitTest(
      `[${harness.label}] a worker that lost its lease cannot complete the job someone else now holds`,
      async () => {
        await withFixture({}, async (fixture) => {
          const { queue, tenants, timeUnitMs } = fixture;
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });

          const stale = await queue.claim({ visibilityTimeoutMs: timeUnitMs });
          assert.ok(stale !== undefined);
          await fixture.advance(timeUnitMs * 2);
          await queue.reclaimExpired();
          const current = await queue.claim();
          assert.ok(current !== undefined);

          // The abandoned worker finally finishes and reports success. If that
          // were honoured, the job the second worker is actively running would be
          // marked done and its result discarded.
          await queue.complete(stale);
          assert.equal((await queue.depth()).running, 1);

          await queue.complete(current);
          assert.equal((await queue.depth()).running, 0);
        });
      },
    );

    unitTest(`[${harness.label}] a heartbeat keeps a long-running job's lease alive`, async () => {
      await withFixture({}, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        const job = await queue.claim({ visibilityTimeoutMs: timeUnitMs * 2 });
        assert.ok(job !== undefined);

        await fixture.advance(timeUnitMs);
        assert.equal(await queue.heartbeat(job, timeUnitMs * 4), true);
        await fixture.advance(timeUnitMs * 2);

        // Without the heartbeat the lease would have expired by now, and the job
        // would be running twice — for a reply handler, a duplicate reply.
        assert.equal(await queue.reclaimExpired(), 0);
        assert.equal((await queue.depth()).running, 1);
      });
    });

    // -----------------------------------------------------------------------
    // Ordering
    // -----------------------------------------------------------------------

    specTest(
      'message-delivery-reliability.md',
      'AC5 messages from one end-customer are processed in the order they were sent',
      `[${harness.label}] jobs sharing a partition run strictly one at a time, in order`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          const tenant = tenants[0]!;
          const ids: string[] = [];
          for (const text of ['first', 'second', 'third']) {
            const { jobId } = await queue.enqueue(tenant, {
              kind: 'reply',
              payload: { text },
              partitionKey: 'end-customer-a',
            });
            ids.push(jobId);
          }

          const first = await queue.claim();
          assert.ok(first !== undefined);
          assert.equal(first.id, ids[0]);
          // The critical assertion: the partition is held, so a second worker
          // cannot start the next message while this one is still in flight.
          assert.equal(await queue.claim(), undefined);

          await queue.complete(first);
          const second = await queue.claim();
          assert.ok(second !== undefined);
          assert.equal(second.id, ids[1]);
        });
      },
    );

    unitTest(
      `[${harness.label}] a retry keeps holding its partition, so a later message cannot overtake it`,
      async () => {
        await withFixture({ maxAttempts: 3 }, async ({ queue, tenants }) => {
          const tenant = tenants[0]!;
          const a = await queue.enqueue(tenant, {
            kind: 'reply',
            payload: { text: 'first' },
            partitionKey: 'end-customer-a',
          });
          await queue.enqueue(tenant, {
            kind: 'reply',
            payload: { text: 'second' },
            partitionKey: 'end-customer-a',
          });

          const first = await queue.claim();
          assert.ok(first !== undefined);
          assert.equal(first.id, a.jobId);
          assert.equal(
            await queue.fail(first, new TransientTransportError('upstream blip', { code: 't' }), {
              retryDelayMs: 0,
            }),
            'retry',
          );

          // Ordering must survive a failure. If the retry released the partition,
          // the second message would be answered before the first — exactly the
          // corruption AC5 forbids.
          const next = await queue.claim();
          assert.ok(next !== undefined);
          assert.equal(next.id, a.jobId);
          assert.equal(next.attempt, 2);
        });
      },
    );

    unitTest(`[${harness.label}] different partitions do not block each other`, async () => {
      await withFixture({}, async ({ queue, tenants }) => {
        const tenant = tenants[0]!;
        await queue.enqueue(tenant, { kind: 'reply', payload: {}, partitionKey: 'customer-a' });
        await queue.enqueue(tenant, { kind: 'reply', payload: {}, partitionKey: 'customer-b' });

        assert.ok((await queue.claim()) !== undefined);
        assert.ok((await queue.claim()) !== undefined);
      });
    });

    unitTest(`[${harness.label}] jobs with no partition key are not serialised`, async () => {
      await withFixture({}, async ({ queue, tenants }) => {
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: {} });
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: {} });
        assert.ok((await queue.claim()) !== undefined);
        assert.ok((await queue.claim()) !== undefined);
      });
    });

    // -----------------------------------------------------------------------
    // Tenant fairness
    // -----------------------------------------------------------------------

    specTest(
      'message-delivery-reliability.md',
      "AC16 one tenant's backlog does not delay another tenant's messages",
      `[${harness.label}] a tenant with one job is served immediately behind a tenant with a large backlog`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          const [busy, quiet] = [tenants[0]!, tenants[1]!];
          for (let i = 0; i < 25; i += 1) {
            await queue.enqueue(busy, { kind: 'reply', payload: { i } });
          }
          // Enqueued last, and behind twenty-five other jobs in every FIFO sense.
          await queue.enqueue(quiet, { kind: 'reply', payload: { i: 'only' } });

          const served: string[] = [];
          for (let i = 0; i < 2; i += 1) {
            const job = await queue.claim();
            assert.ok(job !== undefined);
            served.push(job.tenantId);
          }

          // A global FIFO would put this tenant twenty-sixth. Two claims is the
          // round-robin worst case: at most one job of the busy tenant's goes
          // first, because after that its cursor is behind.
          assert.ok(
            served.includes(quiet),
            `expected the quiet tenant to be served within two claims, got ${served.join(', ')}`,
          );
        });
      },
    );

    specTest(
      'message-delivery-reliability.md',
      "AC16 one tenant's backlog does not delay another tenant's messages",
      `[${harness.label}] dispatch alternates between two equally busy tenants`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          const [a, b] = [tenants[0]!, tenants[1]!];
          for (let i = 0; i < 4; i += 1) await queue.enqueue(a, { kind: 'reply', payload: { i } });
          for (let i = 0; i < 4; i += 1) await queue.enqueue(b, { kind: 'reply', payload: { i } });

          const served: string[] = [];
          for (let i = 0; i < 6; i += 1) {
            const job = await queue.claim();
            assert.ok(job !== undefined);
            served.push(job.tenantId);
            await queue.complete(job);
          }

          // Not merely "both appear": strict alternation is what proves the
          // cursor is being consulted rather than a tenant being picked at random
          // and happening to spread out.
          for (let i = 1; i < served.length; i += 1) {
            assert.notEqual(served[i], served[i - 1], `served in order: ${served.join(', ')}`);
          }
        });
      },
    );

    specTest(
      'message-delivery-reliability.md',
      "AC16 one tenant's backlog does not delay another tenant's messages",
      `[${harness.label}] a per-tenant in-flight cap leaves capacity for other tenants`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          const [stuck, other] = [tenants[0]!, tenants[1]!];
          await queue.enqueue(stuck, { kind: 'reply', payload: { i: 1 } });
          await queue.enqueue(stuck, { kind: 'reply', payload: { i: 2 } });
          await queue.enqueue(other, { kind: 'reply', payload: { i: 3 } });

          // Simulates a handler that hangs: the job is claimed and never
          // completed, occupying a worker for the whole visibility timeout.
          const held = await queue.claim({ maxInFlightPerTenant: 1 });
          assert.ok(held !== undefined);
          assert.equal(held.tenantId, stuck);

          const next = await queue.claim({ maxInFlightPerTenant: 1 });
          assert.ok(next !== undefined);
          assert.equal(next.tenantId, other);

          // This is the assertion the cap alone earns. The stuck tenant still has
          // a ready job and is now the only tenant that does, so round-robin
          // would hand it over and a third worker would be occupied by a tenant
          // that is already hung. The cap refuses instead, which is what keeps a
          // worker free for whoever arrives next.
          const third = await queue.claim({ maxInFlightPerTenant: 1 });
          assert.equal(third, undefined, 'the capped tenant gets no second worker');
        });
      },
    );

    // -----------------------------------------------------------------------
    // Retry, backoff, and the dead-letter path
    // -----------------------------------------------------------------------

    specTest(
      'message-delivery-reliability.md',
      'AC8 an exhausted retry allowance records a failure rather than discarding the reply',
      `[${harness.label}] a job that exhausts its attempts becomes dead-lettered, not deleted`,
      async () => {
        await withFixture({ maxAttempts: 2 }, async ({ queue, tenants }) => {
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
          const error = new TransientTransportError('send failed', { code: 'whatsapp.503' });

          const first = await queue.claim();
          assert.ok(first !== undefined);
          assert.equal(await queue.fail(first, error, { retryDelayMs: 0 }), 'retry');

          const second = await queue.claim();
          assert.ok(second !== undefined);
          assert.equal(second.attempt, 2);
          assert.equal(await queue.fail(second, error, { retryDelayMs: 0 }), 'dead');

          // Still present, and still counted. AC8's requirement is that the
          // failure be recorded against the tenant, which a job that vanished
          // could not be.
          assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 1 });
          assert.equal(await queue.claim(), undefined);
        });
      },
    );

    unitTest(
      `[${harness.label}] an error the taxonomy marks non-retryable is dead-lettered on the first failure`,
      async () => {
        await withFixture({ maxAttempts: 5 }, async ({ queue, tenants }) => {
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
          const job = await queue.claim();
          assert.ok(job !== undefined);

          // `@zeddev/errors` makes retryability a property of the type. Spending
          // four more attempts to rediscover what the class already stated only
          // delays the failure record.
          const outcome = await queue.fail(
            job,
            new TerminalTransportError('number is not registered', { code: 'whatsapp.131026' }),
          );
          assert.equal(outcome, 'dead');
          assert.equal((await queue.depth()).dead, 1);
        });
      },
    );

    unitTest(`[${harness.label}] a retry is not claimable until its backoff elapses`, async () => {
      await withFixture({ maxAttempts: 3 }, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        const job = await queue.claim();
        assert.ok(job !== undefined);
        await queue.fail(job, new TransientTransportError('blip', { code: 't' }), {
          retryDelayMs: timeUnitMs * 2,
        });

        assert.equal(await queue.claim(), undefined, 'still inside the backoff window');
        await fixture.advance(timeUnitMs * 3);

        const retried = await queue.claim();
        assert.ok(retried !== undefined);
        assert.equal(retried.attempt, 2);
      });
    });

    unitTest(`[${harness.label}] a delayed job is not claimable before it is due`, async () => {
      await withFixture({}, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, {
          kind: 'reply',
          payload: PAYLOAD,
          delayMs: timeUnitMs * 2,
        });
        assert.equal(await queue.claim(), undefined);
        await fixture.advance(timeUnitMs * 3);
        assert.ok((await queue.claim()) !== undefined);
      });
    });

    unitTest(`[${harness.label}] a waiting consumer wakes when a delayed job comes due, not at its idle timeout`, async () => {
      await withFixture({}, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD, delayMs: timeUnitMs * 2 });
        // What a consumer does: wait, look, repeat. A wait may return at once (the
        // real adapter's first wait registers for notifications), so it loops.
        const consumer = (async () => {
          for (let round = 0; round < 5; round += 1) {
            await queue.waitForWork(timeUnitMs * 1000);
            const job = await queue.claim();
            if (job !== undefined) return job;
          }
          return undefined;
        })();
        await asleep();
        await fixture.advance(timeUnitMs * 4);
        const outcome = await Promise.race([consumer, fixture.advance(timeUnitMs * 2).then(() => 'still asleep' as const)]);
        assert.ok(outcome !== 'still asleep', 'the consumer slept past the delayed job');
        assert.ok(outcome !== undefined, 'the consumer woke but found no job');
      });
    });

    unitTest(`[${harness.label}] a waiting consumer wakes when an abandoned lease runs out, not at its idle timeout`, async () => {
      await withFixture({}, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        // Claimed by a worker that then died: nobody will complete, fail, or
        // renew it, and nothing will notify anyone when its lease runs out.
        const abandoned = await queue.claim({ visibilityTimeoutMs: timeUnitMs * 2 });
        assert.ok(abandoned !== undefined);
        // What an idle consumer does: wait, sweep, look, repeat.
        const consumer = (async () => {
          for (let round = 0; round < 5; round += 1) {
            await queue.waitForWork(timeUnitMs * 1000);
            await queue.reclaimExpired();
            const job = await queue.claim();
            if (job !== undefined) return job;
          }
          return undefined;
        })();
        await asleep();
        await fixture.advance(timeUnitMs * 4);
        const outcome = await Promise.race([consumer, fixture.advance(timeUnitMs * 2).then(() => 'still asleep' as const)]);
        assert.ok(outcome !== 'still asleep', 'the consumer slept past the expired lease');
        assert.ok(outcome !== undefined, 'the consumer woke but found no job');
        assert.equal(outcome.id, abandoned.id);
        assert.equal(outcome.attempt, 2);
      });
    });

    unitTest(`[${harness.label}] a lease is expired at the instant it runs out`, async () => {
      await withFixture({}, async (fixture) => {
        const { queue, tenants, timeUnitMs } = fixture;
        await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
        assert.ok((await queue.claim({ visibilityTimeoutMs: timeUnitMs * 2 })) !== undefined);
        // A waiter woken by the lease running out must find it reclaimable then,
        // not one tick later, or it goes back to sleep until its idle timeout.
        await fixture.advance(timeUnitMs * 2);
        assert.equal(await queue.reclaimExpired(), 1);
      });
    });

    // -----------------------------------------------------------------------
    // Idempotency and retention
    // -----------------------------------------------------------------------

    unitTest(`[${harness.label}] a repeated dedupe key returns the existing job`, async () => {
      await withFixture({}, async ({ queue, tenants }) => {
        const first = await queue.enqueue(tenants[0]!, {
          kind: 'reply',
          payload: PAYLOAD,
          dedupeKey: 'wamid.abc',
        });
        const second = await queue.enqueue(tenants[0]!, {
          kind: 'reply',
          payload: PAYLOAD,
          dedupeKey: 'wamid.abc',
        });

        assert.equal(second.created, false);
        assert.equal(second.jobId, first.jobId);
        assert.equal((await queue.depth()).ready, 1);
      });
    });

    unitTest(
      `[${harness.label}] a dedupe key keeps suppressing after the job has succeeded`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD, dedupeKey: 'k' });
          const job = await queue.claim();
          assert.ok(job !== undefined);
          await queue.complete(job);

          // A suppression that expires when the work finishes suppresses nothing:
          // the redelivery this exists to absorb arrives *after* processing.
          const again = await queue.enqueue(tenants[0]!, {
            kind: 'reply',
            payload: PAYLOAD,
            dedupeKey: 'k',
          });
          assert.equal(again.created, false);
          assert.equal(await queue.claim(), undefined);
        });
      },
    );

    unitTest(
      `[${harness.label}] the same dedupe key under two tenants produces two independent jobs`,
      async () => {
        await withFixture({}, async ({ queue, tenants }) => {
          const a = await queue.enqueue(tenants[0]!, {
            kind: 'reply',
            payload: PAYLOAD,
            dedupeKey: 'shared',
          });
          const b = await queue.enqueue(tenants[1]!, {
            kind: 'reply',
            payload: PAYLOAD,
            dedupeKey: 'shared',
          });
          assert.equal(b.created, true);
          assert.notEqual(a.jobId, b.jobId);
        });
      },
    );

    unitTest(
      `[${harness.label}] purging removes succeeded jobs and leaves dead ones as the failure record`,
      async () => {
        await withFixture({ maxAttempts: 1 }, async (fixture) => {
          const { queue, tenants, timeUnitMs } = fixture;
          await queue.enqueue(tenants[0]!, { kind: 'reply', payload: PAYLOAD });
          await queue.enqueue(tenants[1]!, { kind: 'reply', payload: PAYLOAD });

          const good = await queue.claim();
          assert.ok(good !== undefined);
          await queue.complete(good);

          const bad = await queue.claim();
          assert.ok(bad !== undefined);
          await queue.fail(bad, new TransientTransportError('gone', { code: 't' }));

          await fixture.advance(timeUnitMs * 2);
          assert.equal(await queue.purgeSucceeded(timeUnitMs), 1);
          // The dead job survives on purpose: destroying it on a retention
          // schedule would destroy the evidence AC8 requires be kept.
          assert.equal((await queue.depth()).dead, 1);
        });
      },
    );
  });
}
