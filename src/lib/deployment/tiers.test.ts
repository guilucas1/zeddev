/**
 * The same platform on all three tiers, from configuration alone
 * (`environment-portability.md`).
 *
 * For each tier in `DEPLOYMENT_TIERS`, every service — the API, the gateway, the
 * conversation worker, the scheduler, and `web` — is started from that tier's
 * documented values exactly as written, plus only what any deployment supplies for
 * itself (where its database is, its credentials, its public URL). Then the same
 * scenario runs on each, as a client and an operator would drive it through
 * `web`: two businesses sign up, confirm the mailed link, configure a bot,
 * connect a number by the guided flow (the code goes out through Meta and comes
 * back through the gateway), go live, and are written to by customers; the
 * operator logs in and looks.
 *
 * What it holds the tiers to:
 *
 * - Each becomes fully functional (AC1–AC3). The managed-cloud tier really
 *   reaches its database over verified TLS, so the one tier whose transport
 *   differs is not the one left untested.
 * - Each tier's values take effect. Whether a service's database link is
 *   encrypted is read from the server, per service.
 * - From outside, the three are indistinguishable (AC8, AC9): every answer the
 *   scenario reads is compared across tiers, after replacing only what differs
 *   between any two runs (ids, timestamps, measured durations).
 * - Moving is configuration (AC4): a deployment brought up as a personal computer
 *   is restarted as a VPS and then as a managed cloud deployment against the same
 *   data, and its clients' sessions, connections, and history carry over.
 *
 * Only the model and Meta's Cloud API are faked, at their ports, and mail is
 * caught in memory: none of them is what differs between tiers. SMTP transport
 * has its own suite against a real server.
 */

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { Readable, Writable } from 'node:stream';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider, type ObservedRequest } from '@zeddev/ai/testing';
import { runCli, startApi, type RunningApi } from '@zeddev/api';
import { loadConfig, type ConfigSchema } from '@zeddev/config';
import { startWorker, type RunningWorker } from '@zeddev/conversation-worker';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, testDatabaseTls, type TestDatabase } from '@zeddev/db/testing';
import { MemorySink } from '@zeddev/logging';
import { decodeMail, InMemoryMailer } from '@zeddev/mail/testing';
import { startScheduler, type RunningScheduler } from '@zeddev/scheduler';
import { generateSealingKey } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { startWeb, type RunningWeb } from '@zeddev/web';
import { startGateway, WEBHOOK_PATH, type RunningGateway } from '@zeddev/whatsapp-gateway';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';
import { DEPLOYMENT_TIERS, PLATFORM_CONFIG_SCHEMAS, tierEnvironment, type DeploymentTier } from './index.ts';

const APP_ID = '3090002222';
const APP_SECRET = ['tiers', 'app', 'secret'].join('-');
const SEALING_KEY = generateSealingKey('tiers');
const PASSWORD = 'harbour-lantern-quill-4';
const OPERATOR_EMAIL = 'ops@example.com';
const OWNER_PHONE = '15550009999';
const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;
const WINDOW_MS = 500;

const BUSINESSES = [
  { label: 'aurora', phoneNumberId: '720000001', businessAccountId: '20230001111' },
  { label: 'borealis', phoneNumberId: '720000002', businessAccountId: '20230002222' },
] as const;

function quoteCustomer(request: ObservedRequest): string {
  if (request.operation !== 'generate') return 'transcribed';
  const customer = request.turns.filter((turn) => turn.role === 'customer').at(-1);
  const texts = (customer?.parts ?? []).flatMap((part) => (part.type === 'text' ? [part.text] : []));
  return `[reply]\nRe: ${texts.join('\n\n').split(/\s*\n+\s*/).join(' | ')}`;
}

function schemaFor(key: string): ConfigSchema | undefined {
  const section = PLATFORM_CONFIG_SCHEMAS.find((candidate) => key in candidate.schema);
  return section === undefined ? undefined : ({ [key]: (section.schema as Record<string, unknown>)[key] } as ConfigSchema);
}

// ---------------------------------------------------------------------------
// The documented values themselves, checked without starting anything.
// ---------------------------------------------------------------------------

