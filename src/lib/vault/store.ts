/**
 * The tenant secret store — `credential-and-secret-handling.md` made operational.
 *
 * `@zeddev/secrets` knows how to seal a value and `0003_tenant_secrets.sql` knows
 * where a sealed value lives; nothing joined the two until now, so a tenant's
 * WhatsApp access token had nowhere to go. This module is that join, and it is
 * deliberately the *only* one: every read, write, and deletion of a tenant secret
 * goes through here.
 *
 * Why one place matters more here than elsewhere:
 *
 *   - **AC14 requires a record of every access and change.** If sealing were done
 *     at each call site, the audit record would be one `await` that a future
 *     caller forgets, and its absence is invisible — the feature still works. Here
 *     the record is written in the same transaction as the access, by the same
 *     function, so there is no path that touches a secret silently.
 *   - **AC5 requires no secret reach a log or an error.** `readTenantSecret`
 *     returns `Secret<string>`, never a bare string, so the value cannot be
 *     interpolated into a message even by accident. Nothing in this module returns
 *     the plaintext in any other shape.
 *   - **AC6 requires a client see *that* a credential is configured and when, but
 *     never its value.** That is a different question from "give me the token", so
 *     it is a different function (`describeTenantSecret`) that never unseals.
 *
 * Every function takes a `Connection` the caller has already bound to one tenant,
 * as in `@zeddev/bot` and `@zeddev/whatsapp`. `tenant_secrets` has no platform
 * policy and no identity policy, so an unbound connection reads zero rows — which
 * is indistinguishable from "this tenant has no credential". `requireTenant`
 * turns that silent wrong answer into a defect.
 */

import type { Connection } from '@zeddev/db';
import { DefectError, NotFoundError } from '@zeddev/errors';
import { SecretSealer, secretRef, type Secret, type SecretAccessRecord, type SecretClass } from '@zeddev/secrets';

/** The classes `tenant_secrets` accepts. Mirrored by a CHECK constraint in migration 0003. */
export const TENANT_SECRET_CLASSES = ['tenant_whatsapp_credential', 'webhook_signing_secret'] as const;
export type TenantSecretClass = (typeof TENANT_SECRET_CLASSES)[number];

/**
 * A stored secret as a product surface may describe it.
 *
 * Note what is absent: there is no field this could put a value in. AC6 holds by
 * the shape of the type rather than by every caller remembering the rule.
 */
export interface StoredSecretDescription {
  readonly secretClass: TenantSecretClass;
  /** The non-sensitive digest form, for support. Never the value. */
  readonly valueRef: string;
  /** Which sealing key protects it — the input to "which rows still use the retired key?". */
  readonly keyId: string;
  readonly createdAt: Date;
  readonly rotatedAt: Date | null;
}

interface SecretRow {
  secret_class: TenantSecretClass;
  sealed_value: string;
  key_id: string;
  value_ref: string;
  created_at: Date;
  rotated_at: Date | null;
}

const DESCRIBE_COLUMNS = 'secret_class, key_id, value_ref, created_at, rotated_at';

function requireTenant(connection: Connection, operation: string): string {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'vault.tenant_unbound' });
  }
  return connection.boundTenantId;
}

function describe(row: Omit<SecretRow, 'sealed_value'>): StoredSecretDescription {
  return {
    secretClass: row.secret_class,
    valueRef: row.value_ref,
    keyId: row.key_id,
    createdAt: row.created_at,
    rotatedAt: row.rotated_at,
  };
}

/**
 * Write the record AC14 requires.
 *
 * Takes the whole `SecretAccessRecord` shape from `@zeddev/secrets` rather than
 * loose arguments so that the type's guarantee — no field can hold a value —
 * reaches the table. `secret_access_records` has an append-only INSERT policy that
 * admits any scope, so this works from a tenant, identity, or platform context
 * alike; it is the *reading* of the table that is restricted.
 */
