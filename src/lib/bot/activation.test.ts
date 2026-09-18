/**
 * Readiness and the go-live toggle, against a real PostgreSQL.
 *
 * Most of what `bot-activation-control.md` requires is enforced by migration
 * 0007 — the readiness definition, the "active implies ready" constraint, the
 * re-evaluation triggers, and the event log — so most of these tests drive the
 * readiness inputs the way their owners will (the WhatsApp state machine, the
 * persona save, and a raw write standing in for a path not built yet) and assert
 * what the toggle does in response. A fake could only agree with itself here;
 * the property under test is that no path around the library escapes the rule.
 *
 * "The bot auto-responds" is observed through `mayAutoRespond`, the gate the
 * reply path must ask. The reply path itself is P2; when it lands, its tests
 * should assert it asks.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { migrate, withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConflictError, DefectError, ValidationError } from '@zeddev/errors';
import { loadSchemaMigrations, migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { transitionConnection, type ConnectionState } from '@zeddev/whatsapp';
import {
  describeBotStatus,
  listBotStatuses,
  mayAutoRespond,
  parseActivationInput,
  READINESS_CONDITION_DESCRIPTIONS,
  READINESS_CONDITIONS,
  readActivationHistory,
  readBotStatus,
  setBotActive,
} from './activation.ts';
import { savePersona } from './persona.ts';

unitTest('the toggle body is exactly { active: boolean }', () => {
  assert.equal(parseActivationInput({ active: true }), true);
  assert.equal(parseActivationInput({ active: false }), false);
  assert.throws(() => parseActivationInput({ active: 'yes' }), ValidationError);
  assert.throws(() => parseActivationInput({}), ValidationError);
  assert.throws(() => parseActivationInput({ active: true, tenantId: 'x' }), ValidationError);
});

describe('bot activation', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Activation Deli ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  const as = <T>(tenant: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(pool, tenant, fn);

  async function connect(tenant: string, ...path: ConnectionState[]): Promise<void> {
    for (const state of path.length > 0 ? path : (['connecting', 'connected'] as const)) {
      await as(tenant, (tx) =>
        transitionConnection(tx, state, { reason: state === 'error' ? 'authorization_revoked' : undefined }),
      );
    }
  }

  async function configure(tenant: string): Promise<void> {
    await as(tenant, (tx) => savePersona(tx, { botName: 'Pip' }));
  }

  /** A tenant that is ready and has not been turned on. */
  async function readyTenant(): Promise<string> {
    const tenant = await newTenant();
    await connect(tenant);
    await configure(tenant);
    return tenant;
  }

  /** A tenant whose bot is live. */
  async function liveTenant(): Promise<string> {
    const tenant = await readyTenant();
    await as(tenant, (tx) => setBotActive(tx, true));
    return tenant;
  }

  before(async () => {
    db = await createTestDatabase('bot_activation');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'bot-activation-control.md',
    'AC1 go-live is rejected while WhatsApp is not connected',
    'a configured client with no connection cannot turn the bot on, and it stays off',
    async () => {
      const tenant = await newTenant();
      await configure(tenant);
      for (const path of [[], ['connecting'], ['error']] as ConnectionState[][]) {
        if (path.length > 0) await connect(tenant, ...path);
        await assert.rejects(
          () => as(tenant, (tx) => setBotActive(tx, true)),
          (error) => error instanceof ConflictError && error.code === 'bot.not_ready',
        );
        const status = await as(tenant, (tx) => readBotStatus(tx));
        assert.equal(status.active, false);
        assert.deepEqual(status.unmetConditions, ['whatsapp_connection']);
      }
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC2 go-live is rejected while persona/tone is incomplete',
    'a connected client with no persona cannot turn the bot on, and it stays off',
    async () => {
      const tenant = await newTenant();
      await connect(tenant);
      await assert.rejects(() => as(tenant, (tx) => setBotActive(tx, true)), ConflictError);
      const status = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(status.active, false);
      assert.deepEqual(status.unmetConditions, ['persona']);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC3 a connected and configured client is reported ready and may go live',
    'status reports ready with nothing unmet and offers go-live',
    async () => {
      const tenant = await readyTenant();
      const status = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(status.ready, true);
      assert.deepEqual(status.unmetConditions, []);
      assert.equal(describeBotStatus(status).canGoLive, true);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC4 becoming ready does not turn the bot on',
    'a client who just became ready stays off and the bot does not auto-respond',
    async () => {
      const tenant = await readyTenant();
      assert.equal((await as(tenant, (tx) => readBotStatus(tx))).active, false);
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), false);
      assert.deepEqual(await as(tenant, (tx) => readActivationHistory(tx)), []);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC5 turning a ready bot on starts auto-responding with no business-hours restriction',
    'after go-live the reply gate is open, and the gate takes no time input at all',
    async () => {
      const tenant = await liveTenant();
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), true);
      // 24/7 is structural: the gate's only input is the tenant-bound connection.
      assert.equal(mayAutoRespond.length, 1);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC6 turning an active bot off stops auto-responding immediately',
    'after pause the reply gate is closed in the very next transaction',
    async () => {
      const tenant = await liveTenant();
      const paused = await as(tenant, (tx) => setBotActive(tx, false));
      assert.equal(paused.active, false);
      assert.equal(paused.activeChangeCause, 'client');
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), false);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC6 turning an active bot off stops auto-responding immediately',
    'a pause committed while a reply transaction is in flight is seen by that transaction before it sends',
    async () => {
      const tenant = await liveTenant();
      // A reply transaction that started before the pause and asks the gate after
      // it — the order the reply path is required to use.
      const answer = await as(tenant, async (reply) => {
        await as(tenant, (client) => setBotActive(client, false));
        return mayAutoRespond(reply);
      });
      assert.equal(answer, false);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC7 a paused bot for a still-ready client can be turned back on',
    'off then on again resumes auto-responding',
    async () => {
      const tenant = await liveTenant();
      await as(tenant, (tx) => setBotActive(tx, false));
      const resumed = await as(tenant, (tx) => setBotActive(tx, true));
      assert.equal(resumed.active, true);
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), true);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC8 losing readiness while active turns the bot off without client action',
    'a connection entering error or disconnected, or a removed persona, switches an active bot off',
    async () => {
      for (const lose of [
        (tenant: string) => connect(tenant, 'error'),
        (tenant: string) => connect(tenant, 'disconnected'),
        // No route deletes a persona today; a raw delete stands in for a future
        // path, and shows the rule does not depend on which path it is.
        (tenant: string) => as(tenant, (tx) => tx.query('DELETE FROM bot_personas')),
      ]) {
        const tenant = await liveTenant();
        await lose(tenant);
        const status = await as(tenant, (tx) => readBotStatus(tx));
        assert.equal(status.active, false);
        assert.equal(status.ready, false);
        assert.equal(status.activeChangeCause, 'readiness_lost');
        assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), false);
      }
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC9 restoring a lost condition does not turn the bot back on',
    'after reconnecting from error the client is ready again but the bot stays off until turned on',
    async () => {
      const tenant = await liveTenant();
      await connect(tenant, 'error');
      await connect(tenant, 'connecting', 'connected');
      const status = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(status.ready, true);
      assert.equal(status.active, false);
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), false);
      assert.equal((await as(tenant, (tx) => setBotActive(tx, true))).active, true);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC10 a not-ready client is told which conditions are unmet',
    'a fresh tenant lists both conditions, each with a description, in a fixed order',
    async () => {
      const tenant = await newTenant();
      const view = describeBotStatus(await as(tenant, (tx) => readBotStatus(tx)));
      assert.deepEqual(view.unmetConditions, [
        { condition: 'whatsapp_connection', description: READINESS_CONDITION_DESCRIPTIONS.whatsapp_connection },
        { condition: 'persona', description: READINESS_CONDITION_DESCRIPTIONS.persona },
      ]);
      assert.equal(view.canGoLive, false);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC11 status always shows both readiness and activation',
    'every status carries ready and active, before and after each transition',
    async () => {
      const tenant = await newTenant();
      const seen: [boolean, boolean][] = [];
      const record = async () => {
        const view = describeBotStatus(await as(tenant, (tx) => readBotStatus(tx)));
        seen.push([view.ready, view.active]);
      };
      await record();
      await configure(tenant);
      await connect(tenant);
      await record();
      await as(tenant, (tx) => setBotActive(tx, true));
      await record();
      assert.deepEqual(seen, [
        [false, false],
        [true, false],
        [true, true],
      ]);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC12 the operator can view readiness and activation but cannot change activation',
    "the platform scope lists every tenant's state and cannot write a bot_activation row",
    async () => {
      const live = await liveTenant();
      const fresh = await newTenant();

      const listed = await withPlatformScope(pool, (tx) => listBotStatuses(tx));
      const byId = new Map(listed.map((entry) => [entry.tenantId, entry]));
      assert.equal(byId.get(live)?.active, true);
      assert.equal(byId.get(live)?.ready, true);
      assert.deepEqual(byId.get(fresh)?.unmetConditions, [...READINESS_CONDITIONS]);
      assert.equal(byId.get(fresh)?.active, false);

      await withPlatformScope(pool, async (tx) => {
        const updated = await tx.query(`UPDATE bot_activation SET active = false, change_cause = 'client'
                                         WHERE tenant_id = $1`, [live]);
        assert.equal(updated.rowCount, 0);
        // Nor can the operator reach the persona that readiness is derived from.
        const personas = await tx.query('SELECT 1 FROM bot_personas');
        assert.equal(personas.rows.length, 0);
      });
      assert.equal(await as(live, (tx) => mayAutoRespond(tx)), true);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC13 every activation change is recorded with when it happened',
    'on, off (client), on, and off (readiness lost) are each recorded with cause and time',
    async () => {
      const tenant = await liveTenant();
      await as(tenant, (tx) => setBotActive(tx, false));
      await as(tenant, (tx) => setBotActive(tx, false)); // no change, no record
      await as(tenant, (tx) => setBotActive(tx, true));
      await connect(tenant, 'disconnected');

      const history = await as(tenant, (tx) => readActivationHistory(tx));
      assert.deepEqual(
        history.map((event) => [event.active, event.cause]),
        [
          [false, 'readiness_lost'],
          [true, 'client'],
          [false, 'client'],
          [true, 'client'],
        ],
      );
      for (const event of history) assert.ok(event.occurredAt instanceof Date);

      await as(tenant, async (tx) => {
        assert.equal((await tx.query('UPDATE bot_activation_events SET active = true')).rowCount, 0);
        assert.equal((await tx.query('DELETE FROM bot_activation_events')).rowCount, 0);
      });
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC14 a reconnecting connection keeps an active bot active',
    'connected → reconnecting → connected leaves the bot on throughout, with no activation event',
    async () => {
      const tenant = await liveTenant();
      await connect(tenant, 'reconnecting');
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), true);
      await connect(tenant, 'connected');
      assert.equal(await as(tenant, (tx) => mayAutoRespond(tx)), true);
      assert.equal((await as(tenant, (tx) => readActivationHistory(tx))).length, 1);
    },
  );

  unitTest('first-ready time is recorded once and survives losing readiness', async () => {
    const tenant = await readyTenant();
    const first = (await as(tenant, (tx) => readBotStatus(tx))).firstReadyAt;
    assert.ok(first instanceof Date);
    await connect(tenant, 'disconnected');
    await connect(tenant, 'connecting', 'connected');
    assert.deepEqual((await as(tenant, (tx) => readBotStatus(tx))).firstReadyAt, first);
  });

  unitTest('the database refuses an active bot that is not ready, whatever the path', async () => {
    const tenant = await newTenant();
    await as(tenant, (tx) => readBotStatus(tx));
    await connect(tenant); // creates the row; persona still missing
    await assert.rejects(() =>
      as(tenant, (tx) => tx.query(`UPDATE bot_activation SET active = true, change_cause = 'client'`)),
    );
    // And a change without a cause cannot slip past the event log.
    await configure(tenant);
    await assert.rejects(() =>
      as(tenant, (tx) => tx.query(`UPDATE bot_activation SET active = true, change_cause = NULL`)),
    );
  });

  unitTest('a go-live racing a connection failure never leaves an active bot on a failed connection', async () => {
    for (let round = 0; round < 10; round += 1) {
      const tenant = await readyTenant();
      await Promise.allSettled([as(tenant, (tx) => setBotActive(tx, true)), connect(tenant, 'error')]);
      const status = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(status.ready, false);
      assert.equal(status.active, false, `round ${round}: the bot stayed live on a failed connection`);
    }
  });

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "one tenant cannot see or change another tenant's activation state or history",
    async () => {
      const owner = await liveTenant();
      const other = await readyTenant();
      await as(other, async (tx) => {
        assert.equal((await tx.query('SELECT 1 FROM bot_activation WHERE tenant_id = $1', [owner])).rows.length, 0);
        assert.equal(
          (await tx.query('SELECT 1 FROM bot_activation_events WHERE tenant_id = $1', [owner])).rows.length,
          0,
        );
        const updated = await tx.query(`UPDATE bot_activation SET active = false, change_cause = 'client'
                                         WHERE tenant_id = $1`, [owner]);
        assert.equal(updated.rowCount, 0);
      });
      assert.equal(await as(owner, (tx) => mayAutoRespond(tx)), true);
    },
  );

  unitTest('READINESS_CONDITIONS agrees with the database definition', async () => {
    const tenant = await newTenant();
    const unmet = await as(tenant, async (tx) => {
      const result = await tx.query<{ unmet: string[] }>('SELECT app.bot_readiness_unmet(app.current_tenant_id()) AS unmet');
      return result.rows[0]!.unmet;
    });
    assert.deepEqual(unmet, [...READINESS_CONDITIONS]);
  });

  unitTest('an unbound connection is a defect, and the operator list requires the platform scope', async () => {
    await assert.rejects(() => pool.transaction((tx) => readBotStatus(tx)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => setBotActive(tx, true)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => listBotStatuses(tx)), DefectError);
  });
});

describe('bot activation migration backfill', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('bot_backfill');
  });

  after(async () => {
    await db?.drop();
  });

  unitTest('tenants that configured a persona before migration 0007 are evaluated by it', async () => {
    const migrations = await loadSchemaMigrations();
    const before0007 = migrations.filter((migration) => migration.version < 7);
    await migrate(db.pool, before0007);

    const tenant = await withIdentityScope(db.pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ('Early Bird', 'ready') RETURNING id`,
      );
      return created.rows[0]!.id;
    });
    await withTenant(db.pool, tenant, (tx) => savePersona(tx, { botName: 'Early' }));

    await migrateToLatest(db.pool);
    const status = await withTenant(db.pool, tenant, (tx) => readBotStatus(tx));
    assert.deepEqual(status.unmetConditions, ['whatsapp_connection']);
    assert.equal(status.active, false);
  });
});