specTest(
  'environment-portability.md',
  'AC6 documented inputs explain every behavioral difference',
  'every value a tier sets is a registered key that parses, and none is a secret',
  () => {
    for (const tier of DEPLOYMENT_TIERS) {
      assert.ok(tier.settings.length > 0, `${tier.id} sets nothing, so it documents nothing`);
      for (const setting of tier.settings) {
        const schema = schemaFor(setting.key);
        assert.ok(schema !== undefined, `${tier.id} sets ${setting.key}, which no registered schema reads`);
        assert.notEqual((schema[setting.key] as { secret?: boolean }).secret, true, `${tier.id} must not carry a secret`);
        assert.doesNotThrow(() => loadConfig(schema, { [setting.key]: setting.value }), `${tier.id}: ${setting.key}=${setting.value}`);
      }
      const keys = tier.settings.map((setting) => setting.key);
      assert.equal(new Set(keys).size, keys.length, `${tier.id} sets a key twice`);
    }
  },
);

unitTest('every tier states the same keys, so the tiers are compared like with like', () => {
  const [first, ...rest] = DEPLOYMENT_TIERS.map((tier) => tier.settings.map((setting) => setting.key).sort());
  for (const keys of rest) assert.deepEqual(keys, first);
});

unitTest('each tier keeps a tenant below the whole worker, as WORKER_MAX_IN_FLIGHT_PER_TENANT requires', () => {
  for (const tier of DEPLOYMENT_TIERS) {
    const env = tierEnvironment(tier);
    assert.ok(Number(env.WORKER_MAX_IN_FLIGHT_PER_TENANT) < Number(env.WORKER_CONCURRENCY) || env.WORKER_CONCURRENCY === '1', tier.id);
  }
});

// ---------------------------------------------------------------------------
// The tiers, running.
// ---------------------------------------------------------------------------

interface Stack {
  readonly api: RunningApi;
  readonly web: RunningWeb;
  readonly gateway: RunningGateway;
  readonly worker: RunningWorker;
  readonly scheduler: RunningScheduler;
  readonly env: Record<string, string>;
  readonly tier: DeploymentTier;
  /** Each API closes its mailer on stop, so every stack has its own. */
  readonly mailer: InMemoryMailer;
}

interface Client {
  readonly label: string;
  readonly phoneNumberId: string;
  readonly cookie: string;
}

/** A free port, so `API_PUBLIC_BASE_URL` can name `web` before `web` starts. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

// 30 s, not 10: an answer waits out the burst quiet period and then a worker
// cycle, and under `npm test`'s full parallel load one tier once took longer than
// 10 s for one business. These checks assert that answers arrive, not how fast,
// so the deadline only bounds how long a genuine failure takes to report.
async function eventually<T>(read: () => Promise<T> | T, done: (value: T) => boolean, label: string, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Replace what differs between any two runs, and nothing else: ids, instants,
 * and measured durations. Whatever is left must be the same on every tier.
 */
function normalize(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((item) => normalize(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, normalize(inner, name)]));
  }
  if (typeof value === 'string') {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return '<id>';
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) return '<instant>';
    // A cursor encodes a position in time, so it is as run-specific as an instant.
    if (/cursor/i.test(key)) return '<cursor>';
  }
  if (typeof value === 'number' && /(ms|millis|duration|responsetime|seconds|average)/i.test(key)) return '<measured>';
  return value;
}

