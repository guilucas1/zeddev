/**
 * The API end to end: a real HTTP listener, a real PostgreSQL, and the mail that
 * carries each link.
 *
 * `@zeddev/identity`'s own suite already proves the rules — lockout, expiry,
 * single-use tokens, the tenant binding. What it cannot prove is that they
 * survive the trip through a transport, and that is where each of the following
 * would silently stop holding:
 *
 * - **AC3/AC9 indistinguishability** holds in the domain by construction and can
 *   be undone here by a status code, a header, or a body that differs.
 * - **"Controlled by the signer"** (`client-signup-and-tenancy.md`) is only true if
 *   the verification token reaches the mailbox and *not* the response. So every
 *   token these tests redeem is read out of a delivered message — never from a
 *   return value, which would prove the API handed the link to the submitter.
 * - **AC21/AC22** — each principal type's token refused at the other's surface —
 *   is tested by presenting the real token in the other cookie, which is the
 *   only form of the attack a browser can actually mount.
 *
 * One test at the end runs the signup loop through a real SMTP server, so the
 * link a client clicks is the one an independent mail server delivered.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider, type ObservedGeneration } from '@zeddev/ai/testing';
import { withTenant } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { IdentityService, TOKEN_PREFIXES, type IdentityPolicy, type TenantProvisioning } from '@zeddev/identity';
import { Logger, MemorySink } from '@zeddev/logging';
import { SmtpMailer, type Mailer } from '@zeddev/mail';
import {
  createTestMailbox,
  decodeMail,
  InMemoryMailer,
  mailTestConfigured,
  SKIP_REASON as MAIL_SKIP_REASON,
} from '@zeddev/mail/testing';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { transitionConnection, type ConnectionState } from '@zeddev/whatsapp';
import { CLIENT_SESSION_COOKIE, createApi, OPERATOR_SESSION_COOKIE, type Api } from './app.ts';
import { loadServerSettings, type ApiSettings } from './config.ts';

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;
const PUBLIC_BASE = 'https://app.example.com';

const POLICY: IdentityPolicy = {
  sessionInactivityMs: 60_000,
  sessionAbsoluteLifetimeMs: 120_000,
  maxFailedAttempts: 5,
  lockoutMs: 30_000,
  emailVerificationTtlMs: 60_000,
  passwordResetTtlMs: 60_000,
  minPasswordLength: 12,
};

const PASSWORD = 'meadow-granite-vessel-8';
const NEW_PASSWORD = 'harbour-thistle-copper-4';

function settingsWith(overrides: Partial<ApiSettings> = {}): ApiSettings {
  return {
    ...loadServerSettings({ API_PUBLIC_BASE_URL: PUBLIC_BASE }),
    // High enough that only the throttle's own test ever meets it.
    anonymousRateLimit: 100_000,
    ...overrides,
  };
}

interface Served {
  readonly url: string;
  readonly server: Server;
  close(): Promise<void>;
}

async function serve(api: Api): Promise<Served> {
  const server = createServer(api.handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

interface Answer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: any;
  readonly text: string;
  readonly cookies: readonly string[];
}

async function call(
  served: Served,
  method: string,
  path: string,
  options: {
    readonly json?: unknown;
    readonly cookie?: string | undefined;
    readonly headers?: Record<string, string>;
    readonly rawBody?: string;
  } = {},
): Promise<Answer> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] ??= 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.rawBody !== undefined) {
    body = options.rawBody;
  }
  if (options.cookie !== undefined) headers.cookie = options.cookie;
  const response = await fetch(`${served.url}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === '' ? undefined : JSON.parse(text),
    text,
    cookies: response.headers.getSetCookie(),
  };
}

/** The value of `name` among a response's Set-Cookie headers. */
function cookieValue(answer: Answer, name: string): string | undefined {
  for (const header of answer.cookies) {
    const match = new RegExp(`^${name}=([^;]*)`).exec(header);
    if (match !== null) return match[1];
  }
  return undefined;
}

/** A reply with its per-request identifier removed, for comparing two replies byte for byte. */
function withoutRequestId(answer: Answer): unknown {
  const headers = Object.fromEntries(
    [...answer.headers.entries()].filter(([name]) => !['x-request-id', 'date', 'content-length'].includes(name)),
  );
  const body = answer.body?.error === undefined ? answer.body : { error: { ...answer.body.error, requestId: 'x' } };
  return { status: answer.status, headers, body };
}

/** The token in the most recent link delivered to `to`. */
function tokenFromMailbox(mailer: InMemoryMailer, to: string): string {
  const messages = mailer.delivered.map((delivered) => decodeMail(delivered.raw)).filter((mail) => mail.to === to);
  const latest = messages.at(-1);
  assert.ok(latest !== undefined, `no mail was delivered to ${to}`);
  const match = /#token=(\S+)/.exec(latest.body);
  assert.ok(match !== null, 'the delivered message carries no link');
  return decodeURIComponent(match[1]!);
}

