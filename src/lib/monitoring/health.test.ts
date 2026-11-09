/**
 * Counting and reading back, against a real PostgreSQL.
 *
 * The rows are written directly, at chosen instants, because what is under test is
 * what the triggers count and which hour they put it in. The conversation worker's
 * `start.test.ts` drives the real pipeline over the same triggers.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError, NotFoundError } from '@zeddev/errors';
import { migrateToLatest, PLATFORM_READABLE_TABLES } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { transitionConnection, type ConnectionState } from '@zeddev/whatsapp';
import { listConnectionHealth, listTenantHealth, readTenantHealth, sortTenantHealth, type TenantHealth } from './health.ts';
import { METRIC_RETENTION_DAYS, purgeExpiredMetrics, type MetricSelection } from './metrics.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** A fixed "now", so a test decides which hour each event falls in. */
const NOW = new Date(Date.UTC(2026, 5, 15, 10, 20));
const WITHIN_DAY = new Date(NOW.getTime() - 2 * HOUR);
const WEEK_AGO = new Date(NOW.getTime() - 5 * DAY);
const LAST_DAY: MetricSelection = { kind: 'window', window: '24h' };

describe('operator health', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  before(async () => {
    db = await createTestDatabase('monitoring');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  async function tenant(name = `Business ${(counter += 1)}`, state = 'ready'): Promise<string> {
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, $2) RETURNING id`,
        [name, state],
      );
      return created.rows[0]!.id;
    });
  }

  async function connect(tenantId: string, ...states: ConnectionState[]): Promise<void> {
    await withTenant(pool, tenantId, async (tx) => {
      for (const state of states) await transitionConnection(tx, state);
    });
  }

  async function receive(tenantId: string, at: Date, externalId = `wamid.m-${(counter += 1)}`): Promise<void> {
    await withTenant(pool, tenantId, (tx) =>
      tx.query(
        `INSERT INTO inbound_messages
           (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
         VALUES (app.current_tenant_id(), $1, '4400000001', '15550001111', 'text', 'text', '{"text":"private words"}'::jsonb, $2, $2)
         ON CONFLICT (tenant_id, external_id) DO NOTHING`,
        [externalId, at],
      ),
    );
  }

  interface Answer {
    readonly outcome?: 'reply' | 'fallback' | 'handoff' | 'withheld';
    readonly trigger?: 'ai_error' | 'low_confidence' | 'out_of_scope';
    readonly openedAt?: Date;
  }

  /** A closed turn with a decided answer, whose delivery is still pending. */
  async function answer(tenantId: string, at: Date, options: Answer = {}): Promise<string> {
    const outcome = options.outcome ?? 'reply';
    const hasMessage = outcome === 'reply' || outcome === 'fallback';
    return withTenant(pool, tenantId, async (tx) => {
      const conversation = await tx.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, customer_id) VALUES (app.current_tenant_id(), $1) RETURNING id`,
        [`1555${String((counter += 1)).padStart(7, '0')}`],
      );
      const conversationId = conversation.rows[0]!.id;
      const opened = options.openedAt ?? at;
      const turn = await tx.query<{ id: string }>(
        `INSERT INTO conversation_turns (tenant_id, conversation_id, state, opened_at, closes_at, deadline_at, closed_at)
         VALUES (app.current_tenant_id(), $1, 'closed', $2, $2, $2, $2) RETURNING id`,
        [conversationId, opened],
      );
      const turnId = turn.rows[0]!.id;
      await tx.query(
        `INSERT INTO conversation_turn_outcomes
           (turn_id, tenant_id, conversation_id, outcome, message, delivery_state, fallback_trigger, fallback_cause, fallback_source,
            handoff_reason, withheld_reason, decided_at)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)`,
        [
          turnId,
          conversationId,
          outcome,
          hasMessage ? 'private reply' : null,
          hasMessage ? 'pending' : null,
          outcome === 'fallback' ? (options.trigger ?? 'ai_error') : null,
          outcome === 'fallback' ? 'declined' : null,
          outcome === 'fallback' ? 'platform_default' : null,
          outcome === 'handoff' ? '{"kind":"explicit_request"}' : null,
          outcome === 'withheld' ? 'bot_inactive' : null,
          at,
        ],
      );
      return turnId;
    });
  }

  async function settle(tenantId: string, turnId: string, state: 'sent' | 'failed' | 'expired', at: Date): Promise<void> {
    await withTenant(pool, tenantId, (tx) =>
      tx.query(
        `UPDATE conversation_turn_outcomes
            SET delivery_state = $2,
                delivery_message_id = CASE WHEN $2 = 'sent' THEN 'wamid.out' END,
                delivery_failure = CASE $2 WHEN 'failed' THEN 'rejected' WHEN 'expired' THEN 'window_expired' END,
                delivery_updated_at = $3
          WHERE turn_id = $1`,
        [turnId, state, at],
      ),
    );
  }

  const list = (selection: MetricSelection = LAST_DAY, extra: Partial<Parameters<typeof listTenantHealth>[1]> = {}) =>
    withPlatformScope(pool, (tx) =>
      listTenantHealth(tx, { selection, connection: undefined, sortBy: 'businessName', sortDirection: 'asc', ...extra }, NOW),
    );

  const detail = (tenantId: string, selection: MetricSelection = LAST_DAY) =>
    withPlatformScope(pool, (tx) => readTenantHealth(tx, tenantId, selection, NOW));

  async function rowFor(tenantId: string, selection: MetricSelection = LAST_DAY): Promise<TenantHealth> {
    return (await detail(tenantId, selection)).tenant;
  }

  // -------------------------------------------------------------------------
  // What gets counted
  // -------------------------------------------------------------------------

  unitTest('a message that arrives is counted once, however many times Meta redelivers it', async () => {
    const id = await tenant();
    await receive(id, WITHIN_DAY, 'wamid.same');
    await receive(id, WITHIN_DAY, 'wamid.same');
    await receive(id, WITHIN_DAY);
    assert.equal((await rowFor(id)).metrics?.messagesReceived, 2);
  });

  unitTest('a rolled-back event leaves no count behind', async () => {
    const id = await tenant();
    await assert.rejects(
      withTenant(pool, id, async (tx) => {
        await tx.query(
          `INSERT INTO inbound_messages
             (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
           VALUES (app.current_tenant_id(), 'wamid.gone', '4400000001', '15550001111', 'text', 'text', '{}'::jsonb, $1, $1)`,
          [WITHIN_DAY],
        );
        throw new Error('the transaction fails after the insert');
      }),
    );
    assert.equal((await rowFor(id)).metrics?.messagesReceived, 0);
  });

  unitTest('the count is written at commit, so its row lock is the last one a transaction takes', async () => {
    const id = await tenant();
    const inTransaction = await withTenant(pool, id, async (tx) => {
      await tx.query(
        `INSERT INTO inbound_messages
           (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
         VALUES (app.current_tenant_id(), 'wamid.deferred', '4400000001', '15550001111', 'text', 'text', '{}'::jsonb, $1, $1)`,
        [WITHIN_DAY],
      );
      return tx.query(`SELECT 1 FROM tenant_metric_buckets`);
    });
    assert.equal(inTransaction.rows.length, 0, 'the bucket row was locked before the transaction ended');
    assert.equal((await rowFor(id)).metrics?.messagesReceived, 1);
  });

  unitTest('only a technical fallback is a failed response, and a withheld turn is not an attempt', async () => {
    const id = await tenant();
    await answer(id, WITHIN_DAY);
    await answer(id, WITHIN_DAY, { outcome: 'handoff' });
    await answer(id, WITHIN_DAY, { outcome: 'fallback', trigger: 'out_of_scope' });
    await answer(id, WITHIN_DAY, { outcome: 'fallback', trigger: 'low_confidence' });
    await answer(id, WITHIN_DAY, { outcome: 'fallback', trigger: 'ai_error' });
    await answer(id, WITHIN_DAY, { outcome: 'withheld' });
    const metrics = (await rowFor(id)).metrics!;
    assert.equal(metrics.turnsAnswered, 5);
    assert.equal(metrics.failedResponses, 1);
  });

  specTest(
    'message-delivery-reliability.md',
    'AC8 an exhausted retry allowance records a failure rather than discarding the reply',
    'a delivery counts where it ended, once, and retries along the way count for nothing',
    async () => {
    const id = await tenant();
    const sent = await answer(id, WITHIN_DAY);
    // A retry: pending -> sending -> pending, in the shape delivery.ts writes.
    await withTenant(pool, id, (tx) => tx.query(`UPDATE conversation_turn_outcomes SET delivery_state = 'sending' WHERE turn_id = $1`, [sent]));
    await withTenant(pool, id, (tx) => tx.query(`UPDATE conversation_turn_outcomes SET delivery_state = 'pending' WHERE turn_id = $1`, [sent]));
    await settle(id, sent, 'sent', WITHIN_DAY);
    await settle(id, await answer(id, WITHIN_DAY), 'failed', WITHIN_DAY);
    await settle(id, await answer(id, WITHIN_DAY), 'expired', WITHIN_DAY);
    const metrics = (await rowFor(id)).metrics!;
    assert.equal(metrics.messagesSent, 1);
    assert.equal(metrics.failedDeliveries, 1);
    assert.equal(metrics.expiredDeliveries, 1);
    },
  );

  unitTest('a late report for a delivery that has already ended is not counted again', async () => {
    const id = await tenant();
    const turnId = await answer(id, WITHIN_DAY);
    await settle(id, turnId, 'failed', WITHIN_DAY);
    await settle(id, turnId, 'sent', WITHIN_DAY);
    const metrics = (await rowFor(id)).metrics!;
    assert.equal(metrics.failedDeliveries, 1);
    assert.equal(metrics.messagesSent, 0);
  });

  unitTest('response time runs from the first message of the turn to the answer leaving, averaged', async () => {
    const id = await tenant();
    await settle(id, await answer(id, WITHIN_DAY, { openedAt: new Date(WITHIN_DAY.getTime() - 4_000) }), 'sent', WITHIN_DAY);
    await settle(id, await answer(id, WITHIN_DAY, { openedAt: new Date(WITHIN_DAY.getTime() - 2_000) }), 'sent', WITHIN_DAY);
    await settle(id, await answer(id, WITHIN_DAY, { openedAt: new Date(WITHIN_DAY.getTime() - 9_000) }), 'failed', WITHIN_DAY);
    const metrics = (await rowFor(id)).metrics!;
    assert.equal(metrics.responsesTimed, 2);
    assert.equal(metrics.averageResponseMs, 3_000);
  });

  unitTest('hours are UTC hours whatever time zone the session is in', async () => {
    const id = await tenant();
    await withTenant(pool, id, async (tx) => {
      await tx.query(`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
      await tx.query(
        `INSERT INTO inbound_messages
           (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
         VALUES (app.current_tenant_id(), 'wamid.tz', '4400000001', '15550001111', 'text', 'text', '{}'::jsonb, $1, $1)`,
        [new Date(Date.UTC(2026, 5, 15, 8, 45))],
      );
    });
    const stored = await withPlatformScope(pool, (tx) =>
      tx.query<{ bucket_start: Date }>(`SELECT bucket_start FROM tenant_metric_buckets WHERE tenant_id = $1`, [id]),
    );
    assert.equal(stored.rows[0]?.bucket_start.toISOString(), '2026-06-15T08:00:00.000Z');
  });

  unitTest('concurrent events in one hour lose no count', async () => {
    const id = await tenant();
    await Promise.all(Array.from({ length: 16 }, () => receive(id, WITHIN_DAY)));
    assert.equal((await rowFor(id)).metrics?.messagesReceived, 16);
  });

  // -------------------------------------------------------------------------
  // The all-tenant view
  // -------------------------------------------------------------------------

  specTest(
    'operator-health-monitoring.md',
    'AC1 the dashboard lists every tenant with its connection state',
    'every tenant is listed with its state, including one that never connected a number',
    async () => {
      const connected = await tenant();
      await connect(connected, 'connecting', 'connected');
      const never = await tenant();
      const { tenants } = await list();
      assert.equal(tenants.find((t) => t.tenantId === connected)?.connection.state, 'connected');
      assert.equal(tenants.find((t) => t.tenantId === never)?.connection.state, 'disconnected');
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC10 a newly onboarded tenant appears',
    'a tenant still being provisioned is in the view from the moment it exists',
    async () => {
      const id = await tenant('Brand New', 'provisioning');
      const row = (await list()).tenants.find((t) => t.tenantId === id);
      assert.equal(row?.provisioningState, 'provisioning');
      assert.equal(row?.metrics?.noActivity, true);
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC2 a connection state change is reflected without a reload',
    'the state a dashboard polls changes as soon as the connection does, with last-known-good',
    async () => {
      const id = await tenant();
      await connect(id, 'connecting', 'connected');
      const before = await withPlatformScope(pool, (tx) => listConnectionHealth(tx));
      const seen = before.find((t) => t.tenantId === id);
      assert.equal(seen?.state, 'connected');
      assert.ok(seen?.lastKnownGoodAt);

      await withTenant(pool, id, (tx) => transitionConnection(tx, 'error', { reason: 'authorization_revoked' }));
      const after2 = await withPlatformScope(pool, (tx) => listConnectionHealth(tx));
      assert.equal(after2.find((t) => t.tenantId === id)?.state, 'error');
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC5 filtering by not connected',
    'not_connected keeps every state but connected, and a single state can be asked for',
    async () => {
      const up = await tenant();
      await connect(up, 'connecting', 'connected');
      const connecting = await tenant();
      await connect(connecting, 'connecting');
      const interrupted = await tenant();
      await connect(interrupted, 'connecting', 'connected', 'reconnecting');
      const never = await tenant();

      const ids = (await list(LAST_DAY, { connection: 'not_connected' })).tenants.map((t) => t.tenantId);
      assert.ok(!ids.includes(up));
      for (const id of [connecting, interrupted, never]) assert.ok(ids.includes(id));

      const single = (await list(LAST_DAY, { connection: 'reconnecting' })).tenants.map((t) => t.tenantId);
      assert.ok(single.includes(interrupted) && !single.includes(connecting));
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC6 sorting by error rate',
    'descending puts the worst first and tenants with no traffic last',
    async () => {
      const healthy = await tenant('Sort Healthy');
      await answer(healthy, WITHIN_DAY);
      const worst = await tenant('Sort Worst');
      await answer(worst, WITHIN_DAY, { outcome: 'fallback', trigger: 'ai_error' });
      const middling = await tenant('Sort Middling');
      await answer(middling, WITHIN_DAY, { outcome: 'fallback', trigger: 'ai_error' });
      await answer(middling, WITHIN_DAY);
      await answer(middling, WITHIN_DAY);
      const quiet = await tenant('Sort Quiet');

      const wanted = new Set([healthy, worst, middling, quiet]);
      const order = (await list(LAST_DAY, { sortBy: 'errorRate', sortDirection: 'desc' })).tenants
        .filter((t) => wanted.has(t.tenantId))
        .map((t) => t.tenantId);
      assert.deepEqual(order, [worst, middling, healthy, quiet]);

      const ascending = (await list(LAST_DAY, { sortBy: 'errorRate', sortDirection: 'asc' })).tenants
        .filter((t) => wanted.has(t.tenantId))
        .map((t) => t.tenantId);
      assert.deepEqual(ascending, [healthy, middling, worst, quiet]);
    },
  );

  unitTest('sorting by connection state puts what needs attention first, and ties fall back to the name', () => {
    const row = (name: string, state: ConnectionState): TenantHealth => ({
      tenantId: name,
      businessName: name,
      provisioningState: 'ready',
      onboardedAt: NOW.toISOString(),
      connection: { state, error: null, lastKnownGoodAt: null, changedAt: null },
      metrics: null,
      health: null,
    });
    const sorted = sortTenantHealth(
      [row('b', 'connected'), row('a', 'connected'), row('c', 'error'), row('d', 'reconnecting')],
      'connectionState',
      'asc',
    ).map((t) => t.tenantId);
    assert.deepEqual(sorted, ['c', 'd', 'a', 'b']);
  });

  unitTest('a tenant well above its own normal is flagged in the list without being opened', async () => {
    const id = await tenant();
    const lastWeek = new Date(NOW.getTime() - 3 * DAY);
    for (let i = 0; i < 10; i += 1) await answer(id, lastWeek);
    for (let i = 0; i < 8; i += 1) await answer(id, WITHIN_DAY);
    await answer(id, WITHIN_DAY, { outcome: 'fallback', trigger: 'ai_error' });
    await answer(id, WITHIN_DAY, { outcome: 'fallback', trigger: 'ai_error' });
    const row = (await list()).tenants.find((t) => t.tenantId === id);
    assert.equal(row?.health?.elevatedErrorRate, true);
    assert.equal(row?.health?.degradedResponseTime, false);
  });

  // -------------------------------------------------------------------------
  // One tenant, and time
  // -------------------------------------------------------------------------

  specTest(
    'operator-health-monitoring.md',
    'AC3 the specific error reason is displayed',
    'the detail carries the reason, its explanation, and the transition history',
    async () => {
      const id = await tenant();
      await connect(id, 'connecting', 'connected');
      await withTenant(pool, id, (tx) => transitionConnection(tx, 'error', { reason: 'business_verification_required' }));
      const { tenant: row, transitions } = await detail(id);
      assert.equal(row.connection.state, 'error');
      assert.equal(row.connection.error?.reason, 'business_verification_required');
      assert.match(row.connection.error?.description ?? '', /business verification/);
      assert.ok(row.connection.lastKnownGoodAt);
      assert.deepEqual(
        transitions.map((t) => t.to),
        ['error', 'connected', 'connecting'],
      );
      assert.equal(transitions[0]?.errorReason, 'business_verification_required');
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC4 a selected time window sets what the metrics cover',
    'widening the window brings in the older hours',
    async () => {
      const id = await tenant();
      await receive(id, WITHIN_DAY);
      await receive(id, WEEK_AGO);
      assert.equal((await rowFor(id, { kind: 'window', window: '24h' })).metrics?.messagesReceived, 1);
      assert.equal((await rowFor(id, { kind: 'window', window: '7d' })).metrics?.messagesReceived, 2);
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC7 historical metrics within the retention window are retrievable',
    'a past range returns that range’s numbers and no others',
    async () => {
      const id = await tenant();
      const past = new Date(NOW.getTime() - 40 * DAY);
      await receive(id, past);
      await receive(id, past);
      await receive(id, WITHIN_DAY);
      const metrics = (await rowFor(id, { kind: 'range', from: new Date(past.getTime() - DAY), to: new Date(past.getTime() + DAY) })).metrics;
      assert.equal(metrics?.messagesReceived, 2);
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC8 historical metrics outside the retention window are reported unavailable',
    'the range is marked unavailable and the numbers are absent rather than zero',
    async () => {
      const id = await tenant();
      await receive(id, new Date(NOW.getTime() - 200 * DAY));
      const selection: MetricSelection = { kind: 'range', from: new Date(NOW.getTime() - 201 * DAY), to: new Date(NOW.getTime() - 199 * DAY) };
      const answerFor = await detail(id, selection);
      assert.equal(answerFor.range.available, false);
      assert.equal(answerFor.tenant.metrics, null);
      assert.equal(answerFor.tenant.health, null);
      const listed = await list(selection);
      assert.equal(listed.range.available, false);
      assert.equal(listed.tenants.find((t) => t.tenantId === id)?.metrics, null);
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC11 zero traffic displays as zero or no activity',
    'a quiet tenant answers with zeroes in both views',
    async () => {
      const id = await tenant();
      await receive(id, WEEK_AGO);
      const metrics = (await rowFor(id)).metrics;
      assert.equal(metrics?.noActivity, true);
      assert.equal(metrics?.messagesSent, 0);
      assert.equal(metrics?.errorRate, null);
      assert.equal((await list()).tenants.find((t) => t.tenantId === id)?.metrics?.noActivity, true);
    },
  );

  unitTest('an unknown tenant is not found', async () => {
    await assert.rejects(detail('00000000-0000-4000-8000-00000000abcd'), NotFoundError);
  });

  unitTest('every read refuses to run outside the platform scope, rather than showing an empty platform', async () => {
    const id = await tenant();
    await withTenant(pool, id, async (tx) => {
      await assert.rejects(listConnectionHealth(tx), DefectError);
      await assert.rejects(
        listTenantHealth(tx, { selection: LAST_DAY, connection: undefined, sortBy: 'businessName', sortDirection: 'asc' }, NOW),
        DefectError,
      );
      await assert.rejects(readTenantHealth(tx, id, LAST_DAY, NOW), DefectError);
    });
  });

  // -------------------------------------------------------------------------
  // Content, and isolation
  // -------------------------------------------------------------------------

  specTest(
    'operator-health-monitoring.md',
    'AC9 no conversation content is visible',
    'the table behind every operator number has no column that could hold text',
    async () => {
      assert.ok((PLATFORM_READABLE_TABLES as readonly string[]).includes('tenant_metric_buckets'));
      const columns = await pool.query<{ data_type: string }>(
        `SELECT DISTINCT data_type FROM information_schema.columns WHERE table_name = 'tenant_metric_buckets'`,
      );
      const allowed = new Set(['uuid', 'timestamp with time zone', 'integer', 'bigint']);
      for (const { data_type: type } of columns.rows) assert.ok(allowed.has(type), `${type} could hold content`);
      assert.ok(columns.rows.length >= 3);
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'AC9 no conversation content is visible',
    'neither view carries a message, a reply, or a customer number',
    async () => {
      const id = await tenant();
      await receive(id, WITHIN_DAY);
      await settle(id, await answer(id, WITHIN_DAY), 'sent', WITHIN_DAY);
      const seen = JSON.stringify([await detail(id), await list()]);
      assert.ok(!seen.includes('private words'));
      assert.ok(!seen.includes('private reply'));
      assert.ok(!seen.includes('15550001111'));
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC2 one tenant cannot read another tenant’s data',
    'a tenant sees its own counts only, and cannot write another tenant’s',
    async () => {
      const mine = await tenant();
      const theirs = await tenant();
      await receive(theirs, WITHIN_DAY);
      await withTenant(pool, mine, async (tx) => {
        const visible = await tx.query(`SELECT 1 FROM tenant_metric_buckets WHERE tenant_id = $1`, [theirs]);
        assert.equal(visible.rows.length, 0);
      });
      await assert.rejects(
        withTenant(pool, mine, (tx) =>
          tx.query(`INSERT INTO tenant_metric_buckets (tenant_id, bucket_start) VALUES ($1, date_trunc('hour', now(), 'UTC'))`, [theirs]),
        ),
      );
    },
  );

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  specTest(
    'operator-health-monitoring.md',
    'AC8 historical metrics outside the retention window are reported unavailable',
    'the sweep deletes exactly what the view already calls unavailable',
    async () => {
      const id = await tenant();
      const oldest = Date.UTC(2026, 5, 15, 10) - METRIC_RETENTION_DAYS * DAY;
      await receive(id, new Date(oldest - HOUR));
      await receive(id, new Date(oldest));
      const hours = async (): Promise<readonly number[]> => {
        const rows = await withPlatformScope(pool, (tx) =>
          tx.query<{ bucket_start: Date }>(`SELECT bucket_start FROM tenant_metric_buckets WHERE tenant_id = $1 ORDER BY 1`, [id]),
        );
        return rows.rows.map((row) => row.bucket_start.getTime());
      };
      assert.deepEqual(await hours(), [oldest - HOUR, oldest]);

      assert.ok((await purgeExpiredMetrics(pool, NOW)) >= 1);
      assert.deepEqual(await hours(), [oldest]);
      assert.equal(await purgeExpiredMetrics(pool, NOW), 0, 'a second sweep has nothing to do');
    },
  );
});
