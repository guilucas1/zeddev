-- Reading conversations back — `client-conversation-visibility.md`.
--
-- No new table and no new policy: the conversation list and the transcript are
-- views over what the reply path already stores, under the tenant-only policies
-- those tables already have. A second copy of a conversation "for display" would
-- be a second thing for offboarding to delete and a second answer to what was said.
--
-- One index, because both reads need what the bot said in one conversation, and
-- until now nothing reached the outcomes by conversation: the worker goes by turn,
-- and the sender by delivery state. Partial, because a turn answered with a handoff
-- or withheld said nothing and appears in neither read. `decided_at` is in the key
-- so the list's "most recent activity" is answered from the index alone.

CREATE INDEX conversation_turn_outcomes_said_idx
  ON conversation_turn_outcomes (tenant_id, conversation_id, decided_at)
  WHERE message IS NOT NULL;
