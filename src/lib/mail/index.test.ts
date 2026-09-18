/**
 * The adapter-independent half of `@zeddev/mail`.
 *
 * Runs the shared conformance suite against the in-memory fake, then checks the
 * pieces that have no server in them at all: the message encoder, the address
 * rules, and the environment schema. The encoder gets the closest attention
 * because its failures are the quiet ones — a wrongly split encoded word does not
 * throw, it arrives as a subject full of replacement characters in somebody
 * else's mail client, where nobody in this repo will ever see it.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ConfigurationError, ValidationError } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import {
  assertEnvelopeAddress,
  buildMessage,
  dataTerminator,
  dotStuff,
  encodeHeaderText,
  formatAddressHeader,
  formatDate,
  loadMailConfig,
  loadSmtpSettings,
  MAIL_CONFIG_SCHEMA,
  mintMessageId,
} from './index.ts';
import {
  decodeMail,
  InMemoryMailer,
  runMailConformance,
  type MailFixture,
  type MailHarness,
} from './testing.ts';

// ---------------------------------------------------------------------------
// The fake, under the shared suite
// ---------------------------------------------------------------------------

const FROM = 'no-reply@zeddev.test';

const memoryHarness: MailHarness = {
  label: 'in-memory',
  async create(): Promise<MailFixture> {
    const mailer = new InMemoryMailer({ fromAddress: FROM });
    return {
      mailer,
      fromAddress: FROM,
      recipient: (localPart: string): string => `${localPart}@mailbox.test`,
      async received() {
        return mailer.delivered.map((message) => decodeMail(message.raw));
      },
      async dispose() {
        await mailer.close();
      },
    };
  },
};

runMailConformance(memoryHarness);

// ---------------------------------------------------------------------------
// Address rules
// ---------------------------------------------------------------------------

describe('envelope addresses', () => {
  unitTest('accepts ordinary addresses unchanged, including their casing', () => {
    // Not lower-cased on purpose: canonicalisation is `@zeddev/identity`'s
    // decision, and a transport that quietly made a different one would send a
    // reset link to an address the account row does not contain.
    assert.equal(assertEnvelopeAddress('Owner.Name+tag@Example.co.uk', 'to'), 'Owner.Name+tag@Example.co.uk');
    assert.equal(assertEnvelopeAddress('  spaced@example.test  ', 'to'), 'spaced@example.test');
  });

  unitTest('names the field it was given, so a caller can report which input failed', () => {
    try {
      assertEnvelopeAddress('nope', 'replyTo');
      assert.fail('expected a rejection');
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      assert.equal(error.issues[0]?.key, 'replyTo');
    }
  });

  specTest(
    'credential-and-secret-handling.md',
    'Given any log, diagnostic record, error message, metric, alert, or notification produced by the system, when it is inspected, then it contains no secret value',
    'a rejection does not echo the offending characters back into its own reason',
    () => {
      // The reason string is a diagnostic and will be logged. Quoting the input
      // into it is how a CRLF injection attempt reaches the log line that was
      // supposed to report it, and how a mail header splits a log record in two.
      try {
        assertEnvelopeAddress('victim@example.test\r\nBcc: attacker@evil.test', 'to');
        assert.fail('expected a rejection');
      } catch (error) {
        assert.ok(error instanceof ValidationError);
        const reason = error.issues[0]?.reason ?? '';
        assert.doesNotMatch(reason, /[\r\n]/);
        assert.doesNotMatch(reason, /attacker/);
      }
    },
  );

  unitTest('refuses every address shape that could change an SMTP command', () => {
    for (const candidate of [
      'a@b.test\r\nRCPT TO:<c@d.test>',
      'a@b.test\nX',
      'a\u0000@b.test',
      'a b@c.test',
      'a@b .test',
      '<a@b.test>',
      'a@b.test,c@d.test',
      'a@b.test;c@d.test',
      '"a"@b.test',
      'a(comment)@b.test',
      'a@[127.0.0.1]',
      'a@b',
      'a@.b.test',
      'a@b-.test',
      '@b.test',
      'a@',
    ]) {
      assert.throws(
        () => assertEnvelopeAddress(candidate, 'to'),
        ValidationError,
        `expected ${JSON.stringify(candidate)} to be refused`,
      );
    }
  });

  specTest(
    'client-signup-and-tenancy.md',
    'Given a client forgets their password, when they use the account recovery flow, then they regain access to their existing tenant without operator involvement',
    'accepts every address @zeddev/identity would accept, so no account can be created that cannot be mailed',
    () => {
      // The direction of this subset relation is the point. Were the mailer
      // stricter than the signup form, a client could create an account and then
      // never receive a verification or reset link, with no visible error and no
      // way to recover — which is exactly the operator involvement this criterion
      // forbids. `@zeddev/identity` is not imported here: a transport must not
      // depend on a domain library, so the relation is pinned by example instead.
      for (const address of [
        'a@b.co',
        'owner@example.com',
        'first.last@sub.domain.example.com',
        "o'brien+tag@example.com",
        'a!#$%&*+-/=?^_`{|}~@example.com',
        `${'a'.repeat(64)}@example.com`,
      ]) {
        assert.equal(assertEnvelopeAddress(address, 'to'), address);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Header encoding
// ---------------------------------------------------------------------------

describe('header encoding', () => {
  unitTest('leaves an ASCII value readable rather than encoding it anyway', () => {
    assert.equal(encodeHeaderText('Confirm your email address'), 'Confirm your email address');
  });

  unitTest('splits a long non-ASCII value on character boundaries, never byte boundaries', () => {
    // Each emoji is four UTF-8 bytes, so a 45-byte chunk holds eleven with one
    // byte spare. An encoder that split by byte would cut the twelfth in half and
    // produce two encoded words that decode to replacement characters.
    const value = '🙂'.repeat(40);
    const encoded = encodeHeaderText(value);
    const words = encoded.split('\r\n ');
    assert.ok(words.length > 1, 'a value this long must be split across encoded words');
    for (const word of words) {
      assert.ok(word.length <= 75, `encoded word exceeds RFC 2047's 75-character limit: ${word.length}`);
      assert.match(word, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=$/);
      // Each word must decode to whole characters on its own.
      const payload = word.slice('=?UTF-8?B?'.length, -'?='.length);
      const decoded = Buffer.from(payload, 'base64').toString('utf8');
      assert.doesNotMatch(decoded, /�/, 'an encoded word decoded to a replacement character');
    }
  });

  unitTest('escapes a display name rather than letting it close its own quoted string', () => {
    assert.equal(formatAddressHeader('a@b.test', ''), '<a@b.test>');
    assert.equal(formatAddressHeader('a@b.test', 'Acme Ltd'), '"Acme Ltd" <a@b.test>');
    assert.equal(
      formatAddressHeader('a@b.test', 'Acme "The Best" \\ Ltd'),
      '"Acme \\"The Best\\" \\\\ Ltd" <a@b.test>',
    );
  });

  unitTest('does not quote an encoded display name, which no client would decode', () => {
    const header = formatAddressHeader('a@b.test', 'Café Ludoteca');
    assert.match(header, /^=\?UTF-8\?B\?[^ ]+\?= <a@b\.test>$/);
    assert.doesNotMatch(header, /"/);
  });

  unitTest('renders an RFC 5322 date in UTC regardless of the host timezone', () => {
    assert.equal(formatDate(new Date('2026-09-17T14:05:03.000Z')), 'Thu, 17 Sep 2026 14:05:03 +0000');
    assert.equal(formatDate(new Date('2026-01-01T00:00:00.000Z')), 'Thu, 01 Jan 2026 00:00:00 +0000');
  });
});

// ---------------------------------------------------------------------------
// Message assembly
// ---------------------------------------------------------------------------

const BASE = {
  from: FROM,
  fromName: '',
  to: 'owner@example.test',
  subject: 'Subject',
  body: 'Body',
  messageId: 'abc@zeddev.test',
  date: new Date('2026-09-17T14:05:03.000Z'),
} as const;

describe('message assembly', () => {
  unitTest('chooses 7bit for an ASCII body so a raw message stays readable', () => {
    const built = buildMessage(BASE);
    const text = built.raw.toString('utf8');
    assert.match(text, /^Content-Transfer-Encoding: 7bit$/m);
    assert.match(text, /\r\n\r\nBody$/, 'the body must not carry its own framing newline');
  });

  unitTest('switches to base64 the moment 7bit would corrupt the body', () => {
    for (const body of ['naïve', 'a\u0000b', `x${'y'.repeat(1000)}`]) {
      const built = buildMessage({ ...BASE, body });
      assert.match(
        built.raw.toString('utf8'),
        /^Content-Transfer-Encoding: base64$/m,
        `expected base64 for ${JSON.stringify(body.slice(0, 20))}`,
      );
      assert.equal(decodeMail(built.raw).body, body);
    }
  });

  unitTest('wraps base64 within the line length every relay accepts', () => {
    const built = buildMessage({ ...BASE, body: 'é'.repeat(5000) });
    const body = built.raw.toString('utf8').split('\r\n\r\n')[1] ?? '';
    for (const line of body.split('\r\n')) {
      assert.ok(line.length <= 76, `base64 line of ${line.length} exceeds 76`);
    }
  });

  unitTest('normalises any mix of line endings to CRLF', () => {
    const built = buildMessage({ ...BASE, body: 'a\nb\r\nc\rd' });
    assert.doesNotMatch(built.raw.toString('binary').replace(/\r\n/g, ''), /[\r\n]/);
  });

  unitTest('validates before writing, so a refused message leaves nothing half-built', () => {
    assert.throws(() => buildMessage({ ...BASE, to: 'bad' }), ValidationError);
    assert.throws(() => buildMessage({ ...BASE, subject: 'a\r\nb' }), ValidationError);
    assert.throws(() => buildMessage({ ...BASE, fromName: 'a\nb' }), ValidationError);
    assert.throws(() => buildMessage({ ...BASE, subject: 'x'.repeat(513) }), ValidationError);
    assert.throws(() => buildMessage({ ...BASE, from: 'not an address' }), ValidationError);
  });

  unitTest('keeps a tab in a subject, which is legal folding whitespace', () => {
    const built = buildMessage({ ...BASE, subject: 'a\tb' });
    assert.equal(decodeMail(built.raw).subject, 'a\tb');
  });

  unitTest('mints a Message-ID in the sending domain, unguessably', () => {
    const first = mintMessageId('no-reply@zeddev.test');
    const second = mintMessageId('no-reply@zeddev.test');
    assert.match(first, /^[0-9a-f]{32}@zeddev\.test$/);
    assert.notEqual(first, second);
  });
});

describe('DATA framing', () => {
  unitTest('supplies the terminator\'s leading CRLF only when the message lacks one', () => {
    // This is the bug this package shipped: writing a full `\r\n.\r\n` after a
    // message that already ended in CRLF appended a blank line to every message
    // sent. It is invisible against a fake built from the same misreading, and a
    // real server reproduces it on the first message — which is how it was found.
    assert.equal(dataTerminator(Buffer.from('End.')).toString(), '\r\n.\r\n');
    assert.equal(dataTerminator(Buffer.from('End.\r\n')).toString(), '.\r\n');
    assert.equal(dataTerminator(Buffer.from('')).toString(), '\r\n.\r\n');
  });

  unitTest('a body never ends with its own line break, whichever encoding is chosen', () => {
    // The invariant that lets the two transfer encodings agree. SMTP cannot
    // represent a trailing newline in a 7bit body — the terminator consumes it —
    // while base64 can, so without normalising, a caller would see a trailing
    // newline preserved or dropped depending on whether their text happened to
    // contain a non-ASCII character.
    for (const body of ['End.', 'End.\n', 'End.\r\n', 'End.\n\n\n', 'naïve\n', 'naïve\n\n']) {
      const built = buildMessage({ ...BASE, body });
      const tail = built.raw.toString('binary').slice(-2);
      assert.notEqual(tail, '\r\n', `built message for ${JSON.stringify(body)} ends with framing`);
      assert.equal(decodeMail(built.raw).body, body.replace(/(?:\r\n|\r|\n)+$/, ''));
    }
  });
});

describe('dot stuffing', () => {
  unitTest('doubles a period only where it begins a line', () => {
    assert.equal(dotStuff(Buffer.from('a\r\n.\r\nb\r\n')).toString(), 'a\r\n..\r\nb\r\n');
    assert.equal(dotStuff(Buffer.from('.hidden\r\n')).toString(), '..hidden\r\n');
    assert.equal(dotStuff(Buffer.from('a.b\r\n')).toString(), 'a.b\r\n');
    assert.equal(dotStuff(Buffer.from('a\r\nb.c\r\n')).toString(), 'a\r\nb.c\r\n');
  });

  unitTest('preserves every byte value, so a base64 body is not mangled', () => {
    const raw = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
    const stuffed = dotStuff(raw);
    assert.deepEqual(stuffed.subarray(0, 0x2e), raw.subarray(0, 0x2e));
    assert.equal(stuffed.length >= raw.length, true);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MINIMAL_ENV = {
  MAIL_HOST: 'mail.example.test',
  MAIL_FROM_ADDRESS: 'no-reply@example.test',
} as const;

describe('configuration', () => {
  specTest(
    'environment-portability.md',
    'Given a required configuration value is missing or invalid for the target environment, when the system attempts to start, then it reports a clear error identifying the missing/invalid configuration rather than starting in a broken or partially functional state',
    'startup names every missing mail key at once rather than one per restart',
    () => {
      try {
        loadMailConfig({});
        assert.fail('expected a configuration failure');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.keys, ['MAIL_FROM_ADDRESS', 'MAIL_HOST']);
      }
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'Given a required secret is missing from the environment\'s configuration, when the system attempts to start, then it fails with a clear error identifying the missing secret rather than starting in a partially functional or insecure state',
    'the mail password arrives wrapped so it cannot be serialised by accident',
    () => {
      const config = loadMailConfig({ ...MINIMAL_ENV, MAIL_PASSWORD: 'hunter2-hunter2' });
      assert.ok(config.MAIL_PASSWORD instanceof Secret);
      assert.equal(config.MAIL_PASSWORD.expose(), 'hunter2-hunter2');
      assert.doesNotMatch(JSON.stringify(config), /hunter2/);
      assert.doesNotMatch(String(config.MAIL_PASSWORD), /hunter2/);
    },
  );

  unitTest('defaults leave a deployment on STARTTLS with authentication off', () => {
    const settings = loadSmtpSettings(MINIMAL_ENV);
    assert.equal(settings.tls, 'starttls');
    assert.equal(settings.allowInsecureAuth, false);
    assert.equal(settings.username, '');
    assert.equal(settings.port, 587);
    assert.equal(settings.maxAttempts, 4);
    assert.equal(settings.caCertificate, undefined);
  });

  unitTest('carries every configured value through to the adapter settings', () => {
    const settings = loadSmtpSettings({
      ...MINIMAL_ENV,
      MAIL_PORT: '2525',
      MAIL_TLS: 'implicit',
      MAIL_USERNAME: 'relay-user',
      MAIL_PASSWORD: 'relay-pass',
      MAIL_ALLOW_INSECURE_AUTH: 'true',
      MAIL_FROM_NAME: 'Acme',
      MAIL_EHLO_NAME: 'mail.acme.test',
      MAIL_CONNECT_TIMEOUT: '5s',
      MAIL_COMMAND_TIMEOUT: '45s',
      MAIL_MAX_ATTEMPTS: '2',
      MAIL_CA_CERTIFICATE: '-----BEGIN CERTIFICATE-----',
    });
    assert.equal(settings.port, 2525);
    assert.equal(settings.tls, 'implicit');
    assert.equal(settings.username, 'relay-user');
    assert.equal(settings.password.expose(), 'relay-pass');
    assert.equal(settings.allowInsecureAuth, true);
    assert.equal(settings.fromName, 'Acme');
    assert.equal(settings.ehloName, 'mail.acme.test');
    assert.equal(settings.connectTimeoutMs, 5_000);
    assert.equal(settings.commandTimeoutMs, 45_000);
    assert.equal(settings.maxAttempts, 2);
    assert.equal(settings.caCertificate, '-----BEGIN CERTIFICATE-----');
  });

  specTest(
    'environment-portability.md',
    'Given the system\'s source code, when it is inspected for environment-detection branching (e.g., "if environment == X"), then no such branching affecting functional behavior is found',
    'TLS is a configured value with no opportunistic mode to fall back through',
    () => {
      assert.deepEqual(MAIL_CONFIG_SCHEMA.MAIL_TLS.values, ['disable', 'starttls', 'implicit']);
      // The tempting violation for a mail client specifically: infer TLS from the
      // port, 465 meaning implicit and 587 meaning STARTTLS. That is environment
      // detection wearing a disguise, and it is why the port has no say here.
      assert.equal(loadSmtpSettings({ ...MINIMAL_ENV, MAIL_PORT: '465' }).tls, 'starttls');
      assert.equal(loadSmtpSettings({ ...MINIMAL_ENV, MAIL_PORT: '25' }).tls, 'starttls');
    },
  );

  unitTest('rejects a TLS mode outside the vocabulary rather than guessing', () => {
    assert.throws(
      () => loadMailConfig({ ...MINIMAL_ENV, MAIL_TLS: 'opportunistic' }),
      ConfigurationError,
    );
  });
});

// ---------------------------------------------------------------------------
// The fake's own contract
// ---------------------------------------------------------------------------

describe('in-memory mailer', () => {
  unitTest('validates before an injected failure can mask the refusal', async () => {
    // Otherwise a message this port would never send looks merely unlucky, and a
    // caller written against the fake would add a retry around it.
    const mailer = new InMemoryMailer({ fromAddress: FROM });
    mailer.failNext(new Error('transport is down'));
    await assert.rejects(
      mailer.send({ to: 'bad address', subject: 'x', body: 'y' }),
      ValidationError,
    );
  });

  unitTest('queues failures so a caller\'s retry path can be driven', async () => {
    const mailer = new InMemoryMailer({ fromAddress: FROM });
    mailer.failNext(new Error('first'));
    mailer.failNext(new Error('second'));
    await assert.rejects(mailer.send({ to: 'a@b.test', subject: 'x', body: 'y' }), /first/);
    await assert.rejects(mailer.send({ to: 'a@b.test', subject: 'x', body: 'y' }), /second/);
    await mailer.send({ to: 'a@b.test', subject: 'x', body: 'y' });
    assert.equal(mailer.delivered.length, 1);
  });

  unitTest('can be made to fail its startup check', async () => {
    const mailer = new InMemoryMailer();
    mailer.setAccessFailure(new ConfigurationError([{ key: 'MAIL_HOST', reason: 'unreachable' }]));
    await assert.rejects(mailer.verifyAccess(), ConfigurationError);
    mailer.setAccessFailure(undefined);
    await mailer.verifyAccess();
  });
});
