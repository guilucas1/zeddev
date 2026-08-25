# Business Knowledge Configuration

## Purpose

Defines how a client business supplies factual, informational knowledge about their business (offerings, policies, FAQs, and similar facts) so their bot can answer end-customers accurately, and how that knowledge stays current and grounds the bot's responses.

## Behavioral Requirements

- The system must let a client enter business knowledge as freeform text, written in their own words, without any required structure or template.
- The system must let a client upload one or more documents (e.g., FAQ sheets, reference documents) for the bot to draw on as business knowledge.
- The system must let a client use freeform text and document upload together, and must not force a choice between the two — a client may rely on either mechanism alone or both in combination.
- The system must let a client add, edit, and remove freeform text knowledge entries after initial setup.
- The system must let a client add and remove uploaded documents after initial setup.
- The system must let a client view a list of all currently configured knowledge (freeform text entries and uploaded documents) for their bot.
- The system must confirm to the client when a freeform text entry or document upload has been successfully saved and is available to the bot.
- The system must reject a document upload that fails to process (e.g., unreadable or unsupported) and tell the client the upload did not succeed, without silently discarding it.
- The system must produce bot responses to end-customers that are consistent with the client's currently configured business knowledge and do not contradict facts the client has provided.
- The system must apply a configuration change (addition, edit, or removal of knowledge) starting with the bot's next response to any end-customer after the change is saved — no separate publish or deploy step is required by the client.
- The system must let each client configure business knowledge independently, with one client's configured knowledge never appearing in or affecting another client's bot responses.
- The system must let a client leave business knowledge unconfigured (empty) and still be able to reach the minimum readiness state defined in `bot-activation-control.md`, since business knowledge is not part of the minimum required configuration.
- The system must indicate to the client, in the bot status or configuration area, whether business knowledge has been configured, so the client can recognize it as an optional-but-recommended step distinct from required minimum configuration.

## Acceptance Criteria

- Given a client with no business knowledge configured, When the client opens the business knowledge section, Then the system shows an empty state and lets the client add knowledge via freeform text or document upload.
- Given a client, When the client writes a freeform text knowledge entry (e.g., "We offer free delivery within 10km") and saves it, Then the system confirms the save and the entry appears in the client's list of configured knowledge.
- Given a client, When the client uploads a valid FAQ or reference document, Then the system confirms the upload succeeded and the document appears in the client's list of configured knowledge.
- Given a client, When the client uploads a file that cannot be processed, Then the system reports the failure to the client and the document does not appear as an active knowledge source.
- Given a client with both freeform text entries and uploaded documents configured, When an end-customer asks a question answerable from either source, Then the bot's response draws on the configured knowledge and does not contradict it.
- Given a client has configured a fact (e.g., "store hours are 9am-6pm"), When an end-customer asks about that fact, Then the bot's response does not state a conflicting fact (e.g., different hours).
- Given a client edits or removes a previously configured knowledge entry, When the client saves the change, Then the next end-customer message answered afterward reflects the updated knowledge, without requiring any additional action from the client.
- Given a client removes a document that was the sole source of a fact, When an end-customer subsequently asks about that fact, Then the bot no longer asserts that fact as configured knowledge.
- Given a client with zero business knowledge configured, When the client checks bot readiness per `bot-activation-control.md`, Then the absence of business knowledge does not by itself block the client from reaching minimum readiness.
- Given a client with zero business knowledge configured, When the client views their bot status, Then the system indicates business knowledge is unconfigured and presents it as recommended but not required.
- Given two different clients, When each configures their own distinct business knowledge, When each client's end-customers message their respective bot, Then each bot's responses reflect only that client's own configured knowledge.
- Given a client, When the client views their configured knowledge list, Then the system shows both freeform text entries and uploaded documents together in a way the client can review and manage.

## Out of Scope

- Persona, tone, and communication style configuration — see `persona-and-tone-configuration.md`.
- Behavior rules, guardrails, and topics the bot must avoid or escalate — see `behavior-rules-configuration.md`.
- The overall readiness gate and on/off activation toggle for the bot — see `bot-activation-control.md`.
- Connecting or syncing knowledge from live external systems (e.g., a real-time inventory, pricing, or CRM system) — out of scope for v1; only freeform text and uploaded documents are supported knowledge sources.
- Structured wizard-style entry for specific fact fields (e.g., dedicated hours-of-operation or address fields) — may be addressed in a future spec; this spec covers only freeform text and document upload.
- How the bot handles questions it cannot answer from configured knowledge — see `fallback-response-behavior.md`.
- Tenant-level data isolation guarantees underlying per-client knowledge separation — see `tenant-data-isolation.md`.
- Specific document file formats, size limits, or number-of-documents limits — left as an open question below and to implementation.
- Any retrieval, indexing, or embedding mechanism used to ground bot responses in configured knowledge — intentionally unspecified; only the observable behavior (consistency, non-contradiction) is required.
- Versioning or history of past knowledge edits, and any client-facing audit trail of changes — not addressed here.
- Translation or multi-language handling of knowledge content — not addressed here.

## Open Questions / Assumptions

- Assumed business knowledge is optional at minimum readiness (per `bot-activation-control.md`, only persona/tone is required at minimum); this spec treats business knowledge as recommended but not gating, and flags that decision as an assumption rather than an explicit interview decision.
- Assumed no hard limit on the number of freeform text entries or documents a client may configure; actual limits (if any, e.g., for cost or performance control) are left to implementation.
- Assumed common office/text document formats (e.g., PDF, Word, plain text) are acceptable for upload; exact supported formats and maximum file size are not specified here and are left open.
- Assumed "grounded in configured knowledge" means the bot must not contradict configured facts, not that the bot is forbidden from answering using general knowledge when nothing configured is relevant — the precise boundary between general knowledge and configured-only answers is left to `fallback-response-behavior.md`.
- Assumed a client can configure knowledge before their WhatsApp number is connected (i.e., knowledge configuration does not itself depend on any other readiness condition), consistent with each configuration area being independently manageable.
- Assumed "next response" for applying changes means the very next automated message the bot sends to any end-customer after the save, with no caching or propagation delay visible to the client; exact technical timing is left to implementation.
