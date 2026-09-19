-- Conversations and turns — `message-burst-aggregation.md`, with the parts of
-- `human-handoff.md`, `conversation-memory.md`, and `fallback-response-behavior.md`
-- that the reply path cannot run without.
--
-- Five tables, all tenant-private (no platform, dispatch, or inbound policy: this
-- is end-customer conversation, `tenant-data-isolation.md` AC7).
--
--   * `conversations` — one per end-customer per tenant. Its row is also the lock
--     every decision about that end-customer's messages is taken under, so two
--     workers can never both think they own the open turn.
--   * `conversation_turns` — the unit of reply generation. `open` while it is
--     still accepting messages, `closed` once its window has run out.
--   * `inbound_dispositions` — what became of each inbound message: aggregated
--     into a turn, or held because the bot was off or the conversation paused.
--     It is the "processed" marker a re-run job consults, so admitting a message
--     twice is impossible rather than merely avoided. `inbound_messages` itself
--     stays append-only.
--   * `conversation_turn_outcomes` — the one answer to one turn. Its primary key
--     is the turn, which is what makes "exactly one reply per turn, including
--     under retry" (burst aggregation, fallback AC13) a constraint rather than a
--     hope. A reply or fallback carries the literal text and waits here as
--     `pending` for the outbound sender.
--   * `conversation_handoff_events` — when a conversation was paused and resumed,
--     and why (`human-handoff.md` AC12).


-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
-- A paused conversation (`handoff_paused_at` set) holds every new message
-- instead of aggregating it. The reason is the handoff signal that paused it, in
-- `@zeddev/bot`'s `HandoffSignal` shape; both columns are set and cleared together.

CREATE TABLE conversations (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id        text        NOT NULL CHECK (customer_id ~ '^[0-9]{1,32}$'),
  created_at         timestamptz NOT NULL DEFAULT now(),
  handoff_paused_at  timestamptz,
  handoff_reason     jsonb       CHECK (handoff_reason IS NULL OR jsonb_typeof(handoff_reason) = 'object'),
  UNIQUE (tenant_id, customer_id),
  -- Referenced by composite foreign keys below, so a child row can never name a
  -- conversation of another tenant.
  UNIQUE (tenant_id, id),
  CHECK ((handoff_paused_at IS NULL) = (handoff_reason IS NULL))
);

ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

CREATE POLICY conversations_own ON conversations
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- conversation_turns
-- ---------------------------------------------------------------------------
-- `closes_at` is when the turn stops accepting messages: the aggregation window
-- after the latest message, but never later than `deadline_at`, the maximum
-- extension after the first. Both are judged against a message's `received_at`,
-- so whether a message joined a turn does not depend on how far behind the
-- worker happened to be.
--
-- At most one open turn per conversation, by index.

CREATE TABLE conversation_turns (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence         bigint      GENERATED ALWAYS AS IDENTITY UNIQUE,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id  uuid        NOT NULL,
  state            text        NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  opened_at        timestamptz NOT NULL,
  closes_at        timestamptz NOT NULL,
  deadline_at      timestamptz NOT NULL,
  closed_at        timestamptz,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, id),
  CHECK (closes_at <= deadline_at),
  CHECK (opened_at <= closes_at),
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);

CREATE UNIQUE INDEX conversation_turns_one_open
  ON conversation_turns (conversation_id) WHERE state = 'open';
CREATE INDEX conversation_turns_conversation_idx
  ON conversation_turns (tenant_id, conversation_id, sequence);

ALTER TABLE conversation_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turns FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_turns_own ON conversation_turns
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- inbound_dispositions
-- ---------------------------------------------------------------------------
-- Mirrors INBOUND_DISPOSITIONS in @zeddev/conversation; a test asserts they agree.
-- A message is aggregated into exactly one turn or held with a reason, never both.

CREATE TABLE inbound_dispositions (
  inbound_message_id  uuid        PRIMARY KEY REFERENCES inbound_messages (id) ON DELETE CASCADE,
  tenant_id           uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id     uuid        NOT NULL,
  turn_id             uuid,
  disposition         text        NOT NULL CHECK (disposition IN ('aggregated', 'held_bot_inactive',
                                                                  'held_handoff_paused')),
  decided_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, turn_id) REFERENCES conversation_turns (tenant_id, id) ON DELETE CASCADE,
  CHECK ((disposition = 'aggregated') = (turn_id IS NOT NULL))
);

CREATE INDEX inbound_dispositions_turn_idx ON inbound_dispositions (turn_id) WHERE turn_id IS NOT NULL;

ALTER TABLE inbound_dispositions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbound_dispositions FORCE ROW LEVEL SECURITY;

