# Voice Message Understanding

## Purpose
Enable the chatbot to understand voice notes (audio messages) sent by end-customers on WhatsApp by converting spoken content into a form the AI can reason about, and to incorporate that understanding into its reply as a normal part of the conversation.

## Behavioral Requirements
- The system must accept voice notes received via WhatsApp as a valid message input type, equivalent in standing to text messages.
- The system must convert the spoken content of a received voice note into text (or an equivalent semantic representation) before generating a response.
- The system must treat the transcribed content of a voice note as the customer's message content for purposes of generating the bot's reply, following the same response-generation flow used for text messages.
- The system must support voice notes in the single spoken language configured for the client business.
- The system must respond to a voice note within the same conversation turn, without requiring the customer to also send a text message.
- The system must handle voice notes of varying lengths up to WhatsApp's own voice-note duration limit.
- The system must handle a conversation where voice notes and text messages are interleaved, treating each according to its own type without requiring special sequencing.
- When a voice note is sent as part of a multi-message burst (e.g., alongside text or images in quick succession), the system must incorporate the voice note's understood content together with the other messages when forming a single response, consistent with how the bot handles multi-message bursts generally.
- The system must not expose raw transcription artifacts (e.g., timestamps, confidence scores, filler-word markers) in the reply text sent to the customer.
- The system must be able to process a voice note using any configured AI/transcription provider without requiring changes to this behavior, per `ai-provider-portability.md`.
- When the spoken content of a voice note cannot be adequately understood (e.g., poor audio quality, unclear or unintelligible speech, silence, non-speech audio), the system must handle it as an instance of the bot being unable to produce a good answer, per `fallback-response-behavior.md`.
- When a voice note fails to download, fails to process, or times out during transcription for technical reasons, the system must handle it as an instance of the bot being unable to produce a good answer, per `fallback-response-behavior.md`.
- The system must record that a given customer message was a voice note (as opposed to text or image) in the conversation history used for context, consistent with how other non-text message types are tracked, per `conversation-memory.md`.

## Acceptance Criteria
- Given a customer sends a clear voice note asking a question the bot can answer, when the bot processes the message, then the bot's reply addresses the spoken question as if it had been typed as text.
- Given a customer sends a voice note in the client business's configured spoken language, when the bot processes it, then the transcription/understanding step succeeds and a relevant reply is produced.
- Given a customer sends a voice note followed immediately by a text message continuing the same thought, when the bot processes the burst, then the reply reflects the combined intent of both messages.
- Given a customer sends a voice note with heavy background noise or mumbled speech such that the spoken content cannot be reliably determined, when the bot processes it, then the bot follows the fallback behavior defined in `fallback-response-behavior.md` rather than guessing or fabricating an answer.
- Given a customer sends a voice note that is silent or contains no speech (e.g., accidental recording), when the bot processes it, then the bot follows the fallback behavior defined in `fallback-response-behavior.md`.
- Given a voice note fails to download or the transcription step errors out or times out, when this occurs, then the bot follows the fallback behavior defined in `fallback-response-behavior.md` rather than leaving the customer without any reply.
- Given a customer sends a voice note at the maximum duration WhatsApp allows, when the bot processes it, then the bot still produces a reply grounded in the spoken content (or falls back per `fallback-response-behavior.md` if content cannot be understood).
- Given a conversation with a mix of text, image, and voice-note messages over time, when a later message references something said earlier in a voice note, then that voice note's understood content is available as prior context, per `conversation-memory.md`.
- Given the bot replies to a voice note, when the customer reads the reply, then the reply contains no transcription metadata (timestamps, confidence scores, non-speech tags) — only natural conversational text.

## Out of Scope
- General conversation flow, multi-message burst handling, and turn-taking logic not specific to voice notes — see `text-conversation-handling.md`.
- Conversation history storage, retrieval, and use as context across messages — see `conversation-memory.md`.
- Definition of fallback behavior itself (what the bot says or does when it cannot produce a good answer) — see `fallback-response-behavior.md`.
- Requirements for keeping the AI/transcription provider swappable — see `ai-provider-portability.md`.
- Understanding of images or image content sent via WhatsApp — see `image-message-understanding.md`.
- Understanding of documents or PDF attachments — explicitly out of scope for v1 per product decisions.
- Detection or handling of multiple spoken languages within a single client business's bot — not required for v1.
- Any transcription vendor, model, or specific technical implementation of speech-to-text conversion.
- Voice note sending/generation by the bot itself (bot replies are assumed text-based; voice replies are not addressed by this spec).

## Open Questions / Assumptions
- Assumes WhatsApp's platform-level voice-note duration limit is the only upper bound on length the system needs to accommodate; no separate business-defined cap is assumed.
- Assumes "single language per client business" means the language configured for that business is also the expected spoken language of its customers' voice notes; behavior when a customer speaks a different language is not specified beyond normal fallback handling.
- Assumes voice notes forwarded from other WhatsApp chats (not recorded directly by the customer) are treated identically to originally recorded voice notes, since WhatsApp does not meaningfully distinguish these for bot-consumption purposes.
- Assumes the bot's reply to a voice note is always delivered as text, consistent with sibling specs; no requirement for the bot to send an audio reply.
