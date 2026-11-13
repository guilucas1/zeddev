/**
 * Component independence, proven on the running services rather than on their
 * definitions (`component-independence.md`).
 *
 * `index.test.ts` proves the *shape* of independence: one image and one Compose
 * entry per service. That is necessary, and it says nothing about behaviour. This
 * file starts the three services a conversation passes through — the gateway, the
 * conversation worker, and the API — as real processes would, from configuration,
 * against one real PostgreSQL and the real queue, and then stops, restarts,
 * redeploys, scales, and crashes each in turn while the others keep serving two
 * tenants. Only the model and Meta's Cloud API are faked, at their ports.
 *
 * What it holds the platform to:
 *
 * - The services share nothing but the database. A stopped worker leaves the
 *   gateway accepting (customers' messages are stored and acknowledged) and the
 *   API answering (clients configure, read, and log in). A stopped API leaves
 *   customers answered. A stopped gateway leaves accepted messages answered.
 * - Coming back needs nobody else. A restarted worker drains what arrived while
 *   it was away, and a restarted API honours sessions issued by its predecessor,
 *   because both kinds of state live in the database, not in a process.
 * - Scaling is adding a consumer. Two workers answer every turn exactly once,
 *   because the queue's leases and the conversation row lock decide who does —
 *   no per-worker configuration, no partitioning by tenant.
 * - A crash costs nothing it does not own. A worker that dies holding a turn
 *   leaves that turn to be answered once by its successor, and every other
 *   tenant's connection, history, and earlier answers are untouched.
 *
 * Each process is identified by its `component_heartbeats` row, which is how an
 * operator sees it too: "the gateway was not restarted" is asserted as "the
 * gateway's instance is the same one, still live".
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, describe } from 'node:test';
import type { AiCapability, AiCallOptions, AiProvider, GenerationRequest, GenerationResult, TranscriptionRequest, TranscriptionResult } from '@zeddev/ai';
import { InMemoryAiProvider, type ObservedRequest } from '@zeddev/ai/testing';
import { startApi, type RunningApi } from '@zeddev/api';
import { savePersona, setBotActive } from '@zeddev/bot';
import { startWorker, type RunningWorker } from '@zeddev/conversation-worker';
import { withPlatformScope, withTenant } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { MemorySink } from '@zeddev/logging';
import { decodeMail, InMemoryMailer } from '@zeddev/mail/testing';
import { PostgresQueue } from '@zeddev/queue';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest } from '@zeddev/testing';
import {
  INBOUND_JOB_KIND,
  INBOUND_QUEUE,
  readConnection,
  recordInboundMessage,
  submitCredentials,
  transitionConnection,
} from '@zeddev/whatsapp';
import { startGateway, WEBHOOK_PATH, type RunningGateway } from '@zeddev/whatsapp-gateway';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';

const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220004444';
const APP_SECRET = ['independence', 'app', 'secret'].join('-');
const SEALING_KEY = generateSealingKey('independence');
const PASSWORD = 'lantern-quarry-saddle-7';
const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;
const WINDOW_MS = 500;

/**
 * Answers every turn by quoting what the customer wrote, so a reply names the
 * message it answers and the assertions need not depend on which worker, in
 * which order, took which turn.
 */
function quoteCustomer(request: ObservedRequest): string {
  if (request.operation !== 'generate') return 'transcribed';
  const customer = request.turns.filter((turn) => turn.role === 'customer').at(-1);
  const texts = (customer?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : []));
  // The port merges a burst's messages into one paragraph-separated part.
  return `[reply]\nRe: ${texts.join('\n\n').split(/\s*\n+\s*/).join(' | ')}`;
}

/**
 * The model, with a way to hold one call open. A crash only means something if it
 * happens while the worker holds a turn, and an in-memory model answers too fast
 * for that to happen by chance.
 */
class HoldableProvider implements AiProvider {
  readonly #inner: InMemoryAiProvider;
  #hold: { reached: () => void; released: Promise<void> } | undefined;

  constructor(inner: InMemoryAiProvider) {
    this.#inner = inner;
  }

  get descriptor() {
    return this.#inner.descriptor;
  }

  supports(capability: AiCapability): boolean {
    return this.#inner.supports(capability);
  }