describe('api service', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let identity: IdentityService;
  let mailer: InMemoryMailer;
  let sink: MemorySink;
  let ai: InMemoryAiProvider;
  let api: Api;
  let served: Served;
  let counter = 0;
  const extra: Served[] = [];

  function nextEmail(): string {
    counter += 1;
    return `owner-${counter}-api@example.com`;
  }

  function apiWith(options: {
    readonly settings?: Partial<ApiSettings>;
    readonly identity?: IdentityService;
    readonly mailer?: Mailer;
    readonly ai?: InMemoryAiProvider;
  } = {}): Api {
    return createApi({
      identity: options.identity ?? identity,
      mailer: options.mailer ?? mailer,
      ai: options.ai ?? ai,
      pool: db.pool,
      settings: settingsWith(options.settings),
      logger: new Logger({ sink }),
    });
  }

  async function signUp(email: string, target: Served = served, targetApi: Api = api): Promise<Answer> {
    const answer = await call(target, 'POST', '/v1/signup', {
      json: { businessName: `Bakery ${email}`, email, password: PASSWORD },
    });
    await targetApi.outbox.drain();
    return answer;
  }

  /** Sign up, verify through the mailed link, log in. Returns the session cookie header value. */
  async function onboard(email: string = nextEmail()): Promise<{ email: string; cookie: string; tenantId: string }> {
    assert.equal((await signUp(email)).status, 201);
    const verified = await call(served, 'POST', '/v1/email-verification', {
      json: { token: tokenFromMailbox(mailer, email) },
    });
    assert.equal(verified.status, 200);
    const login = await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } });
    assert.equal(login.status, 200);
    const cookie = `${CLIENT_SESSION_COOKIE}=${cookieValue(login, CLIENT_SESSION_COOKIE)}`;
    const session = await call(served, 'GET', '/v1/session', { cookie });
    return { email, cookie, tenantId: session.body.tenantId };
  }

  before(async () => {
    db = await createTestDatabase('api');
    await migrateToLatest(db.pool);
    sink = new MemorySink();
    mailer = new InMemoryMailer();
    ai = new InMemoryAiProvider();
    identity = new IdentityService({
      pool: db.pool,
      policy: POLICY,
      credentialParams: FAST_SCRYPT,
      logger: new Logger({ sink }),
    });
    api = apiWith();
    served = await serve(api);
  });

  after(async () => {
    for (const server of extra) await server.close();
    await served?.close();
    await db?.drop();
  });

  // -------------------------------------------------------------------------
  // Signup and verification
  // -------------------------------------------------------------------------

  specTest(
    'client-signup-and-tenancy.md',
    'AC6 the signup email is verified as controlled by the signer',
    'the verification link goes to the mailbox and never into the response',
    async () => {
      const email = nextEmail();
      const answer = await signUp(email);
      assert.equal(answer.status, 201);
      assert.deepEqual(answer.body, { status: 'verification_pending' });
      for (const prefix of Object.values(TOKEN_PREFIXES)) {
        assert.ok(!answer.text.includes(prefix), 'a token appeared in the signup response');
      }
      assert.deepEqual(answer.cookies, []);

      const token = tokenFromMailbox(mailer, email);
      const mail = decodeMail(mailer.delivered.at(-1)!.raw);
      assert.match(mail.body, new RegExp(`^${PUBLIC_BASE}/verify-email#token=`, 'm'));
      assert.equal(new URL(/(https:\S+)/.exec(mail.body)![1]!).search, '', 'the token must not travel in a query string');
      assert.ok(token.length > 20);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC2 an unverified client is denied a usable tenant',
    'logging in before redeeming the mailed link is refused, and succeeds after',
    async () => {
      const email = nextEmail();
      await signUp(email);
      const early = await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } });
      assert.equal(early.status, 401);
      assert.deepEqual(early.cookies, []);

      const verified = await call(served, 'POST', '/v1/email-verification', {
        json: { token: tokenFromMailbox(mailer, email) },
      });
      assert.equal(verified.status, 200);
      const later = await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } });
      assert.equal(later.status, 200);
      assert.ok(cookieValue(later, CLIENT_SESSION_COOKIE)?.startsWith(TOKEN_PREFIXES.client_session));
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC3 duplicate email rejected with a clear reason',
    'a second signup for the same address is a 409 naming the reason',
    async () => {
      const email = nextEmail();
      assert.equal((await signUp(email)).status, 201);
      const again = await signUp(email.toUpperCase());
      assert.equal(again.status, 409);
      assert.equal(again.body.error.code, 'identity.email_in_use');
      assert.match(again.body.error.message, /already registered/);
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC4 credential below the strength standard is rejected',
    'a weak password is a 400 that names the field and never echoes the value',
    async () => {
      const email = nextEmail();
      const answer = await call(served, 'POST', '/v1/signup', {
        json: { businessName: 'Weak Co', email, password: 'short' },
      });
      assert.equal(answer.status, 400);
      assert.equal(answer.body.error.code, 'validation.failed');
      assert.ok(answer.body.error.issues.some((issue: { key: string }) => issue.key === 'password'));
      assert.doesNotMatch(answer.text, /short"/);
      // Nothing was created, so the address is still free.
      assert.equal((await signUp(email)).status, 201);
    },
  );

  unitTest('every missing field is reported at once', async () => {
    const answer = await call(served, 'POST', '/v1/signup', { json: { email: 7 } });
    assert.equal(answer.status, 400);
    assert.deepEqual(
      answer.body.error.issues.map((issue: { key: string }) => issue.key),
      ['businessName', 'email', 'password'],
    );
  });

  specTest(
    'authentication-and-access.md',
    'AC10 a used recovery link is rejected',
    'a verification link works once, and the second attempt says why',
    async () => {
      const email = nextEmail();
      await signUp(email);
      const token = tokenFromMailbox(mailer, email);
      assert.equal((await call(served, 'POST', '/v1/email-verification', { json: { token } })).status, 200);
      const reused = await call(served, 'POST', '/v1/email-verification', { json: { token } });
      assert.equal(reused.status, 400);
      assert.deepEqual(reused.body.error.issues, [{ key: 'token', reason: 'has already been used' }]);
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC6 the signup email is verified as controlled by the signer',
    'a verification resend answers identically for a pending, a verified, and an unknown address',
    async () => {
      const pending = nextEmail();
      await signUp(pending);
      const { email: verified } = await onboard();
      const unknown = nextEmail();
      const before = mailer.delivered.length;

      const answers = [];
      for (const email of [pending, verified, unknown]) {
        answers.push(await call(served, 'POST', '/v1/email-verification/requests', { json: { email } }));
      }
      await api.outbox.drain();

      for (const answer of answers) assert.deepEqual(withoutRequestId(answer), withoutRequestId(answers[0]!));
      assert.equal(answers[0]!.status, 202);
      // Only the pending address had anything to send.
      assert.equal(mailer.delivered.length, before + 1);
      assert.equal(decodeMail(mailer.delivered.at(-1)!.raw).to, pending);
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC7 provisioning failure leaves a visible error state',
    'a provisioning failure during verification is reported as such, and the same link can be retried',
    async () => {
      let fail = true;
      const provisionTenant: TenantProvisioning = async () => {
        if (fail) throw new Error('knowledge index unavailable');
      };
      const failing = new IdentityService({
        pool: db.pool,
        policy: POLICY,
        credentialParams: FAST_SCRYPT,
        provisionTenant,
        logger: new Logger({ sink }),
      });
      const failingApi = apiWith({ identity: failing });
      const failingServed = await serve(failingApi);
      extra.push(failingServed);

      const email = nextEmail();
      await signUp(email, failingServed, failingApi);
      const token = tokenFromMailbox(mailer, email);
      const answer = await call(failingServed, 'POST', '/v1/email-verification', { json: { token } });
      assert.equal(answer.status, 500);
      assert.equal(answer.body.error.code, 'signup.provisioning_failed');
      assert.doesNotMatch(answer.text, /knowledge index/);
      assert.equal((await call(failingServed, 'POST', '/v1/session', { json: { email, password: PASSWORD } })).status, 401);

      fail = false;
      assert.equal((await call(failingServed, 'POST', '/v1/email-verification', { json: { token } })).status, 200);
      assert.equal((await call(failingServed, 'POST', '/v1/session', { json: { email, password: PASSWORD } })).status, 200);
    },
  );

  // -------------------------------------------------------------------------
  // Client sessions
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC3 failed login indistinguishable for known and unknown email',
    'a wrong password and an unknown address produce the same status, headers, and body',
    async () => {
      const { email } = await onboard();
      const wrong = await call(served, 'POST', '/v1/session', { json: { email, password: 'not-the-password-1' } });
      const unknown = await call(served, 'POST', '/v1/session', {
        json: { email: nextEmail(), password: 'not-the-password-1' },
      });
      assert.equal(wrong.status, 401);
      assert.deepEqual(withoutRequestId(wrong), withoutRequestId(unknown));
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC4 the tenant is the one bound to the session',
    'a tenant identifier supplied by the caller is ignored in favour of the session’s own',
    async () => {
      const a = await onboard();
      const b = await onboard();
      assert.notEqual(a.tenantId, b.tenantId);
      const answer = await call(served, 'GET', `/v1/session?tenantId=${b.tenantId}`, {
        cookie: a.cookie,
        headers: { 'x-tenant-id': b.tenantId },
      });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.tenantId, a.tenantId);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC7 logout ends the session everywhere',
    'after logout the same token is refused, and logout answers the same with or without a session',
    async () => {
      const { cookie } = await onboard();
      const out = await call(served, 'DELETE', '/v1/session', { cookie });
      assert.equal(out.status, 204);
      assert.equal(cookieValue(out, CLIENT_SESSION_COOKIE), '');
      assert.equal((await call(served, 'GET', '/v1/session', { cookie })).status, 401);

      const again = await call(served, 'DELETE', '/v1/session', { cookie });
      const none = await call(served, 'DELETE', '/v1/session');
      assert.deepEqual(withoutRequestId(again), withoutRequestId(none));
    },
  );

  unitTest('the session cookie is HttpOnly, SameSite=Strict, and Secure under an https public URL', async () => {
    const email = nextEmail();
    await signUp(email);
    await call(served, 'POST', '/v1/email-verification', { json: { token: tokenFromMailbox(mailer, email) } });
    const login = await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } });
    const header = login.cookies.find((cookie) => cookie.startsWith(`${CLIENT_SESSION_COOKIE}=`));
    assert.ok(header !== undefined);
    assert.match(header, /; Path=\/; HttpOnly; SameSite=Strict; Secure; Expires=/);
    // The token is in the cookie, not in the body a script could read.
    assert.doesNotMatch(login.text, new RegExp(cookieValue(login, CLIENT_SESSION_COOKIE)!));
  });

  specTest(
    'authentication-and-access.md',
    'AC8 a password change invalidates existing sessions',
    'changing the password ends the current session, and only the new password logs in',
    async () => {
      const { email, cookie } = await onboard();
      const changed = await call(served, 'POST', '/v1/account/password', {
        cookie,
        json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
      });
      assert.equal(changed.status, 204);
      assert.equal((await call(served, 'GET', '/v1/session', { cookie })).status, 401);
      assert.equal((await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } })).status, 401);
      assert.equal((await call(served, 'POST', '/v1/session', { json: { email, password: NEW_PASSWORD } })).status, 200);
    },
  );

  unitTest('a password change without a session is refused before the body is read', async () => {
    const answer = await call(served, 'POST', '/v1/account/password', {
      json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(answer.status, 401);
  });

  // -------------------------------------------------------------------------
  // Password recovery
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC9 recovery for an unregistered email does not reveal it',
    'a reset request answers identically for a registered and an unregistered address',
    async () => {
      const { email } = await onboard();
      const before = mailer.delivered.length;
      const known = await call(served, 'POST', '/v1/password-resets/requests', { json: { email } });
      const unknown = await call(served, 'POST', '/v1/password-resets/requests', { json: { email: nextEmail() } });
      await api.outbox.drain();

      assert.equal(known.status, 202);
      assert.deepEqual(withoutRequestId(known), withoutRequestId(unknown));
      assert.equal(mailer.delivered.length, before + 1, 'only the registered address receives mail');
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC11 recovery without operator involvement and without a second tenant',
    'a mailed reset link restores access to the same tenant and ends the old sessions',
    async () => {
      const { email, cookie, tenantId } = await onboard();
      await call(served, 'POST', '/v1/password-resets/requests', { json: { email } });
      await api.outbox.drain();
      const mail = decodeMail(mailer.delivered.at(-1)!.raw);
      assert.match(mail.body, new RegExp(`^${PUBLIC_BASE}/reset-password#token=`, 'm'));

      const token = tokenFromMailbox(mailer, email);
      const reset = await call(served, 'POST', '/v1/password-resets', { json: { token, newPassword: NEW_PASSWORD } });
      assert.equal(reset.status, 204);
      assert.equal(cookieValue(reset, CLIENT_SESSION_COOKIE), '');

      // AC8: the session held before the reset is gone.
      assert.equal((await call(served, 'GET', '/v1/session', { cookie })).status, 401);

      const login = await call(served, 'POST', '/v1/session', { json: { email, password: NEW_PASSWORD } });
      assert.equal(login.status, 200);
      const session = await call(served, 'GET', '/v1/session', {
        cookie: `${CLIENT_SESSION_COOKIE}=${cookieValue(login, CLIENT_SESSION_COOKIE)}`,
      });
      assert.equal(session.body.tenantId, tenantId);

      // AC10: the link worked once.
      const reused = await call(served, 'POST', '/v1/password-resets', { json: { token, newPassword: PASSWORD } });
      assert.equal(reused.status, 400);
    },
  );

  unitTest('a mail server failure changes nothing the requester can see', async () => {
    const { email } = await onboard();
    mailer.failNext(new Error('connection reset'));
    const failed = await call(served, 'POST', '/v1/password-resets/requests', { json: { email } });
    await api.outbox.drain();
    const unknown = await call(served, 'POST', '/v1/password-resets/requests', { json: { email: nextEmail() } });
    assert.deepEqual(withoutRequestId(failed), withoutRequestId(unknown));
    assert.match(sink.serialized(), /api\.mail\.failed/);
  });

  // -------------------------------------------------------------------------
  // The operator, and the boundary between the two identity spaces
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC13 an unauthenticated caller is denied operator surfaces',
    'the operator session surface refuses a caller with no credential',
    async () => {
      const answer = await call(served, 'GET', '/v1/operator/session');
      assert.equal(answer.status, 401);
      assert.deepEqual(Object.keys(answer.body), ['error']);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC21 a client credential is insufficient for operator access',
    'a valid client session token presented as the operator cookie is refused',
    async () => {
      const { cookie } = await onboard();
      const token = cookie.slice(cookie.indexOf('=') + 1);
      const answer = await call(served, 'GET', '/v1/operator/session', {
        cookie: `${OPERATOR_SESSION_COOKIE}=${token}`,
      });
      assert.equal(answer.status, 401);
      // And the client cookie itself is not read by an operator surface at all.
      assert.equal((await call(served, 'GET', '/v1/operator/session', { cookie })).status, 401);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC22 an operator credential is insufficient for client access',
    'a valid operator session token presented as the client cookie is refused',
    async () => {
      const email = `ops-${nextEmail()}`;
      await identity.createOperator({ email, password: PASSWORD });
      const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
      assert.equal(login.status, 200);
      const token = cookieValue(login, OPERATOR_SESSION_COOKIE)!;
      const operatorCookie = `${OPERATOR_SESSION_COOKIE}=${token}`;
      assert.equal((await call(served, 'GET', '/v1/operator/session', { cookie: operatorCookie })).status, 200);

      assert.equal((await call(served, 'GET', '/v1/session', { cookie: `${CLIENT_SESSION_COOKIE}=${token}` })).status, 401);
      assert.equal(
        (
          await call(served, 'POST', '/v1/account/password', {
            cookie: `${CLIENT_SESSION_COOKIE}=${token}`,
            json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
          })
        ).status,
        401,
      );
    },
  );

  unitTest('the operator cookie is scoped to operator routes, and operator logout ends the session', async () => {
    const email = `ops-${nextEmail()}`;
    await identity.createOperator({ email, password: PASSWORD });
    const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
    const header = login.cookies.find((cookie) => cookie.startsWith(`${OPERATOR_SESSION_COOKIE}=`));
    assert.match(header ?? '', /; Path=\/v1\/operator; HttpOnly; SameSite=Strict; Secure;/);

    const cookie = `${OPERATOR_SESSION_COOKIE}=${cookieValue(login, OPERATOR_SESSION_COOKIE)}`;
    const session = await call(served, 'GET', '/v1/operator/session', { cookie });
    assert.equal(session.body.principalType, 'operator');
    assert.equal((await call(served, 'DELETE', '/v1/operator/session', { cookie })).status, 204);
    assert.equal((await call(served, 'GET', '/v1/operator/session', { cookie })).status, 401);
  });

  unitTest('an operator password change ends the operator session', async () => {
    const email = `ops-${nextEmail()}`;
    await identity.createOperator({ email, password: PASSWORD });
    const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
    const cookie = `${OPERATOR_SESSION_COOKIE}=${cookieValue(login, OPERATOR_SESSION_COOKIE)}`;
    const changed = await call(served, 'POST', '/v1/operator/account/password', {
      cookie,
      json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    assert.equal(changed.status, 204);
    assert.equal((await call(served, 'GET', '/v1/operator/session', { cookie })).status, 401);
  });

  // -------------------------------------------------------------------------
  // Bot configuration: persona and tone
  // -------------------------------------------------------------------------

  specTest(
    'persona-and-tone-configuration.md',
    'AC1 a never-configured client sees the structured fields empty and an empty freeform input',
    'GET on a fresh tenant presents every field empty, with the options and the limits',
    async () => {
      const { cookie } = await onboard();
      const answer = await call(served, 'GET', '/v1/bot/persona', { cookie });
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body.persona, {
        botName: null,
        formality: null,
        styleTraits: [],
        freeformInstructions: null,
        updatedAt: null,
      });
      assert.equal(answer.body.complete, false);
      assert.deepEqual(answer.body.missing, ['botName']);
      assert.deepEqual(answer.body.options.formality, ['formal', 'neutral', 'casual']);
      assert.ok(answer.body.options.styleTraits.includes('friendly'));
      // The limits are communicated up front, not only on a refused save.
      assert.deepEqual(answer.body.limits, { botNameMaxLength: 50, freeformInstructionsMaxLength: 2000 });
    },
  );

  specTest(
    'persona-and-tone-configuration.md',
    'AC4 structured fields and freeform text are both kept and shown on reopening',
    'a PUT with both mechanisms is reflected by the next GET',
    async () => {
      const { cookie } = await onboard();
      const persona = {
        botName: 'Sunny',
        formality: 'casual',
        styleTraits: ['playful', 'friendly'],
        freeformInstructions: 'Recommend the croissant of the day.',
      };
      const saved = await call(served, 'PUT', '/v1/bot/persona', { cookie, json: persona });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.complete, true);

      const reopened = await call(served, 'GET', '/v1/bot/persona', { cookie });
      assert.equal(reopened.body.persona.botName, 'Sunny');
      assert.equal(reopened.body.persona.formality, 'casual');
      assert.deepEqual(reopened.body.persona.styleTraits, ['friendly', 'playful']);
      assert.equal(reopened.body.persona.freeformInstructions, 'Recommend the croissant of the day.');
      assert.equal(typeof reopened.body.persona.updatedAt, 'string');
      assert.deepEqual(reopened.body.missing, []);
    },
  );

  specTest(
    'persona-and-tone-configuration.md',
    'AC3 freeform text without the required name is rejected, naming the missing field',
    'a PUT without a bot name is a 400 naming botName, and nothing is saved',
    async () => {
      const { cookie } = await onboard();
      const refused = await call(served, 'PUT', '/v1/bot/persona', {
        cookie,
        json: { freeformInstructions: 'Be brief.' },
      });
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body.error.issues, [{ key: 'botName', reason: 'is required' }]);
      assert.equal((await call(served, 'GET', '/v1/bot/persona', { cookie })).body.complete, false);
    },
  );

  specTest(
    'persona-and-tone-configuration.md',
    'AC9 freeform text over the limit is rejected, communicating the limit',
    'an oversized freeform text is a 400 whose reason states the limit and does not echo the text',
    async () => {
      const { cookie } = await onboard();
      const text = 'Mention our sourdough. '.repeat(100);
      const refused = await call(served, 'PUT', '/v1/bot/persona', {
        cookie,
        json: { botName: 'Sunny', freeformInstructions: text },
      });
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body.error.issues, [
        { key: 'freeformInstructions', reason: 'must be at most 2000 characters' },
      ]);
      assert.doesNotMatch(refused.text, /sourdough/);
    },
  );

  specTest(
    'persona-and-tone-configuration.md',
    'AC6 clearing the freeform text keeps the configuration complete',
    'DELETE on the freeform text clears it alone and the persona stays complete',
    async () => {
      const { cookie } = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', {
        cookie,
        json: { botName: 'Leo', formality: 'formal', freeformInstructions: 'Offer gift wrapping.' },
      });
      const cleared = await call(served, 'DELETE', '/v1/bot/persona/freeform-instructions', { cookie });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.persona.freeformInstructions, null);
      assert.equal(cleared.body.persona.botName, 'Leo');
      assert.equal(cleared.body.persona.formality, 'formal');
      assert.equal(cleared.body.complete, true);
    },
  );

  specTest(
    'persona-and-tone-configuration.md',
    'AC8 each client’s end-customers only ever see that client’s own persona',
    'two clients configuring different personas each read back only their own',
    async () => {
      const alpha = await onboard();
      const beta = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', { cookie: alpha.cookie, json: { botName: 'Alpha Bot' } });
      await call(served, 'PUT', '/v1/bot/persona', {
        cookie: beta.cookie,
        json: { botName: 'Beta Bot', formality: 'casual' },
      });

      const seenByAlpha = await call(served, 'GET', '/v1/bot/persona', { cookie: alpha.cookie });
      const seenByBeta = await call(served, 'GET', '/v1/bot/persona', { cookie: beta.cookie });
      assert.equal(seenByAlpha.body.persona.botName, 'Alpha Bot');
      assert.equal(seenByAlpha.body.persona.formality, null);
      assert.equal(seenByBeta.body.persona.botName, 'Beta Bot');
      assert.doesNotMatch(seenByAlpha.text, /Beta Bot/);

      // A caller-supplied tenant is inert (authentication-and-access.md AC4).
      const smuggled = await call(served, 'PUT', `/v1/bot/persona?tenantId=${beta.tenantId}`, {
        cookie: alpha.cookie,
        json: { botName: 'Planted' },
      });
      assert.equal(smuggled.status, 200);
      const betaAfter = await call(served, 'GET', '/v1/bot/persona', { cookie: beta.cookie });
      assert.equal(betaAfter.body.persona.botName, 'Beta Bot');
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC22 an operator credential is insufficient for client access',
    'configuration routes refuse no session, an operator token in the client cookie, and a foreign origin',
    async () => {
      assert.equal((await call(served, 'GET', '/v1/bot/persona')).status, 401);
      assert.equal((await call(served, 'PUT', '/v1/bot/persona', { json: { botName: 'Anon' } })).status, 401);

      const email = `ops-${nextEmail()}`;
      await identity.createOperator({ email, password: PASSWORD });
      const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
      const asClientCookie = `${CLIENT_SESSION_COOKIE}=${cookieValue(login, OPERATOR_SESSION_COOKIE)}`;
      assert.equal((await call(served, 'GET', '/v1/bot/persona', { cookie: asClientCookie })).status, 401);
      assert.equal(
        (await call(served, 'PUT', '/v1/bot/persona', { cookie: asClientCookie, json: { botName: 'Ops' } })).status,
        401,
      );

      const { cookie } = await onboard();
      const forged = await call(served, 'PUT', '/v1/bot/persona', {
        cookie,
        headers: { origin: 'https://example.org' },
        json: { botName: 'Forged' },
      });
      assert.equal(forged.status, 403);
      assert.equal((await call(served, 'GET', '/v1/bot/persona', { cookie })).body.complete, false);
    },
  );

  // -------------------------------------------------------------------------
  // Bot configuration: behaviour rules
  // -------------------------------------------------------------------------

  specTest(
    'behavior-rules-configuration.md',
    'AC15 the client sees every structured rule with its enabled state and the current freeform text',
    'create, edit, disable, delete, and freeform text over HTTP, each visible on the next GET',
    async () => {
      const { cookie } = await onboard();
      const empty = await call(served, 'GET', '/v1/bot/behavior-rules', { cookie });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.rules, []);
      assert.equal(empty.body.freeformInstructions, null);
      assert.deepEqual(empty.body.options.kinds, ['never', 'always', 'only_when', 'avoid_topic']);
      assert.equal(empty.body.limits.maxRules, 100);

      const created = await call(served, 'POST', '/v1/bot/behavior-rules', {
        cookie,
        json: { kind: 'avoid_topic', subject: 'competitors', action: 'fallback' },
      });
      assert.equal(created.status, 201);
      const id = created.body.rule.id;
      assert.equal(created.body.rule.enabled, true);
      const second = await call(served, 'POST', '/v1/bot/behavior-rules', {
        cookie,
        json: { kind: 'never', subject: 'swear' },
      });
      assert.equal(second.status, 201);

      const edited = await call(served, 'PUT', '/v1/bot/behavior-rules/rule', {
        cookie,
        json: { id, kind: 'only_when', subject: 'discuss returns', condition: 'an order number was given' },
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.rule.condition, 'an order number was given');

      const disabled = await call(served, 'PUT', '/v1/bot/behavior-rules/rule/enabled', {
        cookie,
        json: { id, enabled: false },
      });
      assert.equal(disabled.status, 200);
      assert.equal(disabled.body.rule.enabled, false);

      const text = await call(served, 'PUT', '/v1/bot/behavior-rules/freeform-instructions', {
        cookie,
        json: { freeformInstructions: 'Never promise delivery dates.' },
      });
      assert.equal(text.status, 200);
      assert.equal(text.body.freeformInstructions, 'Never promise delivery dates.');

      const view = await call(served, 'GET', '/v1/bot/behavior-rules', { cookie });
      assert.deepEqual(
        view.body.rules.map((rule: { subject: string; enabled: boolean }) => [rule.subject, rule.enabled]),
        [
          ['discuss returns', false],
          ['swear', true],
        ],
      );
      assert.equal(view.body.freeformInstructions, 'Never promise delivery dates.');

      const deleted = await call(served, 'POST', '/v1/bot/behavior-rules/rule/delete', { cookie, json: { id } });
      assert.equal(deleted.status, 204);
      const cleared = await call(served, 'DELETE', '/v1/bot/behavior-rules/freeform-instructions', { cookie });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.freeformInstructions, null);
      assert.deepEqual(
        cleared.body.rules.map((rule: { subject: string }) => rule.subject),
        ['swear'],
      );
    },
  );

  specTest(
    'behavior-rules-configuration.md',
    'AC14 each business’s bot follows only its own business’s rules',
    'one client’s rule id is not found in another client’s session, for every rule operation',
    async () => {
      const alpha = await onboard();
      const beta = await onboard();
      const created = await call(served, 'POST', '/v1/bot/behavior-rules', {
        cookie: alpha.cookie,
        json: { kind: 'avoid_topic', subject: 'competitors' },
      });
      const id = created.body.rule.id;

      const attempts = [
        call(served, 'PUT', '/v1/bot/behavior-rules/rule', {
          cookie: beta.cookie,
          json: { id, kind: 'never', subject: 'hijacked' },
        }),
        call(served, 'PUT', '/v1/bot/behavior-rules/rule/enabled', { cookie: beta.cookie, json: { id, enabled: false } }),
        call(served, 'POST', '/v1/bot/behavior-rules/rule/delete', { cookie: beta.cookie, json: { id } }),
      ];
      for (const answer of await Promise.all(attempts)) {
        assert.equal(answer.status, 404);
        assert.equal(answer.body.error.code, 'resource.not_found');
      }
      assert.deepEqual((await call(served, 'GET', '/v1/bot/behavior-rules', { cookie: beta.cookie })).body.rules, []);
      const alphaView = await call(served, 'GET', '/v1/bot/behavior-rules', { cookie: alpha.cookie });
      assert.equal(alphaView.body.rules[0].subject, 'competitors');
      assert.equal(alphaView.body.rules[0].enabled, true);
    },
  );

  unitTest('behaviour-rule routes refuse invalid input with every issue, and anonymous or cross-site callers', async () => {
    const { cookie } = await onboard();
    const invalid = await call(served, 'POST', '/v1/bot/behavior-rules', {
      cookie,
      json: { kind: 'only_when', subject: 'discuss refunds' },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.issues, [{ key: 'condition', reason: 'is required when kind is only_when' }]);

    const badId = await call(served, 'POST', '/v1/bot/behavior-rules/rule/delete', { cookie, json: { id: '1; DROP' } });
    assert.equal(badId.status, 400);

    assert.equal((await call(served, 'GET', '/v1/bot/behavior-rules')).status, 401);
    const forged = await call(served, 'POST', '/v1/bot/behavior-rules', {
      cookie,
      headers: { origin: 'https://example.org' },
      json: { kind: 'never', subject: 'forged' },
    });
    assert.equal(forged.status, 403);
    assert.deepEqual((await call(served, 'GET', '/v1/bot/behavior-rules', { cookie })).body.rules, []);
  });

  // -------------------------------------------------------------------------
  // Bot configuration: business knowledge
  // -------------------------------------------------------------------------

  specTest(
    'business-knowledge-configuration.md',
    'AC2 a saved freeform entry is confirmed and appears in the list',
    'add, edit, and remove entries over HTTP: each save answers with the stored entry and shows on the next GET',
    async () => {
      const { cookie } = await onboard();
      const empty = await call(served, 'GET', '/v1/bot/knowledge', { cookie });
      assert.equal(empty.status, 200);
      assert.deepEqual(empty.body.entries, []);
      assert.equal(empty.body.configured, false);
      assert.equal(empty.body.limits.entryMaxLength, 4000);

      const created = await call(served, 'POST', '/v1/bot/knowledge/entries', {
        cookie,
        json: { content: 'We offer free delivery within 10km.' },
      });
      assert.equal(created.status, 201);
      const id = created.body.entry.id;
      assert.equal(created.body.entry.content, 'We offer free delivery within 10km.');
      await call(served, 'POST', '/v1/bot/knowledge/entries', { cookie, json: { content: 'Open 9am-6pm.' } });

      const edited = await call(served, 'PUT', '/v1/bot/knowledge/entries/entry', {
        cookie,
        json: { id, content: 'Free delivery within 15km.' },
      });
      assert.equal(edited.status, 200);
      assert.equal(edited.body.entry.id, id);

      const view = await call(served, 'GET', '/v1/bot/knowledge', { cookie });
      assert.equal(view.body.configured, true);
      assert.deepEqual(
        view.body.entries.map((entry: { content: string }) => entry.content),
        ['Free delivery within 15km.', 'Open 9am-6pm.'],
      );

      const deleted = await call(served, 'POST', '/v1/bot/knowledge/entries/entry/delete', { cookie, json: { id } });
      assert.equal(deleted.status, 204);
      assert.deepEqual(
        (await call(served, 'GET', '/v1/bot/knowledge', { cookie })).body.entries.map(
          (entry: { content: string }) => entry.content,
        ),
        ['Open 9am-6pm.'],
      );
    },
  );

  specTest(
    'business-knowledge-configuration.md',
    'AC11 each client’s bot reflects only its own knowledge',
    'one client’s entry id is not found in another client’s session, for edit and removal',
    async () => {
      const alpha = await onboard();
      const beta = await onboard();
      const created = await call(served, 'POST', '/v1/bot/knowledge/entries', {
        cookie: alpha.cookie,
        json: { content: 'Alpha delivers on Sundays.' },
      });
      const id = created.body.entry.id;
      const attempts = [
        call(served, 'PUT', '/v1/bot/knowledge/entries/entry', { cookie: beta.cookie, json: { id, content: 'hijacked' } }),
        call(served, 'POST', '/v1/bot/knowledge/entries/entry/delete', { cookie: beta.cookie, json: { id } }),
      ];
      for (const answer of await Promise.all(attempts)) {
        assert.equal(answer.status, 404);
        assert.equal(answer.body.error.code, 'resource.not_found');
      }
      assert.deepEqual((await call(served, 'GET', '/v1/bot/knowledge', { cookie: beta.cookie })).body.entries, []);
      const alphaView = await call(served, 'GET', '/v1/bot/knowledge', { cookie: alpha.cookie });
      assert.equal(alphaView.body.entries[0].content, 'Alpha delivers on Sundays.');
    },
  );

  specTest(
    'business-knowledge-configuration.md',
    'AC10 unconfigured knowledge is shown as recommended but not required',
    'the bot status reports knowledge beside, never among, the readiness conditions',
    async () => {
      const { cookie } = await onboard();
      const fresh = await call(served, 'GET', '/v1/bot/status', { cookie });
      assert.equal(fresh.body.businessKnowledge.configured, false);
      assert.equal(fresh.body.businessKnowledge.required, false);
      assert.match(fresh.body.businessKnowledge.recommendation, /not required/);
      assert.ok(
        fresh.body.unmetConditions.every((entry: { condition: string }) => !/knowledge/.test(entry.condition)),
      );

      await call(served, 'POST', '/v1/bot/knowledge/entries', { cookie, json: { content: 'Open 9am-6pm.' } });
      const configured = await call(served, 'GET', '/v1/bot/status', { cookie });
      assert.deepEqual(configured.body.businessKnowledge, { configured: true, required: false, recommendation: null });
      // The toggle answers with the same shape.
      const toggled = await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: false } });
      assert.equal(toggled.body.businessKnowledge.configured, true);
    },
  );

  unitTest('knowledge routes refuse invalid input with every issue, and anonymous or cross-site callers', async () => {
    const { cookie } = await onboard();
    const invalid = await call(served, 'POST', '/v1/bot/knowledge/entries', { cookie, json: { content: '   ' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.issues, [{ key: 'content', reason: 'is required' }]);

    const badId = await call(served, 'POST', '/v1/bot/knowledge/entries/entry/delete', { cookie, json: { id: '1; DROP' } });
    assert.equal(badId.status, 400);

    assert.equal((await call(served, 'GET', '/v1/bot/knowledge')).status, 401);
    const forged = await call(served, 'POST', '/v1/bot/knowledge/entries', {
      cookie,
      headers: { origin: 'https://example.org' },
      json: { content: 'forged' },
    });
    assert.equal(forged.status, 403);
    assert.deepEqual((await call(served, 'GET', '/v1/bot/knowledge', { cookie })).body.entries, []);
  });

  // -------------------------------------------------------------------------
  // Bot configuration: fallback messages
  // -------------------------------------------------------------------------

  specTest(
    'fallback-response-behavior.md',
    'AC12 a preview renders the same content the end-customer would receive',
    'the draft preview, the saved view’s preview, and the stored configuration agree over HTTP',
    async () => {
      const { cookie } = await onboard();
      const empty = await call(served, 'GET', '/v1/bot/fallback-messages', { cookie });
      assert.equal(empty.status, 200);
      assert.equal(empty.body.sharedMessage, null);
      assert.deepEqual(empty.body.triggers, ['ai_error', 'low_confidence', 'out_of_scope']);
      assert.equal(empty.body.limits.messageMaxLength, 1000);
      assert.ok(
        empty.body.preview.every(
          (entry: { trigger: string; message: string; source: string }) =>
            entry.source === 'platform_default' && entry.message === empty.body.platformDefaults[entry.trigger],
        ),
      );

      const draft = { sharedMessage: 'Sorry! Call us on the shop line.', triggerMessages: { ai_error: 'We are having a hiccup.' } };
      const preview = await call(served, 'POST', '/v1/bot/fallback-messages/preview', { cookie, json: draft });
      assert.equal(preview.status, 200);
      // Previewing stores nothing: the saved configuration is still empty.
      assert.equal((await call(served, 'GET', '/v1/bot/fallback-messages', { cookie })).body.sharedMessage, null);

      const saved = await call(served, 'PUT', '/v1/bot/fallback-messages', { cookie, json: draft });
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.preview, preview.body.preview);
      assert.deepEqual(
        saved.body.preview.map((entry: { message: string; source: string }) => [entry.message, entry.source]),
        [
          ['We are having a hiccup.', 'trigger'],
          ['Sorry! Call us on the shop line.', 'shared'],
          ['Sorry! Call us on the shop line.', 'shared'],
        ],
      );
      assert.deepEqual((await call(served, 'GET', '/v1/bot/fallback-messages', { cookie })).body.preview, preview.body.preview);

      // Clearing everything returns every trigger to the platform default.
      const cleared = await call(served, 'PUT', '/v1/bot/fallback-messages', { cookie, json: {} });
      assert.equal(cleared.status, 200);
      assert.equal(cleared.body.updatedAt, null);
      assert.deepEqual(cleared.body.preview, empty.body.preview);
    },
  );

  unitTest('fallback routes refuse invalid input with every issue, other tenants, and anonymous or cross-site callers', async () => {
    const alpha = await onboard();
    const beta = await onboard();
    await call(served, 'PUT', '/v1/bot/fallback-messages', { cookie: alpha.cookie, json: { sharedMessage: 'Alpha only.' } });
    assert.equal((await call(served, 'GET', '/v1/bot/fallback-messages', { cookie: beta.cookie })).body.sharedMessage, null);

    for (const path of ['/v1/bot/fallback-messages', '/v1/bot/fallback-messages/preview']) {
      const invalid = await call(served, path === '/v1/bot/fallback-messages' ? 'PUT' : 'POST', path, {
        cookie: beta.cookie,
        json: { sharedMessage: 'x'.repeat(1001), triggerMessages: { rude: 'no' } },
      });
      assert.equal(invalid.status, 400);
      assert.deepEqual(invalid.body.error.issues, [
        { key: 'sharedMessage', reason: 'must be at most 1000 characters' },
        {
          key: 'triggerMessages.rude',
          reason: 'is not a recognised trigger (expected one of: ai_error, low_confidence, out_of_scope)',
        },
      ]);
    }

    assert.equal((await call(served, 'GET', '/v1/bot/fallback-messages')).status, 401);
    assert.equal(
      (await call(served, 'POST', '/v1/bot/fallback-messages/preview', { json: { sharedMessage: 'echo' } })).status,
      401,
    );
    const forged = await call(served, 'PUT', '/v1/bot/fallback-messages', {
      cookie: alpha.cookie,
      headers: { origin: 'https://example.org' },
      json: { sharedMessage: 'Forged.' },
    });
    assert.equal(forged.status, 403);
    assert.equal(
      (await call(served, 'GET', '/v1/bot/fallback-messages', { cookie: alpha.cookie })).body.sharedMessage,
      'Alpha only.',
    );
  });

  // -------------------------------------------------------------------------
  // Bot configuration: disclosure
  // -------------------------------------------------------------------------

  specTest(
    'bot-disclosure-setting.md',
    'AC9 the configuration view displays the currently active mode accurately',
    'a new client sees the defaulted mode over HTTP, and after a change sees the chosen one',
    async () => {
      const { cookie } = await onboard();
      const initial = await call(served, 'GET', '/v1/bot/disclosure', { cookie });
      assert.equal(initial.status, 200);
      assert.deepEqual(initial.body, {
        mode: 'disclose',
        source: 'platform_default',
        updatedAt: null,
        modes: ['disclose', 'do_not_disclose'],
        platformDefault: 'disclose',
      });

      const saved = await call(served, 'PUT', '/v1/bot/disclosure', { cookie, json: { mode: 'do_not_disclose' } });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.mode, 'do_not_disclose');
      assert.equal(saved.body.source, 'client');
      assert.deepEqual((await call(served, 'GET', '/v1/bot/disclosure', { cookie })).body, saved.body);
    },
  );

  unitTest('disclosure routes refuse invalid input, other tenants, and anonymous or cross-site callers', async () => {
    const alpha = await onboard();
    const beta = await onboard();
    await call(served, 'PUT', '/v1/bot/disclosure', { cookie: alpha.cookie, json: { mode: 'do_not_disclose' } });
    assert.equal((await call(served, 'GET', '/v1/bot/disclosure', { cookie: beta.cookie })).body.mode, 'disclose');

    const invalid = await call(served, 'PUT', '/v1/bot/disclosure', { cookie: beta.cookie, json: { mode: 'maybe' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.issues, [{ key: 'mode', reason: 'must be one of: disclose, do_not_disclose' }]);

    assert.equal((await call(served, 'GET', '/v1/bot/disclosure')).status, 401);
    assert.equal((await call(served, 'PUT', '/v1/bot/disclosure', { json: { mode: 'disclose' } })).status, 401);
    const forged = await call(served, 'PUT', '/v1/bot/disclosure', {
      cookie: alpha.cookie,
      headers: { origin: 'https://example.org' },
      json: { mode: 'disclose' },
    });
    assert.equal(forged.status, 403);
    assert.equal((await call(served, 'GET', '/v1/bot/disclosure', { cookie: alpha.cookie })).body.mode, 'do_not_disclose');
  });

  // -------------------------------------------------------------------------
  // Bot configuration: human handoff
  // -------------------------------------------------------------------------

  specTest(
    'human-handoff.md',
    'AC5 a client’s customized trigger conditions are what the conversation is evaluated against',
    'a new client sees handoff off with the default triggers, then saves, toggles, and reads back its own',
    async () => {
      const { cookie } = await onboard();
      const initial = await call(served, 'GET', '/v1/bot/handoff', { cookie });
      assert.equal(initial.status, 200);
      assert.equal(initial.body.enabled, false);
      assert.deepEqual(initial.body.triggers, ['human_request', 'complaint', 'out_of_scope']);
      assert.deepEqual(initial.body.customConditions, []);
      assert.equal(initial.body.source, 'platform_default');
      assert.equal(initial.body.updatedAt, null);
      assert.deepEqual(initial.body.options.triggers, ['human_request', 'complaint', 'out_of_scope']);
      assert.deepEqual(initial.body.platformDefault, {
        enabled: false,
        triggers: ['human_request', 'complaint', 'out_of_scope'],
      });
      assert.deepEqual(initial.body.limits, { conditionMaxLength: 300, maxConditions: 20 });

      const saved = await call(served, 'PUT', '/v1/bot/handoff', {
        cookie,
        json: { enabled: true, triggers: ['complaint'], customConditions: ['The customer mentions a refund'] },
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.enabled, true);
      assert.deepEqual(saved.body.triggers, ['complaint']);
      assert.deepEqual(saved.body.customConditions, ['The customer mentions a refund']);
      assert.equal(saved.body.source, 'client');
      assert.deepEqual((await call(served, 'GET', '/v1/bot/handoff', { cookie })).body, saved.body);

      const off = await call(served, 'PUT', '/v1/bot/handoff/enabled', { cookie, json: { enabled: false } });
      assert.equal(off.status, 200);
      assert.equal(off.body.enabled, false);
      assert.deepEqual(off.body.triggers, ['complaint']);
      assert.deepEqual(off.body.customConditions, ['The customer mentions a refund']);
    },
  );

  unitTest('handoff routes refuse invalid input, other tenants, and anonymous or cross-site callers', async () => {
    const alpha = await onboard();
    const beta = await onboard();
    const alphaConfiguration = { enabled: true, triggers: ['human_request'], customConditions: [] };
    await call(served, 'PUT', '/v1/bot/handoff', { cookie: alpha.cookie, json: alphaConfiguration });
    const betaView = (await call(served, 'GET', '/v1/bot/handoff', { cookie: beta.cookie })).body;
    assert.equal(betaView.enabled, false);
    assert.equal(betaView.source, 'platform_default');

    const invalid = await call(served, 'PUT', '/v1/bot/handoff', {
      cookie: beta.cookie,
      json: { enabled: true, triggers: [], customConditions: [] },
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.issues, [
      { key: 'enabled', reason: 'cannot be true with no trigger selected and no condition written' },
    ]);
    const badToggle = await call(served, 'PUT', '/v1/bot/handoff/enabled', { cookie: beta.cookie, json: { enabled: 'yes' } });
    assert.equal(badToggle.status, 400);

    assert.equal((await call(served, 'GET', '/v1/bot/handoff')).status, 401);
    assert.equal((await call(served, 'PUT', '/v1/bot/handoff', { json: alphaConfiguration })).status, 401);
    assert.equal((await call(served, 'PUT', '/v1/bot/handoff/enabled', { json: { enabled: false } })).status, 401);
    const forged = await call(served, 'PUT', '/v1/bot/handoff/enabled', {
      cookie: alpha.cookie,
      headers: { origin: 'https://example.org' },
      json: { enabled: false },
    });
    assert.equal(forged.status, 403);
    assert.equal((await call(served, 'GET', '/v1/bot/handoff', { cookie: alpha.cookie })).body.enabled, true);
  });

  // -------------------------------------------------------------------------
  // Readiness, the go-live toggle, and the connection state
  // -------------------------------------------------------------------------

  /**
   * Drive the tenant's connection the way the WhatsApp gateway will. There is no
   * client route that marks a number connected, on purpose: that state has to be
   * earned by verification (whatsapp-number-connection.md).
   */
  async function gatewayMoves(tenantId: string, ...states: ConnectionState[]): Promise<void> {
    for (const state of states) {
      await withTenant(db.pool, tenantId, (tx) =>
        transitionConnection(tx, state, { reason: state === 'error' ? 'authorization_revoked' : undefined }),
      );
    }
  }

  specTest(
    'bot-activation-control.md',
    'AC10 a not-ready client is told which conditions are unmet',
    'GET /v1/bot/status names each unmet condition, and go-live is refused with 409 until both are met',
    async () => {
      const { cookie, tenantId } = await onboard();
      const fresh = await call(served, 'GET', '/v1/bot/status', { cookie });
      assert.equal(fresh.status, 200);
      assert.equal(fresh.body.ready, false);
      assert.equal(fresh.body.active, false);
      assert.deepEqual(
        fresh.body.unmetConditions.map((entry: { condition: string }) => entry.condition),
        ['whatsapp_connection', 'persona'],
      );

      const refused = await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: true } });
      assert.equal(refused.status, 409);
      assert.equal(refused.body.error.code, 'bot.not_ready');

      await call(served, 'PUT', '/v1/bot/persona', { cookie, json: { botName: 'Juno' } });
      await gatewayMoves(tenantId, 'connecting', 'connected');
      const ready = await call(served, 'GET', '/v1/bot/status', { cookie });
      assert.equal(ready.body.ready, true);
      assert.equal(ready.body.canGoLive, true);
      assert.equal(ready.body.active, false);
    },
  );

  specTest(
    'bot-activation-control.md',
    'AC8 losing readiness while active turns the bot off without client action',
    'go live over HTTP, lose the connection, and the status shows the bot off and not ready',
    async () => {
      const { cookie, tenantId } = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', { cookie, json: { botName: 'Juno' } });
      await gatewayMoves(tenantId, 'connecting', 'connected');

      const live = await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: true } });
      assert.equal(live.status, 200);
      assert.equal(live.body.active, true);

      await gatewayMoves(tenantId, 'error');
      const lost = await call(served, 'GET', '/v1/bot/status', { cookie });
      assert.equal(lost.body.active, false);
      assert.equal(lost.body.ready, false);
      assert.equal(lost.body.activeChangeCause, 'readiness_lost');

      const history = await call(served, 'GET', '/v1/bot/activation/history', { cookie });
      assert.deepEqual(
        history.body.events.map((event: { active: boolean; cause: string }) => [event.active, event.cause]),
        [
          [false, 'readiness_lost'],
          [true, 'client'],
        ],
      );
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC7 manual disconnect from connected, error, or reconnecting',
    'the client sees the connection state and can disconnect it, which also takes an active bot off',
    async () => {
      const { cookie, tenantId } = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', { cookie, json: { botName: 'Juno' } });
      await gatewayMoves(tenantId, 'connecting', 'connected');
      await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: true } });

      const seen = await call(served, 'GET', '/v1/whatsapp/connection', { cookie });
      assert.equal(seen.status, 200);
      assert.equal(seen.body.state, 'connected');
      assert.equal(typeof seen.body.lastKnownGoodAt, 'string');

      const done = await call(served, 'POST', '/v1/whatsapp/connection/disconnect', { cookie });
      assert.equal(done.status, 200);
      assert.equal(done.body.state, 'disconnected');
      assert.deepEqual(
        done.body.history.map((entry: { from: string; to: string }) => `${entry.from}->${entry.to}`),
        ['connected->disconnected', 'connecting->connected', 'disconnected->connecting'],
      );
      assert.equal((await call(served, 'GET', '/v1/bot/status', { cookie })).body.active, false);
    },
  );

  unitTest('the activation toggle refuses a body that is not exactly { active: boolean }', async () => {
    const { cookie } = await onboard();
    const answer = await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: 'on' } });
    assert.equal(answer.status, 400);
  });

  specTest(
    'bot-activation-control.md',
    'AC12 the operator can view readiness and activation but cannot change activation',
    'the operator lists every tenant’s state, and an operator token cannot reach the client toggle',
    async () => {
      const { cookie, tenantId } = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', { cookie, json: { botName: 'Juno' } });
      await gatewayMoves(tenantId, 'connecting', 'connected');
      await call(served, 'PUT', '/v1/bot/activation', { cookie, json: { active: true } });

      const email = `ops-${nextEmail()}`;
      await identity.createOperator({ email, password: PASSWORD });
      const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
      const operatorToken = cookieValue(login, OPERATOR_SESSION_COOKIE);
      const operatorCookie = `${OPERATOR_SESSION_COOKIE}=${operatorToken}`;

      const listed = await call(served, 'GET', '/v1/operator/bot-statuses', { cookie: operatorCookie });
      assert.equal(listed.status, 200);
      const mine = listed.body.tenants.find((entry: { tenantId: string }) => entry.tenantId === tenantId);
      assert.equal(mine.active, true);
      assert.equal(mine.ready, true);

      // The operator's token presented to the client toggle is not a client session.
      const forced = await call(served, 'PUT', '/v1/bot/activation', {
        cookie: `${CLIENT_SESSION_COOKIE}=${operatorToken}`,
        json: { active: false },
      });
      assert.equal(forced.status, 401);
      // And a client session is not an operator one.
      const clientToken = cookie.split('=')[1];
      const peeked = await call(served, 'GET', '/v1/operator/bot-statuses', {
        cookie: `${OPERATOR_SESSION_COOKIE}=${clientToken}`,
      });
      assert.equal(peeked.status, 401);
      assert.equal((await call(served, 'GET', '/v1/bot/status', { cookie })).body.active, true);
    },
  );

  // -------------------------------------------------------------------------
  // Reply preview and the active AI provider
  // -------------------------------------------------------------------------

  specTest(
    'behavior-rules-configuration.md',
    'AC16 a preview against a sample message demonstrates the same constraints as a live conversation',
    'the preview route runs the sample through the reply path with the tenant’s saved rules and shows what the customer would receive',
    async () => {
      const { cookie } = await onboard();
      await call(served, 'PUT', '/v1/bot/persona', { cookie, json: { botName: 'Juno' } });
      const created = await call(served, 'POST', '/v1/bot/behavior-rules', {
        cookie,
        json: { kind: 'avoid_topic', subject: 'politics', action: 'fallback' },
      });
      assert.equal(created.status, 201);
      await call(served, 'PUT', '/v1/bot/fallback-messages', {
        cookie,
        json: { triggerMessages: { out_of_scope: 'Only cake questions, please!' } },
      });

      ai.backend.script({ kind: 'text', text: '[fallback] out_of_scope' });
      const before = ai.backend.requests.length;
      const declined = await call(served, 'POST', '/v1/bot/preview', { cookie, json: { message: 'Who should I vote for?' } });
      assert.equal(declined.status, 200);
      assert.deepEqual(declined.body.preview, {
        outcome: 'fallback',
        trigger: 'out_of_scope',
        cause: 'declined',
        message: 'Only cake questions, please!',
        source: 'trigger',
      });
      const seen = ai.backend.requests[before] as ObservedGeneration;
      assert.match(seen.instructions, /\[rule 1\] Do not discuss or engage with this topic: "politics"/);
      assert.match(seen.instructions, /"Juno"/);
      assert.deepEqual(seen.turns, [{ role: 'customer', parts: [{ type: 'text', text: 'Who should I vote for?' }] }]);

      // Disabling the rule is what the next preview obeys.
      const disabled = await call(served, 'PUT', '/v1/bot/behavior-rules/rule/enabled', {
        cookie,
        json: { id: created.body.rule.id, enabled: false },
      });
      assert.equal(disabled.status, 200);
      ai.backend.script({ kind: 'text', text: '[reply]\nI can’t advise on that, but our cakes are apolitical.' });
      const answered = await call(served, 'POST', '/v1/bot/preview', { cookie, json: { message: 'Who should I vote for?' } });
      assert.deepEqual(answered.body.preview, { outcome: 'reply', text: 'I can’t advise on that, but our cakes are apolitical.' });
      assert.doesNotMatch((ai.backend.requests.at(-1) as ObservedGeneration).instructions, /politics/);
    },
  );

  unitTest('the preview refuses invalid input, anonymous callers, and a tenant past its preview budget', async () => {
    const { cookie } = await onboard();
    const invalid = await call(served, 'POST', '/v1/bot/preview', { cookie, json: { message: '  ', tenantId: 'x' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body.error.issues, [
      { key: 'message', reason: 'must not be blank' },
      { key: 'tenantId', reason: 'is not a recognised field' },
    ]);
    assert.equal((await call(served, 'POST', '/v1/bot/preview', { json: { message: 'hi' } })).status, 401);

    const budgetedServed = await serve(apiWith({ settings: { previewRateLimit: 2 } }));
    extra.push(budgetedServed);
    for (let i = 0; i < 2; i += 1) {
      assert.equal((await call(budgetedServed, 'POST', '/v1/bot/preview', { cookie, json: { message: 'hi' } })).status, 200);
    }
    const limited = await call(budgetedServed, 'POST', '/v1/bot/preview', { cookie, json: { message: 'hi' } });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    // The budget is per tenant: another business is unaffected.
    const other = await onboard();
    assert.equal(
      (await call(budgetedServed, 'POST', '/v1/bot/preview', { cookie: other.cookie, json: { message: 'hi' } })).status,
      200,
    );
  });

  specTest(
    'fallback-response-behavior.md',
    'AC5 the AI generation step fails outright and the customer still receives a fallback',
    'a provider failure during a preview shows the error fallback rather than an error response',
    async () => {
      const { cookie } = await onboard();
      const failing = new InMemoryAiProvider({ maxAttempts: 1 });
      failing.backend.script({ kind: 'failure', failure: 'unauthorized' });
      const failingServed = await serve(apiWith({ ai: failing }));
      extra.push(failingServed);
      const answer = await call(failingServed, 'POST', '/v1/bot/preview', { cookie, json: { message: 'Hello?' } });
      assert.equal(answer.status, 200);
      assert.equal(answer.body.preview.outcome, 'fallback');
      assert.equal(answer.body.preview.trigger, 'ai_error');
      assert.equal(answer.body.preview.cause, 'generation_failed');
      assert.equal(answer.body.preview.source, 'platform_default');
    },
  );

  specTest(
    'ai-provider-portability.md',
    'AC8 the operator can tell which provider is active',
    'the operator reads the active provider and model, with no credential or endpoint, and a client cannot',
    async () => {
      const email = `ops-${nextEmail()}`;
      await identity.createOperator({ email, password: PASSWORD });
      const login = await call(served, 'POST', '/v1/operator/session', { json: { email, password: PASSWORD } });
      const operatorCookie = `${OPERATOR_SESSION_COOKIE}=${cookieValue(login, OPERATOR_SESSION_COOKIE)}`;
      const answer = await call(served, 'GET', '/v1/operator/ai-provider', { cookie: operatorCookie });
      assert.equal(answer.status, 200);
      assert.deepEqual(answer.body.provider, {
        provider: 'memory',
        model: 'memory-model',
        transcriptionModel: 'memory-model',
        capabilities: ['text', 'vision', 'audio'],
      });

      const { cookie } = await onboard();
      const clientToken = cookie.split('=')[1];
      const peeked = await call(served, 'GET', '/v1/operator/ai-provider', {
        cookie: `${OPERATOR_SESSION_COOKIE}=${clientToken}`,
      });
      assert.equal(peeked.status, 401);
    },
  );

  // -------------------------------------------------------------------------
  // Transport defences
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC12 throttling from a single source',
    'one source past its budget is refused with a retry hint while another source is unaffected',
    async () => {
      const limited = apiWith({ settings: { anonymousRateLimit: 3, trustedProxyHops: 1 } });
      const limitedServed = await serve(limited);
      extra.push(limitedServed);
      const attempt = (source: string): Promise<Answer> =>
        call(limitedServed, 'POST', '/v1/session', {
          json: { email: nextEmail(), password: 'not-the-password-1' },
          headers: { 'x-forwarded-for': source },
        });

      for (let i = 0; i < 3; i += 1) assert.equal((await attempt('198.51.100.1')).status, 401);
      const refused = await attempt('198.51.100.1');
      assert.equal(refused.status, 429);
      assert.equal(refused.body.error.code, 'request.rate_limited');
      assert.ok(Number(refused.headers.get('retry-after')) > 0);

      assert.equal((await attempt('198.51.100.2')).status, 401);
      // Prepending a forged address does not buy a fresh budget: the trusted
      // proxy's entry is still the rightmost one.
      assert.equal(
        (
          await call(limitedServed, 'POST', '/v1/session', {
            json: { email: nextEmail(), password: 'not-the-password-1' },
            headers: { 'x-forwarded-for': '203.0.113.50, 198.51.100.1' },
          })
        ).status,
        429,
      );
    },
  );

  unitTest('a state-changing request from another origin is refused; the configured origin is not', async () => {
    const foreign = await call(served, 'POST', '/v1/session', {
      json: { email: nextEmail(), password: PASSWORD },
      headers: { origin: 'https://evil.example.org' },
    });
    assert.equal(foreign.status, 403);
    assert.equal(foreign.body.error.code, 'request.cross_origin');

    const own = await call(served, 'POST', '/v1/session', {
      json: { email: nextEmail(), password: PASSWORD },
      headers: { origin: PUBLIC_BASE },
    });
    assert.equal(own.status, 401);
  });

  unitTest('a body that is not JSON, too large, or malformed is refused before any handler runs', async () => {
    const form = await call(served, 'POST', '/v1/session', {
      rawBody: 'email=a%40example.com&password=x',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(form.status, 415);

    const huge = await call(served, 'POST', '/v1/session', {
      rawBody: JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(40_000) }),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(huge.status, 413);

    const broken = await call(served, 'POST', '/v1/session', {
      rawBody: '{"email":',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'request.malformed');

    const array = await call(served, 'POST', '/v1/session', { json: [1, 2] });
    assert.equal(array.status, 400);
  });

  unitTest('an oversized chunked body with no declared length still receives its 413', async () => {
    // The declared-length check cannot see this one, and abandoning the read
    // mid-stream would tear down the socket before the reply could be written —
    // the caller would see a reset connection instead of a reason.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = request(
        `${served.url}/v1/session`,
        { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on('error', reject);
      for (let i = 0; i < 40; i += 1) outgoing.write('x'.repeat(1024));
      outgoing.end();
    });
    assert.equal(status, 413);
  });

  unitTest('unknown routes are 404 and a known route with the wrong method is 405 naming the allowed ones', async () => {
    assert.equal((await call(served, 'GET', '/v1/nowhere')).status, 404);
    const wrong = await call(served, 'PUT', '/v1/session');
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get('allow'), 'POST, GET, DELETE');
  });

  unitTest('every response carries the security headers and a request id', async () => {
    const answer = await call(served, 'GET', '/health/live');
    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get('cache-control'), 'no-store');
    assert.equal(answer.headers.get('x-content-type-options'), 'nosniff');
    assert.match(answer.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(answer.headers.get('x-request-id') ?? '', /^[0-9a-f-]{36}$/);
  });

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'readiness names the database as the failing component when it is unreachable',
    async () => {
      assert.deepEqual((await call(served, 'GET', '/health/ready')).body, { status: 'ready' });

      const broken = createApi({
        identity,
        mailer,
        ai,
        pool: { query: async () => Promise.reject(new Error('connect ECONNREFUSED')) } as never,
        settings: settingsWith(),
        logger: new Logger({ sink }),
      });
      const brokenServed = await serve(broken);
      extra.push(brokenServed);
      const answer = await call(brokenServed, 'GET', '/health/ready');
      assert.equal(answer.status, 503);
      assert.deepEqual(answer.body, { status: 'unavailable', component: 'database' });
      // Liveness is unaffected: restarting this process would not fix the database.
      assert.equal((await call(brokenServed, 'GET', '/health/live')).status, 200);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC5 no secret in any log',
    'after a full signup, login, and reset flow the logs hold no password, token, or email address',
    async () => {
      sink.clear();
      const email = `needle-${nextEmail()}`;
      await signUp(email);
      const verification = tokenFromMailbox(mailer, email);
      await call(served, 'POST', '/v1/email-verification', { json: { token: verification } });
      const login = await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } });
      const session = cookieValue(login, CLIENT_SESSION_COOKIE)!;
      await call(served, 'POST', '/v1/password-resets/requests', { json: { email } });
      await api.outbox.drain();
      const reset = tokenFromMailbox(mailer, email);
      await call(served, 'POST', '/v1/password-resets', { json: { token: reset, newPassword: NEW_PASSWORD } });

      const logged = sink.serialized();
      // Non-empty first: a leak test over no records passes for the wrong reason.
      assert.ok(sink.records.filter((record) => record.event === 'api.request').length >= 5);
      assert.match(logged, /"route":"\/v1\/password-resets"/);
      for (const needle of [PASSWORD, NEW_PASSWORD, verification, reset, session, 'needle-']) {
        assert.ok(!logged.includes(needle), `the log contains ${needle.slice(0, 6)}…`);
      }
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC18 authentication events are recorded without content',
    'logins through the API land in the access records with who, what, and outcome',
    async () => {
      const { email } = await onboard();
      await call(served, 'POST', '/v1/session', { json: { email, password: 'not-the-password-1' } });
      const { withPlatformScope } = await import('@zeddev/db');
      const rows = await withPlatformScope(db.pool, async (tx) =>
        (
          await tx.query<{ action: string; outcome: string }>(
            `SELECT action, outcome FROM access_records WHERE action = 'client.login' ORDER BY occurred_at`,
          )
        ).rows,
      );
      assert.ok(rows.some((row) => row.outcome === 'allowed'));
      assert.ok(rows.some((row) => row.outcome === 'denied'));
    },
  );
});

