/**
 * The control plane's identity domain: signup, tenant provisioning, client and
 * operator authentication, sessions, and self-service recovery.
 *
 * This is where `client-signup-and-tenancy.md` and `authentication-and-access.md`
 * become behaviour. It deliberately contains no HTTP: the service that exposes
 * these operations owns status codes, cookies, and rate limiting, and this owns
 * what is true about identity. Splitting them that way is what lets every rule
 * below be tested against a real PostgreSQL without a server in the loop, which
 * matters because the rules that are hardest to get right — the tenant binding,
 * the session-invalidation-on-credential-change, the failed-attempt counter that
 * must survive a rollback — are all database behaviour.
 *
 * ## Five decisions that shape everything here
 *
 * **1. The tenant binding is derived, never accepted.** `authentication-and-
 * access.md` requires the tenant be "established by the system from the
 * authenticated identity itself, never accepted from a tenant identifier,
 * parameter, or assertion supplied by the caller". The enforcement is structural:
 * no function on this service takes a tenant id. `logIn` reads it from the
 * account row, writes it onto the session row, and `withClientSession` opens the
 * tenant-bound transaction from that stored value. There is no parameter a
 * confused or malicious caller could fill in.
 *
 * **2. Failure outcomes are returned from the transaction and thrown outside
 * it.** A failed login must increment a counter that *persists*, and throwing
 * from inside a transaction rolls that increment back — so the lockout in AC12
 * would never trigger, and nothing would look wrong. Every credential-evaluating
 * method therefore has its transaction return a discriminated outcome, and the
 * throw happens after the commit. This is the single most easily-broken thing in
 * the file; the tests assert the counter, not just the rejection.
 *
 * **3. The caller learns nothing about why authentication failed.** AC3 requires
 * a failed attempt for an unknown email be indistinguishable from one for a known
 * email. `AuthenticationError` carries no reason by construction, and the reason
 * goes to `access_records` instead, which is not a channel the attempting caller
 * can read. Unverified email and a not-yet-ready tenant are folded into the same
 * response for the same reason: "this address exists but is unverified" is an
 * account-enumeration oracle wearing a helpful-error-message disguise.
 *
 * Signup is the deliberate exception. AC3 of `client-signup-and-tenancy.md`
 * requires a duplicate email be "rejected with a clear reason", which is a
 * conscious trade in the spec: a signup form that cannot say "that address is
 * already registered" is unusable. The enumeration surface is narrowed instead by
 * the login and recovery paths staying silent.
 *
 * **4. Time comes from the database, not from a clock in this process.** Every
 * expiry comparison is `now()` evaluated by PostgreSQL. The reason is the same
 * one `@zeddev/queue` gives for leases: several service instances share these
 * rows, and if each judged expiry by its own clock, an instance running fast
 * would reject sessions its neighbours still honour — a session that works or
 * does not depending on which container answered. The cost is that expiry cannot
 * be simulated with a `FakeClock`, so the tests configure very short windows and
 * really wait, exactly as the queue's do.
 *
 * **5. Provisioning is one transaction, with a visible failed state.**
 * `client-signup-and-tenancy.md` AC7 requires that a provisioning failure leave
 * the client with an error state and *not* "a usable account pointing at a
 * partial tenant". Both halves are honoured: the work runs inside the
 * verification transaction, so a failure rolls back everything and no partial
 * tenant can exist; and afterwards, in a transaction of its own, the tenant is
 * marked `failed` and a lifecycle event is recorded, so the state is visible and
 * a login is refused. The verification token is left unconsumed, so the client
 * can retry the same link once the cause is fixed.
 */

import {
  bindTenantContext,
  withIdentityScope,
  withPlatformScope,
  withTenant,
  type Connection,
  type Pool,
} from '@zeddev/db';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  ValidationError,
} from '@zeddev/errors';
import { Logger } from '@zeddev/logging';
import { hashCredential, verifyCredential, Secret, type ScryptParams } from '@zeddev/secrets';
import type { TenantId } from '@zeddev/tenancy';
import { recordAccess, recordAccessOutOfBand, type DenialReason } from './access.ts';
import { assertBusinessName, assertEmail, assertPasswordStrength } from './credentials.ts';
import type { IdentityPolicy } from './config.ts';
import {
  authorize,
  principalId,
  type Action,
  type ClientPrincipal,
  type OperatorPrincipal,
  type Principal,
} from './principals.ts';
import { hasTokenKind, hashToken, mintToken } from './tokens.ts';

/**
 * Work that must succeed for a tenant to be usable, run inside the verification
 * transaction with the tenant already bound.
 *
 * The hook exists because provisioning is not finished as a concept: as later
 * phases land, a ready tenant may also need its language setting and its
 * knowledge index. (Not a persona row: a never-configured persona is the absence
 * of one, which is what keeps readiness unmet until the client names their bot.)
 * Nothing needs seeding yet, so the default hook does nothing — but the *failure semantics* around it are fully
 * implemented and tested, which is the part that is expensive to retrofit. A hook
 * that throws produces exactly the state AC7 describes, and there is a test that
 * drives it.
 *
 * The connection handed in is bound to the new tenant, so anything the hook
 * writes is subject to the same row-level security as the running application.
 */
export type TenantProvisioning = (context: {
  readonly connection: Connection;
  readonly tenantId: TenantId;
  readonly accountId: string;
  readonly businessName: string;
}) => Promise<void>;

export interface IdentityServiceOptions {
  readonly pool: Pool;
  readonly policy: IdentityPolicy;
  readonly logger?: Logger | undefined;
  /**
   * scrypt cost for account credentials.
   *
   * Defaults to `@zeddev/secrets`' production parameters, which cost roughly
   * 32 MiB and ~100 ms per hash — the point of them. Overridable solely so the
   * test suite is not dominated by deliberate slowness; nothing in a deployment
   * should set it, which is why it is a constructor option rather than an
   * environment variable. A weakened cost supplied through configuration would be
   * a security control that a misconfigured deployment can silently switch off.
   */
  readonly credentialParams?: ScryptParams | undefined;
  readonly provisionTenant?: TenantProvisioning | undefined;
}

export interface SignUpInput {
  readonly businessName: string;
  readonly email: string;
  readonly password: string;
}

/**
 * What signup produces.
 *
 * The verification token is returned rather than sent, because delivering mail is
 * a transport concern this domain does not own — the same separation that keeps
 * the WhatsApp transport out of the conversation domain. The caller is expected
 * to hand it to a mail port; see IMPLEMENTATION_PLAN.md for that follow-up.
 */
export interface SignUpResult {
  readonly tenantId: TenantId;
  readonly accountId: string;
  readonly email: string;
  readonly verificationToken: Secret<string>;
  readonly verificationExpiresAt: Date;
}

export interface TokenIssued {
  readonly accountId: string;
  readonly tenantId: TenantId;
  readonly email: string;
  readonly token: Secret<string>;
  readonly expiresAt: Date;
}

