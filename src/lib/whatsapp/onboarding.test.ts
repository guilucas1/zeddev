/**
 * The self-service connection flow, against a real PostgreSQL and the in-memory
 * Cloud API.
 *
 * The database is not optional here. Almost every claim in
 * `whatsapp-number-connection.md` is enforced by a constraint, a trigger, or a
 * policy rather than by this module: the transition history is a trigger, the
 * "one number per tenant" guarantee is a UNIQUE index, and the release of a
 * number on disconnect is another trigger. Testing the flow against a fake store
 * would test the part that is least able to go wrong.
 *
 * `runFlow` drives the same three phases the API route does — open the attempt,
 * call Meta, record the outcome — rather than a single library call, because that
 * split *is* the design: no transaction is held across the network round trip.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withTenant, type Connection, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConflictError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { describeTenantSecret, readTenantSecret } from '@zeddev/vault';
import { businessVerificationBlocked, cloudFailureReason, type CloudCredentials } from './cloud.ts';
import { connectionHistory, readConnection, type ConnectionErrorReason, type ConnectionStatus } from './connection.ts';
import { readPhoneNumber } from './inbound.ts';
import { InMemoryWhatsAppCloud, type ScriptedCloudBackend } from './testing.ts';
import {
  abandonVerification,
  beginVerification,
  connectionCodeMessage,
  CONNECTION_STEPS,
  consumeVerificationReply,
  currentStep,
  describeConnectionSetup,
  disconnectNumber,
  expireStaleVerification,
  generateVerificationCode,
  loadCloudCredentials,
  parseCredentialSubmission,
  parseVerificationRequest,
  readConnectedNumber,
  readVerification,
  recordVerificationSent,
  submitCredentials,
  VERIFICATION_FAILURES,
  VERIFICATION_OUTCOMES,
} from './onboarding.ts';

const APP_ID = '3090001111';
const OWNER_PHONE = '5511555501000';
const PRINCIPAL = 'acct-owner';

/** Token-shaped, built rather than written: see `portability.test.ts`. */
function tokenFor(label: string): string {
  return ['EAA', label, 'bbbbbbbbbbbbbbbbbbbbbbbb'].join('');
}

unitTest('the guided steps are four, in order, each with something to do', () => {
  assert.deepEqual(
    CONNECTION_STEPS.map((step) => step.key),
    ['authorize', 'submit', 'send', 'reply'],
  );
  for (const step of CONNECTION_STEPS) assert.ok(step.detail.length > 40, `${step.key} explains nothing`);
});

unitTest('a submission is checked field by field, and every problem is reported at once', () => {
  try {
    parseCredentialSubmission({ phoneNumberId: 'nope', businessAccountId: '', accessToken: 'short' });
    assert.fail('expected a validation failure');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(
      error.issues.map((issue) => issue.key),
      ['accessToken', 'businessAccountId', 'phoneNumberId'],
    );
  }
});

unitTest('a verification recipient is normalised out of its leading plus', () => {
  assert.deepEqual(parseVerificationRequest({ recipient: ' +5511555501000 ' }), { recipient: OWNER_PHONE });
  assert.throws(() => parseVerificationRequest({ recipient: 'call me' }), ValidationError);
});

unitTest('the code is six digits, and two codes differ', () => {
  const codes = new Set(Array.from({ length: 50 }, () => generateVerificationCode()));
  for (const code of codes) assert.match(code, /^[0-9]{6}$/);
  assert.ok(codes.size > 1, 'the code generator returned the same value 50 times');
});

