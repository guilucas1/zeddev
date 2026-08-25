-- Per-tenant secrets, and the record of every time one is touched.
--
-- `credential-and-secret-handling.md` splits secrets in two: those the platform
-- only ever *checks* (account passwords, hashed one-way, stored in `accounts` and
-- `operators`), and those it must *use* (a tenant's WhatsApp access token, the
-- webhook signing secret), which cannot be irreversibly transformed. This table
-- is for the second kind, and AC4 states the requirement precisely: "when the
-- underlying stored data is read without the system's protection mechanism, then
-- the value obtained is insufficient to use that credential."
--
-- So `sealed_value` holds the output of `SecretSealer.seal` — AES-256-GCM under a
-- key supplied as configuration and never stored in the database. A dump of this
-- table is therefore useless on its own, which is the whole point: the database
-- is the thing most likely to be copied to a backup, an analytics replica, or a
-- developer's laptop, and the sealing key is not in any of those places.

CREATE TABLE tenant_secrets (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Mirrors SECRET_CLASSES in @zeddev/secrets. Constrained rather than free text
  -- so that the secret-access record can name a class without the class name
  -- itself drifting into holding the secret's identity.
  secret_class text        NOT NULL
                           CHECK (secret_class IN ('tenant_whatsapp_credential',
                                                   'webhook_signing_secret')),
  sealed_value text        NOT NULL,
  -- The sealing key that produced `sealed_value`, denormalised out of the sealed
  -- string. It makes "which rows still use the retired key?" answerable with an
  -- index scan instead of by unsealing every row — which would require the key
  -- and defeat the exercise.
  key_id       text        NOT NULL,
  -- A non-reversible digest of the value, for support. AC5 permits identifying a
  -- secret "by a non-sensitive reference or a redacted form"; this lets an
  -- operator confirm that the token a tenant configured is the same one that is
  -- failing, without either of them seeing it.
  value_ref    text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  rotated_at   timestamptz,
  UNIQUE (tenant_id, secret_class)
);

CREATE INDEX tenant_secrets_key_id_idx ON tenant_secrets (key_id);

ALTER TABLE tenant_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_secrets FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_secrets_own ON tenant_secrets
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy, and no identity policy either. This is the enforcement of
-- AC13 — "the operator attempts to view a tenant's WhatsApp credential value,
-- then no such value is displayed or retrievable" — and of AC7, that tenant A's
-- credential cannot be read from tenant B's context. An operator surface running
-- under the platform scope sees this table as empty, so the guarantee does not
-- depend on the operator dashboard never growing a query against it.


-- ---------------------------------------------------------------------------
-- secret_access_records
-- ---------------------------------------------------------------------------
-- AC14: "Given a secret is accessed or changed, when that event is later
-- reviewed, then a record exists identifying who performed it, what secret class
-- was involved, and when it occurred, and that record contains no secret value."
--
-- As with `access_records`, the second half is guaranteed by the absence of any
-- column that could hold a value. `subject_ref` holds a non-sensitive reference —
-- a tenant id, or the digest form — never the secret.
CREATE TABLE secret_access_records (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  principal    text        NOT NULL CHECK (length(principal) <= 200),
  secret_class text        NOT NULL
                           CHECK (secret_class IN ('tenant_whatsapp_credential',
                                                   'client_account_credential',
                                                   'operator_account_credential',
                                                   'ai_provider_credential',
                                                   'infrastructure_credential',
                                                   'webhook_signing_secret')),
  action       text        NOT NULL CHECK (action IN ('read', 'created', 'replaced', 'deleted')),
  subject_ref  text        NOT NULL CHECK (length(subject_ref) <= 200),
  -- Unconstrained by a foreign key so the record of a secret's destruction
  -- survives the tenant's deletion.
  tenant_id    uuid
);

CREATE INDEX secret_access_records_tenant_idx ON secret_access_records (tenant_id, occurred_at DESC);

ALTER TABLE secret_access_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE secret_access_records FORCE ROW LEVEL SECURITY;

CREATE POLICY secret_access_records_append ON secret_access_records
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY secret_access_records_platform_read ON secret_access_records
  FOR SELECT
  USING (app.has_platform_scope());

CREATE POLICY secret_access_records_own_read ON secret_access_records
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());
