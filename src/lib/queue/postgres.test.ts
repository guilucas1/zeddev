/**
 * The real adapter, against a real PostgreSQL.
 *
 * Two things are proved here that the in-memory conformance run cannot prove.
 *
 * **That the fake is not lying.** The conformance suite runs a second time,
 * against the database, so every guarantee asserted of the fake is asserted of
 * the implementation services actually deploy. When the two disagree, this file
 * is where it surfaces.
 *
 * **That the isolation is structural.** The dispatch scope is a context that sees
 * across tenants, which is the sort of thing `tenant-data-isolation.md` exists to
 * forbid, and the argument that it is safe rests entirely on what the migrations
 * do and do not grant. That argument is only worth anything if a real server is
 * asked to break it — so these tests hand the dispatch scope the exact job id of
 * a real payload and assert that it gets nothing back.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  DefectError,
  TenantAccessError,
  TransientTransportError,
} from '@zeddev/errors';
import { withDispatchScope, withIdentityScope, withTenant, type Pool } from '@zeddev/db';
import {
  createTestDatabase,
  SKIP_REASON,
  testDatabaseConfigured,
  type TestDatabase,
} from '@zeddev/db/testing';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { PostgresQueue } from './index.ts';
import { runQueueConformance, type QueueHarness } from './testing.ts';

/** Real milliseconds. Kept small because every time-based assertion pays it. */
const TIME_UNIT_MS = 150;

