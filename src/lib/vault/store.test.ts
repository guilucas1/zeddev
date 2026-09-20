/**
 * The tenant secret store, against a real PostgreSQL.
 *
 * Everything asserted here is a claim `credential-and-secret-handling.md` makes
 * absolutely, and each one needs the database rather than a mock to be worth
 * anything: "the operator cannot retrieve a tenant's credential" is a statement
 * about row-level security policies, and a fake store would pass it by simply not
 * having an operator surface.
 *
 * The sealing key is generated per run. A literal 32-byte base64 value in a
 * source file is a credential-shaped literal — `portability.test.ts` refuses one,
 * and a reader could not tell it from a key a deployment actually uses.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError, NotFoundError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, SecretSealer, secretRef } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import {
  deleteTenantSecret,
  describeTenantSecret,
  putTenantSecret,
  readTenantSecret,
  requireTenantSecret,
  resealTenantSecrets,
  secretsAwaitingReseal,
  TENANT_SECRET_CLASSES,
  tenantSecretAccessHistory,
} from './store.ts';

function sealerWith(...ids: string[]): SecretSealer {
  const keys = ids.map((id) => parseSealingKey(generateSealingKey(id), 'VAULT_SEALING_KEYS'));
  return new SecretSealer(keys, ids[ids.length - 1]);
}

/** A token-shaped value, built rather than written, for the reason above. */
function tokenFor(label: string): string {
  return ['EAA', label, 'aaaaaaaaaaaaaaaaaaaaaaaa'].join('');
}

