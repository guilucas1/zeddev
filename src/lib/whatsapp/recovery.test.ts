/**
 * Automatic recovery, against a real PostgreSQL and the scripted Cloud API.
 *
 * Sweeps are driven by hand, so no test waits on a timer: a zero backoff makes
 * every attempt immediately due, and an hour's backoff proves one is not. The
 * process around these sweeps is `services/scheduler`'s test.
 */

import assert from 'node:assert/strict';
import { after, afterEach, before, describe } from 'node:test';
import { withIdentityScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, Secret, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { probeCloudLink, type WhatsAppCloud } from './cloud.ts';
import { connectionHistory, describeConnection, readConnection, transitionConnection } from './connection.ts';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend, type ScriptedFailure } from './memory.ts';
import { submitCredentials } from './onboarding.ts';
import {
  claimRecoveryProbe,
  listConnectionsDueForRecovery,
  RECOVERY_PRINCIPAL,
  settleRecoveryProbe,
  sweepConnectionRecovery,
  type RecoveryPolicy,
} from './recovery.ts';

const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220002222';
const META_OUTAGE: ScriptedFailure = { status: 503, code: 1 };
const THROTTLED: ScriptedFailure = { status: 429, code: 130429 };
const TOKEN_REVOKED: ScriptedFailure = { status: 401, code: 190 };

const IMMEDIATE: RecoveryPolicy = { maxAttempts: 3, backoff: () => 0 };
const AN_HOUR: RecoveryPolicy = { maxAttempts: 3, backoff: () => 3_600_000 };

