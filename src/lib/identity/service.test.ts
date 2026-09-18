/**
 * The executable form of `client-signup-and-tenancy.md` and
 * `authentication-and-access.md`.
 *
 * Everything here runs against a real PostgreSQL, for the same reason
 * `@zeddev/schema`'s tests do: what is being asserted is largely that a real
 * server refuses a real query. A fake would let every one of these tests pass
 * while the deployed system had no isolation at all — the failure mode
 * IMPLEMENTATION_PLAN.md §4c records, where a superuser silently bypasses every
 * policy and the suite stays green.
 *
 * Three things about how these tests are written are deliberate.
 *
 * **Expiry is really waited out.** The service takes its time from the database
 * rather than from an injected clock, because several instances share these rows
 * and one with a fast clock must not reject a session its neighbours honour. The
 * price is that a `FakeClock` cannot drive an expiry, so the tests that need one
 * build a service with a sub-second window and sleep. That is the same trade
 * `@zeddev/queue`'s PostgreSQL tests make for leases.
 *
 * **Negative assertions are written to fail loudly.** IMPLEMENTATION_PLAN.md §4c
 * records that the cross-tenant tests only caught the superuser problem because
 * they asserted data was *absent*; a test asserting presence would have passed
 * while proving nothing. The isolation tests below assert absence, and each one
 * first establishes that the row it cannot see actually exists.
 *
 * **The failed-attempt counter is asserted directly, not only through its
 * effect.** A login that throws from inside its transaction would roll the
 * counter back, and the lockout would silently never engage while every rejection
 * test still passed. So the tests read the column.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { AuthenticationError, AuthorizationError, ConflictError, toDiagnostic, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { IdentityService, type IdentityServiceOptions } from './service.ts';
import type { IdentityPolicy } from './config.ts';
import { mintToken } from './tokens.ts';

/**
 * scrypt at 1/32nd of the production memory cost.
 *
 * The production parameters exist to be slow, and a suite that hashes a few
 * dozen credentials would spend most of its runtime proving that. The stored
 * format carries its own parameters, so this changes nothing about the code path
 * under test — `verifyCredential` reads N, r and p out of the stored string
 * either way.
 */
const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;

/** Generous enough that nothing expires by accident in a test that is not about expiry. */
const BASE_POLICY: IdentityPolicy = {
  sessionInactivityMs: 60_000,
  sessionAbsoluteLifetimeMs: 120_000,
  maxFailedAttempts: 3,
  lockoutMs: 30_000,
  emailVerificationTtlMs: 60_000,
  passwordResetTtlMs: 60_000,
  minPasswordLength: 12,
};

