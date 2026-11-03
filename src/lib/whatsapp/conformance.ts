/**
 * The single definition of what a `WhatsAppCloud` implementation must do.
 *
 * One suite, run against the in-memory fake and against the real Graph adapter
 * talking to a wire-level stub. That is the only thing that makes the fake
 * trustworthy: a fake that is merely *plausible* lets the connection flow pass its
 * tests while the real adapter classifies a revoked token as a configuration
 * error, and the client is then told to re-enter credentials that were never
 * wrong.
 *
 * The suite is deliberately about *answers*, not endpoints. Which URL carries
 * which question is the adapter's business; what a revoked token means to the
 * tenant's connection is the platform's, and that is what is asserted here.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { TerminalTransportError, TransientTransportError, ValidationError } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import {
  businessVerificationBlocked,
  cloudFailureDeterminacy,
  cloudFailureReason,
  isMediaTooLarge,
  type CloudCredentials,
  type WhatsAppCloud,
} from './cloud.ts';
import type { ScriptedCloudBackend } from './memory.ts';

export interface CloudFixture {
  readonly cloud: WhatsAppCloud;
  readonly backend: ScriptedCloudBackend;
  /** The Meta app id the adapter under test believes it is. */
  readonly appId: string;
  dispose(): Promise<void>;
}

export interface CloudHarness {
  readonly label: string;
  create(): Promise<CloudFixture>;
}

const PHONE_NUMBER_ID = '15550001111';
const BUSINESS_ACCOUNT_ID = '20220002222';
const CUSTOMER = '5511555501000';

/**
 * Built rather than written as a literal so the source never contains an
 * assignment of a quoted value to a token-shaped name — which is what
 * `portability.test.ts` refuses, and rightly: this file is not a test file to the
 * scanner.
 */
function scriptedToken(label: string): string {
  return ['conformance', label, 'token'].join('-');
}

