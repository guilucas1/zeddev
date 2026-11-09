-- Per-tenant operational metrics, for the operator (`operator-health-monitoring.md`).
--
-- Every number the operator is entitled to is derived from tables the operator must
-- never read: a message's text sits in the same row as its timestamp, a reply's text
-- in the same row as its delivery state. Row-level security cannot grant part of a
-- row, so a query over those tables cannot be offered to the platform scope at all.
-- What the platform scope reads instead is this table, which has no column that could
-- hold text. "The operator sees numbers and never content" is then a property of the
-- schema, checked by a test over the column types, and not of how carefully a query
-- was written.
--
-- A row is one tenant's activity in one UTC hour. An hour is fine enough for the
-- windows a dashboard offers, and coarse enough that a year of a busy tenant is under
-- nine thousand rows. A row exists only for an hour with activity; a tenant with no
-- traffic has no rows, and the reader answers zero for it (AC11).

CREATE TABLE tenant_metric_buckets (
  tenant_id          uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  -- Compared as epoch seconds so the rule does not depend on the session's time zone.
  bucket_start       timestamptz NOT NULL CHECK (mod(extract(epoch FROM bucket_start)::numeric, 3600) = 0),

  messages_received  integer     NOT NULL DEFAULT 0 CHECK (messages_received >= 0),
  messages_sent      integer     NOT NULL DEFAULT 0 CHECK (messages_sent >= 0),
  -- Turns the bot decided an answer for. A turn withheld because the bot was off or a
  -- human had taken over is not an attempt, so it could not have failed.
  turns_answered     integer     NOT NULL DEFAULT 0 CHECK (turns_answered >= 0),
  -- Of those, the ones the model could not answer: a fallback for a technical reason.
  -- A fallback the client configured for an out-of-scope question is the bot working.
  responses_failed   integer     NOT NULL DEFAULT 0 CHECK (responses_failed >= 0),
  deliveries_failed  integer     NOT NULL DEFAULT 0 CHECK (deliveries_failed >= 0),
  -- Replies that missed WhatsApp's 24-hour window. Counted apart from failures:
  -- `message-delivery-reliability.md` requires the occurrence be visible, but it is a
  -- consequence of a reply being late, not of anything being broken.
  deliveries_expired integer     NOT NULL DEFAULT 0 CHECK (deliveries_expired >= 0),

  -- An average is kept as its two halves so that hours can be added together. A
  -- stored per-hour average could not be combined without weighting it.
  responses_timed    integer     NOT NULL DEFAULT 0 CHECK (responses_timed >= 0),
  response_ms_total  bigint      NOT NULL DEFAULT 0 CHECK (response_ms_total >= 0),

  PRIMARY KEY (tenant_id, bucket_start)
);

-- The all-tenant view and the retention sweep both ask by time across tenants.
CREATE INDEX tenant_metric_buckets_time_idx ON tenant_metric_buckets (bucket_start);

ALTER TABLE tenant_metric_buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_metric_buckets FORCE ROW LEVEL SECURITY;

-- Written tenant-bound, by the triggers below, and deleted tenant-bound by the
-- retention sweep. The platform scope only ever reads.
CREATE POLICY tenant_metric_buckets_own ON tenant_metric_buckets
  USING (tenant_id = app.current_tenant_id())
  WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY tenant_metric_buckets_platform_read ON tenant_metric_buckets
  FOR SELECT USING (app.has_platform_scope());


-- ---------------------------------------------------------------------------
-- Counting, in the transaction that made each event true
-- ---------------------------------------------------------------------------
-- In triggers, so a count cannot disagree with the row it counts. A count written by
-- application code after the fact can be lost to a crash between the two, and can be
-- repeated by a retried job. These commit or roll back with the event itself.

