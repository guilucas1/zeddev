# Client Conversation Visibility

## Purpose

Defines the client business's ability to view their own end-customers' conversations and transcripts with their bot, so they can monitor, verify, and support what the bot is saying and doing on their behalf.

## Behavioral Requirements

- The system must let a client view the full message transcript of any conversation between their bot and their own end-customers.
- The system must show both the end-customer's messages and the bot's replies, in the order they occurred, within a viewed transcript.
- The system must let a client see the list of their own end-customers' conversations, not just view one conversation at a time in isolation.
- The system must reflect new messages in a conversation's transcript as the conversation continues, so a client can see up-to-date activity, not only a frozen historical snapshot.
- The system must let a client identify which end-customer a conversation belongs to (e.g., the end-customer's WhatsApp identifier/number or name if known) when viewing that client's conversation list or a transcript.
- The system must present non-text message content (e.g., voice messages, images) that occurred in a conversation, or a usable representation of it (such as a transcription per `voice-message-understanding.md` or the understood content per `image-message-understanding.md`), as part of the transcript the client views.
- The system must let a client find a specific conversation (e.g., by end-customer identity or recency) rather than requiring them to scan an undifferentiated list.
- The system must restrict a client's conversation visibility to conversations belonging to their own end-customers only, per the isolation guarantee in `tenant-data-isolation.md`.
- The system must make conversation visibility available for a conversation regardless of whether it is currently under normal bot handling or paused for human handoff per `human-handoff.md`.
- The system must reflect a handed-off conversation's handoff status and trigger reason (as recorded per `human-handoff.md`) when the client views that conversation.
- The system must retain a conversation's transcript and make it visible to the client for at least as long as the underlying conversation data itself is retained by the platform.

## Acceptance Criteria

- Given a client with at least one end-customer conversation, When the client opens their conversation list, Then they see an entry for each of their own end-customers' conversations.
- Given a client viewing a specific conversation, When the transcript loads, Then it shows every message exchanged in that conversation, in chronological order, with each message attributed to either the end-customer or the bot.
- Given an end-customer sends a new message and the bot replies, When the client views (or re-opens) that conversation shortly after, Then both the new end-customer message and the new bot reply appear in the transcript.
- Given a conversation that included a voice message from the end-customer, When the client views that conversation's transcript, Then the client can see the transcription or understood content of that voice message, not just an unplayable raw artifact with no textual representation.
- Given a conversation that included an image from the end-customer, When the client views that conversation's transcript, Then the client can see what the bot understood from that image as part of the transcript.
- Given a client with many end-customer conversations, When the client searches or filters their conversation list by end-customer identity or recency, Then the matching conversation(s) are returned.
- Given a conversation currently paused for human handoff, When the client views that conversation, Then the transcript is visible and shows its handoff status and the reason it was flagged, per `human-handoff.md`.
- Given a client attempts to access a conversation belonging to another client's end-customer, When that access is attempted through any available path, Then the request is denied or returns no data, per `tenant-data-isolation.md`.
- Given the platform operator, When the operator uses any operator-facing tool or dashboard, Then no end-customer conversation transcript or message content is visible to the operator, per `operator-health-monitoring.md` and `tenant-data-isolation.md`.

## Out of Scope

- The isolation mechanism that prevents cross-tenant access to conversations — see `tenant-data-isolation.md`, not redefined here.
- The operator's dashboard and what health/usage data the operator can see — see `operator-health-monitoring.md`; this spec only asserts that conversation content is excluded from it.
- Detection of handoff triggers and the mechanics of pausing/resuming bot replies — see `human-handoff.md`; this spec only covers the client's ability to view a handed-off conversation's transcript and status.
- Voice transcription and image understanding mechanics themselves — see `voice-message-understanding.md` and `image-message-understanding.md`; this spec only requires that their output be shown as part of the transcript.
- Any capability for a human at the client business to send a message into a conversation through the system (as opposed to viewing it) — not addressed here.
- Export, download, or bulk-extraction of conversation transcripts (e.g., CSV/PDF export) — not addressed here.
- End-customer-facing visibility or export rights over their own chat history — not addressed here (see Open Questions).
- Data retention periods, deletion, and offboarding data handling — see `client-offboarding-and-data-retention.md`.
- Authentication mechanics for how a client proves their identity to access their dashboard — assumed already established.
- Real-time delivery guarantees (e.g., maximum delay before a new message appears in the transcript view) — no specific latency bound is defined here.

## Open Questions / Assumptions

- Assumed "conversation" in this spec means the full message thread between one end-customer and the client's bot, consistent with how `human-handoff.md` and `tenant-data-isolation.md` use the term.
- Assumed the client views conversations through some client-facing dashboard/interface; the specific interface design and workflow are left to a later phase.
- Assumed near-real-time visibility (new messages appear on next view/refresh) is sufficient; no live-streaming/push-update requirement was specified in the interview.
- Assumed end-customers themselves have no visibility or export rights over their own chat history through this platform (they only interact via WhatsApp, where they naturally retain their own copy on their device) — this was not explicitly addressed in the interview and should be confirmed.
- Assumed conversation search/filtering only needs to support end-customer identity and recency at minimum; richer filtering (by handoff status, date range, keyword content search) is a possible future enhancement not confirmed as required.
- Assumed transcript retention duration follows whatever general conversation-data retention policy applies platform-wide (see `client-offboarding-and-data-retention.md`), rather than this spec defining its own independent retention period.
- Assumed a client can view an in-progress (not yet concluded) conversation, not only completed ones, since WhatsApp conversations have no explicit "end" state.
