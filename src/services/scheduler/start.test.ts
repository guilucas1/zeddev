/**
 * The scheduler end to end: real PostgreSQL, the real queue, the real loop, real
 * time. WhatsApp is faked at the port, but the scheduler builds its own sealer from
 * `VAULT_SEALING_KEYS` and unseals each tenant's real token to use it.
 *
 * What a recovery attempt decides is pinned down in `@zeddev/whatsapp`'s
 * `recovery.test.ts`. This file proves the process around it: that with nobody
 * calling anything by hand, an interrupted connection is restored or given up on,
 * the bot follows, and old jobs go.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { readBotStatus, savePersona, setBotActive } from '@zeddev/bot';
import { withDispatchScope, withIdentityScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConfigurationError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { PostgresQueue } from '@zeddev/queue';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock, SystemClock } from '@zeddev/time';
import { INBOUND_QUEUE, readConnection, submitCredentials, transitionConnection } from '@zeddev/whatsapp';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';
import { loadSchedulerSettings } from './config.ts';
import { runSchedule } from './schedule.ts';
import { startScheduler, type RunningScheduler } from './start.ts';

const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220002222';
const SEALING_KEY = generateSealingKey('scheduler');

function envFor(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string> {
  const options = db.options;
  return {
    DATABASE_HOST: options.host,
    DATABASE_PORT: String(options.port),
    DATABASE_NAME: options.database,
    DATABASE_USER: options.user,
    DATABASE_PASSWORD: options.password?.expose() ?? '',
    DATABASE_SSL_MODE: 'disable',
    VAULT_SEALING_KEYS: SEALING_KEY,
    WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
    WHATSAPP_APP_ID: APP_ID,
    WHATSAPP_APP_SECRET: ['scheduler', 'app', 'secret'].join('-'),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['scheduler', 'verify', 'token'].join('-'),
    SCHEDULER_RECONNECT_INTERVAL: '1s',
    SCHEDULER_RECONNECT_BASE_DELAY: '1s',
    SCHEDULER_RECONNECT_MAX_DELAY: '1s',
    ...overrides,
  };
}

unitTest('startup names every missing scheduler key at once', async () => {
  await assert.rejects(startScheduler({}), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(error.keys, [
      'DATABASE_HOST',
      'DATABASE_NAME',
      'DATABASE_PASSWORD',
      'DATABASE_USER',
      'VAULT_SEALING_KEYS',
      'WHATSAPP_API_BASE_URL',
      'WHATSAPP_APP_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    ]);
    return true;
  });
});

unitTest('a maximum recovery delay shorter than the base delay is refused', () => {
  assert.throws(
    () => loadSchedulerSettings({ SCHEDULER_RECONNECT_BASE_DELAY: '10m', SCHEDULER_RECONNECT_MAX_DELAY: '1m' }),
    (error: unknown) => error instanceof ConfigurationError && error.keys.includes('SCHEDULER_RECONNECT_MAX_DELAY'),
  );
});

unitTest('the default retention outlasts the seven days Meta may keep redelivering a webhook', () => {
  assert.ok(loadSchedulerSettings({}).jobRetentionMs >= 7 * 24 * 60 * 60 * 1000);
});

/** Run the schedule until `until` says stop, on the real clock with a tiny interval. */
async function runUntil(
  tasks: Parameters<typeof runSchedule>[0]['tasks'],
  until: () => boolean,
  sink?: MemorySink,
): Promise<void> {
  const controller = new AbortController();
  const running = runSchedule({
    tasks,
    signal: controller.signal,
    clock: new SystemClock(),
    ...(sink === undefined ? {} : { logger: new Logger({ sink }) }),
  });
  while (!until()) await new Promise((resolve) => setTimeout(resolve, 2));
  controller.abort();
  await running;
}

