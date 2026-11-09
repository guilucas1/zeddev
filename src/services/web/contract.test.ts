/**
 * Every screen, driven as a browser drives it, against the real API.
 *
 * The screens are written against response shapes they do not import, so what
 * keeps them honest is here: the real `services/api` over a real PostgreSQL, behind
 * the real forward, reached with a cookie jar and an `Origin` header exactly as a
 * browser would send them. A renamed field makes one of these screens render
 * `undefined` or throw.
 *
 * Only `shell.ts` is outside this: it needs a DOM, and is thin on purpose.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider } from '@zeddev/ai/testing';
import { createApi, type Api as ApiService } from '@zeddev/api';
import { loadServerSettings } from '@zeddev/api/config';
import { withTenant } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { IdentityService, type IdentityPolicy } from '@zeddev/identity';
import { Logger, MemorySink } from '@zeddev/logging';
import { decodeMail, InMemoryMailer } from '@zeddev/mail/testing';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { consumeVerificationReply, transitionConnection, type ConnectionState } from '@zeddev/whatsapp';
import { InMemoryWhatsAppCloud } from '@zeddev/whatsapp/testing';
import { createWeb } from './app.ts';
import { loadAssets } from './assets.ts';
import { loadWebSettings } from './config.ts';
import { Api, ApiError } from './ui/api.ts';
import { PAGES, type PagePath } from './ui/paths.ts';
import { SCREENS } from './ui/routes.ts';
import { failureMessages, type Screen, type ScreenContext } from './ui/screen.ts';

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;
const POLICY: IdentityPolicy = {
  sessionInactivityMs: 60_000,
  sessionAbsoluteLifetimeMs: 120_000,
  maxFailedAttempts: 50,
  lockoutMs: 30_000,
  emailVerificationTtlMs: 60_000,
  passwordResetTtlMs: 60_000,
  minPasswordLength: 12,
};
const PASSWORD = 'meadow-granite-vessel-8';
const NEW_PASSWORD = 'harbour-thistle-copper-4';
const SEALER = new SecretSealer([parseSealingKey(generateSealingKey('test'), 'VAULT_SEALING_KEYS')]);
const APP_ID = '3090002222';
/** A marker no fixture identifier can contain. */
const CONTENT_NEEDLE = 'zebra-marmalade-confidential';
const HOSTILE = '<img src=x onerror=alert(1)>';

