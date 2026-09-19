/**
 * Tenant context binding: the mechanism `tenant-data-isolation.md` rests on.
 *
 * That spec's central claim is adversarially worded: "No identifier, credential,
 * or reference belonging to one tenant is valid for retrieving or acting on
 * another tenant's data, **even if guessed, reused, or supplied out of context**"
 * (AC9). An application-layer `WHERE tenant_id = $1` convention cannot honour a
 * claim phrased that way, because it fails *open* — the first query someone
 * writes without the clause returns every tenant's rows, and nothing about that
 * query looks wrong. The isolation has to hold even when the code is wrong.
 *
 * So enforcement lives in the database, as row-level security policies, and this
 * module is the only thing that supplies the context those policies read.
 *
 * ## Why `set_config(..., is_local => true)` and not `SET`
 *
 * `SET` persists for the life of the session. Under a connection pool a session
 * outlives a request, so a `SET` tenant binding would be inherited by whoever
 * borrows the connection next — a cross-tenant read produced by the isolation
 * mechanism itself. `set_config` with `is_local => true` is `SET LOCAL`: scoped to
 * the enclosing transaction and discarded at commit or rollback, both of which
 * always happen. That is why `withTenant` opens a transaction and why `pool.ts`
 * refuses to return a connection that is still inside one.
 *
 * It is also a *function call*, so the tenant id travels as a bound parameter.
 * `SET LOCAL app.tenant_id = '<value>'` would require interpolating the value into
 * SQL text, which is precisely the injection surface this whole design exists to
 * close.
 *
 * ## Why the policy fails closed
 *
 * `current_setting('app.tenant_id', true)` returns NULL when nothing set it. The
 * policy compares `tenant_id = <NULL>`, which is NULL, which is not true, so no
 * row qualifies. Code that forgets to establish a tenant context therefore sees
 * an empty table rather than every tenant's data. The failure mode of forgetting
 * is "my query returned nothing", which gets noticed immediately, instead of
 * "my query returned too much", which does not.
 *
 * ## The platform scope, and its honest limits
 *
 * `tenant-data-isolation.md` also requires the operator see per-tenant connection
 * health and usage metrics across all tenants (AC7) while being unable to reach
 * any conversation content. Both halves are expressed in the schema: a
 * tenant-scoped table gets the tenant policy, and *only* those tables an operator
 * is permitted to see in aggregate additionally get a policy admitting the
 * platform scope. A conversation table has no such policy, so no setting exists
 * that would reveal it.
 *
 * The honest limitation: any code holding a connection can call
 * `withPlatformScope`. What that buys over a bare `WHERE` clause is that it is
 * closed by default, requires one explicit and greppable act to open, applies for
 * exactly one transaction, and — because the set of tables reachable that way is
 * fixed in migrations — still cannot reach conversation content no matter who
 * calls it. Restricting the escape further needs a second database role that
 * lacks the grant; the schema is built so that adding one later changes no
 * application code. That is tracked in IMPLEMENTATION_PLAN.md.
 */

import { TenantAccessError } from '@zeddev/errors';
import { assertTenantId } from '@zeddev/tenancy';
import type { Connection } from './connection.ts';
import type { Pool } from './pool.ts';

/** Session setting naming the tenant whose rows are visible. */
export const TENANT_SETTING = 'app.tenant_id';

/** Session setting that, when `on`, admits the operator-visible cross-tenant views. */
export const PLATFORM_SCOPE_SETTING = 'app.platform_scope';

/** Session setting that, when `on`, admits the tables authentication must read before a tenant is known. */
export const IDENTITY_SCOPE_SETTING = 'app.identity_scope';

/** Session setting that, when `on`, admits the queue routing tables a worker must read before a tenant is known. */
export const DISPATCH_SCOPE_SETTING = 'app.dispatch_scope';

/** Session setting that, when `on`, admits the number routes an inbound notification is attributed by. */
export const INBOUND_SCOPE_SETTING = 'app.inbound_scope';

/**
 * Run `fn` with every query scoped to one tenant.
 *
 * The transaction is not incidental. It is what bounds the lifetime of the
 * binding, so there is no state for the next borrower of this connection to
 * inherit, and it is what makes multi-statement tenant work atomic —
 * `client-signup-and-tenancy.md` AC7 requires that a provisioning failure never
 * leave "a usable account pointing at a broken or partial tenant".
 */
export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  assertTenantId(tenantId);
  return pool.transaction(async (connection) => {
    await connection.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenantId]);
    connection.boundTenantId = tenantId;
    try {
      return await fn(connection);
    } finally {
      // Cleared even though the transaction is about to end and would clear it
      // anyway. The field is read by the error mapper to attribute a policy
      // refusal, and leaving a stale value there would misattribute the next
      // failure on this connection to a tenant that had nothing to do with it.
      connection.boundTenantId = undefined;
    }
  });
}

/**
 * Run `fn` with access to the cross-tenant views the operator is permitted.
 *
 * Deliberately verbose to call and deliberately rare. Every use is a place where
 * `tenant-data-isolation.md` AC7's carve-out is being exercised, and each one
 * should be visible in a diff.
 */
