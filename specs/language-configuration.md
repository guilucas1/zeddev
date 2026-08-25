# Language Configuration

## Purpose

Defines how a client business selects the single language its bot uses when replying to end-customers, how that language is set by default before the client ever touches the setting, and how the configured language governs bot output across text, voice, fallback, and disclosure without depending on or altering the language the end-customer themselves uses.

## Behavioral Requirements

- The system must let a client business configure exactly one active language for their bot at a time — no auto-detection of end-customer language and no per-conversation language switching are supported.
- The system must let the client select the bot's language themselves, self-service, from a defined set of supported languages, without requiring developer help or operator involvement.
- The system must assign a defined default language to a newly provisioned tenant automatically, so the bot's output language is well-defined before the client ever opens the language setting.
- The system must let the client view their bot's currently configured language at any time, including when it is still set to the system default and has never been explicitly changed.
- The system must let the client change the configured language at any time, without developer help or operator involvement.
- The system must apply a language change starting with the bot's next reply to any end-customer, without requiring any redeployment or technical action by the client.
- The system must apply the language change even to a conversation already in progress with an end-customer, so the very next reply the bot sends in that conversation reflects the newly configured language.
- The system must use the configured language for every bot reply to an end-customer, regardless of message type — replies to text messages, replies to image messages, and replies to voice notes must all be produced in the configured language.
- The system must treat the configured language as the expected spoken language for voice-note understanding, per `voice-message-understanding.md`.
- The system must render the fallback message in the configured language, per `fallback-response-behavior.md`.
- The system must render any bot disclosure statement in the configured language, per `bot-disclosure-setting.md`.
- The system must NOT change the configured language, or the language of any bot reply, based on the language an end-customer writes or speaks in — an end-customer who writes or speaks in a language other than the one configured for that client business must still receive bot replies in the configured language.
- The system must NOT translate or otherwise alter the language of client-authored configuration content (persona/tone freeform text, business knowledge, behavior rules) — a client may author that content in any language they choose, and the configured language governs only the bot's output language, not the language of the client's own inputs.
- The system must scope each client's language configuration to that client's tenant only, isolated per `tenant-data-isolation.md` — one client's configured language must never affect or be visible to another client.
- The system must persist the client's configured language across bot restarts and across changes made to any other configuration area (persona/tone, business knowledge, behavior rules, disclosure setting, and so on).
- The system must NOT include language configuration in the minimum required configuration referenced by the bot activation readiness gate, since a default language is always assigned and the client can reach readiness per `bot-activation-control.md` without ever opening this setting.

## Acceptance Criteria

- Given a newly provisioned tenant that has never opened language configuration, when the client views the language setting, then the system shows the platform's defined default language as the currently configured value, not an empty or undefined state.
- Given a client business, when the client opens language configuration, then the system presents the defined set of supported languages and highlights which one is currently active.
- Given a client business, when the client selects a different supported language and saves, then the system confirms the change and reflects the newly selected language as the current setting.
- Given a client changes the configured language, when the bot sends its next reply to any end-customer (including within a conversation already in progress), then that reply is produced in the newly configured language.
- Given a client business configured for a given language, when an end-customer writes a text message in a different language, then the bot's reply is still produced in the client business's configured language, not the end-customer's language.
- Given a client business configured for a given language, when an end-customer sends a voice note, then the system treats the configured language as the expected spoken language for understanding that voice note, per `voice-message-understanding.md`.
- Given a client business configured for a given language, when the bot's reply to a text, image, or voice message is generated, then the reply text is in the configured language regardless of which message type triggered it.
- Given a client business configured for a given language, when a fallback response is triggered, then the fallback message is rendered in the configured language, per `fallback-response-behavior.md`.
- Given a client business configured for a given language with bot disclosure enabled, when a disclosure statement is sent, then it is rendered in the configured language, per `bot-disclosure-setting.md`.
- Given a client has authored persona/tone freeform text, business knowledge, or behavior rules in a language different from the configured output language, when the bot generates a reply, then the reply is still produced in the configured output language and the client's authored content is not translated or altered by the system.
- Given two different client businesses with different configured languages, when each business's end-customers message their respective bots, then each bot replies only in its own business's configured language, never the other business's.
- Given a client who has completed persona/tone configuration but has never touched language configuration, when the client checks bot readiness per `bot-activation-control.md`, then the unconfigured (default) language setting does not by itself block the client from reaching minimum readiness.
- Given a client's configured language, when the bot restarts or when the client changes any other configuration area (persona/tone, business knowledge, behavior rules, disclosure setting), then the configured language remains unchanged unless the client explicitly changes it.

## Out of Scope

- The mechanism by which the client configures persona/tone, business knowledge, or behavior rules content, and the language(s) in which that content is authored — see `persona-and-tone-configuration.md`, `business-knowledge-configuration.md`, and `behavior-rules-configuration.md`; this spec governs only the bot's output language, not the language of client-authored input.
- Translation of client-authored configuration content into the configured output language, or any other translation feature — explicitly not addressed; the system does not translate client input.
- Detection of the language an end-customer is writing or speaking in, and any behavior that would vary by end-customer language — explicitly not supported; see the single-language requirement above.
- Understanding of voice-note audio content itself (transcription mechanics, handling of unintelligible audio) — see `voice-message-understanding.md`.
- The content and triggers of fallback messages beyond their rendered language — see `fallback-response-behavior.md`.
- The content and triggers of bot disclosure statements beyond their rendered language — see `bot-disclosure-setting.md`.
- The full definition of the bot activation readiness gate and the on/off toggle — see `bot-activation-control.md`.
- Client account creation, signup, and tenant provisioning mechanics — see `client-signup-and-tenancy.md`.
- Enforcement mechanics of tenant data isolation beyond the scoping requirement stated here — see `tenant-data-isolation.md`.
- Support for more than one simultaneously active language per client business, or per-conversation or per-end-customer language overrides — not supported; language is single-valued per client in v1.
- Any specific AI provider's or transcription provider's language-handling capabilities or configuration — see `ai-provider-portability.md`.

## Open Questions / Assumptions

- Assumed the exact set of supported languages is a product decision to be defined at implementation time; this spec only requires that a defined, self-service-selectable set exists.
- Assumed the specific default language value assigned to a newly provisioned tenant is a product decision to be defined at implementation time; this spec only requires that some defined default exists and is visible to the client.
- Left open whether the system should warn a client whose configured knowledge or persona/tone content appears to be written in a language different from the configured output language; this spec does not require such a warning but does not prohibit one either.
- Assumed that when an end-customer speaks or writes in a language the bot cannot adequately understand or respond to in the configured language, that situation is handled as an instance of the bot being unable to produce a good answer, per `fallback-response-behavior.md`, rather than by this spec defining separate behavior.
- Assumed "next response" as the effective-change boundary for a language change applies uniformly even to an end-customer's conversation already in progress, consistent with how `persona-and-tone-configuration.md` and `business-knowledge-configuration.md` treat configuration changes.
- Assumed language configuration, like persona/tone and business knowledge, can be set independently of other readiness conditions (e.g., before the WhatsApp connection is established), consistent with each configuration area being independently manageable.
