/**
 * Integration tests for the PostgreSQL client, pool, and migration runner.
 *
 * Every test here runs against a real server. See `testing.ts` for why there is
 * no fake: the behavior under test is PostgreSQL's, and a fake would only prove
 * that this codebase agrees with itself.
 *
 * The tests that matter most are the ones about *session state not surviving a
 * connection's return to the pool*. That property is what the whole tenant
 * isolation design rests on, it is invisible in normal use, and it fails in the
 * worst possible way — by serving one tenant's data to another under load.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigurationError, ConflictError, DefectError, TransientTransportError } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import { Pool, type PoolOptions } from './pool.ts';
import { appliedMigrations, loadMigrations, migrate, pendingMigrations } from './migrate.ts';
import { assertTenantIsolationEnforceable, inspectIsolationCapability } from './preflight.ts';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from './testing.ts';

// `describe` rather than the repo's usual flat `specTest` calls, because these
// share one expensive fixture. The spec traceability helpers are still used for
// individual assertions inside.
describe('PostgreSQL client', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;

  before(async () => {
    db = await createTestDatabase('client');
    pool = db.pool;
  });

  after(async () => {
    await db.drop();
  });

  it('authenticates and reports the server version', async () => {
    const result = await pool.query<{ v: string }>('SELECT version() AS v');
    assert.match(result.rows[0]!.v, /^PostgreSQL /);
  });

  it('round-trips every type the schema uses through a real server', async () => {
    const result = await pool.query<Record<string, unknown>>(
      `SELECT $1::uuid          AS id,
              $2::text          AS name,
              $3::boolean       AS flag,
              $4::integer       AS n,
              $5::bigint        AS big,
              $6::timestamptz   AS at,
              $7::jsonb         AS doc,
              $8::text[]        AS tags,
              $9::bytea         AS blob,
              $10::numeric      AS amount`,
      [
        '11111111-2222-3333-4444-555555555555',
        'a name with , and "quotes"',
        true,
        42,
        9_007_199_254_740_993n,
        new Date('2026-08-25T14:30:00.000Z'),
        { nested: { ok: true } },
        ['a,b', 'c"d', 'plain'],
        Buffer.from('binary'),
        '12345678901234567890.12345',
      ],
    );
    const row = result.rows[0]!;
    assert.equal(row['id'], '11111111-2222-3333-4444-555555555555');
    assert.equal(row['name'], 'a name with , and "quotes"');
    assert.equal(row['flag'], true);
    assert.equal(row['n'], 42);
    assert.equal(row['big'], 9_007_199_254_740_993n);
    assert.equal((row['at'] as Date).toISOString(), '2026-08-25T14:30:00.000Z');
    assert.deepEqual(row['doc'], { nested: { ok: true } });
    assert.deepEqual(row['tags'], ['a,b', 'c"d', 'plain']);
    assert.equal((row['blob'] as Buffer).toString('utf8'), 'binary');
    // Still a string. See codec.ts: a monetary value that has been through a
    // double is no longer the value that was stored.
    assert.equal(row['amount'], '12345678901234567890.12345');
  });

  it('distinguishes SQL NULL from an empty string', async () => {
    const result = await pool.query<{ a: unknown; b: unknown }>(
      `SELECT $1::text AS a, $2::text AS b`,
      [null, ''],
    );
    assert.equal(result.rows[0]!.a, null);
    assert.equal(result.rows[0]!.b, '');
  });

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier supplied out of context does not reach another tenant',
    'query parameters are bound, not interpolated, so SQL in a value stays a value',
    async () => {
      if (!testDatabaseConfigured()) return;
      const hostile = "'; DROP TABLE tenants; --";
      const result = await pool.query<{ echoed: string }>('SELECT $1::text AS echoed', [hostile]);
      assert.equal(result.rows[0]!.echoed, hostile);
    },
  );

  it('remains usable after a statement fails', async () => {
    await assert.rejects(
      () => pool.query('SELECT * FROM a_table_that_does_not_exist'),
      (error: unknown) => error instanceof DefectError,
    );
    const result = await pool.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(result.rows[0]!.ok, 1);
  });

  unitTest('a SQL defect is not retryable, because retrying cannot change the outcome', async () => {
    if (!testDatabaseConfigured()) return;
    await assert.rejects(
      () => pool.query('SELECT * FROM another_missing_table'),
      (error: unknown) => error instanceof DefectError && error.retryable === false,
    );
  });

  specTest(
    'client-signup-and-tenancy.md',
    'AC3 a duplicate email is rejected with a clear reason',
    'a unique violation surfaces as a conflict carrying the constraint name and no row data',
    async () => {
      if (!testDatabaseConfigured()) return;
      await pool.query('CREATE TABLE IF NOT EXISTS dup_probe (email text UNIQUE)');
      await pool.query('INSERT INTO dup_probe VALUES ($1)', ['someone@example.com']);
      await assert.rejects(
        () => pool.query('INSERT INTO dup_probe VALUES ($1)', ['someone@example.com']),
        (error: unknown) => {
          assert.ok(error instanceof ConflictError);
          // The constraint name is schema metadata and is useful. The server's
          // own detail string would have read `Key (email)=(someone@example.com)
          // already exists` — a client's email address in an error that could be
          // logged. Assert it is nowhere in the diagnostic.
          const diagnostic = JSON.stringify(error.toDiagnostic());
          assert.match(diagnostic, /dup_probe_email_key/);
          assert.doesNotMatch(diagnostic, /someone@example\.com/);
          return true;
        },
      );
      await pool.query('DROP TABLE dup_probe');
    },
  );

  it('commits a transaction and rolls one back on a throw', async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS tx_probe (n integer)');
    await pool.transaction(async (tx) => {
      await tx.query('INSERT INTO tx_probe VALUES (1)');
    });
    await assert.rejects(
      pool.transaction(async (tx) => {
        await tx.query('INSERT INTO tx_probe VALUES (2)');
        throw new Error('deliberate');
      }),
    );
    const result = await pool.query<{ n: number }>('SELECT n FROM tx_probe ORDER BY n');
    assert.deepEqual(result.rows.map((r) => r.n), [1]);
    await pool.query('DROP TABLE tx_probe');
  });

  specTest(
    'tenant-data-isolation.md',
    'AC1 a request in one tenant context returns no data belonging to another',
    'a session setting does not survive the connection being returned to the pool',
    async () => {
      if (!testDatabaseConfigured()) return;
      // This is the property the whole tenant-context design depends on. If a
      // binding could outlive its transaction, the next borrower of the
      // connection would silently inherit the previous tenant's scope — an
      // isolation failure produced by the isolation mechanism itself.
      const marker = '99999999-8888-7777-6666-555555555555';
      await pool.transaction(async (tx) => {
        await tx.query('SELECT set_config($1, $2, true)', ['app.tenant_id', marker]);
        const inside = await tx.query<{ v: string | null }>(
          "SELECT current_setting('app.tenant_id', true) AS v",
        );
        assert.equal(inside.rows[0]!.v, marker);
      });

      // Force reuse of the same physical connection by keeping the pool at one.
      const after = await pool.query<{ v: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS v",
      );
      assert.notEqual(after.rows[0]!.v, marker);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC1 a request in one tenant context returns no data belonging to another',
    'a connection left inside a transaction is rolled back before it is reused',
    async () => {
      if (!testDatabaseConfigured()) return;
      // Simulates a caller that escaped `transaction()` — a defect, but one whose
      // consequence must not be the next borrower inheriting an open transaction
      // and with it the previous caller's tenant binding.
      const connection = await pool.acquire();
      await connection.query('BEGIN');
      await connection.query('SELECT set_config($1, $2, true)', ['app.tenant_id', 'leaked']);
      assert.equal(connection.transactionStatus, 'T');
      await pool.release(connection);
      assert.equal(connection.transactionStatus, 'I');

      const reused = await pool.acquire();
      const result = await reused.query<{ v: string | null }>(
        "SELECT current_setting('app.tenant_id', true) AS v",
      );
      assert.notEqual(result.rows[0]!.v, 'leaked');
      await pool.release(reused);
    },
  );

  it('delivers asynchronous notifications without corrupting a concurrent result set', async () => {
    const received: string[] = [];
    const listener = await pool.acquire();
    listener.onNotification((n) => received.push(`${n.channel}:${n.payload}`));
    await listener.query('LISTEN work_available');

    await pool.query("SELECT pg_notify('work_available', 'job-1')");

    // The notification is delivered on the listening connection's socket, so a
    // query on it is what pumps the stream.
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt += 1) {
      await listener.query('SELECT 1');
    }
    await pool.release(listener);
    assert.deepEqual(received, ['work_available:job-1']);
  });
});

describe('connection pool', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('pool');
  });

  after(async () => {
    await db.drop();
  });

  specTest(
    'environment-portability.md',
    'AC8 behavior differs only by configured resource limits',
    'the pool never exceeds its configured maximum, however many callers arrive at once',
    async () => {
      if (!testDatabaseConfigured()) return;
      const bounded = new Pool({ ...poolOptionsFrom(db), maxConnections: 2 });
      try {
        const observed: number[] = [];
        await Promise.all(
          Array.from({ length: 8 }, () =>
            bounded.withConnection(async (connection) => {
              observed.push(bounded.leasedCount);
              await connection.query('SELECT pg_sleep(0.01)');
            }),
          ),
        );
        assert.ok(Math.max(...observed) <= 2, `leased at most 2, saw ${Math.max(...observed)}`);
        assert.ok(bounded.totalCount <= 2);
      } finally {
        await bounded.end();
      }
    },
  );

  unitTest('a caller waiting past the acquire timeout fails rather than hanging forever', async () => {
    if (!testDatabaseConfigured()) return;
    const clock = new FakeClock();
    const bounded = new Pool({
      ...poolOptionsFrom(db),
      maxConnections: 1,
      acquireTimeoutMs: 1000,
      clock,
    });
    try {
      const held = await bounded.acquire();
      const waiting = bounded.acquire();
      // Assert the rejection is attached before advancing, so the rejection is
      // never momentarily unhandled.
      const assertion = assert.rejects(
        waiting,
        (error: unknown) => error instanceof TransientTransportError && error.code === 'db.acquire_timeout',
      );
      await clock.advance(1000);
      await assertion;
      await bounded.release(held);
    } finally {
      await bounded.end();
    }
  });

  unitTest('an idle connection is closed once it has been unused for the configured window', async () => {
    if (!testDatabaseConfigured()) return;
    const clock = new FakeClock();
    const bounded = new Pool({ ...poolOptionsFrom(db), maxConnections: 2, idleTimeoutMs: 60_000, clock });
    try {
      await bounded.withConnection((c) => c.query('SELECT 1'));
      assert.equal(bounded.idleCount, 1);
      await clock.advance(60_001);
      // Reaping happens on acquisition rather than from a background timer, so
      // that an idle deployment costs nothing at all.
      await bounded.withConnection((c) => c.query('SELECT 1'));
      assert.equal(bounded.totalCount, 1);
    } finally {
      await bounded.end();
    }
  });
});

describe('isolation preflight', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('preflight');
  });

  after(async () => {
    await db.drop();
  });

  specTest(
    'environment-portability.md',
    'AC7 a misconfigured deployment fails with a clear error rather than starting broken',
    'a role subject to row-level security passes the preflight check',
    async () => {
      if (!testDatabaseConfigured()) return;
      const capability = await assertTenantIsolationEnforceable(db.pool);
      assert.equal(capability.enforceable, true);
      assert.equal(capability.isSuperuser, false);
      assert.equal(capability.bypassesRls, false);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    'connecting as a superuser is refused at startup, because such a role ignores every policy',
    async () => {
      if (!testDatabaseConfigured()) return;
      // The regression this guards against is total and silent: a superuser is
      // exempt from row-level security, so every policy in the schema stops
      // applying and nothing reports it. The check has to fail loudly at startup,
      // because the alternative is discovering it during an incident.
      const superuserPool = new Pool({
        ...db.options,
        user: process.env['ZEDDEV_TEST_DATABASE_USER'] ?? 'postgres',
        password: (() => {
          const raw = process.env['ZEDDEV_TEST_DATABASE_PASSWORD'];
          return raw === undefined ? undefined : new Secret(raw, 'admin');
        })(),
        maxConnections: 1,
        acquireTimeoutMs: 5000,
        idleTimeoutMs: 30_000,
      });
      try {
        const capability = await inspectIsolationCapability(superuserPool);
        // The fixture's maintenance role is the container superuser. If a future
        // setup changes that, this test would silently stop testing anything, so
        // the precondition is asserted rather than assumed.
        assert.equal(capability.isSuperuser, true, 'precondition: the maintenance role is a superuser');

        await assert.rejects(
          () => assertTenantIsolationEnforceable(superuserPool),
          (error: unknown) => {
            assert.ok(error instanceof ConfigurationError);
            assert.deepEqual(error.keys, ['DATABASE_USER']);
            assert.match(error.message, /NOSUPERUSER NOBYPASSRLS/);
            return true;
          },
        );
      } finally {
        await superuserPool.end();
      }
    },
  );
});

describe('migration runner', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let dir: string;

  before(async () => {
    db = await createTestDatabase('migrate');
    dir = await mkdtemp(join(tmpdir(), 'zeddev-migrations-'));
  });

  after(async () => {
    await db.drop();
    await rm(dir, { recursive: true, force: true });
  });

  it('applies pending migrations in order and is idempotent when re-run', async () => {
    await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE alpha (id integer PRIMARY KEY);\n');
    await writeFile(
      join(dir, '0002_second.sql'),
      'CREATE TABLE beta (id integer PRIMARY KEY);\nCREATE INDEX beta_id_idx ON beta (id);\n',
    );

    const migrations = await loadMigrations(dir);
    assert.deepEqual(migrations.map((m) => m.version), [1, 2]);

    const first = await migrate(db.pool, migrations);
    assert.equal(first.applied.length, 2);

    const second = await migrate(db.pool, migrations);
    assert.equal(second.applied.length, 0);
    assert.equal(second.alreadyApplied, 2);

    assert.deepEqual(await pendingMigrations(db.pool, migrations), []);
  });

  unitTest('a multi-statement migration is one transaction, so a failure leaves nothing behind', async () => {
    if (!testDatabaseConfigured()) return;
    const failing = await mkdtemp(join(tmpdir(), 'zeddev-fail-'));
    try {
      await writeFile(
        join(failing, '0001_partial.sql'),
        'CREATE TABLE will_not_survive (id integer);\nSELECT 1 / 0;\n',
      );
      const scratch = await createTestDatabase('rollback');
      try {
        const migrations = await loadMigrations(failing);
        await assert.rejects(() => migrate(scratch.pool, migrations));
        const exists = await scratch.pool.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'will_not_survive'",
        );
        // Transactional DDL is what makes "just re-run the migrator" safe on
        // every tier without first inspecting what state the last run left.
        assert.equal(exists.rows[0]!.n, 0);
        const ledger = await scratch.pool.withConnection((c) => appliedMigrations(c));
        assert.deepEqual(ledger, []);
      } finally {
        await scratch.drop();
      }
    } finally {
      await rm(failing, { recursive: true, force: true });
    }
  });

  specTest(
    'environment-portability.md',
    'AC4 moving between tiers requires configuration changes only',
    'editing an applied migration is detected rather than silently diverging deployments',
    async () => {
      if (!testDatabaseConfigured()) return;
      const edited = (await loadMigrations(dir)).map((m, index) =>
        index === 0 ? { ...m, sql: `${m.sql}-- edited\n`, checksum: 'tampered' } : m,
      );
      await assert.rejects(
        () => migrate(db.pool, edited),
        (error: unknown) =>
          error instanceof DefectError && error.code === 'db.migration_checksum_mismatch',
      );
    },
  );

  specTest(
    'component-independence.md',
    'AC1 deploying one component does not interrupt the others',
    'two instances starting at once do not race: one applies, the other finds nothing to do',
    async () => {
      if (!testDatabaseConfigured()) return;
      const racing = await mkdtemp(join(tmpdir(), 'zeddev-race-'));
      const scratch = await createTestDatabase('race');
      try {
        await writeFile(join(racing, '0001_only.sql'), 'CREATE TABLE raced (id integer PRIMARY KEY);\n');
        const migrations = await loadMigrations(racing);
        const results = await Promise.all([
          migrate(scratch.pool, migrations),
          migrate(scratch.pool, migrations),
          migrate(scratch.pool, migrations),
        ]);
        // Exactly one runner does the work; the advisory lock makes the others
        // wait and then find the ledger already satisfied.
        const totalApplied = results.reduce((sum, r) => sum + r.applied.length, 0);
        assert.equal(totalApplied, 1);
      } finally {
        await scratch.drop();
        await rm(racing, { recursive: true, force: true });
      }
    },
  );

  unitTest('a gap in migration versions is refused, because a gap means a lost merge', async () => {
    const gapped = await mkdtemp(join(tmpdir(), 'zeddev-gap-'));
    try {
      await writeFile(join(gapped, '0001_a.sql'), 'SELECT 1;\n');
      await writeFile(join(gapped, '0003_c.sql'), 'SELECT 1;\n');
      await assert.rejects(() => loadMigrations(gapped), /gapless/);
    } finally {
      await rm(gapped, { recursive: true, force: true });
    }
  });

  unitTest('a badly named migration file is refused rather than skipped', async () => {
    const bad = await mkdtemp(join(tmpdir(), 'zeddev-bad-'));
    try {
      await writeFile(join(bad, 'add-a-table.sql'), 'SELECT 1;\n');
      await assert.rejects(() => loadMigrations(bad), /NNNN_snake_case_name\.sql/);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

/**
 * Pool options matching a fixture database, at a caller-chosen size.
 *
 * Derived from the fixture's own name via `testConnectionOptions` rather than
 * re-read from the environment, so a test pool can never end up pointing at a
 * different server than the fixture it is supposed to be exercising.
 */
function poolOptionsFrom(db: TestDatabase): PoolOptions {
  return { ...db.options, maxConnections: 5, acquireTimeoutMs: 5000, idleTimeoutMs: 30_000 };
}