export async function withPlatformScope<T>(
  pool: Pool,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (connection) => {
    await connection.query('SELECT set_config($1, $2, true)', [PLATFORM_SCOPE_SETTING, 'on']);
    return fn(connection);
  });
}

/**
 * Run `fn` with access to the identity tables, before a tenant is known.
 *
 * This scope exists because of an ordering constraint that cannot be designed
 * away. `authentication-and-access.md` requires the tenant binding be derived
 * "from the authenticated identity itself, never accepted from a tenant
 * identifier, parameter, or assertion supplied by the caller" — so the account
 * must be found *first*, by email, across every tenant, and the tenant follows
 * from it. A login that already knew its tenant would be a login that trusted the
 * caller to name one.
 *
 * The same applies to signup (the tenant does not exist yet), to resolving a
 * session bearer token, and to redeeming a password-reset link.
 *
 * What limits the blast radius is that the tables reachable this way are fixed in
 * migrations and are exactly the identity tables. `tenant_secrets` carries no
 * identity policy at all, so even this scope cannot read a tenant's credentials.
 */
export async function withIdentityScope<T>(
  pool: Pool,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (connection) => {
    await connection.query('SELECT set_config($1, $2, true)', [IDENTITY_SCOPE_SETTING, 'on']);
    return fn(connection);
  });
}

/**
 * Run `fn` with access to the queue routing tables, before a tenant is known.
 *
 * The fourth scope, and it exists for an ordering constraint with exactly the
 * same shape as the identity scope's. A worker must choose the next job *before*
 * it can know which tenant that job belongs to — the tenant is derived from the
 * job, just as at login it is derived from the account. A dispatch that already
 * knew its tenant would be a dispatch that could only ever serve one tenant, and
 * `cost-efficient-operation.md` forbids per-tenant workers.
 *
 * What limits the blast radius is that the reachable set is fixed in migrations
 * and holds only routing metadata: queue name, state, attempt counts, timestamps,
 * and digests. Job payloads live in `queue_job_payloads`, which carries no
 * dispatch policy at all, so no amount of querying from this scope reaches
 * message content. Reading a payload requires `bindTenantContext` with the
 * tenant the claimed job named, which is what `@zeddev/queue` does.
 */
export async function withDispatchScope<T>(
  pool: Pool,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (connection) => {
    await connection.query('SELECT set_config($1, $2, true)', [DISPATCH_SCOPE_SETTING, 'on']);
    return fn(connection);
  });
}

/**
 * Run `fn` with access to the inbound attribution tables, before a tenant is known.
 *
 * The fifth scope, and the same ordering constraint once more. A WhatsApp
 * notification names the number that received it, not a tenant, and
 * `message-delivery-reliability.md` requires the tenant be *derived* from that
 * number — so the route must be read before any tenant can be bound. A gateway
 * that already knew its tenant would be trusting the notification to name one.
 *
 * What limits the blast radius is, again, the reach fixed in migration 0013: the
 * number→tenant routes (read-only) and the rejection log (append-only). Stored
 * messages carry no inbound policy, so this scope cannot read one.
 */
export async function withInboundScope<T>(
  pool: Pool,
  fn: (connection: Connection) => Promise<T>,
): Promise<T> {
  return pool.transaction(async (connection) => {
    await connection.query('SELECT set_config($1, $2, true)', [INBOUND_SCOPE_SETTING, 'on']);
    return fn(connection);
  });
}

/**
 * Bind a tenant to a transaction that is already open.
 *
 * `withTenant` is the way to do this and should be used everywhere it fits. This
 * lower-level primitive exists for the one case it cannot express: a queue
 * consumer discovers the tenant partway through a transaction it has already
 * begun under the dispatch scope, and the claim and the payload read must commit
 * together or not at all. Splitting them into two transactions would leave a
 * window in which a job is claimed but its payload was never read, which is
 * recoverable — the lease expires — but wastes an attempt on every occurrence.
 *
 * The binding is still `SET LOCAL`, so it still dies with the transaction and
 * still cannot leak to the next borrower of the connection. What the caller gives
 * up is the guarantee that the transaction was *opened* for one tenant, which is
 * why this is not the default.
 */
export async function bindTenantContext(connection: Connection, tenantId: string): Promise<void> {
  assertTenantId(tenantId);
  await connection.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, tenantId]);
  connection.boundTenantId = tenantId;
}

/**
 * Assert that a row belongs to the tenant currently bound.
 *
 * Row-level security already guarantees this, so reaching this function's throw
 * would mean a policy is missing from a table. That is the point: it is a
 * tripwire on the guarantee, and it turns a silent gap in the migrations into a
 * loud, attributable `TenantAccessError` carrying both tenant ids for the audit
 * trail AC9 implies.
 */
export function assertBelongsToTenant(
  row: { readonly tenant_id?: unknown } | undefined,
  boundTenantId: string,
  resource: string,
): void {
  const owner = row?.tenant_id;
  if (typeof owner === 'string' && owner === boundTenantId) return;
  throw new TenantAccessError({
    boundTenantId,
    requestedTenantId: typeof owner === 'string' ? owner : undefined,
    resource,
  });
}
