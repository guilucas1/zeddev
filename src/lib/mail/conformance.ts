/**
 * The single definition of what the mail port means.
 *
 * Runs unchanged against the in-memory fake and against a real SMTP server. That
 * is the whole point: IMPLEMENTATION_PLAN.md §4d records that a fake which
 * behaves differently from its real counterpart turns every test above the port
 * into evidence about a system nobody deploys, and — worse — nothing fails to
 * reveal it. Mail is a particularly easy place for that to happen, because the
 * obvious fake is "push the object onto an array", which validates nothing,
 * encodes nothing, and would let a header-injection bug or a broken Unicode
 * subject pass every test in the repo and fail on the first real signup.
 *
 * Read this file to learn the port's semantics. `types.ts` states the guarantees;
 * this is where they are checked.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { decodeMail, type DecodedMail } from './fixtures.ts';
import type { Mailer } from './types.ts';

export interface MailFixture {
  readonly mailer: Mailer;
  readonly fromAddress: string;
  /** An address this fixture alone observes, so parallel suites cannot see each other's mail. */
  recipient(localPart: string): string;
  /** Everything delivered to this fixture, oldest first, decoded from the wire bytes. */
  received(): Promise<readonly DecodedMail[]>;
  dispose(): Promise<void>;
}

export interface MailHarness {
  readonly label: string;
  create(): Promise<MailFixture>;
}