describe('api service over real SMTP', {
  skip: !testDatabaseConfigured() ? SKIP_REASON : !mailTestConfigured() ? MAIL_SKIP_REASON : false,
}, () => {
  let db: TestDatabase;
  let served: Served;
  let api: Api;
  let mailer: SmtpMailer;

  before(async () => {
    db = await createTestDatabase('api_smtp');
    await migrateToLatest(db.pool);
  });

  after(async () => {
    await served?.close();
    await mailer?.close();
    await db?.drop();
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC6 the signup email is verified as controlled by the signer',
    'the link an independent mail server delivered is the one that activates the account',
    async () => {
      const mailbox = createTestMailbox();
      mailer = new SmtpMailer(mailbox.settings, { logger: new Logger({ sink: new MemorySink() }) });
      const identity = new IdentityService({
        pool: db.pool,
        policy: POLICY,
        credentialParams: FAST_SCRYPT,
        logger: new Logger({ sink: new MemorySink() }),
      });
      api = createApi({
        identity,
        mailer,
        ai: new InMemoryAiProvider(),
        pool: db.pool,
        settings: settingsWith(),
        logger: new Logger({ sink: new MemorySink() }),
      });
      served = await serve(api);

      const email = mailbox.recipient('owner');
      const signed = await call(served, 'POST', '/v1/signup', {
        json: { businessName: 'Harbour Café', email, password: PASSWORD },
      });
      assert.equal(signed.status, 201);
      assert.equal(await api.outbox.drain(15_000), true);

      const [delivered] = await mailbox.serverParsed();
      assert.ok(delivered !== undefined, 'the mail server received nothing');
      assert.deepEqual(delivered.to, [email]);
      const link = /(https:\/\/\S+)/.exec(delivered.text)?.[1];
      assert.ok(link !== undefined);
      const token = decodeURIComponent(new URL(link).hash.replace(/^#token=/, ''));

      assert.equal((await call(served, 'POST', '/v1/email-verification', { json: { token } })).status, 200);
      assert.equal((await call(served, 'POST', '/v1/session', { json: { email, password: PASSWORD } })).status, 200);
    },
  );
});
