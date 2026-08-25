# Message Burst Aggregation

## Purpose

Defines how the system groups an end-customer's rapid consecutive WhatsApp messages into a single conversational turn so that one thought split across several messages — regardless of whether those messages are text, images, or voice notes — produces exactly one bot reply rather than one reply per message.

## Behavioral Requirements

- The system must treat a conversational turn as the unit of work for reply generation: a set of one or more consecutive inbound messages from the same end-customer that are grouped together and answered with a single reply.
- The system must group consecutive inbound messages from the same end-customer into the same turn when each new message arrives within a bounded quiet period ("aggregation window") measured from the most recent inbound message in that turn.
- The system must define the aggregation window as a configurable duration with a sensible platform default, rather than an arbitrary or undocumented value.
- The system must restart the aggregation window each time a further qualifying message from the same end-customer arrives while a turn is still accumulating, so a short pause between messages does not prematurely close the turn.
- The system must enforce an upper bound on how long a single turn may be extended by continued incoming messages, so an end-customer who keeps sending messages in quick succession still eventually receives a reply rather than being starved indefinitely.
- The system must close a turn and proceed to reply generation once either the aggregation window elapses with no further qualifying message, or the maximum turn-extension bound is reached, whichever occurs first.
- The system must accept text messages, images (with or without captions), and voice notes as message types that can each be part of the same burst, understanding each according to its own type per `text-conversation-handling.md`, `image-message-understanding.md`, and `voice-message-understanding.md`.
- The system must combine the understood content of every message in a closed turn — irrespective of the mix of message types it contains — into a single input for generating one reply to that turn.
- The system must combine a mixed-type turn's content correctly regardless of the order in which the message types arrived within the turn (e.g., a voice note followed by text must be combined the same as text followed by a voice note).
- The system must present the messages within a turn to reply generation in the order the end-customer actually sent them.
- The system must produce exactly one reply per closed turn, and must not send a separate reply for each constituent message within that turn.
- The system must not send more than one reply for the same turn, including under retry, delay, or reprocessing conditions that could otherwise cause duplicate reply generation.
- The system must start a new turn for any message that arrives after the reply to the previous turn has already been sent to that end-customer.
- The system must scope turn aggregation to a single end-customer within a single client business's conversation; messages from different end-customers, or from the same end-customer directed at different client businesses, must never be merged into the same turn, consistent with `tenant-data-isolation.md`.
- The system must allow two or more end-customers to have turns accumulating at the same time for the same client business without any cross-contamination of their respective turns.
- The system must contribute every constituent message of a completed turn to the end-customer's conversation context on the same basis as any other message, per `conversation-memory.md`.
- The system must treat the inactivity-based conversation reset window defined in `conversation-memory.md` as an independent, materially longer timer measured from the end-customer's last message, and must not let turn aggregation affect, shorten, extend, or otherwise interfere with reset-window evaluation.
- The system must not aggregate messages that arrive while the bot is off for that client business into a turn that later produces a reply, per `bot-activation-control.md`; such messages are received but do not trigger aggregation toward an automated reply.
- The system must not produce an aggregated reply for messages that arrive while a conversation is paused for human handoff, per `human-handoff.md`, even though those messages continue to be received and retained during the pause.
- The system must resume normal turn aggregation for messages arriving after a handed-off conversation is resumed, per `human-handoff.md`.
- The system must still produce exactly one reply for a turn in which understanding of one or more (but not all) constituent messages failed (e.g., an unintelligible voice note among otherwise-clear text messages), with whether that reply is a fallback governed by `fallback-response-behavior.md`.
- The system must ensure every message that was part of a turn appears individually, in the transcript the client business sees, exactly as it was sent, per `client-conversation-visibility.md`; aggregation changes how a reply is generated, not what is stored or displayed to the client business.

## Acceptance Criteria

