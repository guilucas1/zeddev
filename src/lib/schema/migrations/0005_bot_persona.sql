-- The bot's persona and tone, one row per tenant.
--
-- `persona-and-tone-configuration.md` requires structured fields (the name the
-- bot presents as, a formality level, style traits) plus optional freeform text,
-- persisted until the client changes them, and scoped to that client only.
--
-- A row exists only once the client has saved a *complete* persona: the bot name
-- is NOT NULL and the application refuses a save without one (AC3). So "has this
-- tenant completed persona/tone?" — the readiness condition in
-- `bot-activation-control.md` — is "does the row exist", with no second flag
-- that could disagree with the data it summarises.
--
-- Formality and style traits are optional. The spec requires "at minimum" the
-- name and leaves the rest open; IMPLEMENTATION_PLAN.md records the decision.
-- NULL formality and an empty trait list mean "not chosen", and the prompt says
-- nothing about them rather than inventing a default the client never picked.

CREATE TABLE bot_personas (
  -- One persona per tenant (the spec's "uniform per client in v1"), so the tenant
  -- id is the key. There is no separate id a caller could supply for another
  -- tenant's row.
  tenant_id              uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- Lengths are counted in characters, which is what PostgreSQL's `length()`
  -- counts for UTF-8 and what `@zeddev/bot` counts (code points, not UTF-16
  -- units). The two limits must agree, and a test asserts they do.
  bot_name               text        NOT NULL
                                     CHECK (length(bot_name) BETWEEN 1 AND 50
                                            AND bot_name = btrim(bot_name)),
  -- Mirrors FORMALITY_LEVELS in @zeddev/bot. Constrained here as well so that a
  -- value the prompt assembler has no wording for cannot reach it by any path.
  formality              text        CHECK (formality IN ('formal', 'neutral', 'casual')),
  -- Mirrors STYLE_TRAITS in @zeddev/bot.
  style_traits           text[]      NOT NULL DEFAULT '{}'
                                     CHECK (style_traits <@ ARRAY['friendly', 'professional', 'playful',
                                                                  'empathetic', 'enthusiastic', 'calm',
                                                                  'concise', 'witty']::text[]),
  -- NULL is "no freeform text", and the only representation of it: the
  -- application stores a cleared or whitespace-only value as NULL, and the CHECK
  -- refuses an empty string so there are not two spellings of "cleared".
  freeform_instructions  text        CHECK (length(freeform_instructions) BETWEEN 1 AND 2000),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bot_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_personas FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_personas_own ON bot_personas
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy. The operator needs to see whether a tenant is *ready*
-- (`bot-activation-control.md` AC12), not what its bot is told to say; the
-- freeform text is client-authored instruction content. When the operator's
-- readiness view lands, it reads a derived readiness state, never this table.