describe('the platform on every deployment tier', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let tls: ReturnType<typeof testDatabaseTls>;
  const databases = new Map<DeploymentTier['id'], TestDatabase>();
  const observations = new Map<DeploymentTier['id'], unknown>();
  const running = new Set<Stack>();
  const ai = new InMemoryAiProvider({ reply: quoteCustomer });
  /**
   * Meta as one deployment's tenants know it. A deployment that moves keeps its
   * tenants' numbers, so it keeps its backend too.
   */
  const backends = new Map<TestDatabase, ScriptedCloudBackend>();
  let backend: ScriptedCloudBackend;
  let messageCounter = 0;
  /** Clients of the personal-computer deployment, carried through the move. */
  let movedClients: Client[] = [];

  /**
   * What every deployment supplies for itself, whatever its tier. The test holds
   * itself to the split `tiers.ts` documents: nothing here is a key a tier sets.
   */
  function deploymentValues(db: TestDatabase, webPort: number): Record<string, string> {
    return {
      // By the name the server's certificate carries, as a managed endpoint is reached.
      DATABASE_HOST: tls.host,
      DATABASE_PORT: String(db.options.port),
      DATABASE_NAME: db.options.database,
      DATABASE_USER: db.options.user,
      DATABASE_PASSWORD: db.options.password?.expose() ?? '',
      DATABASE_CA_CERTIFICATE: tls.caCertificate,
      MAIL_HOST: 'mail.invalid',
      MAIL_FROM_ADDRESS: 'no-reply@example.com',
      AI_BASE_URL: 'https://example.com/v1beta',
      AI_MODEL: 'gemini-2.5-flash',
      API_PUBLIC_BASE_URL: `http://127.0.0.1:${webPort}`,
      API_HTTP_HOST: '127.0.0.1',
      API_HTTP_PORT: '0',
      GATEWAY_HTTP_HOST: '127.0.0.1',
      GATEWAY_HTTP_PORT: '0',
      WEB_HTTP_HOST: '127.0.0.1',
      WEB_HTTP_PORT: String(webPort),
      VAULT_SEALING_KEYS: SEALING_KEY,
      WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
      WHATSAPP_APP_ID: APP_ID,
      WHATSAPP_APP_SECRET: APP_SECRET,
      WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['tiers', 'verify', 'token'].join('-'),
      // Shortened so the suite runs in seconds. Not a tier's character: the
      // tiers leave them at their defaults.
      WORKER_AGGREGATION_WINDOW: `${WINDOW_MS}ms`,
      WORKER_MAX_TURN_DURATION: '3s',
      API_SHUTDOWN_GRACE: '1s',
      GATEWAY_SHUTDOWN_GRACE: '1s',
      WORKER_SHUTDOWN_GRACE: '500ms',
      SCHEDULER_SHUTDOWN_GRACE: '500ms',
      WEB_SHUTDOWN_GRACE: '500ms',
    };
  }

  async function startStack(tier: DeploymentTier, db: TestDatabase): Promise<Stack> {
    const webPort = await freePort();
    const own = deploymentValues(db, webPort);
    const fromTier = tierEnvironment(tier);
    const overlap = Object.keys(own).filter((key) => key in fromTier);
    assert.deepEqual(overlap, [], 'the harness must not override a value the tier documents');
    const env = { ...own, ...fromTier };
    const mailer = new InMemoryMailer();
    backend = backends.get(db) ?? new ScriptedCloudBackend();
    backends.set(db, backend);
    const cloud = () => new InMemoryWhatsAppCloud({ appId: APP_ID, backend });

    // Whatever started is stopped if a later service refuses to, or the suite hangs on open pools.
    const started: { stop(): Promise<void> }[] = [];
    const track = <T extends { stop(): Promise<void> }>(service: T): T => (started.push(service), service);
    let api: RunningApi, gateway: RunningGateway, web: RunningWeb, worker: RunningWorker, scheduler: RunningScheduler;
    try {
      api = track(await startApi(env, { mailer, ai, cloud: cloud(), sink: new MemorySink(), credentialParams: FAST_SCRYPT }));
      gateway = track(await startGateway(env, { sink: new MemorySink() }));
      web = track(await startWeb({ ...env, WEB_API_UPSTREAM: api.url }, { sink: new MemorySink() }));
      worker = track(await startWorker(env, { ai, cloud: cloud(), sink: new MemorySink() }));
      scheduler = track(await startScheduler(env, { cloud: cloud(), sink: new MemorySink() }));
    } catch (error) {
      for (const service of started.reverse()) await service.stop();
      throw error;
    }
    const stack: Stack = { api, web, gateway, worker, scheduler, env: { ...env, WEB_API_UPSTREAM: api.url }, tier, mailer };
    running.add(stack);
    return stack;
  }

  async function stopStack(stack: Stack): Promise<void> {
    await stack.web.stop();
    await Promise.all([stack.worker.stop(), stack.scheduler.stop(), stack.gateway.stop()]);
    await stack.api.stop();
    running.delete(stack);
  }

  /**
   * A request as a browser sends it to `web`: same-origin `Origin` on anything that
   * changes state, and, on a tier with a proxy in front of `web`, the
   * `X-Forwarded-For` that proxy adds.
   */
  async function browser(stack: Stack, method: string, path: string, json?: unknown, cookie?: string) {
    const headers: Record<string, string> = {};
    if (json !== undefined) headers['content-type'] = 'application/json';
    if (cookie !== undefined) headers.cookie = cookie;
    if (method !== 'GET') headers.origin = stack.env.API_PUBLIC_BASE_URL!;
    const proxiesBeforeWeb = Number(stack.tier.settings.find((setting) => setting.key === 'API_TRUSTED_PROXY_HOPS')!.value) - 1;
    if (proxiesBeforeWeb > 0) headers['x-forwarded-for'] = '203.0.113.7';
    const response = await fetch(`${stack.web.url}${path}`, {
      method,
      headers,
      ...(json === undefined ? {} : { body: JSON.stringify(json) }),
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? undefined : JSON.parse(text),
      cookies: response.headers.getSetCookie().map((header) => header.split(';')[0]!).join('; '),
    };
  }

  async function customerWrites(stack: Stack, phoneNumberId: string, from: string, text: string, laterBySeconds = 0): Promise<number> {
    messageCounter += 1;
    const body = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'tiers',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
                contacts: [{ profile: { name: 'Sam' }, wa_id: from }],
                messages: [
                  {
                    from,
                    id: `wamid.tiers-${messageCounter}`,
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
    const response = await fetch(`${stack.gateway.url}${WEBHOOK_PATH}`, {
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
    return backend.sends.filter((send) => send.to === customer).map((send) => send.body);
  }

  /** A business as the product makes one, through `web`, from signup to a live bot on a verified number. */
  async function onboard(stack: Stack, business: (typeof BUSINESSES)[number]): Promise<{ client: Client; seen: unknown[] }> {
    const email = `${business.label}-${stack.tier.id}@example.com`;
    const seen: unknown[] = [];
    const signup = await browser(stack, 'POST', '/v1/signup', { businessName: `${business.label} Bakery`, email, password: PASSWORD });
    assert.equal(signup.status, 201, JSON.stringify(signup.body));
    const mail = await eventually(
      () => stack.mailer.delivered.map((delivered) => decodeMail(delivered.raw)).find((decoded) => decoded.to === email),
      (found) => found !== undefined,
      'the verification mail',
    );
    assert.ok(mail!.body.includes(`${stack.env.API_PUBLIC_BASE_URL}/`), 'the link points at the deployment’s own public address');
    const token = decodeURIComponent(/#token=(\S+)/.exec(mail!.body)![1]!);
    assert.equal((await browser(stack, 'POST', '/v1/email-verification', { token })).status, 200);
    const login = await browser(stack, 'POST', '/v1/session', { email, password: PASSWORD });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = login.cookies;

    const persona = await browser(stack, 'PUT', '/v1/bot/persona', { botName: `${business.label} Bot` }, cookie);
    assert.equal(persona.status, 200, JSON.stringify(persona.body));

    const accessToken = ['EAA', business.label, stack.tier.id.replace(/_/g, ''), 'cccccccccccccccc'].join('');
    backend.register({
      token: accessToken,
      phoneNumberId: business.phoneNumberId,
      businessAccountId: business.businessAccountId,
      appId: APP_ID,
      displayNumber: '+55 11 5555-0100',
      verifiedName: `${business.label} Bakery`,
    });
    const submitted = await browser(
      stack,
      'POST',
      '/v1/whatsapp/connection',
      { phoneNumberId: business.phoneNumberId, businessAccountId: business.businessAccountId, accessToken },
      cookie,
    );
    assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
    seen.push(submitted.body);
    const asked = await browser(stack, 'POST', '/v1/whatsapp/connection/verification', { recipient: OWNER_PHONE }, cookie);
    assert.equal(asked.body.attempt?.sent, true, JSON.stringify(asked.body));
    seen.push(asked.body);
    const code = /\b(\d{6})\b/.exec(sentTo(OWNER_PHONE).at(-1) ?? '')?.[1];
    assert.ok(code !== undefined, 'the code went out through Meta');
    // The owner replies from their phone: it arrives where every message arrives.
    assert.equal(await customerWrites(stack, business.phoneNumberId, OWNER_PHONE, code), 200);
    const connected = await eventually(
      () => browser(stack, 'GET', '/v1/whatsapp/connection', undefined, cookie),
      (read) => read.body.state === 'connected',
      'the reply to connect the number',
    );
    seen.push(connected.body);

    const live = await browser(stack, 'PUT', '/v1/bot/activation', { active: true }, cookie);
    assert.equal(live.status, 200, JSON.stringify(live.body));
    seen.push(live.body);
    return { client: { label: business.label, phoneNumberId: business.phoneNumberId, cookie }, seen };
  }

  /** Customers writing to every business, including a two-message burst, and what each business then reads. */
  async function converse(stack: Stack, clients: readonly Client[], round: string): Promise<unknown> {
    const customers = clients.map((client, index) => ({ client, customer: `1555${round}${index}0001` }));
    for (const { client, customer } of customers) {
      assert.equal(await customerWrites(stack, client.phoneNumberId, customer, `${client.label} ${round} first`), 200);
      assert.equal(await customerWrites(stack, client.phoneNumberId, customer, `${client.label} ${round} second`, 1), 200);
    }
    await eventually(
      () => customers.map(({ customer }) => sentTo(customer).length),
      (counts) => counts.every((count) => count >= 1),
      'every business to answer',
    );
    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS * 2));
    const read = [];
    for (const { client, customer } of customers) {
      assert.deepEqual(sentTo(customer), [`Re: ${client.label} ${round} first | ${client.label} ${round} second`]);
      const transcript = await browser(stack, 'POST', '/v1/conversations/transcript', { customerId: customer }, client.cookie);
      assert.equal(transcript.status, 200, JSON.stringify(transcript.body));
      const list = await browser(stack, 'POST', '/v1/conversations/list', {}, client.cookie);
      const status = await browser(stack, 'GET', '/v1/bot/status', undefined, client.cookie);
      read.push({ sent: sentTo(customer), transcript: transcript.body, list: list.body, status: status.body });
    }
    return read;
  }

  /** What the operator sees: every tenant, and every component reporting. */
  async function operatorView(stack: Stack): Promise<unknown> {
    const login = await browser(stack, 'POST', '/v1/operator/session', { email: OPERATOR_EMAIL, password: PASSWORD });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const cookie = login.cookies;
    const connections = await browser(stack, 'GET', '/v1/operator/connections', undefined, cookie);
    assert.equal(connections.status, 200, JSON.stringify(connections.body));
    const components = await eventually(
      () => browser(stack, 'GET', '/v1/operator/components', undefined, cookie),
      (read) => read.status === 200 && read.body.components.every((component: { state: string }) => component.state === 'up'),
      'every component to report up',
    );
    return {
      connections: connections.body,
      components: components.body.components.map((component: { component: string; state: string }) => ({
        component: component.component,
        state: component.state,
      })),
    };
  }

  async function createOperator(env: Record<string, string>): Promise<void> {
    const out: string[] = [];
    const sink = () => new Writable({ write: (chunk, _encoding, done) => (out.push(String(chunk)), done()) });
    const code = await runCli(['create-operator', '--email', OPERATOR_EMAIL], {
      env,
      stdin: Readable.from([`${PASSWORD}\n`]),
      stdout: sink(),
      stderr: sink(),
      credentialParams: FAST_SCRYPT,
    });
    assert.equal(code, 0, out.join(''));
  }

  /** Each service's database link, as the server records it: encrypted or not. */
  async function linkEncryption(db: TestDatabase): Promise<Record<string, boolean[]>> {
    const rows = await db.pool.withConnection(async (connection) =>
      (await connection.query<{ application_name: string; ssl: boolean }>(
        `SELECT a.application_name, s.ssl
           FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid)
          WHERE a.datname = current_database() AND a.application_name LIKE 'zeddev-%'
            AND a.application_name <> $1 AND a.pid <> pg_backend_pid()
          ORDER BY 1`,
        [db.options.applicationName],
      )).rows,
    );
    const links: Record<string, boolean[]> = {};
    for (const row of rows) (links[row.application_name] ??= []).push(row.ssl);
    return links;
  }

  before(() => {
    tls = testDatabaseTls();
  });

  after(async () => {
    for (const stack of [...running]) await stopStack(stack);
    for (const db of databases.values()) await db.drop();
  });

  const CRITERIA: Record<DeploymentTier['id'], string> = {
    personal_computer: 'AC1 the unmodified codebase becomes functional from documented configuration alone',
    vps: 'AC2 the system becomes fully functional on a low-cost VPS from documented configuration alone',
    managed_cloud: 'AC3 the system becomes fully functional on a managed cloud provider from documented configuration alone',
  };

  for (const tier of DEPLOYMENT_TIERS) {
    specTest(
      'environment-portability.md',
      CRITERIA[tier.id],
      `${tier.title}: from its documented values, two businesses go from signup to answered customers, and the operator sees both`,
      async () => {
        const db = await createTestDatabase(`tier_${tier.id}`);
        databases.set(tier.id, db);
        const stack = await startStack(tier, db);
        try {
          await createOperator(stack.env);
          const onboarded = [];
          for (const business of BUSINESSES) onboarded.push(await onboard(stack, business));
          const clients = onboarded.map((entry) => entry.client);
          const conversations = await converse(stack, clients, '1');
          const operator = await operatorView(stack);

          // The tier's transport choice took effect on every service's link.
          const links = await linkEncryption(db);
          assert.ok(Object.keys(links).length >= 4, `every database-backed service holds a link: ${JSON.stringify(links)}`);
          const encrypted = tierEnvironment(tier).DATABASE_SSL_MODE !== 'disable';
          for (const [service, states] of Object.entries(links)) {
            assert.ok(states.every((state) => state === encrypted), `${service} on ${tier.id}: ${JSON.stringify(states)}`);
          }

          observations.set(tier.id, normalize({ onboarding: onboarded.map((entry) => entry.seen), conversations, operator }));
          if (tier.id === 'personal_computer') movedClients = clients;
        } finally {
          await stopStack(stack);
        }
        if (tier.id !== 'personal_computer') {
          await db.drop();
          databases.delete(tier.id);
        }
      },
    );
  }

  specTest(
    'environment-portability.md',
    'AC8 externally observable behavior is indistinguishable across tiers',
    'every answer the scenario read is the same on all three tiers, once ids, instants, and measured durations are set aside',
    () => {
      assert.equal(observations.size, DEPLOYMENT_TIERS.length, 'every tier ran');
      const [first, ...rest] = DEPLOYMENT_TIERS.map((tier) => ({ id: tier.id, seen: observations.get(tier.id) }));
      for (const other of rest) assert.deepEqual(other.seen, first!.seen, `${other.id} differs from ${first!.id}`);
    },
  );

  specTest(
    'environment-portability.md',
    'AC9 every tenant operates identically on every tier',
    'on every tier both businesses were answered, and each business’s answers had the same shape as the other’s',
    () => {
      for (const tier of DEPLOYMENT_TIERS) {
        const seen = observations.get(tier.id) as { conversations: { sent: string[]; transcript: unknown }[] };
        assert.equal(seen.conversations.length, BUSINESSES.length);
        const [a, b] = seen.conversations;
        assert.equal(a!.sent.length, 1);
        assert.equal(b!.sent.length, 1);
        const shape = (value: unknown) => JSON.stringify(value).replace(/aurora|borealis/g, '<business>').replace(/1555\d+/g, '<customer>');
        assert.equal(shape(a!.transcript), shape(b!.transcript), `${tier.id}: the two businesses were served differently`);
      }
    },
  );

  specTest(
    'environment-portability.md',
    'AC4 moving between tiers requires configuration changes only',
    'a deployment brought up as a personal computer is restarted as a VPS, then as a managed cloud, on the same data: sessions, connections, and history carry over',
    async () => {
      const db = databases.get('personal_computer');
      assert.ok(db !== undefined && movedClients.length === BUSINESSES.length, 'the personal-computer deployment ran');
      let round = 2;
      for (const id of ['vps', 'managed_cloud'] as const) {
        const tier = DEPLOYMENT_TIERS.find((candidate) => candidate.id === id)!;
        const stack = await startStack(tier, db);
        try {
          for (const client of movedClients) {
            // Logged in before the move, still logged in after it.
            const connection = await browser(stack, 'GET', '/v1/whatsapp/connection', undefined, client.cookie);
            assert.equal(connection.status, 200, JSON.stringify(connection.body));
            assert.equal(connection.body.state, 'connected');
            const earlier = await browser(stack, 'POST', '/v1/conversations/transcript', { customerId: `15551${movedClients.indexOf(client)}0001` }, client.cookie);
            assert.deepEqual(
              earlier.body.entries.map((entry: { from: string; text: string }) => [entry.from, entry.text]),
              [
                ['customer', `${client.label} 1 first`],
                ['customer', `${client.label} 1 second`],
                ['bot', `Re: ${client.label} 1 first | ${client.label} 1 second`],
              ],
            );
          }
          await converse(stack, movedClients, String(round));
          await operatorView(stack);
          const links = await linkEncryption(db);
          const encrypted = tierEnvironment(tier).DATABASE_SSL_MODE !== 'disable';
          for (const [service, states] of Object.entries(links)) {
            assert.ok(states.every((state) => state === encrypted), `${service} after moving to ${id}`);
          }
        } finally {
          await stopStack(stack);
        }
        round += 1;
      }
    },
  );
});