-- Read and append only: what happened to a message is decided once.
CREATE POLICY inbound_dispositions_own_read ON inbound_dispositions
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY inbound_dispositions_own_insert ON inbound_dispositions
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- conversation_turn_outcomes
-- ---------------------------------------------------------------------------
-- Mirrors TURN_OUTCOMES, WITHHELD_REASONS, FALLBACK_TRIGGERS, FALLBACK_CAUSES and
-- FallbackSource in TypeScript; a test asserts they agree.
--
--   reply     the model's answer, sent as-is
--   fallback  the client's literal fallback text for `fallback_trigger`
--   handoff   nothing sent; the conversation was paused for a person
--   withheld  nothing sent; by the time the turn was answered the bot was off
--             or the conversation paused
--
-- `message` is what the end-customer is sent, and exists exactly for `reply` and
-- `fallback`. `delivery_state` is the outbound sender's; `pending` is the only
-- state until that sender exists.

CREATE TABLE conversation_turn_outcomes (
  turn_id           uuid        PRIMARY KEY,
  tenant_id         uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id   uuid        NOT NULL,
  outcome           text        NOT NULL CHECK (outcome IN ('reply', 'fallback', 'handoff', 'withheld')),
  message           text        CHECK (message IS NULL OR (length(message) BETWEEN 1 AND 4096)),
  fallback_trigger  text        CHECK (fallback_trigger IN ('ai_error', 'low_confidence', 'out_of_scope')),
  fallback_cause    text        CHECK (fallback_cause IN ('generation_failed', 'truncated', 'unusable_output',
                                                          'declined', 'handoff_unavailable', 'not_understood')),
  fallback_source   text        CHECK (fallback_source IN ('trigger', 'shared', 'platform_default')),
  handoff_reason    jsonb       CHECK (handoff_reason IS NULL OR jsonb_typeof(handoff_reason) = 'object'),
  withheld_reason   text        CHECK (withheld_reason IN ('bot_inactive', 'handoff_paused')),
  delivery_state    text        CHECK (delivery_state IN ('pending')),
  input_tokens      integer     CHECK (input_tokens >= 0),
  output_tokens     integer     CHECK (output_tokens >= 0),
  decided_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, turn_id) REFERENCES conversation_turns (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  CHECK ((message IS NOT NULL) = (outcome IN ('reply', 'fallback'))),
  CHECK ((delivery_state IS NOT NULL) = (message IS NOT NULL)),
  CHECK ((fallback_trigger IS NOT NULL) = (outcome = 'fallback')),
  CHECK ((fallback_cause IS NOT NULL) = (outcome = 'fallback')),
  CHECK ((fallback_source IS NOT NULL) = (outcome = 'fallback')),
  CHECK ((handoff_reason IS NOT NULL) = (outcome = 'handoff')),
  CHECK ((withheld_reason IS NOT NULL) = (outcome = 'withheld'))
);

CREATE INDEX conversation_turn_outcomes_pending_idx
  ON conversation_turn_outcomes (tenant_id, decided_at) WHERE delivery_state = 'pending';

ALTER TABLE conversation_turn_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_turn_outcomes FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_turn_outcomes_own ON conversation_turn_outcomes
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());


-- ---------------------------------------------------------------------------
-- conversation_handoff_events
-- ---------------------------------------------------------------------------
-- Append-only history. `reason` is the pausing signal for `paused`; `turn_id` is
-- the turn whose answer paused it. `resumed` carries neither.

CREATE TABLE conversation_handoff_events (
  id               bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id        uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  conversation_id  uuid        NOT NULL,
  event            text        NOT NULL CHECK (event IN ('paused', 'resumed')),
  reason           jsonb       CHECK (reason IS NULL OR jsonb_typeof(reason) = 'object'),
  turn_id          uuid,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, conversation_id) REFERENCES conversations (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, turn_id) REFERENCES conversation_turns (tenant_id, id) ON DELETE CASCADE,
  CHECK ((event = 'paused') = (reason IS NOT NULL)),
  CHECK (event = 'paused' OR turn_id IS NULL)
);

CREATE INDEX conversation_handoff_events_conversation_idx
  ON conversation_handoff_events (tenant_id, conversation_id, id);

ALTER TABLE conversation_handoff_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_handoff_events FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_handoff_events_own_read ON conversation_handoff_events
  FOR SELECT
  USING (tenant_id = app.current_tenant_id());

CREATE POLICY conversation_handoff_events_own_insert ON conversation_handoff_events
  FOR INSERT
  WITH CHECK (tenant_id = app.current_tenant_id());
