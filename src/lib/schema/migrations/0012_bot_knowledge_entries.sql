-- The freeform half of the bot's business knowledge —
-- `business-knowledge-configuration.md`.
--
-- One row per entry the client wrote, in their own words, with no required
-- structure. Uploaded documents are the other half and get a table of their own
-- when upload lands: the two have different lifecycles (an entry is edited in
-- place; a document is added, processed, and removed, never edited), and the
-- combined listing the spec asks for is a read over both, not a shared table.
--
-- Knowledge does not gate readiness (the spec's AC9), so nothing here touches
-- `app.bot_readiness_unmet` and no trigger re-evaluates readiness.

CREATE TABLE bot_knowledge_entries (
  -- Random, so an entry id reveals nothing and cannot be enumerated. Another
  -- tenant's id finds nothing: the policy hides the row, so an edit or delete
  -- naming it matches zero rows and is reported as "not found".
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Creation order: the order the client sees and the order entries are rendered
  -- into the bot's instructions. An identity column, not `created_at`, because two
  -- entries created in one transaction share `now()`, and a tie broken by a random
  -- uuid would reorder the prompt between reads.
  position    bigint      GENERATED ALWAYS AS IDENTITY,
  -- Mirrors KNOWLEDGE_LIMITS.entryMaxLength in @zeddev/bot, counted in characters
  -- as @zeddev/bot counts them. Trimmed and non-empty, so a blank entry — which
  -- would read as "configured" while telling the bot nothing — cannot exist.
  content     text        NOT NULL
                          CHECK (length(content) BETWEEN 1 AND 4000 AND content = btrim(content, E' \n\t')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX bot_knowledge_entries_tenant_order ON bot_knowledge_entries (tenant_id, position);

ALTER TABLE bot_knowledge_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE bot_knowledge_entries FORCE ROW LEVEL SECURITY;

CREATE POLICY bot_knowledge_entries_own ON bot_knowledge_entries
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

-- NO platform policy. Knowledge entries are client-authored business content;
-- nothing in operator-health-monitoring.md needs them.
