-- Identity and access: two separate principal spaces, and the record of what
-- each one did.
--
-- WHY CLIENTS AND OPERATORS ARE SEPARATE TABLES, NOT A ROLE COLUMN
-- `authentication-and-access.md` requires two identity spaces "that never
-- overlap", and specifically that no operator credential can authenticate as a
-- client and no client credential can reach operator surfaces. A shared table
-- with a `role` column expresses that as a value, which means one missing
-- `WHERE role = ...` merges the spaces. Separate tables express it as structure:
-- a query against `accounts` cannot return an operator, because operators are not
-- in it. The cost is a little duplication in the credential columns. The benefit
-- is that the strongest credential in the system — the one with visibility across
-- every tenant — cannot be reached by a bug in the client login path.

-- ---------------------------------------------------------------------------
-- accounts (client principals)
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email                  text        NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  -- Produced by `hashCredential` in @zeddev/secrets: a self-describing scrypt
  -- string carrying its own cost parameters. Never a reversible encoding —
  -- `credential-and-secret-handling.md` AC3 requires that possession of the
  -- stored form alone not permit authentication.
  credential_hash        text        NOT NULL,
  role                   text        NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  email_verified_at      timestamptz,
  -- `authentication-and-access.md` AC12 requires lockout after a defined number
  -- of consecutive failures. Counted on the account rather than in memory so the
  -- count survives a restart; an in-memory counter turns `component-independence.md`'s
  -- routine restarts into a way to reset an attacker's budget.
  failed_attempt_count   integer     NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
  locked_until           timestamptz,
  -- Bumped on every password change or reset. Sessions created before this
  -- instant are invalid, which satisfies AC10 without needing to find and delete
  -- every session row in the same transaction as the credential change.
  credentials_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive uniqueness across the whole platform.
--
-- `citext` would be tidier but requires an extension, and a managed cloud
-- provider may refuse to install one — that would make the platform unable to
-- run on a tier for reasons configuration cannot fix, which
-- `environment-portability.md` rules out. A functional index on `lower(email)`
-- needs nothing beyond core PostgreSQL.
--
-- Note this index is enforced *below* row-level security, so it holds across
-- tenants even though no single query can see across them. That is exactly what
-- `client-signup-and-tenancy.md` AC3 needs: a duplicate signup is rejected even
-- though the signing user can never see the account it collided with.
CREATE UNIQUE INDEX accounts_email_unique_idx ON accounts (lower(email));
CREATE INDEX accounts_tenant_idx ON accounts (tenant_id);

ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY accounts_own ON accounts
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY accounts_identity ON accounts
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());

-- Deliberately no platform policy. The operator has no business reading client
-- account rows: `tenant-data-isolation.md` grants visibility of connection health
-- and usage metrics, and nothing else.


-- ---------------------------------------------------------------------------
-- client_sessions
-- ---------------------------------------------------------------------------
-- `tenant_id` is stored on the session rather than joined from the account on
-- every request. That is not a denormalisation for speed — it is the record of
-- the binding `authentication-and-access.md` requires be "established by the
-- system from the authenticated identity itself, never accepted from a tenant
-- identifier supplied by the caller". The value written here at login is the only
-- thing later requests consult, so there is no code path where a caller-supplied
-- tenant could be substituted.
CREATE TABLE client_sessions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id          uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- The token itself is never stored. A session token is a bearer credential:
  -- storing it would make a database read equivalent to holding every live
  -- session, which is the disclosure `credential-and-secret-handling.md` AC4
  -- exists to prevent.
  token_hash          text        NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  -- Both limits are stored, because they answer different questions: the
  -- absolute expiry caps a session's total life regardless of use, while
  -- inactivity is measured from `last_active_at`. AC9 requires both.
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz
);

CREATE INDEX client_sessions_account_idx ON client_sessions (account_id);

ALTER TABLE client_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY client_sessions_own ON client_sessions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Resolving a bearer token to a session necessarily happens before the tenant is
-- known — that resolution is what determines it.
CREATE POLICY client_sessions_identity ON client_sessions
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());


-- ---------------------------------------------------------------------------
-- account_tokens (email verification and password reset)
-- ---------------------------------------------------------------------------
-- One table with a `purpose` column rather than two near-identical tables. Both
-- carry the same requirements from `authentication-and-access.md` AC11 —
-- single-use, time-limited, hashed — and splitting them would mean fixing any
-- future defect in that logic twice.
CREATE TABLE account_tokens (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  purpose     text        NOT NULL CHECK (purpose IN ('email_verification', 'password_reset')),
  token_hash  text        NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  -- Set on redemption rather than deleting the row. A deleted row cannot
  -- distinguish "this link was already used" from "this link never existed", and
  -- AC11 requires a reused link be rejected — which needs the record to persist
  -- long enough to say so.
  consumed_at timestamptz
);

