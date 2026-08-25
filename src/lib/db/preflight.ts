/**
 * Startup preflight: refuse to run where tenant isolation cannot be enforced.
 *
 * This module exists because of a failure mode discovered while building the
 * schema tests, and it is worth stating plainly because it is invisible and total.
 *
 * PostgreSQL exempts two kinds of role from row-level security: superusers, and
 * roles carrying the `BYPASSRLS` attribute. The exemption is not partial and it
 * is not reported — every policy simply does not apply. `FORCE ROW LEVEL
 * SECURITY`, which is what makes a table's *owner* subject to its own policies,
 * does not close it either.
 *
 * So a deployment whose `DATABASE_USER` happens to be the superuser the database
 * was created with — the default in every quick-start container image, including
 * the one this repository's own `db:up` script used at first — has no tenant
 * isolation whatsoever. Nothing fails. Every query succeeds. Cross-tenant reads
 * return data instead of nothing, and the only symptom is that
 * `tenant-data-isolation.md`'s guarantees are silently false.
 *
 * A misconfiguration that disables the platform's central security property while
 * producing no error is exactly the case `environment-portability.md` AC7 is
 * about: "fail with a clear, diagnosable configuration error ... rather than
 * silently falling back to incorrect behavior". So the platform checks, once, at
 * startup, and refuses to run.
 *
 * The check is cheap — one catalogue query — and it is worth far more than its
 * cost, because the alternative to detecting this at startup is detecting it
 * during an incident.
 */

import { ConfigurationError } from '@zeddev/errors';
import type { Logger } from '@zeddev/logging';
import type { Pool } from './pool.ts';

export interface IsolationCapability {
  readonly role: string;
  readonly isSuperuser: boolean;
  readonly bypassesRls: boolean;
  /** True only when row-level security will actually constrain this role. */
  readonly enforceable: boolean;
}

/** Report whether the connected role is subject to row-level security. */
export async function inspectIsolationCapability(pool: Pool): Promise<IsolationCapability> {
  const result = await pool.query<{
    role: string;
    is_superuser: boolean;
    bypasses_rls: boolean;
  }>(
    `SELECT current_user::text                          AS role,
            current_setting('is_superuser') = 'on'      AS is_superuser,
            COALESCE(r.rolbypassrls, false)             AS bypasses_rls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );

  const row = result.rows[0];
  if (row === undefined) {
    // The role can always see its own row in `pg_roles`, so an empty result means
    // something is wrong enough that assuming isolation works is not defensible.
    throw new ConfigurationError([
      {
        key: 'DATABASE_USER',
        reason: 'could not determine whether the database role is subject to row-level security',
      },
    ]);
  }

  return {
    role: row.role,
    isSuperuser: row.is_superuser,
    bypassesRls: row.bypasses_rls,
    enforceable: !row.is_superuser && !row.bypasses_rls,
  };
}

/**
 * Throw unless the connected role is subject to row-level security.
 *
 * Call this once during startup, before serving any request. The error names the
 * configuration key and the remedy, because the operator hitting it will be
 * someone who followed a database quick-start guide and has no reason to suspect
 * the role attribute is the problem.
 */
export async function assertTenantIsolationEnforceable(
  pool: Pool,
  options: { readonly logger?: Logger | undefined } = {},
): Promise<IsolationCapability> {
  const capability = await inspectIsolationCapability(pool);

  if (!capability.enforceable) {
    throw new ConfigurationError([
      {
        key: 'DATABASE_USER',
        reason:
          `the role "${capability.role}" is ` +
          `${capability.isSuperuser ? 'a superuser' : 'marked BYPASSRLS'}, so PostgreSQL exempts it ` +
          'from every row-level security policy and no tenant isolation is enforced. Connect as a ' +
          'role created with NOSUPERUSER NOBYPASSRLS; it may still own the schema, because every ' +
          'tenant-scoped table uses FORCE ROW LEVEL SECURITY',
      },
    ]);
  }

  options.logger?.info('db.isolation_verified', { principal: capability.role, allowed: true });
  return capability;
}
