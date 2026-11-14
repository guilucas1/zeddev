/**
 * Component heartbeats and the operator's component view, against a real PostgreSQL.
 *
 * Lateness is judged by the database's clock, so "silent" is produced here the
 * honest way: a heartbeat with a short interval is stopped from beating (its pool
 * is closed without a clean stop) and the test waits out the missed beats.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, before, describe } from 'node:test';
import { Pool, withDispatchScope, withHeartbeatScope, withIdentityScope, withPlatformScope, withTenant } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { Logger, type LogRecord } from '@zeddev/logging';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { INBOUND_QUEUE } from '@zeddev/whatsapp';
import {
  BACKLOG,
  COMPONENTS,
  describeBacklog,
  HEARTBEAT,
  QUEUE_CONSUMERS,
  readComponentStatus,
  startHeartbeat,
  summarize,
  withBacklog,
  type BacklogRow,
  type Component,
  type ComponentReport,
  type ComponentStatus,
  type InstanceRow,
  type QueueBacklog,
} from './components.ts';

const silentLogger = (records: LogRecord[] = []): Logger => new Logger({ sink: { write: (record) => void records.push(record) } });

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('component heartbeats', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;

  before(async () => {
    db = await createTestDatabase('components');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  /** A pool of its own, as the fixture role, so closing it is one process losing the database. */
  const ownPool = (): Pool => new Pool({ ...db.options, maxConnections: 2, acquireTimeoutMs: 1_000, idleTimeoutMs: 1_000 });

  async function clear(): Promise<void> {
    await withHeartbeatScope(pool, (tx) => tx.query('DELETE FROM component_heartbeats'));
  }

  async function status(component: Component): Promise<ComponentStatus> {
    const report = await withPlatformScope(pool, (tx) => readComponentStatus(tx));
    return report.components.find((entry) => entry.component === component)!;
  }

  /** A heartbeat whose own pool can be cut, which is what a crashed process looks like from the database. */
  async function doomedHeartbeat(component: Component, intervalMs: number) {
    const own = ownPool();
    const heartbeat = await startHeartbeat({ pool: own, component, logger: silentLogger(), intervalMs, host: 'doomed' });
    return {
      heartbeat,
      crash: async () => {
        // The timer keeps firing and failing against a closed pool, which is the
        // point: nothing is recorded, as when the process is gone.
        await own.end();
      },
    };
  }

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'every component is answered, and one that never reported is down with that reason',
    async () => {
      await clear();
      const heartbeat = await startHeartbeat({ pool, component: 'api', logger: silentLogger(), host: 'api-1' });
      try {
        const report = await withPlatformScope(pool, (tx) => readComponentStatus(tx));
        assert.deepEqual(report.components.map((entry) => entry.component), [...COMPONENTS]);
        const api = report.components.find((entry) => entry.component === 'api')!;
        assert.equal(api.state, 'up');
        assert.equal(api.reason, null);
        assert.equal(api.live, 1);
        assert.equal(api.instances[0]!.host, 'api-1');
        assert.equal(api.instances[0]!.instanceId, heartbeat.instanceId);
        for (const other of report.components.filter((entry) => entry.component !== 'api')) {
          assert.equal(other.state, 'down', other.component);
          assert.equal(other.reason, 'never_reported', other.component);
          assert.equal(other.lastSeenAt, null);
        }
      } finally {
        await heartbeat.stop();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'a clean shutdown reads as stopped, a crash as silent, and the two are told apart',
    async () => {
      await clear();
      const clean = await startHeartbeat({ pool, component: 'scheduler', logger: silentLogger(), intervalMs: 200 });
      await clean.stop();
      assert.deepEqual(
        { state: (await status('scheduler')).state, reason: (await status('scheduler')).reason },
        { state: 'down', reason: 'stopped' },
      );

      const { crash } = await doomedHeartbeat('conversation-worker', 200);
      assert.equal((await status('conversation-worker')).state, 'up');
      await crash();
      // Three missed beats of 200 ms, with room for the database round trip.
      await sleep(200 * HEARTBEAT.missedBeats + 400);
      const worker = await status('conversation-worker');
      assert.equal(worker.state, 'down');
      assert.equal(worker.reason, 'silent');
      assert.equal(worker.instances[0]!.state, 'silent');
      assert.equal(worker.instances[0]!.stoppedAt, null);
    },
  );

  specTest(
    'component-independence.md',
    'AC3 scaling one component changes no other',
    'each instance of a scaled component is counted, and losing one alongside the others reads as degraded',
    async () => {
      await clear();
      const first = await startHeartbeat({ pool, component: 'conversation-worker', logger: silentLogger(), host: 'w1' });
      const { crash } = await doomedHeartbeat('conversation-worker', 200);
      try {
        const both = await status('conversation-worker');
        assert.equal(both.state, 'up');
        assert.equal(both.live, 2);

        await crash();
        await sleep(200 * HEARTBEAT.missedBeats + 400);
        const one = await status('conversation-worker');
        assert.equal(one.live, 1);
        assert.equal(one.state, 'degraded');
        assert.equal(one.reason, 'instance_silent');
        // The others' rows are untouched by it.
        assert.equal((await status('api')).reason, 'never_reported');
      } finally {
        await first.stop();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC6 a component deliberately stopped resumes normal operation when later restarted, with no other intervention',
    'a restarted component is up again, and the instance it replaced is history rather than a fault',
    async () => {
      await clear();
      const { crash } = await doomedHeartbeat('whatsapp-gateway', 200);
      await crash();
      await sleep(200 * HEARTBEAT.missedBeats + 400);
      assert.equal((await status('whatsapp-gateway')).state, 'down');

      const restarted = await startHeartbeat({ pool, component: 'whatsapp-gateway', logger: silentLogger() });
      try {
        const gateway = await status('whatsapp-gateway');
        assert.equal(gateway.state, 'up');
        assert.equal(gateway.reason, null);
        assert.equal(gateway.instances.length, 2);
        assert.deepEqual(gateway.instances.map((instance) => instance.state), ['live', 'silent']);
      } finally {
        await restarted.stop();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'a heartbeat keeps beating on its own timer and survives the database going away without throwing',
    async () => {
      await clear();
      const records: LogRecord[] = [];
      const own = ownPool();
      const heartbeat = await startHeartbeat({ pool: own, component: 'api', logger: silentLogger(records), intervalMs: 150 });
      const firstSeen = (await status('api')).lastSeenAt!;
      await sleep(500);
      assert.ok((await status('api')).lastSeenAt! > firstSeen, 'later beats must move last_seen_at');

      await own.end();
      await sleep(400);
      // Logged once for the run of failures, not once per beat.
      assert.equal(records.filter((record) => record.event === 'component.heartbeat.failed').length, 1);
      await heartbeat.stop();
      assert.equal(records.filter((record) => record.event === 'component.heartbeat.stop_failed').length, 1);
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'a process starting prunes instances past retention, and leaves recent ones',
    async () => {
      await clear();
      await withHeartbeatScope(pool, (tx) =>
        tx.query(
          `INSERT INTO component_heartbeats (instance_id, component, host, interval_ms, started_at, last_seen_at)
           VALUES (gen_random_uuid(), 'scheduler', 'ancient', 1000, now() - interval '30 days', now() - interval '30 days'),
                  (gen_random_uuid(), 'scheduler', 'recent', 1000, now() - interval '1 day', now() - interval '1 day')`,
        ),
      );
      const heartbeat = await startHeartbeat({ pool, component: 'api', logger: silentLogger() });
      await heartbeat.stop();
      const scheduler = await status('scheduler');
      assert.deepEqual(scheduler.instances.map((instance) => instance.host), ['recent']);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC7 the operator sees status and metrics only, never conversation content',
    'outside both scopes the heartbeat table can be neither read nor written',
    async () => {
      await clear();
      const heartbeat = await startHeartbeat({ pool, component: 'api', logger: silentLogger() });
      try {
        const bare = await pool.query('SELECT instance_id FROM component_heartbeats');
        assert.equal(bare.rowCount, 0);
        await assert.rejects(
          pool.query(`INSERT INTO component_heartbeats (instance_id, component, host, interval_ms) VALUES (gen_random_uuid(), 'api', 'x', 1000)`),
        );
        // The operator reads but does not write.
        await assert.rejects(
          withPlatformScope(pool, (tx) =>
            tx.query(`INSERT INTO component_heartbeats (instance_id, component, host, interval_ms) VALUES (gen_random_uuid(), 'api', 'x', 1000)`),
          ),
        );
      } finally {
        await heartbeat.stop();
      }
    },
  );

  // --- Queue backlog (migration 0022) -------------------------------------------

  let tenantCounter = 0;
  async function tenant(): Promise<string> {
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Backlog business ${(tenantCounter += 1)}`],
      );
      return created.rows[0]!.id;
    });
  }

  async function clearQueue(): Promise<void> {
    await withDispatchScope(pool, (tx) => tx.query('DELETE FROM queue_jobs'));
  }

  interface JobShape {
    readonly state: 'ready' | 'running' | 'succeeded' | 'dead';
    /** A PostgreSQL interval relative to the database's now(), e.g. '-2 minutes'. */
    readonly runAt?: string;
    readonly leasedUntil?: string;
    readonly finishedAt?: string;
    readonly partition?: string;
  }

  /** Jobs written as their tenant writes them, with times set relative to the database's clock. */
  async function jobs(tenantId: string, ...shapes: JobShape[]): Promise<void> {
    await withTenant(pool, tenantId, async (tx) => {
      for (const shape of shapes) {
        await tx.query(
          `INSERT INTO queue_jobs (tenant_id, queue, kind, max_attempts, state, partition_ref, run_at, leased_until, finished_at)
           VALUES (app.current_tenant_id(), $1, 'test.job', 3, $2, $3,
                   now() + $4::interval,
                   now() + $5::interval,
                   now() + $6::interval)`,
          [INBOUND_QUEUE, shape.state, shape.partition ?? null, shape.runAt ?? '0 seconds', shape.leasedUntil ?? null, shape.finishedAt ?? null],
        );
      }
    });
  }

  async function report(): Promise<ComponentReport> {
    return withPlatformScope(pool, (tx) => readComponentStatus(tx));
  }

  const inbound = (answer: ComponentReport): QueueBacklog => answer.queues.find((queue) => queue.queue === INBOUND_QUEUE)!;
  const worker = (answer: ComponentReport): ComponentStatus =>
    answer.components.find((entry) => entry.component === 'conversation-worker')!;

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'a worker that is reporting while due work waits past the limit reads as degraded by backlog, and no other component does',
    async () => {
      await clear();
      await clearQueue();
      const live = await startHeartbeat({ pool, component: 'conversation-worker', logger: silentLogger() });
      const api = await startHeartbeat({ pool, component: 'api', logger: silentLogger() });
      try {
        const calm = await report();
        assert.equal(worker(calm).state, 'up');
        // Watched even when empty, so the operator can tell "nothing waiting" from "not looked at".
        assert.deepEqual(
          { ...inbound(calm) },
          {
            queue: INBOUND_QUEUE, consumer: 'conversation-worker', due: 0, tenantsWaiting: 0, scheduled: 0, running: 0,
            expiredLeases: 0, deadLastDay: 0, waitingSince: null, waitingMs: 0, stalled: false,
          },
        );

        const first = await tenant();
        const second = await tenant();
        await jobs(first, { state: 'ready', runAt: '-2 minutes' }, { state: 'ready', runAt: '-10 seconds' });
        await jobs(second, { state: 'ready', runAt: '-5 seconds' });
        const stuck = await report();
        const queue = inbound(stuck);
        assert.equal(queue.due, 3);
        assert.equal(queue.tenantsWaiting, 2);
        assert.equal(queue.stalled, true);
        assert.ok(queue.waitingMs >= 120_000 && queue.waitingMs < 125_000, String(queue.waitingMs));
        assert.equal(Date.parse(stuck.checkedAt) - Date.parse(queue.waitingSince!), queue.waitingMs);
        assert.deepEqual([worker(stuck).state, worker(stuck).reason, worker(stuck).live], ['degraded', 'backlog', 1]);
        const apiStatus = stuck.components.find((entry) => entry.component === 'api')!;
        assert.deepEqual([apiStatus.state, apiStatus.reason], ['up', null]);
      } finally {
        await live.stop();
        await api.stop();
        await clearQueue();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'work held back by its own partition, work not yet due, and recent work are not backlog',
    async () => {
      await clear();
      await clearQueue();
      const live = await startHeartbeat({ pool, component: 'conversation-worker', logger: silentLogger() });
      try {
        const id = await tenant();
        const customer = 'a'.repeat(64);
        // A turn being answered, and the same customer's later messages behind it:
        // that is ordering (message-delivery-reliability.md AC5), not a stalled consumer.
        await jobs(
          id,
          { state: 'running', runAt: '-5 minutes', leasedUntil: '1 minute', partition: customer },
          { state: 'ready', runAt: '-4 minutes', partition: customer },
          { state: 'ready', runAt: '-3 minutes', partition: customer },
          { state: 'ready', runAt: '30 seconds' },
          { state: 'ready', runAt: '-1 second' },
          { state: 'dead', runAt: '-1 hour', finishedAt: '-10 minutes' },
          { state: 'dead', runAt: '-3 days', finishedAt: '-2 days' },
          { state: 'succeeded', runAt: '-1 hour', finishedAt: '-50 minutes' },
        );
        const answer = await report();
        const queue = inbound(answer);
        assert.deepEqual(
          { due: queue.due, scheduled: queue.scheduled, running: queue.running, expired: queue.expiredLeases, dead: queue.deadLastDay },
          { due: 1, scheduled: 1, running: 1, expired: 0, dead: 1 },
        );
        assert.equal(queue.stalled, false);
        assert.ok(queue.waitingMs >= 1_000 && queue.waitingMs < 5_000, String(queue.waitingMs));
        assert.deepEqual([worker(answer).state, worker(answer).reason], ['up', null]);
      } finally {
        await live.stop();
        await clearQueue();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'a lease left expired, which a consuming worker would have taken back, reads as backlog',
    async () => {
      await clear();
      await clearQueue();
      const live = await startHeartbeat({ pool, component: 'conversation-worker', logger: silentLogger() });
      try {
        const id = await tenant();
        await jobs(
          id,
          { state: 'running', runAt: '-5 minutes', leasedUntil: '-90 seconds' },
          { state: 'running', runAt: '-1 minute', leasedUntil: '2 minutes' },
        );
        const answer = await report();
        const queue = inbound(answer);
        assert.deepEqual([queue.running, queue.expiredLeases, queue.due], [2, 1, 0]);
        assert.ok(queue.waitingMs >= 90_000 && queue.waitingMs < 95_000, String(queue.waitingMs));
        assert.equal(queue.stalled, true);
        assert.deepEqual([worker(answer).state, worker(answer).reason], ['degraded', 'backlog']);
      } finally {
        await live.stop();
        await clearQueue();
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'with no worker at all, the worker reads as down and the waiting work is still visible',
    async () => {
      await clear();
      await clearQueue();
      try {
        const id = await tenant();
        await jobs(id, { state: 'ready', runAt: '-3 minutes' });
        const answer = await report();
        // Down is the more specific answer: nothing is there to consume.
        assert.deepEqual([worker(answer).state, worker(answer).reason], ['down', 'never_reported']);
        assert.deepEqual([inbound(answer).due, inbound(answer).stalled], [1, true]);
      } finally {
        await clearQueue();
      }
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC7 the operator sees status and metrics only, never conversation content',
    'the backlog is counts only, refused outside the platform scope, and leaves the operator unable to read a job',
    async () => {
      await clearQueue();
      const id = await tenant();
      await jobs(id, { state: 'ready', runAt: '-1 second', partition: 'b'.repeat(64) });
      try {
        // Refused, not silently empty: an empty answer would read as "no backlog".
        await assert.rejects(pool.query('SELECT * FROM app.queue_backlog()'), { code: 'tenant.access_denied' });
        await assert.rejects(withTenant(pool, id, (tx) => tx.query('SELECT * FROM app.queue_backlog()')), { code: 'tenant.access_denied' });
        await assert.rejects(withDispatchScope(pool, (tx) => tx.query('SELECT * FROM app.queue_backlog()')), { code: 'tenant.access_denied' });

        await withPlatformScope(pool, async (tx) => {
          const answer = await tx.query<Record<string, unknown>>('SELECT * FROM app.queue_backlog()');
          // The shape is fixed in the database: no tenant id, partition, job id, or error.
          assert.deepEqual(Object.keys(answer.rows[0]!).sort(), [
            'dead_last_day', 'due', 'expired_leases', 'oldest_due_at', 'oldest_expired_lease_at',
            'queue', 'running', 'scheduled', 'tenants_waiting',
          ]);
          // The dispatch scope lasted only as long as the function did.
          const scope = await tx.query<{ value: string | null }>(`SELECT current_setting('app.dispatch_scope', true) AS value`);
          assert.notEqual(scope.rows[0]!.value, 'on');
          const rows = await tx.query('SELECT partition_ref FROM queue_jobs');
          assert.equal(rows.rowCount, 0);
        });
      } finally {
        await clearQueue();
      }
    },
  );

  unitTest('the inbound queue is charged to the conversation worker', () => {
    assert.equal(QUEUE_CONSUMERS[INBOUND_QUEUE], 'conversation-worker');
  });

  unitTest('the component list and the migration CHECK name the same components', () => {
    const migration = readFileSync(
      new URL('../schema/migrations/0021_component_heartbeats.sql', import.meta.url),
      'utf8',
    );
    const check = /component IN \(([^)]*)\)/.exec(migration);
    assert.ok(check !== null);
    const listed = check[1]!.split(',').map((entry) => entry.trim().replace(/^'|'$/g, ''));
    assert.deepEqual([...listed].sort(), [...COMPONENTS].sort());
  });
});

describe('summarize', () => {
  const at = (seconds: number): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds));
  const row = (state: InstanceRow['state'], startedAt: number, lastSeenAt: number): InstanceRow => ({
    instance_id: `00000000-0000-4000-8000-${String(startedAt).padStart(12, '0')}`,
    component: 'scheduler',
    host: 'h',
    state,
    started_at: at(startedAt),
    last_seen_at: at(lastSeenAt),
    stopped_at: state === 'stopped' ? at(lastSeenAt) : null,
  });

  unitTest('a silent instance last seen before every live one started was replaced, and is not a fault', () => {
    assert.equal(summarize('scheduler', [row('live', 10, 50), row('silent', 0, 9)]).state, 'up');
  });

  unitTest('a silent instance last seen after a live one started ran alongside it, and is', () => {
    const summary = summarize('scheduler', [row('live', 10, 50), row('silent', 0, 20)]);
    assert.deepEqual([summary.state, summary.reason], ['degraded', 'instance_silent']);
  });

  unitTest('a stopped instance alongside a live one is a scale-down, not a fault', () => {
    assert.equal(summarize('scheduler', [row('live', 10, 50), row('stopped', 0, 20)]).state, 'up');
  });

  unitTest('with nothing live, the newest instance decides between stopped and silent', () => {
    assert.equal(summarize('scheduler', [row('stopped', 10, 50), row('silent', 0, 20)]).reason, 'stopped');
    assert.equal(summarize('scheduler', [row('silent', 10, 50), row('stopped', 0, 20)]).reason, 'silent');
  });
});

describe('backlog judgement', () => {
  const now = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
  const ago = (ms: number): Date => new Date(now.getTime() - ms);
  const row = (overrides: Partial<BacklogRow>): BacklogRow => ({
    queue: INBOUND_QUEUE, due: '0', oldest_due_at: null, tenants_waiting: '0', scheduled: '0', running: '0',
    expired_leases: '0', oldest_expired_lease_at: null, dead_last_day: '0', ...overrides,
  });
  const up: ComponentStatus = { component: 'conversation-worker', state: 'up', reason: null, live: 1, lastSeenAt: null, instances: [] };

  unitTest('the longest wait is the earlier of the oldest due job and the oldest expired lease', () => {
    const [queue] = describeBacklog(
      [row({ due: '1', oldest_due_at: ago(5_000), expired_leases: '1', oldest_expired_lease_at: ago(9_000) })],
      now,
    );
    assert.equal(queue!.waitingMs, 9_000);
    assert.equal(queue!.waitingSince, ago(9_000).toISOString());
  });

  unitTest('waiting exactly the limit is not stalled; a millisecond past it is', () => {
    assert.equal(describeBacklog([row({ due: '1', oldest_due_at: ago(BACKLOG.stalledAfterMs) })], now)[0]!.stalled, false);
    assert.equal(describeBacklog([row({ due: '1', oldest_due_at: ago(BACKLOG.stalledAfterMs + 1) })], now)[0]!.stalled, true);
  });

  unitTest('a queue nothing here consumes is shown but charged to no component', () => {
    const queues = describeBacklog([row({ queue: 'other_work', due: '1', oldest_due_at: ago(600_000) })], now);
    assert.deepEqual(
      queues.map((queue) => [queue.queue, queue.consumer]),
      [[INBOUND_QUEUE, 'conversation-worker'], ['other_work', null]],
    );
    assert.equal(withBacklog(up, queues).state, 'up');
  });

  unitTest('a stalled queue degrades only its consumer, and only when up; down and instance_silent keep their reason', () => {
    const queues = describeBacklog([row({ due: '1', oldest_due_at: ago(600_000) })], now);
    const degraded = withBacklog(up, queues);
    assert.deepEqual([degraded.state, degraded.reason], ['degraded', 'backlog']);
    const down: ComponentStatus = { ...up, state: 'down', reason: 'silent', live: 0 };
    assert.equal(withBacklog(down, queues), down);
    const silent: ComponentStatus = { ...up, state: 'degraded', reason: 'instance_silent' };
    assert.equal(withBacklog(silent, queues), silent);
    const api: ComponentStatus = { ...up, component: 'api' };
    assert.equal(withBacklog(api, queues), api);
  });
});