/** Replaces some of a cloud's operations, leaving the rest answering as before. */
function overriding(cloud: WhatsAppCloud, overrides: Partial<WhatsAppCloud>): WhatsAppCloud {
  return new Proxy(cloud, {
    get(target, property) {
      const override = overrides[property as keyof WhatsAppCloud];
      if (override !== undefined) return override;
      const value = Reflect.get(target, property) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

unitTest('a subscription Meta will not confirm is refused, not reported as a working link', async () => {
  const backend = new ScriptedCloudBackend();
  backend.register({ token: 'probe-token', phoneNumberId: '111', businessAccountId: '222', appId: APP_ID });
  const cloud = overriding(new InMemoryWhatsAppCloud({ appId: APP_ID, backend }), {
    listSubscribedApps: async () => ['some-other-app'],
  });
  const probe = await probeCloudLink(cloud, {
    accessToken: new Secret('probe-token', 'test token'),
    phoneNumberId: '111',
    businessAccountId: '222',
  });
  assert.deepEqual(probe, { ok: false, reason: 'configuration_invalid' });
});

describe('connection recovery', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let backend: ScriptedCloudBackend;
  let cloud: WhatsAppCloud;
  let sealer: SecretSealer;
  let counter = 0;
  const created: string[] = [];

  before(async () => {
    db = await createTestDatabase('recovery');
    pool = db.pool;
    await migrateToLatest(pool);
    sealer = new SecretSealer([parseSealingKey(generateSealingKey('k1'), 'VAULT_SEALING_KEYS')]);
    backend = new ScriptedCloudBackend();
    cloud = new InMemoryWhatsAppCloud({ appId: APP_ID, backend });
  });

  // Every sweep looks across all tenants, so a tenant one test leaves interrupted
  // would otherwise be swept by the next test and consume its scripted failures.
  afterEach(async () => {
    for (const tenant of created.splice(0)) {
      await withTenant(pool, tenant, async (tx) => {
        if ((await readConnection(tx)).state === 'reconnecting') await transitionConnection(tx, 'disconnected');
      });
    }
  });

  after(async () => {
    await db?.drop();
  });

  async function newTenant(): Promise<string> {
    counter += 1;
    const name = `Recovery Roasters ${counter}`;
    const tenant = await withIdentityScope(pool, async (tx) => {
      const row = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [name],
      );
      return row.rows[0]!.id;
    });
    created.push(tenant);
    return tenant;
  }

  /** A connected number whose connection a failed send has just interrupted. */
  async function interrupted(
    options: { readonly registered?: boolean; readonly verificationStatus?: string } = {},
  ): Promise<{ readonly tenant: string; readonly token: string }> {
    const tenant = await newTenant();
    const phoneNumberId = String(700_000_000 + counter);
    const token = ['recovery', String(counter), 'token'].join('-');
    if (options.registered !== false) {
      backend.register({
        token,
        phoneNumberId,
        businessAccountId: BUSINESS_ACCOUNT_ID,
        appId: APP_ID,
        ...(options.verificationStatus === undefined ? {} : { verificationStatus: options.verificationStatus }),
      });
    }
    await withTenant(pool, tenant, async (tx) => {
      await submitCredentials(
        tx,
        sealer,
        { phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, accessToken: token },
        { principal: 'recovery-test' },
      );
      await transitionConnection(tx, 'connected');
      await transitionConnection(tx, 'reconnecting');
    });
    return { tenant, token };
  }

  function sweep(policy: RecoveryPolicy = IMMEDIATE, using: WhatsAppCloud = cloud, logger?: Logger) {
    return sweepConnectionRecovery({ pool, cloud: using, sealer, policy, logger });
  }

  function status(tenant: string) {
    return withTenant(pool, tenant, (tx) => readConnection(tx));
  }

  async function allowance(tenant: string): Promise<{ attempts: number; nextAt: Date | null }> {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ recovery_attempts: number; recovery_next_at: Date | null }>(
        `SELECT recovery_attempts, recovery_next_at FROM whatsapp_connections`,
      );
      return { attempts: result.rows[0]!.recovery_attempts, nextAt: result.rows[0]!.recovery_next_at };
    });
  }

  specTest(
    'whatsapp-number-connection.md',
    'AC5 a successful recovery returns the connection to connected, and the transition is recorded',
    'a probe that finds the link working restores it with no traffic and no client action',
    async () => {
      const { tenant } = await interrupted();
      const summary = await sweep();
      assert.equal(summary.recovered, 1);

      const after = await status(tenant);
      assert.equal(after.state, 'connected');
      assert.ok(after.lastKnownGoodAt instanceof Date);
      const [latest] = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.equal(latest?.from, 'reconnecting');
      assert.equal(latest?.to, 'connected');
      assert.ok(latest?.occurredAt instanceof Date);
    },
  );

  unitTest('a probe repairs a lapsed webhook subscription, and sends nobody anything', async () => {
    const { token } = await interrupted();
    const sendsBefore = backend.sends.length;
    assert.deepEqual(backend.subscribersOf(token), []);
    await sweep();
    assert.deepEqual(backend.subscribersOf(token), [APP_ID]);
    assert.equal(backend.sends.length, sendsBefore);
  });

  specTest(
    'whatsapp-number-connection.md',
    'AC6 when automatic recovery attempts are exhausted the state transitions to error with a surfaced reason',
    'recoverable failures keep the connection reconnecting until the allowance runs out',
    async () => {
      const { tenant } = await interrupted();

      backend.failNext('describeBusinessAccount', META_OUTAGE);
      assert.equal((await sweep()).retrying, 1);
      assert.equal((await status(tenant)).state, 'reconnecting');

      // A throughput limit is recoverable too, and spends the same allowance.
      backend.failNext('describeNumber', THROTTLED);
      assert.equal((await sweep()).retrying, 1);
      assert.equal((await status(tenant)).state, 'reconnecting');
      assert.equal((await allowance(tenant)).attempts, 2);

      backend.failNext('describeBusinessAccount', META_OUTAGE);
      assert.equal((await sweep()).exhausted, 1);

      const final = await status(tenant);
      assert.equal(final.state, 'error');
      assert.equal(final.errorReason, 'recovery_exhausted');
      assert.match(describeConnection(final).error?.description ?? '', /could not be restored automatically/);
      const [latest] = await withTenant(pool, tenant, (tx) => connectionHistory(tx));
      assert.equal(latest?.to, 'error');
      assert.equal(latest?.errorReason, 'recovery_exhausted');
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC12 a connection in error displays a specific reason',
    "a failure retrying cannot fix goes to error at once, carrying Meta's reason rather than recovery_exhausted",
    async () => {
      const { tenant } = await interrupted();
      backend.failNext('describeNumber', TOKEN_REVOKED);
      assert.equal((await sweep()).failed, 1);
      const final = await status(tenant);
      assert.equal(final.state, 'error');
      assert.equal(final.errorReason, 'authorization_revoked');
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC9 business verification incomplete or revoked is surfaced as a distinct blocking condition',
    'a business Meta has stopped treating as verified is not retried as a technical failure',
    async () => {
      const { tenant } = await interrupted({ verificationStatus: 'rejected' });
      assert.equal((await sweep()).failed, 1);
      assert.equal((await status(tenant)).errorReason, 'business_verification_required');
    },
  );

  unitTest('a connection with nothing to probe with goes to error rather than being retried forever', async () => {
    const tenant = await newTenant();
    await withTenant(pool, tenant, async (tx) => {
      await transitionConnection(tx, 'connecting');
      await transitionConnection(tx, 'connected');
      await transitionConnection(tx, 'reconnecting');
    });
    assert.equal((await sweep()).unrecoverable, 1);
    assert.equal((await status(tenant)).errorReason, 'configuration_invalid');
  });

  unitTest('only connections in reconnecting are ever looked at', async () => {
    const reconnecting = await interrupted();
    const connected = await newTenant();
    const failed = await newTenant();
    await withTenant(pool, connected, async (tx) => {
      await transitionConnection(tx, 'connecting');
      await transitionConnection(tx, 'connected');
    });
    await withTenant(pool, failed, async (tx) => {
      await transitionConnection(tx, 'connecting');
      await transitionConnection(tx, 'error', { reason: 'verification_failed' });
    });
    assert.deepEqual(await listConnectionsDueForRecovery(pool, 100), [reconnecting.tenant]);
  });

  unitTest('an attempt is not repeated until its wait is over, and the wait grows with each failure', async () => {
    const { tenant } = await interrupted();
    const asked: number[] = [];
    const policy: RecoveryPolicy = {
      maxAttempts: 10,
      backoff: (attempt) => {
        asked.push(attempt);
        return 3_600_000;
      },
    };

    backend.failNext('describeBusinessAccount', META_OUTAGE);
    assert.equal((await sweep(policy)).retrying, 1);
    assert.ok((await allowance(tenant)).nextAt instanceof Date);

    // Not due: nothing is claimed, and the failure queued below is left unconsumed.
    backend.failNext('describeBusinessAccount', META_OUTAGE);
    assert.deepEqual(await listConnectionsDueForRecovery(pool, 100), []);
    assert.equal((await sweep(policy)).retrying, 0);

    await withTenant(pool, tenant, (tx) =>
      tx.query(`UPDATE whatsapp_connections SET recovery_next_at = now() - interval '1 second'`),
    );
    assert.equal((await sweep(policy)).retrying, 1);
    assert.deepEqual(asked, [1, 2]);
    assert.equal((await allowance(tenant)).attempts, 2);
  });

  unitTest('sweeps running at once probe a connection once, so a second scheduler is safe to run', async () => {
    const { tenant } = await interrupted();

    // The claim is what is being tested, so it is asked directly as well: with an
    // answer still out, the state alone would let a second instance straight in.
    const first = await withTenant(pool, tenant, (tx) => claimRecoveryProbe(tx, sealer, AN_HOUR));
    assert.equal(first.status, 'ready');
    const second = await withTenant(pool, tenant, (tx) => claimRecoveryProbe(tx, sealer, AN_HOUR));
    assert.equal(second.status, 'not_due');
    await withTenant(pool, tenant, (tx) =>
      tx.query(`UPDATE whatsapp_connections SET recovery_next_at = NULL`),
    );

    // Held open like a real Graph call, or the first sweep would settle the row
    // before the others reach it and this would pass with no lease at all.
    let probes = 0;
    const counting = overriding(cloud, {
      describeBusinessAccount: async (credentials) => {
        probes += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        return cloud.describeBusinessAccount(credentials);
      },
    });
    await Promise.all([sweep(AN_HOUR, counting), sweep(AN_HOUR, counting), sweep(AN_HOUR, counting)]);
    assert.equal(probes, 1);
  });

  unitTest('each stay in reconnecting gets a full allowance, whichever way the last one ended', async () => {
    const { tenant } = await interrupted();
    backend.failNext('describeBusinessAccount', META_OUTAGE);
    backend.failNext('describeBusinessAccount', META_OUTAGE);
    await sweep();
    await sweep();
    assert.equal((await allowance(tenant)).attempts, 2);

    // What a send succeeding does, followed by the next interruption.
    await withTenant(pool, tenant, async (tx) => {
      await transitionConnection(tx, 'connected');
      await transitionConnection(tx, 'reconnecting');
    });
    assert.deepEqual(await allowance(tenant), { attempts: 0, nextAt: null });
  });

  unitTest('an answer arriving after the client disconnected is dropped, not applied', async () => {
    const { tenant } = await interrupted();
    const claim = await withTenant(pool, tenant, (tx) => claimRecoveryProbe(tx, sealer, IMMEDIATE));
    assert.equal(claim.status, 'ready');

    await withTenant(pool, tenant, (tx) => transitionConnection(tx, 'disconnected'));

    const verdict = await withTenant(pool, tenant, (tx) => settleRecoveryProbe(tx, { ok: true, number: PROFILE }, IMMEDIATE));
    assert.equal(verdict, 'superseded');
    assert.equal((await status(tenant)).state, 'disconnected');
  });

  unitTest("a defect here spends none of the client's allowance and does not move their connection", async () => {
    const { tenant, token } = await interrupted();
    const sink = new MemorySink();
    const defective = overriding(cloud, {
      describeBusinessAccount: async () => {
        throw new DefectError('a bug on this side of the wire', { code: 'test.defect' });
      },
    });
    assert.equal((await sweep(IMMEDIATE, defective, new Logger({ sink }))).defect, 1);

    const after = await status(tenant);
    assert.equal(after.state, 'reconnecting');
    assert.equal((await allowance(tenant)).attempts, 0);
    assert.ok(sink.records.some((record) => record.event === 'whatsapp.recovery.defect'));
    assert.ok(!sink.serialized().includes(token), 'a token reached a log line');
  });

  unitTest('one failing connection never stops the others in a sweep', async () => {
    const good = await interrupted();
    const broken = await interrupted();
    const secondGood = await interrupted();
    const sometimesDefective = overriding(cloud, {
      describeBusinessAccount: async (credentials) => {
        if (credentials.accessToken.expose() === broken.token) throw new Error('only this one');
        return cloud.describeBusinessAccount(credentials);
      },
    });
    const summary = await sweep(IMMEDIATE, sometimesDefective);
    assert.equal(summary.defect, 1);
    assert.equal(summary.recovered, 2);
    assert.equal((await status(good.tenant)).state, 'connected');
    assert.equal((await status(secondGood.tenant)).state, 'connected');
  });

  specTest(
    'tenant-data-isolation.md',
    "AC3 tenant B's connection failing leaves tenant A's connection unaffected",
    'a sweep settles each tenant under its own binding, and one going to error moves no other',
    async () => {
      const a = await interrupted();
      const b = await interrupted({ registered: false });
      const summary = await sweep();
      assert.equal(summary.recovered, 1);
      assert.equal(summary.failed, 1);
      assert.equal((await status(a.tenant)).state, 'connected');
      assert.equal((await status(b.tenant)).errorReason, 'authorization_revoked');
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC14 accessing a secret leaves a record identifying who performed it',
    'a probe unsealing the token is on the record under its own name',
    async () => {
      const { tenant } = await interrupted();
      await sweep();
      const principals = await withTenant(pool, tenant, async (tx) => {
        const rows = await tx.query<{ principal: string }>(`SELECT principal FROM secret_access_records`);
        return rows.rows.map((row) => row.principal);
      });
      assert.ok(principals.includes(RECOVERY_PRINCIPAL));
    },
  );

  unitTest('an unbound connection is refused rather than silently matching nothing', async () => {
    await pool.transaction(async (tx) => {
      await assert.rejects(claimRecoveryProbe(tx, sealer, IMMEDIATE), DefectError);
      await assert.rejects(settleRecoveryProbe(tx, { ok: true, number: PROFILE }, IMMEDIATE), DefectError);
    });
  });
});

const PROFILE = {
  phoneNumberId: '111',
  displayNumber: '',
  verifiedName: '',
  qualityRating: 'unknown',
  numberVerification: 'verified',
};
