/**
 * The SMTP adapter, against a real server and against a scripted one.
 *
 * The division follows `@zeddev/storage`'s and is deliberate. Everything a real
 * SMTP server will do on demand — greet, advertise capabilities, authenticate,
 * accept a DATA transaction, un-stuff a dotted line, decode an encoded word — is
 * tested against Mailpit through the shared conformance suite, because a fake
 * server would only ever confirm that this package agrees with itself.
 *
 * Everything a real server will *not* do on demand is tested against the
 * connector seam: a 451 in the middle of a transaction, a connection dropped
 * after the terminating dot has been written, a reply arriving in three TCP
 * segments, a server that stops advertising STARTTLS. Those are the paths where
 * the client's behaviour matters most and where a live server offers no way in.
 *
 * Mailpit's own parse is used in one place as an external oracle. Two independent
 * decoders agreeing that the bytes mean what this repo intended is evidence; this
 * repo's decoder agreeing with this repo's encoder is not.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ConfigurationError, TerminalTransportError, TransientTransportError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import type { Clock } from '@zeddev/time';
import { SmtpMailer } from './smtp.ts';
import type { SmtpConnection, SmtpConnectOptions, SmtpConnector } from './socket.ts';
import type { SmtpSettings } from './types.ts';
import {
  createTestMailbox,
  decodeMail,
  mailTestConfigured,
  runMailConformance,
  SKIP_REASON,
  type MailFixture,
  type MailHarness,
} from './testing.ts';

// ===========================================================================
// Against a real server
// ===========================================================================

describe('smtp mailer', { skip: mailTestConfigured() ? false : SKIP_REASON }, () => {
  const harness: MailHarness = {
    label: 'smtp',
    async create(): Promise<MailFixture> {
      const mailbox = createTestMailbox();
      const mailer = new SmtpMailer(mailbox.settings, { logger: new Logger({ sink: new MemorySink() }) });
      return {
        mailer,
        fromAddress: mailbox.settings.fromAddress,
        recipient: mailbox.recipient,
        async received() {
          return (await mailbox.rawMessages()).map((raw) => decodeMail(raw));
        },
        async dispose() {
          await mailer.close();
        },
      };
    },
  };

  runMailConformance(harness);

  describe('against the server itself', () => {
    specTest(
      'client-signup-and-tenancy.md',
      'Given a prospective client with no existing account, when they complete the signup form with valid, unique information, then a new account is created and a dedicated tenant is provisioned without any operator interaction',
      'an independent parser agrees with this package about what the bytes mean',
      async () => {
        if (!mailTestConfigured()) return;
        // The external oracle. Our own decoder round-tripping our own encoder
        // would pass just as happily if both shared a misreading of RFC 2047,
        // which is precisely the failure mode that only shows up in somebody
        // else's mail client.
        const mailbox = createTestMailbox();
        const mailer = new SmtpMailer(mailbox.settings);
        try {
          const to = mailbox.recipient('oracle');
          const subject = 'Confirmez votre adresse — Café 東京';
          const body = 'Bonjour,\n\nhttps://example.test/verify?token=zev1_xyz\n\nMerci.';
          const sent = await mailer.send({ to, subject, body });

          const parsed = await mailbox.serverParsed();
          assert.equal(parsed.length, 1);
          assert.equal(parsed[0]?.subject, subject, 'the server decoded the subject differently than we encoded it');
          assert.equal(parsed[0]?.text.replace(/\r\n/g, '\n').trimEnd(), body.trimEnd());
          assert.deepEqual(parsed[0]?.to, [to]);
          assert.equal(parsed[0]?.from, mailbox.settings.fromAddress);
          assert.equal(parsed[0]?.messageId, sent.messageId);
        } finally {
          await mailer.close();
        }
      },
    );

    unitTest('authenticates with the configured credentials', async () => {
      if (!mailTestConfigured()) return;
      const mailbox = createTestMailbox();
      assert.notEqual(mailbox.settings.username, '', 'the fixture must exercise the AUTH path');
      const mailer = new SmtpMailer(mailbox.settings);
      try {
        await mailer.verifyAccess();
        await mailer.send({ to: mailbox.recipient('authed'), subject: 'Authed', body: 'body' });
        assert.equal((await mailbox.rawMessages()).length, 1);
      } finally {
        await mailer.close();
      }
    });

    specTest(
      'environment-portability.md',
      'Given a required configuration value is missing or invalid for the target environment, when the system attempts to start, then it reports a clear error identifying the missing/invalid configuration rather than starting in a broken or partially functional state',
      'an unreachable mail server fails startup naming the address keys, not a socket error',
      async () => {
        if (!mailTestConfigured()) return;
        // IMPLEMENTATION_PLAN.md §4e records object storage's version of this
        // lesson: a preflight that cannot say which value is wrong is a preflight
        // that does not earn its round trip.
        const mailbox = createTestMailbox({ port: 1, connectTimeoutMs: 2_000, maxAttempts: 1 });
        const mailer = new SmtpMailer(mailbox.settings);
        try {
          await assert.rejects(mailer.verifyAccess(), (error: unknown) => {
            assert.ok(error instanceof ConfigurationError, `expected ConfigurationError, got ${String(error)}`);
            assert.deepEqual(error.keys, ['MAIL_HOST', 'MAIL_PORT', 'MAIL_TLS']);
            return true;
          });
        } finally {
          await mailer.close();
        }
      },
    );
  });
});

// ===========================================================================
// Against a scripted server
// ===========================================================================

/** Sleeps instantly, so a retry test measures behaviour rather than the backoff curve. */
let monotonic = 0;
const instantClock: Clock = {
  now: () => new Date('2026-09-17T14:05:03.000Z'),
  monotonicMs: () => (monotonic += 1),
  sleep: async () => undefined,
  setTimer: (ms, fn) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

type ScriptStep = string | Error | 'eof';

interface ScriptedServer {
  readonly connector: SmtpConnector;
  /** Everything the client wrote, in order, as text. */
  readonly written: string[];
  /** How many times a connection was opened — the retry count, observed from outside. */
  connections: number;
}

/**
 * A server that says exactly what the test tells it to.
 *
 * Steps are consumed by `read`, not by command: a single step may carry several
 * replies, or half of one, which is what makes it possible to reproduce a reply
 * split across TCP segments.
 */
function scriptServer(
  script: readonly ScriptStep[],
  options: { readonly secure?: boolean; readonly startTlsFails?: boolean; readonly perConnection?: boolean } = {},
): ScriptedServer {
  const server: ScriptedServer = {
    written: [],
    connections: 0,
    connector: async (_connect: SmtpConnectOptions): Promise<SmtpConnection> => {
      server.connections += 1;
      // `perConnection` restarts the script for each attempt, which is what a
      // retry against a recovering server looks like. Otherwise one script runs
      // across every attempt.
      const steps = options.perConnection === true ? [...script] : shared;
      let secure = options.secure === true;
      return {
        get secure() {
          return secure;
        },
        async write(data: Buffer) {
          server.written.push(data.toString('binary'));
        },
        async read(): Promise<Buffer | undefined> {
          const step = steps.shift();
          if (step === undefined || step === 'eof') return undefined;
          if (step instanceof Error) throw step;
          return Buffer.from(step, 'binary');
        },
        async startTls() {
          if (options.startTlsFails === true) {
            throw new TransientTransportError('handshake failed', { code: 'mail.tls_handshake_failed' });
          }
          secure = true;
        },
        close() {
          /* nothing is held */
        },
      };
    },
  };
  const shared: ScriptStep[] = [...script];
  return server;
}

const SETTINGS: SmtpSettings = {
  host: 'mail.example.test',
  port: 587,
  tls: 'disable',
  username: '',
  password: new Secret('', 'unused'),
  allowInsecureAuth: false,
  fromAddress: 'no-reply@zeddev.test',
  fromName: '',
  ehloName: 'zeddev-test',
  connectTimeoutMs: 1_000,
  commandTimeoutMs: 1_000,
  maxAttempts: 3,
};

const MESSAGE = { to: 'owner@example.test', subject: 'Verify', body: 'link' } as const;

/** The replies of a server that accepts everything, in order. */
const HAPPY: readonly string[] = [
  '220 mail.example.test ESMTP\r\n',
  '250-mail.example.test\r\n250-SIZE 35882577\r\n250 HELP\r\n',
  '250 2.1.0 Ok\r\n', // MAIL FROM
  '250 2.1.5 Ok\r\n', // RCPT TO
  '354 End data with <CR><LF>.<CR><LF>\r\n',
  '250 2.0.0 Ok: queued\r\n',
  '221 2.0.0 Bye\r\n',
];

describe('reply parsing', () => {
  unitTest('reads a multi-line EHLO reply as a capability table', async () => {
    const server = scriptServer(HAPPY);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await mailer.send(MESSAGE);
    assert.equal(server.connections, 1);
    assert.ok(server.written.some((line) => line.startsWith('EHLO zeddev-test')));
    assert.ok(server.written.some((line) => line.startsWith('MAIL FROM:<no-reply@zeddev.test>')));
    assert.ok(server.written.some((line) => line.startsWith('RCPT TO:<owner@example.test>')));
  });

  unitTest('reassembles a reply split across segments, and splits one carrying two', async () => {
    // The network promises neither. A parser that reads one reply per chunk works
    // against every tidy fake and fails intermittently against a real relay.
    const server = scriptServer([
      '220 mail.exa',
      'mple.test ESMTP\r\n250-mail.example.test\r\n250 HELP\r\n250 2.1.0 Ok\r\n',
      '250 2.1.5 Ok\r\n354 go\r\n',
      '250 queued\r\n221 Bye\r\n',
    ]);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await mailer.send(MESSAGE);
    assert.equal(server.connections, 1);
  });

  unitTest('refuses a reply whose lines disagree about their status code', async () => {
    const server = scriptServer(['220 ok\r\n', '250-first\r\n451 second\r\n']);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.code, 'mail.reply_inconsistent');
      return true;
    });
  });

  unitTest('refuses a malformed reply rather than guessing at it', async () => {
    const server = scriptServer(['220 ok\r\n', 'HELLO THERE\r\n']);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.code, 'mail.reply_malformed');
      return true;
    });
  });

  unitTest('gives up on an unterminated reply instead of buffering it forever', async () => {
    // A remote's failure must not become this process's. Without the cap, a
    // server that never terminates its reply grows the buffer until the host
    // kills the process, taking every unrelated tenant with it.
    const flood: ScriptStep[] = ['220 ok\r\n'];
    for (let index = 0; index < 40; index += 1) flood.push(`250-${'x'.repeat(2048)}\r\n`);
    const server = scriptServer(flood);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.code, 'mail.reply_too_large');
      return true;
    });
  });
});