export interface ClientSessionIssued {
  readonly sessionId: string;
  readonly accountId: string;
  readonly tenantId: TenantId;
  readonly token: Secret<string>;
  readonly absoluteExpiresAt: Date;
}

export interface OperatorSessionIssued {
  readonly sessionId: string;
  readonly operatorId: string;
  readonly token: Secret<string>;
  readonly absoluteExpiresAt: Date;
}

/** The shape every credential-evaluating transaction returns. See decision 2. */
type Outcome<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: DenialReason };

/** Milliseconds as the seconds `make_interval` wants. */
function secs(ms: number): number {
  return ms / 1000;
}

/**
 * A stored hash that no password matches, used to make an unknown account cost
 * the same as a known one.
 *
 * Without it, a login for an address with no account returns as soon as the
 * `SELECT` misses, while a login for a real address pays a full scrypt. The
 * difference is ~100 ms and trivially measurable over a network, which hands an
 * attacker the account-enumeration oracle AC3 exists to close — the careful
 * wording of the *response* would be undone by the timing of it.
 *
 * Computed once per service and per cost parameter set, because computing it on
 * every miss would make an unknown-account login cost *two* scrypts and reopen
 * the same channel in the other direction.
 */
async function decoyHash(params: ScryptParams | undefined): Promise<string> {
  return params === undefined
    ? hashCredential(DECOY_INPUT)
    : hashCredential(DECOY_INPUT, params);
}

/** Never a real credential — it exists only to be hashed and never matched. */
const DECOY_INPUT = 'decoy-input-for-constant-time-authentication';

export class IdentityService {
  readonly #pool: Pool;
  readonly #policy: IdentityPolicy;
  readonly #logger: Logger;
  readonly #credentialParams: ScryptParams | undefined;
  readonly #provisionTenant: TenantProvisioning;
  #decoy: Promise<string> | undefined;

  constructor(options: IdentityServiceOptions) {
    this.#pool = options.pool;
    this.#policy = options.policy;
    this.#logger = (options.logger ?? new Logger()).child({ component: 'identity' });
    this.#credentialParams = options.credentialParams;
    this.#provisionTenant = options.provisionTenant ?? (async () => undefined);
  }

  get policy(): IdentityPolicy {
    return this.#policy;
  }

  #hash(plaintext: string): Promise<string> {
    return this.#credentialParams === undefined
      ? hashCredential(plaintext)
      : hashCredential(plaintext, this.#credentialParams);
  }

  /** Burn the same work an unsuccessful real verification would. See `decoyHash`. */
  async #equalizeTiming(plaintext: string): Promise<void> {
    this.#decoy ??= decoyHash(this.#credentialParams);
    await verifyCredential(plaintext, await this.#decoy);
  }

  // -------------------------------------------------------------------------
  // Signup and provisioning
  // -------------------------------------------------------------------------

  /**
   * Create an account and its tenant, and issue a verification token.
   *
   * Everything happens in one transaction. `client-signup-and-tenancy.md` AC3
   * requires that a duplicate submission create "no duplicate account or tenant",
   * and the tenant row is written before the account row — so a uniqueness
   * failure on the account must undo the tenant, which is what a single
   * transaction gives for free and what two sequential writes would not.
   *
   * The tenant is left in `provisioning`, not `ready`. AC5 of the same spec
   * requires a client who has not verified their email be blocked "from accessing
   * a fully provisioned, isolated tenant until verification completes", so the
   * transition to usable belongs to `verifyEmail` and to nothing else.
   */
  async signUp(input: SignUpInput): Promise<SignUpResult> {
    const businessName = assertBusinessName(input.businessName);
    const email = assertEmail(input.email);
    assertPasswordStrength(input.password, {
      minLength: this.#policy.minPasswordLength,
      email,
      businessName,
    });
    const credentialHash = await this.#hash(input.password);
    const verification = mintToken('email_verification');

    try {
      const result = await withIdentityScope(this.#pool, async (tx) => {
        const tenant = await tx.query<{ id: string }>(
          'INSERT INTO tenants (business_name) VALUES ($1) RETURNING id',
          [businessName],
        );
        const tenantId = tenant.rows[0]!.id;

        let accountId: string;
        try {
          const account = await tx.query<{ id: string }>(
            'INSERT INTO accounts (tenant_id, email, credential_hash) VALUES ($1, $2, $3) RETURNING id',
            [tenantId, email, credentialHash],
          );
          accountId = account.rows[0]!.id;
        } catch (error) {
          // The only unique constraint on `accounts` is the cross-tenant email
          // index, so a conflict here can mean nothing else. Re-thrown as a
          // domain error carrying a code the API layer can map, rather than
          // leaking a database constraint name upward.
          if (error instanceof ConflictError) {
            throw new ConflictError('That email address is already registered', {
              code: 'identity.email_in_use',
            });
          }
          throw error;
        }

        const token = await tx.query<{ expires_at: Date }>(
          `INSERT INTO account_tokens (tenant_id, account_id, purpose, token_hash, expires_at)
           VALUES ($1, $2, 'email_verification', $3, now() + make_interval(secs => $4::double precision))
           RETURNING expires_at`,
          [tenantId, accountId, verification.hash, secs(this.#policy.emailVerificationTtlMs)],
        );

        await recordAccess(tx, {
          principalType: 'client',
          principalId: accountId,
          tenantId,
          action: 'client.signup',
          resource: 'tenant',
          outcome: 'allowed',
        });

        return {
          tenantId,
          accountId,
          email,
          verificationToken: verification.token,
          verificationExpiresAt: token.rows[0]!.expires_at,
        };
      });

      this.#logger.info('identity.signup.accepted', { tenantId: result.tenantId, principal: result.accountId });
      return result;
    } catch (error) {
      // Matched on the code rather than on the class. Any unique constraint in
      // the transaction produces a `ConflictError`, and recording an unrelated
      // one as `duplicate_email` would put a wrong classification into the audit
      // trail — the one table whose value is that it can be trusted literally.
      if (error instanceof ConflictError && error.code === 'identity.email_in_use') {
        // The transaction is gone, and with it any record written inside it —
        // which is why this one is written out of band. A duplicate signup is
        // the denial most worth having in the audit trail, because a burst of
        // them is what credential stuffing against the signup form looks like.
        await recordAccessOutOfBand(this.#pool, {
          principalType: 'anonymous',
          action: 'client.signup',
          resource: 'tenant',
          outcome: 'denied',
          reason: 'duplicate_email',
        });
        this.#logger.warn('identity.signup.rejected', { reason: 'duplicate_email' });
      }
      throw error;
    }
  }