const PASSWORD = 'meadow-granite-vessel-8';
const NEW_PASSWORD = 'harbour-thistle-copper-4';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('identity service', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let service: IdentityService;
  let counter = 0;

  /** A service sharing the pool but with its own policy or hooks. */
  function serviceWith(
    overrides: Partial<IdentityPolicy> = {},
    options: Omit<IdentityServiceOptions, 'pool' | 'policy'> = {},
  ): IdentityService {
    return new IdentityService({
      pool,
      policy: { ...BASE_POLICY, ...overrides },
      credentialParams: FAST_SCRYPT,
      ...options,
    });
  }

  function nextIdentity(): { email: string; businessName: string } {
    counter += 1;
    return { email: `owner-${counter}@example.com`, businessName: `Alpha Bakery ${counter}` };
  }

  /** Sign up, verify, and return everything a later assertion might need. */
  async function onboard(
    svc: IdentityService = service,
  ): Promise<{ email: string; businessName: string; tenantId: string; accountId: string }> {
    const { email, businessName } = nextIdentity();
    const signed = await svc.signUp({ businessName, email, password: PASSWORD });
    await svc.verifyEmail(signed.verificationToken.expose());
    return { email, businessName, tenantId: signed.tenantId, accountId: signed.accountId };
  }

  async function tenantRow(tenantId: string): Promise<{
    provisioning_state: string;
    lifecycle_state: string;
    provisioned_at: Date | null;
  }> {
    return withIdentityScope(pool, async (tx) => {
      const found = await tx.query<{
        provisioning_state: string;
        lifecycle_state: string;
        provisioned_at: Date | null;
      }>('SELECT provisioning_state, lifecycle_state, provisioned_at FROM tenants WHERE id = $1', [
        tenantId,
      ]);
      return found.rows[0]!;
    });
  }

  async function countTenants(): Promise<number> {
    return withIdentityScope(pool, async (tx) => {
      const found = await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM tenants');
      return found.rows[0]!.count;
    });
  }

  before(async () => {
    db = await createTestDatabase('identity');
    pool = db.pool;
    await migrateToLatest(pool);
    service = serviceWith();
  });

  after(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------
  // Signup and provisioning
  // -------------------------------------------------------------------------

  specTest(
    'client-signup-and-tenancy.md',
    'AC1 a complete signup creates an account and provisions a tenant with no operator interaction',
    'signup creates a tenant and an owner account in one step',
    async () => {
      const { email, businessName } = nextIdentity();
      const result = await service.signUp({ businessName, email, password: PASSWORD });

      assert.match(result.tenantId, /^[0-9a-f-]{36}$/);
      assert.equal(result.email, email);
      // Not yet usable: AC13 requires a tenant not be usable before verification.
      assert.equal((await tenantRow(result.tenantId)).provisioning_state, 'provisioning');

      const account = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query<{ role: string; verified: boolean; tenant_id: string }>(
          'SELECT role, email_verified_at IS NOT NULL AS verified, tenant_id FROM accounts WHERE id = $1',
          [result.accountId],
        );
        return found.rows[0]!;
      });
      // AC10: the signing user is the owner/administrator of the new tenant.
      assert.equal(account.role, 'owner');
      assert.equal(account.tenant_id, result.tenantId);
      assert.equal(account.verified, false);
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC3 a duplicate email is rejected and creates no duplicate account or tenant',
    'a second signup on the same address leaves no tenant behind',
    async () => {
      const { email, businessName } = nextIdentity();
      await service.signUp({ businessName, email, password: PASSWORD });

      const before = await countTenants();
      await assert.rejects(
        () => service.signUp({ businessName: `${businessName} Two`, email, password: PASSWORD }),
        (error: unknown) => error instanceof ConflictError && error.code === 'identity.email_in_use',
      );
      // The tenant row is written before the account row, so a uniqueness failure
      // on the account must undo the tenant. This is the assertion that proves
      // the two writes share a transaction.
      assert.equal(await countTenants(), before, 'a rejected signup left an orphaned tenant');
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC4 a password below the minimum strength standard creates no account or tenant',
    'a weak password is refused before anything is written',
    async () => {
      const { email, businessName } = nextIdentity();
      const before = await countTenants();
      await assert.rejects(
        () => service.signUp({ businessName, email, password: 'short' }),
        ValidationError,
      );
      assert.equal(await countTenants(), before);
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC6 verification makes the tenant accessible without any additional operator step',
    'verifying the email provisions the tenant and records the lifecycle event',
    async () => {
      const { email, businessName } = nextIdentity();
      const signed = await service.signUp({ businessName, email, password: PASSWORD });
      const verified = await service.verifyEmail(signed.verificationToken.expose());

      assert.equal(verified.tenantId, signed.tenantId);
      const tenant = await tenantRow(signed.tenantId);
      assert.equal(tenant.provisioning_state, 'ready');
      assert.notEqual(tenant.provisioned_at, null);

      // Read under the platform scope, not the identity scope. That is not
      // incidental: `tenant_lifecycle_events` has no identity-scope policy, so
      // the read the signup path performs cannot see back into the log it wrote.
      // Getting this wrong the first time was informative — the assertion
      // returned an empty array, which is exactly what a missing row would also
      // look like.
      const events = await withPlatformScope(pool, async (tx) => {
        const found = await tx.query<{ event: string }>(
          'SELECT event FROM tenant_lifecycle_events WHERE tenant_id = $1 ORDER BY id',
          [signed.tenantId],
        );
        return found.rows.map((r) => r.event);
      });
      assert.deepEqual(events, ['provisioned']);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC11 a recovery link or code that has already been used once is rejected',
    'a verification token is single-use',
    async () => {
      const { email, businessName } = nextIdentity();
      const signed = await service.signUp({ businessName, email, password: PASSWORD });
      const token = signed.verificationToken.expose();
      await service.verifyEmail(token);

      await assert.rejects(
        () => service.verifyEmail(token),
        (error: unknown) =>
          error instanceof ValidationError &&
          error.issues.some((issue) => issue.reason.includes('already been used')),
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC11 a recovery link or code older than its expiry is rejected',
    'a verification token past its lifetime is rejected as expired',
    async () => {
      const shortLived = serviceWith({ emailVerificationTtlMs: 200 });
      const { email, businessName } = nextIdentity();
      const signed = await shortLived.signUp({ businessName, email, password: PASSWORD });

      await sleep(400);
      await assert.rejects(
        () => shortLived.verifyEmail(signed.verificationToken.expose()),
        (error: unknown) =>
          error instanceof ValidationError &&
          error.issues.some((issue) => issue.reason.includes('expired')),
      );
      // And the tenant is still not usable, which is the point of the expiry.
      assert.equal((await tenantRow(signed.tenantId)).provisioning_state, 'provisioning');
    },
  );

  unitTest('an unrecognised verification token is rejected without revealing anything', async () => {
    await assert.rejects(
      () => service.verifyEmail(mintToken('email_verification').token.expose()),
      ValidationError,
    );
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC7 a provisioning failure leaves an error state, no partial tenant, and no effect on other tenants',
    'a failing provisioning hook marks the tenant failed and blocks login',
    async () => {
      const bystander = await onboard();
      const failing = serviceWith(
        {},
        {
          credentialParams: FAST_SCRYPT,
          provisionTenant: async () => {
            throw new Error('provisioning step is unavailable');
          },
        },
      );

      const { email, businessName } = nextIdentity();
      const signed = await failing.signUp({ businessName, email, password: PASSWORD });
      await assert.rejects(() => failing.verifyEmail(signed.verificationToken.expose()));

      // Visible failure, per AC7's "the client is shown an error state".
      const tenant = await tenantRow(signed.tenantId);
      assert.equal(tenant.provisioning_state, 'failed');
      assert.equal(tenant.provisioned_at, null);

      // No partial tenant: the verification transaction rolled back, so the
      // account is still unverified and the token still unconsumed.
      const account = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query<{ verified: boolean }>(
          'SELECT email_verified_at IS NOT NULL AS verified FROM accounts WHERE id = $1',
          [signed.accountId],
        );
        return found.rows[0]!;
      });
      assert.equal(account.verified, false);

      // Not a usable account pointing at a broken tenant: login is refused.
      await assert.rejects(() => failing.logIn({ email, password: PASSWORD }), AuthenticationError);

      // And no other client's tenant is affected.
      assert.equal((await tenantRow(bystander.tenantId)).provisioning_state, 'ready');

      // The same link still works once the cause is fixed, which is what makes
      // the failure recoverable rather than a dead account.
      const recovered = serviceWith();
      await recovered.verifyEmail(signed.verificationToken.expose());
      assert.equal((await tenantRow(signed.tenantId)).provisioning_state, 'ready');
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC8 two simultaneous signups each get their own distinct, correctly isolated tenant',
    'concurrent signups do not cross-contaminate',
    async () => {
      const a = nextIdentity();
      const b = nextIdentity();
      const [first, second] = await Promise.all([
        service.signUp({ ...a, password: PASSWORD }),
        service.signUp({ ...b, password: PASSWORD }),
      ]);

      assert.notEqual(first.tenantId, second.tenantId);
      await Promise.all([
        service.verifyEmail(first.verificationToken.expose()),
        service.verifyEmail(second.verificationToken.expose()),
      ]);

      const sessionA = await service.logIn({ email: a.email, password: PASSWORD });
      const names = await service.withClientSession(sessionA.token.expose(), async (tx) => {
        const found = await tx.query<{ business_name: string }>('SELECT business_name FROM tenants');
        return found.rows.map((r) => r.business_name);
      });
      // Exactly one tenant is visible, and it is the right one.
      assert.deepEqual(names, [a.businessName]);
    },
  );

  // -------------------------------------------------------------------------
  // Client authentication
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC1 a verified client with correct credentials lands in a session scoped to their own tenant',
    'login issues a session bound to the account’s tenant',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });

      assert.equal(session.tenantId, onboarded.tenantId);
      assert.equal(session.accountId, onboarded.accountId);
      const principal = await service.resolveClientSession(session.token.expose());
      assert.deepEqual(principal, {
        type: 'client',
        accountId: onboarded.accountId,
        tenantId: onboarded.tenantId,
        sessionId: session.sessionId,
      });
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC4 the tenant a session acts on is the one bound by the system, not one supplied by the caller',
    'a session cannot reach another tenant’s rows even with that tenant’s identifiers',
    async () => {
      const alpha = await onboard();
      const beta = await onboard();
      const session = await service.logIn({ email: alpha.email, password: PASSWORD });

      const seen = await service.withClientSession(session.token.expose(), async (tx, principal) => {
        assert.equal(principal.tenantId, alpha.tenantId);
        // Beta's identifiers are supplied out of context, exactly as
        // tenant-data-isolation.md AC9 describes. Row-level security answers.
        const otherTenant = await tx.query('SELECT id FROM tenants WHERE id = $1', [beta.tenantId]);
        const otherAccount = await tx.query('SELECT id FROM accounts WHERE id = $1', [
          beta.accountId,
        ]);
        const ownTenant = await tx.query('SELECT id FROM tenants WHERE id = $1', [alpha.tenantId]);
        return {
          other: otherTenant.rows.length + otherAccount.rows.length,
          own: ownTenant.rows.length,
        };
      });

      // The positive half matters: without it, a policy that hid everything
      // would pass the negative half while proving nothing.
      assert.equal(seen.own, 1, 'the session could not see its own tenant');
      assert.equal(seen.other, 0, 'the session reached another tenant’s rows');
    },
  );

  specTest(
    'client-signup-and-tenancy.md',
    'AC5 an unverified client is blocked from a fully provisioned tenant',
    'correct credentials on an unverified account do not produce a session',
    async () => {
      const { email, businessName } = nextIdentity();
      await service.signUp({ businessName, email, password: PASSWORD });
      await assert.rejects(() => service.logIn({ email, password: PASSWORD }), AuthenticationError);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC3 a failed login for an unknown email is indistinguishable from one for a known email',
    'both failures produce the same error, with no distinguishing detail',
    async () => {
      const onboarded = await onboard();
      const unknown = await service
        .logIn({ email: `nobody-${counter}@example.com`, password: PASSWORD })
        .then(() => undefined, (error: unknown) => error);
      const wrongPassword = await service
        .logIn({ email: onboarded.email, password: 'entirely-wrong-passphrase' })
        .then(() => undefined, (error: unknown) => error);

      assert.ok(unknown instanceof AuthenticationError);
      assert.ok(wrongPassword instanceof AuthenticationError);
      // Compared as diagnostics, which is what a caller or a log would actually
      // see: kind, code, retryability, and context.
      assert.deepEqual(toDiagnostic(unknown), toDiagnostic(wrongPassword));
      assert.equal(unknown.message, wrongPassword.message);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC12 repeated failed attempts are throttled rather than evaluated at full rate',
    'the account locks after the threshold, and the correct password stops working',
    async () => {
      const onboarded = await onboard();

      for (let attempt = 0; attempt < BASE_POLICY.maxFailedAttempts; attempt += 1) {
        await assert.rejects(
          () => service.logIn({ email: onboarded.email, password: 'entirely-wrong-passphrase' }),
          AuthenticationError,
        );
        if (attempt === 0) {
          // The counter must survive the rejection. If the login threw from
          // inside its transaction this would be 0, the lockout would never
          // engage, and every other assertion in this test would still pass.
          const count = await withIdentityScope(pool, async (tx) => {
            const found = await tx.query<{ failed_attempt_count: number }>(
              'SELECT failed_attempt_count FROM accounts WHERE id = $1',
              [onboarded.accountId],
            );
            return found.rows[0]!.failed_attempt_count;
          });
          assert.equal(count, 1, 'the failed-attempt counter was rolled back');
        }
      }

      const locked = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query<{ locked: boolean }>(
          'SELECT (locked_until IS NOT NULL AND locked_until > now()) AS locked FROM accounts WHERE id = $1',
          [onboarded.accountId],
        );
        return found.rows[0]!.locked;
      });
      assert.equal(locked, true);

      // The observable proof that credentials are no longer being evaluated:
      // the *right* password is refused too.
      await assert.rejects(
        () => service.logIn({ email: onboarded.email, password: PASSWORD }),
        AuthenticationError,
      );
    },
  );

  unitTest('a lockout lifts on its own, with no operator involvement', async () => {
    // client-signup-and-tenancy.md requires every recovery path work without the
    // operator. A lockout that needed clearing by hand would breach that for the
    // most common support request there is.
    const brief = serviceWith({ maxFailedAttempts: 2, lockoutMs: 500 });
    const onboarded = await onboard(brief);
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(() => brief.logIn({ email: onboarded.email, password: 'wrong-passphrase-x' }));
    }
    await assert.rejects(() => brief.logIn({ email: onboarded.email, password: PASSWORD }));

    await sleep(900);
    const session = await brief.logIn({ email: onboarded.email, password: PASSWORD });
    assert.equal(session.tenantId, onboarded.tenantId);
  });

  // -------------------------------------------------------------------------
  // Session lifetime
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC5 a session idle beyond the inactivity period requires re-authentication',
    'an idle session stops resolving',
    async () => {
      const brief = serviceWith({ sessionInactivityMs: 800, sessionAbsoluteLifetimeMs: 60_000 });
      const onboarded = await onboard(brief);
      const session = await brief.logIn({ email: onboarded.email, password: PASSWORD });

      assert.equal((await brief.resolveClientSession(session.token.expose())).sessionId, session.sessionId);
      await sleep(1200);
      await assert.rejects(
        () => brief.resolveClientSession(session.token.expose()),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC6 a session past its absolute lifetime is invalid even under continuous activity',
    'continuous use does not extend a session past its absolute lifetime',
    async () => {
      const brief = serviceWith({ sessionInactivityMs: 60_000, sessionAbsoluteLifetimeMs: 1500 });
      const onboarded = await onboard(brief);
      const session = await brief.logIn({ email: onboarded.email, password: PASSWORD });

      // Kept continuously active, which defeats an inactivity timeout entirely.
      // That is precisely why the absolute bound exists as a second rule.
      //
      // The loop is bounded by elapsed time rather than by an iteration count on
      // purpose: with a fixed count, a slow database round trip pushes the last
      // resolution past the absolute bound and the test fails inside the loop,
      // reporting a rejection where it expected success. Bounding by the clock
      // keeps the activity phase comfortably inside the window on any machine.
      const startedAt = Date.now();
      while (Date.now() - startedAt < 700) {
        await sleep(150);
        await brief.resolveClientSession(session.token.expose());
      }
      while (Date.now() - startedAt < 2000) await sleep(100);
      await assert.rejects(
        () => brief.resolveClientSession(session.token.expose()),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC7 logging out ends the session everywhere it was open',
    'a revoked session token stops resolving',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const token = session.token.expose();

      assert.equal(await service.logOut(token), true);
      await assert.rejects(() => service.resolveClientSession(token), AuthenticationError);
      // Idempotent, and the second call says nothing new — a logout endpoint
      // that distinguished "ended" from "no such session" would be an
      // unauthenticated token-validity oracle.
      assert.equal(await service.logOut(token), false);
    },
  );

  // -------------------------------------------------------------------------
  // Password change and recovery
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC10 a password change invalidates every existing session for that account',
    'changing the password ends sessions opened before it',
    async () => {
      const onboarded = await onboard();
      const first = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const second = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const principal = await service.resolveClientSession(first.token.expose());

      await service.changePassword({
        principal,
        currentPassword: PASSWORD,
        newPassword: NEW_PASSWORD,
      });

      // Both mechanisms are in play: the sessions are explicitly revoked, and
      // `credentials_changed_at` moved past their creation time so that one
      // created concurrently in another transaction would also be refused.
      for (const session of [first, second]) {
        await assert.rejects(
          () => service.resolveClientSession(session.token.expose()),
          AuthenticationError,
        );
      }
      await assert.rejects(
        () => service.logIn({ email: onboarded.email, password: PASSWORD }),
        AuthenticationError,
      );
      const reissued = await service.logIn({ email: onboarded.email, password: NEW_PASSWORD });
      assert.equal(reissued.tenantId, onboarded.tenantId);
    },
  );

  unitTest('a wrong current password neither changes the credential nor counts toward lockout', async () => {
    // Incrementing here would let anyone holding a stolen session lock the
    // rightful owner out, converting a confidentiality breach into a denial of
    // service against the victim.
    const onboarded = await onboard();
    const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
    const principal = await service.resolveClientSession(session.token.expose());

    for (let i = 0; i < BASE_POLICY.maxFailedAttempts + 2; i += 1) {
      await assert.rejects(
        () =>
          service.changePassword({
            principal,
            currentPassword: 'not-the-current-passphrase',
            newPassword: NEW_PASSWORD,
          }),
        AuthenticationError,
      );
    }
    const stillWorks = await service.logIn({ email: onboarded.email, password: PASSWORD });
    assert.equal(stillWorks.tenantId, onboarded.tenantId);
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC11 recovery returns the client to their existing tenant without creating a second one',
    'a password reset restores access to the same tenant',
    async () => {
      const onboarded = await onboard();
      const before = await countTenants();

      const issued = await service.requestPasswordReset(onboarded.email);
      assert.ok(issued !== undefined);
      const reset = await service.resetPassword({
        token: issued.token.expose(),
        newPassword: NEW_PASSWORD,
      });

      assert.equal(reset.tenantId, onboarded.tenantId);
      assert.equal(await countTenants(), before, 'recovery created a second tenant');
      const session = await service.logIn({ email: onboarded.email, password: NEW_PASSWORD });
      assert.equal(session.tenantId, onboarded.tenantId);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC8 completing a reset changes the password and invalidates every existing session',
    'a reset ends sessions that were open when it happened',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const issued = await service.requestPasswordReset(onboarded.email);
      assert.ok(issued !== undefined);

      await service.resetPassword({ token: issued.token.expose(), newPassword: NEW_PASSWORD });
      await assert.rejects(
        () => service.resolveClientSession(session.token.expose()),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC9 a recovery request for an unregistered email is answered as if it were registered',
    'requesting a reset for an unknown address neither fails nor reveals anything',
    async () => {
      // The call must not throw — a thrown error would be the exact signal the
      // criterion forbids, since the caller would render it differently.
      const issued = await service.requestPasswordReset(`nobody-${Date.now()}@example.com`);
      assert.equal(issued, undefined);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC11 a reset link that has already been used is rejected',
    'a reset token is single-use',
    async () => {
      const onboarded = await onboard();
      const issued = await service.requestPasswordReset(onboarded.email);
      assert.ok(issued !== undefined);
      const token = issued.token.expose();
      await service.resetPassword({ token, newPassword: NEW_PASSWORD });

      await assert.rejects(
        () => service.resetPassword({ token, newPassword: 'another-valid-passphrase-9' }),
        (error: unknown) =>
          error instanceof ValidationError &&
          error.issues.some((issue) => issue.reason.includes('already been used')),
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC11 a reset link older than its expiry period is rejected',
    'an expired reset token is refused',
    async () => {
      const brief = serviceWith({ passwordResetTtlMs: 200 });
      const onboarded = await onboard(brief);
      const issued = await brief.requestPasswordReset(onboarded.email);
      assert.ok(issued !== undefined);

      await sleep(400);
      await assert.rejects(
        () => brief.resetPassword({ token: issued.token.expose(), newPassword: NEW_PASSWORD }),
        (error: unknown) =>
          error instanceof ValidationError &&
          error.issues.some((issue) => issue.reason.includes('expired')),
      );
    },
  );

  unitTest('issuing a new reset link invalidates the previous one', async () => {
    // Several simultaneously valid takeover links multiply the chance one ends
    // up somewhere it should not, for no benefit: only the newest is ever used.
    const onboarded = await onboard();
    const first = await service.requestPasswordReset(onboarded.email);
    const second = await service.requestPasswordReset(onboarded.email);
    assert.ok(first !== undefined && second !== undefined);

    await assert.rejects(
      () => service.resetPassword({ token: first.token.expose(), newPassword: NEW_PASSWORD }),
      ValidationError,
    );
    await service.resetPassword({ token: second.token.expose(), newPassword: NEW_PASSWORD });
  });

  unitTest('a reset clears a lockout, so a locked-out client can recover unaided', async () => {
    const brief = serviceWith({ maxFailedAttempts: 2, lockoutMs: 60_000 });
    const onboarded = await onboard(brief);
    for (let i = 0; i < 2; i += 1) {
      await assert.rejects(() => brief.logIn({ email: onboarded.email, password: 'wrong-passphrase-x' }));
    }
    const issued = await brief.requestPasswordReset(onboarded.email);
    assert.ok(issued !== undefined);
    await brief.resetPassword({ token: issued.token.expose(), newPassword: NEW_PASSWORD });

    const session = await brief.logIn({ email: onboarded.email, password: NEW_PASSWORD });
    assert.equal(session.tenantId, onboarded.tenantId);
  });

  // -------------------------------------------------------------------------
  // Operator identity
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC13 an unauthenticated caller reaching an operator surface is denied',
    'a fabricated operator token resolves to nothing',
    async () => {
      await assert.rejects(
        () => service.resolveOperatorSession(mintToken('operator_session').token.expose()),
        AuthenticationError,
      );
      await assert.rejects(
        () => service.withOperatorSession('not-a-token', async () => 'reached'),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC21 a client session token is rejected as insufficient for operator access',
    'a client token cannot open an operator session',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      await assert.rejects(
        () => service.resolveOperatorSession(session.token.expose()),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC22 an operator session token is rejected as insufficient for client access',
    'an operator token cannot open a tenant-scoped session',
    async () => {
      counter += 1;
      const email = `operator-${counter}@example.com`;
      await service.createOperator({ email, password: PASSWORD });
      const session = await service.operatorLogIn({ email, password: PASSWORD });

      await assert.rejects(
        () => service.resolveClientSession(session.token.expose()),
        AuthenticationError,
      );
      await assert.rejects(
        () => service.withClientSession(session.token.expose(), async () => 'reached'),
        AuthenticationError,
      );
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC14 an authenticated operator can see per-tenant health across all tenants',
    'an operator session reads across tenants under the platform scope',
    async () => {
      const alpha = await onboard();
      const beta = await onboard();
      counter += 1;
      const email = `operator-${counter}@example.com`;
      await service.createOperator({ email, password: PASSWORD });
      const session = await service.operatorLogIn({ email, password: PASSWORD });

      const ids = await service.withOperatorSession(session.token.expose(), async (tx) => {
        const found = await tx.query<{ id: string }>('SELECT id FROM tenants');
        return found.rows.map((r) => r.id);
      });
      assert.ok(ids.includes(alpha.tenantId) && ids.includes(beta.tenantId));
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC15 an operator is denied tenant-private data through any surface, not only the dashboard',
    'the platform scope an operator session opens cannot read tenant-private tables',
    async () => {
      const onboarded = await onboard();
      counter += 1;
      const email = `operator-${counter}@example.com`;
      await service.createOperator({ email, password: PASSWORD });
      const session = await service.operatorLogIn({ email, password: PASSWORD });

      // `accounts` stands in for every tenant-private table: it carries no
      // platform-read policy, so no setting an operator surface could apply
      // makes it visible. The conversation tables land in P2 and inherit the
      // same rule by default — absence of a policy, not presence of a filter.
      const rows = await service.withOperatorSession(session.token.expose(), async (tx) => {
        const found = await tx.query('SELECT id FROM accounts WHERE id = $1', [onboarded.accountId]);
        return found.rows.length;
      });
      assert.equal(rows, 0, 'an operator session reached a tenant-private table');

      // And the row genuinely exists, so the zero above is a refusal rather
      // than an empty table.
      const exists = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query('SELECT id FROM accounts WHERE id = $1', [onboarded.accountId]);
        return found.rows.length;
      });
      assert.equal(exists, 1);
    },
  );

  unitTest('an operator password change ends every operator session', async () => {
    counter += 1;
    const email = `operator-${counter}@example.com`;
    await service.createOperator({ email, password: PASSWORD });
    const session = await service.operatorLogIn({ email, password: PASSWORD });
    const principal = await service.resolveOperatorSession(session.token.expose());

    await service.changeOperatorPassword({
      principal,
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    await assert.rejects(
      () => service.resolveOperatorSession(session.token.expose()),
      AuthenticationError,
    );
  });

  unitTest('a second operator cannot be created on the same address', async () => {
    counter += 1;
    const email = `operator-${counter}@example.com`;
    await service.createOperator({ email, password: PASSWORD });
    await assert.rejects(
      () => service.createOperator({ email, password: PASSWORD }),
      (error: unknown) => error instanceof ConflictError && error.code === 'identity.operator_exists',
    );
  });

  // -------------------------------------------------------------------------
  // Tenant lifecycle interaction
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC20 a client may still authenticate during the retention window after offboarding',
    'an offboarded tenant still admits its client, so they can reactivate',
    async () => {
      const onboarded = await onboard();
      await withIdentityScope(pool, (tx) =>
        tx.query(
          `UPDATE tenants SET lifecycle_state = 'offboarded', offboarded_at = now(),
                              retention_expires_at = now() + interval '30 days'
           WHERE id = $1`,
          [onboarded.tenantId],
        ),
      );

      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      assert.equal(session.tenantId, onboarded.tenantId);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC19 credentials belonging to a permanently deleted tenant no longer authenticate',
    'a permanently deleted tenant refuses login and invalidates live sessions',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });

      await withIdentityScope(pool, (tx) =>
        tx.query(
          `UPDATE tenants SET lifecycle_state = 'permanently_deleted', permanently_deleted_at = now()
           WHERE id = $1`,
          [onboarded.tenantId],
        ),
      );

      await assert.rejects(
        () => service.logIn({ email: onboarded.email, password: PASSWORD }),
        AuthenticationError,
      );
      // A session issued before deletion must not survive it either.
      await assert.rejects(
        () => service.resolveClientSession(session.token.expose()),
        AuthenticationError,
      );
      // Nor may recovery be used to get back in.
      assert.equal(await service.requestPasswordReset(onboarded.email), undefined);
    },
  );

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC18 access records answer who accessed what and when',
    'every authentication decision leaves an attributable record',
    async () => {
      const onboarded = await onboard();
      await service.logIn({ email: onboarded.email, password: PASSWORD });
      await assert.rejects(() => service.logIn({ email: onboarded.email, password: 'wrong-one-here' }));

      // The operator's view, which is the one AC18 describes: "when the operator
      // or an auditor later reviews the access records". `access_records` grants
      // SELECT to the platform scope and to a bound tenant, and to nothing else —
      // notably not to the identity scope that wrote the rows.
      const records = await withPlatformScope(pool, async (tx) => {
        const found = await tx.query<{
          action: string;
          outcome: string;
          reason: string | null;
          occurred_at: Date;
          principal_id: string | null;
        }>(
          `SELECT action, outcome, reason, occurred_at, principal_id
           FROM access_records WHERE tenant_id = $1 ORDER BY id`,
          [onboarded.tenantId],
        );
        return found.rows;
      });

      const actions = records.map((r) => `${r.action}:${r.outcome}`);
      assert.deepEqual(actions, [
        'client.signup:allowed',
        'client.email_verified:allowed',
        'client.login:allowed',
        'client.login:denied',
      ]);
      assert.equal(records.at(-1)!.reason, 'bad_credential');
      assert.equal(records.at(-1)!.principal_id, onboarded.accountId);
      assert.ok(records.every((r) => r.occurred_at instanceof Date));
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC18 the access records contain no conversation content',
    'no access record carries an email address or any caller-supplied value',
    async () => {
      const onboarded = await onboard();
      await assert.rejects(() => service.logIn({ email: onboarded.email, password: 'wrong-one-here' }));
      await service.requestPasswordReset(`nobody-${counter}@example.com`);

      const { rendered, count } = await withPlatformScope(pool, async (tx) => {
        const found = await tx.query('SELECT * FROM access_records');
        return { rendered: JSON.stringify(found.rows), count: found.rows.length };
      });

      // Asserted first, because a leak test over an empty result set passes for
      // the wrong reason — the failure mode IMPLEMENTATION_PLAN.md §4d records
      // about a needle that can match a fixture identifier, arriving from the
      // other direction.
      assert.ok(count > 0, 'no access records were readable, so nothing was actually inspected');

      // The reason vocabulary is a closed list precisely so this holds: there is
      // no path by which an identifier a caller supplied can reach this table.
      assert.equal(rendered.includes(onboarded.email), false, 'an email reached the audit trail');
      assert.equal(rendered.includes('example.com'), false);
      assert.equal(rendered.includes(PASSWORD), false);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC3 possession of the stored credential form alone does not permit authentication',
    'the stored credential cannot be replayed as the password',
    async () => {
      const onboarded = await onboard();
      const stored = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query<{ credential_hash: string }>(
          'SELECT credential_hash FROM accounts WHERE id = $1',
          [onboarded.accountId],
        );
        return found.rows[0]!.credential_hash;
      });

      assert.equal(stored.includes(PASSWORD), false);
      assert.match(stored, /^scrypt\$/);
      await assert.rejects(
        () => service.logIn({ email: onboarded.email, password: stored }),
        AuthenticationError,
      );
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC4 stored data alone is insufficient to use a session credential',
    'the stored session row holds a digest, not the bearer token',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const stored = await withIdentityScope(pool, async (tx) => {
        const found = await tx.query<{ token_hash: string }>(
          'SELECT token_hash FROM client_sessions WHERE id = $1',
          [session.sessionId],
        );
        return found.rows[0]!.token_hash;
      });

      assert.equal(stored.includes(session.token.expose()), false);
      // Presenting the stored form is not presenting the token.
      await assert.rejects(() => service.resolveClientSession(stored), AuthenticationError);
    },
  );

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC16/AC17 an operator is denied activation changes and offboarding, and the denial is recorded',
    'a refused action is written to the access records as denied',
    async () => {
      counter += 1;
      const email = `operator-${counter}@example.com`;
      const { operatorId } = await service.createOperator({ email, password: PASSWORD });
      const session = await service.operatorLogIn({ email, password: PASSWORD });
      const principal = await service.resolveOperatorSession(session.token.expose());

      await assert.rejects(() => service.authorize(principal, 'tenant.offboard', 'tenant'));
      await assert.rejects(() => service.authorize(principal, 'tenant.activation.change', 'tenant'));
      await service.authorize(principal, 'platform.health.read', 'health');

      const decisions = await withPlatformScope(pool, async (tx) => {
        const found = await tx.query<{ action: string; outcome: string; reason: string | null }>(
          `SELECT action, outcome, reason FROM access_records
           WHERE principal_id = $1 AND action NOT LIKE 'operator.%'
           ORDER BY id`,
          [operatorId],
        );
        return found.rows;
      });
      assert.deepEqual(decisions, [
        { action: 'tenant.offboard', outcome: 'denied', reason: 'forbidden_action' },
        { action: 'tenant.activation.change', outcome: 'denied', reason: 'forbidden_action' },
        { action: 'platform.health.read', outcome: 'allowed', reason: null },
      ]);
    },
  );
  specTest(
    'authentication-and-access.md',
    'AC18 an authorization event records who accessed what and when',
    'withClientAction records the decision, and refuses a client an operator action before opening any tenant transaction',
    async () => {
      const onboarded = await onboard();
      const session = await service.logIn({ email: onboarded.email, password: PASSWORD });
      const token = session.token.expose();

      const seen = await service.withClientAction(token, 'tenant.configuration.read', 'bot.persona', async (tx, principal) => {
        const found = await tx.query<{ id: string }>('SELECT id FROM tenants');
        return { principal: principal.tenantId, tenants: found.rows.map((row) => row.id) };
      });
      assert.deepEqual(seen, { principal: onboarded.tenantId, tenants: [onboarded.tenantId] });

      let reached = false;
      await assert.rejects(
        () =>
          service.withClientAction(token, 'platform.health.read', 'health', async () => {
            reached = true;
          }),
        AuthorizationError,
      );
      assert.equal(reached, false, 'the work ran even though the action was refused');

      const decisions = await withPlatformScope(pool, async (tx) => {
        const found = await tx.query<{ action: string; resource: string; outcome: string }>(
          `SELECT action, resource, outcome FROM access_records
           WHERE principal_id = $1 AND resource IN ('bot.persona', 'health') ORDER BY id`,
          [onboarded.accountId],
        );
        return found.rows;
      });
      assert.deepEqual(decisions, [
        { action: 'tenant.configuration.read', resource: 'bot.persona', outcome: 'allowed' },
        { action: 'platform.health.read', resource: 'health', outcome: 'denied' },
      ]);
    },
  );
});