export function runMailConformance(harness: MailHarness): void {
  describe(`mail conformance: ${harness.label}`, () => {
    async function withFixture(body: (fixture: MailFixture) => Promise<void>): Promise<void> {
      const fixture = await harness.create();
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    }

    const name = (what: string): string => `[${harness.label}] ${what}`;

    // -----------------------------------------------------------------------
    // Delivery
    // -----------------------------------------------------------------------

    specTest(
      'client-signup-and-tenancy.md',
      'The system must verify that the signup email address is valid and controlled by the signer before the account is treated as active',
      name('a message reaches the address it was addressed to, intact'),
      async () => {
        await withFixture(async (fixture) => {
          const to = fixture.recipient('owner');
          const sent = await fixture.mailer.send({
            to,
            subject: 'Confirm your email address',
            body: 'Open this link to finish signing up:\nhttps://example.test/verify?token=zev1_abc\n',
          });

          const received = await fixture.received();
          assert.equal(received.length, 1, 'exactly one message must have been delivered');
          const message = received[0]!;
          assert.equal(message.to, to);
          assert.equal(message.from, fixture.fromAddress);
          assert.equal(message.subject, 'Confirm your email address');
          assert.match(message.body, /token=zev1_abc/);
          assert.equal(
            message.messageId,
            sent.messageId,
            'the reported id must be the one actually on the message, or it is useless for tracing a delivery',
          );
        });
      },
    );

    unitTest(name('each message carries a distinct Message-ID'), async () => {
      await withFixture(async (fixture) => {
        const first = await fixture.mailer.send({
          to: fixture.recipient('a'),
          subject: 'One',
          body: 'one',
        });
        const second = await fixture.mailer.send({
          to: fixture.recipient('b'),
          subject: 'Two',
          body: 'two',
        });
        assert.notEqual(first.messageId, second.messageId);
      });
    });

    unitTest(name('an optional Reply-To is carried, and absent when not asked for'), async () => {
      await withFixture(async (fixture) => {
        await fixture.mailer.send({
          to: fixture.recipient('with-reply'),
          subject: 'With',
          body: 'body',
          replyTo: 'support@example.test',
        });
        await fixture.mailer.send({
          to: fixture.recipient('without-reply'),
          subject: 'Without',
          body: 'body',
        });

        const received = await fixture.received();
        const withReply = received.find((message) => message.subject === 'With');
        const withoutReply = received.find((message) => message.subject === 'Without');
        assert.equal(withReply?.replyTo, 'support@example.test');
        assert.equal(withoutReply?.replyTo, undefined);
      });
    });

    unitTest(name('every message declares itself auto-generated'), async () => {
      // RFC 3834. Without it, a recipient's out-of-office autoresponder replies
      // to an unmonitored address, and two robots exchange mail until one of them
      // rate-limits the other.
      await withFixture(async (fixture) => {
        await fixture.mailer.send({
          to: fixture.recipient('auto'),
          subject: 'Auto',
          body: 'body',
        });
        const received = await fixture.received();
        assert.equal(received[0]?.headers.get('auto-submitted'), 'auto-generated');
      });
    });

    // -----------------------------------------------------------------------
    // Encoding — where a wrong guess is silent
    // -----------------------------------------------------------------------

    unitTest(name('a non-ASCII subject and body survive the round trip'), async () => {
      await withFixture(async (fixture) => {
        const subject = 'Confirmez votre adresse — Café Ludoteca 東京';
        const body = 'Bonjour,\n\nVotre code : ✅ naïve façade — 東京都\n\nMerci.';
        await fixture.mailer.send({ to: fixture.recipient('unicode'), subject, body });

        const received = await fixture.received();
        assert.equal(received[0]?.subject, subject);
        assert.equal(received[0]?.body, body);
      });
    });

    unitTest(name('a body line beginning with a period arrives intact'), async () => {
      // The DATA sub-protocol ends at a line containing a single period, so a
      // body line that begins with one must be sent doubled. Getting this wrong
      // does not corrupt the body — it truncates the message and feeds the
      // remainder to the server as commands. It is reachable with ordinary prose,
      // which is why it is asserted end to end rather than only on the encoder.
      await withFixture(async (fixture) => {
        const body = 'Reply to confirm.\n.\n..leading dots\n. spaced\nEnd.';
        await fixture.mailer.send({ to: fixture.recipient('dots'), subject: 'Dots', body });

        const received = await fixture.received();
        assert.equal(received.length, 1, 'the message must not have been truncated into two');
        assert.equal(received[0]?.body, body);
      });
    });

    unitTest(name('a body with very long lines survives'), async () => {
      // Longer than SMTP's 998-octet line limit, so the encoder must switch to a
      // wrapped transfer encoding rather than emit a line an intermediate relay
      // would fold or reject.
      await withFixture(async (fixture) => {
        const body = `start\n${'x'.repeat(4000)}\nend`;
        await fixture.mailer.send({ to: fixture.recipient('long'), subject: 'Long', body });

        const received = await fixture.received();
        assert.equal(received[0]?.body, body);
      });
    });

    unitTest(name('an empty body is accepted'), async () => {
      await withFixture(async (fixture) => {
        await fixture.mailer.send({ to: fixture.recipient('empty'), subject: 'Empty', body: '' });
        const received = await fixture.received();
        assert.equal(received.length, 1);
        assert.equal(received[0]?.body, '');
      });
    });

    // -----------------------------------------------------------------------
    // Refusals — the security half
    // -----------------------------------------------------------------------

    specTest(
      'tenant-data-isolation.md',
      'No identifier, credential, or reference belonging to one tenant is valid for retrieving or acting on another tenant\'s data, even if guessed, reused, or supplied out of context',
      name('a recipient carrying a line break is refused, and nothing is sent'),
      async () => {
        // This is the attack the port exists to make unreachable. A recipient of
        // `victim@example.test\r\nBcc: attacker@evil.test` is one form field and
        // two recipients on the wire, the second of whom receives a live
        // verification link for an account they do not own.
        await withFixture(async (fixture) => {
          const injected = `${fixture.recipient('victim')}\r\nBcc: attacker@evil.test`;
          await assert.rejects(
            fixture.mailer.send({ to: injected, subject: 'Verify', body: 'link' }),
            (error: unknown) => error instanceof ValidationError,
          );

          const received = await fixture.received();
          assert.equal(received.length, 0, 'a refused message must not be partially delivered');
        });
      },
    );

    unitTest(name('a subject carrying a line break is refused'), async () => {
      await withFixture(async (fixture) => {
        await assert.rejects(
          fixture.mailer.send({
            to: fixture.recipient('subject-injection'),
            subject: 'Verify\r\nBcc: attacker@evil.test',
            body: 'link',
          }),
          (error: unknown) => error instanceof ValidationError,
        );
        assert.equal((await fixture.received()).length, 0);
      });
    });

    unitTest(name('an address that is not a single deliverable mailbox is refused'), async () => {
      await withFixture(async (fixture) => {
        const refused = [
          '',
          '   ',
          'no-at-sign',
          'two@at@signs.test',
          'spaces in@example.test',
          'local@nodots',
          '<wrapped@example.test>',
          'a@example.test, b@example.test',
          'a@example.test;b@example.test',
          '"quoted"@example.test',
          'unicode@exämple.test',
          `${'a'.repeat(65)}@example.test`,
          `${'a'.repeat(310)}@example.test`,
        ];
        for (const to of refused) {
          await assert.rejects(
            fixture.mailer.send({ to, subject: 'Verify', body: 'link' }),
            (error: unknown) => error instanceof ValidationError,
            `expected ${JSON.stringify(to)} to be refused`,
          );
        }
        assert.equal((await fixture.received()).length, 0);
      });
    });

    // -----------------------------------------------------------------------
    // Lifecycle
    // -----------------------------------------------------------------------

    unitTest(name('verifyAccess succeeds against a correctly configured server'), async () => {
      await withFixture(async (fixture) => {
        await fixture.mailer.verifyAccess();
      });
    });

    unitTest(name('sending after close fails rather than opening a new connection'), async () => {
      await withFixture(async (fixture) => {
        await fixture.mailer.close();
        await assert.rejects(
          fixture.mailer.send({ to: fixture.recipient('after-close'), subject: 'x', body: 'y' }),
          /closed/i,
        );
      });
    });

    unitTest(name('close is idempotent'), async () => {
      await withFixture(async (fixture) => {
        await fixture.mailer.close();
        await fixture.mailer.close();
      });
    });
  });
}

export { decodeMail };