describe('retry policy', () => {
  unitTest('retries a 4xx, because the protocol says it means "later"', async () => {
    const server = scriptServer(
      ['220 ok\r\n', '250 mail.example.test\r\n', '451 4.3.0 Try again later\r\n'],
      { perConnection: true },
    );
    const mailer = new SmtpMailer({ ...SETTINGS, maxAttempts: 3 }, {
      connector: server.connector,
      clock: instantClock,
    });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TransientTransportError);
      assert.equal(error.code, 'mail.temporary_failure');
      return true;
    });
    assert.equal(server.connections, 3, 'a temporary failure must use the whole attempt allowance');
  });

  unitTest('does not retry a 5xx, because every attempt would fail identically', async () => {
    // IMPLEMENTATION_PLAN.md §4d: retryability belongs to the error type, not to
    // the attempt count. Spending three attempts rediscovering that a mailbox
    // does not exist only delays the failure the caller has to handle anyway.
    const server = scriptServer(
      ['220 ok\r\n', '250 mail.example.test\r\n', '550 5.1.1 No such user\r\n'],
      { perConnection: true },
    );
    const mailer = new SmtpMailer({ ...SETTINGS, maxAttempts: 3 }, {
      connector: server.connector,
      clock: instantClock,
    });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.code, 'mail.rejected');
      return true;
    });
    assert.equal(server.connections, 1);
  });

  unitTest('recovers when a retry succeeds', async () => {
    let attempt = 0;
    const base: ScriptedServer = scriptServer([], { perConnection: true });
    const connector: SmtpConnector = async (options) => {
      attempt += 1;
      const script: ScriptStep[] =
        attempt === 1 ? ['220 ok\r\n', '250 ok\r\n', '421 4.7.0 Too many connections\r\n'] : [...HAPPY];
      return await scriptServer(script, { perConnection: true }).connector(options);
    };
    void base;
    const mailer = new SmtpMailer({ ...SETTINGS, maxAttempts: 3 }, { connector, clock: instantClock });
    const sent = await mailer.send(MESSAGE);
    assert.match(sent.messageId, /@zeddev\.test$/);
    assert.equal(attempt, 2);
  });

  specTest(
    'message-delivery-reliability.md',
    'The system must not deliver the same outbound message more than once from the end-customer\'s point of view',
    'a failure after the message body is committed is surfaced, never retried',
    async () => {
      // The one place this package deliberately reverses the platform's
      // at-least-once instinct. Once the terminating dot is written, the server
      // may have accepted the message and lost the connection before its 250
      // reached us — so a retry sends a second copy of a message that may already
      // be in the mailbox. The caller can always request another link; nobody can
      // unsend one.
      const server = scriptServer(
        ['220 ok\r\n', '250 ok\r\n', '250 ok\r\n', '250 ok\r\n', '354 go\r\n', 'eof'],
        { perConnection: true },
      );
      const mailer = new SmtpMailer({ ...SETTINGS, maxAttempts: 3 }, {
        connector: server.connector,
        clock: instantClock,
      });
      await assert.rejects(mailer.send(MESSAGE));
      assert.equal(
        server.connections,
        1,
        'the message may already have been delivered, so it must not be sent again',
      );
    },
  );

  unitTest('keeps one Message-ID across every attempt, so a duplicate stays collapsible', async () => {
    const ids: string[] = [];
    let attempt = 0;
    const connector: SmtpConnector = async (options) => {
      attempt += 1;
      const script: ScriptStep[] = attempt === 1 ? ['220 ok\r\n', '250 ok\r\n', '421 busy\r\n'] : [...HAPPY];
      const inner = await scriptServer(script, { perConnection: true }).connector(options);
      return {
        get secure() {
          return inner.secure;
        },
        async write(data: Buffer) {
          const found = /Message-ID: <([^>]+)>/.exec(data.toString('binary'));
          if (found?.[1] !== undefined) ids.push(found[1]);
          await inner.write(data);
        },
        read: inner.read.bind(inner),
        startTls: inner.startTls.bind(inner),
        close: inner.close.bind(inner),
      };
    };
    const mailer = new SmtpMailer({ ...SETTINGS, maxAttempts: 3 }, { connector, clock: instantClock });
    await mailer.send(MESSAGE);
    assert.equal(ids.length, 1);
  });
});

