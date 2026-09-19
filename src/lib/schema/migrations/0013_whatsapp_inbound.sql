-- Inbound WhatsApp messages: attribution, duplicate suppression, and rejection
-- records — `message-delivery-reliability.md`.
--
-- Three tables and one new scope.
--
--   * `whatsapp_number_routes` says which tenant a receiving number belongs to.
--     It is the only thing the gateway reads before it knows the tenant.
--   * `inbound_messages` is every accepted inbound message, stored once. Its
--     unique key is the duplicate suppression AC4 requires: a redelivery
--     inserts nothing, so it enqueues nothing, so it is never replied to. It is
--     the message itself rather than a separate "seen" list, so the suppression
--     record lives exactly as long as the message it suppresses — there is no
--     second retention window to get wrong (IMPLEMENTATION_PLAN.md §4d noted the
--     queue's own dedupe key cannot do this, because queue rows are purged).
--   * `inbound_rejections` records a notification that was refused — failed
--     authenticity, unattributable, malformed — with operational fields only.
--
-- `app.inbound_scope` — the fifth scope, and it exists for the same ordering
-- constraint as the identity and dispatch scopes. A notification names the
-- receiving number, not the tenant; the tenant is derived *from* the number, so
-- the lookup necessarily happens before any tenant can be bound. What limits the
-- scope is its reach: it can read the number→tenant routes and append a
-- rejection record, and nothing else. It cannot read a single message.

CREATE OR REPLACE FUNCTION app.has_inbound_scope() RETURNS boolean
  LANGUAGE sql STABLE
  AS $fn$ SELECT COALESCE(current_setting('app.inbound_scope', true), '') = 'on' $fn$;


-- ---------------------------------------------------------------------------
-- whatsapp_number_routes
-- ---------------------------------------------------------------------------
-- Meta identifies the receiving number by its `phone_number_id`, so that is the
-- key. Both columns are unique: one number routes to one tenant (AC3's "exactly
-- one tenant"), and one tenant has one number (v1's single-number rule, and
-- `whatsapp-number-connection.md`'s "never two numbers simultaneously active").
--
-- A route exists only while the tenant's connection is not `disconnected`. The
-- trigger at the bottom removes it on every move to `disconnected`, whoever makes
-- that move — the client's manual disconnect, offboarding, or a future path that
-- does not exist yet. So a message to an offboarded tenant's former number is
-- unattributable and refused (AC13), without offboarding having to remember.

CREATE TABLE whatsapp_number_routes (
  phone_number_id  text        PRIMARY KEY
                               CHECK (phone_number_id ~ '^[0-9]{1,32}$'),
  tenant_id        uuid        NOT NULL UNIQUE REFERENCES tenants (id) ON DELETE CASCADE,
  assigned_at      timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE whatsapp_number_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_number_routes FORCE ROW LEVEL SECURITY;

CREATE POLICY whatsapp_number_routes_own ON whatsapp_number_routes
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- Read-only. Attribution observes a route; only the owning tenant's connection
-- flow creates or removes one.
CREATE POLICY whatsapp_number_routes_inbound_read ON whatsapp_number_routes
  FOR SELECT
  USING (app.has_inbound_scope());

CREATE OR REPLACE FUNCTION app.release_whatsapp_number_route() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state = 'disconnected' THEN
    DELETE FROM whatsapp_number_routes WHERE tenant_id = NEW.tenant_id;
  END IF;
  RETURN NULL;
END $fn$;

CREATE TRIGGER whatsapp_connections_release_route
  AFTER INSERT OR UPDATE OF state ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION app.release_whatsapp_number_route();


-- ---------------------------------------------------------------------------
-- inbound_messages
-- ---------------------------------------------------------------------------
-- Tenant-private: no platform, dispatch, or inbound policy, because this is
-- end-customer content (`tenant-data-isolation.md` AC7).
--
-- `sent_at` is the end-customer's send time as the upstream reports it, and is
-- what the conversation is ordered by (AC5) — not `received_at`, and not
-- `position`, both of which are arrival order. `position` breaks ties within one
-- second, the upstream timestamp's resolution; within a second there is no
-- signal left to order by.
--
-- `content` is the normalised message: `{text}` for text, `{mediaId, mimeType,
-- caption?}` for an image, `{mediaId, mimeType, voice}` for audio, `{}` for a
-- type the platform does not understand (whose upstream name is kept in
-- `upstream_type`, so the reply path can answer it rather than drop it). A media
-- id is an upstream reference that expires; fetching it is the worker's job.

CREATE TABLE inbound_messages (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  position         bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  external_id      text        NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
  phone_number_id  text        NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,32}$'),
  customer_id      text        NOT NULL CHECK (customer_id ~ '^[0-9]{1,32}$'),
  -- Mirrors INBOUND_MESSAGE_TYPES in @zeddev/whatsapp; a test asserts they agree.
  message_type     text        NOT NULL CHECK (message_type IN ('text', 'image', 'audio', 'unsupported')),
  upstream_type    text        NOT NULL CHECK (upstream_type ~ '^[a-z_]{1,40}$'),
  content          jsonb       NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  sent_at          timestamptz NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_id)
);

CREATE INDEX inbound_messages_customer_idx
  ON inbound_messages (tenant_id, customer_id, sent_at, position);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_messages FORCE ROW LEVEL SECURITY;

-- Read and append only. A stored message is not edited and not deleted by the
-- application; it goes with the tenant through the foreign key, which is what
-- offboarding's deletion requires.
CREATE POLICY inbound_messages_own_read ON inbound_messages
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY inbound_messages_own_insert ON inbound_messages
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- inbound_rejections
-- ---------------------------------------------------------------------------
-- Not tenant-scoped: an unattributable or unauthentic notification has no tenant
-- by definition. Operational fields only (AC17): a reason, the receiving number's
-- upstream id when one could be trusted, how many messages the refused part
-- carried, and when. Never the body, never the sender.

CREATE TABLE inbound_rejections (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- Mirrors INBOUND_REJECTION_REASONS in @zeddev/whatsapp.
  reason           text        NOT NULL CHECK (reason IN ('signature_missing', 'signature_invalid',
                                                          'malformed', 'unattributable')),
  phone_number_id  text        CHECK (phone_number_id ~ '^[0-9]{1,32}$'),
  message_count    integer     NOT NULL DEFAULT 0 CHECK (message_count >= 0),
  received_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX inbound_rejections_received_idx ON inbound_rejections (received_at DESC);

ALTER TABLE inbound_rejections ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_rejections FORCE ROW LEVEL SECURITY;

-- The gateway appends; it has no reason to read the log back.
CREATE POLICY inbound_rejections_inbound_insert ON inbound_rejections
  FOR INSERT
  WITH CHECK (app.has_inbound_scope());

-- Delivery diagnostics are what `operator-health-monitoring.md` shows.
CREATE POLICY inbound_rejections_platform_read ON inbound_rejections
  FOR SELECT
  USING (app.has_platform_scope());
