/**
 * The pure pieces of the API: address resolution, cookies, the error-to-reply
 * mapping, the throttle, and link building.
 *
 * These are unit tests because each is a function whose failure mode is a
 * security property silently not holding — a forged source address walking past
 * the throttle, a token reaching a server log through a query string, a failure
 * reason leaking into a response body — and each is cheaper to pin down exactly
 * here than to infer from an HTTP round trip. The integration suite in
 * `app.test.ts` then proves they are wired in.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import {
  AuthenticationError,
  ConflictError,
  InternalError,
  TransientTransportError,
  ValidationError,
} from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { InMemoryMailer } from '@zeddev/mail/testing';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import { loadServerSettings } from './config.ts';
import { clientAddress, parseCookies, serializeCookie, toReply } from './http.ts';
import { buildLink, MailOutbox, passwordResetMessage } from './mail.ts';
import { FixedWindowRateLimiter } from './ratelimit.ts';

const token = new Secret('zdpr_abc-DEF_123', 'token');

describe('client address resolution', () => {
  unitTest('with no trusted proxy the forwarded header is ignored entirely', () => {
    assert.equal(clientAddress('10.0.0.5', '203.0.113.9', 0), '10.0.0.5');
  });

  specTest(
    'authentication-and-access.md',
    'AC12 throttling from a single source',
    'a caller cannot choose its own source address by prepending to X-Forwarded-For',
    () => {
      // One trusted proxy appended the real client address; the caller wrote the
      // first entry. Reading the leftmost entry — the common mistake — would let
      // every request claim a fresh address and never be throttled.
      assert.equal(clientAddress('10.0.0.2', '1.2.3.4, 198.51.100.7', 1), '198.51.100.7');
      assert.equal(clientAddress('10.0.0.2', ['1.2.3.4', '198.51.100.7'], 1), '198.51.100.7');
    },
  );

  unitTest('two trusted hops read two entries back from the peer', () => {
    assert.equal(clientAddress('10.0.0.3', '9.9.9.9, 198.51.100.7, 10.0.0.2', 2), '198.51.100.7');
  });

  unitTest('a chain shorter than the trusted hops falls back to its leftmost entry', () => {
    assert.equal(clientAddress('10.0.0.2', undefined, 3), '10.0.0.2');
    assert.equal(clientAddress('10.0.0.2', '198.51.100.7', 3), '198.51.100.7');
  });
});

describe('cookies', () => {
  unitTest('parsing keeps the first occurrence of a name, as a browser sends it', () => {
    const cookies = parseCookies('zd_session=first; other=x; zd_session=second');
    assert.equal(cookies.get('zd_session'), 'first');
    assert.equal(cookies.get('other'), 'x');
    assert.equal(parseCookies(undefined).size, 0);
  });

  unitTest('a session cookie is HttpOnly and SameSite=Strict, and Secure only when configured', () => {
    const expires = new Date('2026-09-20T00:00:00Z');
    const plain = serializeCookie('zd_session', 'tok', { path: '/', secure: false, expires });
    assert.match(plain, /^zd_session=tok; Path=\/; HttpOnly; SameSite=Strict; Expires=Sun, 20 Sep 2026 00:00:00 GMT$/);
    const secure = serializeCookie('zd_session', 'tok', { path: '/', secure: true, expires });
    assert.match(secure, /; Secure;/);
  });

  unitTest('clearing a cookie expires it in the past', () => {
    const cleared = serializeCookie('zd_session', '', { path: '/', secure: false });
    assert.match(cleared, /^zd_session=; /);
    assert.match(cleared, /Max-Age=0/);
  });
});

describe('error replies', () => {
  specTest(
    'authentication-and-access.md',
    'AC3 failed login indistinguishable for known and unknown email',
    'an authentication failure produces the same reply whatever context it carries',
    () => {
      const a = toReply(new AuthenticationError(), 'r');
      const b = toReply(new AuthenticationError({ context: { reason: 'unknown_account' } }), 'r');
      assert.deepEqual(a, b);
      assert.equal(a.status, 401);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC5 no secret in any error message',
    'an unclassified failure reveals only a code and the request id',
    () => {
      const reply = toReply(new Error('password=hunter2 leaked into a message'), 'req-1');
      assert.equal(reply.status, 500);
      assert.deepEqual(reply.body, { error: { code: 'internal', requestId: 'req-1' } });
      assert.deepEqual(toReply(new InternalError('also a message with detail'), 'req-1').body, reply.body);
    },
  );

  unitTest('validation issues are reported per field, without values', () => {
    const reply = toReply(new ValidationError([{ key: 'password', reason: 'is too short' }]), 'r');
    assert.equal(reply.status, 400);
    assert.deepEqual(reply.body, {
      error: { code: 'validation.failed', issues: [{ key: 'password', reason: 'is too short' }], requestId: 'r' },
    });
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC3 duplicate email rejected with a clear reason',
    'a conflict carries its authored reason and code',
    () => {
      const reply = toReply(
        new ConflictError('That email address is already registered', { code: 'identity.email_in_use' }),
        'r',
      );
      assert.equal(reply.status, 409);
      assert.deepEqual(reply.body, {
        error: { code: 'identity.email_in_use', message: 'That email address is already registered', requestId: 'r' },
      });
    },
  );

  unitTest('a transient failure is a 503 carrying the upstream retry hint', () => {
    const reply = toReply(new TransientTransportError('busy', { code: 'db.busy', retryAfterMs: 2500 }), 'r');
    assert.equal(reply.status, 503);
    assert.equal(reply.headers?.['retry-after'], '3');
  });
});

describe('fixed-window rate limiter', () => {
  specTest(
    'authentication-and-access.md',
    'AC12 throttling from a single source',
    'a source is refused past the limit and admitted again once its window ends',
    async () => {
      const clock = new FakeClock();
      const limiter = new FixedWindowRateLimiter({ limit: 2, windowMs: 60_000, clock });
      assert.equal(limiter.take('a').allowed, true);
      assert.equal(limiter.take('a').allowed, true);
      const refused = limiter.take('a');
      assert.equal(refused.allowed, false);
      assert.equal(refused.retryAfterMs, 60_000);
      // Another source is unaffected by the first one's budget.
      assert.equal(limiter.take('b').allowed, true);

      await clock.advance(60_000);
      assert.equal(limiter.take('a').allowed, true);
    },
  );

  unitTest('memory stays bounded when a caller rotates source addresses', () => {
    const clock = new FakeClock();
    const limiter = new FixedWindowRateLimiter({ limit: 5, windowMs: 60_000, clock });
    for (let i = 0; i < 25_000; i += 1) limiter.take(`source-${i}`);
    assert.ok(limiter.trackedSources <= 10_000, `tracked ${limiter.trackedSources} sources`);
  });
});

describe('mail links', () => {
  unitTest('the token travels in the fragment, never the query string', () => {
    const link = buildLink(new URL('https://app.example.com/'), 'password_reset', token);
    assert.equal(link, 'https://app.example.com/reset-password#token=zdpr_abc-DEF_123');
    assert.equal(new URL(link).search, '');
  });

  unitTest('a base URL with a path prefix keeps it', () => {
    const settings = loadServerSettings({ API_PUBLIC_BASE_URL: 'https://example.com/zeddev' });
    assert.equal(
      buildLink(settings.publicBaseUrl, 'email_verification', token),
      'https://example.com/zeddev/verify-email#token=zdpr_abc-DEF_123',
    );
  });

  unitTest('a base URL carrying a query, fragment, or credentials is refused at startup', () => {
    for (const bad of ['https://example.com/?x=1', 'https://example.com/#x', 'https://u:p@example.com/']) {
      assert.throws(() => loadServerSettings({ API_PUBLIC_BASE_URL: bad }), /API_PUBLIC_BASE_URL/);
    }
  });

  unitTest('cookies are Secure exactly when the configured public URL is https', () => {
    assert.equal(loadServerSettings({ API_PUBLIC_BASE_URL: 'https://example.com' }).secureCookies, true);
    assert.equal(loadServerSettings({ API_PUBLIC_BASE_URL: 'http://example.com' }).secureCookies, false);
  });
});

describe('mail outbox', () => {
  specTest(
    'credential-and-secret-handling.md',
    'AC5 no secret in any log',
    'a failed delivery is logged without the recipient, the link, or the token',
    async () => {
      const sink = new MemorySink();
      const mailer = new InMemoryMailer();
      const outbox = new MailOutbox(mailer, new Logger({ sink }));
      mailer.failNext(new Error('smtp said no to victim-mailbox@example.com'));
      outbox.dispatch(
        'password_reset',
        passwordResetMessage({
          base: new URL('https://app.example.com/'),
          to: 'victim-mailbox@example.com',
          token,
          expiresAt: new Date('2026-09-17T12:00:00Z'),
        }),
      );
      assert.equal(await outbox.drain(), true);
      assert.equal(outbox.pending, 0);
      const logged = sink.serialized();
      assert.match(logged, /api\.mail\.failed/);
      assert.doesNotMatch(logged, /victim-mailbox/);
      assert.doesNotMatch(logged, /zdpr_abc/);
    },
  );

  unitTest('drain gives up after its timeout rather than hanging shutdown', async () => {
    const never: InMemoryMailer = new InMemoryMailer();
    const stuck = {
      send: () => new Promise<never>(() => undefined),
      verifyAccess: () => never.verifyAccess(),
      close: () => never.close(),
    };
    const outbox = new MailOutbox(stuck, new Logger({ sink: new MemorySink() }));
    outbox.dispatch('email_verification', { to: 'a@example.com', subject: 's', body: 'b' });
    assert.equal(await outbox.drain(20), false);
    assert.equal(outbox.pending, 1);
  });
});