describe('tenant secret store', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let sealer: SecretSealer;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Vault Cafe ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  before(async () => {
    db = await createTestDatabase('vault');
    pool = db.pool;
    sealer = sealerWith('k1');
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'credential-and-secret-handling.md',
    'AC4 stored data alone is insufficient to use a credential',
    'the stored row holds no recoverable form of the token, and unsealing needs the key',
    async () => {
      const tenant = await newTenant();
      const token = tokenFor('atrest');
      await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, { secretClass: 'tenant_whatsapp_credential', value: token, principal: 'acct-1' }),
      );

      const raw = await withTenant(pool, tenant, (tx) =>
        tx.query<{ sealed_value: string; value_ref: string }>('SELECT sealed_value, value_ref FROM tenant_secrets'),
      );
      const stored = raw.rows[0]!;
      assert.equal(stored.sealed_value.includes(token), false, 'the token is present in the stored row');
      assert.equal(stored.value_ref.includes(token), false);
      assert.equal(stored.value_ref, secretRef(token));

      // The same bytes under a key the platform does not hold are unreadable.
      await assert.rejects(async () => sealerWith('other').unsealToBuffer(stored.sealed_value));

      const recovered = await withTenant(pool, tenant, (tx) =>
        readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
      );
      assert.equal(recovered?.expose(), token);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC5 no secret value appears in any log, diagnostic, error message, metric, alert, or notification',
    'a read returns a redacted wrapper, so the value cannot be serialised by accident',
    async () => {
      const tenant = await newTenant();
      const token = tokenFor('redact');
      await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, { secretClass: 'tenant_whatsapp_credential', value: token, principal: 'acct-1' }),
      );
      const secret = await withTenant(pool, tenant, (tx) =>
        readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
      );
      assert.ok(secret !== undefined);
      assert.equal(JSON.stringify({ secret }).includes(token), false);
      assert.equal(`${String(secret)}`.includes(token), false);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC6 a client sees that a credential is configured and when, never its value',
    'the description carries a digest and timestamps and has no field a value could occupy',
    async () => {
      const tenant = await newTenant();
      const token = tokenFor('describe');
      await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, { secretClass: 'tenant_whatsapp_credential', value: token, principal: 'acct-1' }),
      );
      const described = await withTenant(pool, tenant, (tx) =>
        describeTenantSecret(tx, 'tenant_whatsapp_credential'),
      );
      assert.ok(described !== undefined);
      assert.deepEqual(Object.keys(described).sort(), ['createdAt', 'keyId', 'rotatedAt', 'secretClass', 'valueRef']);
      assert.equal(JSON.stringify(described).includes(token), false);
      assert.equal(described.valueRef, secretRef(token));
      assert.ok(described.createdAt instanceof Date);
      assert.equal(described.rotatedAt, null);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC7 one tenant’s credential is unusable from another tenant’s context',
    'a tenant reads only its own secret, and the other tenant’s is invisible rather than refused',
    async () => {
      const alpha = await newTenant();
      const beta = await newTenant();
      await withTenant(pool, alpha, (tx) =>
        putTenantSecret(tx, sealer, {
          secretClass: 'tenant_whatsapp_credential',
          value: tokenFor('alpha'),
          principal: 'acct-alpha',
        }),
      );

      assert.equal(
        await withTenant(pool, beta, (tx) =>
          readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-beta' }),
        ),
        undefined,
      );
      const rowsSeenByBeta = await withTenant(pool, beta, (tx) => tx.query('SELECT sealed_value FROM tenant_secrets'));
      assert.equal(rowsSeenByBeta.rowCount, 0);

      // And beta storing its own does not disturb alpha's.
      await withTenant(pool, beta, (tx) =>
        putTenantSecret(tx, sealer, {
          secretClass: 'tenant_whatsapp_credential',
          value: tokenFor('beta'),
          principal: 'acct-beta',
        }),
      );
      const alphaValue = await withTenant(pool, alpha, (tx) =>
        readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-alpha' }),
      );
      assert.equal(alphaValue?.expose(), tokenFor('alpha'));
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC13 the operator cannot view a tenant’s WhatsApp credential value',
    'the platform scope reads no row from tenant_secrets, so no operator surface can grow one',
    async () => {
      const tenant = await newTenant();
      await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, {
          secretClass: 'tenant_whatsapp_credential',
          value: tokenFor('operator'),
          principal: 'acct-1',
        }),
      );
      const asOperator = await withPlatformScope(pool, (tx) =>
        tx.query('SELECT sealed_value, value_ref FROM tenant_secrets'),
      );
      assert.equal(asOperator.rowCount, 0);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC10 a superseded credential stops working immediately',
    'storing a replacement leaves exactly one value, the new one, and records the change as a replacement',
    async () => {
      const tenant = await newTenant();
      const first = tokenFor('first');
      const second = tokenFor('second');
      const created = await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, { secretClass: 'tenant_whatsapp_credential', value: first, principal: 'acct-1' }),
      );
      assert.equal(created.rotatedAt, null);

      const replaced = await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, sealer, { secretClass: 'tenant_whatsapp_credential', value: second, principal: 'acct-1' }),
      );
      assert.ok(replaced.rotatedAt instanceof Date);

      const rows = await withTenant(pool, tenant, (tx) => tx.query('SELECT 1 FROM tenant_secrets'));
      assert.equal(rows.rowCount, 1, 'the old value survived alongside the new one');
      const current = await withTenant(pool, tenant, (tx) =>
        readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
      );
      assert.equal(current?.expose(), second);

      const history = await withTenant(pool, tenant, (tx) => tenantSecretAccessHistory(tx));
      const actions = history.map((entry) => entry.action);
      assert.equal(actions.includes('created'), true);
      assert.equal(actions.includes('replaced'), true);
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'AC14 a record identifies who, what secret class, and when, without the value',
    'every touch writes a record naming the principal and class, and no record can hold a value',
    async () => {
      const tenant = await newTenant();
      const token = tokenFor('audit');
      await withTenant(pool, tenant, async (tx) => {
        await putTenantSecret(tx, sealer, {
          secretClass: 'tenant_whatsapp_credential',
          value: token,
          principal: 'acct-audit',
        });
        await readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-audit' });
        await deleteTenantSecret(tx, 'tenant_whatsapp_credential', { principal: 'acct-audit' });
      });

      const history = await withTenant(pool, tenant, (tx) => tenantSecretAccessHistory(tx));
      assert.deepEqual(
        [...history].map((entry) => entry.action).sort(),
        ['created', 'deleted', 'read'],
      );
      for (const entry of history) {
        assert.equal(entry.principal, 'acct-audit');
        assert.equal(entry.secretClass, 'tenant_whatsapp_credential');
        assert.equal(entry.subjectRef, secretRef(token));
        assert.equal(JSON.stringify(entry).includes(token), false);
      }
    },
  );

  unitTest('deleting a secret that is not there records nothing and reports it', async () => {
    const tenant = await newTenant();
    const deleted = await withTenant(pool, tenant, (tx) =>
      deleteTenantSecret(tx, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
    );
    assert.equal(deleted, false);
    assert.deepEqual(await withTenant(pool, tenant, (tx) => tenantSecretAccessHistory(tx)), []);
  });

  unitTest('a required secret that is absent is a not-found, not an empty answer', async () => {
    const tenant = await newTenant();
    await assert.rejects(
      () =>
        withTenant(pool, tenant, (tx) =>
          requireTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
        ),
      NotFoundError,
    );
  });

  unitTest('a stored value the key cannot authenticate fails loudly rather than reading as absent', async () => {
    const tenant = await newTenant();
    await withTenant(pool, tenant, (tx) =>
      putTenantSecret(tx, sealer, {
        secretClass: 'tenant_whatsapp_credential',
        value: tokenFor('tamper'),
        principal: 'acct-1',
      }),
    );
    // Flip a byte of the ciphertext, which is what an at-rest tamper looks like.
    await withTenant(pool, tenant, (tx) =>
      tx.query(
        `UPDATE tenant_secrets
            SET sealed_value = regexp_replace(sealed_value, '.$', CASE WHEN right(sealed_value, 1) = 'A' THEN 'B' ELSE 'A' END)
          WHERE secret_class = 'tenant_whatsapp_credential'`,
      ),
    );
    await assert.rejects(
      () =>
        withTenant(pool, tenant, (tx) =>
          readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
        ),
      ValidationError,
    );
  });

  specTest(
    'credential-and-secret-handling.md',
    'AC8 a credential is replaced without downtime for other tenants and without redeployment',
    'a retired key still unseals what it sealed, and re-sealing moves a value to the active key in place',
    async () => {
      const tenant = await newTenant();
      const token = tokenFor('rotate');
      const oldKey = parseSealingKey(generateSealingKey('k-old'), 'VAULT_SEALING_KEYS');
      const newKey = parseSealingKey(generateSealingKey('k-new'), 'VAULT_SEALING_KEYS');
      const before = new SecretSealer([oldKey], 'k-old');
      // Both keys held, the new one active: the state a rotation actually runs in.
      const during = new SecretSealer([oldKey, newKey], 'k-new');

      await withTenant(pool, tenant, (tx) =>
        putTenantSecret(tx, before, { secretClass: 'tenant_whatsapp_credential', value: token, principal: 'acct-1' }),
      );

      // Nothing is unreadable the moment the new key becomes active.
      const stillReadable = await withTenant(pool, tenant, (tx) =>
        readTenantSecret(tx, during, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
      );
      assert.equal(stillReadable?.expose(), token);

      const pending = await withTenant(pool, tenant, (tx) => secretsAwaitingReseal(tx, during));
      assert.deepEqual(
        pending.map((entry) => [entry.secretClass, entry.keyId]),
        [['tenant_whatsapp_credential', 'k-old']],
      );

      const resealed = await withTenant(pool, tenant, (tx) =>
        resealTenantSecrets(tx, during, { principal: 'acct-1' }),
      );
      assert.deepEqual(resealed, ['tenant_whatsapp_credential']);
      assert.deepEqual(await withTenant(pool, tenant, (tx) => secretsAwaitingReseal(tx, during)), []);

      const after = await withTenant(pool, tenant, (tx) =>
        readTenantSecret(tx, during, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
      );
      assert.equal(after?.expose(), token, 're-sealing changed the value');
    },
  );

  unitTest('the secret-class vocabulary matches the migration CHECK constraint', async () => {
    const result = await pool.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
        WHERE c.conrelid = 'tenant_secrets'::regclass AND c.contype = 'c'`,
    );
    const definition = result.rows
      .map((row) => row.definition)
      .find((text) => /^CHECK \(\(?secret_class = ANY/.test(text));
    assert.ok(definition !== undefined, 'no value-list CHECK on tenant_secrets.secret_class');
    assert.deepEqual(
      [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]!).sort(),
      [...TENANT_SECRET_CLASSES].sort(),
    );
  });
  unitTest('an unbound connection is a defect, not an empty answer', async () => {
    await assert.rejects(
      () => withIdentityScope(pool, (tx) => describeTenantSecret(tx, 'tenant_whatsapp_credential')),
      DefectError,
    );
    await assert.rejects(
      () =>
        withIdentityScope(pool, (tx) =>
          readTenantSecret(tx, sealer, 'tenant_whatsapp_credential', { principal: 'acct-1' }),
        ),
      DefectError,
    );
  });
});
