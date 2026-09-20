-- Connecting a number: which number, and the proof that it works.
--
-- Migration 0006 recorded the connection's *state* and deliberately left how a
-- number gets into that state to the gateway. This migration is that: the number
-- a connection is for, and the send-and-receive round trip that earns
-- `connecting → connected`.
--
-- `whatsapp-number-connection.md` is emphatic on the point this migration exists
-- to enforce: "must not allow a tenant to be marked 'connected' based solely on
-- the client submitting credentials/configuration — connection status must
-- reflect a verified, working link, not just submitted intent." A boolean column
-- would not have made that true. A recorded, expiring, single-use round trip does.


-- ---------------------------------------------------------------------------
-- The number a connection is for
-- ---------------------------------------------------------------------------
-- `phone_number_id` is deliberately NOT duplicated here: it already lives in
-- `whatsapp_number_routes`, whose UNIQUE (tenant_id) is what makes "two numbers
-- simultaneously active for one tenant" unrepresentable (AC12). A second copy
-- would be a second answer to "which number is this tenant's", and the two would
-- eventually disagree.
--
-- What is here is what that table does not carry and the client's own status
-- screen needs: the business account the number belongs to (needed to reach Meta
-- on every subsequent call), and the display number and name as Meta renders
-- them, so the client can confirm they connected the number they meant to.
ALTER TABLE whatsapp_connections
  ADD COLUMN business_account_id text CHECK (business_account_id ~ '^[0-9]{1,32}$'),
  ADD COLUMN display_number      text CHECK (length(display_number) <= 40),
  ADD COLUMN verified_name       text CHECK (length(verified_name) <= 200);

-- A disconnected connection names no number. Enforced rather than left to the
-- application because the vocabulary defines `disconnected` as "no number is
-- actively connected for the tenant", and a stale business account id left
-- behind would be a credential-adjacent identifier surviving a disconnect.
ALTER TABLE whatsapp_connections
  ADD CONSTRAINT whatsapp_connections_disconnected_names_no_number
  CHECK (state <> 'disconnected' OR business_account_id IS NULL);

-- BEFORE, so the clearing happens ahead of the CHECK above: the application
-- transitions to `disconnected` without having to remember to null three columns,
-- and a future caller that forgets is corrected rather than rejected. This is the
-- same division of labour as `app.release_whatsapp_number_route()`, which deletes
-- the route on the same transition.
CREATE OR REPLACE FUNCTION app.clear_whatsapp_connection_number() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.state = 'disconnected' THEN
    NEW.business_account_id := NULL;
    NEW.display_number      := NULL;
    NEW.verified_name       := NULL;
  END IF;
  RETURN NEW;
END $fn$;

CREATE TRIGGER whatsapp_connections_clear_number
  BEFORE INSERT OR UPDATE ON whatsapp_connections
  FOR EACH ROW EXECUTE FUNCTION app.clear_whatsapp_connection_number();


-- ---------------------------------------------------------------------------
-- whatsapp_connection_verifications
-- ---------------------------------------------------------------------------
-- One attempt to prove the link works in both directions.
--
-- The send leg is a real message through the Cloud API to a number the client
-- nominates; the receive leg is that number's reply arriving back through the
-- platform's own webhook. Nothing weaker proves both directions: an API call that
-- returns 200 proves the token can send, and a webhook subscription that exists
-- at Meta proves Meta *intends* to deliver — neither proves a notification
-- actually reaches this deployment's URL.
--
-- `code_digest` rather than the code. The code is never shown on a product
-- surface (the client reads it off WhatsApp), so the platform has no reason to be
-- able to recover it, and `credential-and-secret-handling.md` AC3's reasoning
-- about one-way storage applies to any value whose only use is being compared
-- against something the holder presents.
--
-- A row is kept after it completes. AC10 asks for a retrievable history of the
-- connection, and "the last verification failed because the reply never came" is
-- exactly what a client stuck in `connecting` needs to be told.
CREATE TABLE whatsapp_connection_verifications (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  phone_number_id     text        NOT NULL CHECK (phone_number_id ~ '^[0-9]{1,32}$'),
  -- The number the client asked the platform to prove itself against, E.164
  -- without the leading '+', which is the only form the Cloud API accepts.
  recipient           text        NOT NULL CHECK (recipient ~ '^[1-9][0-9]{6,17}$'),
  code_digest         text        NOT NULL CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  outcome             text        NOT NULL DEFAULT 'pending'
                                  CHECK (outcome IN ('pending', 'passed', 'failed')),
  -- Mirrors VERIFICATION_FAILURES in @zeddev/whatsapp.
  failure             text        CHECK (failure IN ('send_failed', 'reply_not_received', 'superseded')),
  CHECK ((outcome = 'failed') = (failure IS NOT NULL)),
  CHECK ((outcome = 'pending') = (completed_at IS NULL)),
  -- Meta's id for the message carrying the code, for support. Not a secret: it
  -- names a message, it does not reveal one.
  outbound_message_id text,
  -- The inbound message that closed it. Kept so a redelivery of that same
  -- notification is recognised as already consumed rather than admitted into the
  -- end-customer's conversation — the verification reply is platform plumbing and
  -- must never be answered by the bot.
  inbound_external_id text,
  started_at          timestamptz NOT NULL DEFAULT now(),
  expires_at          timestamptz NOT NULL,
  completed_at        timestamptz
);

-- At most one attempt in flight per tenant. Without it, two submissions would
-- leave two live codes and the second reply could pass the first attempt — which
-- would mean a number verified against credentials that were already replaced.
CREATE UNIQUE INDEX whatsapp_connection_verifications_one_pending
  ON whatsapp_connection_verifications (tenant_id)
  WHERE outcome = 'pending';

CREATE INDEX whatsapp_connection_verifications_tenant_idx
  ON whatsapp_connection_verifications (tenant_id, started_at DESC);

ALTER TABLE whatsapp_connection_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connection_verifications FORCE ROW LEVEL SECURITY;

-- Tenant-private, with no platform policy. The recipient is a personal number the
-- client nominated — usually their own mobile — and `tenant-data-isolation.md`
-- AC7 limits the operator to connection health, which `whatsapp_connections`
-- already carries. The gateway reads this table under the tenant it has already
-- attributed the notification to, so it needs no scope of its own.
CREATE POLICY whatsapp_connection_verifications_own ON whatsapp_connection_verifications
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());
