/**
 * Test harness: a real, disposable PostgreSQL database per test file.
 *
 * There is no fake or in-memory implementation of this port, and that is a
 * deliberate departure from the ports-and-adapters rule in IMPLEMENTATION_PLAN.md
 * §1, which gives every external dependency an in-memory fake.
 *
 * The reason is that the behavior under test *is* PostgreSQL's. A fake would have
 * to reimplement row-level security in order to test row-level security, and the
 * test would then prove that the fake's policy engine agrees with the fake's
 * policy engine. `tenant-data-isolation.md`'s guarantees are absolute and
 * adversarially worded; the only evidence worth having is that a real server
 * refuses a real cross-tenant query. Higher layers still get fakes — they depend
 * on repository interfaces, not on this.
 *
 * A whole database per test file, rather than a shared one truncated between
 * tests, because `node --test` runs files in parallel processes. Shared state
 * across parallel writers produces failures that depend on scheduling, and a
 * suite that fails one run in twenty gets rerun rather than read.
 *
 * ## Why each fixture creates its own unprivileged role
 *
 * This is the part that was learned the hard way. A PostgreSQL superuser — and
 * any role with `BYPASSRLS` — ignores row-level security entirely, and
 * `FORCE ROW LEVEL SECURITY` does not change that. A test suite connecting as the
 * container's default superuser therefore sees every tenant's rows and reports
 * that isolation is broken; worse, had the assertions been written the other way
 * round, it would have reported that isolation works while proving nothing.
 *
 * So every fixture creates a `NOSUPERUSER NOBYPASSRLS` role, makes it the owner
 * of the database, and connects as it. Owning the tables is fine precisely
 * because the schema uses `FORCE ROW LEVEL SECURITY`, which subjects even the
 * owner to its own policies. That is the same shape a real deployment must use,
 * and `assertTenantIsolationEnforceable` in `preflight.ts` refuses to start
 * against anything else.
 *
 * Connection details come from `ZEDDEV_TEST_DATABASE_*`, not `DATABASE_*`, so
 * that running the suite in a shell that happens to have production
 * configuration loaded cannot create and drop databases on it.
 */

import { randomBytes } from 'node:crypto';
import { Secret } from '@zeddev/secrets';
import { Connection, type ConnectionOptions } from './connection.ts';
import { Pool } from './pool.ts';

const PREFIX = 'ZEDDEV_TEST_DATABASE_';

function envValue(suffix: string): string | undefined {
  const raw = process.env[`${PREFIX}${suffix}`];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** Whether a test database is configured. Tests skip themselves when it is not. */
export function testDatabaseConfigured(): boolean {
  return envValue('HOST') !== undefined;
}

/**
 * The reason a test skipped, phrased so it tells the reader how to fix it.
 *
 * A skip message that says only "no database" trains people to ignore skips.
 * This one names the command and the variables.
 */
export const SKIP_REASON =
  'no test database configured — run `npm run db:up` and export the ZEDDEV_TEST_DATABASE_* variables it prints (see AGENTS.md)';

/** Options for the privileged connection that creates and drops fixtures. */
function adminOptions(database: string): ConnectionOptions {
  return {
    host: envValue('HOST') ?? '',
    port: Number(envValue('PORT') ?? '5432'),
    user: envValue('USER') ?? 'postgres',
    password: (() => {
      const raw = envValue('PASSWORD');
      return raw === undefined ? undefined : new Secret(raw, `${PREFIX}PASSWORD`);
    })(),
    database,
    applicationName: 'zeddev-test-admin',
    sslMode: 'disable',
    connectTimeoutMs: 5000,
    statementTimeoutMs: 15_000,
  };
}

/** Database the fixture connects to in order to issue CREATE/DROP DATABASE. */
function maintenanceDatabase(): string {
  return envValue('NAME') ?? 'postgres';
}

export interface TestDatabase {
  readonly name: string;
  readonly role: string;
  /**
   * Connection options for the unprivileged fixture role.
   *
   * Exposed so a test needing a differently-sized pool builds it from the same
   * source as the fixture, and — more importantly — as the same *role*. A test
   * pool that quietly reverted to the superuser would stop enforcing the policies
   * it was written to verify.
   */
  readonly options: ConnectionOptions;
  readonly pool: Pool;
  /** Close the pool, drop the database, drop the role. Always call from `after`. */
  drop(): Promise<void>;
}

async function onAdmin<T>(database: string, fn: (connection: Connection) => Promise<T>): Promise<T> {
  const connection = new Connection(adminOptions(database));
  await connection.connect();
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

/**
 * Create a disposable database owned by a fresh unprivileged role.
 *
 * `label` is folded into the names so a fixture left behind by a crashed run says
 * which test file created it.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const safeLabel = label.replace(/[^a-z0-9]+/gi, '_').toLowerCase().slice(0, 20);
  const suffix = randomBytes(4).toString('hex');
  const name = `zeddev_t_${safeLabel}_${suffix}`;
  const role = `zeddev_r_${safeLabel}_${suffix}`;
  const rolePassword = randomBytes(18).toString('hex');

  await onAdmin(maintenanceDatabase(), async (admin) => {
    // Neither CREATE ROLE nor CREATE DATABASE may run inside a transaction block,
    // so both go through the simple query protocol. Every interpolated value is
    // built from a hex suffix and a character-filtered label, so there is nothing
    // to inject.
    await admin.simpleQuery(
      `CREATE ROLE "${role}" LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`,
    );
    await admin.simpleQuery(`CREATE DATABASE "${name}" OWNER "${role}"`);
  });

  const options: ConnectionOptions = {
    ...adminOptions(name),
    user: role,
    password: new Secret(rolePassword, 'test-role-password'),
    applicationName: 'zeddev-test',
  };

  const pool = new Pool({ ...options, maxConnections: 5, acquireTimeoutMs: 5000, idleTimeoutMs: 30_000 });

  return {
    name,
    role,
    options,
    pool,
    async drop(): Promise<void> {
      await pool.end();
      await onAdmin(maintenanceDatabase(), async (admin) => {
        // FORCE terminates any connection a test left open. Without it a single
        // leaked connection fails the drop and the next run inherits a stale
        // fixture.
        await admin.simpleQuery(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.simpleQuery(`DROP ROLE IF EXISTS "${role}"`);
      });
    },
  };
}
