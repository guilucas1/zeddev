# Conversation Memory

## Purpose

Defines how the bot maintains and uses context from prior messages in an ongoing WhatsApp conversation with a given end-customer — across text, image, and voice messages — so replies are coherent multi-turn responses rather than isolated, context-free answers, and defines when that context resets to start a fresh conversation, a policy that is configurable per client business.

## Behavioral Requirements

- The bot must use the content and understood meaning of prior messages in an end-customer's ongoing conversation (text content, derived image understanding, and transcribed/understood voice content) when generating a reply to that end-customer's current message.
- The bot must maintain this in-conversation context per individual end-customer, per client business — one end-customer's conversation context must never be used when replying to a different end-customer, and one client business's conversation context must never be used when replying on another client business's WhatsApp number.
- The bot must treat text, image, and voice messages as contributing to the same unified conversation context, regardless of the order or mix in which they were sent.
- The bot must make each client business's reset policy configurable independently of other client businesses; changing one client business's reset policy must not alter the behavior of any other client business's bot.
- The bot must support, at minimum, a time-based inactivity reset policy: when a client business configures an inactivity window, an end-customer's next message after that window has elapsed since their last message starts a fresh conversation context, excluding messages sent before the reset from that fresh context.
- The bot must support a manual reset capability: a client business must be able to explicitly reset a given end-customer's active conversation context on demand, after which the bot's next reply to that end-customer does not draw on context from before the reset.
- The bot must apply whatever reset policy is currently configured for a client business consistently to all of that business's end-customer conversations, unless a manual reset is applied to a specific conversation.
- The bot must determine, for each inbound message, whether it falls within the currently active conversation context or starts a new one, based solely on that client business's configured reset policy.
- A conversation memory reset must affect only what the bot uses as active context for generating replies; it must not delete, hide, or alter the stored conversation transcript available to the client business or any data-retention record.
- The bot must begin a new conversation context with no carried-over context immediately following a reset (whether time-based or manual), such that the first message after a reset is treated as the start of a new conversation for reply-generation purposes.
- The bot must correctly resume using existing conversation context (without resetting) when an end-customer sends a new message before any configured inactivity window has elapsed and no manual reset has occurred.
- Changing a client business's reset policy configuration must apply to conversations going forward without requiring the client business to manually reset every existing active conversation.

## Acceptance Criteria

- Given an end-customer sends a text message referencing something they said in an earlier message in the same ongoing conversation, when the bot replies, then the reply reflects awareness of that earlier message's content.
- Given an end-customer sends an image in one message and later refers to "that photo" or asks a follow-up question about it in a subsequent text message within the same active conversation, when the bot replies, then the reply demonstrates understanding of the earlier image consistent with `image-message-understanding.md`.
- Given an end-customer sends a voice note in one message and later refers to something they said in it within a subsequent message in the same active conversation, when the bot replies, then the reply demonstrates awareness of the voice note's understood content consistent with `voice-message-understanding.md`.
- Given two different end-customers are messaging the same client business's bot at the same time, when the bot replies to each, then neither end-customer's reply is influenced by the other end-customer's conversation content.
- Given two different client businesses each have an end-customer in an ongoing conversation, when the bot replies to each, then neither business's bot uses the other business's end-customer conversation content.
- Given a client business has configured a time-based inactivity reset policy with a specific window, when an end-customer sends a new message after that window has elapsed since their previous message, then the bot's reply does not draw on any context from before the gap, and the bot treats the new message as the start of a fresh conversation.
- Given the same time-based inactivity reset policy, when an end-customer sends a new message before that window has elapsed, then the bot's reply continues to draw on the existing conversation context as if no reset occurred.
- Given a client business triggers a manual reset for a specific end-customer's active conversation, when that end-customer's next message arrives, then the bot's reply does not draw on any context from before the manual reset, while conversations with other end-customers of that same business remain unaffected.
- Given a client business changes its configured reset policy (e.g., from a longer inactivity window to a shorter one, or from automatic to manual-only), when subsequent end-customer messages arrive, then the bot applies the newly configured policy going forward without requiring any manual intervention on existing conversations.
- Given a conversation's context has reset (by inactivity or manual action), when the client business later views that end-customer's conversation transcript per `client-conversation-visibility.md`, then the pre-reset messages are still present and visible in the transcript.
- Given a client business has not configured any reset policy beyond the platform default, when an end-customer's conversation is otherwise idle, then the bot's behavior follows whatever default reset policy applies until the client business configures otherwise.

## Out of Scope

- Understanding the content of a specific message type (parsing text, deriving image understanding, transcribing voice) — see `text-conversation-handling.md`, `image-message-understanding.md`, and `voice-message-understanding.md` respectively.
- Long-term storage, retention duration, and deletion of conversation data for compliance purposes — see `client-offboarding-and-data-retention.md`. A memory reset is distinct from data deletion: resetting what the bot uses as active context does not by itself delete or retract stored history.
- The client business's ability to view, search, or browse end-customer conversation transcripts — see `client-conversation-visibility.md`.
- The user interface, workflow, or mechanism by which a client business configures its reset policy or triggers a manual reset (forms, dashboards, buttons) — not detailed here, only the resulting behavior.
- Turning the bot on or off, or otherwise controlling whether it is active for a given client business or conversation — see `bot-activation-control.md`.
- Determining what the bot does when it cannot produce a good/confident answer — see `fallback-response-behavior.md`.
- Transferring or escalating a conversation to a human agent — see `human-handoff.md`.
- Swappability of the underlying AI provider/model used to generate replies or process messages — see `ai-provider-portability.md`.
- Isolation and security guarantees between tenants beyond conversation-context usage (broader data isolation) — see `tenant-data-isolation.md`.
- Any limit on how much historical context is technically retrievable or how far back memory can extend in the absence of a reset (e.g., token/length limits on very long-running conversations) — not addressed by this spec.

## Open Questions / Assumptions

- The exact set of selectable reset policies a client business can choose from is not fully finalized. This spec assumes, at minimum, a time-based inactivity policy (configurable window) and a manual-reset capability must both be supported, since the client needs some way to configure their choice. Whether a "never reset automatically (full history always in context)" option, or other policy types, are also offered is flagged as open for the client/operator to finalize during planning.
- Assumes there is a sensible default reset policy (e.g., a default inactivity window) applied to a client business that has not explicitly configured one, so the bot has well-defined behavior from day one; the specific default value is left open for a later phase.
- Assumes "ongoing conversation" and "end-customer" are identified by the end-customer's WhatsApp identity (e.g., their phone number) in relation to a specific client business's WhatsApp number; no other identity-merging or cross-number linking is assumed.
- Assumes a memory reset is instantaneous and applies at the point it is triggered (window elapsed, or manual action taken) — it does not retroactively affect replies already sent before the reset occurred.
- Assumes that when an inactivity window is configured, "inactivity" is measured from the end-customer's last message (not the bot's last reply), since the trigger described in the interview is "no messages from that end-customer."
- Assumes conversation memory reset settings are a single configuration per client business (not per end-customer segment or per topic), consistent with how other per-business configuration (persona, tone, knowledge) is scoped in sibling specs.
