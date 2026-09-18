-- The client's fallback messages — `fallback-response-behavior.md`.
--
-- What the bot sends when it cannot produce a good answer and handoff is not the
-- path taken. One row per tenant, holding an optional shared message plus an
-- optional message per trigger (AI/system error, low confidence, out of scope).
-- Resolution is per trigger: the trigger's own message, else the shared one, else
-- the platform default carried in `@zeddev/bot` (`resolveFallbackMessage`), so
-- "one message for everything" and "a distinct message per trigger" are both
-- ordinary configurations rather than one being a special case of the other.
--
-- The messages are stored as literal, client-authored text and are never
-- generated at send time. That is what lets a fallback go out when the AI step is
-- the thing that failed (AC5): sending one needs this row and nothing else.
--
-- A row exists only while at least one message is configured. Saving with every
-- message blank deletes the row, so "never configured" and "cleared" have one
-- representation, and the CHECK below refuses an all-NULL row reaching the table
-- by any other path.
--
-- Not a readiness condition: the platform default means the bot always has a
-- fallback to send, so nothing here touches `app.bot_readiness_unmet`.

CREATE TABLE bot_fallback_messages (
  -- One configuration per tenant, so the tenant id is the key. There is no
  -- separate id a caller could supply for another tenant's row.
  tenant_id               uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Lengths are counted in characters, as `@zeddev/bot` counts them
  -- (FALLBACK_LIMITS.messageMaxLength), and a test asserts the two agree. NULL is
  -- "not configured" and the only representation of it: the CHECKs refuse an
  -- empty string.
  shared_message          text        CHECK (length(shared_message) BETWEEN 1 AND 1000),
  -- One column per entry of FALLBACK_TRIGGERS in @zeddev/bot. A test asserts the
  -- list and these columns agree.
  ai_error_message        text        CHECK (length(ai_error_message) BETWEEN 1 AND 1000),
  low_confidence_message  text        CHECK (length(low_confidence_message) BETWEEN 1 AND 1000),
  out_of_scope_message    text        CHECK (length(out_of_scope_message) BETWEEN 1 AND 1000),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bot_fallback_messages_not_empty CHECK (
    num_nonnulls(shared_message, ai_error_message, low_confidence_message, out_of_scope_message) >= 1
  )
);

ALTER TABLE bot_fallback_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_fallback_messages FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_fallback_messages_own ON bot_fallback_messages
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy. The messages are client-authored text addressed to their
-- end-customers; nothing in operator-health-monitoring.md needs them.
