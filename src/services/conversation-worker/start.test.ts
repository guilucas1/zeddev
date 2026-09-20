/**
 * The worker end to end: real PostgreSQL, the real queue, the real consumer loop,
 * real time. Only the model is faked.
 *
 * The library tests (`@zeddev/conversation`) drive the handlers with a simulated
 * clock and pin down what a turn is. This file proves the process around them:
 * that a message stored and scheduled the way the gateway does it gets exactly one
 * answer, with nobody calling a handler by hand — including the turn's delayed
 * job, which has to wake a sleeping consumer when its window runs out rather than
 * whenever the consumer's idle timeout next lets it look.
 *
 * WhatsApp is faked at the port, not at the process: the worker builds its own
 * sealer from `VAULT_SEALING_KEYS` and unseals the tenant's real access token to
 * send, so what this file proves is the whole outbound path bar the socket to
 * Meta — which `@zeddev/whatsapp`'s conformance suite covers against a wire-level
 * stub.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider } from '@zeddev/ai/testing';
import { savePersona, setBotActive } from '@zeddev/bot';
import { withIdentityScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConfigurationError } from '@zeddev/errors';
import { MemorySink } from '@zeddev/logging';
import { PostgresQueue } from '@zeddev/queue';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import {
  INBOUND_JOB_KIND,
  INBOUND_QUEUE,
  recordInboundMessage,
  submitCredentials,
  transitionConnection,
} from '@zeddev/whatsapp';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';
import { loadWorkerSettings } from './config.ts';
import { startWorker, type RunningWorker } from './start.ts';

const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220002222';
const SEALING_KEY = generateSealingKey('worker');

function envFor(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string> {
  const options = db.options;
  return {
    DATABASE_HOST: options.host,
    DATABASE_PORT: String(options.port),
    DATABASE_NAME: options.database,
    DATABASE_USER: options.user,
    DATABASE_PASSWORD: options.password?.expose() ?? '',
    DATABASE_SSL_MODE: 'disable',
    AI_BASE_URL: 'https://example.com/v1beta',
    AI_MODEL: 'gemini-2.5-flash',
    VAULT_SEALING_KEYS: SEALING_KEY,
    WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
    WHATSAPP_APP_ID: APP_ID,
    WHATSAPP_APP_SECRET: ['worker', 'app', 'secret'].join('-'),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['worker', 'verify', 'token'].join('-'),
    WORKER_AGGREGATION_WINDOW: '600ms',
    WORKER_MAX_TURN_DURATION: '3s',
    ...overrides,
  };
}

unitTest('startup names every missing worker key at once', async () => {
  await assert.rejects(startWorker({}), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    // The WhatsApp keys are here because the worker sends replies, and the
    // schema is loaded whole rather than split — one key, one definition. The
    // cost is that the worker also demands the two the gateway alone uses.
    assert.deepEqual(error.keys, [
      'AI_BASE_URL',
      'AI_MODEL',
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

unitTest('a maximum turn duration shorter than the aggregation window is refused', () => {
  assert.throws(
    () => loadWorkerSettings({ WORKER_AGGREGATION_WINDOW: '10s', WORKER_MAX_TURN_DURATION: '5s' }),
    (error: unknown) => error instanceof ConfigurationError && error.keys.includes('WORKER_MAX_TURN_DURATION'),
  );
  const defaults = loadWorkerSettings({});
  assert.ok(defaults.aggregationWindowMs > 0 && defaults.maxTurnDurationMs >= defaults.aggregationWindowMs);
});

describe('conversation worker', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let worker: RunningWorker;
  const provider = new InMemoryAiProvider();
  const cloudBackend = new ScriptedCloudBackend();
  const sink = new MemorySink();
  // The same keys the worker will build its own sealer from, so a token sealed
  // by this fixture is one the worker can actually unseal.
  const sealer = new SecretSealer([parseSealingKey(SEALING_KEY, 'VAULT_SEALING_KEYS')]);
  let counter = 0;

  before(async () => {
    db = await createTestDatabase('worker');
    pool = db.pool;
    // The idle wait is left long on purpose: a turn must be answered because its
    // delayed job woke the consumer, not because the consumer happened to look.
    worker = await startWorker(envFor(db), {
      ai: provider,
      cloud: new InMemoryWhatsAppCloud({ appId: APP_ID, backend: cloudBackend }),
      sink,
      idleWaitMs: 60_000,
    });
  });

  after(async () => {
    await worker?.stop();
    await db?.drop();
  });

  async function liveTenant(): Promise<{ tenant: string; phoneNumberId: string }> {
    counter += 1;
    const phoneNumberId = String(800_000_000 + counter);
    const tenant = await withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Worker Winery ${counter}`],
      );
      return created.rows[0]!.id;
    });
    const token = ['worker', String(counter), 'token'].join('-');
    cloudBackend.register({ token, phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, appId: APP_ID });
    await withTenant(pool, tenant, async (tx) => {
      await submitCredentials(
        tx,
        sealer,
        { phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, accessToken: token },
        { principal: 'worker-test' },
      );
      await transitionConnection(tx, 'connected');
      await savePersona(tx, { botName: 'Vera' });
      await setBotActive(tx, true);
    });
    return { tenant, phoneNumberId };
  }

  /** What the gateway does with one accepted message: store it and schedule it, together. */
  async function deliver(tenant: string, phoneNumberId: string, customerId: string, externalId: string, text: string) {
    const scheduler = new PostgresQueue({ name: INBOUND_QUEUE, pool });
    await withTenant(pool, tenant, async (tx) => {
      const stored = await recordInboundMessage(tx, phoneNumberId, {
        externalId,
        customerId,
        type: 'text',
        upstreamType: 'text',
        content: { text },
        sentAt: new Date(),
      });
      if (stored.created) {
        await scheduler.enqueueWithin(tx, {
          kind: INBOUND_JOB_KIND,
          payload: { inboundMessageId: stored.id },
          partitionKey: customerId,
          dedupeKey: externalId,
        });
      }
    });
  }

  /** What this customer was actually sent, in order. */
  function sentTo(customer: string): string[] {
    return cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body);
  }

  function outcomes(tenant: string) {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ outcome: string; message: string | null }>(
        'SELECT outcome, message FROM conversation_turn_outcomes ORDER BY decided_at',
      );
      return result.rows;
    });
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  specTest(
    'message-burst-aggregation.md',
    'AC1 three messages inside the window get exactly one reply',
    'a burst delivered through the queue is answered once, after the window, by the running worker',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      provider.backend.script({ kind: 'text', text: '[reply]\nHappy to help with both!' });
      const started = Date.now();
      await deliver(tenant, phoneNumberId, '15551230001', 'wamid.worker-1', 'hi');
      await deliver(tenant, phoneNumberId, '15551230001', 'wamid.worker-2', 'two questions');
      const answered = await eventually(() => outcomes(tenant), (rows) => rows.length > 0, 'the turn to be answered');
      const elapsed = Date.now() - started;

      assert.deepEqual(answered, [{ outcome: 'reply', message: 'Happy to help with both!' }]);
      assert.ok(elapsed >= 600, `answered after ${elapsed} ms, before the aggregation window could elapse`);
      assert.ok(elapsed < 5_000, `answered after ${elapsed} ms — the consumer slept past the turn's due time`);
      // Nothing more arrives for it, however long we wait.
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal((await outcomes(tenant)).length, 1);
      // And it was actually sent — by the running process, over the port, with
      // the tenant's own token unsealed on the way. One copy, for two messages.
      await eventually(
        async () => sentTo('15551230001'),
        (sends) => sends.length > 0,
        'the reply to be delivered',
      );
      assert.deepEqual(sentTo('15551230001'), ['Happy to help with both!']);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC4 a redelivered message is not stored again and not replied to again',
    'a redelivery stored nothing, so the worker answers the turn once',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      await deliver(tenant, phoneNumberId, '15551230002', 'wamid.worker-dup', 'hello');
      await deliver(tenant, phoneNumberId, '15551230002', 'wamid.worker-dup', 'hello');
      await eventually(() => outcomes(tenant), (rows) => rows.length > 0, 'the turn to be answered');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal((await outcomes(tenant)).length, 1);
    },
  );

  unitTest('the worker stops cleanly and idempotently', async () => {
    const second = await startWorker(envFor(db), { ai: provider, sink: new MemorySink() });
    await Promise.all([second.stop(), second.stop()]);
  });
});
