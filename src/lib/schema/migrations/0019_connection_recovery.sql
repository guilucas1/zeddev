-- Bounding automatic reconnection.
--
-- `whatsapp-number-connection.md` AC6 says recovery attempts are *exhausted*
-- before a `reconnecting` connection falls to `error`. Until now nothing counted
-- them: a send failure moved a connection to `reconnecting` and only a later
-- successful send moved it back, so a tenant with no traffic stayed there
-- indefinitely.
--
-- The count lives on the connection rather than in the scheduler's memory because
-- "exhausted" must survive the scheduler restarting, and because the scheduler may
-- run as several instances that have to agree on it.
--
-- There is deliberately no CHECK tying these columns to the state. A NULL
-- `recovery_next_at` means "due now", so a connection entering `reconnecting` needs
-- nothing written for its first probe to be picked up, and a row already in that
-- state when this migration runs is simply due at the first sweep. That avoids a
-- backfill, which row-level security would make a per-tenant DO block.

ALTER TABLE whatsapp_connections
  -- Probes that Meta (or the path to Meta) answered with a recoverable failure.
  -- An attempt is counted when it is settled, not when it is claimed, so a process
  -- that dies mid-probe or a defect in this platform spends none of a client's
  -- allowance.
  ADD COLUMN recovery_attempts integer NOT NULL DEFAULT 0 CHECK (recovery_attempts >= 0),
  -- When the next probe may run. Advancing it is also how a probe is claimed, so
  -- two scheduler instances cannot probe one tenant at the same time.
  ADD COLUMN recovery_next_at  timestamptz;


-- ---------------------------------------------------------------------------
-- Each stay in `reconnecting` gets its own allowance
-- ---------------------------------------------------------------------------
-- In a trigger, so every path out of the state is covered: a send that succeeds,
-- a client who disconnects, a probe that settles. If resetting were left to each
-- of them, the one that forgot would hand an interruption next month whatever
-- remained of this month's allowance.

CREATE FUNCTION app.reset_whatsapp_connection_recovery() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    NEW.recovery_attempts := 0;
    NEW.recovery_next_at  := NULL;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER whatsapp_connections_reset_recovery
  BEFORE UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION app.reset_whatsapp_connection_recovery();


-- ---------------------------------------------------------------------------
-- Finding what is due
-- ---------------------------------------------------------------------------
-- Partial, because this is asked once a minute forever and almost no connection
-- is ever in this state. An idle deployment should answer it without reading the
-- table. Read under the platform scope, whose existing policy on this table
-- already permits exactly this: connection health, across tenants, read-only. The
-- writes happen tenant-bound, so no new scope or policy is needed.

CREATE INDEX whatsapp_connections_recovery_due_idx
  ON whatsapp_connections (recovery_next_at NULLS FIRST)
  WHERE state = 'reconnecting';
