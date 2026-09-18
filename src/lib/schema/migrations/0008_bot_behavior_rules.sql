-- The bot's behaviour rules — `behavior-rules-configuration.md`.
--
-- Two mechanisms, both binding at once: discrete structured rules, each with its
-- own enable/disable, edit, and delete lifecycle, and one block of freeform
-- instructions text per tenant. They are separate tables because they have
-- separate lifecycles — a tenant may have many rules and no text, or text and no
-- rules — and because "zero rules" must be representable without a placeholder
-- row that could be mistaken for a configured one.
--
-- Neither table gates readiness: the spec never lists behaviour rules among the
-- minimum configuration, so nothing here touches `app.bot_readiness_unmet`.

-- ---------------------------------------------------------------------------
-- Structured rules
-- ---------------------------------------------------------------------------

CREATE TABLE bot_behavior_rules (
  -- Random, so a rule id reveals nothing and cannot be enumerated. A guessed id
  -- belonging to another tenant finds nothing: the policy below hides the row, so
  -- an edit, toggle, or delete naming it matches zero rows and is reported as
  -- "not found" — the same answer as an id that never existed.
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Creation order, which is the order the client sees and the order the rules
  -- are rendered into the bot's instructions. An identity column rather than
  -- `created_at` because two rules created in one transaction share `now()`, and
  -- a tie broken by a random uuid would reorder the prompt between reads.
  position    bigint      GENERATED ALWAYS AS IDENTITY,
  -- Mirrors RULE_KINDS in @zeddev/bot. Constrained here too so that a kind the
  -- instruction renderer has no wording for cannot reach it by any path.
  kind        text        NOT NULL CHECK (kind IN ('never', 'always', 'only_when', 'avoid_topic')),
  -- What the rule is about: the behaviour for never/always/only_when, the topic
  -- for avoid_topic. Counted in characters, as @zeddev/bot counts them.
  subject     text        NOT NULL
                          CHECK (length(subject) BETWEEN 1 AND 300 AND subject = btrim(subject)),
  -- The "only when …" of an only_when rule (required) or the "before …" of an
  -- always rule (optional). Meaningless for the other two kinds, so refused there
  -- rather than stored and silently ignored.
  condition   text        CHECK (length(condition) BETWEEN 1 AND 300 AND condition = btrim(condition)),
  -- Mirrors RULE_ACTIONS in @zeddev/bot: what the bot does when this rule stops it
  -- answering directly. 'respond' means the rule only constrains the bot's own
  -- reply; 'handoff' and 'fallback' defer to human-handoff.md and
  -- fallback-response-behavior.md respectively.
  action      text        NOT NULL DEFAULT 'respond' CHECK (action IN ('respond', 'handoff', 'fallback')),
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT bot_behavior_rules_condition_by_kind CHECK (
    CASE kind
      WHEN 'only_when' THEN condition IS NOT NULL
      WHEN 'always'    THEN true
      ELSE                  condition IS NULL
    END
  ),
  -- An obligation is something the bot does itself; "always hand off" is a
  -- handoff trigger, which belongs to human-handoff.md's own configuration.
  CONSTRAINT bot_behavior_rules_action_by_kind CHECK (kind <> 'always' OR action = 'respond')
);

CREATE INDEX bot_behavior_rules_tenant_order ON bot_behavior_rules (tenant_id, position);

ALTER TABLE bot_behavior_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_behavior_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_behavior_rules_own ON bot_behavior_rules
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- ---------------------------------------------------------------------------
-- Freeform instructions
-- ---------------------------------------------------------------------------

CREATE TABLE bot_behavior_instructions (
  tenant_id              uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
  -- NULL is "no freeform text" and the only representation of it: the application
  -- stores a blank submission as NULL and this CHECK refuses an empty string, so
  -- there are not two spellings of "cleared".
  freeform_instructions  text        CHECK (length(freeform_instructions) BETWEEN 1 AND 4000),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bot_behavior_instructions ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_behavior_instructions FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_behavior_instructions_own ON bot_behavior_instructions
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy on either table. Rules and freeform text are client-authored
-- instruction content; nothing in operator-health-monitoring.md needs them.
