/**
 * The WhatsApp connection state machine, against a real PostgreSQL.
 *
 * The transition table is pure and tested as such. What needs the database is
 * that the history is written for every change by the trigger (AC10), that the
 * vocabulary and the error-reason pairing hold even for a write that bypasses
 * this module, and that one tenant's connection is invisible from another's
 * context while the operator can read every tenant's.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConflictError, DefectError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import {
  CONNECTION_ERROR_REASONS,
  CONNECTION_STATES,
  CONNECTION_TRANSITIONS,
  connectionHistory,
  describeConnection,
  disconnectWhatsApp,
  ERROR_REASON_DESCRIPTIONS,
  readConnection,
  transitionConnection,
  type ConnectionState,
} from './connection.ts';

unitTest('only connecting and reconnecting lead to connected', () => {
  const into = CONNECTION_STATES.filter((from) => CONNECTION_TRANSITIONS[from].includes('connected'));
  assert.deepEqual(into, ['connecting', 'reconnecting']);
});

unitTest('reconnecting is reachable only from connected', () => {
  const into = CONNECTION_STATES.filter((from) => CONNECTION_TRANSITIONS[from].includes('reconnecting'));
  assert.deepEqual(into, ['connected']);
});

specTest(
  'whatsapp-number-connection.md',
  'AC12 a connection in error displays a specific reason',
  'every error reason has its own human-readable description, and business verification reads as external action',
  () => {
    const descriptions = CONNECTION_ERROR_REASONS.map((reason) => ERROR_REASON_DESCRIPTIONS[reason]);
    assert.equal(new Set(descriptions).size, descriptions.length, 'two reasons share one description');
    for (const text of descriptions) assert.ok(text.length > 20);
    assert.match(ERROR_REASON_DESCRIPTIONS.business_verification_required, /Meta/);
  },
);

describe('whatsapp connection', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Connection Cafe ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  function move(tenant: string, to: ConnectionState, reason?: (typeof CONNECTION_ERROR_REASONS)[number]) {
    return withTenant(pool, tenant, (tx) => transitionConnection(tx, to, { reason }));
  }

  before(async () => {
    db = await createTestDatabase('whatsapp');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  unitTest('a tenant that never connected reads as disconnected with no history', async () => {
    const tenant = await newTenant();
    const status = await withTenant(pool, tenant, (tx) => readConnection(tx));
    assert.deepEqual(status, { state: 'disconnected', errorReason: null, lastKnownGoodAt: null, changedAt: null });
    assert.deepEqual(await withTenant(pool, tenant, (tx) => connectionHistory(tx)), []);
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC2 submitted but unverified configuration is connecting, not connected',
    'starting a connection records connecting, and a disconnected number cannot jump straight to connected',
    async () => {
      const tenant = await newTenant();
      await assert.rejects(() => move(tenant, 'connected'), ConflictError);
      const started = await move(tenant, 'connecting');
      assert.equal(started.state, 'connecting');
      assert.equal(started.lastKnownGoodAt, null);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC5 recovery from reconnecting returns to connected and is recorded with a timestamp',
    'connecting → connected → reconnecting → connected is recorded in order, each with a timestamp',
    async () => {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      const connected = await move(tenant, 'connected');
      assert.ok(connected.lastKnownGoodAt instanceof Date);
      const interrupted = await move(tenant, 'reconnecting');
      assert.equal(interrupted.state, 'reconnecting');
      await move(tenant, 'connected');

      const history = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.deepEqual(
        history.map((entry) => `${entry.from}->${entry.to}`),
        ['reconnecting->connected', 'connected->reconnecting', 'connecting->connected', 'disconnected->connecting'],
      );
      for (const entry of history) assert.ok(entry.occurredAt instanceof Date);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC6 exhausted recovery transitions to error with a surfaced reason',
    'reconnecting → error requires a reason, stores it, and the client view spells it out',
    async () => {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      await move(tenant, 'connected');
      await move(tenant, 'reconnecting');
      await assert.rejects(() => move(tenant, 'error'), ValidationError);
      const failed = await move(tenant, 'error', 'recovery_exhausted');
      assert.equal(failed.errorReason, 'recovery_exhausted');

      const view = describeConnection(failed);
      assert.deepEqual(view.error, {
        reason: 'recovery_exhausted',
        description: ERROR_REASON_DESCRIPTIONS.recovery_exhausted,
      });
      // Last-known-good is when the link stopped being good, not cleared by the failure.
      assert.ok(failed.lastKnownGoodAt instanceof Date);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC9 incomplete Meta business verification is a distinct blocking condition',
    'business verification is its own error reason, and a change of reason within error is recorded',
    async () => {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      await move(tenant, 'error', 'rate_limited');
      const blocked = await move(tenant, 'error', 'business_verification_required');
      assert.equal(blocked.errorReason, 'business_verification_required');
      await assert.rejects(() => move(tenant, 'error', 'business_verification_required'), ConflictError);

      const history = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.deepEqual(
        history.map((entry) => entry.errorReason),
        ['business_verification_required', 'rate_limited', null],
      );
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC7 manual disconnect from connected, error, or reconnecting',
    'the client can disconnect from each of those states, and disconnecting twice changes nothing',
    async () => {
      for (const path of [['connecting', 'connected'], ['connecting', 'connected', 'reconnecting'], ['connecting']] as const) {
        const tenant = await newTenant();
        for (const state of path) await move(tenant, state);
        const done = await withTenant(pool, tenant, (tx) => disconnectWhatsApp(tx));
        assert.equal(done.state, 'disconnected');
        assert.equal(done.errorReason, null);
      }

      const failed = await newTenant();
      await move(failed, 'connecting');
      await move(failed, 'error', 'configuration_invalid');
      const cleared = await withTenant(pool, failed, (tx) => disconnectWhatsApp(tx));
      assert.equal(cleared.state, 'disconnected');
      assert.equal(cleared.errorReason, null, 'the stale error reason survived the disconnect');

      const before = (await withTenant(pool, failed, (tx) => connectionHistory(tx))).length;
      await withTenant(pool, failed, (tx) => disconnectWhatsApp(tx));
      assert.equal((await withTenant(pool, failed, (tx) => connectionHistory(tx))).length, before);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC10 every state transition is recorded with a timestamp and retrievable as history',
    'a write that bypasses the library is recorded too, and history cannot be rewritten',
    async () => {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      await withTenant(pool, tenant, (tx) =>
        tx.query(`UPDATE whatsapp_connections SET state = 'connected', changed_at = now()`),
      );
      const history = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.equal(history[0]?.to, 'connected');

      await withTenant(pool, tenant, async (tx) => {
        const updated = await tx.query(`UPDATE whatsapp_connection_transitions SET to_state = 'error'`);
        const deleted = await tx.query(`DELETE FROM whatsapp_connection_transitions`);
        assert.equal(updated.rowCount, 0);
        assert.equal(deleted.rowCount, 0);
      });
    },
  );

  unitTest('the database refuses a state outside the vocabulary and an error without a reason', async () => {
    const tenant = await newTenant();
    await move(tenant, 'connecting');
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) => tx.query(`UPDATE whatsapp_connections SET state = 'online'`)),
    );
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) => tx.query(`UPDATE whatsapp_connections SET state = 'error'`)),
    );
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) =>
        tx.query(`UPDATE whatsapp_connections SET error_reason = 'rate_limited'`),
      ),
    );
  });

  unitTest('the vocabulary and error reasons agree with the database constraints', async () => {
    // Every state and reason the library offers is accepted...
    for (const reason of CONNECTION_ERROR_REASONS) {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      await move(tenant, 'error', reason);
    }
    for (const state of CONNECTION_STATES) {
      const tenant = await newTenant();
      await withTenant(pool, tenant, (tx) =>
        tx.query(`INSERT INTO whatsapp_connections (tenant_id, state, error_reason)
                  VALUES (app.current_tenant_id(), $1, $2)`, [state, state === 'error' ? 'rate_limited' : null]),
      );
    }
    // ...and a reason the library does not offer is refused.
    const tenant = await newTenant();
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) =>
        tx.query(`INSERT INTO whatsapp_connections (tenant_id, state, error_reason)
                  VALUES (app.current_tenant_id(), 'error', 'solar_flare')`),
      ),
    );
  });

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "one tenant's connection and history are invisible and unwritable from another tenant's context",
    async () => {
      const owner = await newTenant();
      const other = await newTenant();
      await move(owner, 'connecting');
      await move(owner, 'connected');

      await withTenant(pool, other, async (tx) => {
        const seen = await tx.query(`SELECT 1 FROM whatsapp_connections WHERE tenant_id = $1`, [owner]);
        const history = await tx.query(`SELECT 1 FROM whatsapp_connection_transitions WHERE tenant_id = $1`, [owner]);
        const updated = await tx.query(`UPDATE whatsapp_connections SET state = 'error', error_reason = 'rate_limited'
                                         WHERE tenant_id = $1`, [owner]);
        assert.equal(seen.rows.length, 0);
        assert.equal(history.rows.length, 0);
        assert.equal(updated.rowCount, 0);
      });
      assert.equal((await withTenant(pool, owner, (tx) => readConnection(tx))).state, 'connected');
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC12 a connection in error displays a specific reason',
    "the operator can read every tenant's connection state and reason, and cannot change one",
    async () => {
      const tenant = await newTenant();
      await move(tenant, 'connecting');
      await move(tenant, 'error', 'authorization_revoked');

      await withPlatformScope(pool, async (tx) => {
        const seen = await tx.query<{ state: string; error_reason: string }>(
          `SELECT state, error_reason FROM whatsapp_connections WHERE tenant_id = $1`,
          [tenant],
        );
        assert.deepEqual(seen.rows, [{ state: 'error', error_reason: 'authorization_revoked' }]);
        const updated = await tx.query(`UPDATE whatsapp_connections SET state = 'disconnected', error_reason = NULL
                                         WHERE tenant_id = $1`, [tenant]);
        assert.equal(updated.rowCount, 0);
      });
    },
  );

  unitTest('an unbound connection is a defect, not an empty result', async () => {
    await assert.rejects(() => pool.transaction((tx) => readConnection(tx)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => transitionConnection(tx, 'connecting')), DefectError);
  });
});
