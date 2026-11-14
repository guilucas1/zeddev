/**
 * The mail client's two TLS modes, against real servers that speak TLS.
 *
 * The VPS tier reaches its relay with `MAIL_TLS=starttls` and the managed-cloud
 * tier with `MAIL_TLS=implicit` (`DEPLOYMENT_TIERS`). Until the test servers spoke
 * TLS, no test had completed either handshake: the laptop tier uses `disable`,
 * `tiers.test.ts` catches mail in memory, and the TLS tests against the connector
 * seam stop at the STARTTLS reply. So the two tiers whose mail transport differs
 * were the two with no evidence for it (`environment-portability.md` AC2, AC3).
 *
 * `scripts/mail.sh` runs one Mailpit offering STARTTLS and one speaking TLS from
 * the first byte, both with a certificate naming `localhost` under an authority it
 * generates. Connecting by `127.0.0.1` is therefore a name the certificate does
 * not carry, which is what proves hostname verification is on.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ConfigurationError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { specTest, unitTest } from '@zeddev/testing';
import { runMailConformance, type MailFixture } from './conformance.ts';
import { createTestTlsMailbox, decodeMail, mailTestConfigured, SKIP_REASON } from './fixtures.ts';
import { SmtpMailer } from './smtp.ts';
import { createConnector, type SmtpConnection, type SmtpConnector } from './socket.ts';
import type { SmtpSettings } from './types.ts';

const MODES = ['starttls', 'implicit'] as const;
type Mode = (typeof MODES)[number];

const TIER_CRITERION: Readonly<Record<Mode, string>> = {
  starttls: 'AC2 the system becomes fully functional on a low-cost VPS from documented configuration alone',
  implicit: 'AC3 the system becomes fully functional on a managed cloud provider from documented configuration alone',
};

/** The real connector, counting how often it was asked and keeping what it opened. */
function recordingConnector(): { connector: SmtpConnector; opened: SmtpConnection[]; calls: () => number } {
  const real = createConnector();
  const opened: SmtpConnection[] = [];
  let calls = 0;
  return {
    opened,
    calls: () => calls,
    connector: async (options) => {
      calls += 1;
      const connection = await real(options);
      opened.push(connection);
      return connection;
    },
  };
}

function quietMailer(settings: SmtpSettings, connector?: SmtpConnector): SmtpMailer {
  return new SmtpMailer(settings, { connector, logger: new Logger({ sink: new MemorySink() }) });
}

const MESSAGE_SUBJECT = 'Confirm your address';

describe('smtp mailer over TLS', { skip: mailTestConfigured() ? false : SKIP_REASON }, () => {
  for (const mode of MODES) {
    // The whole port contract, over each encrypted transport: the same suite the
    // cleartext server and the in-memory fake answer to, including verifyAccess,
    // which is the preflight the API runs at startup.
    runMailConformance({
      label: `smtp over ${mode}`,
      async create(): Promise<MailFixture> {
        const mailbox = createTestTlsMailbox(mode);
        const mailer = quietMailer(mailbox.settings);
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
    });

    specTest(
      'environment-portability.md',
      TIER_CRITERION[mode],
      `mail is delivered over a verified ${mode} connection, authenticating only once it is encrypted`,
      async () => {
        const mailbox = createTestTlsMailbox(mode);
        assert.ok(mailbox.settings.username.length > 0, 'the fixture authenticates, so the credential crosses the connection');
        assert.equal(mailbox.settings.allowInsecureAuth, false);
        const recorder = recordingConnector();
        const mailer = quietMailer(mailbox.settings, recorder.connector);

        await mailer.send({ to: mailbox.recipient('owner'), subject: MESSAGE_SUBJECT, body: 'Follow the link.' });

        assert.equal(recorder.opened.length, 1);
        assert.equal(recorder.opened[0]?.secure, true, 'the session that carried the message was encrypted');
        const received = (await mailbox.rawMessages()).map((raw) => decodeMail(raw));
        assert.deepEqual(
          received.map((mail) => mail.subject),
          [MESSAGE_SUBJECT],
        );
      },
    );

    specTest(
      'environment-portability.md',
      'AC7 startup fails with a clear error identifying the invalid configuration',
      `${mode}: a certificate naming another host is refused once, naming MAIL_HOST`,
      async () => {
        // Same server, reached by an address its certificate does not carry.
        const mailbox = createTestTlsMailbox(mode, { host: '127.0.0.1' });
        const recorder = recordingConnector();
        const mailer = quietMailer(mailbox.settings, recorder.connector);

        await assert.rejects(mailer.verifyAccess(), (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.deepEqual(error.keys, ['MAIL_HOST']);
          assert.match(error.message, /ERR_TLS_CERT_ALTNAME_INVALID/);
          return true;
        });
        await assert.rejects(
          mailer.send({ to: mailbox.recipient('owner'), subject: MESSAGE_SUBJECT, body: 'x' }),
          ConfigurationError,
        );
        // One for verifyAccess, one for send: a certificate verdict is not retried,
        // because every attempt would reach the same one.
        assert.equal(recorder.calls(), 2);
        assert.deepEqual(await mailbox.rawMessages(), []);
      },
    );

    specTest(
      'environment-portability.md',
      'AC7 startup fails with a clear error identifying the invalid configuration',
      `${mode}: a certificate from an authority not trusted is refused, naming MAIL_CA_CERTIFICATE`,
      async () => {
        // No MAIL_CA_CERTIFICATE: the system store, which does not hold the test authority.
        const mailbox = createTestTlsMailbox(mode, { caCertificate: undefined });
        const mailer = quietMailer(mailbox.settings);
        await assert.rejects(mailer.verifyAccess(), (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.deepEqual(error.keys, ['MAIL_CA_CERTIFICATE']);
          return true;
        });
      },
    );
  }

  unitTest('implicit TLS against a STARTTLS server fails at connect and names MAIL_TLS among the keys', async () => {
    // The VPS tier's port with the managed tier's mode: the server greets in
    // cleartext, which is not a TLS record. Not a certificate verdict, so it
    // keeps the transient classification and the phase names the keys.
    const starttls = createTestTlsMailbox('starttls');
    const mailer = quietMailer({ ...starttls.settings, tls: 'implicit', connectTimeoutMs: 3_000 });
    await assert.rejects(mailer.verifyAccess(), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.keys.includes('MAIL_TLS'), `expected MAIL_TLS among ${error.keys.join(', ')}`);
      return true;
    });
  });

  unitTest('STARTTLS against an implicit-TLS server fails waiting for the greeting and names MAIL_TLS', async () => {
    // The other way round: the client waits for a cleartext greeting the server
    // will only send inside TLS.
    const implicit = createTestTlsMailbox('implicit');
    const mailer = quietMailer({ ...implicit.settings, tls: 'starttls', commandTimeoutMs: 1_000 });
    await assert.rejects(mailer.verifyAccess(), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.keys.includes('MAIL_TLS'), `expected MAIL_TLS among ${error.keys.join(', ')}`);
      return true;
    });
  });
});
