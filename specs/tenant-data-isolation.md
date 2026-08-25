# Tenant Data Isolation

## Purpose
Guarantee that every client tenant's data, conversations, connections, and bot behavior are fully isolated from every other tenant's, and that access to any tenant's data is limited to that tenant and to only the operator functions explicitly permitted — regardless of what onboarding, configuration, error, or load event is occurring for any other tenant.

## Behavioral Requirements
- Each client's configuration (bot settings, prompts, business rules, integrations) is visible and editable only within that client's own tenant context.
- Each client's conversation history and memory (past messages, extracted facts, session state) is retrievable only in the context of that client's tenant and is never returned, referenced, or blended into another client's conversations or memory.
- Each client's WhatsApp connection (linked number, connection state, credentials/session) is distinct per tenant and cannot be used to send, receive, or read messages on behalf of another tenant.
- Each client's uploaded knowledge documents are usable only by that client's own bot instance and are never retrievable, searchable, or referenceable by another client's bot.
- Each client's usage metrics (message volume, costs, errors, etc.) are computed and reported per-tenant; a metric shown to one client never includes another client's activity.
- An action performed for one client (onboarding a new client, changing that client's configuration, that client's WhatsApp connection dropping or erroring, that client's bot throwing an error, that client's usage spiking) produces no observable change in any other client's data, configuration, connection state, bot behavior, or availability.
- The platform operator can view per-client connection health status and aggregated/per-client usage metrics across all tenants.
- The platform operator cannot view any client's end-customer conversation transcripts, message content, or conversation memory — that content is visible only to the client that owns it.
- A newly onboarded client's tenant is isolated from every existing client from the moment it is created — no setup or propagation delay during which partial visibility or cross-tenant effects occur.
- Isolation guarantees hold for a tenant that is in the process of being offboarded or has been offboarded: other tenants' data, connections, and bot behavior are unaffected by another tenant's offboarding or deletion.
- A failure, crash, error, or resource exhaustion (e.g., runaway usage) in one client's bot instance does not degrade or interrupt service for another client's bot instance.
- No identifier, credential, or reference belonging to one tenant (e.g., WhatsApp connection identifiers, document identifiers, conversation identifiers) is valid for retrieving or acting on another tenant's data, even if guessed, reused, or supplied out of context.

## Acceptance Criteria
- Given two client tenants A and B, when a user with access to tenant A's configuration requests tenant B's configuration through any available access path, then the request is denied or returns no data belonging to tenant B.
- Given two client tenants A and B, when tenant A's bot processes an end-customer conversation, then no data from that conversation appears in tenant B's conversation history, memory, or bot responses, and no data from tenant B appears in tenant A's.
- Given tenant A's WhatsApp number is connected, when tenant B's WhatsApp connection is set up, reconnected, or fails, then tenant A's connection state, message delivery, and message history are unaffected.
- Given tenant A has uploaded knowledge documents, when tenant B's bot answers an end-customer question, then tenant B's bot's response draws only on tenant B's own documents and never surfaces content sourced from tenant A's documents.
- Given tenant A generates a high volume of messages or errors, when tenant B's bot is queried in the same time window, then tenant B's response availability and latency are unaffected by tenant A's load or error state.
- Given the operator is onboarding new client tenant C, when the onboarding process runs (including connecting C's WhatsApp number), then no existing tenant's configuration, connection, conversation data, or bot behavior changes as a result.
- Given the operator views the platform dashboard, when the operator inspects per-client connection health or usage metrics, then the operator sees status and aggregate/per-client numbers only, and cannot open, search, or export any client's end-customer conversation transcripts or message content.
- Given a client is offboarded (per `client-offboarding-and-data-retention.md`), when the offboarding process runs to completion, then every other tenant's configuration, connection, conversation history, documents, and metrics remain unchanged and accessible as before.
- Given a request supplies an identifier (connection ID, document ID, conversation ID, etc.) that belongs to tenant A, when that request is made in a context authenticated as tenant B, then the system denies access rather than returning tenant A's data.
- Given a client's own dashboard or interface, when that client views their conversation history, then they see only their own end-customers' conversations, never another client's.

## Out of Scope
- Deletion mechanics, data retention periods, and offboarding workflow steps — see `client-offboarding-and-data-retention.md`.
- Authentication mechanics for how a client or the operator proves their identity (login, credentials, session management) — isolation here assumes identity is already established and concerns what happens after.
- Specific technical means of enforcing isolation (data partitioning strategy, storage architecture, network segmentation) — intentionally left to a later implementation phase.
- Performance/capacity guarantees beyond "one tenant's load doesn't degrade another's" (e.g., specific throughput or latency SLAs) — covered by any future performance-specific spec.
- Billing and cost-allocation correctness — covered by any future billing-specific spec, though per-tenant metrics visibility is addressed here.

## Open Questions / Assumptions
- Assumed "operator" means the solo operator role only; if additional platform-side staff roles are introduced later, their access should be re-evaluated against this same conversation-transcript restriction.
- Assumed each client business maps to exactly one tenant and one WhatsApp number; multi-number-per-tenant scenarios are not addressed here and may need a follow-up spec if that becomes a supported configuration.
- Assumed "aggregated metrics" visible to the operator means numeric/statistical data only (counts, health status) and never free-text content derived from conversations (e.g., no message excerpts in error logs shown to the operator) — this should be confirmed since bot error diagnostics could otherwise leak conversation content.
- Assumed isolation requirements apply equally to any backups, exports, or archived copies of tenant data, not just live/production data — not explicitly confirmed in the interview.
