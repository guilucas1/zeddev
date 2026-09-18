-- The WhatsApp connection's health state, one row per tenant, plus its history.
--
-- `whatsapp-number-connection.md` fixes a five-word vocabulary that other specs
-- key off: readiness (`bot-activation-control.md`), operator monitoring, and
-- alerting all ask "what state is this tenant's number in?". This migration is
-- that state and nothing else. How a number is authorized with Meta and verified
-- able to send and receive is the WhatsApp gateway's job; the table records the
-- outcome, so every consumer reads one answer.
--
-- One row per tenant because v1 allows exactly one number per tenant. The
-- tenant id is the key, so "a second concurrent number" is not a state this
-- table can hold.
--
-- A tenant with no row is `disconnected` — the vocabulary's "no connection has
-- ever been established". The row is created on the first transition rather
-- than at provisioning, for the same reason `bot_personas` has no default row:
-- a row saying "disconnected" carries no information its absence does not.

CREATE TABLE whatsapp_connections (
  tenant_id           uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Mirrors CONNECTION_STATES in @zeddev/whatsapp; a test asserts they agree.
  state               text        NOT NULL
                                  CHECK (state IN ('connecting', 'connected', 'reconnecting', 'error', 'disconnected')),
  -- The spec requires `error` "must carry a reason", and a reason on any other
  -- state would be stale — describing a failure the connection has recovered
  -- from. The paired CHECK makes both of those unrepresentable.
  -- Mirrors CONNECTION_ERROR_REASONS in @zeddev/whatsapp.
  error_reason        text        CHECK (error_reason IN ('authorization_revoked', 'number_disconnected',
                                                          'rate_limited', 'configuration_invalid',
                                                          'business_verification_required',
                                                          'verification_failed', 'recovery_exhausted')),
  CHECK ((state = 'error') = (error_reason IS NOT NULL)),
  -- The "last-known-good timestamp" the client must be able to see: the last
  -- moment this number was known to be `connected`. Stamped on entering and on
  -- leaving `connected`, so while connected it is when the link was confirmed,
  -- and afterwards it is when it stopped being good.
  last_known_good_at  timestamptz,
  changed_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_connections_own ON whatsapp_connections
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Connection health is exactly what `tenant-data-isolation.md` AC7 lets the
-- operator see across tenants. SELECT only: the operator observes a connection,
-- it never changes one.
CREATE POLICY whatsapp_connections_platform_read ON whatsapp_connections
  FOR SELECT
  USING (app.has_platform_scope());


-- ---------------------------------------------------------------------------
-- whatsapp_connection_transitions
-- ---------------------------------------------------------------------------
-- "When did this change and to what" — AC10. Written by a trigger on
-- `whatsapp_connections`, not by the library, so there is no code path that
-- changes the state without recording it: a future caller that updates the row
-- directly is recorded exactly like the library is.

CREATE TABLE whatsapp_connection_transitions (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  from_state    text        NOT NULL,
  to_state      text        NOT NULL,
  error_reason  text,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_connection_transitions_tenant_idx
  ON whatsapp_connection_transitions (tenant_id, id DESC);

ALTER TABLE whatsapp_connection_transitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connection_transitions FORCE ROW LEVEL SECURITY;

-- Readable and appendable by the owning tenant; no UPDATE or DELETE policy, so
-- history cannot be rewritten by any caller. (Rows go with the tenant on
-- deletion through the foreign key, which is what offboarding requires.)
CREATE POLICY whatsapp_connection_transitions_own_read ON whatsapp_connection_transitions
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY whatsapp_connection_transitions_own_insert ON whatsapp_connection_transitions
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Transition history is what `operator-health-monitoring.md` shows per tenant.
CREATE POLICY whatsapp_connection_transitions_platform_read ON whatsapp_connection_transitions
  FOR SELECT
  USING (app.has_platform_scope());

CREATE OR REPLACE FUNCTION app.record_whatsapp_connection_transition() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT'
     OR NEW.state IS DISTINCT FROM OLD.state
     OR NEW.error_reason IS DISTINCT FROM OLD.error_reason THEN
    INSERT INTO whatsapp_connection_transitions (tenant_id, from_state, to_state, error_reason, occurred_at)
    VALUES (NEW.tenant_id,
            CASE WHEN TG_OP = 'INSERT' THEN 'disconnected' ELSE OLD.state END,
            NEW.state,
            NEW.error_reason,
            NEW.changed_at);
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER whatsapp_connections_record_transition
  AFTER INSERT OR UPDATE OF state, error_reason ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION app.record_whatsapp_connection_transition();
