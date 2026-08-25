/**
 * `@zeddev/schema` — the platform's database schema, as ordered SQL migrations.
 *
 * Kept as a package of its own rather than as files inside `@zeddev/db` because
 * the two answer different questions. `@zeddev/db` is *how* to talk to
 * PostgreSQL and is reusable against any schema; this is *what* this platform's
 * tables are. Separating them means the migration runner can be tested against a
 * throwaway schema — as it is — instead of against the real one, so a bug in the
 * runner cannot hide behind the schema being correct, or vice versa.
 *
 * The schema is a single source of truth in the strict sense: there is no ORM
 * model, no second declaration in TypeScript, and no generated types checked in
 * beside it. A row's shape is whatever the migrations say, and the tests that
 * matter assert against a real database rather than against a mirror of it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, migrate, type MigrateResult, type Migration, type Pool } from '@zeddev/db';
import type { Logger } from '@zeddev/logging';

/** Directory holding the ordered `NNNN_name.sql` migration files. */
export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export function loadSchemaMigrations(): Promise<Migration[]> {
  return loadMigrations(MIGRATIONS_DIR);
}

/**
 * Bring a database up to the current schema.
 *
 * Safe to call on every start of whichever service owns migrations: the runner
 * takes an advisory lock and applies only what is missing, so a rolling deploy in
 * which several instances start at once converges rather than racing.
 */
export async function migrateToLatest(
  pool: Pool,
  options: { readonly logger?: Logger | undefined } = {},
): Promise<MigrateResult> {
  return migrate(pool, await loadSchemaMigrations(), options);
}

/**
 * Tables that hold tenant-scoped rows and must therefore carry a `tenant_id`
 * column plus a row-level-security policy binding it to the session's tenant.
 *
 * Declared here so the invariant is testable. `tenant-data-isolation.md`'s
 * guarantees are absolute and adversarially worded, and the realistic way they
 * break is not a wrong policy but a *missing* one on a table added later. A test
 * that reads this list and checks the catalogue turns that omission into a build
 * failure instead of a silent, complete loss of isolation on one table.
 */
export const TENANT_SCOPED_TABLES = [
  'accounts',
  'account_tokens',
  'client_sessions',
  'tenant_secrets',
  'queue_jobs',
  'queue_job_payloads',
  'queue_dispatch_cursors',
] as const;

/**
 * Tables an operator may read across all tenants, per `tenant-data-isolation.md`
 * AC7's carve-out for connection health and usage metrics.
 *
 * Enumerated so that the *complement* is enforceable: any tenant-scoped table not
 * on this list must be invisible under the platform scope. That complement is
 * where the operator's inability to reach conversation content lives, and it is
 * the half most likely to erode as tables are added.
 */
export const PLATFORM_READABLE_TABLES = [
  'tenants',
  'tenant_lifecycle_events',
  'access_records',
  'secret_access_records',
] as const;

/**
 * Tables reachable under the dispatch scope — the cross-tenant context a queue
 * consumer runs in while choosing which job to run next.
 *
 * Enumerated for the same reason as `PLATFORM_READABLE_TABLES`: so the
 * *complement* is enforceable. The dispatch scope exists because a worker cannot
 * bind a tenant it has not yet discovered, and the price of that is a context
 * that sees across tenants. What keeps that price bounded is that the reachable
 * set is fixed in migrations and contains only routing metadata — never a job
 * payload, which lives in `queue_job_payloads` and carries no dispatch policy at
 * all. A test asserting this list is complete turns "someone added a dispatch
 * policy to a table holding content" into a build failure.
 */
export const DISPATCH_READABLE_TABLES = ['queue_jobs', 'queue_dispatch_cursors'] as const;