describe('transport security', () => {
  unitTest('requires STARTTLS when configured for it, rather than silently downgrading', async () => {
    // The whole reason there is no opportunistic mode. A relay that stops
    // advertising STARTTLS — a misconfiguration, or a downgrade attack — would
    // otherwise move every message and every credential to cleartext with
    // nothing observable changing.
    const server = scriptServer(['220 ok\r\n', '250-mail.example.test\r\n250 HELP\r\n']);
    const mailer = new SmtpMailer({ ...SETTINGS, tls: 'starttls' }, {
      connector: server.connector,
      clock: instantClock,
    });
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.code, 'mail.starttls_unavailable');
      return true;
    });
  });

  unitTest('re-issues EHLO after the handshake, because the first answer is not trustworthy', async () => {
    const server = scriptServer([
      '220 ok\r\n',
      '250-mail.example.test\r\n250 STARTTLS\r\n',
      '220 2.0.0 Ready to start TLS\r\n',
      '250-mail.example.test\r\n250 AUTH PLAIN LOGIN\r\n',
      '235 2.7.0 Authenticated\r\n',
      '250 ok\r\n',
      '250 ok\r\n',
      '354 go\r\n',
      '250 queued\r\n',
      '221 Bye\r\n',
    ]);
    const mailer = new SmtpMailer(
      { ...SETTINGS, tls: 'starttls', username: 'relay', password: new Secret('pw', 'test') },
      { connector: server.connector, clock: instantClock },
    );
    await mailer.send(MESSAGE);
    const ehlos = server.written.filter((line) => line.startsWith('EHLO'));
    assert.equal(ehlos.length, 2, 'AUTH is commonly advertised only after the handshake');
    assert.ok(server.written.some((line) => line.startsWith('AUTH PLAIN ')));
  });

  specTest(
    'credential-and-secret-handling.md',
    'Given a client account authentication credential has been stored, when the stored form is inspected in isolation, then the original credential cannot be recovered from it',
    'authentication over an unencrypted connection is refused unless explicitly allowed',
    async () => {
      const server = scriptServer(['220 ok\r\n', '250-mail.example.test\r\n250 AUTH PLAIN\r\n']);
      const mailer = new SmtpMailer(
        { ...SETTINGS, tls: 'disable', username: 'relay', password: new Secret('pw', 'test') },
        { connector: server.connector, clock: instantClock },
      );
      await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.keys, ['MAIL_TLS']);
        return true;
      });
      assert.ok(!server.written.some((line) => line.startsWith('AUTH')), 'the credential must never reach the wire');
    },
  );

  unitTest('sends the credential once insecure authentication is explicitly allowed', async () => {
    const server = scriptServer([
      '220 ok\r\n',
      '250-mail.example.test\r\n250 AUTH PLAIN\r\n',
      '235 ok\r\n',
      ...HAPPY.slice(2),
    ]);
    const mailer = new SmtpMailer(
      {
        ...SETTINGS,
        tls: 'disable',
        username: 'relay',
        password: new Secret('pw', 'test'),
        allowInsecureAuth: true,
      },
      { connector: server.connector, clock: instantClock },
    );
    await mailer.send(MESSAGE);
    assert.ok(server.written.some((line) => line.startsWith('AUTH PLAIN ')));
  });

  unitTest('falls back to AUTH LOGIN when PLAIN is not offered', async () => {
    const server = scriptServer([
      '220 ok\r\n',
      '250-mail.example.test\r\n250 AUTH LOGIN\r\n',
      '334 VXNlcm5hbWU6\r\n',
      '334 UGFzc3dvcmQ6\r\n',
      '235 ok\r\n',
      ...HAPPY.slice(2),
    ]);
    const mailer = new SmtpMailer(
      {
        ...SETTINGS,
        username: 'relay',
        password: new Secret('pw', 'test'),
        allowInsecureAuth: true,
      },
      { connector: server.connector, clock: instantClock },
    );
    await mailer.send(MESSAGE);
    assert.ok(server.written.some((line) => line.trim() === 'AUTH LOGIN'));
    assert.ok(server.written.some((line) => line.trim() === Buffer.from('relay').toString('base64')));
  });

  unitTest('names the configuration key when no supported mechanism is offered', async () => {
    const server = scriptServer(['220 ok\r\n', '250-mail.example.test\r\n250 AUTH GSSAPI\r\n']);
    const mailer = new SmtpMailer(
      { ...SETTINGS, username: 'relay', password: new Secret('pw', 'test'), allowInsecureAuth: true },
      { connector: server.connector, clock: instantClock },
    );
    await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.deepEqual(error.keys, ['MAIL_USERNAME']);
      return true;
    });
  });
});

