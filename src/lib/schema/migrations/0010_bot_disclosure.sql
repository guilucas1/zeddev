-- The client's disclosure choice — `bot-disclosure-setting.md`.
--
-- Whether the bot tells end-customers it is an automated/AI system: exactly two
-- modes, "disclose" and "do not disclose". One row per tenant that has *made a
-- choice*. A tenant with no row has never chosen and is given the platform
-- default, carried in `@zeddev/bot` (PLATFORM_DEFAULT_DISCLOSURE_MODE), so a new
-- bot has a defined mode without the client configuring anything (AC8).
--
-- Why not seed a row per tenant at provisioning: tenants are created before any
-- tenant is bound (signup runs under the identity scope), so a row written then
-- would need a policy letting the identity scope write bot configuration. Keeping
-- "never chosen" as the absence of a row keeps that scope's reach where it is,
-- and is the same shape persona and fallback messages already use.
--
-- The cost of that shape: changing the platform default later would change the
-- mode of every tenant that never chose. If that is ever done, it must be a
-- migration that first writes the *old* default into a row for each such tenant,
-- binding each tenant in turn as 0007's backfill does.
--
-- Not a readiness condition: every tenant has a mode, chosen or default.

CREATE TABLE bot_disclosure_settings (
  -- One setting per tenant, so the tenant id is the key. There is no separate id
  -- a caller could supply for another tenant's row.
  tenant_id   uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Mirrors DISCLOSURE_MODES in @zeddev/bot; a test asserts they agree.
  mode        text        NOT NULL CHECK (mode IN ('disclose', 'do_not_disclose')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bot_disclosure_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_disclosure_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_disclosure_settings_own ON bot_disclosure_settings
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy. Nothing in operator-health-monitoring.md needs a client's
-- disclosure choice, and every table the platform scope can reach is one more
-- that must be argued to hold no client content.
