-- Platform foundations: the tenant registry and the security-context functions
-- every row-level-security policy in this schema is written against.
--
-- WHY THE `app` SCHEMA EXISTS
-- The three functions below are the entire vocabulary a policy may use to decide
-- whether a row is visible. Keeping them in one schema, defined once, means the
-- question "under what circumstances can this table be read?" is answered by
-- reading the policy, not by reconstructing what some `current_setting` call
-- somewhere meant. A policy that inlined `current_setting('app.tenant_id', true)`
-- would work identically and would drift the first time one table spelled the
-- setting differently.
--
-- WHY EACH SCOPE IS NAMED AFTER A REASON, NOT A PRIVILEGE LEVEL
-- There is no "admin" or "superuser" scope, because a scope named after a level
-- accumulates unrelated permissions over time. Each of these names a specific
-- situation in which the tenant filter provably cannot apply:
--
--   * `app.tenant_id` — normal operation. Everything a client's own request
--     touches is filtered to their tenant.
--   * `app.identity_scope` — authentication, before a tenant is known. Logging in
--     requires finding an account by email across all tenants, because the tenant
--     is *derived from* the account. `authentication-and-access.md` requires the
--     tenant binding be established "from the authenticated identity itself,
--     never accepted from a tenant identifier supplied by the caller", which
--     makes this lookup unavoidable — the alternative is trusting the caller to
--     say which tenant they belong to.
--   * `app.platform_scope` — the operator's cross-tenant health and usage view,
--     which `tenant-data-isolation.md` AC7 explicitly permits.
--
-- The tables reachable under each scope are fixed here, in migrations. That is
-- what makes the negative half of AC7 structural: no table holding conversation
-- content will ever carry a platform-scope policy, so no setting an operator
-- surface could set would reveal it.

CREATE SCHEMA IF NOT EXISTS app;
GRANT USAGE ON SCHEMA app TO PUBLIC;

-- `NULLIF` before the cast is load-bearing. `current_setting(..., true)` returns
-- NULL for a setting that was never assigned, but an empty string for one
-- assigned an empty value, and `''::uuid` raises rather than yielding NULL. That
-- error would surface as a failure of whatever query ran next, attributed to the
-- wrong caller.
CREATE OR REPLACE FUNCTION app.current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app.has_identity_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(current_setting('app.identity_scope', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION app.has_platform_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT COALESCE(current_setting('app.platform_scope', true), '') = 'on' $$;


-- ---------------------------------------------------------------------------
-- tenants
-- ---------------------------------------------------------------------------
-- The root of every isolation boundary. `client-signup-and-tenancy.md` requires
-- that provisioning "complete (or visibly fail) within a bounded, predictable
-- time, without leaving the account in an indeterminate state" (AC7), which is
-- why `provisioning_state` is an explicit column rather than something inferred
-- from whether related rows exist. "Inferred readiness" has no way to express
-- *failed*, so a half-provisioned tenant would be indistinguishable from one
-- still in progress.
--
-- The lifecycle columns are kept on the tenant row rather than derived from the
-- event log because they are read on every request (is this tenant still active?)
-- and the event log is read almost never. The log remains the audit record.
CREATE TABLE tenants (
  id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name          text        NOT NULL
                                     CHECK (length(btrim(business_name)) BETWEEN 1 AND 200),
  provisioning_state     text        NOT NULL DEFAULT 'provisioning'
                                     CHECK (provisioning_state IN ('provisioning', 'ready', 'failed')),
  -- `active` / `offboarded` / `permanently_deleted` are the states
  -- `client-offboarding-and-data-retention.md` names. Reactivation during the
  -- retention window returns a tenant to `active`; it is a transition, not a
  -- fourth state.
  lifecycle_state        text        NOT NULL DEFAULT 'active'
                                     CHECK (lifecycle_state IN ('active', 'offboarded', 'permanently_deleted')),
  created_at             timestamptz NOT NULL DEFAULT now(),
  provisioned_at         timestamptz,
  offboarded_at          timestamptz,
  retention_expires_at   timestamptz,
  deletion_requested_at  timestamptz,
  permanently_deleted_at timestamptz
);

-- Supports the scheduler's "which retention windows have expired?" sweep without
-- scanning every tenant. Partial, because only offboarded tenants have a window,
-- and on a platform whose cost model assumes low volume an index over rows that
-- can never match is pure overhead.
CREATE INDEX tenants_retention_due_idx
  ON tenants (retention_expires_at)
  WHERE lifecycle_state = 'offboarded';

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
-- FORCE is not optional here. Without it, the role that owns the table — which,
-- in a single-role deployment, is the role the application connects as — bypasses
-- every policy silently. The isolation tests would pass by not being enforced.
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;

CREATE POLICY tenants_own ON tenants
  USING (id = app.current_tenant_id())
  WITH CHECK (id = app.current_tenant_id());

-- Signup creates the tenant before any tenant context can exist, and login reads
-- it to derive the binding. Both run under the identity scope.
CREATE POLICY tenants_identity ON tenants
  USING (app.has_identity_scope())
  WITH CHECK (app.has_identity_scope());

-- SELECT only. `bot-activation-control.md` requires the operator have no ability
-- to change a client's activation state, and `tenant-data-isolation.md` gives the
-- operator visibility, never authority. Omitting the write half is how that is
-- enforced rather than merely intended.
CREATE POLICY tenants_platform_read ON tenants
  FOR SELECT
  USING (app.has_platform_scope());


-- ---------------------------------------------------------------------------
-- tenant_lifecycle_events
-- ---------------------------------------------------------------------------
-- Append-only record of every lifecycle transition.
--
-- `tenant_id` deliberately carries NO foreign key. `client-offboarding-and-data-
-- retention.md` requires the system record "when permanent deletion actually
-- occurred" — and a cascading foreign key would delete that record as part of the
-- deletion it exists to attest to. The row that survives holds an opaque
-- identifier and a timestamp: enough to prove the deletion happened, and nothing
-- that would make the tenant's data recoverable, which the same spec requires.
CREATE TABLE tenant_lifecycle_events (
  id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   uuid        NOT NULL,
  event       text        NOT NULL
                          CHECK (event IN ('provisioned', 'provisioning_failed', 'offboarded',
                                           'reactivated', 'deletion_requested', 'permanently_deleted')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX tenant_lifecycle_events_tenant_idx
  ON tenant_lifecycle_events (tenant_id, occurred_at DESC);

ALTER TABLE tenant_lifecycle_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_lifecycle_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_lifecycle_events_own ON tenant_lifecycle_events
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_lifecycle_events_platform_read ON tenant_lifecycle_events
  FOR SELECT
  USING (app.has_platform_scope());

-- Insertable from any context, because a lifecycle transition can be recorded by
-- the signup path (no tenant bound yet), by the client's own request, and by the
-- scheduler sweeping expired retention windows. There is no UPDATE or DELETE
-- policy at all, which makes the table append-only for every caller including
-- the one that wrote the row.
CREATE POLICY tenant_lifecycle_events_append ON tenant_lifecycle_events
  FOR INSERT
  WITH CHECK (true);
