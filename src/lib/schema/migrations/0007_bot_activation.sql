-- Readiness and the activation toggle — `bot-activation-control.md`.
--
-- WHY THE RULE LIVES IN THE DATABASE
-- The spec's hardest requirement is not "reject go-live when not ready"; that is
-- one check on one request. It is "turn an active bot off if readiness is later
-- lost", which has to hold on *every* path that can change a readiness input:
-- the client clearing configuration, the WhatsApp gateway observing a revoked
-- authorization, the scheduler giving up on reconnection, offboarding. Written
-- in application code, that is a call every one of those paths must remember to
-- make, and the failure mode of forgetting is a bot that keeps answering
-- customers through a connection the platform knows is broken.
--
-- So the rule is enforced here, in three layers:
--   1. `CHECK (NOT active OR ready)` on `bot_activation` — an active bot that is
--      not ready is a row the database refuses to hold.
--   2. Triggers on each readiness input re-evaluate readiness in the same
--      transaction as the change, and switch the bot off if it was lost. No
--      caller can change an input without the re-evaluation happening.
--   3. A trigger on `bot_activation` appends every on/off change to
--      `bot_activation_events`, so no path can flip the toggle unrecorded (AC13).
--
-- WHY READINESS IS STORED, NOT ONLY COMPUTED
-- AC12 lets the operator *view* readiness, but readiness is derived partly from
-- `bot_personas`, which carries no platform-scope policy on purpose — its
-- freeform text is client-authored instruction content. The stored `ready` and
-- `unmet_conditions` are the derived facts the operator may see, and they cannot
-- go stale because (2) rewrites them in every transaction that changes an input.
--
-- WHAT "CONNECTED" MEANS FOR READINESS
-- `connected` or `reconnecting`. A reconnecting number is being restored
-- automatically, and dropping readiness there would turn a momentary network
-- blip into a bot that stays paused until the client notices — the spec forbids
-- re-activating without a client action. `error`, `disconnected`, and
-- `connecting` do not count. The decision and its reasoning are recorded in both
-- specs and in IMPLEMENTATION_PLAN.md.

-- ---------------------------------------------------------------------------
-- bot_activation
-- ---------------------------------------------------------------------------
-- One row per tenant. A tenant with no row has never had a readiness input
-- change since this migration (the backfill below covers tenants that existed
-- before it), so it has neither a persona nor a connection: not ready, off,
-- every condition unmet.

CREATE TABLE bot_activation (
  tenant_id          uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- The client's toggle. Never set true by anything but the client (the spec's
  -- "activation always requires an explicit client action").
  active             boolean     NOT NULL DEFAULT false,
  ready              boolean     NOT NULL DEFAULT false,
  -- Mirrors READINESS_CONDITIONS in @zeddev/bot; a test asserts they agree.
  unmet_conditions   text[]      NOT NULL DEFAULT ARRAY['whatsapp_connection', 'persona']
                                 CHECK (unmet_conditions <@ ARRAY['whatsapp_connection', 'persona']),
  -- AC16's "record when a client's bot first becomes ready". Set once, never
  -- cleared: losing readiness later does not change when it first happened.
  first_ready_at     timestamptz,
  -- Why `active` last changed. Copied into the event log by the trigger below,
  -- so the history says whether the client paused the bot or readiness did.
  change_cause       text        CHECK (change_cause IN ('client', 'readiness_lost')),
  active_changed_at  timestamptz,
  evaluated_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (ready = (cardinality(unmet_conditions) = 0)),
  CHECK (NOT active OR ready),
  CHECK (NOT ready OR first_ready_at IS NOT NULL)
);

ALTER TABLE bot_activation ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_activation FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_activation_own ON bot_activation
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- SELECT only. AC12: the operator can view readiness and activation "but has no
-- control to change the client's activation state". Omitting the write half is
-- what makes that an access-control rule rather than a missing button.
CREATE POLICY bot_activation_platform_read ON bot_activation
  FOR SELECT
  USING (app.has_platform_scope());


-- ---------------------------------------------------------------------------
-- bot_activation_events
-- ---------------------------------------------------------------------------
-- AC13: every on/off change and when it happened. Append-only for every caller.