describe('postgres queue', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let fixtureCount = 0;

  before(async () => {
    db = await createTestDatabase('queue');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db.drop();
  });

  /**
   * Fresh tenants and a fresh queue name per fixture.
   *
   * Isolation by queue name rather than by database: every statement in the
   * adapter filters on `queue`, so two fixtures in one database cannot see each
   * other's jobs, and creating a database per test would cost more than the whole
   * suite. Fresh tenants matter too — the fairness assertions are about cursor
   * ordering, and a tenant carried over from an earlier test would arrive with a
   * cursor already advanced.
   */
  async function newTenants(count: number): Promise<string[]> {
    return withIdentityScope(pool, async (tx) => {
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const result = await tx.query<{ id: string }>(
          'INSERT INTO tenants (business_name) VALUES ($1) RETURNING id',
          [`Fixture ${fixtureCount}-${i}`],
        );
        ids.push(result.rows[0]!.id);
      }
      return ids;
    });
  }

  const harness: QueueHarness = {
    label: 'postgres',
    async create(options = {}) {
      fixtureCount += 1;
      const queue = new PostgresQueue({ pool, name: `conformance_${fixtureCount}`, ...options });
      const tenants = await newTenants(3);
      return {
        queue,
        tenants,
        timeUnitMs: TIME_UNIT_MS,
        // Real waiting, because the real adapter takes its time from the database
        // server. That is not an inconvenience to work around: a lease whose
        // expiry a worker could simulate is a lease a worker with a fast clock
        // could expire early, handing running work to a second worker.
        advance: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
        dispose: () => queue.close(),
      };
    },
  };

  runQueueConformance(harness);

  // -------------------------------------------------------------------------
  // Isolation: what the dispatch scope can and cannot reach
  // -------------------------------------------------------------------------

  specTest(
    'tenant-data-isolation.md',
    'AC2 no data from one tenant conversation appears in another tenant context',
    'the dispatch scope can route a job but cannot read its payload',
    async () => {
      if (!testDatabaseConfigured()) return;
      const [tenant] = await newTenants(1);
      const queue = new PostgresQueue({ pool, name: 'isolation_payload' });
      const { jobId } = await queue.enqueue(tenant!, {
        kind: 'reply',
        payload: { text: 'the end customer said something private' },
      });

      const seen = await withDispatchScope(pool, async (tx) => {
        // The routing row is visible — that is the entire purpose of the scope.
        const job = await tx.query<{ id: string }>('SELECT id FROM queue_jobs WHERE id = $1', [
          jobId,
        ]);
        assert.equal(job.rows.length, 1, 'dispatch must be able to see the job it is routing');

        // The payload is not, and this is asked with the exact, correct job id —
        // `tenant-data-isolation.md` AC9 requires an identifier be useless out of
        // context "even if guessed, reused, or supplied out of context".
        return tx.query('SELECT payload FROM queue_job_payloads WHERE job_id = $1', [jobId]);
      });

      assert.equal(seen.rows.length, 0);
      // Enforced by the absence of a policy, not by the absence of a query: a
      // future dispatch loop that grew `SELECT payload` would still get nothing.
      const policies = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_policy p
           JOIN pg_class c ON c.oid = p.polrelid
          WHERE c.relname = 'queue_job_payloads'
            AND pg_get_expr(p.polqual, p.polrelid) LIKE '%dispatch%'`,
      );
      assert.equal(policies.rows[0]!.n, 0);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "tenant B holding tenant A's job id can reach neither the job nor its payload",
    async () => {
      if (!testDatabaseConfigured()) return;
      const [a, b] = await newTenants(2);
      const queue = new PostgresQueue({ pool, name: 'isolation_cross' });
      const { jobId } = await queue.enqueue(a!, { kind: 'reply', payload: { text: 'private' } });

      const asB = await withTenant(pool, b!, async (tx) => ({
        jobs: await tx.query('SELECT * FROM queue_jobs WHERE id = $1', [jobId]),
        payloads: await tx.query('SELECT * FROM queue_job_payloads WHERE job_id = $1', [jobId]),
      }));

      assert.equal(asB.jobs.rows.length, 0);
      assert.equal(asB.payloads.rows.length, 0);
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'AC9 an identifier belonging to tenant A is refused in tenant B context',
    "a tenant cannot enqueue a job stamped with another tenant's id",
    async () => {
      if (!testDatabaseConfigured()) return;
      const [a, b] = await newTenants(2);
      await assert.rejects(
        () =>
          withTenant(pool, a!, (tx) =>
            tx.query(
              `INSERT INTO queue_jobs (tenant_id, queue, kind, max_attempts)
               VALUES ($1, $2, $3, $4)`,
              [b, 'isolation_forge', 'reply', 5],
            ),
          ),
        (error: unknown) => error instanceof TenantAccessError,
      );
    },
  );

  unitTest('the dispatch scope cannot move a job between tenants', async () => {
    if (!testDatabaseConfigured()) return;
    const [a, b] = await newTenants(2);
    const queue = new PostgresQueue({ pool, name: 'isolation_move' });
    const { jobId } = await queue.enqueue(a!, { kind: 'reply', payload: {} });

    // The dispatch UPDATE policy's WITH CHECK admits any row shape, so without
    // the trigger this would succeed and hand one tenant's message to another's
    // worker. Asserted rather than assumed because the policy alone does not say
    // it.
    await assert.rejects(
      () =>
        withDispatchScope(pool, (tx) =>
          tx.query('UPDATE queue_jobs SET tenant_id = $2 WHERE id = $1', [jobId, b]),
        ),
      (error: unknown) => error instanceof TenantAccessError,
    );
  });

  unitTest('the dispatch scope cannot create a job for any tenant', async () => {
    if (!testDatabaseConfigured()) return;
    const [a] = await newTenants(1);
    // No INSERT policy exists for the dispatch scope, so a row inserted from a
    // context that never authenticated as a tenant is refused. Enqueue is a
    // tenant-bound act by construction.
    await assert.rejects(
      () =>
        withDispatchScope(pool, (tx) =>
          tx.query(
            `INSERT INTO queue_jobs (tenant_id, queue, kind, max_attempts) VALUES ($1, $2, $3, $4)`,
            [a, 'isolation_insert', 'reply', 5],
          ),
        ),
      (error: unknown) => error instanceof TenantAccessError,
    );
  });

  specTest(
    'message-delivery-reliability.md',
    'AC17 delivery diagnostics contain operational information only, never message content',
    'queue_jobs has no column that could hold message content',
    async () => {
      if (!testDatabaseConfigured()) return;
      // Asserting on the column list makes AC17 a property of the schema rather
      // than a rule every future writer has to remember. The row is readable
      // across tenants, so a `payload` or `error_message` column appearing here
      // would be a leak that no behavioral test would necessarily catch.
      const columns = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'queue_jobs' ORDER BY column_name`,
      );
      assert.deepEqual(columns.rows.map((r) => r.column_name), [
        'attempt',
        'dedupe_ref',
        'enqueued_at',
        'finished_at',
        'id',
        'kind',
        'last_error_code',
        'last_error_kind',
        'leased_until',
        'max_attempts',
        'partition_ref',
        'queue',
        'run_at',
        'seq',
        'started_at',
        'state',
        'tenant_id',
      ]);
    },
  );

  unitTest('an ordering key is stored as a digest, never as the key itself', async () => {
    if (!testDatabaseConfigured()) return;
    const [tenant] = await newTenants(1);
    const queue = new PostgresQueue({ pool, name: 'isolation_digest' });
    await queue.enqueue(tenant!, {
      kind: 'reply',
      payload: {},
      partitionKey: '+15550001111',
      dedupeKey: 'wamid.HBgLMTU1NTAwMDExMTE=',
    });

    const stored = await withDispatchScope(pool, (tx) =>
      tx.query<{ partition_ref: string; dedupe_ref: string }>(
        'SELECT partition_ref, dedupe_ref FROM queue_jobs WHERE queue = $1',
        ['isolation_digest'],
      ),
    );
    const row = stored.rows[0]!;
    // The natural partition key for message work is an end-customer identity, and
    // this column is readable across tenants. Hashing on the way in is what keeps
    // AC17 true regardless of what a caller passes.
    assert.match(row.partition_ref, /^[0-9a-f]{64}$/);
    assert.match(row.dedupe_ref, /^[0-9a-f]{64}$/);
    assert.ok(!row.partition_ref.includes('5550001111'));
  });

  // -------------------------------------------------------------------------
  // Behavior that only the real adapter has
  // -------------------------------------------------------------------------

  unitTest('completing a job destroys its payload', async () => {
    if (!testDatabaseConfigured()) return;
    const [tenant] = await newTenants(1);
    const queue = new PostgresQueue({ pool, name: 'payload_lifetime' });
    const { jobId } = await queue.enqueue(tenant!, { kind: 'reply', payload: { text: 'hello' } });

    const job = await queue.claim();
    assert.ok(job !== undefined);
    await queue.complete(job);

    // Content lives exactly as long as the work does. The job row survives so
    // `dedupeKey` keeps suppressing, and it holds only the digest.
    const remaining = await withTenant(pool, tenant!, (tx) =>
      tx.query('SELECT payload FROM queue_job_payloads WHERE job_id = $1', [jobId]),
    );
    assert.equal(remaining.rows.length, 0);
  });

  unitTest('a dead-lettered job keeps its payload so it can be replayed', async () => {
    if (!testDatabaseConfigured()) return;
    const [tenant] = await newTenants(1);
    const queue = new PostgresQueue({ pool, name: 'payload_dead', maxAttempts: 1 });
    const { jobId } = await queue.enqueue(tenant!, { kind: 'reply', payload: { text: 'hello' } });

    const job = await queue.claim();
    assert.ok(job !== undefined);
    assert.equal(await queue.fail(job, new TransientTransportError('gone', { code: 't' })), 'dead');

    const remaining = await withTenant(pool, tenant!, (tx) =>
      tx.query('SELECT payload FROM queue_job_payloads WHERE job_id = $1', [jobId]),
    );
    assert.equal(remaining.rows.length, 1);
  });

  specTest(
    'message-delivery-reliability.md',
    'AC1 an inbound notification is acknowledged without waiting for a reply to be generated',
    'a job can be enqueued inside the caller transaction that records the message',
    async () => {
      if (!testDatabaseConfigured()) return;
      const [tenant] = await newTenants(1);
      const queue = new PostgresQueue({ pool, name: 'txn_enqueue' });

      // Recording the message and scheduling its processing must be one act:
      // record without enqueue loses the message, enqueue without record loses
      // the duplicate suppression. A rollback must therefore undo both.
      await assert.rejects(() =>
        withTenant(pool, tenant!, async (tx) => {
          await queue.enqueueWithin(tx, { kind: 'reply', payload: { text: 'inbound' } });
          throw new Error('the surrounding unit of work failed');
        }),
      );

      assert.deepEqual(await queue.depth(), { ready: 0, running: 0, dead: 0 });

      await withTenant(pool, tenant!, async (tx) => {
        await queue.enqueueWithin(tx, { kind: 'reply', payload: { text: 'inbound' } });
      });
      assert.equal((await queue.depth()).ready, 1);
    },
  );

  unitTest('enqueueWithin refuses a transaction that has no tenant bound', async () => {
    if (!testDatabaseConfigured()) return;
    const queue = new PostgresQueue({ pool, name: 'txn_unbound' });
    await assert.rejects(
      () => pool.transaction((tx) => queue.enqueueWithin(tx, { kind: 'reply', payload: {} })),
      // Not a silent no-op and not a row with a null tenant: enqueueing outside a
      // tenant context is a defect in the caller, and it fails loudly.
      (error: unknown) => error instanceof DefectError,
    );
  });

  specTest(
    'cost-efficient-operation.md',
    'AC6 an idle platform incurs no fixed cost merely to remain available',
    'a waiting consumer is woken by an enqueue rather than by polling',
    async () => {
      if (!testDatabaseConfigured()) return;
      const [tenant] = await newTenants(1);
      const queue = new PostgresQueue({ pool, name: 'notify_wake' });
      try {
        // Establishes the LISTEN registration. The first call returns at once by
        // design — anything enqueued before the registration existed produced a
        // notification nobody heard, so sleeping on it would be sleeping through
        // ready work.
        await queue.waitForWork(50);

        const startedAt = Date.now();
        // A ten-second timeout that the test expects to end in milliseconds. If
        // the wake-up did not arrive this assertion fails on elapsed time rather
        // than hanging the suite.
        const waiting = queue.waitForWork(10_000);
        await queue.enqueue(tenant!, { kind: 'reply', payload: {} });
        await waiting;

        assert.ok(
          Date.now() - startedAt < 5000,
          'the consumer slept through a notification and had to be woken by its timeout',
        );
      } finally {
        await queue.close();
      }
    },
  );

  unitTest('concurrent claims never hand the same job to two workers', async () => {
    if (!testDatabaseConfigured()) return;
    const [tenant] = await newTenants(1);
    const queue = new PostgresQueue({ pool, name: 'concurrent_claim' });
    for (let i = 0; i < 5; i += 1) {
      await queue.enqueue(tenant!, { kind: 'reply', payload: { i } });
    }

    // `SKIP LOCKED` over a shortlist rather than over a single row is what makes
    // this work: with a one-row candidate set, four of these five would contend
    // for the same job and return empty while work was sitting ready.
    const claimed = await Promise.all(Array.from({ length: 5 }, () => queue.claim()));
    const ids = claimed.filter((job) => job !== undefined).map((job) => job.id);

    assert.equal(new Set(ids).size, ids.length, 'a job was claimed twice');
    assert.ok(ids.length >= 1);
  });
});
