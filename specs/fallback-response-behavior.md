# Fallback Response Behavior

## Purpose

Defines what the bot must do when it cannot produce a good answer to an end-customer message — due to an AI/system error, low confidence, or an out-of-scope question — and human handoff is off or unavailable. Fallback is client-configurable per business and must stay within that business's configured persona and tone.

## Behavioral Requirements

- The system must allow each client business to configure its own fallback message text, independent of every other client business.
- The system must allow each client business to configure more than one fallback message variant, where multiple variants exist, for different fallback triggers (AI/system error, low confidence, out-of-scope question), if the client chooses to differentiate them; a single shared fallback message must also remain a valid configuration.
- The system must apply a platform-default fallback message for any fallback trigger the client has not explicitly configured, so the bot never sends a blank or missing reply.
- The system must trigger fallback behavior whenever the bot cannot produce a response it can send with acceptable confidence, regardless of the underlying cause (AI/system error, low confidence in the generated answer, or the message falling outside the scope the client configured the bot to handle).
- The system must trigger fallback behavior independently of human handoff configuration — fallback must fire the same way whether human handoff is enabled, disabled, or simply unavailable at that moment, whenever handoff is not the path actually taken for that message.
- Where human handoff is enabled and available, the system must route to handoff behavior as defined in `human-handoff.md` instead of, or in addition to, sending the fallback message, per that spec's rules; this spec governs only the case where handoff is not the path taken.
- The system must render the fallback message consistent with the client business's configured persona and tone as defined in `persona-and-tone-configuration.md`.
- The system must apply the client business's configured behavior rules (e.g., restricted topics, required disclaimers) as defined in `behavior-rules-configuration.md` when generating or sending a fallback response.
- The system must send exactly one fallback response per end-customer message that triggers fallback, not a duplicate or multiple messages.
- The system must be able to send a fallback response even when the AI generation step itself has failed or errored, using a non-AI-generated (pre-configured or default) message, so a system error does not result in silence.
- The system must let the client business preview their configured fallback message(s) before they take effect for end-customers.
- The system must let the client business edit or update their configured fallback message(s) at any time, with changes taking effect for subsequent end-customer messages.
- The system must record that a fallback response was sent for a given end-customer message, including which trigger caused it (error, low confidence, out-of-scope), so the client business can review fallback occurrences.
- The system must not attempt to answer the end-customer's question using unconfigured or fabricated information as a substitute for triggering fallback.

## Acceptance Criteria

- Given a client business has configured a custom fallback message, when their bot cannot produce a good answer and handoff is not taken, then the end-customer receives that client's custom fallback message, not a generic platform message.
- Given a client business has not configured any fallback message, when their bot cannot produce a good answer and handoff is not taken, then the end-customer receives the platform-default fallback message.
- Given a client business has configured distinct fallback messages for error, low-confidence, and out-of-scope triggers, when each trigger occurs independently, then the end-customer receives the message matching that specific trigger.
- Given a client business has configured only one shared fallback message, when any of the three triggers occurs, then the end-customer receives that same shared message.
- Given the AI generation step fails outright (system error), when fallback is triggered, then the end-customer still receives a fallback response rather than no response.
- Given human handoff is enabled and available for a client business, when the bot cannot produce a good answer, then the message is routed per `human-handoff.md` and this spec's fallback message is not the behavior exercised.
- Given human handoff is disabled or unavailable for a client business, when the bot cannot produce a good answer, then the end-customer receives the configured fallback message.
- Given a client business has configured a persona/tone profile, when a fallback message is sent, then its wording is consistent with that configured persona and tone.
- Given a client business has configured behavior rules (e.g., a required disclaimer), when a fallback message is sent, then those rules are applied to the fallback message.
- Given a fallback response is sent for an end-customer message, when the client business reviews activity, then a record exists showing a fallback occurred and which trigger caused it.
- Given a client business edits their configured fallback message, when a subsequent message triggers fallback, then the updated message is what gets sent (not the prior version).
- Given a client business previews a configured fallback message, when they view the preview, then it renders the same content and tone the end-customer would actually receive.
- Given a single end-customer message triggers fallback, when the bot responds, then only one fallback message is sent for that message, not multiple.

## Out of Scope

- Whether, when, and how the bot offers or executes a handoff to a human — see `human-handoff.md`.
- Defining or configuring the client's persona and tone system itself — see `persona-and-tone-configuration.md`.
- Defining or configuring the client's general behavior rules system itself — see `behavior-rules-configuration.md`.
- Rate-limiting, spam, or abuse protection — explicitly out of scope for v1 and not to be conflated with error-driven or confidence-driven fallback.
- How confidence is scored or what threshold counts as "low confidence" — a scoring/detection mechanism is assumed to exist upstream and feed into this behavior, not defined here.
- How scope/topic boundaries are defined or detected for a client business (i.e., what counts as "out of scope") — assumed to be produced by a separate configuration/detection concern, not defined here.
- Notification of the client business or operator when fallback occurs (e.g., alerts) — not addressed by this spec beyond the record-keeping requirement above.
- Analytics, reporting dashboards, or trend analysis over fallback occurrences beyond the basic per-occurrence record.
- Multi-language fallback message variants — not addressed; assumed to be covered, if needed, by whatever general localization/language spec governs client-configured content.

## Open Questions / Assumptions

- Assumed a platform-default fallback message exists as a system-wide fallback-of-last-resort for any client that has not configured their own; exact default wording is not specified here and is left open.
- Assumed "cannot produce a good answer" is determined by an upstream confidence/error/scope-detection mechanism whose thresholds and logic are out of scope for this spec; this spec only defines what happens once that determination is made.
- Assumed a client business can leave fallback triggers undifferentiated (one message for all triggers) as a valid, supported configuration state, not just a transitional one.
- Assumed "preview" is a distinct, lightweight capability (view configured text/tone) rather than a full end-to-end test conversation; if a live test-send capability is desired, that may need its own spec.
- Assumed fallback and human handoff are mutually exclusive per message (one or the other is the path taken for a given failed message), not both firing simultaneously; open question whether a client might want the fallback message plus a handoff notice together.
- Assumed the record of a fallback occurrence (trigger type, timestamp, which message) is retained indefinitely alongside other conversation history rather than having its own retention policy; retention itself is not defined here.