CREATE TABLE bot_activation_events (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id    uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  active       boolean     NOT NULL,
  cause        text        NOT NULL CHECK (cause IN ('client', 'readiness_lost')),
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bot_activation_events_tenant_idx ON bot_activation_events (tenant_id, id DESC);

ALTER TABLE bot_activation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_activation_events FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_activation_events_own_read ON bot_activation_events
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY bot_activation_events_own_insert ON bot_activation_events
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY bot_activation_events_platform_read ON bot_activation_events
  FOR SELECT
  USING (app.has_platform_scope());

CREATE OR REPLACE FUNCTION app.record_bot_activation_change() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.active IS DISTINCT FROM OLD.active THEN
    IF NEW.change_cause IS NULL THEN
      RAISE EXCEPTION 'bot_activation.active changed without a cause'
        USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO bot_activation_events (tenant_id, active, cause, occurred_at)
    VALUES (NEW.tenant_id, NEW.active, NEW.change_cause, COALESCE(NEW.active_changed_at, now()));
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER bot_activation_record_change
  AFTER UPDATE OF active ON bot_activation
  FOR EACH ROW EXECUTE FUNCTION app.record_bot_activation_change();


-- ---------------------------------------------------------------------------
-- Readiness evaluation
-- ---------------------------------------------------------------------------

-- The single definition of readiness: the conditions that are *not* met for a
-- tenant, in a fixed order. Every other reading of readiness is derived from this.
CREATE OR REPLACE FUNCTION app.bot_readiness_unmet(p_tenant uuid) RETURNS text[]
  LANGUAGE sql STABLE AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN EXISTS (SELECT 1 FROM whatsapp_connections c
                       WHERE c.tenant_id = p_tenant AND c.state IN ('connected', 'reconnecting'))
         THEN NULL ELSE 'whatsapp_connection' END,
    CASE WHEN EXISTS (SELECT 1 FROM bot_personas p WHERE p.tenant_id = p_tenant)
         THEN NULL ELSE 'persona' END
  ], NULL)
$$;

-- Re-evaluate one tenant's readiness, switching the bot off if it was lost.
--
-- Takes the row lock *before* reading the inputs, and is VOLATILE so each
-- statement sees a fresh snapshot. That ordering is what makes the toggle and a
-- concurrent readiness loss serialise correctly under READ COMMITTED: whichever
-- commits second re-reads the inputs after the first has committed, so the bot
-- cannot end up active against a connection that has already failed.
--
-- Runs as the invoker, not as a definer: row-level security applies, so it can
-- only ever evaluate the tenant the calling transaction is bound to.
CREATE OR REPLACE FUNCTION app.reevaluate_bot_readiness(p_tenant uuid) RETURNS void
  LANGUAGE plpgsql VOLATILE AS $fn$
DECLARE
  unmet text[];
BEGIN
  -- The tenant row is gone when this runs from a cascade during tenant
  -- deletion; there is nothing left to evaluate, and inserting would fail the
  -- foreign key.
  IF NOT EXISTS (SELECT 1 FROM tenants WHERE id = p_tenant) THEN
    RETURN;
  END IF;

  INSERT INTO bot_activation (tenant_id) VALUES (p_tenant) ON CONFLICT (tenant_id) DO NOTHING;
  PERFORM 1 FROM bot_activation WHERE tenant_id = p_tenant FOR UPDATE;

  unmet := app.bot_readiness_unmet(p_tenant);

  UPDATE bot_activation
     SET ready             = cardinality(unmet) = 0,
         unmet_conditions  = unmet,
         first_ready_at    = CASE WHEN cardinality(unmet) = 0 THEN COALESCE(first_ready_at, now())
                                  ELSE first_ready_at END,
         change_cause      = CASE WHEN active AND cardinality(unmet) > 0 THEN 'readiness_lost'
                                  ELSE change_cause END,
         active_changed_at = CASE WHEN active AND cardinality(unmet) > 0 THEN now()
                                  ELSE active_changed_at END,
         -- Never true unless it already was: readiness returning does not turn the
         -- bot back on (AC9). Only the client does that.
         active            = active AND cardinality(unmet) = 0,
         evaluated_at      = now()
   WHERE tenant_id = p_tenant;
END $fn$;

CREATE OR REPLACE FUNCTION app.reevaluate_bot_readiness_trigger() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM app.reevaluate_bot_readiness(CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END);
  RETURN NULL;
END $fn$;

-- Every readiness input. A new readiness condition means a new clause in
-- `app.bot_readiness_unmet` and a new trigger here.
CREATE TRIGGER whatsapp_connections_reevaluate_readiness
  AFTER INSERT OR UPDATE OF state OR DELETE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION app.reevaluate_bot_readiness_trigger();

-- Persona completeness is row existence (migration 0005), so only INSERT and
-- DELETE can change it.
CREATE TRIGGER bot_personas_reevaluate_readiness
  AFTER INSERT OR DELETE ON bot_personas
  FOR EACH ROW EXECUTE FUNCTION app.reevaluate_bot_readiness_trigger();


-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------
-- Tenants that existed before this migration may already have a persona. Row-
-- level security applies to the migration's own role too, so the loop binds each
-- tenant in turn exactly as the application would — the same policies, not a
-- bypass. The platform scope is used only to enumerate tenant ids.
DO $$
DECLARE
  t uuid;
BEGIN
  PERFORM set_config('app.platform_scope', 'on', true);
  FOR t IN SELECT id FROM tenants LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    PERFORM app.reevaluate_bot_readiness(t);
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
  PERFORM set_config('app.platform_scope', '', true);
END $$;