  /** The next generation waits for `release`; the returned promise settles once it has started waiting. */
  holdNext(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.#hold = { reached, released };
    return { reached: reachedPromise, release };
  }

  async generate(request: GenerationRequest, options?: AiCallOptions): Promise<GenerationResult> {
    const hold = this.#hold;
    if (hold !== undefined) {
      this.#hold = undefined;
      hold.reached();
      await hold.released;
    }
    return this.#inner.generate(request, options);
  }

  transcribe(request: TranscriptionRequest, options?: AiCallOptions): Promise<TranscriptionResult> {
    return this.#inner.transcribe(request, options);
  }
}

interface Client {
  readonly tenant: string;
  readonly cookie: string;
  readonly phoneNumberId: string;
}

describe('component independence across running services', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  const mailer = new InMemoryMailer();
  const provider = new HoldableProvider(new InMemoryAiProvider({ reply: quoteCustomer }));
  const cloudBackend = new ScriptedCloudBackend();
  const sealer = new SecretSealer([parseSealingKey(SEALING_KEY, 'VAULT_SEALING_KEYS')]);
  let gateway: RunningGateway;
  let api: RunningApi;
  const workers = new Set<RunningWorker>();
  let alpha: Client;
  let beta: Client;
  let messageCounter = 0;

  function env(): Record<string, string> {
    const options = db.options;
    return {
      DATABASE_HOST: options.host,
      DATABASE_PORT: String(options.port),
      DATABASE_NAME: options.database,
      DATABASE_USER: options.user,
      DATABASE_PASSWORD: options.password?.expose() ?? '',
      DATABASE_SSL_MODE: 'disable',
      MAIL_HOST: 'mail.invalid',
      MAIL_FROM_ADDRESS: 'no-reply@example.com',
      AI_BASE_URL: 'https://example.com/v1beta',
      AI_MODEL: 'gemini-2.5-flash',
      API_PUBLIC_BASE_URL: 'https://example.com',
      API_HTTP_HOST: '127.0.0.1',
      API_HTTP_PORT: '0',
      API_SHUTDOWN_GRACE: '1s',
      GATEWAY_HTTP_HOST: '127.0.0.1',
      GATEWAY_HTTP_PORT: '0',
      GATEWAY_SHUTDOWN_GRACE: '1s',
      VAULT_SEALING_KEYS: SEALING_KEY,
      WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
      WHATSAPP_APP_ID: APP_ID,
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['independence', 'verify', 'token'].join('-'),
      WORKER_AGGREGATION_WINDOW: `${WINDOW_MS}ms`,
      WORKER_MAX_TURN_DURATION: '3s',
      // The shortest lease the configuration allows: how long a dead worker's turn waits for a successor.
      WORKER_VISIBILITY_TIMEOUT: '10s',
      WORKER_SHUTDOWN_GRACE: '200ms',
    };
  }

  const startGatewayProcess = () => startGateway(env(), { sink: new MemorySink() });
  const startApiProcess = () =>
    startApi(env(), {
      mailer,
      ai: provider,
      cloud: new InMemoryWhatsAppCloud({ appId: APP_ID, backend: cloudBackend }),
      sink: new MemorySink(),
      credentialParams: FAST_SCRYPT,
    });
  async function startWorkerProcess(): Promise<RunningWorker> {
    const worker = await startWorker(env(), {
      ai: provider,
      cloud: new InMemoryWhatsAppCloud({ appId: APP_ID, backend: cloudBackend }),
      sink: new MemorySink(),
    });
    workers.add(worker);
    return worker;
  }
  async function stopWorker(worker: RunningWorker): Promise<void> {
    await worker.stop();
    workers.delete(worker);
  }
  async function stopAllWorkers(): Promise<void> {
    await Promise.all([...workers].map(stopWorker));
  }

  async function call(base: string, method: string, path: string, json?: unknown, cookie?: string) {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie !== undefined) headers.cookie = cookie;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await response.text();
    return { status: response.status, body: text === '' ? undefined : JSON.parse(text), headers: response.headers };
  }

  async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string, ms = 10_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  /** A client as the product makes one: signed up, verified by the mailed link, and logged in through the API. */
  async function onboardClient(label: string, phoneNumberId: string): Promise<Client> {
    const email = `${label}-independence@example.com`;
    const signup = await call(api.url, 'POST', '/v1/signup', { businessName: `${label} Bakery`, email, password: PASSWORD });
    assert.equal(signup.status, 201);
    const mail = await eventually(
      () => mailer.delivered.map((delivered) => decodeMail(delivered.raw)).find((decoded) => decoded.to === email),
      (found) => found !== undefined,
      'the verification mail',
    );
    const token = decodeURIComponent(/#token=(\S+)/.exec(mail!.body)![1]!);
    assert.equal((await call(api.url, 'POST', '/v1/email-verification', { token })).status, 200);
    const login = await fetch(`${api.url}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((header) => header.split(';')[0]!).join('; ');
    const session = await call(api.url, 'GET', '/v1/session', undefined, cookie);
    const tenant = session.body.tenantId as string;

    // The number's connection is set up directly: the guided flow has its own
    // tests, and what matters here is a live bot on a connected number.
    const accessToken = ['independence', label, 'token'].join('-');
    cloudBackend.register({ token: accessToken, phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, appId: APP_ID });
    await withTenant(db.pool, tenant, async (tx) => {
      await submitCredentials(tx, sealer, { phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, accessToken }, { principal: 'independence-test' });
      await transitionConnection(tx, 'connected');
      await savePersona(tx, { botName: `${label} Bot` });
      await setBotActive(tx, true);
    });
    return { tenant, cookie, phoneNumberId };
  }

  /** What Meta does when a customer writes: a signed notification to the gateway. */
  async function customerWrites(client: Client, customer: string, text: string, base = gateway.url, laterBySeconds = 0): Promise<number> {
    messageCounter += 1;
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: BUSINESS_ACCOUNT_ID,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: client.phoneNumberId },
                contacts: [{ profile: { name: 'Sam' }, wa_id: customer }],
                messages: [
                  {
                    from: customer,
                    id: `wamid.independence-${messageCounter}`,
                    timestamp: String(Math.floor(Date.now() / 1000) + laterBySeconds),
                    type: 'text',
                    text: { body: text },
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    const response = await fetch(`${base}${WEBHOOK_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`,
      },
      body,
    });
    await response.arrayBuffer();
    return response.status;
  }

  function sentTo(customer: string): string[] {
    return cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body);
  }

  async function transcript(client: Client, customerId: string): Promise<[string, string][]> {
    const read = await call(api.url, 'POST', '/v1/conversations/transcript', { customerId }, client.cookie);
    assert.equal(read.status, 200, JSON.stringify(read.body));
    return read.body.entries.map((entry: { from: string; text: string }) => [entry.from, entry.text]);
  }

  /** The processes an operator would see as live, by component. */
  async function liveInstances(): Promise<Record<string, string[]>> {
    const rows = await withPlatformScope(db.pool, async (tx) =>
      (await tx.query<{ component: string; instance_id: string }>(
        'SELECT component, instance_id FROM component_heartbeats WHERE stopped_at IS NULL ORDER BY started_at, instance_id',
      )).rows,
    );
    const live: Record<string, string[]> = {};
    for (const row of rows) (live[row.component] ??= []).push(row.instance_id);
    return live;
  }

  async function healthy(base: string): Promise<boolean> {
    try {
      return (await fetch(`${base}/health/ready`)).status === 200;
    } catch {
      return false;
    }
  }

  before(async () => {
    db = await createTestDatabase('independence');
    // Started in the order a deployment would never guarantee: each migrates
    // under the advisory lock and none waits for another.
    [gateway, api] = await Promise.all([startGatewayProcess(), startApiProcess()]);
    await startWorkerProcess();
    alpha = await onboardClient('alpha', '710000001');
    beta = await onboardClient('beta', '710000002');
  });

  after(async () => {
    await stopAllWorkers();
    await gateway?.stop();
    await api?.stop();
    await db?.drop();
  });

  specTest(
    'component-independence.md',
    'AC1 one component is redeployed without restarting any other',
    'replacing the worker process leaves the gateway and the API the same live instances, and the new worker answers',
    async () => {
      const beforeRedeploy = await liveInstances();
      assert.equal(beforeRedeploy['whatsapp-gateway']?.length, 1);
      assert.equal(beforeRedeploy.api?.length, 1);
      assert.equal(beforeRedeploy['conversation-worker']?.length, 1);

      await stopAllWorkers();
      const replacement = await startWorkerProcess();

      const afterRedeploy = await liveInstances();
      assert.deepEqual(afterRedeploy['whatsapp-gateway'], beforeRedeploy['whatsapp-gateway'], 'the gateway was not restarted');
      assert.deepEqual(afterRedeploy.api, beforeRedeploy.api, 'the API was not restarted');
      assert.deepEqual(afterRedeploy['conversation-worker'], [replacement.instanceId]);

      assert.equal(await customerWrites(alpha, '15550100001', 'after the redeploy?'), 200);
      await eventually(() => sentTo('15550100001'), (sends) => sends.length === 1, 'the new worker to answer');
      assert.deepEqual(sentTo('15550100001'), ['Re: after the redeploy?']);
    },
  );

  specTest(
    'component-independence.md',
    'AC5 functionality not depending on a stopped component keeps working',
    'with no worker running, customers are still acknowledged and stored and clients still log in, configure, and read',
    async () => {
      await stopAllWorkers();
      assert.equal((await liveInstances())['conversation-worker'], undefined);

      assert.equal(await customerWrites(alpha, '15550200001', 'is anyone there?'), 200);
      assert.equal(await customerWrites(beta, '15550200002', 'hello from beta'), 200);

      // The API does not need the worker for anything a client does.
      assert.ok(await healthy(api.url));
      assert.ok(await healthy(gateway.url));
      const renamed = await call(api.url, 'PUT', '/v1/bot/persona', { botName: 'Alpha Renamed' }, alpha.cookie);
      assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
      assert.deepEqual(await transcript(alpha, '15550200001'), [['customer', 'is anyone there?']]);
      assert.deepEqual(await transcript(beta, '15550200002'), [['customer', 'hello from beta']]);
      const second = await fetch(`${api.url}/v1/session`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'beta-independence@example.com', password: PASSWORD }),
      });
      await second.arrayBuffer();
      assert.equal(second.status, 200);

      // Nothing answers, and nothing is lost: both are waiting on the queue.
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
      assert.deepEqual(sentTo('15550200001'), []);
      assert.deepEqual(sentTo('15550200002'), []);
    },
  );

  specTest(
    'component-independence.md',
    'AC6 a component deliberately stopped resumes normal operation when later restarted, with no other intervention',
    'a worker started after an outage answers what arrived while it was away, once each, for both tenants',
    async () => {
      await startWorkerProcess();
      await eventually(
        () => [sentTo('15550200001'), sentTo('15550200002')],
        ([a, b]) => a!.length === 1 && b!.length === 1,
        'the backlog to be answered',
      );
      assert.deepEqual(sentTo('15550200001'), ['Re: is anyone there?']);
      assert.deepEqual(sentTo('15550200002'), ['Re: hello from beta']);
      assert.deepEqual(await transcript(alpha, '15550200001'), [
        ['customer', 'is anyone there?'],
        ['bot', 'Re: is anyone there?'],
      ]);
      // And only once, however long we wait.
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
      assert.equal(sentTo('15550200001').length, 1);
      assert.equal(sentTo('15550200002').length, 1);
    },
  );

  specTest(
    'component-independence.md',
    'AC2 restarting one component leaves unrelated components available throughout',
    'customers are answered while the API is down, and a restarted API honours the sessions its predecessor issued',
    async () => {
      const gatewayInstance = (await liveInstances())['whatsapp-gateway'];
      await api.stop();
      assert.equal(await healthy(api.url), false);

      // The bot does not need the API: a customer writing now is answered.
      assert.equal(await customerWrites(beta, '15550300001', 'while the dashboard is down'), 200);
      await eventually(() => sentTo('15550300001'), (sends) => sends.length === 1, 'the reply without an API');
      assert.deepEqual(sentTo('15550300001'), ['Re: while the dashboard is down']);

      api = await startApiProcess();
      // Sessions live in the database, so the client is still logged in on the new process.
      assert.deepEqual(await transcript(beta, '15550300001'), [
        ['customer', 'while the dashboard is down'],
        ['bot', 'Re: while the dashboard is down'],
      ]);
      assert.deepEqual((await liveInstances())['whatsapp-gateway'], gatewayInstance, 'the gateway was not restarted');
    },
  );

  specTest(
    'component-independence.md',
    'AC5 functionality not depending on a stopped component keeps working',
    'with the gateway down, a message it already accepted is still answered and the API keeps serving; a restarted gateway accepts again',
    async () => {
      assert.equal(await customerWrites(alpha, '15550400001', 'just before the gateway goes'), 200);
      await gateway.stop();
      assert.equal(await healthy(gateway.url), false);

      await eventually(() => sentTo('15550400001'), (sends) => sends.length === 1, 'the accepted message to be answered');
      assert.deepEqual(sentTo('15550400001'), ['Re: just before the gateway goes']);
      assert.ok(await healthy(api.url));
      assert.equal((await call(api.url, 'GET', '/v1/bot/status', undefined, alpha.cookie)).status, 200);

      gateway = await startGatewayProcess();
      assert.equal(await customerWrites(alpha, '15550400001', 'and after it is back'), 200);
      await eventually(() => sentTo('15550400001'), (sends) => sends.length === 2, 'the next message to be answered');
      assert.deepEqual(sentTo('15550400001'), ['Re: just before the gateway goes', 'Re: and after it is back']);
    },
  );

  specTest(
    'component-independence.md',
    'AC3 scaling one component changes no other',
    'a second worker is just another consumer: every turn of both tenants is answered exactly once, and the gateway and API are untouched',
    async () => {
      const beforeScale = await liveInstances();
      await startWorkerProcess();
      const scaled = await liveInstances();
      assert.equal(scaled['conversation-worker']?.length, 2);
      assert.deepEqual(scaled['whatsapp-gateway'], beforeScale['whatsapp-gateway']);
      assert.deepEqual(scaled.api, beforeScale.api);

      const customers = ['15550500001', '15550500002', '15550500003'];
      // Every conversation bursts at once; within one, the second message is sent
      // after the first and stamped a second later, as a phone would.
      const writes: Promise<number[]>[] = [];
      for (const customer of customers) {
        for (const client of [alpha, beta]) {
          const name = client === alpha ? 'alpha' : 'beta';
          writes.push(
            (async () => [
              await customerWrites(client, customer, `${name} first`),
              await customerWrites(client, customer, `${name} second`, gateway.url, 1),
            ])(),
          );
        }
      }
      assert.deepEqual((await Promise.all(writes)).flat(), writes.flatMap(() => [200, 200]));

      // One customer number writing to two businesses is two conversations, so each gets two replies — one per business.
      await eventually(
        () => customers.map((customer) => sentTo(customer).length),
        (counts) => counts.every((count) => count >= 2),
        'every turn to be answered',
      );
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
      for (const customer of customers) {
        assert.deepEqual(
          [...sentTo(customer)].sort(),
          ['Re: alpha first | alpha second', 'Re: beta first | beta second'],
          `customer ${customer} was answered once per business, each burst whole`,
        );
      }

      // Scaling back down is stopping one; the other carries on alone.
      const [first] = workers;
      await stopWorker(first!);
      assert.equal((await liveInstances())['conversation-worker']?.length, 1);
      assert.equal(await customerWrites(beta, '15550500004', 'after scaling down'), 200);
      await eventually(() => sentTo('15550500004'), (sends) => sends.length === 1, 'the remaining worker to answer');
    },
  );

  specTest(
    'component-independence.md',
    'AC7 data owned by other components is intact after a component fails',
    'a worker that dies holding a turn leaves it to its successor, answered once, with both connections and every earlier answer intact',
    async () => {
      const historyBefore = {
        alpha: await transcript(alpha, '15550400001'),
        beta: await transcript(beta, '15550300001'),
      };
      const hold = provider.holdNext();
      assert.equal(await customerWrites(alpha, '15550600001', 'asked as the worker dies'), 200);
      await hold.reached;

      // The worker holding the turn dies: its grace runs out with the model still
      // thinking, and its pool is closed under it.
      await stopAllWorkers();
      hold.release();
      // Meanwhile the gateway is unaffected and still accepting for the other tenant.
      assert.equal(await customerWrites(beta, '15550600002', 'while alpha is stuck'), 200);

      await startWorkerProcess();
      // The orphaned turn waits out its lease (WORKER_VISIBILITY_TIMEOUT) and is then taken over.
      await eventually(
        () => [sentTo('15550600001'), sentTo('15550600002')],
        ([a, b]) => a!.length === 1 && b!.length === 1,
        'both turns to be answered',
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
      assert.deepEqual(sentTo('15550600001'), ['Re: asked as the worker dies'], 'answered once, by the successor');
      assert.deepEqual(sentTo('15550600002'), ['Re: while alpha is stuck']);

      for (const client of [alpha, beta]) {
        const connection = await withTenant(db.pool, client.tenant, (tx) => readConnection(tx));
        assert.equal(connection.state, 'connected', 'a worker crash does not touch the connection');
      }
      assert.deepEqual(await transcript(alpha, '15550400001'), historyBefore.alpha);
      assert.deepEqual(await transcript(beta, '15550300001'), historyBefore.beta);
    },
  );

  specTest(
    'component-independence.md',
    'AC8 no tenant shows loss or corruption after a component fails',
    'across both tenants, every message the gateway accepted is stored once, answered once, and delivered',
    async () => {
      for (const client of [alpha, beta]) {
        const rows = await withTenant(db.pool, client.tenant, async (tx) => ({
          messages: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM inbound_messages')).rows[0]!.n,
          distinct: (await tx.query<{ n: number }>('SELECT count(DISTINCT external_id)::int AS n FROM inbound_messages')).rows[0]!.n,
          outcomes: (await tx.query<{ outcome: string; delivery_state: string }>(
            'SELECT outcome, delivery_state FROM conversation_turn_outcomes',
          )).rows,
          turns: (await tx.query<{ n: number }>('SELECT count(*)::int AS n FROM conversation_turns')).rows[0]!.n,
        }));
        assert.equal(rows.messages, rows.distinct, 'no message stored twice');
        assert.equal(rows.outcomes.length, rows.turns, 'every turn has exactly one answer');
        assert.ok(rows.outcomes.length > 0);
        for (const outcome of rows.outcomes) assert.deepEqual({ ...outcome }, { outcome: 'reply', delivery_state: 'sent' });
      }
    },
  );

  specTest(
    'component-independence.md',
    'AC10 a replacement honouring the same contract needs no change elsewhere',
    'a producer written differently from the gateway, honouring only its contract (a stored message and its job), is answered by the unmodified worker',
    async () => {
      // The gateway's contract with the worker is a stored `inbound_messages` row
      // and an inbound job in the same transaction. Anything that keeps it — a
      // rewritten gateway, another channel — is consumed with no worker change.
      const scheduler = new PostgresQueue({ name: INBOUND_QUEUE, pool: db.pool });
      try {
        await withTenant(db.pool, beta.tenant, async (tx) => {
          const stored = await recordInboundMessage(tx, beta.phoneNumberId, {
            externalId: 'wamid.independence-replacement',
            customerId: '15550700001',
            type: 'text',
            upstreamType: 'text',
            content: { text: 'from a replacement producer' },
            sentAt: new Date(),
          });
          assert.ok(stored.created);
          await scheduler.enqueueWithin(tx, {
            kind: INBOUND_JOB_KIND,
            payload: { inboundMessageId: stored.id },
            partitionKey: '15550700001',
            dedupeKey: 'wamid.independence-replacement',
          });
        });
      } finally {
        await scheduler.close();
      }
      await eventually(() => sentTo('15550700001'), (sends) => sends.length === 1, 'the worker to answer');
      assert.deepEqual(sentTo('15550700001'), ['Re: from a replacement producer']);
    },
  );

  specTest(
    'component-independence.md',
    'AC11 one platform-wide operation serves every tenant',
    'one worker restart serves both tenants: each is answered by the same new process with no per-tenant step',
    async () => {
      await stopAllWorkers();
      assert.equal(await customerWrites(alpha, '15550800001', 'alpha after the restart'), 200);
      assert.equal(await customerWrites(beta, '15550800002', 'beta after the restart'), 200);
      const restarted = await startWorkerProcess();
      await eventually(
        () => [sentTo('15550800001'), sentTo('15550800002')],
        ([a, b]) => a!.length === 1 && b!.length === 1,
        'both tenants to be answered',
      );
      assert.deepEqual((await liveInstances())['conversation-worker'], [restarted.instanceId]);
      assert.deepEqual(sentTo('15550800001'), ['Re: alpha after the restart']);
      assert.deepEqual(sentTo('15550800002'), ['Re: beta after the restart']);
    },
  );
});