- Given an end-customer sends three short text messages a few seconds apart that together form one thought, when the aggregation window elapses after the last of the three, then the bot sends exactly one reply that addresses all three messages together.
- Given an end-customer sends a text message, then an image, then a voice note within the aggregation window of each other, when the turn closes, then the bot sends exactly one reply that reflects the combined understanding of the text, the image, and the voice note.
- Given an end-customer sends the same mixed burst of message types but in a different order (e.g., voice note first, then image, then text), when the turn closes, then the resulting reply reflects the same combined understanding as if the messages had arrived in any other order, with content presented to reply generation in the order actually sent.
- Given an end-customer keeps sending new messages such that each one restarts the aggregation window before it elapses, when the maximum turn-extension bound is reached, then the turn closes and a reply is sent covering everything received up to that point, rather than the customer being left without any reply.
- Given a turn has closed and its reply has already been sent, when the end-customer sends another message, then that message starts a new turn rather than being appended to the reply that already went out.
- Given two different end-customers are messaging the same client business's bot at the same time, when each sends a multi-message burst, then each end-customer receives their own single reply built only from their own messages, with no messages from one end-customer appearing in the other's turn.
- Given two end-customers of two different client businesses send bursts at the same time, when each turn closes, then each burst is aggregated and answered entirely within its own client business's context, per `tenant-data-isolation.md`.
- Given a turn has closed and been replied to, when the client business later reviews that end-customer's conversation, then every individual message that was part of the turn appears separately in the transcript, per `client-conversation-visibility.md`, even though only one reply was sent.
- Given a client business's bot is off when an end-customer sends a burst of messages, when the bot is later turned on, then the messages sent while the bot was off did not trigger an aggregated automated reply at the time they were sent, per `bot-activation-control.md`.
- Given a conversation is paused for human handoff, when the end-customer sends further messages during the pause, then those messages are received and retained but no aggregated reply is produced, and when the conversation is resumed, subsequent messages are aggregated and replied to normally, per `human-handoff.md`.
- Given a turn contains a voice note that cannot be understood alongside clear text messages, when the turn closes, then exactly one reply is still sent for the turn, with its content (normal or fallback) governed by `fallback-response-behavior.md`.
- Given an end-customer's messages are close enough together to fall within the aggregation window, when the turn is evaluated against the separate inactivity reset window defined in `conversation-memory.md`, then the short aggregation wait never itself counts as, or triggers, a conversation reset.

## Out of Scope

- How text, image, or voice-note content is individually understood or interpreted — see `text-conversation-handling.md`, `image-message-understanding.md`, and `voice-message-understanding.md` respectively.
- The inactivity-based or manual conversation context reset policy and its configuration — see `conversation-memory.md`.
- Detection and handling of duplicate or redelivered inbound messages from the transport layer — see `message-delivery-reliability.md`.
- Rate limiting or abuse protection against high-volume or malicious message bursts — explicitly deferred for v1.
- The bot ever sending more than one message of its own for a single turn (e.g., splitting a long reply into several WhatsApp messages) — not addressed by this spec.
- Determining what the bot does when it cannot produce a good/confident answer — see `fallback-response-behavior.md`.
- Pausing or resuming automated replies for a conversation under human handoff — see `human-handoff.md`.
- Turning the bot on or off for a client business — see `bot-activation-control.md`.
- What the client business can see or search in the stored conversation transcript — see `client-conversation-visibility.md`.
- Tenant-level data isolation guarantees beyond ensuring turns are not merged across end-customers or client businesses — see `tenant-data-isolation.md`.

## Open Questions / Assumptions

- The exact default duration of the aggregation window is left open for a later implementation-phase decision; this spec only requires that a sensible default exist and be configurable.
- The exact maximum duration a turn may be extended by continued messages is left open for a later implementation-phase decision.
- Whether the aggregation window (and its maximum extension) should be configurable per client business or fixed platform-wide is left open; this spec assumes a platform-fixed value for v1, applied uniformly to all client businesses, since no client-specific configuration for this behavior was described.
- Whether the bot should send a typing indicator or read receipt to the end-customer while a turn is still accumulating messages is unaddressed by this spec and left for a later decision.
- There is an inherent tension between a longer aggregation window, which lets end-customers finish multi-message thoughts more naturally, and the live-chat responsiveness expectation set in `text-conversation-handling.md`; this spec does not resolve that trade-off beyond requiring that both the window and its maximum extension be deliberately chosen and bounded, not left unbounded or unconsidered.
- Assumes "close together" and "quick succession," as used informally in `voice-message-understanding.md` and `image-message-understanding.md`, refer to the aggregation window defined by this spec, and that this spec is the single source of truth for that boundary.
- Assumes a turn's participating message count has no separate cap beyond the maximum turn-extension time bound (i.e., there is no fixed maximum number of messages per turn independent of time), since no such limit was described.