/**
 * Schema tests: the executable form of `tenant-data-isolation.md`.
 *
 * That spec's guarantees are absolute and adversarially worded, and
 * IMPLEMENTATION_PLAN.md §5 names the real risk plainly: "Isolation is easy to
 * claim and hard to prove." These tests are the proof, and they are written
 * against a real PostgreSQL because the thing being asserted is that a real
 * server refuses a real query.
 *
 * Two kinds of test appear here, and both are necessary.
 *
 *   - **Behavioral**: tenant A's context cannot read tenant B's row. These prove
 *     the policies that exist are correct.
 *   - **Structural**: every table declared tenant-scoped actually has row-level
 *     security enabled *and forced*, and no table outside the declared list is
 *     readable by the operator. These prove that a policy has not gone *missing*,
 *     which is how isolation realistically breaks — not by someone writing a
 *     wrong policy, but by someone adding a table and forgetting one. A
 *     behavioral test only covers tables somebody thought to write a test for.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { TenantAccessError, ConflictError } from '@zeddev/errors';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseConfigured,
  type TestDatabase,
} from '@zeddev/db/testing';
import { specTest, unitTest } from '@zeddev/testing';
import {
  DISPATCH_READABLE_TABLES,
  migrateToLatest,
  PLATFORM_READABLE_TABLES,
  TENANT_SCOPED_TABLES,
} from './index.ts';

describe('baseline schema', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let tenantA = '';
  let tenantB = '';

  before(async () => {
    db = await createTestDatabase('schema');
    pool = db.pool;
    await migrateToLatest(pool);

    // Signup runs before any tenant exists, so it necessarily runs under the
    // identity scope — see `withIdentityScope` for why that ordering is forced
    // by `authentication-and-access.md` rather than chosen for convenience.
    await withIdentityScope(pool, async (tx) => {
      const a = await tx.query<{ id: string }>(
        'INSERT INTO tenants (business_name) VALUES ($1) RETURNING id',
        ['Alpha Bakery'],
      );
      const b = await tx.query<{ id: string }>(
        'INSERT INTO tenants (business_name) VALUES ($1) RETURNING id',
        ['Beta Cycles'],
      );
      tenantA = a.rows[0]!.id;
      tenantB = b.rows[0]!.id;

      await tx.query(
        'INSERT INTO accounts (tenant_id, email, credential_hash) VALUES ($1, $2, $3), ($4, $5, $6)',
        [tenantA, 'owner@alpha.example', 'scrypt$1$1$1$c2FsdA==$aGFzaA==',
         tenantB, 'owner@beta.example', 'scrypt$1$1$1$c2FsdA==$aGFzaA=='],
      );
    });

    // Seeded under each tenant's own context rather than under the identity
    // scope, because `tenant_secrets` deliberately carries no identity policy —
    // authentication has no business reading a tenant's WhatsApp credential.
    // The fixture has to obey the same rule the application does; an attempt to
    // seed it from the identity scope is refused, which is the policy working.
    for (const [tenant, ref] of [
      [tenantA, 'sha256:aaaaaaaaaaaa'],
      [tenantB, 'sha256:bbbbbbbbbbbb'],
    ] as const) {
      await withTenant(pool, tenant, (tx) =>
        tx.query(
          'INSERT INTO tenant_secrets (tenant_id, secret_class, sealed_value, key_id, value_ref) VALUES ($1, $2, $3, $4, $5)',
          [tenant, 'tenant_whatsapp_credential', 'v1$k1$aXY=$dGFn$Y2lwaGVy', 'k1', ref],
        ),
      );
    }
  });

  after(async () => {
    await db.drop();
  });

  // -------------------------------------------------------------------------
  // Structural: the policies exist at all
  // -------------------------------------------------------------------------

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    'every tenant-scoped table has a tenant_id column with row-level security enabled AND forced',
    async () => {
      if (!testDatabaseConfigured()) return;
      for (const table of TENANT_SCOPED_TABLES) {
        const meta = await pool.query<{ rls: boolean; forced: boolean; columns: number; policies: number }>(
          `SELECT c.relrowsecurity  AS rls,
                  c.relforcerowsecurity AS forced,
                  (SELECT count(*)::int FROM information_schema.columns
                     WHERE table_name = $1 AND column_name = 'tenant_id') AS columns,
                  (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
             FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relname = $1 AND n.nspname = 'public'`,
          [table],
        );
        const row = meta.rows[0];
        assert.ok(row !== undefined, `${table} does not exist`);
        assert.equal(row.columns, 1, `${table} must carry a tenant_id column`);
        assert.equal(row.rls, true, `${table} must have row-level security enabled`);
        // FORCE is the half that is easy to omit and impossible to notice. Without
        // it the table's owner — which in a single-role deployment is the role the
        // application connects as — bypasses every policy silently, and every
        // behavioral test below would pass by not being enforced at all.
        assert.equal(row.forced, true, `${table} must FORCE row-level security`);
        assert.ok(row.policies > 0, `${table} must have at least one policy`);
      }
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC7 the operator sees status and metrics only, never conversation content',
    'no tenant-scoped table outside the declared operator-readable list is visible under the platform scope',
    async () => {
      if (!testDatabaseConfigured()) return;
      // The positive half of AC7 is easy and gets built. This is the negative
      // half: as tables are added, the default must remain "the operator cannot
      // see it". Enumerating the exception list and asserting the complement is
      // what keeps that true without anyone remembering to check.
      const readable = new Set<string>(PLATFORM_READABLE_TABLES);
      const withPlatformPolicy = await pool.query<{ table_name: string }>(
        `SELECT DISTINCT c.relname AS table_name
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
          WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%has_platform_scope%'`,
      );
      for (const row of withPlatformPolicy.rows) {
        assert.ok(
          readable.has(row.table_name),
          `${row.table_name} grants the platform scope but is not in PLATFORM_READABLE_TABLES`,
        );
      }
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC2 no data from one tenant conversation appears in another tenant context',
    'no tenant-scoped table outside the declared dispatch-readable list is visible under the dispatch scope',
    async () => {
      if (!testDatabaseConfigured()) return;
      // The same shape of assertion as the platform-scope one above, and for the
      // same reason. The dispatch scope exists because a queue consumer must pick
      // a job before it can know whose job it is, and the argument that this is
      // safe rests entirely on the reachable set being routing metadata only. A
      // table holding content that quietly grew a dispatch policy would break
      // that argument without breaking any behavioral test.
      const readable = new Set<string>(DISPATCH_READABLE_TABLES);
      const withDispatchPolicy = await pool.query<{ table_name: string }>(
        `SELECT DISTINCT c.relname AS table_name
           FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
          WHERE pg_get_expr(p.polqual, p.polrelid) LIKE '%has_dispatch_scope%'`,
      );
      for (const row of withDispatchPolicy.rows) {
        assert.ok(
          readable.has(row.table_name),
          `${row.table_name} grants the dispatch scope but is not in DISPATCH_READABLE_TABLES`,
        );
      }
    },
  );

  // -------------------------------------------------------------------------
  // Behavioral: cross-tenant reads and writes
  // -------------------------------------------------------------------------

  specTest(
    'tenant-data-isolation.md',
    'AC1 a request for another tenant returns no data belonging to it',
    'a tenant-bound query sees only its own rows',
    async () => {
      if (!testDatabaseConfigured()) return;
      const seenByA = await withTenant(pool, tenantA, (tx) =>
        tx.query<{ email: string }>('SELECT email FROM accounts'),
      );
      assert.deepEqual(seenByA.rows.map((r) => r.email), ['owner@alpha.example']);

      const seenByB = await withTenant(pool, tenantB, (tx) =>
        tx.query<{ email: string }>('SELECT email FROM accounts'),
      );
      assert.deepEqual(seenByB.rows.map((r) => r.email), ['owner@beta.example']);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "tenant B supplying tenant A's exact row id gets nothing, not tenant A's data",
    async () => {
      if (!testDatabaseConfigured()) return;
      // The spec says the identifier must be useless "even if guessed, reused, or
      // supplied out of context" — so this test hands over the real, correct id.
      const idOfAsAccount = await withTenant(pool, tenantA, (tx) =>
        tx.query<{ id: string }>('SELECT id FROM accounts'),
      );
      const target = idOfAsAccount.rows[0]!.id;

      const attempt = await withTenant(pool, tenantB, (tx) =>
        tx.query('SELECT * FROM accounts WHERE id = $1', [target]),
      );
      assert.equal(attempt.rowCount, 0);
      assert.equal(attempt.rows.length, 0);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "a tenant cannot write a row stamped with another tenant's id",
    async () => {
      if (!testDatabaseConfigured()) return;
      // Reading is the obvious direction. Writing matters just as much: without a
      // WITH CHECK clause a tenant could insert rows into another tenant's data,
      // which no read-side test would ever catch.
      await assert.rejects(
        () =>
          withTenant(pool, tenantA, (tx) =>
            tx.query(
              'INSERT INTO accounts (tenant_id, email, credential_hash) VALUES ($1, $2, $3)',
              [tenantB, 'smuggled@alpha.example', 'scrypt$1$1$1$c2FsdA==$aGFzaA=='],
            ),
          ),
        (error: unknown) => {
          assert.ok(error instanceof TenantAccessError);
          // The violation is attributed to the tenant context it was attempted
          // from, which is what makes it usable as a security audit record.
          assert.equal(error.context['boundTenantId'], tenantA);
          return true;
        },
      );
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC1 a request for another tenant returns no data belonging to it',
    'a query with no tenant context established sees nothing, rather than seeing everything',
    async () => {
      if (!testDatabaseConfigured()) return;
      // The failure mode of forgetting to establish context must be "returned
      // nothing", which is noticed immediately, and never "returned every
      // tenant's rows", which is not noticed at all.
      const result = await pool.query('SELECT * FROM accounts');
      assert.equal(result.rows.length, 0);
    },
  );

  // -------------------------------------------------------------------------
  // The operator boundary
  // -------------------------------------------------------------------------

  specTest(
    'tenant-data-isolation.md',
    'AC7 the operator can inspect per-client health and metrics across all tenants',
    'the platform scope reads every tenant row',
    async () => {
      if (!testDatabaseConfigured()) return;
      const result = await withPlatformScope(pool, (tx) =>
        tx.query<{ business_name: string }>('SELECT business_name FROM tenants ORDER BY business_name'),
      );
      assert.deepEqual(result.rows.map((r) => r.business_name), ['Alpha Bakery', 'Beta Cycles']);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC13 the operator cannot view a tenant WhatsApp credential value',
    'the platform scope reads zero rows from tenant_secrets, however it asks',
    async () => {
      if (!testDatabaseConfigured()) return;
      // Enforced by the *absence* of a policy rather than by the absence of a
      // query. An operator dashboard that grew a `SELECT sealed_value FROM
      // tenant_secrets` would still return nothing.
      const result = await withPlatformScope(pool, (tx) =>
        tx.query('SELECT sealed_value FROM tenant_secrets'),
      );
      assert.equal(result.rows.length, 0);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC7 tenant A credential is unusable from tenant B context',
    'a tenant reads only its own sealed credential',
    async () => {
      if (!testDatabaseConfigured()) return;
      const forA = await withTenant(pool, tenantA, (tx) =>
        tx.query<{ value_ref: string }>('SELECT value_ref FROM tenant_secrets'),
      );
      assert.deepEqual(forA.rows.map((r) => r.value_ref), ['sha256:aaaaaaaaaaaa']);
    },
  );

  specTest(
    'authentication-and-access.md',
    'AC17 a client session is rejected at an operator surface',
    'the operators table is unreachable from a tenant-bound transaction',
    async () => {
      if (!testDatabaseConfigured()) return;
      await withIdentityScope(pool, (tx) =>
        tx.query('INSERT INTO operators (email, credential_hash) VALUES ($1, $2)', [
          'operator@platform.example',
          'scrypt$1$1$1$c2FsdA==$aGFzaA==',
        ]),
      );
      // `operators` carries no tenant policy at all, so the strongest credential
      // in the system is structurally unreachable from any client request — the
      // separation is enforced by the schema, not by a `WHERE` clause somebody
      // has to remember.
      const fromTenant = await withTenant(pool, tenantA, (tx) =>
        tx.query('SELECT email FROM operators'),
      );
      assert.equal(fromTenant.rows.length, 0);

      const fromIdentity = await withIdentityScope(pool, (tx) =>
        tx.query<{ email: string }>('SELECT email FROM operators'),
      );
      assert.deepEqual(fromIdentity.rows.map((r) => r.email), ['operator@platform.example']);
    },
  );

  // -------------------------------------------------------------------------
  // Audit records
  // -------------------------------------------------------------------------

  specTest(
    'authentication-and-access.md',
    'AC20 a record exists of who accessed what and when',
    'access records can be appended from any context but never modified or deleted',
    async () => {
      if (!testDatabaseConfigured()) return;
      // Appended with no context at all, because the records that matter most are
      // the denials — and a denial happens precisely when the caller has no valid
      // context to record it under.
      await pool.query(
        'INSERT INTO access_records (principal_type, tenant_id, action, resource, outcome, reason) VALUES ($1,$2,$3,$4,$5,$6)',
        ['anonymous', tenantA, 'session.resolve', 'client_session', 'denied', 'unknown_token'],
      );

      const updated = await withPlatformScope(pool, (tx) =>
        tx.query("UPDATE access_records SET outcome = 'allowed' WHERE outcome = 'denied'"),
      );
      const deleted = await withPlatformScope(pool, (tx) =>
        tx.query('DELETE FROM access_records'),
      );
      // No UPDATE or DELETE policy exists, so the rows are invisible to those
      // commands and nothing is affected. An audit record that can be edited is
      // not an audit record.
      assert.equal(updated.rowCount, 0);
      assert.equal(deleted.rowCount, 0);

      const still = await withPlatformScope(pool, (tx) =>
        tx.query<{ outcome: string }>('SELECT outcome FROM access_records'),
      );
      assert.deepEqual(still.rows.map((r) => r.outcome), ['denied']);
    },
  );

  unitTest('the access record schema has no column that could hold conversation content', async () => {
    if (!testDatabaseConfigured()) return;
    // `authentication-and-access.md` AC21 requires these records exclude
    // conversation content. Asserting on the column list makes that a property of
    // the schema rather than a rule every future writer has to remember.
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'access_records' ORDER BY column_name`,
    );
    assert.deepEqual(columns.rows.map((r) => r.column_name), [
      'action',
      'id',
      'occurred_at',
      'outcome',
      'principal_id',
      'principal_type',
      'reason',
      'resource',
      'tenant_id',
    ]);
  });

  // -------------------------------------------------------------------------
  // Signup and lifecycle
  // -------------------------------------------------------------------------

  specTest(
    'client-signup-and-tenancy.md',
    'AC3 a duplicate email is rejected and no second account is created',
    'email uniqueness holds across tenants even though no query can see across them',
    async () => {
      if (!testDatabaseConfigured()) return;
      // The interesting property: the unique index is enforced *below* row-level
      // security. The signing user can never see the account they collided with,
      // and the collision is still detected.
      await assert.rejects(
        () =>
          withIdentityScope(pool, (tx) =>
            tx.query('INSERT INTO accounts (tenant_id, email, credential_hash) VALUES ($1, $2, $3)', [
              tenantB,
              'OWNER@ALPHA.EXAMPLE',
              'scrypt$1$1$1$c2FsdA==$aGFzaA==',
            ]),
          ),
        (error: unknown) => error instanceof ConflictError,
      );
    },
  );

  specTest(
    'client-offboarding-and-data-retention.md',
    'the record of when permanent deletion occurred survives the deletion',
    'deleting a tenant removes its data but leaves the lifecycle record behind',
    async () => {
      if (!testDatabaseConfigured()) return;
      const doomed = await withIdentityScope(pool, async (tx) => {
        const created = await tx.query<{ id: string }>(
          'INSERT INTO tenants (business_name) VALUES ($1) RETURNING id',
          ['Gamma Garage'],
        );
        const id = created.rows[0]!.id;
        await tx.query('INSERT INTO accounts (tenant_id, email, credential_hash) VALUES ($1,$2,$3)', [
          id,
          'owner@gamma.example',
          'scrypt$1$1$1$c2FsdA==$aGFzaA==',
        ]);
        await tx.query('INSERT INTO tenant_lifecycle_events (tenant_id, event) VALUES ($1, $2)', [
          id,
          'permanently_deleted',
        ]);
        return id;
      });

      await withIdentityScope(pool, (tx) => tx.query('DELETE FROM tenants WHERE id = $1', [doomed]));

      const accountsLeft = await withIdentityScope(pool, (tx) =>
        tx.query('SELECT id FROM accounts WHERE tenant_id = $1', [doomed]),
      );
      assert.equal(accountsLeft.rows.length, 0, 'the tenant data must be gone');

      const events = await withPlatformScope(pool, (tx) =>
        tx.query<{ event: string }>('SELECT event FROM tenant_lifecycle_events WHERE tenant_id = $1', [
          doomed,
        ]),
      );
      // A cascading foreign key here would have deleted the very record attesting
      // to the deletion. The row that survives holds an opaque id and a timestamp
      // — enough to prove it happened, nothing that makes the data recoverable.
      assert.deepEqual(events.rows.map((r) => r.event), ['permanently_deleted']);
    },
  );

  unitTest('provisioning state can express failure, not just progress', async () => {
    if (!testDatabaseConfigured()) return;
    // `client-signup-and-tenancy.md` AC7 requires a failed provisioning be
    // *visible* rather than indistinguishable from one still running. A boolean
    // could not express it.
    const created = await withIdentityScope(pool, (tx) =>
      tx.query<{ provisioning_state: string }>(
        "INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'failed') RETURNING provisioning_state",
        ['Delta Diner'],
      ),
    );
    assert.equal(created.rows[0]!.provisioning_state, 'failed');

    await assert.rejects(
      () =>
        withIdentityScope(pool, (tx) =>
          tx.query("INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'nonsense')", [
            'Bad State',
          ]),
        ),
      'an unrecognised provisioning state must be refused by the schema',
    );
  });
});
