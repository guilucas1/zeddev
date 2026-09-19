/**
 * `@zeddev/db` — PostgreSQL access, schema migration, and tenant context binding.
 *
 * The package exists as one unit rather than three because the three parts are
 * only correct together. `pool.ts` refuses to return a connection that is still
 * inside a transaction *because* `tenant.ts` binds the tenant with `SET LOCAL`;
 * `tenant.ts` can use `SET LOCAL` *because* the pool guarantees a transaction
 * boundary; and `migrate.ts` installs the policies that make either meaningful.
 * Splitting them would let one be replaced without the others, and the isolation
 * guarantee in `tenant-data-isolation.md` would quietly stop holding.
 *
 * IMPLEMENTATION_PLAN.md §1 records the decision behind the shape of this
 * package: PostgreSQL is the single persistent store, carrying relational data,
 * the job queue, and knowledge embeddings, because every additional always-on
 * backing service is a tenant-independent fixed cost that
 * `cost-efficient-operation.md` forbids.
 */

export { DATABASE_CONFIG_SCHEMA } from './config.ts';
export {
  Connection,
  SSL_MODES,
  type ConnectionOptions,
  type QueryResult,
  type SslMode,
} from './connection.ts';
export { Pool, type PoolOptions } from './pool.ts';
export {
  assertTenantIsolationEnforceable,
  inspectIsolationCapability,
  type IsolationCapability,
} from './preflight.ts';
export {
  mapPostgresFailure,
  toPostgresFailure,
  type FailureContext,
  type PostgresFailure,
} from './errors.ts';
export {
  appliedMigrations,
  loadMigrations,
  migrate,
  pendingMigrations,
  type AppliedMigration,
  type Migration,
  type MigrateResult,
} from './migrate.ts';
export {
  assertBelongsToTenant,
  bindTenantContext,
  DISPATCH_SCOPE_SETTING,
  IDENTITY_SCOPE_SETTING,
  INBOUND_SCOPE_SETTING,
  PLATFORM_SCOPE_SETTING,
  TENANT_SETTING,
  withDispatchScope,
  withIdentityScope,
  withInboundScope,
  withPlatformScope,
  withTenant,
} from './tenant.ts';
export { decodeValue, encodeParam, normalizeTimestampText, OID, parseArrayText } from './codec.ts';
export type { BackendNotification, FieldDescription } from './wire.ts';

import { loadConfig, type Config, type RawEnv } from '@zeddev/config';
import { Secret } from '@zeddev/secrets';
import type { Clock } from '@zeddev/time';
import { DATABASE_CONFIG_SCHEMA } from './config.ts';
import { Pool } from './pool.ts';

export type DatabaseConfig = Config<typeof DATABASE_CONFIG_SCHEMA>;

export function loadDatabaseConfig(env: RawEnv = process.env): DatabaseConfig {
  return loadConfig(DATABASE_CONFIG_SCHEMA, env);
}

/**
 * Build a pool from validated configuration.
 *
 * Every value the pool needs comes from the schema, with no fallback invented
 * here. That is what makes `environment-portability.md` AC6 true in practice: the
 * generated configuration reference is a complete account of how one deployment's
 * database behavior can differ from another's, because there is nowhere else for
 * a difference to come from.
 */
export function createPool(
  config: DatabaseConfig,
  options: { readonly applicationName: string; readonly clock?: Clock | undefined },
): Pool {
  const caCertificate = config.DATABASE_CA_CERTIFICATE;
  return new Pool({
    host: config.DATABASE_HOST,
    port: config.DATABASE_PORT,
    user: config.DATABASE_USER,
    password: config.DATABASE_PASSWORD instanceof Secret ? config.DATABASE_PASSWORD : undefined,
    database: config.DATABASE_NAME,
    applicationName: options.applicationName,
    sslMode: config.DATABASE_SSL_MODE,
    connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT,
    statementTimeoutMs: config.DATABASE_STATEMENT_TIMEOUT,
    maxConnections: config.DATABASE_POOL_MAX,
    acquireTimeoutMs: config.DATABASE_ACQUIRE_TIMEOUT,
    idleTimeoutMs: config.DATABASE_IDLE_TIMEOUT,
    ...(caCertificate === '' ? {} : { caCertificate }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