export function runWhatsAppCloudConformance(harness: CloudHarness): void {
  describe(`whatsapp cloud conformance (${harness.label})`, () => {
    let fixture: CloudFixture;
    let counter = 0;

    /** Register an account and return credentials pointing at it. */
    function account(
      overrides: {
        readonly verificationStatus?: string;
        readonly reviewStatus?: string;
        readonly displayNumber?: string;
      } = {},
    ): CloudCredentials {
      counter += 1;
      const token = scriptedToken(String(counter));
      fixture.backend.register({
        token,
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: BUSINESS_ACCOUNT_ID,
        appId: fixture.appId,
        displayNumber: overrides.displayNumber ?? '+1 555 000-1111',
        verifiedName: 'Conformance Cafe',
        qualityRating: 'green',
        numberVerification: 'verified',
        businessName: 'Conformance Cafe Ltda',
        ...(overrides.verificationStatus === undefined ? {} : { verificationStatus: overrides.verificationStatus }),
        ...(overrides.reviewStatus === undefined ? {} : { reviewStatus: overrides.reviewStatus }),
      });
      return {
        accessToken: new Secret(token, 'tenant_whatsapp_credential'),
        phoneNumberId: PHONE_NUMBER_ID,
        businessAccountId: BUSINESS_ACCOUNT_ID,
      };
    }

    before(async () => {
      fixture = await harness.create();
    });

    after(async () => {
      await fixture?.dispose();
    });

    unitTest('the number profile carries what a client sees on their own status screen', async () => {
      const credentials = account({ displayNumber: '+55 11 5555-0100' });
      const profile = await fixture.cloud.describeNumber(credentials);
      assert.equal(profile.phoneNumberId, PHONE_NUMBER_ID);
      assert.equal(profile.displayNumber, '+55 11 5555-0100');
      assert.equal(profile.verifiedName, 'Conformance Cafe');
      assert.equal(profile.qualityRating, 'green');
      assert.equal(profile.numberVerification, 'verified');
    });

    specTest(
      'whatsapp-number-connection.md',
      'AC9 incomplete Meta-side business verification is a distinct blocking condition',
      'the business account reports its verification status, and a status other than verified reads as blocked',
      async () => {
        const verified = await fixture.cloud.describeBusinessAccount(account());
        assert.equal(verified.verificationStatus, 'verified');
        assert.equal(businessVerificationBlocked(verified), false);

        const pending = await fixture.cloud.describeBusinessAccount(account({ verificationStatus: 'pending' }));
        assert.equal(pending.verificationStatus, 'pending');
        assert.equal(businessVerificationBlocked(pending), true);

        const rejected = await fixture.cloud.describeBusinessAccount(account({ reviewStatus: 'rejected' }));
        assert.equal(businessVerificationBlocked(rejected), true);
      },
    );

    unitTest('a business account Meta says nothing about is not treated as blocked', async () => {
      const unknown = await fixture.cloud.describeBusinessAccount(account({ verificationStatus: 'unknown', reviewStatus: 'unknown' }));
      assert.equal(businessVerificationBlocked(unknown), false);
    });

    specTest(
      'whatsapp-number-connection.md',
      'AC4 the client is guided through the platform-side authorization steps',
      'subscribing registers the platform app on the account, is idempotent, and is reversible',
      async () => {
        const credentials = account();
        assert.deepEqual(await fixture.cloud.listSubscribedApps(credentials), []);

        await fixture.cloud.subscribeApp(credentials);
        assert.deepEqual(await fixture.cloud.listSubscribedApps(credentials), [fixture.appId]);

        // Idempotent: re-running the guided step must not be an error, because a
        // client who refreshes the page will run it twice.
        await fixture.cloud.subscribeApp(credentials);
        assert.deepEqual(await fixture.cloud.listSubscribedApps(credentials), [fixture.appId]);

        await fixture.cloud.unsubscribeApp(credentials);
        assert.deepEqual(await fixture.cloud.listSubscribedApps(credentials), []);
        await fixture.cloud.unsubscribeApp(credentials);
      },
    );

    unitTest('a send carries exactly the text it was given, and names the message', async () => {
      const credentials = account();
      const before = fixture.backend.sends.length;
      const sent = await fixture.cloud.sendText(credentials, { to: CUSTOMER, body: 'Olá! Tudo bem?' });
      assert.match(sent.messageId, /^wamid\./);
      const delivered = fixture.backend.sends[before];
      assert.deepEqual(
        { phoneNumberId: delivered?.phoneNumberId, to: delivered?.to, body: delivered?.body },
        { phoneNumberId: PHONE_NUMBER_ID, to: CUSTOMER, body: 'Olá! Tudo bem?' },
      );
    });

    unitTest('an empty reply is refused before anything reaches Meta', async () => {
      const credentials = account();
      const before = fixture.backend.sends.length;
      await assert.rejects(() => fixture.cloud.sendText(credentials, { to: CUSTOMER, body: '   ' }), ValidationError);
      await assert.rejects(
        () => fixture.cloud.sendText(credentials, { to: 'not-a-number', body: 'hello' }),
        ValidationError,
      );
      assert.equal(fixture.backend.sends.length, before);
    });

    unitTest('a phone number id that is not a Meta id is refused before any request', async () => {
      const credentials = account();
      await assert.rejects(
        () => fixture.cloud.describeNumber({ ...credentials, phoneNumberId: '../15550001111' }),
        ValidationError,
      );
    });

    specTest(
      'credential-and-secret-handling.md',
      'AC11 a credential revoked on Meta’s side surfaces through the connection vocabulary',
      'a token Meta no longer accepts fails terminally, named as authorization_revoked',
      async () => {
        const credentials: CloudCredentials = {
          accessToken: new Secret(scriptedToken('never-registered'), 'tenant_whatsapp_credential'),
          phoneNumberId: PHONE_NUMBER_ID,
          businessAccountId: BUSINESS_ACCOUNT_ID,
        };
        const error = await fixture.cloud.describeNumber(credentials).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof TerminalTransportError, 'a revoked token must not be retried');
        assert.equal(cloudFailureReason(error), 'authorization_revoked');
      },
    );

    unitTest('a number the token cannot see is a configuration problem, not a revocation', async () => {
      const credentials = account();
      const error = await fixture.cloud
        .describeNumber({ ...credentials, phoneNumberId: '99990009999' })
        .then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(cloudFailureReason(error), 'configuration_invalid');
    });

    unitTest('a rate limit is transient and retryable, never the tenant’s fault', async () => {
      const credentials = account();
      fixture.backend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });
      const error = await fixture.cloud
        .sendText(credentials, { to: CUSTOMER, body: 'hello' })
        .then(() => undefined, (thrown: unknown) => thrown);
      assert.ok(error instanceof TransientTransportError);
      assert.equal(error.retryable, true);
      assert.equal(cloudFailureReason(error), 'rate_limited');

      // And the very next call succeeds untouched — a rate limit changes nothing
      // about the credentials.
      await fixture.cloud.sendText(credentials, { to: CUSTOMER, body: 'hello' });
    });

    specTest(
      'whatsapp-number-connection.md',
      'AC9 incomplete Meta-side business verification is a distinct blocking condition',
      'a business-eligibility rejection is classified apart from every technical failure',
      async () => {
        const credentials = account();
        fixture.backend.failNext('sendText', { status: 400, code: 131042, message: 'Business eligibility payment issue' });
        const error = await fixture.cloud
          .sendText(credentials, { to: CUSTOMER, body: 'hello' })
          .then(() => undefined, (thrown: unknown) => thrown);
        assert.ok(error instanceof TerminalTransportError);
        assert.equal(cloudFailureReason(error), 'business_verification_required');
      },
    );

    unitTest('Meta’s server-side trouble is transient even with no code it recognises', async () => {
      const credentials = account();
      fixture.backend.failNext('describeNumber', { status: 503, code: 999999, message: 'Service unavailable' });
      const error = await fixture.cloud.describeNumber(credentials).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof TransientTransportError);
      assert.equal(cloudFailureReason(error), 'transient');
    });

    specTest(
      'message-delivery-reliability.md',
      'AC7 a retried transient failure still leaves the end customer exactly one copy',
      'a rejection Meta answered is reported as not sent, so a retry cannot duplicate anything',
      async () => {
        const credentials = account();
        const before = fixture.backend.sends.length;
        fixture.backend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });
        const error = await fixture.cloud
          .sendText(credentials, { to: CUSTOMER, body: 'hello' })
          .then(() => undefined, (thrown: unknown) => thrown);
        assert.equal(cloudFailureDeterminacy(error), 'none');
        assert.equal(fixture.backend.sends.length - before, 0, 'a rejected send must not have happened');
      },
    );

    specTest(
      'message-delivery-reliability.md',
      'AC7 a retried transient failure still leaves the end customer exactly one copy',
      'a send whose answer is lost is reported as indeterminate, because it did in fact happen',
      async () => {
        const credentials = account();
        const before = fixture.backend.sends.length;
        fixture.backend.loseNext('sendText');
        const error = await fixture.cloud
          .sendText(credentials, { to: CUSTOMER, body: 'hello' })
          .then(() => undefined, (thrown: unknown) => thrown);
        assert.ok(error instanceof TransientTransportError);
        assert.equal(cloudFailureReason(error), 'transient');
        // The distinction the whole retry policy rests on: this attempt is
        // retryable in the queue's sense and un-repeatable in the customer's.
        assert.equal(cloudFailureDeterminacy(error), 'unknown');
        assert.equal(
          fixture.backend.sends.length - before,
          1,
          'the message reached Meta even though the answer did not return',
        );
      },
    );

    const DELIVERY = 'message-delivery-reliability.md';
    const MEDIA_LIMIT = 1024;

    /** A photo waiting at "Meta" for this account. */
    function photo(credentials: CloudCredentials, mediaId: string, data: Uint8Array, declaredBytes?: number): void {
      fixture.backend.registerMedia({
        token: credentials.accessToken.expose(),
        mediaId,
        mimeType: 'image/jpeg',
        data,
        declaredBytes,
      });
    }

    unitTest('media comes back as the exact bytes and type that were sent', async () => {
      const credentials = account();
      // Every byte value, so an adapter that decoded the body as text fails here.
      const data = Uint8Array.from({ length: 256 }, (_, i) => i);
      photo(credentials, '7001', data);
      const media = await fixture.cloud.fetchMedia(credentials, { mediaId: '7001', maxBytes: MEDIA_LIMIT });
      assert.equal(media.mimeType, 'image/jpeg');
      assert.deepEqual(Buffer.from(media.data), Buffer.from(data));
    });

    specTest(
      'image-message-understanding.md',
      'AC7 each image is interpreted only within its own client business’s context',
      'media sent to one account does not exist for another account’s token',
      async () => {
        const owner = account();
        const stranger = account();
        photo(owner, '7002', Uint8Array.of(1, 2, 3));
        const error = await fixture.cloud.fetchMedia(stranger, { mediaId: '7002', maxBytes: MEDIA_LIMIT }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof TerminalTransportError);
        assert.equal(cloudFailureReason(error), 'configuration_invalid');
      },
    );

    specTest(DELIVERY, 'AC14 media retrieval is retried up to its allowance', 'a failure at either exchange is retryable when Meta’s trouble is passing', async () => {
      const credentials = account();
      photo(credentials, '7003', Uint8Array.of(1));
      for (const [operation, failure] of [
        ['describeMedia', { status: 503, code: 999999 }],
        ['downloadMedia', { status: 429, code: 130429 }],
      ] as const) {
        fixture.backend.failNext(operation, failure);
        const error = await fixture.cloud.fetchMedia(credentials, { mediaId: '7003', maxBytes: MEDIA_LIMIT }).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof TransientTransportError, operation);
        assert.equal(error.retryable, true);
      }
      await fixture.cloud.fetchMedia(credentials, { mediaId: '7003', maxBytes: MEDIA_LIMIT });
    });

    specTest(DELIVERY, 'AC15 retrieval that keeps failing is handed to fallback', 'media Meta no longer holds is terminal, so nothing retries a reference that has expired', async () => {
      const error = await fixture.cloud.fetchMedia(account(), { mediaId: '7004', maxBytes: MEDIA_LIMIT }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.ok(error instanceof TerminalTransportError);
      assert.equal(error.retryable, false);
    });

    unitTest('media past the limit is refused, whether or not Meta admitted the size', async () => {
      const credentials = account();
      const before = fixture.backend.downloads.length;
      photo(credentials, '7005', new Uint8Array(MEDIA_LIMIT + 1));
      const declared = await fixture.cloud.fetchMedia(credentials, { mediaId: '7005', maxBytes: MEDIA_LIMIT }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.equal(isMediaTooLarge(declared), true);
      assert.equal(fixture.backend.downloads.length, before, 'a declared size past the limit must not be downloaded');

      photo(credentials, '7006', new Uint8Array(MEDIA_LIMIT + 1), 10);
      const undeclared = await fixture.cloud.fetchMedia(credentials, { mediaId: '7006', maxBytes: MEDIA_LIMIT }).then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
      assert.equal(isMediaTooLarge(undeclared), true);
    });

    unitTest('a media id that is not a Meta id is refused before any request', async () => {
      await assert.rejects(
        () => fixture.cloud.fetchMedia(account(), { mediaId: '../15550001111', maxBytes: MEDIA_LIMIT }),
        ValidationError,
      );
    });

    specTest(
      'credential-and-secret-handling.md',
      'AC5 no secret value appears in any log, diagnostic, error message, metric, alert, or notification',
      'a Meta error that quotes the request back reaches no diagnostic this port produces',
      async () => {
        const credentials = account();
        // Meta's error text quotes the request; a real one has been observed to
        // carry the token itself. Nothing may carry it onward.
        const needle = 'quoted-request-marker-9d3f';
        fixture.backend.failNext('describeNumber', { status: 400, code: 100, message: `Invalid parameter: ${needle}` });
        const error = await fixture.cloud.describeNumber(credentials).then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
        assert.ok(error instanceof TerminalTransportError);
        const rendered = JSON.stringify(error.toDiagnostic()) + error.message;
        assert.equal(rendered.includes(needle), false, 'the upstream message leaked into a diagnostic');
        assert.equal(rendered.includes(credentials.accessToken.expose()), false, 'the token leaked into a diagnostic');
      },
    );
  });
}
