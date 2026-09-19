-- The client's human-handoff configuration — `human-handoff.md`.
--
-- Whether handoff is enabled for the bot at all, and which conditions trigger
-- it: any of the three built-in triggers the spec requires be available
-- (an explicit request for a person, a complaint, a message outside what the bot
-- is configured to handle), plus conditions the client writes in their own words.
--
-- One row per tenant that has *saved something*. A tenant with no row has never
-- configured handoff and is given the platform default carried in `@zeddev/bot`:
-- disabled, with all three built-in triggers selected, so enabling it without
-- touching the triggers gives the spec's "default trigger conditions" (AC2).
-- Not seeded at provisioning for the reason migration 0010 records: tenants are
-- created under the identity scope, which must not be able to write bot
-- configuration.
--
-- This table is configuration only. Whether a given conversation is paused for
-- handoff is per-conversation state that lives with conversations (P2), and it
-- is deliberately *not* derived from this row: saving here — including disabling
-- handoff — must never reactivate a conversation already handed off (AC13).
--
-- Not a readiness condition: a bot with handoff disabled is complete, and its
-- unanswerable messages follow `fallback-response-behavior.md` instead.

-- Whether a list of client-written conditions is well formed: each one a
-- trimmed, single-line phrase of 1-300 characters, none repeated. IMMUTABLE so a
-- CHECK constraint may call it. Mirrors HANDOFF_LIMITS and the phrase rules in
-- @zeddev/bot; a test asserts the two agree.
CREATE OR REPLACE FUNCTION app.bot_handoff_conditions_valid(p_conditions text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$
    SELECT coalesce(bool_and(
             c IS NOT NULL
             AND length(c) BETWEEN 1 AND 300
             AND c = btrim(c)
             AND c !~ '[[:cntrl:]]'
           ), true)
       AND cardinality(p_conditions) = (SELECT count(DISTINCT d) FROM unnest(p_conditions) AS d)
      FROM unnest(p_conditions) AS c
  $$;

CREATE TABLE bot_handoff_settings (
  -- One configuration per tenant, so the tenant id is the key. There is no
  -- separate id a caller could supply for another tenant's row.
  tenant_id          uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  enabled            boolean     NOT NULL,
  -- The built-in triggers selected. Mirrors HANDOFF_TRIGGERS in @zeddev/bot; a
  -- test asserts they agree. The library stores them de-duplicated, in the
  -- list's order.
  triggers           text[]      NOT NULL
                                 CHECK (triggers <@ ARRAY['human_request', 'complaint', 'out_of_scope']::text[]
                                        AND array_position(triggers, NULL) IS NULL),
  -- The client's own conditions, in the order they were written. Rendered into
  -- every reply's prompt, hence the cap: see HANDOFF_LIMITS.
  custom_conditions  text[]      NOT NULL DEFAULT '{}'
                                 CHECK (cardinality(custom_conditions) <= 20
                                        AND app.bot_handoff_conditions_valid(custom_conditions)),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  -- Enabled with nothing that could ever trigger it would read as "on" on the
  -- client's screen while behaving exactly as "off". Disabled with no triggers
  -- is fine: nothing is promised.
  CONSTRAINT bot_handoff_settings_enabled_has_trigger CHECK (
    NOT enabled OR cardinality(triggers) + cardinality(custom_conditions) > 0
  )
);

ALTER TABLE bot_handoff_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_handoff_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_handoff_settings_own ON bot_handoff_settings
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy: custom conditions are client-authored content, and nothing
-- in operator-health-monitoring.md needs a client's handoff configuration.