describe('the dashboards against the real API', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let identity: IdentityService;
  let mailer: InMemoryMailer;
  let ai: InMemoryAiProvider;
  let cloud: InMemoryWhatsAppCloud;
  let apiService: ApiService;
  let apiServer: Server;
  let webServer: Server;
  let origin: string;
  let counter = 0;
  const sink = new MemorySink();

  before(async () => {
    db = await createTestDatabase('web');
    await migrateToLatest(db.pool);
    mailer = new InMemoryMailer();
    ai = new InMemoryAiProvider();
    cloud = new InMemoryWhatsAppCloud({ appId: APP_ID });
    identity = new IdentityService({ pool: db.pool, policy: POLICY, credentialParams: FAST_SCRYPT, logger: new Logger({ sink }) });

    // The API must know the address the browser is on before it can check Origin,
    // so that address is taken first and served once everything else exists.
    webServer = createServer();
    await new Promise<void>((resolve) => webServer.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(webServer.address() as AddressInfo).port}`;

    apiService = createApi({
      identity,
      mailer,
      ai,
      cloud,
      sealer: SEALER,
      verificationTtlMs: 15 * 60_000,
      pool: db.pool,
      settings: { ...loadServerSettings({ API_PUBLIC_BASE_URL: origin, API_TRUSTED_PROXY_HOPS: '1' }), anonymousRateLimit: 100_000 },
      logger: new Logger({ sink }),
    });
    apiServer = createServer(apiService.handler);
    await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
    const upstream = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    webServer.on('request', createWeb({ settings: loadWebSettings({ WEB_API_UPSTREAM: upstream }), assets: loadAssets(), logger: new Logger({ sink }) }).handler);
  });

  after(async () => {
    for (const server of [webServer, apiServer]) {
      if (server === undefined) continue;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    }
    await db?.drop();
  });

  /** One browser: a cookie jar, and the `Origin` header a browser adds to a state-changing request. */
  function browser(startingFragment = '') {
    const cookies = new Map<string, { value: string; path: string }>();
    let fragment = startingFragment;
    const navigated: { path: string; notice: string | undefined }[] = [];

    const api = new Api(async (path, init) => {
      const cookie = [...cookies.entries()]
        .filter(([, stored]) => path.startsWith(stored.path))
        .map(([name, stored]) => `${name}=${stored.value}`)
        .join('; ');
      const response = await fetch(`${origin}${path}`, {
        method: init.method,
        headers: { ...init.headers, ...(cookie === '' ? {} : { cookie }), ...(init.method === 'GET' ? {} : { origin }) },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
      for (const header of response.headers.getSetCookie()) {
        const [pair, ...attributes] = header.split('; ');
        const separator = pair!.indexOf('=');
        const name = pair!.slice(0, separator);
        if (attributes.includes('Max-Age=0')) cookies.delete(name);
        else {
          const path = attributes.find((attribute) => attribute.startsWith('Path='))?.slice(5) ?? '/';
          cookies.set(name, { value: pair!.slice(separator + 1), path });
        }
      }
      return response;
    });

    const context: ScreenContext = {
      api,
      navigate: (path, notice) => navigated.push({ path, notice }),
      fragment: () => fragment,
      clearFragment: () => {
        fragment = '';
      },
    };

    return {
      api,
      navigated,
      setFragment: (value: string) => {
        fragment = value;
      },
      currentFragment: () => fragment,
      open: async (path: PagePath): Promise<Screen> => {
        const screen = SCREENS[path](context);
        await screen.load?.();
        return screen;
      },
    };
  }

  type Browser = ReturnType<typeof browser>;

  function nextEmail(): string {
    counter += 1;
    return `owner-${counter}-web@example.com`;
  }

  function linkFor(email: string): string {
    const mail = mailer.delivered.map((delivered) => decodeMail(delivered.raw)).filter((message) => message.to === email).at(-1);
    assert.ok(mail !== undefined, `no mail to ${email}`);
    const match = /#(token=\S+)/.exec(mail.body);
    assert.ok(match !== null);
    return match[1]!;
  }

  /** The whole path a new client walks, using only the screens. */
  async function onboard(businessName = 'Padaria Aurora'): Promise<{ page: Browser; email: string; tenantId: string }> {
    const email = nextEmail();
    const page = browser();
    const signup = await page.open('/signup');
    await signup.forms!.signup!({ businessName, email, password: PASSWORD });
    assert.match(signup.view().text, /Check your email/);
    await apiService.outbox.drain();

    page.setFragment(linkFor(email));
    const verify = await page.open('/verify-email');
    assert.match(verify.view().text, /Your email is confirmed/);
    assert.equal(page.currentFragment(), '', 'the token stays in the address bar');

    const login = await page.open('/login');
    await login.forms!.login!({ email, password: PASSWORD });
    assert.deepEqual(page.navigated.at(-1), { path: '/', notice: undefined });

    const session = await page.api.get<{ tenantId: string }>('/v1/session');
    return { page, email, tenantId: session.tenantId };
  }

  async function operator(): Promise<Browser> {
    counter += 1;
    const email = `ops-${counter}-web@example.com`;
    await identity.createOperator({ email, password: PASSWORD });
    const page = browser();
    const login = await page.open('/operator/login');
    await login.forms!.login!({ email, password: PASSWORD });
    assert.equal(page.navigated.at(-1)?.path, '/operator');
    return page;
  }

  async function gatewayMoves(tenantId: string, ...states: ConnectionState[]): Promise<void> {
    for (const state of states) {
      await withTenant(db.pool, tenantId, (tx) => transitionConnection(tx, state, { reason: state === 'error' ? 'authorization_revoked' : undefined }));
    }
  }

  async function makeReady(tenantId: string, page: Browser): Promise<void> {
    await gatewayMoves(tenantId, 'connecting', 'connected');
    const persona = await page.open('/persona');
    await persona.forms!.persona!({ botName: 'Aurora' });
  }

  /** A conversation as the gateway and worker leave it. */
  async function seedMessage(
    tenantId: string,
    customerId: string,
    message: { readonly type: 'text' | 'image' | 'audio'; readonly content: unknown; readonly understood?: string; readonly reply?: string },
  ): Promise<void> {
    counter += 1;
    const externalId = `wamid.web-${counter}`;
    await withTenant(db.pool, tenantId, async (tx) => {
      const inbound = await tx.query<{ id: string }>(
        `INSERT INTO inbound_messages (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at)
         VALUES (app.current_tenant_id(), $1, '4400000009', $2, $3, $3, $4::jsonb, now() - interval '1 minute')
         RETURNING id`,
        [externalId, customerId, message.type, JSON.stringify(message.content)],
      );
      if (message.understood !== undefined) {
        await tx.query(
          `INSERT INTO inbound_media_understandings (inbound_message_id, tenant_id, understood_text, failure, attempts)
           VALUES ($1, app.current_tenant_id(), $2, NULL, 1)`,
          [inbound.rows[0]!.id, message.understood],
        );
      }
      if (message.reply === undefined) return;
      const conversation = await tx.query<{ id: string }>(
        `INSERT INTO conversations (tenant_id, customer_id) VALUES (app.current_tenant_id(), $1)
         ON CONFLICT (tenant_id, customer_id) DO UPDATE SET customer_id = EXCLUDED.customer_id RETURNING id`,
        [customerId],
      );
      const conversationId = conversation.rows[0]!.id;
      const turn = await tx.query<{ id: string }>(
        `INSERT INTO conversation_turns (tenant_id, conversation_id, state, opened_at, closes_at, deadline_at, closed_at)
         VALUES (app.current_tenant_id(), $1, 'closed', now(), now(), now(), now()) RETURNING id`,
        [conversationId],
      );
      await tx.query(
        `INSERT INTO inbound_dispositions (inbound_message_id, tenant_id, conversation_id, turn_id, disposition)
         VALUES ($1, app.current_tenant_id(), $2, $3, 'aggregated')`,
        [inbound.rows[0]!.id, conversationId, turn.rows[0]!.id],
      );
      await tx.query(
        `INSERT INTO conversation_turn_outcomes (turn_id, tenant_id, conversation_id, outcome, message, delivery_state)
         VALUES ($1, app.current_tenant_id(), $2, 'reply', $3, 'pending')`,
        [turn.rows[0]!.id, conversationId, message.reply],
      );
    });
  }

  const areaPaths = (area: 'client' | 'operator'): PagePath[] =>
    (Object.keys(PAGES) as PagePath[]).filter((path) => PAGES[path] === area);

  // Getting in ---------------------------------------------------------------------

  specTest('client-signup-and-tenancy.md', 'AC3 a duplicate email is rejected with a clear reason', 'the signup form says the address is already registered', async () => {
    const { email } = await onboard();
    const again = browser();
    const signup = await again.open('/signup');
    const failure = await signup.forms!.signup!({ businessName: 'Second', email, password: PASSWORD }).catch((error: unknown) => error);
    assert.ok(failure instanceof ApiError);
    assert.match(failureMessages(failure)[0]!, /already registered/);
    assert.doesNotMatch(signup.view().text, /Check your email/);
  });

  specTest('client-signup-and-tenancy.md', 'AC6 verification makes the tenant accessible', 'a new client goes from the form to a session with no operator step', async () => {
    const { tenantId } = await onboard();
    assert.ok(tenantId.length > 0);
  });

  specTest('client-signup-and-tenancy.md', 'AC10 the account is identified as the owner', 'the account page says so', async () => {
    const { page } = await onboard();
    assert.match((await page.open('/account')).view().text, /<strong>owner<\/strong>/);
  });

  specTest('client-signup-and-tenancy.md', 'AC11 recovery returns the client to their tenant', 'forgot, mailed link, new password, and back into the same tenant', async () => {
    const { email, tenantId } = await onboard();
    const page = browser();
    const forgot = await page.open('/forgot-password');
    await forgot.forms!.forgot!({ email });
    assert.match(forgot.view().text, /reset link is on its way/);
    await apiService.outbox.drain();

    page.setFragment(linkFor(email));
    const reset = await page.open('/reset-password');
    assert.equal(page.currentFragment(), '');
    await assert.rejects(reset.forms!.reset!({ newPassword: NEW_PASSWORD, confirmation: 'different-thing-22' }), (error: ApiError) => /match/.test(failureMessages(error)[0]!));
    await reset.forms!.reset!({ newPassword: NEW_PASSWORD, confirmation: NEW_PASSWORD });
    assert.equal(page.navigated.at(-1)?.path, '/login');

    const login = await page.open('/login');
    await login.forms!.login!({ email, password: NEW_PASSWORD });
    assert.equal((await page.api.get<{ tenantId: string }>('/v1/session')).tenantId, tenantId);
  });

  unitTest('a used or invented link is explained, and offers a new one', async () => {
    const page = browser('token=not-a-real-token');
    const verify = await page.open('/verify-email');
    const view = verify.view().text;
    assert.match(view, /This link no longer works/);
    assert.match(view, /data-form="newLink"/);
  });

  unitTest('a wrong password gets one message for every cause', async () => {
    const page = browser();
    const login = await page.open('/login');
    await assert.rejects(login.forms!.login!({ email: nextEmail(), password: PASSWORD }), (error: ApiError) => /confirm your email/.test(failureMessages(error)[0]!));
  });

  unitTest('a foreign origin is refused through the forward, so the API still decides', async () => {
    const response = await fetch(`${origin}/v1/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.org' },
      body: '{"email":"a@example.com","password":"x"}',
    });
    assert.equal(response.status, 403);
  });

  unitTest('every signed-in page refuses a browser with no session', async () => {
    const page = browser();
    for (const path of areaPaths('client').filter((p) => SCREENS[p](contextless()).load !== undefined)) {
      await assert.rejects(page.open(path), (error: ApiError) => error.code === 'auth.failed', path);
    }
    await assert.rejects(page.open('/operator'), (error: ApiError) => error.code === 'auth.failed');
  });

  function contextless(): ScreenContext {
    return { api: new Api(() => Promise.reject(new Error('unused'))), navigate: () => undefined, fragment: () => '', clearFragment: () => undefined };
  }

  // Every page renders ---------------------------------------------------------------

  unitTest('every client page renders for a brand-new tenant', async () => {
    const { page } = await onboard();
    for (const path of areaPaths('client')) {
      const text = (await page.open(path)).view().text;
      assert.ok(text.includes('<h1>'), path);
      assert.doesNotMatch(text, /undefined|\[object Object\]|NaN/, path);
    }
  });

  unitTest('every operator page renders', async () => {
    await onboard();
    const page = await operator();
    for (const path of areaPaths('operator')) {
      const text = (await page.open(path)).view().text;
      assert.ok(text.includes('<h1>'), path);
      assert.doesNotMatch(text, /undefined|\[object Object\]|NaN/, path);
    }
  });

  // Status and going live ------------------------------------------------------------

  specTest('bot-activation-control.md', 'AC10 a not-ready client sees what is unmet', 'the overview lists each condition with where to fix it, and go-live is disabled', async () => {
    const { page } = await onboard();
    const view = (await page.open('/')).view().text;
    assert.match(view, /Not ready/);
    assert.match(view, /href="\/whatsapp"/);
    assert.match(view, /href="\/persona"/);
    assert.match(view, /data-active="true"\s+disabled/);
  });

  specTest('bot-activation-control.md', 'AC3 a ready client may go live', 'the overview enables go-live and the click turns the bot on', async () => {
    const { page, tenantId } = await onboard();
    await makeReady(tenantId, page);
    const screen = await page.open('/');
    assert.match(screen.view().text, /Ready/);
    assert.doesNotMatch(screen.view().text, /data-active="true"\s+disabled/);
    await screen.actions!.setActive!({ active: 'true' });
    assert.match(screen.view().text, /Turn bot off/);
    assert.match(screen.view().text, /Turned on/);
  });

  specTest('bot-activation-control.md', 'AC11 the client always sees readiness and activation', 'both are on the overview in every state', async () => {
    const { page } = await onboard();
    const view = (await page.open('/')).view().text;
    assert.match(view, /Readiness/);
    assert.match(view, /<span class="label">Bot<\/span>/);
  });

  specTest('business-knowledge-configuration.md', 'AC10 unconfigured knowledge is recommended, not required', 'the overview recommends it and says it is optional', async () => {
    const { page } = await onboard();
    const view = (await page.open('/')).view().text;
    assert.match(view, /Recommended/);
    assert.match(view, /Optional/);
  });

  // WhatsApp -------------------------------------------------------------------------

  function metaAccount(): { phoneNumberId: string; businessAccountId: string; accessToken: string } {
    counter += 1;
    const phoneNumberId = String(15560000000 + counter);
    const businessAccountId = String(20230000000 + counter);
    const accessToken = ['EAA', `web${counter}`, 'cccccccccccccccccccccccc'].join('');
    cloud.backend.register({ token: accessToken, phoneNumberId, businessAccountId, appId: APP_ID, displayNumber: '+55 11 5555-0100', verifiedName: 'Padaria Aurora' });
    return { phoneNumberId, businessAccountId, accessToken };
  }

  specTest('whatsapp-number-connection.md', 'AC1 the client sees the connection complete', 'credentials, code, reply, and the page updates by polling to connected', async () => {
    const { page, tenantId } = await onboard();
    const account = metaAccount();
    const screen = await page.open('/whatsapp');
    assert.match(screen.view().text, /Disconnected/);
    assert.match(screen.view().text, /data-form="credentials"/);

    await screen.forms!.credentials!(account);
    assert.match(screen.view().text, /Connecting/);
    assert.match(screen.view().text, /data-form="verification"/);

    const recipient = '5511555509999';
    await screen.forms!.verification!({ recipient });
    assert.match(screen.view().text, /Waiting for your reply/);
    assert.equal(screen.pollAfterMs!(), 4_000, 'a client waiting on their phone needs a quick update');

    const code = /\b(\d{6})\b/.exec(cloud.backend.sends.at(-1)!.body)![1]!;
    await withTenant(db.pool, tenantId, (tx) => consumeVerificationReply(tx, { customerId: recipient, text: code, externalId: 'wamid.web.reply' }));

    await screen.poll!();
    const connected = screen.view().text;
    assert.match(connected, /Connected/);
    assert.match(connected, /data-action="startReplace"/);
  });

  specTest('credential-and-secret-handling.md', 'AC6 a client sees a credential is configured, never its value', 'the token is not on the page after it is saved', async () => {
    const { page } = await onboard();
    const account = metaAccount();
    const screen = await page.open('/whatsapp');
    await screen.forms!.credentials!(account);
    const view = screen.view().text;
    assert.match(view, /Access token<\/dt><dd>Configured/);
    assert.ok(!view.includes(account.accessToken));
  });

  specTest('whatsapp-number-connection.md', 'AC12 an error state displays its reason', 'the description the API gives is on the page', async () => {
    const { page, tenantId } = await onboard();
    await gatewayMoves(tenantId, 'connecting', 'error');
    const view = (await page.open('/whatsapp')).view().text;
    assert.match(view, /Error/);
    const connection = await page.api.get<{ error: { description: string } }>('/v1/whatsapp/connection');
    assert.ok(view.includes(connection.error.description.replaceAll("'", '&#39;')));
  });

  specTest('whatsapp-number-connection.md', 'AC4 reconnecting is visible to the client', 'the page says it is retrying automatically and offers no reconnect form', async () => {
    const { page, tenantId } = await onboard();
    await gatewayMoves(tenantId, 'connecting', 'connected', 'reconnecting');
    const view = (await page.open('/whatsapp')).view().text;
    assert.match(view, /Reconnecting/);
    assert.match(view, /retrying automatically/);
    assert.doesNotMatch(view, /data-form="credentials"/);
  });

  // Configuration --------------------------------------------------------------------

  specTest('persona-and-tone-configuration.md', 'AC1 an empty persona form with every structured field', 'a new client sees the name, formality, style, and freeform inputs', async () => {
    const { page } = await onboard();
    const view = (await page.open('/persona')).view().text;
    for (const name of ['botName', 'formality', 'styleTraits', 'freeformInstructions']) assert.match(view, new RegExp(`name="${name}"`));
    assert.match(view, /value="friendly"/, 'the option list comes from the API');
  });

  specTest('persona-and-tone-configuration.md', 'AC3 a save without the required field is refused', 'the failure names the bot name and the page keeps the old state', async () => {
    const { page } = await onboard();
    const screen = await page.open('/persona');
    const failure = await screen.forms!.persona!({ freeformInstructions: 'Be nice' }).catch((error: unknown) => error);
    assert.ok(failure instanceof ApiError);
    assert.match(failureMessages(failure).join(' '), /Bot name/);
  });

  specTest('persona-and-tone-configuration.md', 'AC10 a too-long name is refused and the limit communicated', 'the failure states the maximum', async () => {
    const { page } = await onboard();
    const screen = await page.open('/persona');
    const failure = await screen.forms!.persona!({ botName: 'x'.repeat(51) }).catch((error: unknown) => error);
    assert.match(failureMessages(failure).join(' '), /50/);
    assert.match(screen.view().text, /Up to 50 characters/);
  });

  specTest('persona-and-tone-configuration.md', 'AC4 what is saved is what reopening shows', 'name, formality, traits, and text all come back', async () => {
    const { page } = await onboard();
    const screen = await page.open('/persona');
    await screen.forms!.persona!({ botName: 'Aurora', formality: 'casual', styleTraits: ['friendly', 'witty'], freeformInstructions: 'Say olá.' });
    const view = (await page.open('/persona')).view().text;
    assert.match(view, /value="Aurora"/);
    assert.match(view, /value="casual" selected/);
    assert.match(view, /value="witty" checked/);
    assert.match(view, /Say olá\./);
    assert.doesNotMatch(view, /value="calm" checked/);
  });

  specTest('behavior-rules-configuration.md', 'AC15 the client sees every rule, its state, and the freeform text', 'add, disable, edit, and delete all show through', async () => {
    const { page } = await onboard();
    const screen = await page.open('/rules');
    assert.match(screen.view().text, /No rules yet/);
    await screen.forms!.add!({ kind: 'never', subject: 'discuss competitors', condition: '', action: 'respond' });
    await screen.forms!.freeform!({ freeformInstructions: 'Always sign off warmly.' });
    let view = screen.view().text;
    assert.match(view, /discuss competitors/);
    assert.match(view, /Enabled/);
    assert.match(view, /Always sign off warmly\./);

    const rule = (await page.api.get<{ rules: { id: string }[] }>('/v1/bot/behavior-rules')).rules[0]!;
    await screen.actions!.toggle!({ id: rule.id, enabled: 'false' });
    assert.match(screen.view().text, /Disabled/);

    screen.actions!.edit!({ id: rule.id });
    assert.match(screen.view().text, /data-form="edit"/);
    await screen.forms!.edit!({ id: rule.id, kind: 'avoid_topic', subject: 'politics', action: 'respond' });
    view = screen.view().text;
    assert.match(view, /politics/);
    assert.doesNotMatch(view, /data-form="edit"/);

    await screen.actions!.remove!({ id: rule.id });
    assert.match(screen.view().text, /No rules yet/);
  });

  unitTest('a rule the API considers malformed is refused with its reason', async () => {
    const { page } = await onboard();
    const screen = await page.open('/rules');
    const failure = await screen.forms!.add!({ kind: 'only_when', subject: 'quote prices', action: 'respond' }).catch((error: unknown) => error);
    assert.match(failureMessages(failure).join(' '), /required when kind is only_when/);
  });

  specTest('business-knowledge-configuration.md', 'AC1 an empty knowledge section can be added to', 'a new client sees the empty state and a form', async () => {
    const { page } = await onboard();
    const view = (await page.open('/knowledge')).view().text;
    assert.match(view, /Nothing here yet/);
    assert.match(view, /data-form="add"/);
  });

  specTest('business-knowledge-configuration.md', 'AC2 a saved entry is confirmed and listed', 'add, edit, and remove', async () => {
    const { page } = await onboard();
    const screen = await page.open('/knowledge');
    assert.match((await screen.forms!.add!({ content: 'We deliver within 10km.' })) ?? '', /Saved/);
    assert.match(screen.view().text, /We deliver within 10km\./);
    const entry = (await page.api.get<{ entries: { id: string }[] }>('/v1/bot/knowledge')).entries[0]!;
    screen.actions!.edit!({ id: entry.id });
    await screen.forms!.edit!({ id: entry.id, content: 'We deliver within 15km.' });
    assert.match(screen.view().text, /15km/);
    await screen.actions!.remove!({ id: entry.id });
    assert.match(screen.view().text, /Nothing here yet/);
  });

  specTest('fallback-response-behavior.md', 'AC12 preview shows exactly what would be sent, saved or not', 'an unsaved draft and the platform default both appear', async () => {
    const { page } = await onboard();
    const screen = await page.open('/fallback');
    assert.match(screen.view().text, /Platform default/);
    await screen.forms!.fallback!({ intent: 'preview', sharedMessage: 'Back soon!' });
    assert.match(screen.view().text, /Back soon!/);
    assert.match(screen.view().text, /would receive/);
    assert.equal((await page.api.get<{ sharedMessage: string | null }>('/v1/bot/fallback-messages')).sharedMessage, null, 'a preview must not save');
    await screen.forms!.fallback!({ intent: 'save', 'trigger:out_of_scope': 'Only cake questions.' });
    assert.match(screen.view().text, /Only cake questions\./);
    assert.match(screen.view().text, /Your message for this case/);
  });

  specTest('bot-disclosure-setting.md', 'AC9 the active mode is displayed accurately', 'the default, then the choice', async () => {
    const { page } = await onboard();
    const screen = await page.open('/disclosure');
    assert.match(screen.view().text, /platform default/);
    assert.match(screen.view().text, /value="disclose" checked/);
    await screen.forms!.disclosure!({ mode: 'do_not_disclose' });
    assert.match(screen.view().text, /value="do_not_disclose" checked/);
    assert.doesNotMatch(screen.view().text, /platform default/);
  });

  specTest('human-handoff.md', 'AC1 handoff can be enabled and triggers chosen', 'a saved configuration comes back, conditions one per line', async () => {
    const { page } = await onboard();
    const screen = await page.open('/handoff');
    await screen.forms!.handoff!({ enabled: 'on', triggers: ['complaint'], customConditions: 'Wants a refund\n\nAsks about catering' });
    const view = (await page.open('/handoff')).view().text;
    assert.match(view, /name="enabled"\s+checked/);
    assert.match(view, /value="complaint" checked/);
    assert.doesNotMatch(view, /value="human_request" checked/);
    assert.match(view, /Wants a refund\nAsks about catering/);
  });

  specTest('behavior-rules-configuration.md', 'AC16 the preview applies the real constraints', 'a reply, a handoff, and a fallback each read as what they are', async () => {
    const { page } = await onboard();
    const screen = await page.open('/preview');

    ai.backend.script({ kind: 'text', text: '[reply]\nOur cakes are lovely.' });
    await screen.forms!.preview!({ message: 'Hello?' });
    assert.match(screen.view().text, /Our cakes are lovely\./);
    assert.match(screen.view().text, /Hello\?/);

    ai.backend.script({ kind: 'text', text: '[fallback] out_of_scope' });
    await screen.forms!.preview!({ message: 'Who should I vote for?' });
    assert.match(screen.view().text, /A fallback message/);
  });

  // Conversations --------------------------------------------------------------------

  specTest('client-conversation-visibility.md', 'AC1 the client sees each of their conversations', 'the list shows every customer and no other tenant\'s', async () => {
    const alpha = await onboard();
    const beta = await onboard();
    await seedMessage(alpha.tenantId, '15550001111', { type: 'text', content: { text: 'hi' } });
    await seedMessage(beta.tenantId, '15550002222', { type: 'text', content: { text: 'hi' } });
    const view = (await alpha.page.open('/conversations')).view().text;
    assert.match(view, /\+15550001111/);
    assert.doesNotMatch(view, /15550002222/);
  });

  specTest('client-conversation-visibility.md', 'AC2 the transcript attributes every message', 'customer and bot entries appear in order, and hostile text is inert', async () => {
    const { page, tenantId } = await onboard();
    const customer = '15550003333';
    await seedMessage(tenantId, customer, { type: 'text', content: { text: `Hello ${HOSTILE}` }, reply: 'Hi there!' });
    const screen = await page.open('/conversations');
    await screen.actions!.open!({ customer });
    const view = screen.view().text;
    assert.ok(view.indexOf('bubble customer') < view.indexOf('bubble bot'));
    assert.match(view, /Hi there!/);
    assert.ok(!view.includes('<img'), 'text from the public reached the page as markup');
    assert.ok(view.includes('&lt;img'));
    assert.match(view, /Sending/, 'an answer not yet delivered must not look delivered');
  });

  specTest('client-conversation-visibility.md', 'AC3 new messages appear while the transcript is open', 'polling brings in the new message without losing the old', async () => {
    const { page, tenantId } = await onboard();
    const customer = '15550004444';
    await seedMessage(tenantId, customer, { type: 'text', content: { text: 'first message' } });
    const screen = await page.open('/conversations');
    await screen.actions!.open!({ customer });
    assert.ok(screen.pollAfterMs!() !== undefined);
    await seedMessage(tenantId, customer, { type: 'text', content: { text: 'second message' } });
    await screen.poll!();
    const view = screen.view().text;
    assert.match(view, /first message/);
    assert.match(view, /second message/);
  });

  specTest('client-conversation-visibility.md', 'AC4 a voice message shows what it said', 'the transcription is on the page', async () => {
    const { page, tenantId } = await onboard();
    const customer = '15550005555';
    await seedMessage(tenantId, customer, { type: 'audio', content: { mediaId: '7', mimeType: 'audio/ogg', voice: true }, understood: 'I want to change my booking' });
    const screen = await page.open('/conversations');
    await screen.actions!.open!({ customer });
    assert.match(screen.view().text, /Voice message/);
    assert.match(screen.view().text, /I want to change my booking/);
  });

  specTest('client-conversation-visibility.md', 'AC5 an image shows what the bot understood', 'the understanding and the caption are on the page', async () => {
    const { page, tenantId } = await onboard();
    const customer = '15550006666';
    await seedMessage(tenantId, customer, { type: 'image', content: { mediaId: '8', mimeType: 'image/jpeg', caption: 'is this fixable?' }, understood: 'A red bicycle with a flat tyre' });
    const screen = await page.open('/conversations');
    await screen.actions!.open!({ customer });
    assert.match(screen.view().text, /is this fixable\?/);
    assert.match(screen.view().text, /A red bicycle with a flat tyre/);
  });

  specTest('client-conversation-visibility.md', 'AC7 a paused conversation shows its status and reason', 'the reason is shown and resume returns it to the bot', async () => {
    const { page, tenantId } = await onboard();
    const customer = '15550007777';
    await seedMessage(tenantId, customer, { type: 'text', content: { text: 'I want a human' } });
    await withTenant(db.pool, tenantId, (tx) =>
      tx.query(
        `INSERT INTO conversations (tenant_id, customer_id, handoff_paused_at, handoff_reason)
         VALUES (app.current_tenant_id(), $1, now(), '{"kind":"trigger","trigger":"human_request"}'::jsonb)`,
        [customer],
      ),
    );
    const list = await page.open('/conversations');
    assert.match(list.view().text, /Waiting for you/);
    await list.actions!.open!({ customer });
    assert.match(list.view().text, /Paused for handoff/);
    assert.match(list.view().text, /The customer asked for a person/);
    await list.actions!.resume!({});
    assert.match(list.view().text, /Bot handling/);
    assert.doesNotMatch(list.view().text, /data-action="resume"/);
  });

  unitTest('searching narrows the list, and nothing about a customer goes in an address', async () => {
    const { page, tenantId } = await onboard();
    await seedMessage(tenantId, '15550008888', { type: 'text', content: { text: 'a' } });
    await seedMessage(tenantId, '15550009999', { type: 'text', content: { text: 'b' } });
    const screen = await page.open('/conversations');
    await screen.forms!.filter!({ customer: '8888' });
    const view = screen.view().text;
    assert.match(view, /15550008888/);
    assert.doesNotMatch(view, /15550009999/);
    assert.doesNotMatch(view, /href="[^"]*1555/);
  });

  // The operator ---------------------------------------------------------------------

  specTest('operator-health-monitoring.md', 'AC1 the dashboard lists every tenant with its state', 'each tenant appears', async () => {
    const alpha = await onboard('Alpha Bakery');
    await gatewayMoves(alpha.tenantId, 'connecting', 'error');
    const page = await operator();
    const view = (await page.open('/operator')).view().text;
    assert.match(view, /Alpha Bakery/);
    assert.match(view, /pill bad">Error/);
  });

  specTest('operator-health-monitoring.md', 'AC2 a change reaches the page without a reload', 'a poll after a state change redraws from fresh data', async () => {
    const { tenantId } = await onboard('Polled Bakery');
    await gatewayMoves(tenantId, 'connecting', 'connected');
    const page = await operator();
    const screen = await page.open('/operator');
    await screen.forms!.controls!({ window: '24h', connection: '', sortBy: 'connectionState', sortDirection: 'asc' });
    assert.ok(screen.pollAfterMs!() !== undefined);
    const row = (text: string): string => text.split('<tr>').find((part) => part.includes('Polled Bakery'))!;
    assert.match(row(screen.view().text), /Connected/);
    await gatewayMoves(tenantId, 'error');
    await screen.poll!();
    assert.match(row(screen.view().text), /pill bad">Error/);
  });

  specTest('operator-health-monitoring.md', 'AC3 a tenant detail shows the error reason', 'and its history', async () => {
    const { tenantId } = await onboard('Broken Bakery');
    await gatewayMoves(tenantId, 'connecting', 'error');
    const page = await operator();
    const screen = await page.open('/operator');
    await screen.actions!.open!({ tenant: tenantId });
    const view = screen.view().text;
    assert.match(view, /Broken Bakery/);
    assert.match(view, /authorization_revoked/);
    assert.match(view, /connecting → <strong>error/);
  });

  specTest('operator-health-monitoring.md', 'AC5 filtering by not connected', 'connected tenants drop out', async () => {
    const good = await onboard('Good Connected');
    await gatewayMoves(good.tenantId, 'connecting', 'connected');
    const bad = await onboard('Bad Disconnected');
    const page = await operator();
    const screen = await page.open('/operator');
    await screen.forms!.controls!({ window: '24h', connection: 'not_connected', sortBy: 'businessName', sortDirection: 'asc' });
    const view = screen.view().text;
    assert.match(view, /Bad Disconnected/);
    assert.doesNotMatch(view, /Good Connected/);
    assert.ok(bad.tenantId.length > 0);
  });

  specTest('operator-health-monitoring.md', 'AC8 outside retention is reported as unavailable', 'not zeros', async () => {
    await onboard('Old Period');
    const page = await operator();
    const screen = await page.open('/operator');
    await screen.forms!.controls!({ window: 'custom', from: '2020-01-01', to: '2020-02-01', connection: '', sortBy: 'businessName', sortDirection: 'asc' });
    const view = screen.view().text;
    assert.match(view, /unavailable/i);
    assert.match(view, /Unavailable/);
  });

  specTest('operator-health-monitoring.md', 'AC11 a quiet tenant shows no activity', 'rather than being left out or failing', async () => {
    await onboard('Quiet Bakery');
    const page = await operator();
    const view = (await page.open('/operator')).view().text;
    const row = view.split('<tr>').find((part) => part.includes('Quiet Bakery'))!;
    assert.match(row, /No activity/);
  });

  specTest('bot-activation-control.md', 'AC12 the operator sees activation and cannot change it', 'the detail shows both and offers no control', async () => {
    const { tenantId } = await onboard('Readonly Bakery');
    const page = await operator();
    const screen = await page.open('/operator');
    await screen.actions!.open!({ tenant: tenantId });
    const view = screen.view().text;
    assert.match(view, /Readiness/);
    assert.match(view, /<span class="label">Bot<\/span>/);
    assert.doesNotMatch(view, /setActive/);
  });

  specTest('operator-health-monitoring.md', 'AC9 no conversation content on any operator screen', 'a tenant with a stored message shows none of it, on the list or the detail', async () => {
    const { tenantId } = await onboard('Private Bakery');
    await seedMessage(tenantId, '15550001234', { type: 'text', content: { text: CONTENT_NEEDLE }, reply: CONTENT_NEEDLE });
    const page = await operator();
    const screen = await page.open('/operator');
    assert.ok(!screen.view().text.includes(CONTENT_NEEDLE));
    await screen.actions!.open!({ tenant: tenantId });
    const view = screen.view().text;
    assert.ok(!view.includes(CONTENT_NEEDLE));
    assert.ok(!view.includes('15550001234'), 'a customer number reached an operator screen');
  });

  specTest('tenant-data-isolation.md', 'AC7 the operator has no way to a transcript', 'the operator session is refused by the conversation routes', async () => {
    const page = await operator();
    await assert.rejects(page.api.post('/v1/conversations/list', {}), (error: ApiError) => error.code === 'auth.failed');
  });

  specTest('authentication-and-access.md', 'AC14 the operator sees health across all tenants', 'once signed in, and not before', async () => {
    const anonymous = browser();
    await assert.rejects(anonymous.open('/operator'), (error: ApiError) => error.code === 'auth.failed');
    await onboard('Visible Bakery');
    const page = await operator();
    assert.match((await page.open('/operator')).view().text, /Visible Bakery/);
  });

  unitTest('changing a password sends the person back to sign in', async () => {
    const { page, email } = await onboard();
    const screen = await page.open('/account');
    await screen.forms!.password!({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD });
    assert.equal(page.navigated.at(-1)?.path, '/login');
    await assert.rejects(page.api.get('/v1/session'), (error: ApiError) => error.code === 'auth.failed');
    const login = await page.open('/login');
    await login.forms!.login!({ email, password: NEW_PASSWORD });
  });
});
