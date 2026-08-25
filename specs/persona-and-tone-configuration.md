# Persona and Tone Configuration

## Purpose

Defines how a client business configures the identity, personality, and communication style their bot presents to end-customers, without needing developer help. Covers both a structured guided mechanism and an optional freeform text mechanism, and how the two combine.

## Behavioral Requirements

- The system must let a client configure their bot's persona and tone through a structured, guided mechanism made of discrete fields, requiring no prompt-engineering or technical expertise to use.
- The structured mechanism must let the client set the name/identity the bot presents as to end-customers.
- The structured mechanism must let the client set the bot's degree of formality (e.g., a choice along a formal-to-casual spectrum).
- The structured mechanism must let the client set the bot's general communication style/personality traits (e.g., friendly, professional, playful, empathetic) via selectable options.
- The system must also let the client supply freeform instructions text describing persona/tone, as an alternative or supplement to the structured fields.
- The system must allow a client to use only the structured fields, only the freeform text, or both together.
- The system must NOT require a client to use the freeform text mechanism — the structured fields alone must be sufficient to complete persona/tone configuration.
- When both the structured fields and freeform text are provided, the system must apply both as inputs to the bot's presented persona/tone, rather than silently discarding one.
- The system must let the client view their currently configured persona/tone settings (structured fields and freeform text) at any time.
- The system must let the client edit and save changes to persona/tone configuration (structured fields and/or freeform text) at any time.
- The system must let the client clear/reset the freeform text independently of the structured fields.
- The system must validate that required structured fields (at minimum, the bot's presented name) are filled in before persona/tone configuration is considered complete.
- The system must persist the client's persona/tone configuration until the client changes it again.
- The system must apply a saved persona/tone configuration change starting with the bot's next response to any end-customer, without requiring any redeployment or technical action by the client.
- The system must apply the client's persona/tone configuration consistently across all of that client's end-customer conversations — it must not vary by individual end-customer.
- The system must scope each client's persona/tone configuration to that client only — one client can never view or be affected by another client's persona/tone settings.
- The system must treat completion of the minimum required structured fields as satisfying the persona/tone portion of the minimum required configuration referenced by the bot activation readiness gate.
- The system must enforce a reasonable maximum length on the freeform instructions text and communicate that limit to the client.
- The system must enforce a reasonable maximum length on the bot's presented name field.

## Acceptance Criteria

- Given a client who has never configured persona/tone, When the client opens persona/tone configuration, Then the system presents the structured fields (at minimum: bot name, formality level, communication style) in an empty or default state, plus an empty freeform text input.
- Given a client filling in only the structured fields with all required fields completed, When the client saves, Then the system accepts the save and marks persona/tone configuration as complete, with no freeform text required.
- Given a client who fills in only the freeform text and leaves a required structured field (e.g., bot name) empty, When the client attempts to save, Then the system rejects the save and identifies which required structured field is missing.
- Given a client who has completed the required structured fields and also enters freeform text, When the client saves, Then the system accepts both and reflects both when the client reopens the configuration.
- Given a client with an existing persona/tone configuration, When the client changes the bot's presented name and saves, Then the next response the bot sends to any end-customer reflects the new name.
- Given a client with existing freeform tone instructions, When the client clears the freeform text and saves while required structured fields remain filled, Then the system accepts the save and persona/tone configuration remains complete.
- Given a client who has not yet completed the required structured fields, When the client checks bot readiness, Then persona/tone is reported as an unmet condition.
- Given two different clients, When each configures a different bot name and tone, Then each client's end-customers only ever see that client's own configured persona/tone, never the other client's.
- Given a client submitting freeform text longer than the allowed maximum, When the client attempts to save, Then the system rejects the save and communicates the length limit.
- Given a client submitting a bot name longer than the allowed maximum, When the client attempts to save, Then the system rejects the save and communicates the length limit.
- Given a client who saves a persona/tone change mid-conversation with an end-customer, When the bot sends its next reply in that same conversation, Then the reply reflects the updated persona/tone.

## Out of Scope

- Business knowledge content configuration (e.g., product/service facts, FAQs) — see `business-knowledge-configuration.md`.
- Behavior rules and guardrails configuration (e.g., what the bot must never say or do) — see `behavior-rules-configuration.md`.
- The full definition of the bot activation readiness gate and on/off toggle — see `bot-activation-control.md`.
- WhatsApp number connection and verification — see `whatsapp-number-connection.md`.
- Client account creation, signup, and tenant provisioning — see `client-signup-and-tenancy.md`.
- Enforcement of tenant data isolation mechanics beyond the scoping requirement stated here — see `tenant-data-isolation.md`.
- How the bot actually generates responses using the configured persona/tone (underlying processing/model behavior) — not addressed here.
- Per-conversation or per-end-customer persona/tone overrides — not supported; persona/tone is uniform per client in v1.
- Multi-language or localized persona/tone configuration — not addressed here.
- Preset/template persona libraries the client could pick from — not addressed here; only that structured fields and freeform text are supported.
- Versioning or rollback of prior persona/tone configurations — not addressed here.

## Open Questions / Assumptions

- Assumed the minimum required structured field for readiness purposes is at least the bot's presented name; whether formality/communication-style selection is also strictly required (versus defaulted) was not specified in the interview and would need product confirmation.
- Assumed freeform text and structured fields are combined/applied together rather than one overriding the other when both are present; the interview did not specify precedence rules, and this spec intentionally leaves the combination mechanism open, only requiring that neither is silently discarded.
- Assumed reasonable maximum lengths for the name field and freeform text are needed for system stability, but did not specify exact numeric limits, which are left to implementation/product decision.
- Assumed persona/tone configuration is single-valued per client (one bot, one persona) consistent with the single-WhatsApp-number-per-client scope used in sibling specs; multi-bot or multi-persona-per-client scenarios are not addressed.
- Assumed "next response" as the effective-change boundary applies uniformly even to an end-customer's conversation already in progress, per the interview's stated behavioral expectation.