export async function recordSecretAccess(
  connection: Connection,
  record: Omit<SecretAccessRecord, 'at'> & { readonly tenantId: string | null },
): Promise<void> {
  await connection.query(
    `INSERT INTO secret_access_records (principal, secret_class, action, subject_ref, tenant_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [record.principal, record.secretClass, record.action, record.subjectRef, record.tenantId],
  );
}

/**
 * Store a tenant's secret, replacing any previous value of the same class.
 *
 * The replacement is an UPSERT rather than a delete-then-insert because AC10
 * requires a superseded credential stop working "immediately": there must be no
 * instant in which both the old and the new value are live, and no instant in
 * which neither is. One statement gives both.
 *
 * The audit record distinguishes `created` from `replaced` by what the UPSERT
 * actually did, not by a prior read — a read-then-decide would mislabel two
 * concurrent writes.
 */
export async function putTenantSecret(
  connection: Connection,
  sealer: SecretSealer,
  input: {
    readonly secretClass: TenantSecretClass;
    readonly value: string;
    /** Who is storing it, for the access record. A principal id, never a credential. */
    readonly principal: string;
  },
): Promise<StoredSecretDescription> {
  const tenantId = requireTenant(connection, 'putTenantSecret');
  const valueRef = secretRef(input.value);
  const sealed = sealer.seal(input.value);
  const result = await connection.query<Omit<SecretRow, 'sealed_value'> & { inserted: boolean }>(
    // `xmax = 0` is how PostgreSQL reports which half of an UPSERT ran: a row the
    // INSERT created carries no updating transaction id, one the DO UPDATE
    // rewrote carries this transaction's. Asking the statement is exact; a prior
    // SELECT would misreport under two concurrent writers.
    `INSERT INTO tenant_secrets (tenant_id, secret_class, sealed_value, key_id, value_ref)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4)
     ON CONFLICT (tenant_id, secret_class)
     DO UPDATE SET sealed_value = EXCLUDED.sealed_value,
                   key_id       = EXCLUDED.key_id,
                   value_ref    = EXCLUDED.value_ref,
                   rotated_at   = now()
     RETURNING ${DESCRIBE_COLUMNS}, (xmax = 0) AS inserted`,
    [input.secretClass, sealed, sealer.activeKeyId, valueRef],
  );
  const row = result.rows[0]!;
  await recordSecretAccess(connection, {
    principal: input.principal,
    secretClass: input.secretClass,
    action: row.inserted ? 'created' : 'replaced',
    subjectRef: valueRef,
    tenantId,
  });
  return describe(row);
}

/**
 * Read a tenant's secret for use, recording that it was read.
 *
 * Returns `undefined` when the tenant has none, rather than throwing: "this
 * tenant never configured a number" is an ordinary answer on the outbound path,
 * not an exceptional one. A *tampered or unreadable* stored value is a different
 * matter and does throw, out of `SecretSealer.unsealToBuffer` — silently treating
 * it as absent would turn key misconfiguration into "the tenant is not connected",
 * which is the wrong diagnosis and the wrong remedy.
 */
export async function readTenantSecret(
  connection: Connection,
  sealer: SecretSealer,
  secretClass: TenantSecretClass,
  options: { readonly principal: string },
): Promise<Secret<string> | undefined> {
  const tenantId = requireTenant(connection, 'readTenantSecret');
  const result = await connection.query<SecretRow>(
    `SELECT sealed_value, ${DESCRIBE_COLUMNS}
       FROM tenant_secrets
      WHERE tenant_id = app.current_tenant_id() AND secret_class = $1`,
    [secretClass],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  const value = sealer.unseal(row.sealed_value, secretClass);
  await recordSecretAccess(connection, {
    principal: options.principal,
    secretClass,
    action: 'read',
    subjectRef: row.value_ref,
    tenantId,
  });
  return value;
}

/**
 * What a product surface may show about a stored secret (AC6).
 *
 * Reads no sealed value and needs no sealer, so a surface that only has to answer
 * "is a credential configured, and since when?" structurally cannot obtain one.
 */
export async function describeTenantSecret(
  connection: Connection,
  secretClass: TenantSecretClass,
): Promise<StoredSecretDescription | undefined> {
  requireTenant(connection, 'describeTenantSecret');
  const result = await connection.query<Omit<SecretRow, 'sealed_value'>>(
    `SELECT ${DESCRIBE_COLUMNS} FROM tenant_secrets
      WHERE tenant_id = app.current_tenant_id() AND secret_class = $1`,
    [secretClass],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : describe(row);
}

/**
 * Destroy a tenant's secret.
 *
 * Returns whether anything was deleted, and records the deletion only when there
 * was something to delete — an access record for a secret that never existed
 * would make the audit trail describe an event that did not happen.
 */
export async function deleteTenantSecret(
  connection: Connection,
  secretClass: TenantSecretClass,
  options: { readonly principal: string },
): Promise<boolean> {
  const tenantId = requireTenant(connection, 'deleteTenantSecret');
  const result = await connection.query<{ value_ref: string }>(
    `DELETE FROM tenant_secrets
      WHERE tenant_id = app.current_tenant_id() AND secret_class = $1
      RETURNING value_ref`,
    [secretClass],
  );
  const row = result.rows[0];
  if (row === undefined) return false;
  await recordSecretAccess(connection, {
    principal: options.principal,
    secretClass,
    action: 'deleted',
    subjectRef: row.value_ref,
    tenantId,
  });
  return true;
}

/** The same read, but a missing secret is a failure the caller cannot proceed past. */
export async function requireTenantSecret(
  connection: Connection,
  sealer: SecretSealer,
  secretClass: TenantSecretClass,
  options: { readonly principal: string },
): Promise<Secret<string>> {
  const value = await readTenantSecret(connection, sealer, secretClass, options);
  if (value === undefined) {
    throw new NotFoundError(`${secretClass} for this tenant`, { context: { secretClass } });
  }
  return value;
}

/**
 * The secrets still protected by a key other than the active one.
 *
 * Rotation's progress indicator. Answerable from the indexed `key_id` column
 * without unsealing anything, which is the whole reason that column is
 * denormalised out of the sealed string.
 */
export async function secretsAwaitingReseal(
  connection: Connection,
  sealer: SecretSealer,
): Promise<StoredSecretDescription[]> {
  requireTenant(connection, 'secretsAwaitingReseal');
  const result = await connection.query<Omit<SecretRow, 'sealed_value'>>(
    `SELECT ${DESCRIBE_COLUMNS} FROM tenant_secrets
      WHERE tenant_id = app.current_tenant_id() AND key_id <> $1
      ORDER BY secret_class`,
    [sealer.activeKeyId],
  );
  return result.rows.map(describe);
}

/**
 * Re-seal one tenant's secrets under the active key.
 *
 * Unseals and re-seals in one transaction. Recorded as `replaced` rather than as
 * a read, because the value did not leave the platform — what changed is which
 * key protects it.
 */
export async function resealTenantSecrets(
  connection: Connection,
  sealer: SecretSealer,
  options: { readonly principal: string },
): Promise<readonly TenantSecretClass[]> {
  const tenantId = requireTenant(connection, 'resealTenantSecrets');
  const pending = await connection.query<SecretRow>(
    `SELECT secret_class, sealed_value, key_id, value_ref, created_at, rotated_at
       FROM tenant_secrets
      WHERE tenant_id = app.current_tenant_id() AND key_id <> $1
      ORDER BY secret_class
      FOR UPDATE`,
    [sealer.activeKeyId],
  );
  const resealed: TenantSecretClass[] = [];
  for (const row of pending.rows) {
    const plaintext = sealer.unsealToBuffer(row.sealed_value);
    await connection.query(
      `UPDATE tenant_secrets
          SET sealed_value = $1, key_id = $2, rotated_at = now()
        WHERE tenant_id = app.current_tenant_id() AND secret_class = $3`,
      [sealer.seal(plaintext), sealer.activeKeyId, row.secret_class],
    );
    await recordSecretAccess(connection, {
      principal: options.principal,
      secretClass: row.secret_class,
      action: 'replaced',
      subjectRef: row.value_ref,
      tenantId,
    });
    resealed.push(row.secret_class);
  }
  return resealed;
}

/** A tenant's own secret-access history (AC14), newest first. */
export async function tenantSecretAccessHistory(
  connection: Connection,
  options: { readonly limit?: number } = {},
): Promise<readonly (SecretAccessRecord & { readonly tenantId: string })[]> {
  const tenantId = requireTenant(connection, 'tenantSecretAccessHistory');
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const result = await connection.query<{
    occurred_at: Date;
    principal: string;
    secret_class: SecretClass;
    action: 'read' | 'created' | 'replaced' | 'deleted';
    subject_ref: string;
  }>(
    `SELECT occurred_at, principal, secret_class, action, subject_ref
       FROM secret_access_records
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY occurred_at DESC, id DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    at: row.occurred_at,
    principal: row.principal,
    secretClass: row.secret_class,
    action: row.action,
    subjectRef: row.subject_ref,
    tenantId,
  }));
}