unitTest('a task that fails is logged and runs again, and does not stop another', async () => {
  const sink = new MemorySink();
  let failing = 0;
  let healthy = 0;
  await runUntil(
    [
      {
        name: 'failing-task',
        intervalMs: 1,
        run: async () => {
          failing += 1;
          throw new Error('this run failed');
        },
      },
      {
        name: 'healthy-task',
        intervalMs: 1,
        run: async () => {
          healthy += 1;
        },
      },
    ],
    () => failing >= 3 && healthy >= 3,
    sink,
  );
  assert.ok(sink.records.some((record) => record.event === 'scheduler.task.failed' && record.fields['component'] === 'failing-task'));
});

unitTest('a task never overlaps itself, however long a run takes', async () => {
  let running = 0;
  let peak = 0;
  let runs = 0;
  await runUntil(
    [
      {
        name: 'slow-task',
        intervalMs: 1,
        run: async () => {
          running += 1;
          peak = Math.max(peak, running);
          await new Promise((resolve) => setTimeout(resolve, 10));
          running -= 1;
          runs += 1;
        },
      },
    ],
    () => runs >= 3,
  );
  assert.equal(peak, 1);
});

unitTest('a stop ends a task waiting out a long interval without waiting for it', async () => {
  const controller = new AbortController();
  let runs = 0;
  const running = runSchedule({
    // A fake clock never advances, so returning at all proves the wait was aborted.
    clock: new FakeClock(),
    signal: controller.signal,
    tasks: [
      {
        name: 'hourly-task',
        intervalMs: 3_600_000,
        run: async () => {
          runs += 1;
        },
      },
    ],
  });
  while (runs === 0) await new Promise((resolve) => setTimeout(resolve, 2));
  controller.abort();
  await running;
  assert.equal(runs, 1);
});