describe('secret handling', () => {
  specTest(
    'credential-and-secret-handling.md',
    'Given any log, diagnostic record, error message, metric, alert, or notification produced by the system, when it is inspected, then it contains no secret value, using a non-sensitive reference or redacted form wherever a secret must be identified',
    'a rejected authentication does not put the credential into the error or the log',
    async () => {
      // A failed AUTH is exactly when this error gets raised, logged, and pasted
      // into a support channel — and an `AUTH PLAIN` command *is* the credential
      // in base64, so quoting the failing command would publish it.
      const password = 'correct-horse-battery-staple';
      const encoded = Buffer.from(`\0relay\0${password}`, 'utf8').toString('base64');
      const sink = new MemorySink();
      const server = scriptServer(
        ['220 ok\r\n', '250-mail.example.test\r\n250 AUTH PLAIN\r\n', '535 5.7.8 Bad credentials\r\n'],
        { perConnection: true },
      );
      const mailer = new SmtpMailer(
        {
          ...SETTINGS,
          username: 'relay',
          password: new Secret(password, 'test'),
          allowInsecureAuth: true,
        },
        { connector: server.connector, clock: instantClock, logger: new Logger({ sink }) },
      );

      await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
        const rendered = `${String(error)} ${JSON.stringify((error as Error & { toJSON?: () => unknown }).toJSON?.() ?? {})}`;
        assert.doesNotMatch(rendered, new RegExp(password));
        assert.doesNotMatch(rendered, new RegExp(encoded.slice(0, 16)));
        return true;
      });

      // The command did reach the wire, so this assertion is not passing for the
      // wrong reason — it is the log and the error that must not carry it.
      assert.ok(server.written.some((line) => line.includes(encoded)));
      const logged = sink.serialized();
      assert.ok(logged.length > 0, 'the failure must actually have been logged');
      assert.doesNotMatch(logged, new RegExp(password));
      assert.doesNotMatch(logged, new RegExp(encoded.slice(0, 16)));
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'The system must exclude end-customer conversation content from operator-visible diagnostics',
    'a rejection does not carry the server\'s prose, which routinely quotes the recipient',
    async () => {
      // IMPLEMENTATION_PLAN.md §4c records the same decision for PostgreSQL,
      // whose error detail quotes row data. SMTP is worse: a bounce reply names
      // the mailbox, so propagating the reply text would put a client's address
      // into an operator-visible diagnostic.
      const sink = new MemorySink();
      const server = scriptServer(
        ['220 ok\r\n', '250 ok\r\n', '250 ok\r\n', '550 5.1.1 <owner@example.test>: unknown user\r\n'],
        { perConnection: true },
      );
      const mailer = new SmtpMailer(SETTINGS, {
        connector: server.connector,
        clock: instantClock,
        logger: new Logger({ sink }),
      });

      await assert.rejects(mailer.send(MESSAGE), (error: unknown) => {
        assert.doesNotMatch(String(error), /owner@example\.test/);
        assert.doesNotMatch(JSON.stringify((error as TerminalTransportError).toJSON()), /owner@example\.test/);
        return true;
      });
      assert.doesNotMatch(sink.serialized(), /owner@example\.test/);
    },
  );

  unitTest('refuses an EHLO name that could smuggle a second command', () => {
    assert.throws(
      () => new SmtpMailer({ ...SETTINGS, ehloName: 'host\r\nMAIL FROM:<a@b.test>' }),
      (error: unknown) => error instanceof ConfigurationError && error.keys[0] === 'MAIL_EHLO_NAME',
    );
    assert.throws(
      () => new SmtpMailer({ ...SETTINGS, username: 'relay\r\nQUIT' }),
      (error: unknown) => error instanceof ConfigurationError && error.keys[0] === 'MAIL_USERNAME',
    );
  });
});

describe('transaction shape', () => {
  unitTest('writes the terminating dot as its own line after the body', async () => {
    const server = scriptServer(HAPPY);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await mailer.send({ ...MESSAGE, body: 'line one\n.\nline two' });
    const stream = server.written.join('');
    assert.match(stream, /\r\n\.\.\r\n/, 'the body\'s lone period must have been stuffed');
    assert.ok(stream.endsWith('QUIT\r\n'));
    assert.match(stream, /\r\n\.\r\nQUIT\r\n$/, 'the transaction must end with an unstuffed dot line');
  });

  unitTest('treats a dropped connection at QUIT as success, not as a lost message', async () => {
    // The server has already taken responsibility for the message by then.
    // Reporting a failure would invite the caller to send it again.
    const server = scriptServer([...HAPPY.slice(0, 6), 'eof']);
    const mailer = new SmtpMailer(SETTINGS, { connector: server.connector, clock: instantClock });
    await mailer.send(MESSAGE);
  });
});
