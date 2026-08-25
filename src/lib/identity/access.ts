/**
 * The audit trail: who authenticated, what identity resulted, what was reached
 * or refused, and when.
 *
 * `authentication-and-access.md` AC18 requires exactly that, and AC19 requires
 * the same records contain no conversation content. The schema already makes the
 * second half structural — `access_records` has no column that could hold
 * content, and there is no UPDATE or DELETE policy on it — so what is left for
 * this module is to make writing a record easy enough that no path skips it, and
 * to keep the free-text field from becoming free text.
 *
 * ## Why `reason` is a closed vocabulary
 *
 * `access_records.reason` is a `text` column, which is a hole exactly the size of
 * whatever someone decides is useful context. The first time a denial is hard to
 * debug, somebody writes `reason: \`no account for ${email}\``, and now the audit
 * table — the one an operator reads — holds a client's email address. The
 * vocabulary below closes that: a reason is a classification drawn from a fixed
 * list, so an identifier cannot be interpolated into it without changing this
 * file, which is a reviewable act.
 *
 * ## Why some records are written out of band
 *
 * A denial usually happens on a path whose transaction is about to roll back —
 * a duplicate signup is the clearest case, where the whole point is that no
 * tenant and no account survive. Writing the record inside that transaction means
 * the record does not survive either, and the denial that most warrants an audit
 * trail is the one that leaves none. `recordAccessOutOfBand` opens its own
 * transaction for these.
 *
 * The converse case matters too and is handled by the caller rather than here: a
 * failed login must *commit* its failed-attempt counter, so the login path
 * returns an outcome from its transaction and throws afterwards, rather than
 * throwing from inside and rolling the counter back. See `service.ts`.
 */

import type { Connection, Pool } from '@zeddev/db';
import { withIdentityScope } from '@zeddev/db';

/**
 * The principal classifications the schema's CHECK constraint allows.
 *
 * `system` is for platform-initiated actions with no human principal — the
 * scheduler sweeping an expired retention window, for instance. `anonymous` is
 * for a caller who never established an identity, which is precisely the case a
 * failed login produces and precisely the case worth auditing.
 */
export const ACCESS_PRINCIPAL_TYPES = ['client', 'operator', 'system', 'anonymous'] as const;
export type AccessPrincipalType = (typeof ACCESS_PRINCIPAL_TYPES)[number];

/**
 * Every reason a decision may carry.
 *
 * Grouped by where they arise. Note that the login-failure reasons are recorded
 * here even though the *caller* is told nothing beyond "authentication failed" —
 * AC3 requires the response be indistinguishable between an unknown and a known
 * email, and this table is not the response. Keeping the distinction in the audit
 * record and out of the reply is what lets an operator diagnose "this client
 * cannot log in" without giving an attacker an account-enumeration oracle.
 */
export const DENIAL_REASONS = [
  // Credential evaluation.
  'unknown_account',
  'bad_credential',
  'locked_out',
  'email_unverified',
  // Tenant state.
  'tenant_not_ready',
  'tenant_deleted',
  'provisioning_failed',
  // Session resolution.
  'session_unknown',
  'session_revoked',
  'session_expired',
  'session_idle',
  'credentials_changed',
  'wrong_token_kind',
  // Single-use token redemption.
  'token_unknown',
  'token_consumed',
  'token_expired',
  // Signup.
  'duplicate_email',
  // Authorization.
  'forbidden_action',
] as const;
export type DenialReason = (typeof DENIAL_REASONS)[number];

export interface AccessRecordInput {
  readonly principalType: AccessPrincipalType;
  /** The account or operator id, when one was established. */
  readonly principalId?: string | undefined;
  readonly tenantId?: string | undefined;
  /** A dotted action name, e.g. `client.login`. Never interpolated. */
  readonly action: string;
  /** What was reached: a surface or resource name, never a value. */
  readonly resource: string;
  readonly outcome: 'allowed' | 'denied';
  readonly reason?: DenialReason | undefined;
}

const INSERT_SQL = `
  INSERT INTO access_records (principal_type, principal_id, tenant_id, action, resource, outcome, reason)
  VALUES ($1, $2, $3, $4, $5, $6, $7)
`;

/**
 * Append a record inside an existing transaction.
 *
 * Preferred wherever the surrounding transaction commits, because it makes the
 * record atomic with the thing it attests to: there is no window in which a
 * session exists but its issuance was never recorded.
 *
 * The insert needs no scope of any kind — `access_records_append` is
 * `WITH CHECK (true)` — which is deliberate in the schema: a denial has to be
 * recordable exactly when the caller has no valid context.
 */
export async function recordAccess(connection: Connection, input: AccessRecordInput): Promise<void> {
  await connection.query(INSERT_SQL, [
    input.principalType,
    input.principalId ?? null,
    input.tenantId ?? null,
    input.action,
    input.resource,
    input.outcome,
    input.reason ?? null,
  ]);
}

/**
 * Append a record in a transaction of its own.
 *
 * For the paths whose own transaction must roll back. Runs under the identity
 * scope only because it needs *a* transaction; the insert policy admits every
 * context, so no privilege is being borrowed.
 */
export async function recordAccessOutOfBand(pool: Pool, input: AccessRecordInput): Promise<void> {
  await withIdentityScope(pool, (connection) => recordAccess(connection, input));
}
