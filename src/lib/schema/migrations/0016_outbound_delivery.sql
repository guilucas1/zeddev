-- Delivering the answer: the outbox's state machine.
--
-- Migration 0014 created `conversation_turn_outcomes` as an outbox whose
-- `delivery_state` had exactly one legal value, `pending`, because nothing drained
-- it yet. This migration gives that column the rest of its vocabulary and the
-- fields a send attempt produces.
--
-- `message-delivery-reliability.md` asks for four things here that a bare
-- "sent?" boolean cannot carry:
--
--   * AC7 — a transient failure is retried and the end customer still receives
--     exactly one copy. That needs the row to know an attempt is *in flight*
--     (`sending`), not merely that one has not succeeded, because "no success
--     recorded" is also what a crash after a successful send looks like.
--   * AC8 — an exhausted retry allowance is recorded against the tenant rather
--     than silently discarded. That is `failed` plus a reason and a count.
--   * AC10 — a reply falling outside WhatsApp's 24-hour customer service window
--     is detected, not silently dropped, and the occurrence recorded. That is
--     `expired`, which is deliberately its own state and not a kind of failure:
--     nothing was attempted and nothing was wrong with the connection.
--   * AC17 — delivery diagnostics carry operational information only. Every
--     column added here is a state, a count, a timestamp, a classified reason, or
--     Meta's own message id. None of them can hold message text; the text itself
--     already lives in `message`, which no operator surface reads.


-- ---------------------------------------------------------------------------
-- The state vocabulary
-- ---------------------------------------------------------------------------
--   pending  decided, not yet attempted (or a definitive rejection is being retried)
--   sending  an attempt is in flight, or was in flight when this process died
--   sent     Meta accepted it and returned a message id
--   failed   not delivered, and it will not be attempted again — with a reason
--   expired  outside the 24-hour customer service window; never attempted
--
-- `pending` remains the only state `recordTurnOutcome` writes, so nothing about
-- how an answer is *decided* changes.

ALTER TABLE conversation_turn_outcomes
  DROP CONSTRAINT conversation_turn_outcomes_delivery_state_check;

ALTER TABLE conversation_turn_outcomes
  ADD CONSTRAINT conversation_turn_outcomes_delivery_state_check
  CHECK (delivery_state IN ('pending', 'sending', 'sent', 'failed', 'expired'));


-- ---------------------------------------------------------------------------
-- What an attempt produces
-- ---------------------------------------------------------------------------
-- `delivery_failure` mirrors DELIVERY_FAILURES in @zeddev/conversation; a test
-- asserts the two agree.
--
--   window_expired    the 24-hour customer service window had closed (AC10)
--   indeterminate     the attempt's outcome is unknowable — see below
--   rejected          Meta refused it and will refuse it again
--   attempts_exhausted  every retry in the allowance failed definitively (AC8)
--
-- `indeterminate` is the one that earns its keep. A request that times out, or a
-- process that dies between the send and the record, leaves a row that cannot
-- distinguish "Meta never saw it" from "Meta delivered it". The Cloud API offers
-- no idempotency key and no way to ask after the fact, so the platform has to
-- choose which mistake it prefers: a duplicate reply to an end customer, or a
-- recorded non-delivery. AC7 forbids the first by name and AC8 explicitly
-- provides for the second, so an indeterminate attempt is never re-sent.

ALTER TABLE conversation_turn_outcomes
  ADD COLUMN delivery_attempts   integer     NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  ADD COLUMN delivery_failure    text        CHECK (delivery_failure IN
                                                     ('window_expired', 'indeterminate',
                                                      'rejected', 'attempts_exhausted')),
  -- Why the last attempt failed, in one classified word: a ConnectionErrorReason,
  -- `transient`, or `not_connected` when there was no number to send from. Kept
  -- beside the failure because "rejected" alone does not tell an operator whether
  -- to fix the token or wait.
  ADD COLUMN delivery_reason     text        CHECK (delivery_reason ~ '^[a-z_]{1,40}$'),
  ADD COLUMN delivery_message_id text        CHECK (length(delivery_message_id) BETWEEN 1 AND 256),
  ADD COLUMN delivery_updated_at timestamptz;

-- A terminal state names why, and only a terminal state does. Without this a
-- `failed` row with no reason would satisfy AC8's letter and defeat its purpose:
-- the operator metric would show a failure that nothing explains.
ALTER TABLE conversation_turn_outcomes
  ADD CONSTRAINT conversation_turn_outcomes_delivery_failure_pairs_state
  CHECK ((delivery_failure IS NOT NULL) = (delivery_state IN ('failed', 'expired')));

-- Meta's message id exists exactly for a delivered message. It is the only
-- evidence the platform holds that a particular answer reached a particular
-- customer, so a row claiming `sent` without one would be unfalsifiable.
ALTER TABLE conversation_turn_outcomes
  ADD CONSTRAINT conversation_turn_outcomes_delivery_message_id_pairs_sent
  CHECK ((delivery_message_id IS NOT NULL) = (delivery_state = 'sent'));


-- ---------------------------------------------------------------------------
-- Finding work, and counting failures
-- ---------------------------------------------------------------------------
-- Partial, because the interesting rows are a vanishing fraction of the table
-- once the platform has been running: everything reaches `sent` and stays there.
-- The queue is what actually drives a send; this index exists for the recovery
-- sweep and for the per-tenant failed-delivery metric
-- `operator-health-monitoring.md` requires.
-- Replaces 0014's `..._pending_idx`, which this one covers: two partial indexes
-- over the same column, one a subset of the other, is a second answer to "what
-- still needs delivering" that would have to be kept in step by hand.
DROP INDEX conversation_turn_outcomes_pending_idx;

CREATE INDEX conversation_turn_outcomes_undelivered_idx
  ON conversation_turn_outcomes (tenant_id, delivery_state, decided_at)
  WHERE delivery_state IS NOT NULL AND delivery_state <> 'sent';
