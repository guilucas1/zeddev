# Human Handoff

## Purpose

Defines how an in-progress conversation is detected as needing a human, how the client business is notified, and how the bot's automated replies are paused for that specific conversation until it is resumed back to the bot.

## Behavioral Requirements

- The system must allow each client to independently enable or disable human handoff for their bot.
- The system must NOT trigger a handoff for a client who has handoff disabled; the bot must instead follow fallback behavior as defined in `fallback-response-behavior.md`.
- The system must allow a client with handoff enabled to configure what conditions trigger a handoff for their bot, rather than relying on a single fixed, non-configurable trigger list.
- The system must support, at minimum, an explicit end-customer request to speak to a person as a triggerable handoff condition.
- The system must support, at minimum, detection of a complaint as a triggerable handoff condition.
- The system must support, at minimum, detection that the incoming message falls outside what the bot is configured to handle as a triggerable handoff condition.
- The system must evaluate handoff-trigger conditions on a per-conversation basis, using the content and context of that specific conversation.
- The system must, when a handoff trigger fires for a conversation, notify the client business that the conversation needs human attention.
- The system must include, in the handoff notification, enough context (e.g., which conversation/end-customer and why it was flagged) for the client to identify and act on it.
- The system must, when a conversation is handed off, pause automated bot replies for that specific conversation only.
- The system must continue automated bot handling, unaffected, for all other conversations belonging to the same client while one conversation is paused for handoff.
- The system must NOT send any further automated reply into a paused (handed-off) conversation until that conversation is resumed to the bot.
- The system must still receive and retain incoming end-customer messages for a paused conversation while it is paused, even though the bot does not auto-reply to them.
- The system must provide a way for the client business to resume automated bot handling of a handed-off conversation.
- The system must provide a way for the bot/system to resume automated bot handling of a handed-off conversation (e.g., as a result of a defined resumption condition), in addition to client-initiated resumption.
- The system must, upon resumption, return the conversation to normal automated handling so subsequent eligible end-customer messages receive automated bot replies again.
- The system must reflect, at any time, whether a given conversation is currently paused for handoff or under normal automated handling, in a way the client can check.
- The system must record when a conversation was handed off, what triggered it, and when/how it was resumed.
- The system must treat handoff state as scoped to a single conversation, not to the client's bot as a whole or to the end-customer across all their conversations, unless the client's trigger configuration explicitly says otherwise.
- The system must apply the client's current handoff enabled/disabled setting and trigger configuration to new trigger evaluations; changing the setting must not retroactively alter the paused/active state of conversations already handed off.

## Acceptance Criteria

- Given a client with handoff disabled, When an end-customer message would otherwise match a handoff condition, Then no handoff occurs and the bot instead follows the fallback behavior defined in `fallback-response-behavior.md`.
- Given a client with handoff enabled and default or configured trigger conditions, When an end-customer explicitly asks to speak to a person, Then the conversation is flagged for handoff.
- Given a client with handoff enabled, When an end-customer message is detected as a complaint, Then the conversation is flagged for handoff.
- Given a client with handoff enabled, When an end-customer message falls outside what the bot is configured to handle, Then the conversation is flagged for handoff.
- Given a client who has customized their handoff trigger conditions, When an end-customer message matches one of the client's configured conditions, Then the conversation is flagged for handoff according to that configuration.
- Given a conversation that triggers handoff, When the trigger fires, Then the client business receives a notification that identifies the conversation and the reason it was flagged.
- Given a conversation that has been handed off, When further end-customer messages arrive in that same conversation before resumption, Then the bot does not send any automated reply into that conversation, but the messages are still received and retained.
- Given a client with multiple concurrent conversations and one conversation handed off, When end-customers in the other conversations message the bot, Then the bot continues to auto-respond normally in those other conversations.
- Given a handed-off conversation, When the client business resumes it, Then the bot resumes auto-responding to subsequent eligible messages in that conversation.
- Given a handed-off conversation, When a defined bot/system-side resumption condition is met without client action, Then the bot resumes auto-responding to subsequent eligible messages in that conversation.
- Given any conversation, When the client checks its status, Then the system shows whether it is currently paused for handoff or under normal automated handling.
- Given a conversation that was handed off and later resumed, When the client reviews the conversation's history, Then the system shows when it was handed off, what triggered it, and when/how it was resumed.
- Given a client who disables handoff entirely, When a conversation was already paused for handoff before the change, Then that conversation remains paused until explicitly resumed; the disable action does not silently reactivate the bot on it.

## Out of Scope

- The bot's behavior when handoff is off or unavailable — see `fallback-response-behavior.md`.
- The specific channel or technology used to deliver the handoff notification to the client business (e.g., email, push, in-app) — intentionally left open.
- The specific interface, workflow, or tooling the client uses to view, respond to, or manage handed-off conversations beyond resuming them — not addressed here.
- Any capability for a human at the client business to send messages into the conversation through the system, as opposed to handling it via WhatsApp directly — not addressed here.
- The exhaustive, fixed list of conditions that trigger a handoff — this spec establishes the capability and configurability, not a final trigger catalog.
- Bot activation/deactivation of the client's bot as a whole — see `bot-activation-control.md`.
- General text conversation handling and message processing outside of handoff triggering and pausing — see `text-conversation-handling.md`.
- Tenant data isolation guarantees for handoff-related records — see `tenant-data-isolation.md`.
- Billing, staffing, or operational aspects of how the client business actually handles a conversation once handed off — not addressed here.

## Open Questions / Assumptions

- Assumed the minimum built-in trigger set is "explicit request for a human," "complaint," and "message outside what the bot is configured to handle," per the product context's examples; the exact detection logic for each is left open.
- Assumed handoff state and trigger configuration are scoped per client (tenant), consistent with other specs in this project, and that trigger configuration is itself client-editable at any time.
- Assumed resumption can be initiated either by the client business or by a defined bot/system-side condition (e.g., a timeout or an automated re-check), per the interview decision to describe resumption behaviorally without prescribing mechanism; the exact bot-side resumption condition(s), if any, are left to a later phase.
- Assumed handoff state is scoped to a single conversation by default, with no cross-conversation "this end-customer is always escalated" behavior unless the client explicitly configures it that way; this was not explicitly addressed in the interview.
- Assumed incoming messages during a paused conversation are still stored/retained (not dropped) so the human handling the conversation and the eventual resumed bot have full context; this was not explicitly stated in the interview but follows from the requirement that only automated replies are paused.
- Assumed changing the handoff enabled/disabled setting or trigger configuration is not retroactive to already-paused conversations; this was inferred to avoid unexpected reactivation and was not explicitly addressed in the interview.
