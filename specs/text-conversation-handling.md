# Text Conversation Handling

## Purpose

Defines how the bot interprets an end-customer's incoming WhatsApp text message and produces a helpful, relevant, AI-generated text reply that reflects the client business's configured persona, tone, knowledge, and rules, without any code written by the client business.

## Behavioral Requirements

- The bot must accept free-form text messages of any length WhatsApp permits and treat the message content as the primary input for generating a reply.
- The bot must generate a reply written in natural, coherent sentences appropriate to a WhatsApp chat (not a code snippet, not a raw data dump, not a templated form unless the client business's configuration specifies templated replies).
- The bot must generate a reply that is topically relevant to the end-customer's message — addressing what was asked or stated, not a generic non-sequitur.
- The bot's reply must reflect the client business's configured persona and tone (e.g., formal vs. casual, brand voice) as set through that business's configuration, without requiring the client business to write code.
- The bot's reply must draw on and stay consistent with the client business's configured business knowledge (e.g., offerings, policies, facts about the business) when the end-customer's message relates to that knowledge.
- The bot's reply must respect the client business's configured behavioral rules (e.g., topics to avoid, required disclaimers, response constraints) when generating a reply.
- The bot must generate its reply in the single language configured for that client business, regardless of the language the end-customer wrote in.
- The bot must be able to receive and respond to a text message at any time of day, any day of the week, with no business-hours restriction, whenever the bot is activated for that client business.
- The bot must generate a reply for each qualifying inbound text message without a human at the client business having to write, review, or approve the reply before it is sent, under normal operation.
- The bot must produce a reply within a time frame consistent with a live chat conversation (i.e., the end-customer should not perceive the conversation as broken or abandoned).
- The bot's behavior configuration (persona, tone, knowledge, rules) is scoped per client business — one client business's configuration must not influence the replies sent to another client business's end-customers.
- The bot must handle text messages containing common WhatsApp text elements (emoji, line breaks, punctuation-heavy text, mixed casing) without failing to produce a reply.
- If generating a reply fails outright (e.g., no response could be produced), the bot must not send a broken, empty, or malformed message to the end-customer.

## Acceptance Criteria

- Given an activated client business and an end-customer sends a plain text WhatsApp message asking a question covered by that business's configured knowledge, when the bot processes the message, then the end-customer receives a text reply that correctly addresses the question using that configured knowledge.
- Given two different client businesses with different configured personas (e.g., one formal, one casual), when each receives a similar end-customer message, then each bot reply reflects its own business's configured persona and the replies are noticeably different in tone.
- Given a client business configured for a single language (e.g., Portuguese), when an end-customer sends a message in a different language, then the bot's reply is still produced in the client business's configured language.
- Given an end-customer sends a text message at any hour of any day to an activated bot, when the message is received, then the bot generates and sends a reply without regard to time of day or day of week.
- Given a client business has configured a behavioral rule (e.g., "never discuss pricing of competitor products"), when an end-customer's message would otherwise prompt the bot to violate that rule, then the bot's reply complies with the rule instead.
- Given an end-customer sends a text message containing emoji, unusual punctuation, or line breaks, when the bot processes it, then the bot still produces a coherent, relevant text reply.
- Given the bot cannot generate any reply for a given inbound message, when this occurs, then no empty, malformed, or placeholder-broken message is sent to the end-customer (the absence of a usable reply is handled per `fallback-response-behavior.md`, not by sending broken output).
- Given an end-customer sends a text message, when the bot replies, then the reply is sent back as a text message on the same WhatsApp conversation thread the end-customer messaged from.

## Out of Scope

- Understanding image messages — see `image-message-understanding.md`.
- Understanding voice notes / audio messages — see `voice-message-understanding.md`.
- Remembering prior messages or maintaining multi-turn context within or across conversations — see `conversation-memory.md`.
- Determining what the bot does when it cannot produce a good/confident answer (fallback wording, escalation triggers) — see `fallback-response-behavior.md`.
- Transferring or escalating a conversation to a human agent — see `human-handoff.md`.
- The mechanisms by which a client business configures persona, tone, knowledge, and rules (forms, UI, onboarding flow) — covered by sibling configuration specs, not detailed here.
- Turning the bot on/off or otherwise controlling whether it is active for a given client business or conversation — see `bot-activation-control.md`.
- Disclosing to the end-customer that they are talking to a bot rather than a human — see `bot-disclosure-setting.md`.
- Swappability of the underlying AI provider/model — see `ai-provider-portability.md`.
- Rate-limiting or abuse protection against high message volume or malicious input — explicitly deferred for v1.
- Handling of non-text WhatsApp message types (documents, location pins, contact cards, stickers, reactions) beyond acknowledging they are out of this spec's scope.

## Open Questions / Assumptions

- Assumes "text message" includes standard WhatsApp text and emoji, but excludes WhatsApp-native non-text objects (stickers, location, contacts, documents), which are treated as a separate concern not covered here.
- Assumes each client business is configured with exactly one active persona/tone/knowledge/rule set at a time (no per-conversation or per-segment variation within a single business) — not stated explicitly in the interview but implied by "client business's configured persona/tone/knowledge/rules" being singular per business.
- Assumes "reasonable live-chat response time" is the intended latency bar since no specific numeric SLA was provided in the interview; a concrete target (e.g., seconds) is left for a later implementation-phase decision.
- Assumes reply delivery format is plain WhatsApp text (no rich media, buttons, or quick replies) since this spec is scoped to text-in/text-out; richer WhatsApp message formatting is not addressed.
- Assumes the bot always attempts a reply to every qualifying inbound text message while activated (no per-message opt-out or muting logic), since no such mechanism was mentioned in the decisions provided.
