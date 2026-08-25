/**
 * Tests that need no database: the conformance suite against the in-memory
 * adapter, the backoff curve, and the consumer loop.
 *
 * The consumer is tested here rather than against PostgreSQL on purpose. What it
 * does — route by kind, complete on success, fail on throw, dead-letter what
 * cannot succeed — is queue-agnostic, and testing it through the port is the
 * thing that proves the port is sufficient. If the loop needed something only the
 * real adapter offers, that would be a gap in the port, and this file is where it
 * would show up.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { TransientTransportError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { FakeClock } from '@zeddev/time';
import { specTest, unitTest } from '@zeddev/testing';
import { exponentialBackoff, runConsumer, type ClaimedJob } from './index.ts';
import { InMemoryQueue, runQueueConformance, type QueueHarness } from './testing.ts';

const TENANTS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
] as const;

const memoryHarness: QueueHarness = {
  label: 'in-memory',
  async create(options = {}) {
    // A fake clock, so lease expiry and backoff windows are driven rather than
    // waited for. This is the only intended difference from the real adapter,
    // which takes its time from the database server.
    const clock = new FakeClock();
    const queue = new InMemoryQueue({ name: 'conformance', clock, ...options });
    return {
      queue,
      tenants: TENANTS,
      timeUnitMs: 1000,
      advance: (ms: number) => clock.advance(ms),
      dispose: () => queue.close(),
    };
  },
};

runQueueConformance(memoryHarness);

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('backoff', () => {
  unitTest('doubles per attempt and stops at the ceiling', () => {
    // Jitter off, so the curve itself is what is under test. The jittered path is
    // exercised separately below.
    const backoff = exponentialBackoff({ baseMs: 1000, maxMs: 8000, jitter: 0 });
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(backoff), [1000, 2000, 4000, 8000, 8000, 8000]);
  });

  unitTest('never overflows on an implausibly high attempt number', () => {
    // A lease that expires repeatedly could in principle drive the attempt count
    // high; `2 ** attempt` without a clamp becomes Infinity, and an interval of
    // Infinity is a job that is never retried and never dead-lettered.
    const backoff = exponentialBackoff({ baseMs: 1000, maxMs: 60_000, jitter: 0 });
    assert.equal(backoff(1000), 60_000);
  });

  unitTest('full jitter draws from zero up to the computed delay', () => {
    const lowest = exponentialBackoff({ baseMs: 1000, maxMs: 8000, random: () => 0 });
    const highest = exponentialBackoff({ baseMs: 1000, maxMs: 8000, random: () => 1 });
    assert.equal(lowest(3), 0);
    assert.equal(highest(3), 4000);
  });

  unitTest('partial jitter keeps a fixed floor', () => {
    // The property that matters: with jitter below 1 there is always a minimum
    // wait, so a retry storm cannot collapse into an immediate hot loop.
    const backoff = exponentialBackoff({ baseMs: 1000, maxMs: 8000, jitter: 0.5, random: () => 0 });
    assert.equal(backoff(2), 1000);
  });
});

// ---------------------------------------------------------------------------
// Consumer
// ---------------------------------------------------------------------------

async function waitUntil(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Run the loop until the queue has nothing ready or running, then stop it. */
async function drain(
  queue: InMemoryQueue,
  handlers: Record<string, (job: ClaimedJob) => Promise<void>>,
  logger?: Logger,
): Promise<void> {
  const controller = new AbortController();
  const loop = runConsumer({
    queue,
    handlers,
    signal: controller.signal,
    idleWaitMs: 20,
    reclaimIntervalMs: 10_000,
    visibilityTimeoutMs: 5000,
    ...(logger === undefined ? {} : { logger }),
  });
  try {
    await waitUntil(async () => {
      const depth = await queue.depth();
      return depth.ready === 0 && depth.running === 0;
    }, 'the queue to drain');
  } finally {
    controller.abort();
    await loop;
  }
}

