-- Which components are running, for the operator (`component-independence.md` AC9).
--
-- The API and the gateway answer HTTP probes, but the conversation worker and the
-- scheduler listen on no port, so nothing outside them can ask whether they are
-- alive. Without this table an operator whose customers stopped getting answers
-- would see a healthy API, healthy connections, and no sign that the one process
-- that writes replies had died. Each process now reports itself here on a timer, and
-- the operator's component view reads it back.
--
-- A row is one process: a random id chosen at startup, the component it is, and
-- when it was last heard from. A row per process, rather than per component, is
-- what lets the operator see how many instances of a scaled component are alive
-- (AC3), and what keeps two instances from overwriting each other's evidence.
--
-- Nothing in a row belongs to a tenant, and nothing in it can hold content: a
-- component name from a fixed list, a host name, timestamps, and an interval.


-- `app.heartbeat_scope` — the sixth scope, named after its reason as 0001 requires:
-- a process reporting that it is alive belongs to no tenant, and the only table it
-- needs is this one. Reusing the platform scope would have handed every background
-- service the operator's cross-tenant read access in order to write one row.
CREATE OR REPLACE FUNCTION app.has_heartbeat_scope() RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $fn$ SELECT COALESCE(current_setting('app.heartbeat_scope', true), '') = 'on' $fn$;


CREATE TABLE component_heartbeats (
  instance_id   uuid        PRIMARY KEY,
  -- The list `COMPONENTS` in `@zeddev/monitoring` mirrors; a test asserts the two agree.
  -- `web` is absent on purpose: it holds no database settings, and whether it is up
  -- is answered by whether the dashboard loads at all.
  component     text        NOT NULL CHECK (component IN ('api', 'whatsapp-gateway', 'conversation-worker', 'scheduler')),
  -- Which container or machine, so a dead replica can be told from a live one.
  host          text        NOT NULL CHECK (length(host) BETWEEN 1 AND 255),
  started_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  -- Each process states its own cadence, so "late" is judged against the promise
  -- that process made and not against a constant the reader would have to share.
  interval_ms   integer     NOT NULL CHECK (interval_ms BETWEEN 100 AND 3600000),
  -- Set by a clean shutdown. A process that stopped on purpose and one that
  -- vanished are different things to an operator, and only the second is a fault.
  stopped_at    timestamptz,
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);

-- The reader asks for the newest instances of each component; startup prunes by age.
CREATE INDEX component_heartbeats_seen_idx ON component_heartbeats (component, last_seen_at DESC);

ALTER TABLE component_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE component_heartbeats FORCE ROW LEVEL SECURITY;

-- A reporting process writes its own row and prunes long-dead ones.
CREATE POLICY component_heartbeats_report ON component_heartbeats
  USING (app.has_heartbeat_scope())
  WITH CHECK (app.has_heartbeat_scope());

-- The operator only reads.
CREATE POLICY component_heartbeats_platform_read ON component_heartbeats
  FOR SELECT USING (app.has_platform_scope());
