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
import { Pool, withHeartbeatScope, withPlatformScope } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { Logger, type LogRecord } from '@zeddev/logging';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import {
  COMPONENTS,
  HEARTBEAT,
  readComponentStatus,
  startHeartbeat,
  summarize,
  type Component,
  type ComponentStatus,
  type InstanceRow,
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