CREATE INDEX account_tokens_account_purpose_idx ON account_tokens (account_id, purpose);

ALTER TABLE account_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_tokens FORCE ROW LEVEL SECURITY;

CREATE POLICY account_tokens_own ON account_tokens
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Redeeming a reset link is by definition unauthenticated, so it has no tenant
-- context; the token is what establishes one.
CREATE POLICY account_tokens_identity ON account_tokens
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());


-- ---------------------------------------------------------------------------
-- operators (platform principals)
-- ---------------------------------------------------------------------------
-- No `tenant_id`, and none is possible: the operator is scoped platform-wide.
-- The absence of the column is what makes "an operator credential cannot
-- authenticate as a client" structural — there is nothing for a tenant binding
-- to be derived from.
CREATE TABLE operators (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email                  text        NOT NULL CHECK (length(email) BETWEEN 3 AND 320),
  credential_hash        text        NOT NULL,
  failed_attempt_count   integer     NOT NULL DEFAULT 0 CHECK (failed_attempt_count >= 0),
  locked_until           timestamptz,
  credentials_changed_at timestamptz NOT NULL DEFAULT now(),
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX operators_email_unique_idx ON operators (lower(email));

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;

-- Reachable only while authenticating. There is no tenant policy, so a
-- transaction bound to a tenant sees this table as empty no matter what it asks
-- for — which is the database-level form of AC17's requirement that a client
-- session presented at an operator surface be rejected.
CREATE POLICY operators_identity ON operators
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());


CREATE TABLE operator_sessions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_id         uuid        NOT NULL REFERENCES operators (id) ON DELETE CASCADE,
  token_hash          text        NOT NULL UNIQUE,
  created_at          timestamptz NOT NULL DEFAULT now(),
  last_active_at      timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at timestamptz NOT NULL,
  revoked_at          timestamptz
);

ALTER TABLE operator_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY operator_sessions_identity ON operator_sessions
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());


-- ---------------------------------------------------------------------------
-- access_records
-- ---------------------------------------------------------------------------
-- The audit trail `authentication-and-access.md` AC20 requires: "who
-- authenticated, what identity resulted, what resource or surface was accessed or
-- denied, and when".
--
-- Note what the table cannot hold. AC21 requires these records exclude
-- conversation content, and there is no column that could carry it: `action` and
-- `resource` are identifiers, `reason` is a classification. The guarantee is made
-- by the schema, so it does not depend on every future writer of an audit record
-- remembering the rule — the same argument that puts redaction in the logger
-- rather than at each call site.
CREATE TABLE access_records (
  id             bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  principal_type text        NOT NULL
                             CHECK (principal_type IN ('client', 'operator', 'system', 'anonymous')),
  principal_id   uuid,
  -- No foreign key, for the same reason as `tenant_lifecycle_events`: the record
  -- of what was accessed must outlive the tenant whose deletion it attests to.
  tenant_id      uuid,
  action         text        NOT NULL CHECK (length(action) <= 120),
  resource       text        NOT NULL CHECK (length(resource) <= 200),
  outcome        text        NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  reason         text        CHECK (reason IS NULL OR length(reason) <= 200)
);

CREATE INDEX access_records_tenant_idx ON access_records (tenant_id, occurred_at DESC);
CREATE INDEX access_records_principal_idx ON access_records (principal_id, occurred_at DESC);
CREATE INDEX access_records_denied_idx
  ON access_records (occurred_at DESC)
  WHERE outcome = 'denied';

ALTER TABLE access_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE access_records FORCE ROW LEVEL SECURITY;

-- Any context may append. A denial has to be recordable precisely in the
-- situations where the caller has no valid context — an unattributable request,
-- a client session presented at an operator surface — and a policy that required
-- a context would drop exactly the records that matter most.
CREATE POLICY access_records_append ON access_records
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY access_records_platform_read ON access_records
  FOR SELECT
  USING (app.has_platform_scope());

CREATE POLICY access_records_own_read ON access_records
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

-- No UPDATE and no DELETE policy anywhere: an audit record that can be edited is
-- not an audit record.