CREATE FUNCTION app.bump_tenant_metrics(
  p_tenant             uuid,
  p_at                 timestamptz,
  p_messages_received  integer DEFAULT 0,
  p_messages_sent      integer DEFAULT 0,
  p_turns_answered     integer DEFAULT 0,
  p_responses_failed   integer DEFAULT 0,
  p_deliveries_failed  integer DEFAULT 0,
  p_deliveries_expired integer DEFAULT 0,
  p_responses_timed    integer DEFAULT 0,
  p_response_ms_total  bigint  DEFAULT 0
) RETURNS void
  LANGUAGE sql AS $fn$
  INSERT INTO tenant_metric_buckets AS b
    (tenant_id, bucket_start, messages_received, messages_sent, turns_answered, responses_failed,
     deliveries_failed, deliveries_expired, responses_timed, response_ms_total)
  VALUES
    -- The three-argument form, so the hour is a UTC hour whatever the session's zone.
    (p_tenant, date_trunc('hour', p_at, 'UTC'), p_messages_received, p_messages_sent, p_turns_answered,
     p_responses_failed, p_deliveries_failed, p_deliveries_expired, p_responses_timed, p_response_ms_total)
  ON CONFLICT (tenant_id, bucket_start) DO UPDATE SET
    messages_received  = b.messages_received  + EXCLUDED.messages_received,
    messages_sent      = b.messages_sent      + EXCLUDED.messages_sent,
    turns_answered     = b.turns_answered     + EXCLUDED.turns_answered,
    responses_failed   = b.responses_failed   + EXCLUDED.responses_failed,
    deliveries_failed  = b.deliveries_failed  + EXCLUDED.deliveries_failed,
    deliveries_expired = b.deliveries_expired + EXCLUDED.deliveries_expired,
    responses_timed    = b.responses_timed    + EXCLUDED.responses_timed,
    response_ms_total  = b.response_ms_total  + EXCLUDED.response_ms_total;
$fn$;

CREATE FUNCTION app.count_inbound_message() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM app.bump_tenant_metrics(NEW.tenant_id, NEW.received_at, p_messages_received => 1);
  RETURN NULL;
END $fn$;

CREATE FUNCTION app.count_turn_outcome() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  IF NEW.outcome <> 'withheld' THEN
    PERFORM app.bump_tenant_metrics(
      NEW.tenant_id, NEW.decided_at,
      p_turns_answered   => 1,
      p_responses_failed => CASE WHEN NEW.fallback_trigger = 'ai_error' THEN 1 ELSE 0 END
    );
  END IF;
  RETURN NULL;
END $fn$;

-- Response time is what the customer waited: from their first message of the turn
-- to the answer leaving. That includes the quiet period the platform waits for a
-- burst to finish, because the customer waited through that too.
CREATE FUNCTION app.count_settled_delivery() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
DECLARE
  waited_ms bigint;
BEGIN
  IF NEW.delivery_state = 'sent' THEN
    SELECT GREATEST(0, round(extract(epoch FROM (NEW.delivery_updated_at - t.opened_at)) * 1000))::bigint
      INTO waited_ms
      FROM conversation_turns t
     WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.turn_id;
    PERFORM app.bump_tenant_metrics(
      NEW.tenant_id, NEW.delivery_updated_at,
      p_messages_sent     => 1,
      p_responses_timed   => CASE WHEN waited_ms IS NULL THEN 0 ELSE 1 END,
      p_response_ms_total => COALESCE(waited_ms, 0)
    );
  ELSIF NEW.delivery_state = 'failed' THEN
    PERFORM app.bump_tenant_metrics(NEW.tenant_id, NEW.delivery_updated_at, p_deliveries_failed => 1);
  ELSIF NEW.delivery_state = 'expired' THEN
    PERFORM app.bump_tenant_metrics(NEW.tenant_id, NEW.delivery_updated_at, p_deliveries_expired => 1);
  END IF;
  RETURN NULL;
END $fn$;

-- Constraint triggers deferred to commit, for the row lock's sake. All of a tenant's
-- work shares this row for the hour, so a bump made mid-transaction would hold it
-- across everything after, and would take it before locks other transactions take
-- in the opposite order: settling a delivery goes on to lock the connection row.
-- Fired at commit it is the last lock taken, which is what rules out a cycle. Every
-- real transaction's events carry one `now()`, so it touches a single row here.
CREATE CONSTRAINT TRIGGER inbound_messages_count
  AFTER INSERT ON inbound_messages
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.count_inbound_message();

CREATE CONSTRAINT TRIGGER conversation_turn_outcomes_count
  AFTER INSERT ON conversation_turn_outcomes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.count_turn_outcome();

-- Only a move out of an unsettled state counts. A worker that lost its lease can
-- report after another has already recorded the end of the delivery, and that second
-- report must not count the one message twice.
CREATE CONSTRAINT TRIGGER conversation_turn_outcomes_count_delivery
  AFTER UPDATE OF delivery_state ON conversation_turn_outcomes
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (OLD.delivery_state IN ('pending', 'sending') AND NEW.delivery_state IN ('sent', 'failed', 'expired'))
  EXECUTE FUNCTION app.count_settled_delivery();
