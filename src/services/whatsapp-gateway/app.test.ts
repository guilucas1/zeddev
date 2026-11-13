/**
 * The gateway end to end: a real listener, a real PostgreSQL, a real queue.
 *
 * Each test sends what Meta would send — a signed notification in the upstream's
 * envelope — over HTTP, and then asserts on what the database holds, because
 * `message-delivery-reliability.md` is a set of claims about what is *stored and
 * scheduled*, not about what the handler returned. A 200 with nothing stored would
 * be the worst failure this service can have: Meta never redelivers an
 * acknowledged notification, so the message would be gone.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConfigurationError } from '@zeddev/errors';
import { MemorySink } from '@zeddev/logging';
import { PostgresQueue } from '@zeddev/queue';
import { specTest, unitTest } from '@zeddev/testing';
import {
  assignPhoneNumber,
  beginVerification,
  INBOUND_JOB_KIND,
  INBOUND_QUEUE,
  listInboundMessages,
  readConnection,
  readInboundMessage,
  transitionConnection,
} from '@zeddev/whatsapp';
import { WEBHOOK_PATH } from './app.ts';
import { startGateway, type RunningGateway } from './start.ts';

const APP_SECRET = 'gateway-test-app-secret-4417';
const VERIFY_TOKEN = 'gateway-test-verify-token-9051';

function envFor(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string> {
  const options = db.options;
  return {
    DATABASE_HOST: options.host,
    DATABASE_PORT: String(options.port),
    DATABASE_NAME: options.database,
    DATABASE_USER: options.user,
    DATABASE_PASSWORD: options.password?.expose() ?? '',
    DATABASE_SSL_MODE: 'disable',
    WHATSAPP_APP_SECRET: APP_SECRET,
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: VERIFY_TOKEN,
    WHATSAPP_APP_ID: '3090001111',
    WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
    GATEWAY_HTTP_HOST: '127.0.0.1',
    GATEWAY_HTTP_PORT: '0',
    ...overrides,
  };
}

function textMessage(id: string, body: string, timestamp: number, from = '15557654321'): unknown {
  return { from, id, timestamp: String(timestamp), type: 'text', text: { body } };
}

function envelope(phoneNumberId: string, messages: unknown[]): string {
  return JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '1029384756',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Pat' }, wa_id: '15557654321' }],
              messages,
            },
          },
        ],
      },
    ],
  });
}

function signature(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

unitTest('startup names every missing gateway key at once', async () => {
  await assert.rejects(startGateway({}), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(error.keys, [
      'DATABASE_HOST',
      'DATABASE_NAME',
      'DATABASE_PASSWORD',
      'DATABASE_USER',
      'WHATSAPP_API_BASE_URL',
      'WHATSAPP_APP_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    ]);
    return true;
  });
});

describe('whatsapp gateway', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let gateway: RunningGateway;
  const sink = new MemorySink();
  let counter = 0;
  let numberCounter = 900_000_000;

  async function connectedTenant(): Promise<{ tenant: string; phoneNumberId: string }> {
    counter += 1;
    numberCounter += 1;
    const phoneNumberId = String(numberCounter);
    const tenant = await withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Gateway Grocer ${counter}`],
      );
      return created.rows[0]!.id;
    });
    await withTenant(pool, tenant, async (tx) => {
      await transitionConnection(tx, 'connecting');
      await assignPhoneNumber(tx, phoneNumberId);
      await transitionConnection(tx, 'connected');
    });
    return { tenant, phoneNumberId };
  }

  function post(body: string, headers: Record<string, string> = { 'x-hub-signature-256': signature(body) }) {
    return fetch(`${gateway.url}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body,
    });
  }

  /** This tenant's scheduled jobs, in enqueue order, with their payloads. */
  function jobsOf(tenant: string) {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ queue: string; kind: string; state: string; payload: { inboundMessageId: string } }>(
        `SELECT j.queue, j.kind, j.state, p.payload
           FROM queue_jobs j JOIN queue_job_payloads p ON p.job_id = j.id
          ORDER BY j.seq`,
      );
      return result.rows;
    });
  }

  async function rejections(): Promise<readonly { reason: string; phone_number_id: string | null; message_count: number }[]> {
    const result = await withPlatformScope(pool, (tx) =>
      tx.query<{ reason: string; phone_number_id: string | null; message_count: number }>(
        'SELECT reason, phone_number_id, message_count FROM inbound_rejections ORDER BY id',
      ),
    );
    return result.rows;
  }

  before(async () => {
    db = await createTestDatabase('gateway');
    pool = db.pool;
    gateway = await startGateway(envFor(db), { sink });
  });

  after(async () => {
    await gateway?.stop();
    await db?.drop();
  });

  // -------------------------------------------------------------------------
  // The subscription handshake
  // -------------------------------------------------------------------------

  unitTest('the subscription handshake echoes the challenge only for the configured verify token', async () => {
    const url = (token: string, challenge = '1158201444', mode = 'subscribe') =>
      `${gateway.url}${WEBHOOK_PATH}?hub.mode=${mode}&hub.verify_token=${encodeURIComponent(token)}&hub.challenge=${encodeURIComponent(challenge)}`;
    const accepted = await fetch(url(VERIFY_TOKEN));
    assert.equal(accepted.status, 200);
    assert.match(accepted.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await accepted.text(), '1158201444');

    for (const refused of [
      url('wrong-token-wrong-token'),
      url(VERIFY_TOKEN, '1158201444', 'unsubscribe'),
      // The challenge is echoed into the response, so markup is never echoed.
      url(VERIFY_TOKEN, '<script>alert(1)</script>'),
    ]) {
      const response = await fetch(refused);
      assert.equal(response.status, 403);
      assert.ok(!(await response.text()).includes('script'));
    }
  });

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  specTest(
    'message-delivery-reliability.md',
    'AC1 a connected tenant inbound notification is acknowledged without waiting for a reply',
    'a signed notification is stored, scheduled, and acknowledged — with no reply generated on the way',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const body = envelope(phoneNumberId, [textMessage('wamid.first', 'Are you open today?', 1_760_000_000)]);
      const response = await post(body);
      assert.equal(response.status, 200);

      const stored = await withTenant(pool, tenant, (tx) => listInboundMessages(tx));
      assert.equal(stored.length, 1);
      assert.deepEqual(stored[0]!.content, { text: 'Are you open today?' });
      assert.equal(stored[0]!.phoneNumberId, phoneNumberId);

      // Acknowledged while the work is still waiting: nothing in this process
      // generates replies, so the acknowledgement cannot have waited on one.
      const jobs = await jobsOf(tenant);
      assert.deepEqual(jobs, [
        { queue: INBOUND_QUEUE, kind: INBOUND_JOB_KIND, state: 'ready', payload: { inboundMessageId: stored[0]!.id } },
      ]);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC2 a notification failing authenticity verification is rejected',
    'an unsigned or wrongly signed notification is refused, recorded, and nothing is stored',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const body = envelope(phoneNumberId, [textMessage('wamid.forged', 'injected', 1_760_000_000)]);
      const before = (await rejections()).length;

      assert.equal((await post(body, {})).status, 401);
      assert.equal((await post(body, { 'x-hub-signature-256': signature(body, 'not-the-app-secret') })).status, 401);

      const recorded = (await rejections()).slice(before);
      assert.deepEqual(recorded, [
        { reason: 'signature_missing', phone_number_id: null, message_count: 0 },
        { reason: 'signature_invalid', phone_number_id: null, message_count: 0 },
      ]);
      assert.deepEqual(await withTenant(pool, tenant, (tx) => listInboundMessages(tx)), []);
      assert.deepEqual(await jobsOf(tenant), []);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC3 a notification that cannot be matched to a tenant is rejected',
    'a notification for a number no tenant owns is recorded and acknowledged, and processed against nobody',
    async () => {
      const bystander = await connectedTenant();
      const before = (await rejections()).length;
      const body = envelope('123450000', [
        textMessage('wamid.stray-1', 'hello?', 1_760_000_000),
        textMessage('wamid.stray-2', 'anyone?', 1_760_000_001),
      ]);
      // Acknowledged: it is authentic, and redelivering it cannot make it ours.
      assert.equal((await post(body)).status, 200);
      assert.deepEqual((await rejections()).slice(before), [
        { reason: 'unattributable', phone_number_id: '123450000', message_count: 2 },
      ]);
      assert.deepEqual(await withTenant(pool, bystander.tenant, (tx) => listInboundMessages(tx)), []);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC4 a redelivered message is not stored again and not replied to again',
    'a redelivery after the original was fully processed is acknowledged and neither stored nor scheduled again',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const body = envelope(phoneNumberId, [textMessage('wamid.redelivered', 'One table for two', 1_760_000_000)]);
      assert.equal((await post(body)).status, 200);

      // The original is processed to completion before the redelivery arrives —
      // the case the spec calls out, and the one a queue-row dedupe key alone
      // would miss once succeeded jobs are purged.
      const consumer = new PostgresQueue({ name: INBOUND_QUEUE, pool });
      let job = await consumer.claim();
      while (job !== undefined && job.tenantId !== tenant) job = await consumer.claim();
      assert.ok(job !== undefined);
      await consumer.complete(job);
      await consumer.purgeSucceeded(0);

      assert.equal((await post(body)).status, 200);
      assert.equal((await withTenant(pool, tenant, (tx) => listInboundMessages(tx))).length, 1);
      assert.deepEqual(await jobsOf(tenant), []);
      await consumer.close();
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC5 out-of-order notifications are processed and stored in sent order',
    'messages are scheduled and listed in the order the end-customer sent them, not the order they arrived',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      // One notification listing them backwards, then a late one carrying the
      // earliest message of all.
      assert.equal(
        (await post(envelope(phoneNumberId, [
          textMessage('wamid.o3', 'third', 1_760_000_003),
          textMessage('wamid.o2', 'second', 1_760_000_002),
        ]))).status,
        200,
      );
      assert.equal((await post(envelope(phoneNumberId, [textMessage('wamid.o1', 'first', 1_760_000_001)]))).status, 200);

      const listed = await withTenant(pool, tenant, (tx) => listInboundMessages(tx));
      assert.deepEqual(listed.map((m) => m.externalId), ['wamid.o1', 'wamid.o2', 'wamid.o3']);

      // Within one notification, scheduling follows send order too.
      const scheduled = await jobsOf(tenant);
      const byId = new Map(listed.map((m) => [m.id, m.externalId]));
      assert.deepEqual(scheduled.slice(0, 2).map((j) => byId.get(j.payload.inboundMessageId)), ['wamid.o2', 'wamid.o3']);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC6 an acknowledged message survives a restart of the component producing the reply',
    'after the gateway acknowledges and stops, a fresh consumer still finds the job and the message it names',
    async () => {
      const second = await startGateway(envFor(db), { sink });
      const { tenant, phoneNumberId } = await connectedTenant();
      const body = envelope(phoneNumberId, [textMessage('wamid.durable', 'Still there?', 1_760_000_000)]);
      const response = await fetch(`${second.url}${WEBHOOK_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature(body) },
        body,
      });
      assert.equal(response.status, 200);
      await second.stop();
      // The stop was recorded as one, so the operator reads it as stopped rather than crashed.
      const heartbeat = await withPlatformScope(pool, async (tx) =>
        (await tx.query<{ component: string; stopped: boolean }>(
          'SELECT component, stopped_at IS NOT NULL AS stopped FROM component_heartbeats WHERE instance_id = $1',
          [second.instanceId],
        )).rows[0],
      );
      assert.deepEqual(heartbeat, { component: 'whatsapp-gateway', stopped: true });

      // A consumer that did not exist when the message was acknowledged.
      const consumer = new PostgresQueue({ name: INBOUND_QUEUE, pool });
      let job = await consumer.claim();
      while (job !== undefined && job.tenantId !== tenant) job = await consumer.claim();
      assert.ok(job !== undefined, 'the acknowledged message must still be scheduled');
      assert.equal(job.kind, INBOUND_JOB_KIND);
      const { inboundMessageId } = job.payload as { inboundMessageId: string };
      const message = await withTenant(pool, tenant, (tx) => readInboundMessage(tx, inboundMessageId));
      assert.deepEqual(message?.content, { text: 'Still there?' });
      await consumer.close();
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC11 a message to a bot that is turned off is received, deduplicated, and retained',
    'a tenant whose bot was never switched on still has its message stored and scheduled',
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      const active = await withTenant(pool, tenant, (tx) =>
        tx.query<{ active: boolean }>('SELECT active FROM bot_activation'),
      );
      assert.notEqual(active.rows[0]?.active, true, 'the fixture bot must be off, or this proves nothing');
      assert.equal((await post(envelope(phoneNumberId, [textMessage('wamid.off', 'hi', 1_760_000_000)]))).status, 200);
      assert.equal((await withTenant(pool, tenant, (tx) => listInboundMessages(tx))).length, 1);
      // Whether to reply is the worker's question (`mayAutoRespond`), asked when
      // the reply would be sent — not the gateway's.
      assert.equal((await jobsOf(tenant)).length, 1);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC13 no reply is produced for a tenant that has offboarded',
    "a message to a disconnected tenant's former number is refused as unattributable and never stored",
    async () => {
      const { tenant, phoneNumberId } = await connectedTenant();
      await withTenant(pool, tenant, (tx) => transitionConnection(tx, 'disconnected'));
      const before = (await rejections()).length;
      assert.equal((await post(envelope(phoneNumberId, [textMessage('wamid.gone', 'hello', 1_760_000_000)]))).status, 200);
      assert.deepEqual((await rejections()).slice(before), [
        { reason: 'unattributable', phone_number_id: phoneNumberId, message_count: 1 },
      ]);
      assert.deepEqual(await withTenant(pool, tenant, (tx) => listInboundMessages(tx)), []);
      assert.deepEqual(await jobsOf(tenant), []);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC17 delivery diagnostics contain operational information only',
    'the gateway log carries ids and counts but never message text or the end-customer number',
    async () => {
      const { phoneNumberId } = await connectedTenant();
      sink.clear();
      const needle = 'Quokka-marmalade-lighthouse';
      const customer = '447911123456';
      assert.equal(
        (await post(envelope(phoneNumberId, [textMessage('wamid.logged', needle, 1_760_000_000, customer)]))).status,
        200,
      );
      const log = sink.serialized();
      assert.ok(log.includes('gateway.inbound.accepted'), 'the acceptance must be logged, or the check proves nothing');
      assert.ok(!log.includes(needle));
      assert.ok(!log.includes(customer));
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC1 a completed self-service flow with verified send and receive becomes connected',
    'a reply carrying the connection code connects the number and is never stored as a conversation',
    async () => {
      counter += 1;
      numberCounter += 1;
      const phoneNumberId = String(numberCounter);
      const owner = String(5511500000000 + numberCounter);
      const code = '480913';

      const tenant = await withIdentityScope(pool, async (tx) => {
        const created = await tx.query<{ id: string }>(
          `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
          [`Gateway Verifier ${counter}`],
        );
        return created.rows[0]!.id;
      });
      await withTenant(pool, tenant, async (tx) => {
        await transitionConnection(tx, 'connecting');
        await assignPhoneNumber(tx, phoneNumberId);
        await beginVerification(tx, {
          recipient: owner,
          code,
          expiresAt: new Date(Date.now() + 15 * 60_000),
        });
      });

      // The reply travels the real path: signed webhook, attributed by number,
      // tenant-bound. That round trip is the whole proof the receive direction
      // works, so nothing short of it may connect a number.
      const body = envelope(phoneNumberId, [
        textMessage('wamid.code-reply', `Code ${code}`, 1_760_000_000, owner),
      ]);
      const answer = await post(body);
      assert.equal(answer.status, 200);

      const status = await withTenant(pool, tenant, (tx) => readConnection(tx));
      assert.equal(status.state, 'connected');

      // And the code reply is not an end-customer message: storing it would put
      // the client's own words in a transcript and, once the bot is on, have the
      // bot answer them.
      const stored = await withTenant(pool, tenant, (tx) => listInboundMessages(tx));
      assert.deepEqual(stored, []);

      // A redelivery of the same notification is recognised, not admitted.
      assert.equal((await post(body)).status, 200);
      assert.deepEqual(await withTenant(pool, tenant, (tx) => listInboundMessages(tx)), []);
    },
  );

  unitTest('an end-customer message that merely contains digits is an ordinary message', async () => {
    const { tenant, phoneNumberId } = await connectedTenant();
    const body = envelope(phoneNumberId, [
      textMessage('wamid.digits', 'my order number is 480913', 1_760_000_100),
    ]);
    assert.equal((await post(body)).status, 200);
    const stored = await withTenant(pool, tenant, (tx) => listInboundMessages(tx));
    assert.equal(stored.length, 1);
  });
  unitTest('an oversized notification is refused before it is buffered, and unknown routes are 404/405', async () => {
    const huge = 'x'.repeat(gateway.settings.maxBodyBytes + 1);
    assert.equal((await post(huge, { 'x-hub-signature-256': signature(huge) })).status, 413);
    assert.equal((await fetch(`${gateway.url}/v1/other`)).status, 404);
    const wrongMethod = await fetch(`${gateway.url}${WEBHOOK_PATH}`, { method: 'PUT', body: '{}' });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.get('allow'), 'GET, POST');
    assert.equal((await fetch(`${gateway.url}/health/ready`)).status, 200);
  });
});