describe('scheduler', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  const backend = new ScriptedCloudBackend();
  const cloud = new InMemoryWhatsAppCloud({ appId: APP_ID, backend });
  // The same key the scheduler builds its own sealer from, so a token sealed here
  // is one it can actually unseal.
  const sealer = new SecretSealer([parseSealingKey(SEALING_KEY, 'VAULT_SEALING_KEYS')]);
  let counter = 0;

  before(async () => {
    db = await createTestDatabase('scheduler');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  /** A live bot whose connection a failed send has just interrupted. */
  async function interruptedLiveTenant(): Promise<string> {
    counter += 1;
    const phoneNumberId = String(600_000_000 + counter);
    const accessToken = ['scheduler', String(counter), 'token'].join('-');
    const tenant = await withIdentityScope(pool, async (tx) => {
      const row = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Scheduler Bakery ${counter}`],
      );
      return row.rows[0]!.id;
    });
    backend.register({ token: accessToken, phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, appId: APP_ID });
    await withTenant(pool, tenant, async (tx) => {
      await submitCredentials(
        tx,
        sealer,
        { phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, accessToken },
        { principal: 'scheduler-test' },
      );
      await transitionConnection(tx, 'connected');
      await savePersona(tx, { botName: 'Vera' });
      await setBotActive(tx, true);
      await transitionConnection(tx, 'reconnecting');
    });
    return tenant;
  }

  async function waitFor(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!(await condition())) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async function during(
    overrides: Record<string, string>,
    fn: (running: RunningScheduler, sink: MemorySink) => Promise<void>,
  ): Promise<void> {
    const sink = new MemorySink();
    const running = await startScheduler(envFor(db, overrides), { cloud, sink });
    try {
      await fn(running, sink);
    } finally {
      await running.stop();
    }
  }

  function connectionOf(tenant: string) {
    return withTenant(pool, tenant, (tx) => readConnection(tx));
  }

  specTest(
    'bot-activation-control.md',
    'AC14 a bot stays active through reconnecting and back to connected, with no client action',
    'with no traffic at all, the scheduler restores the connection and the bot was never off',
    async () => {
      const tenant = await interruptedLiveTenant();
      await during({}, async () => {
        await waitFor('the connection to recover', async () => (await connectionOf(tenant)).state === 'connected');
      });
      const bot = await withTenant(pool, tenant, (tx) => readBotStatus(tx));
      assert.equal(bot.active, true);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC6 when automatic recovery attempts are exhausted the state transitions to error with a surfaced reason',
    'with Meta unreachable the scheduler keeps trying on its own, gives up at the configured bound, and the bot goes off',
    async () => {
      const tenant = await interruptedLiveTenant();
      // Queued first so a sweep cannot find this tenant due before the failures exist.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        backend.failNext('describeBusinessAccount', { status: 503, code: 1 });
      }
      await during({ SCHEDULER_RECONNECT_MAX_ATTEMPTS: '2' }, async () => {
        await waitFor('recovery to give up', async () => (await connectionOf(tenant)).state === 'error');
      });
      assert.equal((await connectionOf(tenant)).errorReason, 'recovery_exhausted');
      const bot = await withTenant(pool, tenant, (tx) => readBotStatus(tx));
      assert.equal(bot.active, false, 'error does not satisfy readiness, so an active bot must have gone off');
    },
  );

  specTest(
    'component-independence.md',
    'AC6 a component deliberately stopped resumes normal operation when later restarted, with no other intervention',
    'an attempt count survives a restart, and a connection left interrupted is picked up by the next process',
    async () => {
      const tenant = await interruptedLiveTenant();
      backend.failNext('describeBusinessAccount', { status: 503, code: 1 });
      await during({ SCHEDULER_RECONNECT_MAX_ATTEMPTS: '5' }, async () => {
        await waitFor('the first attempt to be counted', async () => {
          const rows = await withTenant(pool, tenant, (tx) =>
            tx.query<{ recovery_attempts: number }>(`SELECT recovery_attempts FROM whatsapp_connections`),
          );
          return rows.rows[0]!.recovery_attempts === 1;
        });
      });
      assert.equal((await connectionOf(tenant)).state, 'reconnecting');

      await during({}, async () => {
        await waitFor('recovery after the restart', async () => (await connectionOf(tenant)).state === 'connected');
      });
    },
  );

  unitTest('old succeeded jobs are deleted; recent ones and dead ones stay', async () => {
    const tenant = await withIdentityScope(pool, async (tx) => {
      const row = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ('Purge Pantry', 'ready') RETURNING id`,
      );
      return row.rows[0]!.id;
    });
    const queue = new PostgresQueue({ name: INBOUND_QUEUE, pool });

    async function finish(kind: string, outcome: 'succeed' | 'die'): Promise<string> {
      const { jobId } = await queue.enqueue(tenant, { kind, payload: { kept: kind }, maxAttempts: 1 });
      const claimed = await queue.claim();
      assert.equal(claimed?.id, jobId);
      if (outcome === 'succeed') await queue.complete(claimed!);
      else await queue.fail(claimed!, new Error('this job died'));
      return jobId;
    }

    const old = await finish('scheduler_test_old', 'succeed');
    const recent = await finish('scheduler_test_recent', 'succeed');
    const dead = await finish('scheduler_test_dead', 'die');
    await withDispatchScope(pool, (tx) =>
      tx.query(`UPDATE queue_jobs SET finished_at = now() - interval '2 hours' WHERE id = ANY($1::uuid[])`, [[old, dead]]),
    );

    const survivors = () =>
      withDispatchScope(pool, async (tx) => {
        const rows = await tx.query<{ id: string }>(`SELECT id FROM queue_jobs WHERE id = ANY($1::uuid[])`, [
          [old, recent, dead],
        ]);
        return rows.rows.map((row) => row.id);
      });

    await during({ SCHEDULER_JOB_RETENTION: '1h' }, async () => {
      await waitFor('the purge', async () => !(await survivors()).includes(old));
    });
    assert.deepEqual((await survivors()).sort(), [recent, dead].sort());
  });

  unitTest('stop is idempotent and leaves nothing running', async () => {
    const running = await startScheduler(envFor(db), { cloud });
    await Promise.all([running.stop(), running.stop()]);
    await running.stop();
  });
});