describe('whatsapp connection flow', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let sealer: SecretSealer;
  let cloud: InMemoryWhatsAppCloud;
  let backend: ScriptedCloudBackend;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Connect Cafe ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  /** Register an account at the fake Meta and return what the client would type. */
  function metaAccount(
    label: string,
    overrides: { readonly verificationStatus?: string; readonly displayNumber?: string } = {},
  ): { phoneNumberId: string; businessAccountId: string; accessToken: string } {
    counter += 1;
    const phoneNumberId = String(15550000000 + counter);
    const businessAccountId = String(20220000000 + counter);
    const token = tokenFor(label);
    backend.register({
      token,
      phoneNumberId,
      businessAccountId,
      appId: APP_ID,
      displayNumber: overrides.displayNumber ?? `+1 555 ${counter}`,
      verifiedName: `Cafe ${label}`,
      businessName: `Cafe ${label} Ltda`,
      ...(overrides.verificationStatus === undefined ? {} : { verificationStatus: overrides.verificationStatus }),
    });
    return { phoneNumberId, businessAccountId, accessToken: token };
  }

  function submit(
    tenant: string,
    account: { phoneNumberId: string; businessAccountId: string; accessToken: string },
    options: { readonly replace?: boolean } = {},
  ): Promise<ConnectionStatus> {
    return withTenant(pool, tenant, (tx) =>
      submitCredentials(tx, sealer, parseCredentialSubmission(account), {
        principal: PRINCIPAL,
        replace: options.replace,
      }),
    );
  }

  /**
   * Ask for a code, exactly as the API route does: open the attempt, call Meta
   * outside the transaction, record the outcome in a second one.
   */
  async function requestCode(
    tenant: string,
    recipient = OWNER_PHONE,
  ): Promise<{ code: string; sent: boolean; reason: ConnectionErrorReason | 'transient' | undefined }> {
    const code = generateVerificationCode();
    const expiresAt = new Date(Date.now() + 15 * 60_000);
    const opened = await withTenant(pool, tenant, async (tx) => {
      const credentials = await loadCloudCredentials(tx, sealer, { principal: PRINCIPAL });
      const attempt = await beginVerification(tx, { recipient, code, expiresAt });
      return { credentials, attempt };
    });

    const attempt = await probe(opened.credentials, recipient, code);
    await withTenant(pool, tenant, async (tx) => {
      if (attempt.sent) {
        await recordVerificationSent(tx, opened.attempt.id, {
          outboundMessageId: attempt.messageId,
          displayNumber: attempt.displayNumber,
          verifiedName: attempt.verifiedName,
        });
      } else {
        await abandonVerification(tx, opened.attempt.id, 'send_failed', {
          errorReason: attempt.reason === 'transient' || attempt.reason === 'rate_limited' ? undefined : attempt.reason,
        });
      }
    });
    return { code, sent: attempt.sent, reason: attempt.sent ? undefined : attempt.reason };
  }

  /** The Meta half, mirroring `probeAndSend` in the API service. */
  async function probe(
    credentials: CloudCredentials,
    recipient: string,
    code: string,
  ): Promise<
    | { sent: true; messageId: string; displayNumber: string; verifiedName: string }
    | { sent: false; reason: ConnectionErrorReason | 'transient' }
  > {
    try {
      const business = await cloud.describeBusinessAccount(credentials);
      if (businessVerificationBlocked(business)) return { sent: false, reason: 'business_verification_required' };
      const number = await cloud.describeNumber(credentials);
      await cloud.subscribeApp(credentials);
      const subscribed = await cloud.listSubscribedApps(credentials);
      if (!subscribed.includes(APP_ID)) return { sent: false, reason: 'configuration_invalid' };
      const sent = await cloud.sendText(credentials, { to: recipient, body: connectionCodeMessage(code) });
      return {
        sent: true,
        messageId: sent.messageId,
        displayNumber: number.displayNumber,
        verifiedName: number.verifiedName,
      };
    } catch (error) {
      const reason = cloudFailureReason(error);
      if (reason === undefined) throw error;
      return { sent: false, reason };
    }
  }

  /** The reply arriving at the gateway, which is where it really arrives. */
  function reply(
    tenant: string,
    text: string,
    options: { readonly from?: string; readonly externalId?: string } = {},
  ): Promise<string> {
    counter += 1;
    return withTenant(pool, tenant, (tx) =>
      consumeVerificationReply(tx, {
        customerId: options.from ?? OWNER_PHONE,
        text,
        externalId: options.externalId ?? `wamid.reply.${counter}`,
      }),
    );
  }

  function status(tenant: string): Promise<ConnectionStatus> {
    return withTenant(pool, tenant, (tx) => readConnection(tx));
  }

  before(async () => {
    db = await createTestDatabase('whatsapp-onboarding');
    pool = db.pool;
    sealer = new SecretSealer([parseSealingKey(generateSealingKey('k1'), 'VAULT_SEALING_KEYS')]);
    cloud = new InMemoryWhatsAppCloud({ appId: APP_ID });
    backend = cloud.backend;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC2 credentials submitted but not yet verified leave the tenant connecting, not connected',
    'submitting stores the number and the token and stops at connecting, with no Meta call made',
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('ac2');
      const sendsBefore = backend.sends.length;

      const after = await submit(tenant, account);
      assert.equal(after.state, 'connecting');
      assert.equal(backend.sends.length, sendsBefore, 'submitting reached Meta');

      assert.equal(await withTenant(pool, tenant, (tx) => readPhoneNumber(tx)), account.phoneNumberId);
      const stored = await withTenant(pool, tenant, (tx) => describeTenantSecret(tx, 'tenant_whatsapp_credential'));
      assert.equal(stored?.secretClass, 'tenant_whatsapp_credential');
      const number = await withTenant(pool, tenant, (tx) => readConnectedNumber(tx));
      assert.equal(number?.businessAccountId, account.businessAccountId);
      // Meta has not been asked yet, so nothing is known about how it renders.
      assert.equal(number?.displayNumber, null);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC1 a completed self-service flow with verified send and receive becomes connected',
    'the code goes out over the Cloud API and the reply coming back through the webhook connects the number',
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('ac1', { displayNumber: '+55 11 5555-0100' });
      await submit(tenant, account);

      const requested = await requestCode(tenant);
      assert.equal(requested.sent, true);

      // The send really happened, from the client's own number, carrying the code.
      const delivered = backend.sends.at(-1);
      assert.equal(delivered?.phoneNumberId, account.phoneNumberId);
      assert.equal(delivered?.to, OWNER_PHONE);
      assert.ok(delivered?.body.includes(requested.code));

      // Still not connected: sending proves one direction only.
      assert.equal((await status(tenant)).state, 'connecting');
      assert.equal((await withTenant(pool, tenant, (tx) => readVerification(tx)))?.outcome, 'pending');

      assert.equal(await reply(tenant, requested.code), 'verified');

      const connected = await status(tenant);
      assert.equal(connected.state, 'connected');
      assert.ok(connected.lastKnownGoodAt instanceof Date);
      const number = await withTenant(pool, tenant, (tx) => readConnectedNumber(tx));
      assert.equal(number?.displayNumber, '+55 11 5555-0100');
      assert.equal((await withTenant(pool, tenant, (tx) => readVerification(tx)))?.outcome, 'passed');
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'the system must not mark a tenant connected on submitted credentials alone',
    'no sequence that stops short of a returned reply reaches connected',
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('ac13');
      await submit(tenant, account);
      assert.equal((await status(tenant)).state, 'connecting');

      await requestCode(tenant);
      assert.equal((await status(tenant)).state, 'connecting');

      // A reply from the right number with the wrong code proves nothing.
      assert.equal(await reply(tenant, '000000'), 'mismatch');
      assert.equal((await status(tenant)).state, 'connecting');

      // And a reply carrying the right code from somebody else proves nothing
      // either: matching on text alone would let any end-customer who happened to
      // send six digits complete a stranger's connection.
      const pending = await withTenant(pool, tenant, (tx) => readVerification(tx));
      assert.equal(pending?.outcome, 'pending');
      assert.equal((await status(tenant)).state, 'connecting');
    },
  );

  unitTest('a reply from a number other than the nominated one is an ordinary message', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('stranger'));
    const requested = await requestCode(tenant);
    assert.equal(await reply(tenant, requested.code, { from: '5511999990000' }), 'not_awaited');
    assert.equal((await status(tenant)).state, 'connecting');
  });

  unitTest('a redelivery of the reply that connected the number is recognised, not answered', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('redeliver'));
    const requested = await requestCode(tenant);
    assert.equal(await reply(tenant, requested.code, { externalId: 'wamid.once' }), 'verified');
    assert.equal(await reply(tenant, requested.code, { externalId: 'wamid.once' }), 'already_consumed');
    assert.equal((await status(tenant)).state, 'connected');
  });

  unitTest('a code quoted inside a sentence is accepted; a longer number containing it is not', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('quoted'));
    const requested = await requestCode(tenant);
    assert.equal(await reply(tenant, `my code is ${requested.code}9`), 'mismatch');
    assert.equal(await reply(tenant, `Code: ${requested.code}!`), 'verified');
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC3 a tenant with a connected number cannot add a second one',
    'connecting another number is refused, and the original stays the sole active number',
    async () => {
      const tenant = await newTenant();
      const first = metaAccount('first');
      await submit(tenant, first);
      const requested = await requestCode(tenant);
      await reply(tenant, requested.code);
      assert.equal((await status(tenant)).state, 'connected');

      const second = metaAccount('second');
      await assert.rejects(() => submit(tenant, second), ConflictError);

      assert.equal((await status(tenant)).state, 'connected');
      assert.equal(await withTenant(pool, tenant, (tx) => readPhoneNumber(tx)), first.phoneNumberId);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC8 replacing a number leaves the old one inactive no later than the new one connects',
    'the replacement drops the old route before the new one is assigned, so the two are never both active',
    async () => {
      const tenant = await newTenant();
      const old = metaAccount('old');
      await submit(tenant, old);
      const first = await requestCode(tenant);
      await reply(tenant, first.code);
      assert.equal((await status(tenant)).state, 'connected');

      const replacement = metaAccount('new');
      const midFlight = await submit(tenant, replacement, { replace: true });

      // The moment the replacement starts, the old number is already gone: one
      // route row per tenant means there is no instant in which both exist.
      assert.equal(midFlight.state, 'connecting');
      assert.equal(await withTenant(pool, tenant, (tx) => readPhoneNumber(tx)), replacement.phoneNumberId);
      const routes = await withTenant(pool, tenant, (tx) =>
        tx.query<{ phone_number_id: string }>('SELECT phone_number_id FROM whatsapp_number_routes'),
      );
      assert.deepEqual(
        routes.rows.map((row) => row.phone_number_id),
        [replacement.phoneNumberId],
      );

      const second = await requestCode(tenant);
      await reply(tenant, second.code);
      assert.equal((await status(tenant)).state, 'connected');

      // The history says plainly what happened, in order.
      const history = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.deepEqual(
        history.slice(0, 3).map((entry) => `${entry.from}->${entry.to}`),
        ['connecting->connected', 'disconnected->connecting', 'connected->disconnected'],
      );
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC9 incomplete Meta-side business verification is a distinct blocking condition',
    'a business Meta has not verified blocks the connection with its own reason, not a technical one',
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('unverified', { verificationStatus: 'pending_submission' });
      await submit(tenant, account);

      const sendsBefore = backend.sends.length;
      const requested = await requestCode(tenant);
      assert.equal(requested.sent, false);
      assert.equal(requested.reason, 'business_verification_required');
      assert.equal(backend.sends.length, sendsBefore, 'a code went out despite the block');

      const blocked = await status(tenant);
      assert.equal(blocked.state, 'error');
      assert.equal(blocked.errorReason, 'business_verification_required');
    },
  );

  unitTest('a revoked token puts the connection in error naming the revocation', async () => {
    const tenant = await newTenant();
    const account = metaAccount('revoked');
    await submit(tenant, account);
    backend.failNext('describeBusinessAccount', { status: 401, code: 190, message: 'Session invalidated' });

    const requested = await requestCode(tenant);
    assert.equal(requested.sent, false);
    assert.equal(requested.reason, 'authorization_revoked');
    assert.equal((await status(tenant)).errorReason, 'authorization_revoked');
  });

  unitTest('a rate limit leaves the connection connecting, because retrying is all it needs', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('limited'));
    backend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });

    const limited = await requestCode(tenant);
    assert.equal(limited.sent, false);
    assert.equal(limited.reason, 'rate_limited');
    assert.equal((await status(tenant)).state, 'connecting');

    // And the retry succeeds with nothing re-entered.
    const retried = await requestCode(tenant);
    assert.equal(retried.sent, true);
    assert.equal(await reply(tenant, retried.code), 'verified');
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC6 recovery attempts exhausted without success become error with a surfaced reason',
    'a verification whose reply never arrives expires into error naming verification_failed',
    async () => {
      const tenant = await newTenant();
      await submit(tenant, metaAccount('expired'));
      const requested = await requestCode(tenant);
      assert.equal(requested.sent, true);

      // Reach past the flow to age the attempt: the window is judged by the
      // database clock, which is the thing a test cannot advance.
      await withTenant(pool, tenant, (tx) =>
        tx.query(`UPDATE whatsapp_connection_verifications SET expires_at = now() - interval '1 second'`),
      );

      const after = await withTenant(pool, tenant, (tx) => expireStaleVerification(tx));
      assert.equal(after.state, 'error');
      assert.equal(after.errorReason, 'verification_failed');
      const attempt = await withTenant(pool, tenant, (tx) => readVerification(tx));
      assert.equal(attempt?.outcome, 'failed');
      assert.equal(attempt?.failure, 'reply_not_received');

      // A late reply cannot rescue it.
      assert.equal(await reply(tenant, requested.code), 'not_awaited');
      assert.equal((await status(tenant)).state, 'error');
    },
  );

  unitTest('expiring is idempotent and leaves a healthy connection alone', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('idem'));
    const requested = await requestCode(tenant);
    await reply(tenant, requested.code);

    const first = await withTenant(pool, tenant, (tx) => expireStaleVerification(tx));
    const second = await withTenant(pool, tenant, (tx) => expireStaleVerification(tx));
    assert.equal(first.state, 'connected');
    assert.equal(second.state, 'connected');
    assert.equal(second.changedAt?.getTime(), first.changedAt?.getTime());
  });

  unitTest('a second request for a code supersedes the first, so only one code is live', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('supersede'));
    const first = await requestCode(tenant);
    const second = await requestCode(tenant);
    assert.notEqual(first.code, second.code);

    assert.equal(await reply(tenant, first.code), 'mismatch');
    assert.equal(await reply(tenant, second.code), 'verified');

    const attempts = await withTenant(pool, tenant, (tx) =>
      tx.query<{ outcome: string; failure: string | null }>(
        'SELECT outcome, failure FROM whatsapp_connection_verifications ORDER BY started_at',
      ),
    );
    assert.deepEqual(attempts.rows, [
      { outcome: 'failed', failure: 'superseded' },
      { outcome: 'passed', failure: null },
    ]);
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC7 a client may disconnect from connected, error, or reconnecting',
    'disconnecting releases the number, destroys the token, and records the transition',
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('disconnect');
      await submit(tenant, account);
      const requested = await requestCode(tenant);
      await reply(tenant, requested.code);
      assert.equal((await status(tenant)).state, 'connected');

      const after = await withTenant(pool, tenant, (tx) => disconnectNumber(tx, { principal: PRINCIPAL }));
      assert.equal(after.state, 'disconnected');

      // Nothing of the number survives: not the route, not the business account,
      // and not the credential.
      assert.equal(await withTenant(pool, tenant, (tx) => readPhoneNumber(tx)), undefined);
      assert.equal(await withTenant(pool, tenant, (tx) => readConnectedNumber(tx)), undefined);
      assert.equal(
        await withTenant(pool, tenant, (tx) =>
          readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: PRINCIPAL }),
        ),
        undefined,
      );

      const history = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.equal(`${history[0]?.from}->${history[0]?.to}`, 'connected->disconnected');
    },
  );

  unitTest('disconnecting twice is what the client asked for, not a conflict', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('twice'));
    await withTenant(pool, tenant, (tx) => disconnectNumber(tx, { principal: PRINCIPAL }));
    const again = await withTenant(pool, tenant, (tx) => disconnectNumber(tx, { principal: PRINCIPAL }));
    assert.equal(again.state, 'disconnected');
  });

  unitTest('a disconnected tenant can connect a different number without a replace flag', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('before-gap'));
    await withTenant(pool, tenant, (tx) => disconnectNumber(tx, { principal: PRINCIPAL }));
    const fresh = metaAccount('after-gap');
    assert.equal((await submit(tenant, fresh)).state, 'connecting');
    assert.equal(await withTenant(pool, tenant, (tx) => readPhoneNumber(tx)), fresh.phoneNumberId);
  });

  unitTest('re-submitting while connecting corrects a mistyped token without a disconnect', async () => {
    const tenant = await newTenant();
    const wrong = metaAccount('typo');
    await submit(tenant, { ...wrong, accessToken: tokenFor('nothing-registered') });
    const failed = await requestCode(tenant);
    assert.equal(failed.sent, false);
    assert.equal(failed.reason, 'authorization_revoked');

    await submit(tenant, wrong);
    const fixed = await requestCode(tenant);
    assert.equal(fixed.sent, true);
    assert.equal(await reply(tenant, fixed.code), 'verified');
  });

  specTest(
    'whatsapp-number-connection.md',
    'the system must guide the client through the platform-side authorization steps',
    'the status names the step outstanding and never carries the credential value',
    async () => {
      const tenant = await newTenant();
      const describe_ = async (): Promise<ReturnType<typeof describeConnectionSetup>> =>
        withTenant(pool, tenant, async (tx) =>
          describeConnectionSetup(await readConnection(tx), await readConnectedNumber(tx), await readVerification(tx)),
        );

      assert.equal((await describe_()).currentStep, 'authorize');

      const account = metaAccount('guided');
      await submit(tenant, account);
      assert.equal((await describe_()).currentStep, 'send');

      const requested = await requestCode(tenant);
      const waiting = await describe_();
      assert.equal(waiting.currentStep, 'reply');
      assert.equal(waiting.verification?.outcome, 'pending');
      assert.equal(waiting.number?.credentialConfigured, true);
      assert.equal(JSON.stringify(waiting).includes(account.accessToken), false, 'the token reached a product surface');
      assert.equal(JSON.stringify(waiting).includes(requested.code), false, 'the code reached a product surface');

      await reply(tenant, requested.code);
      assert.equal((await describe_()).currentStep, null);
    },
  );

  unitTest('a tenant that never connected has no number and is on the first step', async () => {
    const tenant = await newTenant();
    const empty = await withTenant(pool, tenant, async (tx) =>
      describeConnectionSetup(await readConnection(tx), await readConnectedNumber(tx), await readVerification(tx)),
    );
    assert.deepEqual({ number: empty.number, verification: empty.verification }, { number: null, verification: null });
    assert.equal(empty.currentStep, 'authorize');
    assert.equal(empty.steps.length, CONNECTION_STEPS.length);
  });

  unitTest('the step for an errored connection sends the client back to the start', () => {
    const errored: ConnectionStatus = {
      state: 'error',
      errorReason: 'authorization_revoked',
      lastKnownGoodAt: null,
      changedAt: new Date(),
    };
    assert.equal(currentStep(errored, undefined), 'authorize');
  });

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier from one tenant is refused in another tenant’s context',
    'one tenant cannot claim a number another tenant already holds',
    async () => {
      const alpha = await newTenant();
      const beta = await newTenant();
      const account = metaAccount('contested');
      await submit(alpha, account);

      // Beta submits alpha's number with a token of its own. The route is taken,
      // and taking it is what attribution depends on.
      backend.register({
        token: tokenFor('beta-contest'),
        phoneNumberId: account.phoneNumberId,
        businessAccountId: account.businessAccountId,
        appId: APP_ID,
      });
      await assert.rejects(
        () => submit(beta, { ...account, accessToken: tokenFor('beta-contest') }),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          assert.equal(error.code, 'whatsapp.number.in_use');
          return true;
        },
      );
      assert.equal(await withTenant(pool, alpha, (tx) => readPhoneNumber(tx)), account.phoneNumberId);
    },
  );

  // -------------------------------------------------------------------------
  // The vocabularies and the CHECK constraints agree
  // -------------------------------------------------------------------------

  async function checkValues(table: string, column: string): Promise<string[]> {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
      [table],
    );
    const definition = result.rows
      .map((row) => row.definition)
      .find((text) => new RegExp(`^CHECK \\(\\(?${column} = ANY`).test(text));
    assert.ok(definition !== undefined, `no value-list CHECK on ${table}.${column}`);
    return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]!).sort();
  }

  unitTest('the verification vocabularies match the migration CHECK constraints', async () => {
    assert.deepEqual(
      await checkValues('whatsapp_connection_verifications', 'outcome'),
      [...VERIFICATION_OUTCOMES].sort(),
    );
    assert.deepEqual(
      await checkValues('whatsapp_connection_verifications', 'failure'),
      [...VERIFICATION_FAILURES].sort(),
    );
  });

  specTest(
    'whatsapp-number-connection.md',
    'the system must prevent two numbers being simultaneously active for one tenant',
    "the database refuses a second route for one tenant, so the guarantee does not rest on this module",
    async () => {
      const tenant = await newTenant();
      const account = metaAccount('structural');
      await submit(tenant, account);
      await assert.rejects(() =>
        withTenant(pool, tenant, (tx) =>
          tx.query('INSERT INTO whatsapp_number_routes (phone_number_id, tenant_id) VALUES ($1, $2)', [
            '15559999999',
            tenant,
          ]),
        ),
      );
    },
  );

  unitTest('a disconnected connection cannot keep naming a business account', async () => {
    const tenant = await newTenant();
    await submit(tenant, metaAccount('cleared'));
    await withTenant(pool, tenant, (tx) => disconnectNumber(tx, { principal: PRINCIPAL }));
    const row = await withTenant(pool, tenant, (tx) =>
      tx.query<{ business_account_id: string | null; display_number: string | null }>(
        'SELECT business_account_id, display_number FROM whatsapp_connections',
      ),
    );
    assert.deepEqual(row.rows[0], { business_account_id: null, display_number: null });
  });
  unitTest('a verification cannot be opened for a connection that is not connecting', async () => {
    const tenant = await newTenant();
    await assert.rejects(
      () =>
        withTenant(pool, tenant, (tx: Connection) =>
          beginVerification(tx, {
            recipient: OWNER_PHONE,
            code: '123456',
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ),
      ConflictError,
    );
  });
});