describe('consumer', () => {
  unitTest('runs the handler for each job and completes it', async () => {
    const queue = new InMemoryQueue({ name: 'consumer' });
    const handled: string[] = [];
    for (const text of ['a', 'b', 'c']) {
      await queue.enqueue(TENANTS[0], { kind: 'reply', payload: { text } });
    }

    await drain(queue, {
      reply: async (job) => {
        handled.push((job.payload as { text: string }).text);
      },
    });

    assert.deepEqual(handled.sort(), ['a', 'b', 'c']);
    assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 0 });
  });

  specTest(
    'message-delivery-reliability.md',
    'AC8 an exhausted retry allowance records a failure rather than discarding the reply',
    'a handler that keeps throwing exhausts its attempts and the job is dead-lettered',
    async () => {
      const queue = new InMemoryQueue({ name: 'consumer', maxAttempts: 3, backoff: () => 0 });
      const { jobId } = await queue.enqueue(TENANTS[0], { kind: 'reply', payload: {} });
      let attempts = 0;

      await drain(queue, {
        reply: async () => {
          attempts += 1;
          // Retryable by class, so the queue spends the whole allowance before
          // giving up — which is what AC8's "after the retry allowance is
          // exhausted" describes.
          throw new TransientTransportError('upstream refused', { code: 'whatsapp.503' });
        },
      });

      assert.equal(attempts, 3);
      const record = queue.inspect(jobId);
      assert.equal(record.state, 'dead');
      assert.equal(record.attempt, 3);
      assert.equal(record.errorCode, 'whatsapp.503');
    },
  );

  unitTest('a job whose kind has no handler is dead-lettered without retrying', async () => {
    const queue = new InMemoryQueue({ name: 'consumer', maxAttempts: 5 });
    const { jobId } = await queue.enqueue(TENANTS[0], { kind: 'unregistered', payload: {} });

    await drain(queue, { reply: async () => {} });

    // One attempt, not five. A kind this process cannot handle will still be
    // unhandleable next time, so retrying only delays the failure record.
    const record = queue.inspect(jobId);
    assert.equal(record.state, 'dead');
    assert.equal(record.attempt, 1);
    assert.equal(record.errorCode, 'queue.unknown_kind');
  });

  unitTest('a transient failure is retried and can then succeed', async () => {
    // Backoff pinned to zero so the test asserts the retry *happens* rather than
    // how long it waits — the curve itself is covered above, and a real backoff
    // here would only make the test slow and its timeout load-bearing.
    const queue = new InMemoryQueue({ name: 'consumer', maxAttempts: 3, backoff: () => 0 });
    await queue.enqueue(TENANTS[0], { kind: 'reply', payload: {} });
    let attempts = 0;

    await drain(queue, {
      reply: async () => {
        attempts += 1;
        if (attempts === 1) throw new TransientTransportError('blip', { code: 'x' });
      },
    });

    assert.equal(attempts, 2);
    assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 0 });
  });

  unitTest('two tenants are served concurrently rather than one draining first', async () => {
    const queue = new InMemoryQueue({ name: 'consumer' });
    for (let i = 0; i < 4; i += 1) {
      await queue.enqueue(TENANTS[0], { kind: 'reply', payload: { i } });
    }
    await queue.enqueue(TENANTS[1], { kind: 'reply', payload: { i: 'only' } });

    const order: string[] = [];
    await drain(queue, {
      reply: async (job) => {
        order.push(job.tenantId);
      },
    });

    const position = order.indexOf(TENANTS[1]);
    // With concurrency 1 and round-robin dispatch the single-job tenant is served
    // second at the latest, never fifth.
    assert.ok(position >= 0 && position <= 1, `served in order: ${order.join(', ')}`);
  });

  specTest(
    'operator-health-monitoring.md',
    'AC9 operator-visible diagnostics contain no conversation content',
    'nothing the consumer logs while failing a job carries the payload',
    async () => {
      const sink = new MemorySink();
      const logger = new Logger({ sink, level: 'debug' });
      // A marker chosen so it cannot occur in a tenant id, a job id, or a
      // timestamp. An earlier version of this test used a card-shaped number and
      // matched the `4111` inside the fixture's own tenant UUID — a false
      // positive that would have been read as a real leak.
      const marker = 'zz-conversation-content-zz';
      const queue = new InMemoryQueue({ name: 'consumer', maxAttempts: 1 });
      await queue.enqueue(TENANTS[0], { kind: 'reply', payload: { text: marker } });

      await drain(
        queue,
        {
          reply: async () => {
            // Deliberately interpolates the payload into the message, which is
            // what a well-meaning handler author does. The guarantee has to hold
            // against that, not against handlers that remember not to.
            throw new TransientTransportError(`failed sending: ${marker}`, {
              code: 'whatsapp.400',
            });
          },
        },
        logger,
      );

      const serialised = sink.serialized();
      assert.ok(serialised.includes('queue.handler.failed'), 'the failure was logged at all');
      assert.ok(
        !serialised.includes(marker),
        'a log record carried content from the payload or the error message',
      );
    },
  );

  unitTest('aborting the signal drains in-flight work rather than abandoning it', async () => {
    const queue = new InMemoryQueue({ name: 'consumer' });
    await queue.enqueue(TENANTS[0], { kind: 'reply', payload: {} });

    const controller = new AbortController();
    let released = (): void => {};
    const started = new Promise<void>((resolve) => {
      released = resolve;
    });
    let finished = false;

    const loop = runConsumer({
      queue,
      signal: controller.signal,
      idleWaitMs: 20,
      handlers: {
        reply: async () => {
          released();
          await new Promise((resolve) => setTimeout(resolve, 40));
          finished = true;
        },
      },
    });

    await started;
    controller.abort();
    await loop;

    // `component-independence.md` AC2: a planned restart must not turn in-flight
    // work into lease expiries that a second worker then re-runs.
    assert.equal(finished, true);
    assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 0 });
  });
});