  /**
   * Redeem a verification token, provision the tenant, and make it usable.
   *
   * The single-use guarantee AC11 requires is enforced by the `UPDATE ... WHERE
   * consumed_at IS NULL` returning zero rows on a second attempt, not by the
   * `SELECT` that read the row a moment earlier. That distinction is the whole
   * of the concurrency safety: two simultaneous redemptions both see an
   * unconsumed row, and exactly one of them wins the update.
   */
  async verifyEmail(rawToken: string): Promise<{ tenantId: TenantId; accountId: string }> {
    const tokenHash = hashToken(rawToken);
    let failedTenantId: string | undefined;

    try {
      const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<{ tenantId: string; accountId: string }>> => {
        const found = await tx.query<{
          id: string;
          account_id: string;
          tenant_id: string;
          consumed: boolean;
          expired: boolean;
          business_name: string;
        }>(
          `SELECT t.id, t.account_id, t.tenant_id,
                  t.consumed_at IS NOT NULL AS consumed,
                  t.expires_at <= now()     AS expired,
                  n.business_name
           FROM account_tokens t
           JOIN tenants n ON n.id = t.tenant_id
           WHERE t.token_hash = $1 AND t.purpose = 'email_verification'`,
          [tokenHash],
        );

        const row = found.rows[0];
        if (row === undefined) return { ok: false, reason: 'token_unknown' };
        if (row.consumed) return { ok: false, reason: 'token_consumed' };
        if (row.expired) return { ok: false, reason: 'token_expired' };

        const consumed = await tx.query(
          'UPDATE account_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
          [row.id],
        );
        if (consumed.rowCount !== 1) return { ok: false, reason: 'token_consumed' };

        await tx.query(
          'UPDATE accounts SET email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1',
          [row.account_id],
        );

        // From here on the transaction is doing tenant-scoped work, so it binds
        // the tenant. Anything the provisioning hook writes is then subject to
        // the same row-level security the running application is.
        failedTenantId = row.tenant_id;
        await bindTenantContext(tx, row.tenant_id);
        await this.#provisionTenant({
          connection: tx,
          tenantId: row.tenant_id,
          accountId: row.account_id,
          businessName: row.business_name,
        });

        await tx.query(
          `UPDATE tenants
           SET provisioning_state = 'ready', provisioned_at = COALESCE(provisioned_at, now())
           WHERE id = $1`,
          [row.tenant_id],
        );
        await tx.query(
          `INSERT INTO tenant_lifecycle_events (tenant_id, event) VALUES ($1, 'provisioned')`,
          [row.tenant_id],
        );
        await recordAccess(tx, {
          principalType: 'client',
          principalId: row.account_id,
          tenantId: row.tenant_id,
          action: 'client.email_verified',
          resource: 'tenant',
          outcome: 'allowed',
        });

        return { ok: true, value: { tenantId: row.tenant_id, accountId: row.account_id } };
      });

      if (!outcome.ok) {
        await recordAccessOutOfBand(this.#pool, {
          principalType: 'anonymous',
          action: 'client.email_verify',
          resource: 'account_token',
          outcome: 'denied',
          reason: outcome.reason,
        });
        throw new ValidationError([
          { key: 'token', reason: TOKEN_REJECTIONS[outcome.reason] ?? 'is not valid' },
        ]);
      }

      this.#logger.info('identity.email_verified', {
        tenantId: outcome.value.tenantId,
        principal: outcome.value.accountId,
      });
      return outcome.value;
    } catch (error) {
      // A `ValidationError` here is the token being rejected, which is not a
      // provisioning failure and must not mark a tenant broken.
      if (error instanceof ValidationError || failedTenantId === undefined) throw error;
      await this.#markProvisioningFailed(failedTenantId);
      throw error;
    }
  }

  /**
   * Record that a tenant is not usable, in a transaction of its own.
   *
   * Its own transaction because the one that failed has been rolled back — that
   * rollback is what guarantees no partial tenant exists. What is left to do is
   * make the failure *visible*, which AC7 requires and a silent rollback does
   * not provide: without this the client would see an error, retry, and find a
   * tenant that still claims to be merely "provisioning".
   */
  async #markProvisioningFailed(tenantId: string): Promise<void> {
    try {
      await withIdentityScope(this.#pool, async (tx) => {
        await tx.query(`UPDATE tenants SET provisioning_state = 'failed' WHERE id = $1`, [tenantId]);
        await tx.query(
          `INSERT INTO tenant_lifecycle_events (tenant_id, event) VALUES ($1, 'provisioning_failed')`,
          [tenantId],
        );
        await recordAccess(tx, {
          principalType: 'system',
          tenantId,
          action: 'tenant.provision',
          resource: 'tenant',
          outcome: 'denied',
          reason: 'provisioning_failed',
        });
      });
      this.#logger.error('identity.provisioning.failed', undefined, { tenantId });
    } catch (bookkeepingError) {
      // Never mask the original provisioning failure with a failure to record
      // it. The caller needs the cause, not the note-taking.
      this.#logger.error('identity.provisioning.mark_failed_failed', bookkeepingError, { tenantId });
    }
  }

  /**
   * Issue a fresh verification token for an address, if one is warranted.
   *
   * **Caller contract:** the return value says whether there is mail to send. It
   * must never influence what the requester is told. Returning `undefined` for an
   * unknown or already-verified address and a token for a pending one, and then
   * responding identically in both cases, is what keeps this from being the
   * account-enumeration oracle that the login path is careful not to be.
   *
   * Any outstanding verification token is consumed first, so at most one live
   * link exists per account. Several simultaneously valid links multiply the
   * chances that one ends up somewhere it should not — a forwarded mail, a
   * proxy log — for no benefit, since a client only ever uses the newest.
   */
  async requestEmailVerification(rawEmail: string): Promise<TokenIssued | undefined> {
    const email = assertEmail(rawEmail);
    const minted = mintToken('email_verification');

    return withIdentityScope(this.#pool, async (tx) => {
      const found = await tx.query<{
        id: string;
        tenant_id: string;
        verified: boolean;
        lifecycle_state: string;
      }>(
        `SELECT a.id, a.tenant_id, a.email_verified_at IS NOT NULL AS verified, t.lifecycle_state
         FROM accounts a JOIN tenants t ON t.id = a.tenant_id
         WHERE lower(a.email) = $1`,
        [email],
      );
      const row = found.rows[0];
      // `email_unverified` reads oddly as the reason for refusing to re-send a
      // verification link, but it is the honest classification of the state: the
      // request was declined because the account's verification is not pending.
      // The alternative — a `already_verified` reason — would be a vocabulary
      // entry used exactly once, and the audit value is the same.
      const declined: DenialReason | undefined =
        row === undefined
          ? 'unknown_account'
          : row.lifecycle_state === 'permanently_deleted'
            ? 'tenant_deleted'
            : row.verified
              ? 'email_unverified'
              : undefined;

      if (declined !== undefined || row === undefined) {
        await recordAccess(tx, {
          principalType: row === undefined ? 'anonymous' : 'client',
          principalId: row?.id,
          tenantId: row?.tenant_id,
          action: 'client.email_verification_requested',
          resource: 'account_token',
          outcome: 'denied',
          reason: declined ?? 'unknown_account',
        });
        return undefined;
      }

      await tx.query(
        `UPDATE account_tokens SET consumed_at = now()
         WHERE account_id = $1 AND purpose = 'email_verification' AND consumed_at IS NULL`,
        [row.id],
      );
      const issued = await tx.query<{ expires_at: Date }>(
        `INSERT INTO account_tokens (tenant_id, account_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, 'email_verification', $3, now() + make_interval(secs => $4::double precision))
         RETURNING expires_at`,
        [row.tenant_id, row.id, minted.hash, secs(this.#policy.emailVerificationTtlMs)],
      );
      await recordAccess(tx, {
        principalType: 'client',
        principalId: row.id,
        tenantId: row.tenant_id,
        action: 'client.email_verification_requested',
        resource: 'account_token',
        outcome: 'allowed',
      });

      return {
        accountId: row.id,
        tenantId: row.tenant_id,
        email,
        token: minted.token,
        expiresAt: issued.rows[0]!.expires_at,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Client authentication
  // -------------------------------------------------------------------------

  /**
   * Authenticate a client and issue a session.
   *
   * The order of checks is not arbitrary. The lockout is evaluated *before* the
   * credential, because AC12 requires the system "throttle or temporarily lock
   * out further attempts rather than continuing to evaluate credentials at full
   * rate" — evaluating and then discarding the result would still pay the scrypt
   * and would still be a full-rate oracle. And the counter is reset on a correct
   * password *before* the verification and tenant-state checks, so that an
   * unverified client typing their real password cannot lock themselves out of
   * the account they are about to be told to verify.
   */
  async logIn(input: { readonly email: string; readonly password: string }): Promise<ClientSessionIssued> {
    const email = assertEmail(input.email);
    const minted = mintToken('client_session');

    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<ClientSessionIssued>> => {
      const found = await tx.query<{
        id: string;
        tenant_id: string;
        credential_hash: string;
        verified: boolean;
        locked: boolean;
        provisioning_state: string;
        lifecycle_state: string;
      }>(
        `SELECT a.id, a.tenant_id, a.credential_hash,
                a.email_verified_at IS NOT NULL AS verified,
                (a.locked_until IS NOT NULL AND a.locked_until > now()) AS locked,
                t.provisioning_state, t.lifecycle_state
         FROM accounts a JOIN tenants t ON t.id = a.tenant_id
         WHERE lower(a.email) = $1`,
        [email],
      );
      const row = found.rows[0];

      if (row === undefined) {
        await this.#equalizeTiming(input.password);
        await recordAccess(tx, {
          principalType: 'anonymous',
          action: 'client.login',
          resource: 'session',
          outcome: 'denied',
          reason: 'unknown_account',
        });
        return { ok: false, reason: 'unknown_account' };
      }

      if (row.locked) {
        // No decoy hash here, so a locked account answers measurably faster than
        // either an unknown address or a wrong password. That is an accepted
        // leak rather than an overlooked one: an account can only *be* locked
        // after somebody drove it past the threshold, so the caller who can
        // observe the fast path already knows the address exists. Adding the
        // decoy back would restore the very "continuing to evaluate credentials
        // at full rate" cost that AC12 exists to remove.
        await recordAccess(tx, {
          principalType: 'client',
          principalId: row.id,
          tenantId: row.tenant_id,
          action: 'client.login',
          resource: 'session',
          outcome: 'denied',
          reason: 'locked_out',
        });
        return { ok: false, reason: 'locked_out' };
      }

      if (!(await verifyCredential(input.password, row.credential_hash))) {
        // Resetting the counter as the lockout is applied gives the account a
        // fresh budget once the window expires. Leaving it at the threshold
        // would mean a single mistyped password after the lockout lifts
        // immediately re-locks for the full duration, which turns a temporary
        // control into a near-permanent one for a forgetful owner.
        await tx.query(
          `UPDATE accounts
           SET failed_attempt_count = CASE WHEN failed_attempt_count + 1 >= $2 THEN 0 ELSE failed_attempt_count + 1 END,
               locked_until = CASE WHEN failed_attempt_count + 1 >= $2
                                   THEN now() + make_interval(secs => $3::double precision)
                                   ELSE locked_until END
           WHERE id = $1`,
          [row.id, this.#policy.maxFailedAttempts, secs(this.#policy.lockoutMs)],
        );
        await recordAccess(tx, {
          principalType: 'client',
          principalId: row.id,
          tenantId: row.tenant_id,
          action: 'client.login',
          resource: 'session',
          outcome: 'denied',
          reason: 'bad_credential',
        });
        return { ok: false, reason: 'bad_credential' };
      }

      await tx.query(
        'UPDATE accounts SET failed_attempt_count = 0, locked_until = NULL WHERE id = $1',
        [row.id],
      );

      const blocked: DenialReason | undefined = !row.verified
        ? 'email_unverified'
        : row.lifecycle_state === 'permanently_deleted'
          ? 'tenant_deleted'
          : row.provisioning_state !== 'ready'
            ? 'tenant_not_ready'
            : undefined;

      if (blocked !== undefined) {
        await recordAccess(tx, {
          principalType: 'client',
          principalId: row.id,
          tenantId: row.tenant_id,
          action: 'client.login',
          resource: 'session',
          outcome: 'denied',
          reason: blocked,
        });
        return { ok: false, reason: blocked };
      }

      const session = await tx.query<{ id: string; absolute_expires_at: Date }>(
        `INSERT INTO client_sessions (tenant_id, account_id, token_hash, absolute_expires_at)
         VALUES ($1, $2, $3, now() + make_interval(secs => $4::double precision))
         RETURNING id, absolute_expires_at`,
        [row.tenant_id, row.id, minted.hash, secs(this.#policy.sessionAbsoluteLifetimeMs)],
      );
      await recordAccess(tx, {
        principalType: 'client',
        principalId: row.id,
        tenantId: row.tenant_id,
        action: 'client.login',
        resource: 'session',
        outcome: 'allowed',
      });

      return {
        ok: true,
        value: {
          sessionId: session.rows[0]!.id,
          accountId: row.id,
          tenantId: row.tenant_id,
          token: minted.token,
          absoluteExpiresAt: session.rows[0]!.absolute_expires_at,
        },
      };
    });

    if (!outcome.ok) {
      this.#logger.warn('identity.login.denied', { principalType: 'client', reason: outcome.reason });
      throw new AuthenticationError();
    }
    this.#logger.info('identity.login.allowed', {
      principalType: 'client',
      tenantId: outcome.value.tenantId,
      principal: outcome.value.accountId,
      sessionId: outcome.value.sessionId,
    });
    return outcome.value;
  }

  /**
   * Resolve a bearer token to the principal it names, refreshing its activity.
   *
   * Six ways a structurally valid token is refused, and each maps to a specific
   * acceptance criterion: revoked (AC7, logout), past its absolute lifetime
   * (AC6), idle beyond the inactivity window (AC5), created before the account's
   * last credential change (AC8/AC10), belonging to a permanently deleted tenant
   * (AC19), or belonging to a tenant that is not provisioned.
   *
   * Only denials are written to `access_records`. Recording every successful
   * resolution would put one row per request into an append-only table on a
   * platform whose premise is near-zero fixed cost, and would say nothing the
   * login record does not already say. Denials are the security-relevant half and
   * are bounded by how often clients present dead tokens.
   */
  async resolveClientSession(rawToken: string): Promise<ClientPrincipal> {
    if (!hasTokenKind(rawToken, 'client_session')) {
      await this.#denySessionResolution('client.session_resolve', 'wrong_token_kind');
      throw new AuthenticationError();
    }
    const tokenHash = hashToken(rawToken);

    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<ClientPrincipal>> => {
      const found = await tx.query<{
        id: string;
        tenant_id: string;
        account_id: string;
        revoked: boolean;
        absolute_expired: boolean;
        idle: boolean;
        stale_credentials: boolean;
        provisioning_state: string;
        lifecycle_state: string;
      }>(
        `SELECT s.id, s.tenant_id, s.account_id,
                s.revoked_at IS NOT NULL          AS revoked,
                s.absolute_expires_at <= now()    AS absolute_expired,
                s.last_active_at <= now() - make_interval(secs => $2::double precision) AS idle,
                s.created_at < a.credentials_changed_at              AS stale_credentials,
                t.provisioning_state, t.lifecycle_state
         FROM client_sessions s
         JOIN accounts a ON a.id = s.account_id
         JOIN tenants t  ON t.id = s.tenant_id
         WHERE s.token_hash = $1`,
        [tokenHash, secs(this.#policy.sessionInactivityMs)],
      );
      const row = found.rows[0];

      const reason: DenialReason | undefined =
        row === undefined
          ? 'session_unknown'
          : row.revoked
            ? 'session_revoked'
            : row.absolute_expired
              ? 'session_expired'
              : row.idle
                ? 'session_idle'
                : row.stale_credentials
                  ? 'credentials_changed'
                  : row.lifecycle_state === 'permanently_deleted'
                    ? 'tenant_deleted'
                    : row.provisioning_state !== 'ready'
                      ? 'tenant_not_ready'
                      : undefined;

      if (reason !== undefined || row === undefined) {
        await recordAccess(tx, {
          principalType: row === undefined ? 'anonymous' : 'client',
          principalId: row?.account_id,
          tenantId: row?.tenant_id,
          action: 'client.session_resolve',
          resource: 'session',
          outcome: 'denied',
          reason: reason ?? 'session_unknown',
        });
        return { ok: false, reason: reason ?? 'session_unknown' };
      }

      await tx.query('UPDATE client_sessions SET last_active_at = now() WHERE id = $1', [row.id]);
      return {
        ok: true,
        value: {
          type: 'client',
          accountId: row.account_id,
          tenantId: row.tenant_id,
          sessionId: row.id,
        },
      };
    });

    if (!outcome.ok) throw new AuthenticationError();
    return outcome.value;
  }

  /**
   * End a session.
   *
   * Idempotent, and deliberately says nothing about whether the token existed.
   * The boolean is for the caller's own bookkeeping; the response to the client
   * must be the same either way, because a logout endpoint that distinguishes
   * "ended" from "no such session" is a token-validity oracle reachable without
   * authentication.
   */
  async logOut(rawToken: string): Promise<boolean> {
    if (!hasTokenKind(rawToken, 'client_session')) return false;
    return withIdentityScope(this.#pool, async (tx) => {
      const revoked = await tx.query<{ id: string; tenant_id: string; account_id: string }>(
        `UPDATE client_sessions SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL
         RETURNING id, tenant_id, account_id`,
        [hashToken(rawToken)],
      );
      const row = revoked.rows[0];
      if (row === undefined) return false;
      await recordAccess(tx, {
        principalType: 'client',
        principalId: row.account_id,
        tenantId: row.tenant_id,
        action: 'client.logout',
        resource: 'session',
        outcome: 'allowed',
      });
      this.#logger.info('identity.logout', { tenantId: row.tenant_id, sessionId: row.id });
      return true;
    });
  }

  /**
   * Change a client's password, ending every session they hold.
   *
   * AC8 and AC10 require that a change or reset invalidate existing sessions, and
   * both mechanisms the schema offers are used: the sessions are explicitly
   * revoked, *and* `credentials_changed_at` moves so that any session created
   * concurrently in another transaction — one that was in flight and could not be
   * seen by the `UPDATE` — is rejected at its next resolution. Either alone
   * leaves a window; together they do not.
   *
   * A wrong current password does not count toward the lockout. The counter
   * defends an unauthenticated surface against guessing, and this surface already
   * requires a valid session; incrementing here would let anyone holding a stolen
   * session lock the rightful owner out, which converts a confidentiality breach
   * into a denial of service against the victim.
   */
  async changePassword(input: {
    readonly principal: ClientPrincipal;
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    const { principal } = input;
    const outcome = await withTenant(this.#pool, principal.tenantId, async (tx): Promise<Outcome<null>> => {
      const found = await tx.query<{ email: string; credential_hash: string }>(
        'SELECT email, credential_hash FROM accounts WHERE id = $1',
        [principal.accountId],
      );
      const row = found.rows[0];
      if (row === undefined || !(await verifyCredential(input.currentPassword, row.credential_hash))) {
        await recordAccess(tx, {
          principalType: 'client',
          principalId: principal.accountId,
          tenantId: principal.tenantId,
          action: 'client.password_change',
          resource: 'account',
          outcome: 'denied',
          reason: 'bad_credential',
        });
        return { ok: false, reason: 'bad_credential' };
      }

      assertPasswordStrength(
        input.newPassword,
        { minLength: this.#policy.minPasswordLength, email: row.email },
        'newPassword',
      );
      await tx.query(
        'UPDATE accounts SET credential_hash = $2, credentials_changed_at = now() WHERE id = $1',
        [principal.accountId, await this.#hash(input.newPassword)],
      );
      await tx.query(
        'UPDATE client_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL',
        [principal.accountId],
      );
      await recordAccess(tx, {
        principalType: 'client',
        principalId: principal.accountId,
        tenantId: principal.tenantId,
        action: 'client.password_change',
        resource: 'account',
        outcome: 'allowed',
      });
      return { ok: true, value: null };
    });

    if (!outcome.ok) throw new AuthenticationError();
    this.#logger.info('identity.password_changed', {
      tenantId: principal.tenantId,
      principal: principal.accountId,
    });
  }

  /**
   * Issue a password-reset token, if the address has an account.
   *
   * **Caller contract, as for `requestEmailVerification`:** AC9 requires the
   * response to a recovery request for an unregistered address be
   * indistinguishable from one for a registered address. `undefined` means "there
   * is no mail to send", never "tell the requester there is no account".
   *
   * Outstanding reset tokens are consumed before a new one is issued, so a
   * request storm cannot accumulate a pile of simultaneously valid takeover
   * links.
   */
  async requestPasswordReset(rawEmail: string): Promise<TokenIssued | undefined> {
    const email = assertEmail(rawEmail);
    const minted = mintToken('password_reset');

    return withIdentityScope(this.#pool, async (tx) => {
      const found = await tx.query<{ id: string; tenant_id: string; lifecycle_state: string }>(
        `SELECT a.id, a.tenant_id, t.lifecycle_state
         FROM accounts a JOIN tenants t ON t.id = a.tenant_id
         WHERE lower(a.email) = $1`,
        [email],
      );
      const row = found.rows[0];
      if (row === undefined || row.lifecycle_state === 'permanently_deleted') {
        await recordAccess(tx, {
          principalType: 'anonymous',
          tenantId: row?.tenant_id,
          action: 'client.password_reset_requested',
          resource: 'account_token',
          outcome: 'denied',
          reason: row === undefined ? 'unknown_account' : 'tenant_deleted',
        });
        return undefined;
      }

      await tx.query(
        `UPDATE account_tokens SET consumed_at = now()
         WHERE account_id = $1 AND purpose = 'password_reset' AND consumed_at IS NULL`,
        [row.id],
      );
      const issued = await tx.query<{ expires_at: Date }>(
        `INSERT INTO account_tokens (tenant_id, account_id, purpose, token_hash, expires_at)
         VALUES ($1, $2, 'password_reset', $3, now() + make_interval(secs => $4::double precision))
         RETURNING expires_at`,
        [row.tenant_id, row.id, minted.hash, secs(this.#policy.passwordResetTtlMs)],
      );
      await recordAccess(tx, {
        principalType: 'client',
        principalId: row.id,
        tenantId: row.tenant_id,
        action: 'client.password_reset_requested',
        resource: 'account_token',
        outcome: 'allowed',
      });
      return {
        accountId: row.id,
        tenantId: row.tenant_id,
        email,
        token: minted.token,
        expiresAt: issued.rows[0]!.expires_at,
      };
    });
  }

  /**
   * Redeem a reset token and set a new password.
   *
   * Also clears the failed-attempt lockout. Without that, a client locked out by
   * an attacker's guessing — which is the scenario that most often prompts a
   * reset in the first place — would complete the reset and still be unable to
   * log in, and the recovery path `client-signup-and-tenancy.md` requires work
   * "without operator involvement" would need exactly that.
   *
   * A reset does *not* mark the email verified. Redeeming the link does prove
   * control of the address, but verification is also what triggers provisioning,
   * and quietly provisioning a tenant from the recovery path would make two
   * flows able to reach the same transition — one of them untested for it. An
   * unverified account that resets its password still has to verify.
   */
  async resetPassword(input: { readonly token: string; readonly newPassword: string }): Promise<{
    readonly accountId: string;
    readonly tenantId: TenantId;
  }> {
    const tokenHash = hashToken(input.token);

    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<{ accountId: string; tenantId: string }>> => {
      const found = await tx.query<{
        id: string;
        account_id: string;
        tenant_id: string;
        email: string;
        consumed: boolean;
        expired: boolean;
        lifecycle_state: string;
      }>(
        `SELECT t.id, t.account_id, t.tenant_id, a.email,
                t.consumed_at IS NOT NULL AS consumed,
                t.expires_at <= now()     AS expired,
                n.lifecycle_state
         FROM account_tokens t
         JOIN accounts a ON a.id = t.account_id
         JOIN tenants  n ON n.id = t.tenant_id
         WHERE t.token_hash = $1 AND t.purpose = 'password_reset'`,
        [tokenHash],
      );
      const row = found.rows[0];
      if (row === undefined) return { ok: false, reason: 'token_unknown' };
      if (row.consumed) return { ok: false, reason: 'token_consumed' };
      if (row.expired) return { ok: false, reason: 'token_expired' };
      if (row.lifecycle_state === 'permanently_deleted') return { ok: false, reason: 'tenant_deleted' };

      assertPasswordStrength(
        input.newPassword,
        { minLength: this.#policy.minPasswordLength, email: row.email },
        'newPassword',
      );

      const consumed = await tx.query(
        'UPDATE account_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL',
        [row.id],
      );
      if (consumed.rowCount !== 1) return { ok: false, reason: 'token_consumed' };

      await tx.query(
        `UPDATE accounts
         SET credential_hash = $2, credentials_changed_at = now(),
             failed_attempt_count = 0, locked_until = NULL
         WHERE id = $1`,
        [row.account_id, await this.#hash(input.newPassword)],
      );
      await tx.query(
        'UPDATE client_sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL',
        [row.account_id],
      );
      await recordAccess(tx, {
        principalType: 'client',
        principalId: row.account_id,
        tenantId: row.tenant_id,
        action: 'client.password_reset',
        resource: 'account',
        outcome: 'allowed',
      });
      return { ok: true, value: { accountId: row.account_id, tenantId: row.tenant_id } };
    });

    if (!outcome.ok) {
      await recordAccessOutOfBand(this.#pool, {
        principalType: 'anonymous',
        action: 'client.password_reset',
        resource: 'account_token',
        outcome: 'denied',
        reason: outcome.reason,
      });
      throw new ValidationError([
        { key: 'token', reason: TOKEN_REJECTIONS[outcome.reason] ?? 'is not valid' },
      ]);
    }
    this.#logger.info('identity.password_reset', {
      tenantId: outcome.value.tenantId,
      principal: outcome.value.accountId,
    });
    return outcome.value;
  }

  // -------------------------------------------------------------------------
  // Operator authentication
  // -------------------------------------------------------------------------

  /**
   * Create the platform operator.
   *
   * There is no operator signup surface and there should not be: the operator is
   * the single highest-value credential in the system, and a self-service route
   * to creating one is a route to creating a second one. This is called from a
   * deployment bootstrap, where the caller already has the database.
   */
  async createOperator(input: { readonly email: string; readonly password: string }): Promise<{ readonly operatorId: string }> {
    const email = assertEmail(input.email);
    assertPasswordStrength(input.password, { minLength: this.#policy.minPasswordLength, email });
    const credentialHash = await this.#hash(input.password);

    return withIdentityScope(this.#pool, async (tx) => {
      let operatorId: string;
      try {
        const created = await tx.query<{ id: string }>(
          'INSERT INTO operators (email, credential_hash) VALUES ($1, $2) RETURNING id',
          [email, credentialHash],
        );
        operatorId = created.rows[0]!.id;
      } catch (error) {
        if (error instanceof ConflictError) {
          throw new ConflictError('That operator address is already registered', {
            code: 'identity.operator_exists',
          });
        }
        throw error;
      }
      await recordAccess(tx, {
        principalType: 'operator',
        principalId: operatorId,
        action: 'operator.created',
        resource: 'operator',
        outcome: 'allowed',
      });
      return { operatorId };
    });
  }

  /**
   * Authenticate the operator.
   *
   * Structurally the client login with the tenant checks removed, and it queries
   * a different table — which is the whole point. `authentication-and-access.md`
   * requires the two identity spaces "never overlap", and the reason this reads
   * as duplication rather than being factored into a shared helper parameterised
   * by table name is that a shared helper is precisely how the spaces come to
   * overlap: one conditional, one wrong argument, and a client credential reaches
   * the operator table. The duplication is the guarantee.
   */
  async operatorLogIn(input: { readonly email: string; readonly password: string }): Promise<OperatorSessionIssued> {
    const email = assertEmail(input.email);
    const minted = mintToken('operator_session');

    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<OperatorSessionIssued>> => {
      const found = await tx.query<{ id: string; credential_hash: string; locked: boolean }>(
        `SELECT id, credential_hash,
                (locked_until IS NOT NULL AND locked_until > now()) AS locked
         FROM operators WHERE lower(email) = $1`,
        [email],
      );
      const row = found.rows[0];

      if (row === undefined) {
        await this.#equalizeTiming(input.password);
        await recordAccess(tx, {
          principalType: 'anonymous',
          action: 'operator.login',
          resource: 'operator_session',
          outcome: 'denied',
          reason: 'unknown_account',
        });
        return { ok: false, reason: 'unknown_account' };
      }
      if (row.locked) {
        await recordAccess(tx, {
          principalType: 'operator',
          principalId: row.id,
          action: 'operator.login',
          resource: 'operator_session',
          outcome: 'denied',
          reason: 'locked_out',
        });
        return { ok: false, reason: 'locked_out' };
      }
      if (!(await verifyCredential(input.password, row.credential_hash))) {
        await tx.query(
          `UPDATE operators
           SET failed_attempt_count = CASE WHEN failed_attempt_count + 1 >= $2 THEN 0 ELSE failed_attempt_count + 1 END,
               locked_until = CASE WHEN failed_attempt_count + 1 >= $2
                                   THEN now() + make_interval(secs => $3::double precision)
                                   ELSE locked_until END
           WHERE id = $1`,
          [row.id, this.#policy.maxFailedAttempts, secs(this.#policy.lockoutMs)],
        );
        await recordAccess(tx, {
          principalType: 'operator',
          principalId: row.id,
          action: 'operator.login',
          resource: 'operator_session',
          outcome: 'denied',
          reason: 'bad_credential',
        });
        return { ok: false, reason: 'bad_credential' };
      }

      await tx.query(
        'UPDATE operators SET failed_attempt_count = 0, locked_until = NULL WHERE id = $1',
        [row.id],
      );
      const session = await tx.query<{ id: string; absolute_expires_at: Date }>(
        `INSERT INTO operator_sessions (operator_id, token_hash, absolute_expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision))
         RETURNING id, absolute_expires_at`,
        [row.id, minted.hash, secs(this.#policy.sessionAbsoluteLifetimeMs)],
      );
      await recordAccess(tx, {
        principalType: 'operator',
        principalId: row.id,
        action: 'operator.login',
        resource: 'operator_session',
        outcome: 'allowed',
      });
      return {
        ok: true,
        value: {
          sessionId: session.rows[0]!.id,
          operatorId: row.id,
          token: minted.token,
          absoluteExpiresAt: session.rows[0]!.absolute_expires_at,
        },
      };
    });

    if (!outcome.ok) {
      this.#logger.warn('identity.login.denied', { principalType: 'operator', reason: outcome.reason });
      throw new AuthenticationError();
    }
    this.#logger.info('identity.login.allowed', {
      principalType: 'operator',
      principal: outcome.value.operatorId,
      sessionId: outcome.value.sessionId,
    });
    return outcome.value;
  }

  /** Resolve an operator bearer token. Mirrors `resolveClientSession` minus the tenant. */
  async resolveOperatorSession(rawToken: string): Promise<OperatorPrincipal> {
    if (!hasTokenKind(rawToken, 'operator_session')) {
      await this.#denySessionResolution('operator.session_resolve', 'wrong_token_kind');
      throw new AuthenticationError();
    }
    const tokenHash = hashToken(rawToken);

    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<OperatorPrincipal>> => {
      const found = await tx.query<{
        id: string;
        operator_id: string;
        revoked: boolean;
        absolute_expired: boolean;
        idle: boolean;
        stale_credentials: boolean;
      }>(
        `SELECT s.id, s.operator_id,
                s.revoked_at IS NOT NULL       AS revoked,
                s.absolute_expires_at <= now() AS absolute_expired,
                s.last_active_at <= now() - make_interval(secs => $2::double precision) AS idle,
                s.created_at < o.credentials_changed_at              AS stale_credentials
         FROM operator_sessions s
         JOIN operators o ON o.id = s.operator_id
         WHERE s.token_hash = $1`,
        [tokenHash, secs(this.#policy.sessionInactivityMs)],
      );
      const row = found.rows[0];
      const reason: DenialReason | undefined =
        row === undefined
          ? 'session_unknown'
          : row.revoked
            ? 'session_revoked'
            : row.absolute_expired
              ? 'session_expired'
              : row.idle
                ? 'session_idle'
                : row.stale_credentials
                  ? 'credentials_changed'
                  : undefined;

      if (reason !== undefined || row === undefined) {
        await recordAccess(tx, {
          principalType: row === undefined ? 'anonymous' : 'operator',
          principalId: row?.operator_id,
          action: 'operator.session_resolve',
          resource: 'operator_session',
          outcome: 'denied',
          reason: reason ?? 'session_unknown',
        });
        return { ok: false, reason: reason ?? 'session_unknown' };
      }

      await tx.query('UPDATE operator_sessions SET last_active_at = now() WHERE id = $1', [row.id]);
      return { ok: true, value: { type: 'operator', operatorId: row.operator_id, sessionId: row.id } };
    });

    if (!outcome.ok) throw new AuthenticationError();
    return outcome.value;
  }

  /** End an operator session. Same idempotent, oracle-free contract as `logOut`. */
  async operatorLogOut(rawToken: string): Promise<boolean> {
    if (!hasTokenKind(rawToken, 'operator_session')) return false;
    return withIdentityScope(this.#pool, async (tx) => {
      const revoked = await tx.query<{ id: string; operator_id: string }>(
        `UPDATE operator_sessions SET revoked_at = now()
         WHERE token_hash = $1 AND revoked_at IS NULL
         RETURNING id, operator_id`,
        [hashToken(rawToken)],
      );
      const row = revoked.rows[0];
      if (row === undefined) return false;
      await recordAccess(tx, {
        principalType: 'operator',
        principalId: row.operator_id,
        action: 'operator.logout',
        resource: 'operator_session',
        outcome: 'allowed',
      });
      return true;
    });
  }

  /** Change the operator's password, ending every operator session. */
  async changeOperatorPassword(input: {
    readonly principal: OperatorPrincipal;
    readonly currentPassword: string;
    readonly newPassword: string;
  }): Promise<void> {
    const { principal } = input;
    const outcome = await withIdentityScope(this.#pool, async (tx): Promise<Outcome<null>> => {
      const found = await tx.query<{ email: string; credential_hash: string }>(
        'SELECT email, credential_hash FROM operators WHERE id = $1',
        [principal.operatorId],
      );
      const row = found.rows[0];
      if (row === undefined || !(await verifyCredential(input.currentPassword, row.credential_hash))) {
        await recordAccess(tx, {
          principalType: 'operator',
          principalId: principal.operatorId,
          action: 'operator.password_change',
          resource: 'operator',
          outcome: 'denied',
          reason: 'bad_credential',
        });
        return { ok: false, reason: 'bad_credential' };
      }
      assertPasswordStrength(
        input.newPassword,
        { minLength: this.#policy.minPasswordLength, email: row.email },
        'newPassword',
      );
      await tx.query(
        'UPDATE operators SET credential_hash = $2, credentials_changed_at = now() WHERE id = $1',
        [principal.operatorId, await this.#hash(input.newPassword)],
      );
      await tx.query(
        'UPDATE operator_sessions SET revoked_at = now() WHERE operator_id = $1 AND revoked_at IS NULL',
        [principal.operatorId],
      );
      await recordAccess(tx, {
        principalType: 'operator',
        principalId: principal.operatorId,
        action: 'operator.password_change',
        resource: 'operator',
        outcome: 'allowed',
      });
      return { ok: true, value: null };
    });
    if (!outcome.ok) throw new AuthenticationError();
  }

  // -------------------------------------------------------------------------
  // Acting as a principal
  // -------------------------------------------------------------------------

  /**
   * Run tenant-scoped work as the holder of a client session token.
   *
   * This is the function every client-facing route should go through, because it
   * is where "the tenant binding is derived from the identity" stops being a
   * convention and becomes the only available path: the token resolves to a
   * tenant, and that tenant — not any argument — opens the transaction. There is
   * no overload taking a tenant id, and adding one would be the single change
   * that undoes `tenant-data-isolation.md`.
   */
  async withClientSession<T>(
    rawToken: string,
    fn: (connection: Connection, principal: ClientPrincipal) => Promise<T>,
  ): Promise<T> {
    const principal = await this.resolveClientSession(rawToken);
    return withTenant(this.#pool, principal.tenantId, (connection) => fn(connection, principal));
  }

  /**
   * Perform one permission-checked action as the holder of a client session token.
   *
   * `withClientSession` plus `authorize`, in the only order that is safe: resolve
   * the session, check the action against `ACTION_PRINCIPALS` and record the
   * decision, and only then open the tenant-bound transaction. Every tenant-scoped
   * route in `services/api` goes through this, so a route cannot reach tenant data
   * without naming the action it performs — a route that forgot the check would
   * have to bypass this function to do it, which is visible in review.
   *
   * The authorization record is written before the work, out of band, so a
   * denial is recorded even though nothing else happens, and an allowed action is
   * recorded even if its own transaction later fails.
   */
  async withClientAction<T>(
    rawToken: string,
    action: Action,
    resource: string,
    fn: (connection: Connection, principal: ClientPrincipal) => Promise<T>,
  ): Promise<T> {
    const principal = await this.resolveClientSession(rawToken);
    await this.authorize(principal, action, resource);
    return withTenant(this.#pool, principal.tenantId, (connection) => fn(connection, principal));
  }

  /**
   * Run operator work as the holder of an operator session token.
   *
   * Opens the *platform* scope, never a tenant scope. That is what makes AC15
   * hold below the application as well as above it: the platform scope reaches
   * only the tables that carry a platform-read policy, which by construction
   * excludes anything holding conversation content. Even a defective operator
   * route cannot select a transcript, because no policy would admit the read.
   */
  async withOperatorSession<T>(
    rawToken: string,
    fn: (connection: Connection, principal: OperatorPrincipal) => Promise<T>,
  ): Promise<T> {
    const principal = await this.resolveOperatorSession(rawToken);
    return withPlatformScope(this.#pool, (connection) => fn(connection, principal));
  }

  /**
   * Check an action against the principal's type, recording the decision.
   *
   * Both outcomes are recorded, unlike session resolution: authorization
   * decisions are what AC18's "what resource or surface was accessed or denied"
   * is asking about, and they are far rarer than request-level authentication —
   * one per meaningful operation rather than one per HTTP call.
   */
  async authorize(principal: Principal, action: Action, resource: string): Promise<void> {
    let denied = false;
    try {
      authorize(principal, action);
    } catch (error) {
      if (!(error instanceof AuthorizationError)) throw error;
      denied = true;
    }

    await recordAccessOutOfBand(this.#pool, {
      principalType: principal.type,
      principalId: principalId(principal),
      tenantId: principal.type === 'client' ? principal.tenantId : undefined,
      action,
      resource,
      outcome: denied ? 'denied' : 'allowed',
      reason: denied ? 'forbidden_action' : undefined,
    });

    if (denied) {
      this.#logger.warn('identity.authorization.denied', {
        principalType: principal.type,
        action,
        resource,
      });
      throw new AuthorizationError({ principal: principal.type, action });
    }
  }

  /** Record a resolution refused before any lookup — a token of the wrong kind. */
  async #denySessionResolution(action: string, reason: DenialReason): Promise<void> {
    await recordAccessOutOfBand(this.#pool, {
      principalType: 'anonymous',
      action,
      resource: 'session',
      outcome: 'denied',
      reason,
    });
  }
}

/**
 * Caller-facing wording for a rejected single-use token.
 *
 * These *do* distinguish expired from already-used from unknown, unlike the login
 * path. That is not an inconsistency: the enumeration risk at login is that a
 * caller learns whether an *address* exists, and an address is guessable. A token
 * is 256 random bits, so telling its holder why it failed reveals nothing they
 * could not already determine, and telling them "this link has expired, request a
 * new one" is the difference between a recoverable flow and a dead end.
 */
const TOKEN_REJECTIONS: Readonly<Record<string, string>> = {
  token_unknown: 'is not a recognised link',
  token_consumed: 'has already been used',
  token_expired: 'has expired',
  tenant_deleted: 'belongs to an account that no longer exists',
};
