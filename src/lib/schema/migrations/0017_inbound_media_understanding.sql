-- What the platform understood from an image or voice note —
-- `image-message-understanding.md`, `voice-message-understanding.md`, and the
-- media half of `message-delivery-reliability.md` (AC14, AC15).
--
-- One row per media message, written once. `inbound_messages` stays append-only
-- and keeps saying what arrived; this says what was made of it.
--
-- Text, never bytes. What the specs need afterwards is the derived content:
-- `conversation-memory.md` puts it in later turns' context, and
-- `client-conversation-visibility.md` AC4/AC5 ask the transcript to show "the
-- transcription or understood content". Neither needs the photo itself, and a
-- customer's photos are the most sensitive thing this platform could hold and the
-- most expensive to keep, so they stay in the worker's memory for the length of
-- one call. It also means Meta's reference expiring, which
-- `message-delivery-reliability.md` warns about, costs nothing later: the
-- understanding is here, and the reference is never needed again.
--
-- A row also records failure, not just success, because "this photo could not be
-- viewed" is a fact later turns must be able to tell the model. Mirrors
-- MEDIA_UNDERSTANDING_FAILURES in @zeddev/conversation; a test asserts they agree.
--
-- Tenant-private: no platform, dispatch, or inbound policy. This is end-customer
-- content (`tenant-data-isolation.md` AC7).

-- So the foreign key below can name the tenant as well as the message, and a row
-- can never attach one tenant's understanding to another tenant's message.
ALTER TABLE inbound_messages ADD CONSTRAINT inbound_messages_tenant_id_id_key UNIQUE (tenant_id, id);

CREATE TABLE inbound_media_understandings (
  inbound_message_id  uuid        PRIMARY KEY,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- NULL means understood; otherwise why not. The two technical reasons
  -- (`retrieval_failed`, `provider_failed`) route to the `ai_error` fallback, the
  -- rest to `low_confidence`.
  failure             text        CHECK (failure IN ('unreadable', 'no_speech', 'unsupported_format',
                                                     'capability_missing', 'too_large', 'retrieval_failed',
                                                     'provider_failed')),
  understood_text     text        CHECK (understood_text IS NULL OR length(understood_text) BETWEEN 1 AND 20000),
  -- The attempt of the turn's job that settled it, for AC17's "retry counts".
  attempts            integer     NOT NULL CHECK (attempts >= 1),
  input_tokens        integer     CHECK (input_tokens >= 0),
  output_tokens       integer     CHECK (output_tokens >= 0),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, inbound_message_id) REFERENCES inbound_messages (tenant_id, id) ON DELETE CASCADE,
  CHECK ((understood_text IS NULL) = (failure IS NOT NULL))
);

ALTER TABLE inbound_media_understandings ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_media_understandings FORCE ROW LEVEL SECURITY;

-- Read and append only: what was understood from a message is decided once.
CREATE POLICY inbound_media_understandings_own_read ON inbound_media_understandings
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY inbound_media_understandings_own_insert ON inbound_media_understandings
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
