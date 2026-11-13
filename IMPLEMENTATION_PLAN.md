# Implementation Plan

**Status as of 2026-09-19:** P0 is complete, including container definitions. The P1 control plane now has
identity, mail, and `services/api`: identity is reachable over HTTP, verification and reset mail is
actually delivered, and the platform operator can be bootstrapped. At the API increment, `src/` held fifteen
workspace packages — fourteen dependency-free libraries (`@zeddev/errors`, `@zeddev/time`, `@zeddev/secrets`,
`@zeddev/logging`, `@zeddev/config`, `@zeddev/testing`, `@zeddev/db`, `@zeddev/schema`, `@zeddev/queue`,
`@zeddev/tenancy`, `@zeddev/storage`, `@zeddev/identity`, `@zeddev/mail`, `@zeddev/deployment`) plus the
first deployable service, `@zeddev/api` (`src/services/api`) — and 522 passing tests, zero skipped, of
which a growing share run against a real PostgreSQL, a real S3-compatible object storage server (MinIO),
and a real SMTP server (Mailpit). Persistence, migrations, and database-enforced tenant isolation are in
place and proven by cross-tenant negative tests. A durable, tenant-fair job queue is in place, with
per-partition FIFO ordering, lease-based at-least-once delivery, and a dead-letter path. Object storage is
done: an S3-compatible port, a hand-written SigV4 signer, a real adapter, and an in-memory fake proven
against the real one by a shared conformance suite. `@zeddev/identity` covers signup, transactional tenant
provisioning, email verification, client and operator authentication as two non-overlapping identity
spaces, sessions with both expiry bounds, logout, password change, self-service reset, failed-attempt
lockout, the audit trail, and the action→principal permission table — all tested against a real
PostgreSQL. See §4f. `@zeddev/mail` is a hand-written SMTP adapter behind a single-recipient, plain-text
port. See §4g. `services/api` is a hand-written HTTP service over `node:http` that wires both of them
together: signup, email verification (and resend), password reset, and client and operator sessions —
plus startup preflights, migrations at startup, and a `create-operator` CLI that reads the password from
stdin. See §4h.

Container definitions are done: a Dockerfile per service, `compose.yaml` for laptop and VPS, and the
generated environment-variable reference at `docs/configuration.md`. The whole stack — Postgres, the API
service, and optionally Mailpit — was verified by actually running it in a temporary Compose project: see
§4h.

Run `npm run db:up`, `npm run storage:up`, and `npm run mail:up`, then `npm run check`, before assuming any
of the above still holds. `npm run check` now *refuses* to pass without a database, an object storage server,
and an SMTP server,
because the database- and storage-backed suites are where every tenant isolation guarantee is verified
and a green run without them proves considerably less than it looks.

Persona and tone — the only configuration that gates readiness besides connectivity — is done as a new
domain library, `@zeddev/bot`, with the first tenant-scoped routes in `services/api` (`GET`/`PUT
/v1/bot/persona`, `DELETE /v1/bot/persona/freeform-instructions`). See §4i.

Readiness evaluation and the go-live toggle (`bot-activation-control.md`) are now done too, together with
the WhatsApp connection *state machine* — not the Meta connection flow, which is still P2 — as a new
library, `@zeddev/whatsapp`, migrations `0006_whatsapp_connection` and `0007_bot_activation`, and six new
API routes. That makes seventeen workspace packages and 595 passing tests, zero skipped. 15 of 27 specs now
have covering tests, 261 spec-linked assertions. See §4j.

Behavior rules configuration (`behavior-rules-configuration.md`) is done too: structured rules plus
freeform instructions, both rendered into the prompt by `behaviorDirectives`, migration
`0008_bot_behavior_rules`, and seven new API routes. See §4k. That brings the totals to 626 passing tests,
zero skipped, 16 of 27 specs with covering tests, 278 spec-linked assertions.

Fallback message configuration (`fallback-response-behavior.md`) is done too: per-trigger and shared
messages with a platform default per trigger, resolved by one function (`resolveFallbackMessage`) shared by
the reply-path entry point and preview, migration `0009_bot_fallback_messages`, and three new API routes.
See §4l. That brings the totals to 647 passing tests, zero skipped, 16 of 27 specs with covering tests, 288
spec-linked assertions. (The pre-increment "16 of 27" figure recorded below was itself an overcount by one;
16 of 27 is also the correct post-increment count.)

The bot disclosure setting (`bot-disclosure-setting.md`) is done too: two modes, a platform default of
"disclose" for a tenant that never chose (no row seeded), the prompt section rendered by
`disclosureDirectives`, migration `0010_bot_disclosure`, and `GET`/`PUT /v1/bot/disclosure`. See §4m. That
brings the totals to 664 passing tests, zero skipped, 17 of 27 specs with covering tests, 297 spec-linked
assertions.

Human handoff configuration (`human-handoff.md`, the configuration half) is done too: enable/disable, the
three built-in triggers, client-written conditions, a platform default of "disabled, all three triggers
selected" for a tenant that never saved, the prompt section rendered by `handoffDirectives`, and the single
handoff-or-fallback decision `resolveHandoffSignal`. Migration `0011_bot_handoff_settings` and three API
routes. See §4n. That brings the totals to 683 passing tests, zero skipped, 18 of 27 specs with covering
tests, 303 spec-linked assertions.

The freeform-entries half of business knowledge configuration (`business-knowledge-configuration.md`) is done
too: add/edit/remove of unstructured entries, the listing, the prompt section rendered by
`knowledgeDirectives`, and a "recommended but not required" knowledge summary on the bot status. Migration
`0012_bot_knowledge_entries` and four API routes. See §4o. That brings the totals to 702 passing tests, zero
skipped, 18 of 27 specs with covering tests, 316 spec-linked assertions. (The "18 of 27" recorded after the
handoff increment was an overcount by one: `npm run spec-coverage` reported 17 before this increment.)

The AI provider port (`ai-provider-portability.md`) is done as a new library, `@zeddev/ai`: declared
capabilities (text, vision, audio), a registry keyed by provider name, configuration-driven selection
(`AI_*` keys), two real adapters — Gemini `generateContent` and OpenAI-compatible `/chat/completions` +
`/audio/transcriptions` — an in-memory fake, and one conformance suite run against all three. See §4p. That
brings the totals to 785 passing tests, zero skipped, 20 of 27 specs with covering tests, 347 spec-linked
assertions.

Prompt assembly and the reply output protocol are done in `@zeddev/bot` (`reply.ts`): `replyInstructions`
composes every directive renderer in a fixed order, `interpretReply` reads the model's tagged answer
(`[reply]` / `[handoff] …` / `[fallback] …`) into a decision, and `generateReply` is the single function the
future conversation worker and the new `POST /v1/bot/preview` both call, which closes behaviour-rules AC16.
`services/api` now loads `AI_*` and exposes the active provider to the operator (`GET
/v1/operator/ai-provider`, ai-provider-portability AC8). See §4q. That brings the totals to 808 passing tests,
zero skipped, 21 of 27 specs with covering tests, 359 spec-linked assertions.

The inbound half of message delivery is done: a new service, `services/whatsapp-gateway`, verifies Meta's
webhook signature, attributes each notification to a tenant by its receiving number, stores each message
exactly once (the stored row *is* the duplicate-suppression record), and schedules it on the durable queue in
the same transaction before acknowledging. Migration `0013_whatsapp_inbound` adds a fifth RLS scope
(`app.inbound_scope`), number routes, inbound messages, and a rejection log; `@zeddev/http` now holds the
shared bounded body reader. See §4r. That brings the totals to 836 passing tests, zero skipped, 21 of 27 specs
with covering tests, 376 spec-linked assertions.

The conversation worker is done too: a new library, `@zeddev/conversation`, turns bursts of inbound messages
into conversational turns, assembles per-customer memory for the model, and records exactly one outcome per
turn; a new service, `services/conversation-worker`, consumes the queue `services/whatsapp-gateway` schedules
onto. Migration `0014_conversation_turns` adds `conversations` (one lock row per end-customer per tenant),
`conversation_turns`, `inbound_dispositions`, `conversation_turn_outcomes` (the pending outbox the future
outbound sender drains), and `conversation_handoff_events`. A new route,
`POST /v1/conversations/handoff/resume`, lets a client resume a paused conversation. Alongside it, a queue fix:
`waitForWork` in both adapters now wakes for the next delayed job's due time instead of only the idle timeout,
which had been silently delaying every retry and turn close by up to 30 s. See §4s. That brings the totals to
889 passing tests, zero skipped, 23 of 27 specs with covering tests, 409 spec-linked assertions.

The WhatsApp connection flow is done too, which closes the last P2 item that nothing else could start
without. `@zeddev/whatsapp` gained the Cloud API itself — a port (`cloud.ts`), Meta's Graph adapter
(`graph.ts`), an in-memory fake, a local HTTP stub speaking Meta's wire format, and one conformance suite
holding all of them to the same answers — and the four-step self-service flow that drives the state machine
with it (`onboarding.ts`): authorize, submit, send a one-time code, and reply with it. Only the inbound reply
earns `connected`. Alongside it, a new library, `@zeddev/vault`, makes `tenant_secrets` reachable from exactly
one place, with a configured list of sealing keys so rotation is configuration. Migration
`0015_whatsapp_connection_setup` adds the verification attempt table and the connection's Meta-side names;
three API routes and one gateway hook complete the flow. See §4t. That brings the totals to 974 passing tests,
zero skipped, 23 of 27 specs with covering tests, 445 spec-linked assertions.

The outbound sender is done too, which means a message now makes the whole round trip: a customer writes,
the gateway stores and schedules, the worker aggregates and answers, and the answer is sent back over the
Cloud API. Migration `0016_outbound_delivery` gives `conversation_turn_outcomes.delivery_state` the rest of
its vocabulary, and `delivery.ts` in `@zeddev/conversation` drains it: the 24-hour customer service window,
retry for what Meta definitively refused, a refusal to repeat what it cannot know the fate of, the
attempts-exhausted record, and connection-state feedback — which is also what finally drives automatic
reconnection. See §4u. That brings the totals to 987 passing tests, zero skipped, 23 of 27 specs with
covering tests, 457 spec-linked assertions.

Image and voice understanding are done too: a customer's photo or voice note now reaches the model as what it showed or said. `WhatsAppCloud.fetchMedia` retrieves the bytes (port, Graph adapter, fake, wire stub, conformance), `media.ts` in `@zeddev/conversation` turns each message into text once, when its turn is about to be answered, and migration `0017_inbound_media_understanding` keeps that text and never the bytes. Retrieval has its own retry allowance through the queue and ends in the fallback rather than a dead letter. See §4v. That brings the totals to 1054 passing tests, zero skipped, 24 of 27 specs with covering tests, 494 spec-linked assertions. Neither path has yet run against a live model or against Meta: see the follow-ups in §4v.

Client conversation visibility is done too: a client can now list their conversations and read any of them, with what each photo showed, what each voice note said, why anything went unanswered, and whether each answer was actually delivered. `transcript.ts` in `@zeddev/conversation` reads what the reply path already stores, migration `0018_conversation_visibility` adds one index and no table, and `POST /v1/conversations/list` and `POST /v1/conversations/transcript` expose it. See §4w. That brings the totals to 1088 passing tests, zero skipped, 25 of 27 specs with covering tests, 516 spec-linked assertions. There is still no dashboard to read it in: `services/web` is not built.

The scheduler is done too: a new service, `services/scheduler`, runs the platform's timer-driven work. An interrupted WhatsApp connection is now retried with no traffic and no client action, restored when its link is found working, and moved to `error` with `recovery_exhausted` when its allowance runs out, which closes `whatsapp-number-connection.md` AC6. Old succeeded jobs are deleted at last. `recovery.ts` in `@zeddev/whatsapp` holds the rules and migration `0019_connection_recovery` holds the count. See §4x. That brings the totals to 1116 passing tests, zero skipped, 25 of 27 specs with covering tests, 525 spec-linked assertions.

Per-tenant metrics and the operator's health view are done too: an operator can see every tenant's connection, its numbers over a chosen period, which tenants stand out, and one tenant in depth, without any route that could reach a message. Migration `0020_tenant_metrics` counts each event in a counts-only hourly table, a new library, `@zeddev/monitoring`, reads it back, three operator routes expose it, and `services/scheduler` deletes what is past retention. See §4y. That brings the totals to 1159 passing tests, zero skipped, 25 of 27 specs with covering tests, 545 spec-linked assertions. The screens are `services/web`'s and are not built.

Knowledge selection is done too: a tenant whose knowledge no longer fits one prompt now sends only the entries that matter to the conversation, and the model is told it holds a selection. A tenant within the 12,000-character budget still sends everything, exactly as before. `knowledge-selection.ts` in `@zeddev/bot` holds it, `generateReply` calls it, and no table or migration changes. See §4z. That brings the totals to 1195 passing tests, zero skipped, 25 of 27 specs with covering tests, 569 spec-linked assertions. Uploaded documents are not part of it, since upload is still blocked on §4.

The dashboards are done: `services/web` serves the client and operator screens and is the one origin they share with the API, forwarding `/v1/`. A client can now sign up, confirm the mailed link, configure the bot, connect a number, go live, and read conversations in a browser, and an operator can watch every tenant, which also ends the mailed links landing on nothing. The screens are checked against the real API over PostgreSQL, and the stack was walked end to end in Chrome through Compose. See §4aa. That brings the totals to 1266 passing tests, zero skipped, 25 of 27 specs with covering tests, 611 spec-linked assertions.

AI provider verification is done too: an operator can put the active provider or a staged candidate (`AI_CANDIDATE_*`, read only by the API) through a fixed suite that drives the live reply and media paths, and see each check's result and what came back before a swap. Promoting and reverting are the same exchange of configuration values. `verification.ts` in `@zeddev/conversation`, a new operator action `platform.ai.verify`, and `POST /v1/operator/ai-provider/verify`. See §4ab. That brings the totals to 1282 passing tests, zero skipped, 25 of 27 specs with covering tests, 619 spec-linked assertions; `ai-provider-portability.md` now has covering tests for all 8 of its criteria.

**Every remaining P1 item is blocked on a §4 operator decision:** language configuration on the supported-language list, document upload on accepted document formats and size limits, memory reset policy on the default inactivity window. Operator alerting and client handoff notification are blocked on the notification channel decision, and offboarding on the retention window. The next unblocked work is the component-independence and environment-portability validation in P4.

**Requirements baseline:** `specs/` (27 specs plus a README index — 22 originals, 5 authored during this
planning pass and listed in §0). Specs are behavior-only by design and deliberately
prescribe no technology. This plan is where technology and sequencing decisions live. Where this plan
makes a choice a spec left open, it is marked **[DECISION]** and the reasoning is stated, so it can be
revisited rather than rediscovered.

**Goal this plan serves:** a multi-tenant, containerized SaaS where each client business gets an isolated
AI-powered WhatsApp chatbot; the same artifact runs on a laptop, a low-cost VPS, and a managed cloud
provider with only configuration differing; and the AI provider is swappable, defaulting to free-tier usage.

---

## 0. Specs authored during this planning pass

Five gaps were found where the spec set required behavior that no spec owned. Two of them were *broken
cross-references* — a spec explicitly deferring to a sibling that does not cover the topic. These were
authored as part of this planning pass and are listed here so their provenance is clear:

- `specs/language-configuration.md` — **closes a dangling requirement.** `text-conversation-handling.md`
  and `voice-message-understanding.md` both depend on "the single language configured for that client
  business", but no spec defined configuring it; `persona-and-tone-configuration.md` and
  `business-knowledge-configuration.md` each explicitly disclaim it.
- `specs/message-burst-aggregation.md` — **closes a broken cross-reference.**
  `voice-message-understanding.md` defers multi-message burst handling to `text-conversation-handling.md`,
  which never mentions bursts; `image-message-understanding.md` requires multi-image turns and leaves the
  grouping window undefined. This spec is now the single source of truth for what one conversational turn is.
- `specs/authentication-and-access.md` — **closes a disclaimed ownership gap.** Both
  `tenant-data-isolation.md` and `client-conversation-visibility.md` push authentication out of scope and
  hand it to nobody. Operator authentication to the platform-wide monitoring surfaces was entirely
  unspecified despite being the highest-value credential in the system.
- `specs/message-delivery-reliability.md` — **closes a whole missing layer.** The spec set contained zero
  mentions of webhooks, duplicate inbound delivery, message ordering, outbound retry, or WhatsApp's
  24-hour customer service window, yet `operator-health-monitoring.md` already requires a per-tenant
  "failed message deliveries" metric that nothing produced.
- `specs/credential-and-secret-handling.md` — **closes a protection gap.** No spec mentioned encryption or
  protection at rest. `tenant-data-isolation.md` requires per-tenant WhatsApp credentials be unusable
  across tenants but says nothing about protecting them from disclosure.

`specs/README.md` has been updated to index all five.

---

## 1. Architecture decisions

These are load-bearing — most items below assume them. Recorded here so they are challengeable.

- **[DECISION] TypeScript on Node.js, single language across all services.** Rationale: one toolchain for
  API, workers, and dashboards; first-class Meta Graph API and AI provider SDK coverage; the widest set of
  free-tier hosts; and the operator's existing tooling in this repo (`parse_stream.cjs`) is already Node.
- **[DECISION] Monorepo with workspaces.** `src/lib/*` is the project's standard library — shared
  utilities, ports, and components live there and nowhere else. `src/services/*` holds the independently
  deployable units. Ad-hoc copies of a utility in a service are a defect, not a shortcut.
- **[DECISION] PostgreSQL as the single persistent store**, carrying relational data and the job queue. (Vector embeddings were first assumed here for knowledge retrieval; §4z chose lexical ranking instead.) Rationale: `cost-efficient-operation.md` forbids
  tenant-independent fixed-cost infrastructure, and every additional always-on backing service (a
  dedicated broker, a dedicated vector DB) is exactly that. One store is also the cheapest thing to make
  identical across a laptop container, a VPS container, and a managed cloud instance per
  `environment-portability.md`.
- **[DECISION] Tenant isolation enforced in the database, not only in application code.** Every
  tenant-scoped table carries a `tenant_id`; row-level security policies bind reads and writes to a
  session-scoped tenant context set from the authenticated identity. `tenant-data-isolation.md` requires
  that an identifier belonging to tenant A be useless in a context authenticated as tenant B *"even if
  guessed, reused, or supplied out of context"* — an application-layer `WHERE tenant_id = ?` convention
  cannot honor that claim, because it fails open the first time someone forgets the clause.
- **[DECISION] Ports-and-adapters for every external dependency.** AI provider, WhatsApp transport, object
  storage, queue, and clock are each a port in `src/lib` with at least one real adapter and one in-memory
  fake. This is what makes `ai-provider-portability.md` and `component-independence.md` testable rather
  than aspirational.
- **[DECISION] Configuration exclusively via validated environment variables**, parsed once at startup
  against a schema, failing with a diagnosable error listing every missing or invalid key.
  `environment-portability.md` forbids environment-detection branching outright, so there is no
  `if (env === 'production')` anywhere — differences between tiers are values, never code paths.
- **[DECISION] One container image per service; Docker Compose for laptop and VPS; the same images pushed
  to a managed cloud.** Satisfies the containerization goal and gives `environment-portability.md`'s
  "byte-for-byte identical artifact" requirement a concrete meaning.
- **[DECISION] A clock port, injected everywhere.** Three separate behaviors are timer-driven — the burst
  aggregation window, the conversation memory reset window, and the offboarding retention window — and
  none of them are testable against a real clock.
- **[DECISION] Node 24 native TypeScript type stripping — no build step.** Node 24 executes `.ts`
  directly, so the source tree *is* the artifact. This gives `environment-portability.md`'s
  "byte-for-byte identical artifact" requirement a trivially provable meaning, and removes an entire
  class of "works locally, breaks in the built image" failures. Cost: `erasableSyntaxOnly` must stay
  on, so no `enum`, `namespace`, or constructor parameter properties anywhere.
- **[DECISION] `node:test` as the test runner and npm workspaces as the package manager.** Zero test
  dependencies and zero build dependencies. Rationale is `cost-efficient-operation.md` indirectly —
  every dependency is a supply-chain and maintenance cost carried on a platform whose whole premise
  is near-zero fixed cost — and pnpm is not installed on the target machine.
- **[DECISION] The PostgreSQL client is hand-written, not a driver dependency.** `@zeddev/db`
  implements protocol v3 directly over `node:net`/`node:tls`: startup, SCRAM-SHA-256 (plus md5 and
  cleartext), the extended query flow, the simple query flow for DDL, and `LISTEN`/`NOTIFY`. Rationale
  is the same one that rejected a test framework — every dependency is a supply-chain and maintenance
  cost carried against a near-zero-fixed-cost premise — plus the observation that the needed subset is
  small and closed, because the wire protocol has been stable since 2003. The obvious objection is that
  a hand-written driver is where subtle bugs live; the answer is that there is no fake server anywhere
  in the package, so every path is tested against a real PostgreSQL. Revisit if the platform ever needs
  binary format, COPY, or connection cancellation, none of which are implemented.
- **[DECISION] Database configuration is discrete keys, not a connection URL.** A URL is a single string
  containing a password, which makes every accidental disclosure of it — a log line, a crash dump, a
  process listing — a credential disclosure. Discrete keys let exactly one of them be marked `secret`,
  so it arrives wrapped in `Secret` and cannot be serialised by accident.
- **[DECISION] Row-level security scopes are named after *reasons*, not privilege levels.** There is no
  "admin" scope. There are three situations in which the tenant filter provably cannot apply, and each
  gets its own session setting: `app.tenant_id` (normal operation), `app.identity_scope`
  (authentication, before a tenant is known — the tenant is *derived from* the account, so the lookup
  necessarily crosses tenants), and `app.platform_scope` (the operator's cross-tenant health view that
  `tenant-data-isolation.md` AC7 explicitly permits). The set of tables each scope can reach is fixed in
  migrations, which is what makes AC7's *negative* half structural: no table holding conversation
  content will ever carry a platform-scope policy.
- **[DECISION] Migrations are forward-only.** No `down` scripts. A rollback script is written when the
  schema is understood and executed when it is not, and "roll back the migration" on a table holding
  tenant data means deleting the columns holding that data. Recovering from a bad migration is a new
  forward migration.
- **[DECISION] Log redaction is an allowlist, not a denylist.** `src/lib/logging` permits only field
  names in `OPERATIONAL_FIELDS`; everything else is replaced with `[redacted]`. A denylist fails open
  the first time a field is named `body` or `pw`. Log calls also take a dotted event name rather than
  a message string, so there is no free-text channel to interpolate content into.
- **[DECISION] A fourth row-level-security scope, `app.dispatch_scope`, for queue dispatch.** It exists for
  an ordering constraint with the same shape as the identity scope's: a worker must select the next job
  *before* it can know which tenant that job belongs to, because the tenant is derived from the job. The
  scope's reach is fixed in migrations and holds routing metadata only.
- **[DECISION] Job payloads live in a separate table from job routing metadata.** Row-level security is
  row-level, not column-level, so "dispatch may read the row but not the payload" is not expressible as a
  policy. `queue_jobs` carries a dispatch policy; `queue_job_payloads` carries none, so a payload can only
  be read inside a transaction bound to its own tenant. This makes `tenant-data-isolation.md` AC2 survive a
  bug in the dispatch loop rather than depend on there being none.
- **[DECISION] Queue dispatch is round-robin across tenants via a per-(queue, tenant) cursor**, never a
  global FIFO. `message-delivery-reliability.md` AC16 forbids one tenant's backlog delaying another's, and
  `cost-efficient-operation.md` forbids the other obvious answer, a queue per tenant. Fair scheduling
  inside shared capacity is what is left. An optional per-tenant in-flight cap covers the case round-robin
  cannot: a tenant whose handler hangs occupying every worker.
- **[DECISION] Object storage is reached through a port that cannot be given a key.** Everywhere else
  tenant isolation is enforced by row-level security below the application; object storage has no
  equivalent, since a bucket is a flat keyspace. So there is no operation on the port that takes a key:
  `put` mints the identifier, and `get`/`head`/`delete` take an `ObjectRef` carrying its owning tenant,
  reachable only through a handle already bound to one tenant. A cross-tenant ref is refused before any
  request leaves the process. Object ids are 128 random bits, so `tenant-data-isolation.md`'s "even if
  guessed" has nothing to enumerate. Honest limitation: this is application-layer, weaker than RLS; the
  mitigation is that the authoritative index of which objects exist belongs in PostgreSQL under RLS, and
  the key layout (`<tenantId>/<kind>/<id>`, tenant first) leaves a bucket policy scoped to
  `<tenantId>/*` expressible later — the object-storage analogue of the deferred second database role in
  §4c.
- **[DECISION] One S3-compatible adapter, never two.** A laptop container, a VPS container, and a managed
  cloud bucket all speak the same protocol, so all three are the same code reached through different
  `STORAGE_*` values. The one genuine protocol difference — path vs virtual-host bucket addressing — is
  `STORAGE_ADDRESSING_STYLE`, configured rather than detected, because "if the host is an IP address, use
  path style" is environment-tier detection wearing a disguise, which `environment-portability.md` AC5
  forbids.
- **[DECISION] The SigV4 signer and the HTTP client are hand-written**, on the same reasoning §1 already
  records for the PostgreSQL client. SigV4 is a published, frozen algorithm with official test vectors,
  and the AWS SDK is several hundred packages. `node:http`/`node:https` rather than `fetch` because
  `fetch` adds headers underneath a signature.
- **[DECISION] Object bodies are buffered, not streamed**, bounded by `STORAGE_MAX_OBJECT_BYTES` (default
  32 MiB). In exchange every write can be hashed before it is sent, so the remote verifies integrity
  rather than trusting us, and an oversized upload is rejected before a byte moves — which is what makes
  `business-knowledge-configuration.md`'s "reject without silently discarding it" true in both directions.
  Revisit if the platform ever accepts large media.
- **[DECISION] Identity is a domain library, not a service.** `@zeddev/identity` contains no HTTP. The
  API service will own status codes, cookies, headers, and request-level rate limiting; the library owns
  what is *true* about identity. The payoff is that the rules hardest to get right — the tenant binding,
  session invalidation on credential change, the failed-attempt counter that must survive a rollback — are
  all database behaviour and are tested against a real PostgreSQL with no server in the loop.
- **[DECISION] Session, lockout, and token expiry are judged by the database clock, not an injected
  `Clock`.** Same reasoning `@zeddev/queue` gives for leases: several instances share these rows, and an
  instance with a fast clock must not reject a session its neighbours honour. The cost is that a
  `FakeClock` cannot drive an expiry, so those tests configure sub-second windows and really wait. This is
  the one place the clock-port decision in §1 is deliberately not applied.
- **[DECISION] Client login reveals nothing; signup reveals duplicates.** `authentication-and-access.md`
  AC3 requires an unknown address and a known one be indistinguishable on failure, so unverified email, a
  not-ready tenant, and a wrong password all produce one `AuthenticationError` with no reason, and the
  reason goes to `access_records` instead. `client-signup-and-tenancy.md` AC3 requires the opposite at
  signup — "rejected with a clear reason" — which is the spec's own trade, since a signup form that cannot
  say "already registered" is unusable. Timing is equalised on the login path with a decoy scrypt, because
  a carefully worded response undone by a 100 ms difference is not a closed oracle.
- **[DECISION] Permission is a table keyed by action, not by principal.** `ACTION_PRINCIPALS` in
  `@zeddev/identity` maps each action to the single principal type that holds it.
  `authentication-and-access.md` AC15–AC17 require the operator's denials be enforced "as an access-control
  rule rather than merely the absence of a button" and "through any surface", which rules out per-route
  checks: a rule scattered across routes is one a new route can omit. Keyed by action rather than by
  principal because a new action then fails to compile until someone names its holder, instead of silently
  appearing in neither list.
- **[DECISION] Session tokens are hashed with SHA-256, account passwords with scrypt.** Not an
  inconsistency: scrypt exists to make an offline *dictionary* attack expensive, and a 256-bit CSPRNG token
  has no dictionary. Paying 32 MiB and ~100 ms per request to defend an attack that cannot be mounted would
  be a self-inflicted denial of service on the hot path.
- **[DECISION] The environment-variable reference is generated, never written.**
  `environment-portability.md` states completeness as an inspectable criterion, and a hand-maintained
  reference stops being complete on the second key anyone adds — silently. `@zeddev/deployment` renders
  `docs/configuration.md` from the schemas that actually parse the environment, and a test fails the build
  when the committed file drifts or when a package grows a `*_CONFIG_SCHEMA` that no registry knows about.
- **[DECISION] Sessions travel in HttpOnly cookies, not bearer headers; one origin serves dashboard and
  API.** `zd_session` (Path=/) and `zd_operator_session` (Path=/v1/operator), both HttpOnly + SameSite=Strict,
  Secure iff `API_PUBLIC_BASE_URL` is https. No CORS support at all. Rationale: a token a script can read is
  a token an XSS can steal; same-origin removes a whole CORS surface. CSRF needs three independent
  failures: SameSite=Strict, JSON-only request bodies (a cross-site form cannot send `application/json`
  without a preflight nobody answers), and a refused foreign `Origin` on every non-GET.
- **[DECISION] Verification and reset mail is sent after the response, from an in-process outbox, not the
  durable queue.** After-the-response because otherwise a registered address answers an SMTP round-trip
  slower, undoing AC9's indistinguishable body with timing. In-process because a queue payload would store
  the raw token in the database, defeating hash-only token storage; a lost message costs one "send again"
  click. Shutdown drains the outbox within `API_SHUTDOWN_GRACE`.
- **[DECISION] Tokens travel in the URL fragment** (`<base>/verify-email#token=…`,
  `<base>/reset-password#token=…`): browsers never send fragments to servers, so tokens stay out of access
  logs, proxy logs, and Referer headers.
- **[DECISION] Public base URL and trusted proxy hops are configured, never inferred**
  (`API_PUBLIC_BASE_URL`, `API_TRUSTED_PROXY_HOPS`): a link built from the Host header is host-header
  poisoning of reset links; trusting X-Forwarded-For blindly lets a caller forge the address the throttle
  counts by. The client address is the entry `hops` back from the TCP peer.
- **[DECISION] The per-source throttle is in-process** (`API_ANONYMOUS_RATE_LIMIT` per
  `API_ANONYMOUS_RATE_WINDOW`, default 30/10m) — the "from a single source" half of
  `authentication-and-access.md` AC12; the per-account half stays the database lockout. N instances admit
  N× the limit; a shared counter would need a write per anonymous request or another always-on service.
- **[DECISION] The API service runs migrations at startup** (advisory-locked, idempotent), after refusing a
  role that bypasses RLS and before verifying mail and listening.
- **[DECISION] The operator is created by a CLI reading the password from standard input**
  (`node src/services/api/cli.ts create-operator --email …`), never by a route, an argument (visible in the
  process list), or an env var (ends up committed in a Compose file).
- **[DECISION] The Postgres superuser password lives in a Compose secret file**
  (`deploy/secrets/postgres-superuser-password`), not `.env`, because `.env` is passed whole to the service
  containers.

### Component map (the units `component-independence.md` requires be independently deployable)

- `postgres` — persistent storage.
- `object-storage` — uploaded knowledge documents. S3-compatible port so a local container and a cloud bucket are the same adapter. **Revised (§4v):** fetched WhatsApp media is not stored; only the text derived from it is.
- `services/whatsapp-gateway` — inbound webhook verification, acknowledgement, deduplication, tenant
  attribution, enqueue; consumes the connection-verification reply. **Revised (§4u):** outbound send moved
  to the conversation worker, because the outbox is that library's table and this process's one hard
  requirement is to acknowledge a webhook fast.
- `services/conversation-worker` — burst aggregation, memory assembly, prompt construction, AI calls,
  rule enforcement, handoff decisions, fallback execution, and outbound send with retry — which is also
  where a send failure feeds back into the connection state.
- `services/api` — client and operator HTTP API: auth, configuration, transcripts, metrics.
- `services/scheduler` — timer-driven work. **Built (§4x):** connection recovery, job purging, and metric retention. Still to land here as their specs are built: alert evaluation and suppression, retention-window deletion, memory reset evaluation.
- `services/web` — client dashboard and operator dashboard, and the single origin they share with the API. **Built (§4aa).**

The gateway is deliberately separate from the worker: `message-delivery-reliability.md` requires
acknowledging inbound notifications promptly and independently of reply-generation time, and a slow AI
call must never be able to cause Meta to redeliver.

---

## 2. Backlog — items yet to be implemented, in priority order

### P0 — Foundation (nothing else can be built or verified without these)

- **[DONE]** Repository scaffold: npm workspaces, TypeScript configuration (`tsconfig.base.json`, strict
  plus `erasableSyntaxOnly`), and `node:test` as the runner. Commands are recorded in `AGENTS.md`.
  **No linter or formatter was added** — this is a deliberate deferral, not an oversight. TypeScript
  `strict` plus the repo-scan guards in `src/lib/testing/portability.test.ts` cover the rules that
  actually protect a spec guarantee, and every lint dependency is carried by a platform whose premise
  is near-zero fixed cost. Revisit when a second contributor joins and style drift starts costing
  review time; a formatter is worth more then than now.
- **[DONE]** `src/lib/config` — environment schema definition, single parse at startup, fail-fast error listing every
  missing/invalid key. Directly satisfies `environment-portability.md`'s startup-failure criterion.
- **[DONE]** `src/lib/errors` — typed error taxonomy distinguishing configuration errors, tenant-access violations,
  transient transport failures, terminal transport failures, and AI-generation failures. Several specs
  hinge on telling these apart (transient vs terminal drives `whatsapp-number-connection.md`'s
  reconnecting-vs-error boundary; AI failure vs delivery failure drives whether
  `fallback-response-behavior.md` applies).
- **[DONE]** `src/lib/logging` — structured logging with **content redaction enforced at the logger boundary**.
  `tenant-data-isolation.md` and `operator-health-monitoring.md` both forbid conversation content from
  reaching operator-visible diagnostics. Redaction must be impossible to bypass by accident, which means
  it belongs in the logger, not in each call site. Building this after the fact means auditing every log
  line ever written.
- **[DONE]** `src/lib/db` — a dependency-free PostgreSQL client (protocol v3, TLS, SCRAM-SHA-256),
  connection pool, migration runner, tenant-context session binding, and the startup preflight that
  refuses to run where row-level security cannot be enforced.
- **[DONE]** `src/lib/schema` — baseline migrations for tenants, identity, and audit records, with
  row-level security on every tenant-scoped table. See §4c for what was learned building it.
- **[DONE]** `src/lib/secrets` — sealing and unsealing of recoverable secrets, one-way transformation for account
  credentials, and redaction helpers, per `credential-and-secret-handling.md`.
- **[DONE]** `src/lib/time` — clock port with a controllable fake.
- **[DONE]** `src/lib/queue` — job enqueue/consume port over Postgres. At-least-once via leases, exponential
  backoff with full jitter, a dead-letter path, per-partition FIFO ordering, round-robin tenant fairness, and
  a `LISTEN`/`NOTIFY` consumer that sleeps rather than polls. Ships a real adapter, an in-memory fake, and a
  shared conformance suite that runs against both. See §4d.
- **[DONE]** `src/lib/storage` — S3-compatible object storage port: hand-written SigV4 signer, a real
  adapter, an in-memory fake, and a shared conformance suite that runs both. See §4e.
- **[DONE]** `src/lib/testing` — in-memory fakes for every port, plus a spec-traceability helper so each test can
  declare which spec file and acceptance criterion it covers.
- **[DONE]** Container definitions: one Dockerfile per service, `compose.yaml` for laptop and VPS, and the
  generated environment-variable reference (`docs/configuration.md`). Verified by building the API image and
  running the whole Compose stack end to end in a temporary copy under a separate project name: isolation
  preflight passed, migrations applied, signup → link read from Mailpit → verify → login → session all
  worked, `create-operator` worked inside the container, and `docker compose stop` exited 0 after a logged
  drain.
- **[DONE]** Baseline database schema and migrations for tenants, users, and the audit/event records that
  several specs require. Delivered as `@zeddev/schema`: `tenants`, `tenant_lifecycle_events`, `accounts`,
  `client_sessions`, `account_tokens`, `operators`, `operator_sessions`, `access_records`,
  `tenant_secrets`, `secret_access_records`.

> **P0 is complete.** Still-open follow-ups, carried forward rather than blocking anything:
> `maxInFlightPerTenant` is now set by `services/conversation-worker` (§4s); `purgeSucceeded` is now called by `services/scheduler` (§4x); `verifyAccess()` still has no
> caller from any service that holds an object store (storage,
> §4e) — none does yet, which is also why object storage (MinIO) is not in `compose.yaml`: there is nothing in
> it to run against.

### P1 — Control plane (a client can sign up, configure, and reach "ready")

- **[DONE]** Client signup: business name, email, credential strength enforcement, duplicate-email
  rejection, email verification, and **transactional tenant provisioning** — a provisioning failure rolls
  back entirely and then marks the tenant `failed` in a transaction of its own, so there is both no partial
  tenant and a visible error state. Delivered as `@zeddev/identity`. The verification *link* is minted but
  not delivered; see the mail-port follow-up in §4f.
- **[DONE]** Client authentication: login, session issuance with inactivity and absolute lifetimes, logout,
  password change, self-service reset with single-use expiring tokens, session invalidation on credential
  change, and failed-attempt lockout that lifts on its own.
- **[DONE]** Tenant binding derived from the authenticated identity and never accepted from caller input.
  Structural: no function on `IdentityService` takes a tenant id, and `withClientSession` opens the
  tenant-bound transaction from the value stored on the session row at login.
- **[DONE]** Operator authentication as a **separate identity space**: separate tables, separate token
  prefixes, separate code paths, and `withOperatorSession` opening the *platform* scope rather than a
  tenant scope — so even a defective operator route cannot reach a tenant-private table, because no policy
  admits the read.
- **[DONE]** Mail port: `@zeddev/mail`, an SMTP adapter plus an in-memory fake under one conformance suite.
  See §4g.
- **[DONE]** `services/api`: the HTTP surface over `@zeddev/identity` and `@zeddev/mail` — signup, email
  verification and resend, password reset request and completion, client and operator session
  issue/read/revoke, authenticated password change, the operator-bootstrap CLI, and startup preflights
  (config, tenant-isolation enforceability, mail reachability, migrations). See §4h.
- **[DONE]** Persona and tone configuration: `@zeddev/bot` (`persona.ts`) plus migration `0005_bot_persona`
  and three routes in `services/api`. Bot name required (≤50 characters, one line), formality and style
  traits optional, freeform text optional (≤2000 characters) and independently clearable, both mechanisms
  rendered together by `personaDirectives`. All 11 acceptance criteria covered against a real PostgreSQL.
  See §4i.
- **[DONE]** Readiness evaluation and the go-live toggle: `@zeddev/bot` (`activation.ts`) plus migration
  `0007_bot_activation`. Readiness, the "active implies ready" invariant, re-evaluation on every input
  change, and the on/off event log are all enforced in the database (CHECK + triggers), so no path that
  loses readiness can leave a bot live. All 14 acceptance criteria covered against a real PostgreSQL,
  including a go-live-versus-connection-failure race. See §4j.
- **[DONE]** Behavior rules configuration: individually addressable structured rules
  (never/always/only_when/avoid_topic, with a required or spec-shaped-optional condition and a
  respond/handoff/fallback action) with enable/disable/edit/delete lifecycles, plus freeform instructions,
  both binding simultaneously. `@zeddev/bot` (`behavior.ts`) plus migration `0008_bot_behavior_rules` and
  seven routes in `services/api`. 15 of 16 acceptance criteria covered at the instruction layer; AC16
  (preview) is done through the live reply path, `POST /v1/bot/preview`. See §4k and §4q.
- **[DONE]** Fallback message configuration: per-trigger and shared messages, each with a platform default
  per trigger, resolved by one function (`resolveFallbackMessage`) shared by the reply-path entry point and
  preview. `@zeddev/bot` (`fallback.ts`) plus migration `0009_bot_fallback_messages` and three routes in
  `services/api`, including a preview route for an unsaved draft. 9 of 13 acceptance criteria covered at the
  configuration layer; AC6, AC7, AC10, AC13 need P2's reply path. See §4l.
- **[DONE]** Bot disclosure setting: `@zeddev/bot` (`disclosure.ts`) plus migration `0010_bot_disclosure` and
  `GET`/`PUT /v1/bot/disclosure`. 8 of 9 acceptance criteria covered, AC1–AC4 at the instruction layer; AC6
  (past messages unchanged) needs transcripts. See §4m.
- **[DONE]** Human handoff enable/disable and trigger configuration: `@zeddev/bot` (`handoff.ts`) plus migration
  `0011_bot_handoff_settings` and `GET`/`PUT /v1/bot/handoff`, `PUT /v1/bot/handoff/enabled`. AC1–AC5 covered at
  the configuration and decision layer; AC6–AC13 are per-conversation behaviour and need P2. See §4n.
- **[DONE]** Business knowledge, freeform half: `@zeddev/bot` (`knowledge.ts`) plus migration
  `0012_bot_knowledge_entries` and `GET /v1/bot/knowledge`, `POST /v1/bot/knowledge/entries`,
  `PUT /v1/bot/knowledge/entries/entry`, `POST /v1/bot/knowledge/entries/entry/delete`; `/v1/bot/status` now
  carries `businessKnowledge`. AC1, AC2, AC5–AC12 covered for entries (AC5–AC8 at the instruction layer).
  See §4o.
> **P1 remaining scope.** Everything below this line — language configuration, document upload, and
> conversation memory reset policy. All three are blocked on §4 decisions.

- Language configuration with a platform default, per `language-configuration.md`.
- Business knowledge document upload, with upload failures surfaced rather than silently dropped, joining the
  existing entry listing and the `knowledgeConfigured` answer (§4o). **Blocked** on accepted formats/size.
- Conversation memory reset policy configuration (inactivity window plus manual reset).

### P2 — Data plane (the bot actually holds conversations)

- **[DONE]** WhatsApp connection flow: guided self-service authorization (`CONNECTION_STEPS`), send/receive
  verification by a one-time code the client must reply with before the number is marked connected, and
  rejection of a second concurrent number with a 409. `whatsapp-number-connection.md` is explicit that
  submitted credentials alone must never produce a "connected" state, and no edge into `connected` exists
  except from `connecting`. AC1–AC3, AC7–AC10, AC12 covered. See §4t.
- **[DONE]** The state, its fixed vocabulary (connecting / connected / reconnecting / error /
  disconnected), the legal-transition table, timestamped transition history, and surfaced error reasons —
  including Meta-side business-verification failure as a distinct condition
  (`business_verification_required`) — in `@zeddev/whatsapp` plus migration `0006_whatsapp_connection`. What
  Bounding it is done too: `services/scheduler` retries an interrupted connection with no traffic and gives up with `recovery_exhausted` (§4x). Offboarding transitioning to `disconnected` is P4.
- **[DONE]** Number replacement as a distinct guided flow that structurally cannot produce a dual-active
  window: `submitCredentials(..., { replace: true })` goes through `disconnected` — releasing the old number's
  route — before assigning the new one. See §4t.
- **[DONE]** Inbound webhook endpoint: `services/whatsapp-gateway` — signature verification, the subscription
  handshake, acknowledgement only after the message is committed and scheduled, tenant attribution from the
  receiving number, and rejection-with-record for anything unauthentic, unreadable, or unattributable. AC1–AC4,
  AC6 (queue half), AC11, AC13, AC17 covered. See §4r.
- **[DONE]** Inbound deduplication: `inbound_messages` is unique on `(tenant_id, external_id)`, so a redelivery —
  even after the original job was completed and purged — stores and schedules nothing.
- **[DONE]** Per-end-customer ordering and durability: messages are stored with the sender's timestamp and
  listed in send order, scheduled in send order within a notification, partitioned per end-customer on the queue,
  and survive a gateway restart. The worker's half is pull-based admission under the conversation lock, ordered
  by send time within a turn. See §4s.
- **[DONE]** Burst aggregation into conversational turns, with the quiet-period window, the maximum turn
  extension, mixed-type combination, and exactly-one-reply-per-turn, in `@zeddev/conversation`. See §4s. AC2
  (combined understanding of an image and a voice message) needs media understanding; AC12 (reset window
  independence) needs the memory reset policy. Per `message-burst-aggregation.md`.
- **[DONE]** `src/lib/ai` provider port with declared capabilities (text generation, vision, audio transcription),
  a registry, and configuration-driven selection. Two adapters (Gemini, OpenAI-compatible), an in-memory fake,
  and a shared conformance suite. AC1–AC5, AC8 covered (AC4 by the verification suite, §4ab); AC6/AC7 are
  structural (no tenant on any port call, instructions sent unchanged) but have no dedicated test. See §4p.
- **[DECISION] Default provider: Google Gemini free tier**, because it covers text, vision, and audio in
  one free-tier provider, which keeps the v1 dependency count at one. A second adapter should be built
  early — the portability requirement in `ai-provider-portability.md` is unfalsifiable with only one
  adapter, so building the second is really a test of the first.
- **[PARTIAL]** Prompt assembly from tenant configuration: `replyInstructions` in `@zeddev/bot` (`reply.ts`)
  composes persona, disclosure, knowledge entries, behaviour rules, handoff, and the output protocol, and
  `interpretReply` reads the answer back. Conversation memory is now supplied (up to 20 turns, from
  `@zeddev/conversation`). Still to add as they land: language (blocked on §4), and the reset boundary. Knowledge is selected per reply when it exceeds the prompt budget (§4z). See §4q, §4s.
- **[PARTIAL]** Conversation memory: `@zeddev/conversation` (`context.ts`) supplies a unified
  per-end-customer-per-tenant context across text/image/voice, capped at `CONVERSATION_LIMITS.contextTurns` =
  20 turns; the stored transcript itself is untouched. Inactivity and manual reset are still blocked on the §4
  default-inactivity-window decision. See §4s.
- **[DONE]** Knowledge retrieval grounding over freeform entries: `selectKnowledge` in `@zeddev/bot`. Ingested documents join it when upload lands (blocked on §4). See §4z.
- **[DONE]** Outbound send with transient retry and backoff, exactly-once delivery from the end-customer's
  perspective, terminal-failure recording feeding the operator metrics, and connection-state feedback when
  a send failure indicates the connection itself is broken. `delivery.ts` in `@zeddev/conversation` plus
  migration `0016_outbound_delivery`; AC7, AC8, AC9, AC17 covered. See §4u.
- **[PARTIAL]** 24-hour customer service window: detection and recording are done (AC10) — a reply outside
  the window is marked `expired` and never sent. What to send *instead* — an approved template, which costs
  money — is still **blocked on a product decision**, see §4.
- **[PARTIAL]** Fallback execution across all three triggers, plus the new `not_understood` cause, are decided
  and recorded with literal text in the outbox (`conversation_turn_outcomes`); actually sending it is the
  outbound sender's. See §4s.
- **[DONE]** Image understanding, including captions, multiple images per turn, and text visible within images, persisted as `inbound_media_understandings`. All 8 acceptance criteria of `image-message-understanding.md` have tests, at the port and turn layers; prompt quality against a live model is unverified. See §4v.
- **[DONE]** Voice note transcription, with transcription artifacts stripped and the transcript persisted. `voice-message-understanding.md` AC1–AC9 have tests. The language hint is not sent until language configuration exists (blocked on §4). See §4v.
- **[PARTIAL]** Human handoff: trigger detection via the reply protocol, per-conversation pause, held
  messages, client-initiated resume (`POST /v1/conversations/handoff/resume`), and history are done. Client notification (blocked on channel decision) and a system-side resumption condition remain; the status listing is `POST /v1/conversations/list` with `pausedOnly` (§4w). See §4s.
- **[DONE]** Bounded automatic reconnection and job purging: `services/scheduler`, `recovery.ts` in `@zeddev/whatsapp`, and migration `0019_connection_recovery`. `whatsapp-number-connection.md` AC5, AC6, AC9, AC12 covered on this path. See §4x.

### P3 — Visibility

- **[DONE]** Metrics collection: per-tenant message volume, error rate, response time, and failed deliveries, in hourly rows that support any window within a 90-day retention. Migration `0020_tenant_metrics`, `@zeddev/monitoring`. See §4y.
- **[DONE]** Client conversation visibility: conversation list, full chronological transcript with attribution, representations of image and voice content, search/filter by end-customer identity and recency, and handoff status with trigger reason. All 9 acceptance criteria covered, at the library and over HTTP; the screens are in `services/web`. See §4w.
- **[DONE]** Operator health dashboard: the data and API are done: the all-tenant view, per-tenant detail with transition history, last-known-good timestamps, error reasons, sorting and filtering, flags for unusual error rates and response times, and historical metrics with explicit unavailability past retention. All 11 acceptance criteria have tests at the library layer. The screens, including polling to keep state current (AC2), are in `services/web`. See §4y, §4aa.
- Operator proactive alerting: error-state and stalled-reconnect and error-spike triggers, per-tenant
  independence, suppression windows with escalation bypass, resolution notifications, delivery retry, and
  a queryable notification history including delivery outcomes.

### P4 — Lifecycle and portability proof

- Offboarding: immediate stop of auto-responses, WhatsApp revocation, entry into the retention window,
  reactivation during the window, automatic deletion at window end, and on-demand permanent deletion with
  explicit irreversibility confirmation. Deletion must reach secrets and any backup or archived copy.
- **[DONE]** AI provider verification mode and revert: the `AI_CANDIDATE_*` slot, `verifyAiProvider`, and
  `POST /v1/operator/ai-provider/verify`; promotion and revert are one exchange of configuration values. See §4ab.
- Environment portability validation: bring the same artifacts up on all three tiers from configuration
  alone, and add an automated check that fails the build if environment-detection branching appears in the
  source. `environment-portability.md` states this as an inspectable criterion, so it should be a test.
- Component independence validation: redeploy, restart, and scale each service in isolation and assert the
  others stay available and uncorrupted.

### Cross-cutting, runs alongside everything

- **[DONE, ongoing] Acceptance-criteria traceability.** `specTest(spec, criterion, name, fn)` in
  `src/lib/testing` records the mapping and throws at definition time if the spec filename does not
  exist, so a spec rename breaks the build instead of silently orphaning the criterion. `npm run
  spec-coverage` reports per-spec coverage. Current state: 13 of 27 specs have covering tests, 211
  spec-linked assertions. (Superseded after the persona increment: 14 of 27 specs, 231 assertions;
  `persona-and-tone-configuration.md` at 11, covering all 11 of its criteria.) `authentication-and-access.md` is now at 45 and `client-signup-and-tenancy.md`
  at 20 — the two best-covered specs in the set — appropriately, since every other spec's "identity is
  already established" assumption rests on them. `credential-and-secret-handling.md` is at 27,
  `environment-portability.md` at 20, `tenant-data-isolation.md` at 18, `component-independence.md` at 3.
  The remaining uncovered specs are all P1–P4 features not yet built. (After the readiness increment: 15 of
  27 specs, 261 assertions; `bot-activation-control.md` covers all 14 of its criteria and
  `whatsapp-number-connection.md` 8 of 12.) (After the behaviour-rules increment: 16 of 27 specs, 278
  assertions; `behavior-rules-configuration.md` covers 15 of 16, AC16 preview pending the AI port.) (After
  the fallback increment: 16 of 27 specs, 288 assertions; `fallback-response-behavior.md` covers 9 of 13 at
  the configuration layer.) (After the disclosure increment: 17 of 27 specs, 297 assertions;
  `bot-disclosure-setting.md` covers 8 of 9.) (After the handoff-configuration increment: 303
  assertions; `human-handoff.md` covers AC1–AC5 of 13.) (After the knowledge-entries increment: 18 of 27 specs,
  316 assertions; `business-knowledge-configuration.md` covers 10 of 12 criteria — AC3/AC4 are document upload.)
  (After the AI port increment: 20 of 27 specs, 347 assertions; `ai-provider-portability.md` covers AC1, AC2,
  AC3, AC5, AC8; `voice-message-understanding.md` gained its first two at the port layer.) (After the
  conversation worker increment: 23 of 27 specs, 409 assertions; `message-burst-aggregation.md` covers 10 of
  12, `conversation-memory.md` 3 of 11 at the context layer.) (After the connection flow increment: 23 of 27
  specs, 445 assertions; `whatsapp-number-connection.md` covers 18 criteria and
  `credential-and-secret-handling.md` 36 — the two specs `@zeddev/vault` and `@zeddev/whatsapp` jointly own.
  The four specs still at zero are `client-conversation-visibility.md`, `image-message-understanding.md`,
  `language-configuration.md`, and `operator-proactive-alerting.md`.) (After the outbound sender increment:
  457 assertions; `message-delivery-reliability.md` covers 23 criteria across the gateway, the worker, and the
  sender, and `whatsapp-number-connection.md` 20.) (After the media understanding increment: 24 of 27 specs, 494 assertions; `image-message-understanding.md` covers all 8 criteria and `voice-message-understanding.md` all 9. The three specs still at zero are `client-conversation-visibility.md`, `language-configuration.md`, and `operator-proactive-alerting.md`.) (After the conversation visibility increment: 25 of 27 specs, 516 assertions; `client-conversation-visibility.md` covers all 9 criteria, and `bot-disclosure-setting.md` gains AC6. The two specs still at zero are `language-configuration.md` and `operator-proactive-alerting.md`.) (After the scheduler increment: 25 of 27 specs, 525 assertions.) (After the metrics increment: 25 of 27 specs, 545 assertions.) (After the knowledge selection increment: 25 of 27 specs, 569 assertions.) (After the dashboard increment: 25 of 27 specs, 611 assertions.) (After the AI provider verification increment: 25 of 27 specs, 619 assertions.)

---

## 3. Cross-spec conflicts found — these need resolution, not just implementation

- **Transient disconnect permanently pauses the bot.** **Resolved (2026-09-18):** readiness is satisfied by
  `connected` *or* `reconnecting`; `error`, `disconnected`, and `connecting` do not count. Both specs were
  updated to say so — `bot-activation-control.md` gained AC14: a reconnecting→connected blip leaves an
  active bot active. The rule lives in exactly one place, `app.bot_readiness_unmet` in migration
  `0007_bot_activation`, so reversing the decision is one line of SQL in a new migration. Note: it was
  decided without explicit operator confirmation, following this plan's own recommendation, and is worth
  confirming.
- **"New conversation" is undefined for disclosure.** `bot-disclosure-setting.md` requires a disclosure
  statement at the start of every new conversation and flags the session boundary as an open question.
  `conversation-memory.md` already defines exactly that boundary via its reset policy.
  **Recommendation:** define disclosure's "new conversation" as the memory-reset boundary, so there is one
  concept rather than two that can drift apart. The disclosure increment (§4m) kept this open deliberately:
  `disclosureDirectives(mode, { conversationStart })` takes the boundary from its caller, so P2's reply path
  decides it in one place and the disclosure module needs no change either way.
- **Zero-cost operation may not survive contact with Meta's pricing.**
  `cost-efficient-operation.md` requires that the platform be operable end-to-end — "bot conversations,
  hosting, storage" — at no cost at low volume. AI and hosting can plausibly be free-tier. WhatsApp
  Business Cloud API pricing is set by Meta, is outside the operator's control, and has changed
  materially over time. **Action:** verify Meta's current conversation/message pricing and free allowance
  before committing to the zero-cost claim, and amend the spec if it does not hold. This is the
  cost-model assumption most likely to be wrong.
- **"No fixed-cost infrastructure" versus always-on components.**
  `cost-efficient-operation.md` forbids infrastructure existing merely to support future tenants, but
  `operator-proactive-alerting.md` requires push alerting without a dashboard open, and the aggregation,
  reset, and retention timers all require a running process. These are genuinely always-on. The tension is
  benign on a laptop and small on a VPS, but it should be acknowledged rather than discovered later.
- **Fallback tone versus fallback availability.** **Resolved (2026-09-18):** fallback text is stored as
  literal, client-authored text sent verbatim — never generated or rewritten by the AI provider. The spec
  was amended accordingly, and P2's reply path must send the resolved text as-is rather than "improving" it
  into an AI-generated fallback.

---

## 4. Decisions needed from the operator before the dependent items can be built

Drawn from the specs' own Open Questions where the answer actually blocks work, rather than the ones that
can be defaulted safely.

- Behavior when a reply would fall outside WhatsApp's 24-hour customer service window: drop it, or send an
  approved template message? Templates cost money, so this is a cost decision as much as a product one.
  Blocks the outbound path in P2.
- Default retention window duration after offboarding, and the bounded turnaround for an explicit deletion
  request. Blocks P4.
- Default conversation memory reset inactivity window, and whether a "never reset" option is offered.
  Blocks memory work in P2.
- The supported language list and the platform default. Blocks P1.
- Notification channel for operator alerting, and separately for client handoff notifications. Both specs
  deliberately leave the channel open. Blocks P2 handoff and P3 alerting.
- Whether multi-factor authentication is required for the operator identity. It is the only credential in
  the system with visibility across every tenant. **No longer blocking** — operator authentication shipped
  without it, and because the operator login path is deliberately separate from the client one, adding a
  second factor is a change to one function. Still worth answering before launch.
- Whether signup needs CAPTCHA or equivalent anti-abuse. `client-signup-and-tenancy.md` flags this as a
  likely necessary control that was never confirmed in scope. Signup is now publicly reachable through
  `POST /v1/signup`; the per-source throttle (§1) bounds volume per address but does not stop a distributed
  signup flood, and the failed-attempt lockout defends *login*, not signup.
- ~~Whether formality and communication style are required for readiness or safely defaulted.~~ **Decided
  (persona increment, §4i):** neither is required, and neither is defaulted — an unset value is stored as
  NULL / an empty list and the prompt says nothing about it. Only the bot name gates readiness. Making
  either required later is a one-line validation change in `parsePersonaInput`, not a migration.
- Accepted document formats and size limits for knowledge upload.
- Whether the secret-protection boundary must defend against an attacker who has obtained the running
  host, or only against disclosure of stored data. This materially changes what P0's secrets work must do,
  so it should be answered early.

---

## 4b. Findings from the P0 increment

- **`.gitignore` was silently ignoring `src/lib/**`.** The file is Python-derived and its unanchored
  `lib/` rule matched `src/lib/` at any depth — the exact directory §1 designates as the project's
  standard library. Fixed by anchoring `lib/`, `lib64/`, `parts/`, and `var/` to the repo root. Worth
  knowing because the failure was silent: files would have been created, tested, and never committed.
- **Typechecking is not covered by `npm test`.** Type stripping erases types without checking them,
  so a type error runs fine and fails nothing. `npm run check` (typecheck then test) is the real gate;
  running only `npm test` gives false confidence.
- **A repo-scan guard must be quote-aware.** The first version of the embedded-address guard stripped
  `//` comments with a naive regex, which truncated `'postgres://localhost/db'` at the `//` and made
  the rule silently stop matching the literal it existed to catch. Guards need their own negative
  tests — a guard that never fires is worse than no guard, because it is trusted.
- **`specs/` acceptance criteria are machine-countable.** All 27 specs use a consistent
  `- Given ... when ... then ...` bullet format under an `## Acceptance Criteria` heading, which is
  what makes the coverage denominator possible. Preserve that format when editing specs.

---

## 4c. Findings from the persistence increment

- **A PostgreSQL superuser is exempt from every row-level security policy, and `FORCE ROW LEVEL
  SECURITY` does not change that.** This is the most important thing learned in this increment. The
  exemption is total and silent: no error, no warning, every policy simply does not apply. It also
  applies to any role carrying `BYPASSRLS`. A deployment whose `DATABASE_USER` is the superuser the
  database was created with — the default in every quick-start container image, including this repo's
  own first version of `scripts/db.sh` — therefore has *no tenant isolation whatsoever* while appearing
  to work perfectly. It was caught only because the cross-tenant tests were written to assert that data
  is *absent*; had they been written the other way round they would have passed while proving nothing.
  **Mitigations, both landed:** `assertTenantIsolationEnforceable()` in `@zeddev/db` fails startup
  against such a role, and every test fixture creates its own `NOSUPERUSER NOBYPASSRLS` role. The
  fixture role still *owns* the schema, which is fine precisely because every tenant-scoped table uses
  `FORCE ROW LEVEL SECURITY` — that is what `FORCE` is for. Call the preflight from every service's
  startup path as services are built.
- **A green test run can prove much less than it appears to.** The database suites skip themselves when
  no database is configured, which is right, but it left `npm run check` fully green with every
  isolation assertion unexecuted. This is the same shape as the §4b finding that `npm test` does not
  typecheck. Fixed by making `check` require a database and adding `check:offline` as a named, visible
  choice; `scripts/db.sh up` now writes `.env.test`, which `npm test` loads automatically, so there is
  no export step to forget.
- **`describe(name, { skip }, fn)` does not execute `fn`.** So `specTest` calls inside a skipped suite
  never register, and spec coverage silently under-reported the database-backed specs — the tenant
  isolation and credential specs, which most need the traceability. Any command that collects coverage
  must invoke the tests exactly as `npm test` does. `scripts/spec-coverage.ts` was fixed accordingly.
- **A failing `before` hook in `node:test` reports only `cancelledByParent` on its children.** The real
  error appears solely on the parent suite's entry, which the default reporter does not show. Use
  `--test-reporter=tap` and read the suite line. This cost real time.
- **PostgreSQL's own error text quotes row data.** A unique-violation detail reads
  `Key (email)=(...) already exists`. Propagating the server's `message`/`detail` would put a client's
  email or an end customer's phone number into an operator-visible diagnostic, violating
  `operator-health-monitoring.md` AC9. `src/lib/db/errors.ts` therefore maps failures onto the taxonomy
  using the SQLSTATE and constraint name only, and drops the prose at that boundary — not further
  downstream, because downstream is where someone eventually logs it. There is a test asserting the
  address does not appear in the diagnostic.
- **`InternalError` being retryable was wrong for known-terminal failures.** A SQL syntax error or a
  missing table will fail identically on every attempt. Added `DefectError` to `@zeddev/errors` — same
  `internal` kind, `retryable: false` — rather than adding a `retryable` constructor argument, which
  would have broken the taxonomy's central invariant that retryability is a property of the *type*.
- **The fixture could not seed `tenant_secrets` under the identity scope**, which was the policy working
  as designed: authentication has no business reading a tenant's WhatsApp credential. Worth recording
  because it is a good sign, not a problem — the test fixture is subject to exactly the same rules as
  the application, so a fixture that needs a scope the application would not have is a design smell.
- **Queue fairness is a requirement, not an optimisation.** `message-delivery-reliability.md` requires
  that one tenant's failure, backlog, or surge not delay another's, while `cost-efficient-operation.md`
  forbids dedicated per-tenant infrastructure. Together these mean the dequeue must be fair *within*
  shared capacity — round-robin or per-tenant capacity partitioning — never a single global FIFO where
  one tenant's retry storm starves the line. No spec names an algorithm; the outcome is what binds.

### Deferred hardening: a second database role

The platform scope is currently opened by any code that can call `withPlatformScope`. What that buys
over a bare `WHERE` clause is real — closed by default, one explicit and greppable act to open, scoped
to a single transaction, and unable to reach conversation content no matter who calls it, because the
reachable set is fixed in migrations. But it is weaker than a second PostgreSQL role that simply lacks
the grant. The schema is built so that introducing one later changes no application code. Worth doing
before the operator dashboard ships in P3.

---

## 4d. Findings from the queue increment

- **A cross-tenant read scope is unavoidable for dispatch, and row-level security cannot narrow it by
  column.** A worker must select a job before it can know whose job it is. RLS is row-level, so "dispatch
  may read the row but not the payload" cannot be written as a policy. Splitting the payload into its own
  table is what makes it expressible — the same move `tenant_secrets` makes against the identity scope. Any
  future table that a cross-tenant context must route around, without reading, needs the same treatment.
- **The canonical PostgreSQL dequeue violates a spec outright.** `SELECT ... WHERE state = 'ready' ORDER BY
  seq LIMIT 1 FOR UPDATE SKIP LOCKED` is what every article recommends, and it fails AC16 by construction:
  ten thousand of one tenant's jobs sit in front of everyone else's next message. The fairness cursor costs
  one table, one sequence, and one UPDATE per claim. Recorded because the naive form will look like a
  simplification to anyone reading the dispatch query cold.
- **`SKIP LOCKED` over a single candidate row is a throughput trap.** Fairness selection naturally produces
  one best row, and if every concurrent worker locks that same row, all but one return empty while work is
  ready. Dispatch shortlists instead (default 8), ordered breadth-first across tenants, and locks the first
  available.
- **Retryability belongs to the error type, not to the attempt count.** A `TerminalTransportError` or a
  `DefectError` fails identically on every attempt, so spending the full allowance to rediscover that only
  delays AC8's failure record. `fail()` reads `toDiagnostic(error).retryable` and dead-letters immediately
  when it is false. This is the §4c taxonomy invariant paying off a second time.
- **A lease that expires under a still-running handler is a duplicate reply.** Raising the visibility
  timeout is not the fix — it also raises how long a genuinely dead worker's job sits stuck. The consumer
  heartbeats at a third of the lease instead, and `complete`, `fail`, and `heartbeat` all match on
  `(id, state, attempt)` so a worker that lost its lease cannot overwrite the state of the worker that now
  holds it.
- **A fake queue is the easiest place in this system to prove nothing.** If the fake dispatches FIFO while
  the real one dispatches fairly, every test above the port is evidence about a system nobody deploys, and
  nothing fails to reveal it. `conformance.ts` runs one suite against both adapters. The only intended
  difference is the time source: the real adapter takes time from the database server, because a worker
  with a fast clock must not be able to expire its own lease early; the fake takes it from an injected
  clock so a lease expiry can be driven rather than waited for.
- **A content-leak assertion needs a needle that cannot occur in a fixture identifier.** The first version
  of the redaction test searched logs for `4111` and matched the `4111` inside the fixture's own tenant
  UUID, reporting a leak that did not exist. Same shape as the §4b finding about quote-aware guards: a test
  that can fire for the wrong reason is as bad as one that never fires.
- **Dispatch cost is proportional to active tenants, not to queue depth, and that is deliberate.** The
  tenant shortlist is intentionally uncapped: capping it can stall a tenant whose jobs are all
  partition-blocked while other tenants hold the top of the list. Worth revisiting only if the platform ever
  has thousands of concurrently active tenants, and that is a change to one query.

### Follow-ups the queue leaves open

- `maxInFlightPerTenant` is deliberately not defaulted — the right value depends on total worker count,
  which the library cannot know, and a wrong default silently throttles a single-tenant deployment. The P2
  conversation worker must set it, or AC16 holds for dispatch frequency but not for worker occupancy.
- `purgeSucceeded` has no caller yet. The P2 scheduler owns it. Until then, succeeded jobs accumulate; the
  retention window it is given is really the enqueue-idempotency window, so it must exceed the upstream's
  redelivery interval. **Closed by §4x.**
- `queue_jobs` carries no platform-scope policy, so P3's operator queue-depth metrics need a forward
  migration. It is safe to add — the table holds routing metadata only — but it should be a deliberate act.
- `dedupeKey` is enqueue idempotency, **not** the AC4 inbound-redelivery suppression. That record must
  outlive the queue row and belongs to the gateway with its own retention.

---

## 4e. Findings from the object storage increment

- **An HTTP HEAD response carries no body, so S3's error code is unavailable on it.** The first version of
  `verifyAccess()` did `HEAD /<bucket>`, which cannot distinguish "no such bucket" from "wrong credential"
  from "denied" — every startup misconfiguration collapsed to the same undiagnosable 403, defeating the
  whole point of a preflight under `environment-portability.md`. Caught only because the tests asserted
  the *specific* error class rather than that it failed. Fixed by listing one key instead: same round
  trip, and it proves reachability, credential validity, bucket existence, and read permission.
- **`URLSearchParams` is not the same encoder SigV4 requires.** It renders a space as `+` where SigV4
  requires `%20`, and encodes a different unreserved set. Sending one form while signing another is a 403
  that appears only for values containing the offending character — here, a listing continuation token,
  which is to say only once a tenant has enough objects to paginate. The query string is now written with
  the signer's own encoder.
- **A hand-written signer needs an external oracle, and SigV4 has one.** The published worked example is
  asserted at each intermediate stage — canonical request, string to sign, derived signing key — not only
  at the final signature, because a single end assertion says "it is broken" and nothing about where. This
  is the property `@zeddev/db`'s SCRAM implementation does not have and this one does.
- **A shared utility copied is a shared utility that will diverge.** `exponentialBackoff` moved from
  `@zeddev/queue` to `@zeddev/time` when storage needed the same curve — an object store on a free tier
  answers a burst with `SlowDown` for the same reason a queue's upstream does. `DEFAULT_BACKOFF` stayed in
  the queue, because the *parameters* are a property of what is being retried. Same move for
  `assertTenantId`, which now lives in a new `@zeddev/tenancy`: `@zeddev/storage` must not depend on
  `@zeddev/db` (an object store that drags in a PostgreSQL wire client is a `component-independence.md`
  violation), so the rule's home is neither of them. That rule is sharper in storage than in the database:
  a tenant id is a *path segment* in every object key, so a value containing `/` does not fail, it
  silently relocates one tenant's object under another's prefix.
- **The pagination loop is the part of a deletion sweep that is never exercised.** A continuation-token
  loop tested only below the page size is not tested, and what it breaks — `deleteTenant` stopping short —
  is precisely the promise `client-offboarding-and-data-retention.md` calls irreversible. The test fixture
  pins the page size to 2 so every listing in the conformance suite crosses at least one boundary.
  Relatedly, a truncated listing with no continuation token now raises rather than silently ending the
  loop.
- **A prefix sweep must not delete what it did not write.** A bucket may hold keys from another
  application on a small deployment. `deleteTenant` parses every key and skips what does not match the
  platform's layout, rather than deleting whatever the prefix returns.
- **Two harness scripts writing one `.env.test` is an ordering bug waiting to happen.** `scripts/db.sh`
  truncated the file; adding `scripts/storage.sh` would have meant whichever ran last silently disabled
  the other's suite — the §4c "green run that proves nothing" failure, arriving by a new route. Both
  scripts now upsert only their own `ZEDDEV_TEST_*` block. `scripts/require-db.ts` became
  `scripts/require-services.ts` and requires both, because the object store is the one place in the
  platform where isolation is *not* enforced below the application, so its isolation tests are the least
  affordable to skip.

### Follow-ups the object storage port leaves open

- No encryption of object *bodies* at rest. There is no confirmed spec requirement for it —
  `credential-and-secret-handling.md` scopes at-rest protection to credentials — but the §4 open question
  about whether the protection boundary must defend against an attacker holding the running host decides
  it, and knowledge documents plus inbound media are the largest body of client content outside the
  database. `@zeddev/secrets`' `SecretSealer` is the tool if the answer is yes.
- The authoritative index of stored objects belongs in PostgreSQL under RLS and does not exist yet. Until
  it does, tenant isolation for objects rests on the port's ownership check and unguessable ids rather than
  on row-level security. P1's business-knowledge work owns this.
- A bucket policy or IAM policy scoped to `<tenantId>/*` is expressible against the key layout and is not
  implemented. Worth doing when the platform runs somewhere that offers it.
- Nothing calls `verifyAccess()` yet; every service's startup path must, alongside
  `assertTenantIsolationEnforceable()`.
- `ensureBucket()` is deliberately not called on first write. Auto-creating on demand turns a typo in
  `STORAGE_BUCKET` into a silently-created empty bucket that the platform then writes tenant documents
  into — a data-loss shape that looks exactly like success.

---

## 4f. Findings from the identity increment

- **A failed login that throws from inside its transaction never locks anything out.** The whole point of
  `accounts.failed_attempt_count` is that it *persists*, and a `throw` inside `pool.transaction` rolls it
  back. The lockout would then never engage while every rejection test still passed — the failure is
  invisible from the outside, because the only observable difference is the eleventh attempt succeeding at
  full rate. Fixed by having every credential-evaluating transaction return a discriminated outcome and
  throwing after the commit. The test reads the column directly rather than only asserting the rejection,
  because asserting the rejection is exactly what would not have caught this.
- **The identity scope can write `access_records` and `tenant_lifecycle_events` but cannot read them
  back.** Both tables grant SELECT to the platform scope and to a bound tenant only. Three tests were
  written reading them under `withIdentityScope` and returned empty arrays — which is precisely what a
  *missing row* also looks like, so the first reading was "the record was never written". This is the §4c
  lesson arriving from a new direction: a query that returns nothing has two explanations and the policy is
  usually the one nobody checks. Worth knowing before P3 builds the operator's audit view.
- **A leak test over an empty result set passes for the wrong reason.** The assertion that no access record
  contains an email address was green while reading zero rows, for the scope reason above. It now asserts
  the row count is non-zero *first*. Same shape as §4d's needle-matching-a-fixture-identifier finding: a
  test that can be satisfied without exercising anything is worse than no test, because it is trusted.
- **A time-bounded test loop must be bounded by time, not by iterations.** The absolute-session-lifetime
  test kept a session active with three fixed sleeps and then waited for expiry. On a slow round trip the
  third resolution landed *past* the bound and the test failed inside its own setup, reporting a rejection
  where it expected success — a flake that looks like a real defect. Rewritten to loop while elapsed time
  is under a fraction of the window. Any test that races a real clock needs this shape.
- **Two identity spaces means accepting duplicated code.** `logIn` and `operatorLogIn` are structurally the
  same function against different tables, and factoring them into one helper parameterised by table name is
  the single most obvious cleanup in the package. It is also exactly how the spaces come to overlap: one
  conditional, one wrong argument, and a client credential reaches the operator table.
  `authentication-and-access.md` requires they "never overlap", so the duplication *is* the guarantee. Do
  not merge them.
- **Row-level security cannot express "this row is visible but this verb is not."** The operator can read
  the `tenants` row and must not be able to change activation state on it. The schema gets half of that
  — `tenants_platform_read` is `FOR SELECT` — but "may not offboard" is a verb on a surface, not a row
  predicate. That half necessarily lives above the database, which is why `ACTION_PRINCIPALS` exists and
  why it is a table rather than a set of route checks.
- **Provisioning needed a seam, and the seam had to be tested even though it is empty.** The
  `provisionTenant` hook does nothing today because the tables later phases will populate do not exist.
  What is fully implemented is the *failure* semantics around it, and there is a test that drives a
  throwing hook through the rollback, the `failed` state, the refused login, the unaffected bystander
  tenant, and the successful retry of the same link. That is the expensive part to retrofit; the body is
  not.
- **A reset link and a verification link are not equally dangerous, and should not share a lifetime.** A
  reset link is account takeover in one click and is requestable by anyone who knows an address; a
  verification link is only useful to someone who already controls the mailbox. Defaults are one hour and
  twenty-four hours respectively.
- **A reset must clear the lockout.** Otherwise the client locked out by an attacker's guessing — which is
  the most common reason anyone reaches the reset flow — completes it and still cannot log in, and
  `client-signup-and-tenancy.md`'s "recover access without operator involvement" is false in the one case
  it most needs to be true.
- **A wrong current password on the authenticated change surface must not count toward the lockout.** That
  surface already requires a valid session, so incrementing there lets anyone holding a stolen session lock
  the rightful owner out — converting a confidentiality breach into a denial of service against the victim.

### The numbers §4 left open, now decided

`authentication-and-access.md` explicitly defers these ("must be defined at implementation time"). They are
now `IDENTITY_*` keys in `docs/configuration.md`, with the reasoning recorded beside each default in
`src/lib/identity/config.ts`: session inactivity 12h, absolute lifetime 7d, lockout at 10 consecutive
failures for 15m, verification link 24h, reset link 1h, minimum password length 12. Startup additionally
refuses an absolute lifetime below the inactivity timeout — individually valid on both keys, and jointly it
leaves only one of the two required expiry rules in force.

### Follow-ups the identity increment leaves open

- **The common-password blocklist is a few hundred stems carried in source, not a breach corpus.** It
  covers the top of the frequency table, which is where the mass is, but a real deployment should check
  against a breached-credential list. That needs either a dependency or a data file, and both deserve a
  deliberate decision rather than being smuggled in here.
- **Multi-factor authentication for the operator is still open** (§4). Nothing in this increment forecloses
  it — the operator login path is separate, so a second factor lands in one function.
- **`resolveClientSession` records only denials, not successful resolutions.** Recording every request
  would put one row per request into an append-only table on a platform whose premise is near-zero fixed
  cost, and it would say nothing the login record does not. If an audit requirement later demands
  per-request records, that is a deliberate change with a retention policy attached, not a default.

Resolved by the API increment (§4h): the mail port now has a caller (`services/api` composes and sends),
`createOperator` now has a caller (`cli.ts create-operator`), and `assertTenantIsolationEnforceable()` now
has a caller (the database preflight in `start.ts`). `verifyAccess()` for a held object store is still
uncalled — no service holds a store yet.

---

## 4g. Findings from the mail increment

- **The port cannot express more than one recipient, HTML, or attachments.** A recipient list is where a
  verification link addressed to one account reaches another, through a loop bug or header injection, and
  it is how a sending surface becomes an open relay. It is the same move as the storage port refusing keys:
  the dangerous operation is absent rather than guarded. `buildMessage` validates every caller-supplied
  field before a byte is written, because a business name or address containing CR/LF is a header injection.
- **Message bytes are built in exactly one place, and both adapters call it.** A fake that encoded its own
  way would accept what the real server rejects. But a fake still cannot disagree with an encoder it
  shares, so Mailpit's HTTP read-back is the external oracle: tests assert on what arrived, not on what we
  believe we sent.
- **There is no opportunistic STARTTLS.** `MAIL_TLS` is `disable`, `starttls` (required, and fails if not
  offered), or `implicit`, and it is never inferred from the port. Opportunistic TLS silently downgrades
  credentials to cleartext when a server stops advertising it, and nothing observable changes. AUTH over
  cleartext also needs `MAIL_ALLOW_INSECURE_AUTH`, which only the test container sets.
- **A preflight must name the value to fix.** `verifyAccess()` maps the failing SMTP phase (connect,
  greeting, EHLO, STARTTLS, AUTH, transaction) to the `MAIL_*` keys that govern it. This applies the §4e
  lesson about collapsed 403s before it could recur.
- **SMTP's `<CRLF>.<CRLF>` terminator owns the body's final line break.** `buildMessage` never ends with one
  and strips trailing newlines. Otherwise 7bit and base64 bodies would round-trip differently depending on
  whether the text happened to be ASCII.
- **Parallel test files share one mail server, so no fixture may clear it.** Each fixture owns a unique
  recipient domain. The first draft of `scripts/mail.sh` claimed tests cleared the mailbox, which was wrong
  and has been corrected.
- **One connection per message, no pooling.** At signup-and-reset volume a pool buys nothing, and a
  silently dropped idle connection is a failure that only appears in production. Revisit if operator
  alerting starts sending in bulk.

### Follow-ups the mail increment leaves open

Both resolved by the API increment: see §4h. `services/api` now composes and sends through `@zeddev/mail`,
and a failed send is recoverable through `POST /v1/email-verification/requests` (resend) or a fresh
`POST /v1/password-resets/requests` (each mints a new token rather than needing a transaction spanning
SMTP).

---

## 4h. Findings from the API increment

- **Leaving a `for await` loop over an `IncomingMessage` early destroys the socket, not just the loop.** A
  `throw` or `break` out of the loop abandons the request stream, and Node tears down the underlying socket
  with it — so the 413 reply for an oversized *chunked* body was never delivered; the caller just saw a
  reset connection. The declared-`Content-Length` check hid this in the first round of tests, because that
  path rejects before the body is ever read. Fixed by reading and discarding to the end of the stream
  instead of bailing out early; a regression test sends a chunked oversized body specifically, since a
  declared-length one would not have caught the original bug either.
- **The portability guard exempts only bare `example.com`/`example.org` hosts in URL literals** — not
  subdomains. `https://app.example.com` inside a schema's `example:` field was flagged as an embedded
  endpoint. That is the guard working correctly, not a false positive: the fix was to change the example to
  a bare exempted host, not to loosen a guard whose whole point is to have no exceptions worth remembering.
- **The official PostgreSQL image's `POSTGRES_USER` is a superuser.** A Compose file that simply pointed
  the service at it would have started with no tenant isolation at all, silently — the §4c finding arriving
  a second time, now against the platform's own container image rather than a test fixture. The service
  itself refuses this now (the preflight in `start.ts`), so the failure mode changed from "silent" to
  "startup fails loudly." `deploy/postgres/10-application-role.sh` creates a `NOSUPERUSER NOBYPASSRLS` role
  that owns the database on first container start, with values passed as psql variables rather than
  interpolated into SQL text, so a quote inside a password cannot alter the statement.
- **`core.autocrlf=true` on the Windows checkout means shell scripts mounted into Linux containers can
  arrive with CRLF line endings**, which makes the shell fail with a "missing interpreter" error that has
  nothing obviously to do with line endings. `.gitattributes` now pins LF for `*.sh`, `Dockerfile`, and
  `*.yaml` — the files that actually run inside a Linux container — regardless of the checkout platform.
- **The repo root's `.env` is a developer convenience file, not the platform's configuration.** Compose
  verification for this increment was done in a temporary copy of the repo, under a separate Compose
  project name, specifically so nothing in that process could overwrite it. That file must never be
  overwritten by tooling.
- **Startup reports every missing configuration key across every package's schema in one error, not the
  first one it finds.** `loadAll` in `start.ts` collects every package's schema failures into a single
  `ConfigurationError`, emitted both as one JSON log record per key (`configKey`, `reason`) and as plain
  text on stderr — because a log pipeline that is not set up yet (the common case for a first deploy)
  identifies nothing, and stopping at the first missing key would turn configuring the service into a
  fix-one-restart-repeat loop.
- **Logging carries the matched route *pattern*, never the raw request path.** The `route` operational
  field is always something like `/v1/email-verification`, never the literal path a caller sent, because
  the raw path is caller-supplied and a caller can paste a token into a query string — which would put a
  credential-shaped value into every access log line for that request.

### Follow-ups the API increment leaves open

- The API image copies the whole `src/` tree, including other services' sources once they exist. Harmless
  today with one service, but worth narrowing to the service's own workspace closure once a second service
  lands, so a change to an unrelated service does not change this image's bytes.
- No per-recipient mail cooldown: repeated reset requests for one address are bounded only by the
  per-source throttle, so a distributed caller can still mail a victim repeatedly — each request invalidates
  the previous link. A cooldown belongs in `@zeddev/identity`, not `services/api`, because it must hold
  across instances; keyed on the latest token's `created_at`.
- No operator password recovery: `create-operator` refuses a duplicate address, and there is no reset path
  for a locked-out or forgotten operator credential. When needed, this should be a deliberate CLI command,
  not a route.
- Compose does not terminate TLS. On a VPS a reverse proxy must, and `API_TRUSTED_PROXY_HOPS=1` must be set
  to match it or the client-address derivation (§1) breaks. Object storage (MinIO) joins `compose.yaml`
  when the first service that holds a store lands.
- The rate limiter is per process, not shared — see the decision in §1.

---

## 4i. Findings from the persona increment

- **A persona row exists only once it is complete, so "is persona done?" is "does the row exist?".** The
  save refuses a submission without a bot name and the column is `NOT NULL`, so there is no separate
  `complete` flag that could disagree with the data. The same reason keeps provisioning from seeding a
  default row: a default persona would make every new tenant look configured.
- **Length limits must be counted the way the database counts them.** JavaScript's `length` counts UTF-16
  units; PostgreSQL's `length()` counts characters. With a naive `length` check a 30-emoji name is refused
  by the application and accepted by the database, and a limit enforced in only one of the two places turns
  a boundary input into a 500. `@zeddev/bot` counts code points, the migration's CHECK uses the same
  numbers, and a test saves a 50-emoji name through both.
- **Option lists stored twice are asserted to agree.** `FORMALITY_LEVELS` and `STYLE_TRAITS` are mirrored as
  CHECK constraints, the same way `secret_class` mirrors `SECRET_CLASSES`. A test saves every offered value
  and confirms that a value outside the list is refused, so the two copies cannot drift without a failing test.
- **A read on an unbound connection must fail loudly, not come back empty.** Row-level security fails
  closed, but for a read that looks exactly like "never configured", which would report a configured bot
  as not ready. `@zeddev/bot` checks `connection.boundTenantId` in-process (no extra round trip) and throws
  `DefectError`.
- **Tenant-scoped routes go through one function that names the action.**
  `IdentityService.withClientAction(token, action, resource, fn)` resolves the session, checks the action
  against `ACTION_PRINCIPALS`, records the decision out of band, and only then opens the tenant
  transaction. `services/api`'s `asClient` is its only caller. Cost: every configuration read writes one
  `access_records` row. That is acceptable at configuration-screen volume, but a high-frequency read route
  (such as a polling transcript view) should decide deliberately whether it needs a per-call record.
- **Nothing caches a persona, and nothing should without an invalidation plan.** AC5 and AC11 ("the next
  reply reflects the change") hold because the reply path reads the persona inside the transaction that
  assembles the reply. `personaDirectives` is the single renderer of the persona section, and P2's prompt
  assembly must call it rather than render the fields itself.

### Follow-ups the persona increment leaves open

- `bot_personas` has no platform-scope policy, on purpose: freeform text is client-authored content.
  `bot-activation-control.md` AC12 (the operator can *view* readiness and activation) therefore needs a
  derived readiness/activation state the platform scope can read, such as columns on `tenants` or a small
  table of its own. It must not add a platform policy to `bot_personas`. The readiness increment owns this.

---

## 4j. Findings from the readiness and activation increment

- **The rule that matters is the one on every *other* path.** Rejecting go-live when not ready is one check
  on one request. Switching an active bot off when readiness is lost must hold on paths that do not exist
  yet — the gateway seeing a revoked authorization, the scheduler giving up on reconnection, offboarding.
  An application-level "remember to call reevaluate" would fail open the first time one forgot. So:
  `CHECK (NOT active OR ready)` on `bot_activation`, AFTER triggers on every readiness input
  (`whatsapp_connections`, `bot_personas`) that re-evaluate in the same transaction, and a trigger that
  appends every on/off change to `bot_activation_events`. Tests drive a raw `DELETE FROM bot_personas` and a
  raw `UPDATE` of the connection to prove paths around the library are covered.
- **Readiness is stored because the operator may not read its inputs.** AC12 lets the operator see
  readiness, but persona is client-authored content with no platform policy. `bot_activation.ready` /
  `unmet_conditions` are the derived facts the platform scope can read; they cannot go stale because the
  triggers rewrite them in the same transaction as any input change. The client status reads the same row.
- **Lock before reading the inputs.** `app.reevaluate_bot_readiness` takes the `bot_activation` row lock
  first and is VOLATILE (fresh snapshot per statement under READ COMMITTED), and `setBotActive` calls it
  before deciding. Whichever of "go live" and "connection failed" commits second re-reads the other's
  result, so the bot cannot end active on a failed connection. A test races the two ten times.
- **Row-level security applies to migrations too.** Migration 0007's backfill could not simply `INSERT ...
  SELECT FROM tenants` — the migration role is subject to FORCE RLS like everyone else and sees nothing. It
  loops over tenant ids under the platform scope and binds each tenant with `set_config('app.tenant_id', ...)`
  before re-evaluating, i.e. it goes through the same policies as the application rather than around them.
  A test migrates to 0006, saves a persona, then migrates to latest and checks the backfill.
- **History is written by triggers, not by the library.** Both `whatsapp_connection_transitions` and
  `bot_activation_events` are appended by triggers and have no UPDATE/DELETE policy, so AC10/AC13's "every
  change is recorded" does not depend on callers.
- **The reply gate must be asked inside the sending transaction.** `mayAutoRespond` is the only question
  P2's conversation worker may ask, and it must be asked in the transaction that sends or records the
  reply, not once per burst ahead of time — that is what makes AC6's "immediate effect" true for a reply
  already being generated when the client paused. It takes no clock or schedule, which is AC5's 24/7
  structurally.
- **`withOperatorAction` was added to `IdentityService`**, the operator counterpart of `withClientAction`
  (resolve → authorize and record → platform scope). The first operator data route (`GET
  /v1/operator/bot-statuses`) uses it; future operator routes should too, rather than `withOperatorSession`,
  so each names its action.

### Follow-ups the readiness increment leaves open

- No client route can move a connection to `connected`; only `transitionConnection` can, and only the P2
  gateway may call it with `connected`, after real send/receive verification. Nothing structural enforces
  that yet beyond there being no route; when the gateway lands, consider requiring verification evidence in
  the call.
- Bounded automatic reconnection (`reconnecting → error` with `recovery_exhausted`) needs the scheduler and
  an attempt/time policy, which `whatsapp-number-connection.md` leaves to implementation. **Closed by §4x.**
- The P2 reply path must call `mayAutoRespond` in its sending transaction; its tests should assert that.
- Concurrent *first* transitions for a tenant with no `whatsapp_connections` row can race on the INSERT and
  one fails with a unique violation; harmless at the volume a single client's connect flow produces, but the
  gateway should retry it.
- Readiness currently requires only persona and a connection, as the spec assumes. If business knowledge or
  behavior rules ever gate readiness, that is a new clause in `app.bot_readiness_unmet`, a new trigger, and
  a new entry in `READINESS_CONDITIONS` (a test asserts the TS list equals the SQL function's output).

---

## 4k. Findings from the behaviour rules increment

- **A rule's shape follows from what "structured" has to mean to be enforceable.** **[DECISION]** A rule is
  a `kind` from a fixed list (`never` / `always` / `only_when` / `avoid_topic`) plus one or two
  plain-language phrases plus an `action` from a fixed list (`respond` / `handoff` / `fallback`). The
  condition is required for `only_when`, optional for `always` ("before Y"), and refused for `never` and
  `avoid_topic` — those two kinds are the condition. `always` rules may only take `respond`: "always hand
  off" is a handoff *trigger*, and that vocabulary is owned by `human-handoff.md`'s configuration, not this
  one. CHECK constraints in migration `0008_bot_behavior_rules` mirror all of this, and a test asserts the
  library and the database agree for every kind×action combination — the same double-bookkeeping discipline
  §4i used for option lists.
- **Limits exist because of what gets sent on every reply, not as arbitrary hygiene.** **[DECISION]** Phrases
  ≤300 characters, freeform text ≤4000 characters, ≤100 rules per tenant. The spec leaves limits to
  implementation; these ones exist because every *enabled* rule is rendered into every reply's prompt, and
  prompt tokens are the direct cost driver on a free-tier AI provider. The 100-rule cap is enforced under a
  per-tenant `pg_advisory_xact_lock`, tested with five concurrent creates racing for the last slot: exactly
  one wins, the rest get `ConflictError` → HTTP 409.
- **Directives are absent, not empty, when nothing applies.** `behaviorDirectives(configuration)` renders
  only enabled rules plus the freeform text, JSON-quoting client-authored phrases so a phrase cannot break
  out of the prompt structure, and returns `undefined` when there is nothing to say — AC1 requires the
  section be *absent*, not present-and-empty. The handoff and fallback actions render as the literal strings
  `"handoff"`/`"fallback"`; P2's reply output protocol must define what those two action names mean on the
  wire, and must resolve a `handoff` action against `human-handoff.md`'s availability (including the case
  where handoff is disabled, which presumably falls back to `fallback` — that routing is P2's decision, not
  this increment's).
- **A rule is named by `id` in the JSON body, not a path segment.** The router matches exact paths only, by
  design (see `AGENTS.md`), so `PUT /v1/bot/behavior-rules/rule` and `PUT
  /v1/bot/behavior-rules/rule/enabled` both take `{ id, ... }` in the body rather than `/rule/:id`. Deletion
  is `POST /v1/bot/behavior-rules/rule/delete` rather than `DELETE` with a body, because an intermediary
  (proxy, gateway, some HTTP client) may silently drop a body on a `DELETE`, which would turn "delete this
  rule" into "delete nothing" with no error.
- **Another tenant's rule id is indistinguishable from one that never existed.** Both produce a 404
  `resource.not_found`. Row-level security simply hides the row rather than the route checking ownership
  explicitly, so there is nothing for a client to enumerate — the same "even if guessed" property §1 already
  requires of tenant ids generally.
- **Coverage here is at the instruction layer only.** 15 of `behavior-rules-configuration.md`'s 16
  acceptance criteria are covered by what the reply path *would* read and render, because P2's reply path
  and the AI port do not exist yet. AC2–AC8 need to be re-verified against actual bot output once they do;
  passing today proves the configuration and rendering are correct, not that a reply obeys a rule.

### Follow-ups the behaviour rules increment leaves open

- AC2–AC8 need output-level tests once P2's reply path exists; today's tests only prove the instruction layer
  is correct.
- The spec leaves structured-rules-versus-freeform-instructions precedence open — both are binding
  simultaneously, with no precedence between them — and `behaviorDirectives` renders them accordingly
  (both sections present, neither overriding the other). Revisit only if a real conflict between the two
  surfaces in practice.

---

## 4l. Findings from the fallback messages increment

- **Resolution is a fixed chain, not a fallback-to-fallback pun.** For each of the three triggers
  (`ai_error`, `low_confidence`, `out_of_scope`), `resolveFallbackMessage` tries the trigger's own message,
  then the tenant's shared message, then `PLATFORM_DEFAULT_FALLBACK_MESSAGES[trigger]` — neutral English
  wording, one entry per trigger, so a client who has configured nothing still gets a trigger-appropriate
  reply rather than one message stretched across three situations. `fallbackMessageFor(connection,
  trigger)` is the one function the reply path may call; it and preview both go through
  `resolveFallbackMessage`, so the two can never disagree about what a save actually produces.
- **A row exists only once something is configured — the same invariant §4i gave personas.** Saving with
  every message blank `DELETE`s the row rather than writing an all-NULL one; there is no separate
  "configured" flag that could disagree with the data, and provisioning never seeds a default row, for the
  same reason a default persona would make every new tenant look configured.
- **Preview must cover a draft that was never saved, because a save is not observable until the next
  message.** AC12 asks that an author see resolved text "before [changes] take effect." A save takes effect
  on the *next* inbound message, so previewing only the saved configuration cannot show the effect of an
  edit still sitting in the form. `POST /v1/bot/fallback-messages/preview` validates a draft exactly as a
  save would and resolves it, storing nothing; `GET`/`PUT` also return the resolved preview of whatever is
  currently saved, so saved and unsaved configurations are previewed through the same resolver.
- **An unauthenticated echo endpoint is an open reflector.** The preview route reads no tenant data — it
  only validates and resolves whatever the caller sent — which made "why require a session for it" a live
  question. Without one, the route is a free service that reflects arbitrary text back at arbitrary volume,
  an amplification/relay primitive wearing the platform's name. It requires a session
  (`tenant.configuration.read`) even though the session's tenant binding is otherwise unused by this route.
- **Persona/tone and behaviour-rule compliance are properties of the client's authored text, not of the
  platform.** AC8 (tone) and AC9 (disclaimers) need no rendering step analogous to `personaDirectives` or
  `behaviorDirectives` — fallback text is sent verbatim, so "reflects configured persona" and "includes a
  required disclaimer" are satisfied, or not, by what the client typed. That is the same conclusion the §3
  "fallback tone versus availability" conflict reaches from the availability side: literal text is what
  makes both requirements simultaneously satisfiable, and it is why the spec was amended to say so.
- **Three near-identical validators is a smell worth fixing before a fourth copy appears.** `persona.ts`,
  `behavior.ts`, and `activation.ts` each carried their own `requireTenant` and their own code-point-counting
  and multi-line-text rules; `fallback.ts` would have been a fourth copy of all of it. Extracted to
  `src/lib/bot/shared.ts` (`characters`, `CONTROL`, `CONTROL_EXCEPT_LINE_BREAK_AND_TAB`,
  `parseMultilineText`, `requireTenant`), not exported from the package — an internal seam, not new public
  API — and the three existing modules were refactored onto it in the same increment rather than left to
  drift.
- **`ValidationError` sorts its issues by key.** A test written to expect issues in push order rather than
  key order fails in a way that looks like a validation bug but is a test-authoring mistake; see the
  `AGENTS.md` gotcha.

### Follow-ups the fallback increment leaves open

- P2's reply path must call `fallbackMessageFor` inside the sending transaction, alongside `mayAutoRespond`,
  and send the resolved text verbatim — never through the AI provider.
- Each fallback occurrence must be recorded with its triggering condition (AC10) in a tenant-scoped table
  that does not exist yet.
- Exactly one fallback per triggering message (AC13) ties into inbound dedup, which P2 also owns.
- `PLATFORM_DEFAULT_FALLBACK_MESSAGES` is English-only; when language configuration lands, defaults become
  per-language, since `language-configuration.md` requires fallback text in the configured language.
- The spec's own new open question: whether the fallback screen should show the client's active behaviour
  rules and persona, to help the client author compliant text.

---

## 4m. Findings from the disclosure increment

- **The default is the absence of a row, not a seeded row.** **[DECISION]** AC8 requires a new bot to have a
  defined mode without the client configuring it. Seeding a row at tenant creation was rejected: tenants are
  created under the identity scope before any tenant is bound, so a seeding trigger or insert would need a
  policy letting the identity scope write bot configuration — widening the one scope that crosses tenants.
  Test fixtures insert tenants under that scope too, which is how the problem surfaced. So a tenant with no
  row follows `PLATFORM_DEFAULT_DISCLOSURE_MODE` ("disclose", the spec's stated assumption), and the view
  reports `source: 'platform_default'` vs `'client'` so the screen is accurate either way (AC9).
- **The cost of that shape is recorded where someone changing it will look.** Changing the platform default
  would silently flip every tenant that never chose. Migration 0010's header and the constant's doc comment
  both say a default change must first be a migration that materialises the *old* default per never-chosen
  tenant (binding each tenant, as 0007's backfill does). An explicit choice of the default mode is still
  stored as a choice, so it survives such a change.
- **The mode is required on save; there is no "reset to default".** A save with the field missing is a 400,
  not a return to the default, because a form that forgot the field would otherwise flip the bot's behaviour.
  Exact values only — no case-folding — so "exactly two modes" cannot widen.
- **"Do not disclose" renders no instruction about denial.** The spec does not require denial and assigns
  whether evasion or denial is allowed to behaviour rules, so `disclosureDirectives` forbids volunteering
  and says nothing else; a test asserts the do-not-disclose text does not mention humans at all.

### Follow-ups the disclosure increment leaves open

- P2's prompt assembly must call `disclosureDirectives(disclosureModeFor(tx), { conversationStart })` in the
  reply transaction and decide `conversationStart` (§3 recommends the memory-reset boundary).
- AC1–AC4 need output-level tests once the reply path and AI port exist; AC6 needs transcripts (P3).
- The disclosure statement's exact wording is left to the model in the persona's voice. If deterministic
  wording is ever required (e.g., for a regulated client), the reply path would prepend literal text instead,
  the way fallback text is sent verbatim.

---

## 4n. Findings from the handoff configuration increment

- **Default is disabled, with all three built-in triggers pre-selected.** **[DECISION]** The spec names no
  default. A handoff pauses a conversation until a person at the business acts, and the notification channel
  is still undecided (§4) — so a client who never opened the setting would have conversations silently
  parked on a person nobody knows is needed. Disabled means those messages get the fallback reply instead.
  The triggers are pre-selected so that switching handoff on without touching them is AC2's "default trigger
  conditions". Same no-row-means-default shape as §4m, for the same identity-scope reason.
- **"Disabled" is a routing rule, not an absent section.** AC1 requires a message that *would* match a handoff
  condition to get fallback behaviour. So `handoffDirectives` always renders: enabled lists the conditions with
  the `"handoff"` action; disabled tells the model not to offer a person and to take `"fallback"` wherever a
  request would call for one — including a behaviour rule whose action is `"handoff"`, which `behaviorDirectives`
  renders unconditionally. `resolveHandoffSignal(policy, signal)` is the runtime backstop and the single place
  the decision is made: disabled → fallback (`out_of_scope` message) for any signal; enabled → handoff only for a
  behaviour rule or a *currently configured* trigger/condition. This also answers §4k/§4l's open question of how
  a `handoff` rule action resolves when handoff is off.
- **Enabled with nothing to trigger it is refused, in both places.** It would read "on" and behave as "off". The
  validator and the CHECK `bot_handoff_settings_enabled_has_trigger` both refuse it; disabled with no triggers is
  fine. `setHandoffEnabled` locks the row before checking so a concurrent save cannot interleave.
- **Client conditions are a `text[]` checked by an IMMUTABLE SQL function**, not a child table: the list is
  saved whole, so one row and one upsert keep a save atomic without ordering or replace-all logic. The function
  `app.bot_handoff_conditions_valid` enforces per-element length, trim, single-line, and no repeats; a test
  drives each through raw SQL. A repeat is refused rather than merged, so the screen never shows fewer
  conditions than the client typed.
- **The configuration never touches conversation state**, which is how AC13 ("disabling does not reactivate a
  paused conversation") will hold: P2's pause state must not be derived from, or reset by, this row.

### Follow-ups the handoff configuration increment leaves open

- AC6–AC13 (notification, per-conversation pause, retention while paused, client and system resume, status and
  history) need conversations — P2. The pause record must store the `HandoffSignal` it was raised with (a custom
  condition by its text), so later edits to the configuration cannot rewrite history.
- The system-side resumption condition (AC10) is undefined; the spec leaves it to a later phase.
- The spec's "unless the client's trigger configuration explicitly says otherwise" (cross-conversation scope)
  is not offered; handoff state is per conversation only.
- The notification channel is still a §4 decision.

---

## 4o. Findings from the business knowledge (freeform entries) increment

- **An entry is one block of text and nothing else.** **[DECISION]** No title, category, or tags: AC2 requires
  "without any required structure", and an optional title would become a field the screen nags for. An edit
  replaces the text in place and keeps the id and list position (`position` identity column, same reason as
  §4k: two entries created in one transaction share `now()`).
- **Limits: 4000 characters per entry, 100 entries per tenant.** **[DECISION]** The spec assumes no limit and
  leaves any to implementation. What one prompt carries is bounded separately (§4z); bulk knowledge belongs in documents. The per-entry
  limit is mirrored by the CHECK in migration 0012 (tested at the boundary with 4000 emoji), and the cap is
  enforced under a per-tenant advisory lock, raced by five concurrent adds for the last slot.
- **A blank entry cannot exist.** It would make knowledge read as "configured" while telling the bot nothing.
  The validator refuses it and the CHECK refuses empty or untrimmed content. Removing an entry is what delete is for.
- **"Recommended but not required" (AC10) sits beside readiness, never inside it.** `describeKnowledgeStatus`
  is merged into `GET /v1/bot/status` and `PUT /v1/bot/activation` responses as `businessKnowledge` by one
  helper (`statusBody` in `app.ts`), read in the same transaction as the readiness row. AC9 is structural:
  no clause in `app.bot_readiness_unmet`, no readiness trigger on the table — a test goes ready with no
  knowledge and adds/removes an entry without readiness changing.
- **Entries render JSON-quoted.** An entry is multi-line; quoting keeps one entry from reading as the start of
  the next, or as an instruction about the list. `knowledgeDirectives` returns `undefined` when nothing is
  configured, so the section is absent rather than present and empty.
- **Knowledge is the second area that must answer "configured" from two sources.** `knowledgeConfigured` is
  the one place that answer is computed; when documents land it must count them too, or a client who only
  uploads would be told knowledge is unconfigured.

### Follow-ups the knowledge-entries increment leaves open

- Document upload (AC3, AC4, and the document halves of AC5, AC8, AC12) — blocked on the §4 formats/size
  decision. Needs a `bot_knowledge_documents` table (the authoritative index of stored objects under RLS, per
  §1's object-storage decision), processing with a visible failed state, and inclusion in `describeKnowledge`,
  `knowledgeConfigured`, and `knowledgeDirectives`' input. This is also the first service to hold an object
  store, which puts MinIO in `compose.yaml` and requires calling `verifyAccess()` at startup (§4e).

## 4p. Findings from the AI provider port increment

- **Tested against local stubs of each upstream, not a live model.** **[DECISION]** Unlike MinIO and Mailpit, a
  real model needs a credential in CI, spends the free-tier quota the platform itself depends on, and cannot be
  made to return a 429, a safety block, or a stalled body on demand. The stubs (`src/lib/ai/stubs.ts`) *decode*
  each wire format back into the port's vocabulary before consulting the same `ScriptedBackend` the fake uses,
  so "the model saw exactly this conversation" is asserted against what crossed the socket. **Risk:** the stubs
  are written from the providers' documentation. Before go-live, run one manual smoke test per adapter against
  the real upstream (Gemini free tier; Groq or a local Ollama for the OpenAI-compatible adapter).
- **Unverified: thinking models and `maxOutputTokens`.** Gemini 2.5 models think by default, and reasoning
  tokens may count against the output bound. With a small bound the reply could come back empty
  (`ai.empty_response`). Check during the smoke test; if confirmed, either give the reply path headroom or add a
  thinking-budget setting to the Gemini adapter.
- **A second, non-retryable AI error class.** `AiRequestRejectedError` in `@zeddev/errors`: same kind
  (`ai_generation`, so fallback catches both) but `retryable = false`, for a bad credential, a missing model, a
  malformed request, a content-filter block, or a capability the model lacks. Retrying those only burns quota.
- **Validation, merging, retry, and classification are written once and shared by every adapter and the fake.**
  `normalizeGeneration` merges consecutive same-side turns and adjacent texts (joined with a blank line), so a
  swap cannot change how a burst is shown to the model. `runAttempts` owns retry: 408/425/429/5xx, timeouts,
  and dropped connections are retried; everything else is not. The fake reports scripted failures as HTTP
  statuses and goes through the same loop, so it cannot drift from the adapters.
- **Capabilities are declared (`AI_CAPABILITIES`), not probed.** A model's capabilities belong to the model,
  and probing costs quota. A request needing an undeclared capability is refused before anything is sent
  (`ai.capability_unsupported`). Accepted media types are the *intersection* of the two upstreams (JPEG/PNG/WebP;
  OGG/MP3/WAV/FLAC), so a swap cannot change which media is understood. WhatsApp AMR/AAC/MP4 audio is refused
  (transcoding is not in scope); `audioMediaType`/`imageMediaType` map WhatsApp's raw types.
- **Upstream quirks are handled in the adapter, not the loop.** Gemini answers a bad key with 400 +
  `API_KEY_INVALID`; the adapter reports it as 401 so the operator sees `ai.unauthorized`. Upstream error
  *messages* are never read (they quote the request back); only code-shaped values survive `safeProviderCode`.
  The Gemini key goes in `x-goog-api-key`, never `?key=`.
- **`Retry-After` is honoured up to 20 s (`MAX_RETRY_WAIT_MS`), then the call fails at once.** A free-tier 429
  means either "this minute" or "today"; waiting out the second would hold a worker for hours.
- **The per-attempt timeout runs on the injected `Clock`**, so `FakeClock` drives it.
- **`fetch`, not the hand-written transport from `@zeddev/storage`.** That transport exists because SigV4 signs
  exact headers; neither AI upstream signs anything, and `fetch` gives abort-covers-body and native multipart.

### Follow-ups the AI port increment leaves open

- ~~AC4 verification mode and a candidate-provider configuration: P4.~~ Done, §4ab.
- AC7: an output-level check that no provider identity reaches an end-customer needs the reply path.

---

## 4q. Findings from the prompt assembly and reply preview increment

- **One reply path, so a preview cannot lie.** `generateReply` (`src/lib/bot/reply.ts`) is the only function
  that assembles instructions, calls the provider, and interprets the answer. The preview route calls it via
  `previewReply` with one sample message as the opening turn; the conversation worker must call it with the
  real conversation. A preview with its own prompt could pass while live replies disagree (behaviour-rules
  AC16), which is why there is no second assembler.
- **[DECISION] Output protocol is a tagged first line, not JSON.** `[reply]` + message, `[handoff] <trigger |
  custom "…" | rule N>`, `[fallback] <out_of_scope | low_confidence>`. Free text with quotes and emoji is
  escaped less reliably inside JSON by small free-tier models, and JSON mode is a provider feature the port
  does not expose. This also settles where confidence and scope detection come from: the model declares them.
- **[DECISION] Untagged output with no tag anywhere is accepted as a reply.** Small models drop format
  instructions often; turning every such answer into an apology would tie quality to formatting obedience.
  A tag anywhere but the first line, empty output, truncated output, control characters, or more than 4096
  characters (WhatsApp's per-message limit) becomes the `ai_error` fallback with cause `unusable_output` or
  `truncated` — never a sent message (text-conversation-handling AC7).
- **Rules are numbered by `enabledBehaviorRules`**, the one definition used both by `behaviorDirectives`
  (`[rule N]`) and by `interpretReply` to map "rule N" back. A cited rule whose action is not `handoff`, or a
  custom condition the client never wrote, cannot pause a conversation; it becomes the out-of-scope fallback.
- **A behaviour rule's `fallback` action maps to `out_of_scope`**, as §4l recommended.
- **Handoff honoured only if offered.** The `[handoff]` form appears in the protocol only while handoff is
  enabled; a handoff line with handoff disabled is resolved by `resolveHandoffSignal` to the fallback, with
  cause `handoff_unavailable`.
- **A provider failure is decided, not thrown**: an `ai_generation` error becomes the `ai_error` fallback
  (fallback AC5), and the route logs `api.preview.generation_failed` with kind/code only, no content.
- **Preview is rate-limited per tenant** (`API_PREVIEW_RATE_LIMIT`, `API_PREVIEW_RATE_WINDOW`), because every
  preview spends the free-tier quota all tenants' live conversations share. The limiter is per-process.
- **The configuration read is one tenant-bound transaction; the model call happens after it commits**, so a
  slow provider holds no database connection.
- **`services/api` now requires `AI_BASE_URL` and `AI_MODEL`.** A developer `.env` from before this increment
  lacks them, and `docker compose up` will refuse to start the API until they are added (the template in
  `docs/configuration.md` lists them). Credentials are not verified at startup: proving one works costs a
  generation from the shared quota.
- **Raw control characters had got into five source files** (NUL/BEL test fixtures and a NUL separator in
  `src/lib/queue/types.ts`), which made git show those files as binary. They are now `\u` escapes, and
  `src/lib/testing/source-text.test.ts` fails the build on any raw control character under `src/` or
  `scripts/`.

### Follow-ups the reply increment leaves open

- The conversation worker (P2) must call `generateReply` with real turns and the right `conversationStart`,
  resolve fallback text inside the sending transaction, and record each fallback with its trigger and cause
  (fallback AC10).
- Output-level tests of behaviour rules AC2–AC8 and disclosure against a real model are still missing; today's
  tests pin the prompt and the interpretation, with the model faked.
- Language, retrieved knowledge, and conversation memory are not yet sections of `replyInstructions`.
- The preview rate limit is per-process; a multi-instance deployment admits N× the limit. Acceptable while the
  platform runs one API instance.

---

## 4r. Findings from the inbound gateway increment

- **The stored message is the duplicate-suppression record.** **[DECISION]** The spec leaves open how long
  suppression must last. A separate "seen ids" table would need its own retention window, and every choice of
  window is a bet on Meta's redelivery behaviour. Making `(tenant_id, external_id)` unique on the message itself
  means suppression lasts exactly as long as the message exists. The queue's `dedupeKey` is still set (belt and
  braces) but is not what AC4 rests on — a test completes and purges the original job before redelivering.
- **A fifth RLS scope, `app.inbound_scope`.** Same ordering constraint as identity and dispatch: a notification
  names a number, not a tenant. Its reach is `whatsapp_number_routes` (read) and `inbound_rejections` (insert)
  only, declared as `INBOUND_SCOPE_TABLES`; the structural test scans *both* `USING` and `WITH CHECK`
  expressions, because the rejection log's grant is an INSERT policy that a `USING`-only scan (like the
  existing platform/dispatch ones) would never see.
- **Routes are released by trigger on every move to `disconnected`.** So offboarding, a manual disconnect, and a
  raw `UPDATE` all make the former number unattributable without remembering to (AC13). `reconnecting` and
  `error` keep the route, so messages sent during recovery are still retained. `assignPhoneNumber` works only
  while `connecting`; the P2 connection flow is its intended caller.
- **Acknowledgement statuses.** **[DECISION]** 200 only after commit. Unauthentic → 401 (+ record). Authentic but
  unusable (malformed, unattributable) → 200 (+ record), because a non-200 makes Meta retry for days with no
  chance of a different outcome. Database failure → 503 so Meta redelivers; batches that did commit are then
  suppressed as duplicates.
- **Signature over the raw bytes.** `readBody` returns the untouched buffer; verifying a re-serialised parse
  would reject real notifications. A test asserts two byte-different encodings of the same JSON verify differently.
- **PostgreSQL `jsonb` refuses U+0000.** One NUL in an end-customer's text would fail the insert → 503 → Meta
  redelivers the same unstorable body forever. The parser strips NUL from text and captions.
- **Shared HTTP helpers moved to `@zeddev/http`** (`readBody`, `HttpError`, `SECURITY_HEADERS`), and `loadAll` to
  `@zeddev/config`, rather than copying them into the second service. `services/api` re-exports them unchanged.
- **The gateway migrates at startup too** (advisory-locked), so neither service needs the other up first.
- **Bash heredocs in the tool sometimes fail to parse** (`unexpected EOF while looking for matching '`) when a long
  script mixes backticks and apostrophes. Writing the script with the Write tool and running it with `node` is
  reliable; see `AGENTS.md`.

### Follow-ups the inbound gateway increment leaves open

- **Conversation worker:** delivered in §4s. Pull-based admission re-reads a customer's pending messages under
  the conversation lock rather than trusting job order across notifications; `maxInFlightPerTenant` is set by
  the worker; `unsupported` messages go to fallback with the new cause `not_understood`; idempotency comes from
  `inbound_dispositions` (append-only per inbound message) and `conversation_turn_outcomes`' primary key (one
  answer per turn, structurally).
- **Outbound delivery receipts** (`statuses`) are acknowledged and ignored until the outbound path exists.
- **Media ids expire.** The worker must fetch image/voice media promptly and store it in object storage; the
  gateway stores only the upstream id.
- **Rejection flood:** every unauthentic POST writes one `inbound_rejections` row. Bounded by
  `GATEWAY_MAX_BODY_BYTES` and a cheap HMAC, but a sustained flood grows the table; consider aggregating per
  minute and reason, or a per-source limiter, if it is ever observed. The table also needs a retention sweep
  (scheduler).
- **Meta account-level events** (`account_update`, number quality, revoked permission) arrive on the same webhook
  and are ignored today; they are the natural signal for driving `reconnecting`/`error` transitions.
- **Public exposure:** Meta calls public HTTPS only. `compose.yaml` publishes the gateway on loopback
  (`GATEWAY_PUBLISHED_*`); the proxy or tunnel in front is deployment plumbing still to document per tier.
- The `whatsapp_number_routes` unique key reveals across tenants that a number is already routed
  (`whatsapp.number.in_use`). Accepted: Meta itself refuses one number to two apps' tenants.
- Not yet verified against real Meta traffic; the envelope shape is from Meta's documentation. Run one live
  delivery through a tunnel before go-live, as §4p recommends for the AI adapters.

---

## 4s. Findings from the conversation worker increment

- **Admission is pull-based, not push-based.** Any job for an end-customer admits *all* of that customer's
  undecided messages, oldest arrival first, under the conversation row lock. That makes a re-run of the same
  job idempotent for free and closes the §4r follow-up about ordering pending messages across notifications:
  there is no job-order assumption left to violate.
- **The aggregation window is judged by each message's stored `received_at` (gateway time), never by when the
  worker happens to reach it** — a lagging worker groups a burst exactly like an idle one would have. A message
  joins the open turn iff it arrived at or before that turn's `closes_at`, where `closes_at` = min(latest
  arrival + window, first arrival + max turn duration). Whether a turn is *due* to close is judged separately,
  by the worker's injected `Clock`, so clock skew between the worker host and the database shifts *when* a turn
  closes but never *what it contains*.
- **Turn jobs deliberately carry no partition key.** Inbound message jobs are partitioned per end-customer; a
  delayed turn job sitting at the head of that same partition would block the very messages it is waiting to
  aggregate. Ordering between an inbound job and its turn job is the conversation lock's job, not the queue's.
- **A turn job that runs early because its window was extended reschedules itself at the new `closes_at`**
  (the dedupe key includes the deadline), so extending a turn schedules nothing new — it just moves the one job
  that already exists.
- **Turns of one conversation are answered strictly in order.** A closed turn whose predecessor is unanswered
  returns `behind` rather than being answered out of turn; recording an answer schedules the next closed turn
  in the same transaction. Risk: if a turn's job is dead-lettered, every later turn of that conversation stays
  `behind` forever — see the follow-up below.
- **The model is called between two short transactions, never inside one.** `recordTurnOutcome` re-checks under
  the lock: if the bot was switched off or the conversation was paused while the model was thinking, the
  outcome is `withheld` and nothing is sent. Fallback text is resolved inside the recording transaction (the
  literal client-authored text, per the §3 fallback-tone resolution). A `handoff` outcome pauses the
  conversation and writes a `paused` event in the same transaction.
- **Messages held while the bot is off or the conversation is paused are never answered retroactively** and are
  excluded from the model's context entirely. After a resume, only new messages are answered.
- **[DECISION]** Conversation memory is a fixed cap — `CONVERSATION_LIMITS.contextTurns` = 20 turns (the
  customer's messages in sent order plus the bot's reply/fallback text) — because the reset policy that would
  normally bound history is blocked on §4. Until that policy exists, a conversation never resets, so
  `conversationStart` (the disclosure-opening flag) is true only until the bot has first spoken in that
  conversation.
- **Image/voice/unsupported messages become bracketed notes in the model's context** (e.g. "[The customer sent
  a photo, which could not be viewed.]"). An image caption counts as understood text on its own. A turn in
  which nothing was understood skips the model entirely and goes straight to fallback — `out_of_scope` if every
  message in the turn was an unsupported type, `low_confidence` otherwise — via a new fallback cause,
  `not_understood`, added to `FALLBACK_CAUSES` in `@zeddev/bot`.
- **[DECISION]** Defaults: `WORKER_AGGREGATION_WINDOW` = 5 s, `WORKER_MAX_TURN_DURATION` = 30 s, per the burst
  spec's v1 platform-wide assumption. Startup refuses a configured max shorter than the window.
  `WORKER_CONCURRENCY` defaults to 4, `WORKER_MAX_IN_FLIGHT_PER_TENANT` to 2 (resolving that part of the §4d
  follow-up), `WORKER_VISIBILITY_TIMEOUT` to 60 s, `WORKER_SHUTDOWN_GRACE` to 30 s.
- **Queue fix in `@zeddev/queue`:** `waitForWork` in both `PostgresQueue` and `InMemoryQueue` now caps its sleep
  at the next *delayed* ready job's due time (a query under the dispatch scope, once per wait, excluding jobs
  already due to avoid a spin). Before this fix, delayed jobs — including every retry backoff — were only
  reached at the consumer's idle timeout (30 s). A new conformance test ("a waiting consumer wakes when a
  delayed job comes due") holds both adapters to it and was confirmed to fail without the fix.

### Follow-ups the conversation worker increment leaves open

- The outbound sender still has to drain the pending outbox: extend the `delivery_state` CHECK on
  `conversation_turn_outcomes` in a new migration for its state machine, and the 24-hour customer-service-window
  decision (§4) still blocks what to do with an outcome that falls outside it.
- A dead-lettered turn job leaves every later turn of that conversation `behind` forever — needs either a
  stale-turn rule or an operator replay path.
- Handoff client notification (blocked on channel decision, §4) and a system-side resumption condition are not built.
- The memory reset policy must bound context by something other than a fixed count and define
  `conversationStart` properly — blocked on the same §4 default-inactivity-window decision.
- Worker/database clock skew shifts *when* a turn closes, as noted above — acceptable because it never changes
  *what* the turn contains.
- Typing indicator / read receipt behaviour is not implemented — the spec leaves it an open question.
- `purgeSucceeded` (§4d) is still not called by anything, and every turn now adds at least one more job row to
  what accumulates. **Closed by §4x.**
- No live test against a real model yet for this path; §4p's recommended smoke test also covers the worker.

---

## 4t. Findings from the WhatsApp connection flow increment

- **Connection is earned by a round trip, not by a form submission.** `whatsapp-number-connection.md`'s
  strongest sentence is that submitted credentials must never produce "connected", so the flow is four steps
  (`CONNECTION_STEPS` in `src/lib/whatsapp/onboarding.ts`): *authorize* the platform's Meta app on the
  client's WhatsApp Business Account, *submit* the phone number id / business account id / access token,
  *send* a one-time code from the number to a recipient the client nominates, and *reply* with that code from
  the recipient's phone. Only the inbound reply moves the state to `connected`. The state machine backs this
  structurally: `CONNECTION_TRANSITIONS` has no edge into `connected` except from `connecting`, so there is no
  code path — not even a buggy one — that can promote a submission.
- **The receive leg is proven by the gateway, which is the only component that can prove it.** The client's
  reply arrives as an ordinary Meta webhook notification, so `consumeVerificationReply` runs in
  `services/whatsapp-gateway` *before* the message is stored. A matching code is consumed and the message is
  never written to `inbound_messages` — the code reply is not a conversation, and the worker must never answer
  it. A non-matching message that merely contains digits falls through to the ordinary path untouched.
- **One pending attempt per tenant, enforced by a partial unique index.** `whatsapp_connection_verifications`
  has `UNIQUE (tenant_id) WHERE outcome = 'pending'`, which is what stops a stale code from staying valid
  beside a newer one. Codes are stored only as a SHA-256 digest and compared in constant time; expiry is lazy
  (`expireStaleVerification`, called on read) rather than scheduled, because a background sweeper for a
  15-minute TTL is an always-on cost `cost-efficient-operation.md` does not want.
- **Replacement goes through `disconnected` on purpose.** `submitCredentials(..., { replace: true })`
  transitions the connection to `disconnected` — which fires the trigger that releases the old number's route —
  and only then to `connecting` with the new number assigned. Adding a `connected → connecting` edge would have
  been shorter and would have opened exactly the dual-active window the spec forbids. Without `replace`, a
  second submission on a tenant that already holds a number is a `ConflictError` (409).
- **[DECISION] Meta's Cloud API is a port with a wire-level stub, not a real upstream.** `@zeddev/storage` and
  `@zeddev/mail` test against real servers because MinIO and Mailpit are free, local, and can be asked for any
  answer. Meta is none of those: it needs a real business, a real number, and real money, and it cannot be told
  to revoke a token or withdraw a business verification on demand — which is precisely what the acceptance
  criteria are about. So `cloud.ts` is the port, `graph.ts` is the Graph adapter, `memory.ts` is the fake, and
  `stubs.ts` is a local HTTP server that *decodes* Meta's documented wire shapes back into the port's
  vocabulary before answering from the same scripted backend the fake uses. `runWhatsAppCloudConformance` then
  holds fake and adapter to identical answers, so an assertion about "what the number was asked to send" is an
  assertion about what went over the socket.
- **Business verification is a first-class condition, checked before the send.** `businessVerificationBlocked`
  reads Meta's `verification_status` / `account_review_status`; `CLOUD_ERROR_CODES` maps 131031 and 131042 to
  the same `business_verification_required` reason the state machine already carried. A business Meta has not
  verified is refused with its own reason and description rather than a generic failure, and without burning a
  send attempt. `unknown` is deliberately not treated as blocked — Meta telling us nothing is not Meta telling
  us no.
- **The model call's shape, applied to the network.** `POST /v1/whatsapp/connection/verification` is three
  phases: a short transaction that opens the attempt and unseals the credential, the Meta round trip outside
  any transaction, then a second short transaction recording the outcome. The attempt row is written *before*
  the send, so a send that succeeds and then crashes leaves a recoverable record rather than an invisible one.
  This is the same rule the conversation worker follows for the model: never hold a database connection across
  a network call to a third party.
- **`@zeddev/vault` is new, and it is where tenant secrets stop being cryptography and become policy.**
  `@zeddev/secrets` had the AES-256-GCM sealer already; what did not exist was a single place that decides
  where a sealed value lives, who may read it, and what is written to the audit trail when anyone touches it.
  `tenant_secrets` is now reachable through `@zeddev/vault` and nowhere else, every operation records a
  `secret_access_records` row naming the principal and the secret class but never a value, and every entry
  point refuses an unbound connection with a `DefectError` rather than silently matching zero rows.
- **[DECISION] Sealing keys are a configured list, not one key.** `VAULT_SEALING_KEYS` carries
  `<keyId>:<base64 32-byte key>` entries and `VAULT_ACTIVE_SEALING_KEY` names which one seals; a value sealed
  under a retired id keeps unsealing for as long as that id is still listed. That is what makes rotation
  (`credential-and-secret-handling.md` AC8, AC9) a configuration change rather than a flag day, and
  `secretsAwaitingReseal` / `resealTenantSecrets` move stragglers to the active key in place. A managed cloud
  KMS would satisfy AC4 too, but it exists on only one of the three tiers `environment-portability.md` names.
- **[DECISION] `WHATSAPP_API_BASE_URL` is required, not defaulted.** For the reason `AI_BASE_URL` is: a
  vendor URL embedded in source pins the deployment to one upstream *and one API version*, so a version bump
  would stop being a configuration change. `WHATSAPP_APP_ID` joins it because connecting a number subscribes
  the client's WhatsApp Business Account to this app by id, and the flow verifies that subscription.
- **Known cost of "one key, one definition":** `services/whatsapp-gateway` loads the whole
  `WHATSAPP_CONFIG_SCHEMA` for the app secret and verify token, so it now also requires `WHATSAPP_APP_ID` and
  `WHATSAPP_API_BASE_URL` at startup despite never calling the Cloud API itself. Splitting the schema to avoid
  this would create two places a WhatsApp key can be defined, which is the worse trade.
- **Traceability fix made in passing:** three `specTest` criteria in `onboarding.test.ts` were labelled `AC4`,
  `AC12`, and `AC13` against behavioural-requirement numbers rather than the spec's acceptance-criteria
  numbers — and one of them collided with the real `AC12` under a different meaning. They now quote the
  requirement they cover instead, which is the existing convention for a test that traces to a requirement
  with no matching `- Given` bullet.

### Follow-ups the connection flow increment leaves open

- **Automatic reconnection is still not driven by anything.** `reconnecting` is reachable and legal, and the
  Cloud port now classifies failures into recoverable and terminal (`CLOUD_RECOVERABLE_REASONS`), but no
  component yet observes a live failure and moves the state. This belongs to the outbound sender, which is the
  first component that will call Meta on a schedule: a send failing for a recoverable reason should move
  `connected → reconnecting` and a later success should move it back, with a bounded attempt policy (still
  undecided — see §4) before it falls to `error`. **Closed by §4x.**
- **Sealed values are not bound to their row.** `SecretSealer` uses AES-256-GCM with no additional
  authenticated data, so a ciphertext lifted from one `tenant_secrets` row and written into another tenant's
  row would unseal cleanly. Row-level security already prevents that write, so this is defence in depth rather
  than a live hole, but binding the seal to `(tenant_id, secret_class)` as AAD would make
  `credential-and-secret-handling.md` AC7 a cryptographic guarantee instead of only a policy one. Worth doing
  before there is any sealed data to migrate.
- **Offboarding still owes `whatsapp-number-connection.md` AC11** (offboarding transitions the connection to
  `disconnected`). `disconnectNumber` is the function it should call; nothing calls it from that direction yet.
- **The access token is never re-validated after connection.** A token revoked at Meta is only discovered on
  the next send. That is acceptable while the outbound sender is the only caller, but the operator health
  surface (P3) will want a cheaper signal than "a customer's reply failed".
- **No live test against real Meta.** The stub decodes Meta's documented shapes, but the first real number will
  still be the first real proof. This is the §5 "Meta onboarding is the critical path" risk, and it is now the
  only part of the flow that has not been exercised end to end.

---

## 4u. Findings from the outbound sender increment

- **The hard requirement is not "retry", it is "retry without duplicating".**
  `message-delivery-reliability.md` AC7 asks for both in one sentence, and the Cloud API offers no
  idempotency key and no way to ask after the fact whether a message was accepted. The two are therefore
  not jointly achievable by retrying harder; they are achieved by knowing which failures left nothing
  behind. `cloudFailureDeterminacy(error)` is that knowledge: `none` when Meta answered (so the send
  provably did not happen and repeating it is safe), `unknown` for everything else.
- **[DECISION] Determinacy defaults to `unknown`, and `none` is claimed only on evidence.** `fetch`
  reports "I could not complete this" for both "nothing was sent" and "something was sent and the answer
  was lost", and its error shape does not separate them. The Graph adapter walks the cause chain for a
  code that cannot occur after the request was written — `ENOTFOUND`, `ECONNREFUSED`, a TLS rejection —
  and claims `none` only then. Guessing the other way is precisely how an end customer gets the same
  reply twice.
- **The outbox's `sending` state is what makes a crash recoverable.** The row moves to `sending` in its
  own committed transaction *before* the call, so an attempt that finds it already there knows a previous
  attempt reached Meta and never came back to say what happened. It records `failed` / `indeterminate`
  rather than sending again. A lost reply is recorded and visible — AC8 explicitly provides for that — and
  a duplicate reply is neither.
- **Both fakes learned to lose an answer.** `ScriptedCloudBackend.loseNext(operation)` performs the work
  and *then* destroys the answer: the in-memory adapter raises the same unreachable error the real one
  does, and the HTTP stub destroys the socket with nothing written on it. Two new conformance assertions
  hold the fake and the Graph adapter to the same verdict, which is what stops "we never duplicate" from
  being a property of the fake alone.
- **[DECISION] A reply outside the 24-hour customer service window is recorded `expired` and not sent.**
  AC10 requires detection, no silent failure, and a record; it does not say what to send instead. The
  alternative — an approved template — costs money per send and is still an open §4 decision, so the
  conservative half is implemented and the other half stays a configuration change rather than a rewrite.
  The window is measured from the end customer's own `sent_at`, not from when the platform stored the
  message, so a delay in the pipeline cannot make the window look wider than Meta will treat it as.
- **Automatic reconnection now has something driving it**, which closes the §4t follow-up. A send failing
  for a recoverable reason (`transient`, `rate_limited`) moves `connected → reconnecting`; a terminal Meta
  reason moves the connection to `error` carrying that reason (AC9); and a send that succeeds while
  `reconnecting` moves it back to `connected` — the only evidence of recovery the platform gets.
  Transitions are checked for legality rather than caught, because a send failing while the client happens
  to be disconnecting is an ordinary race, not a conflict anyone needs told about.
- **[DECISION] Delivery runs in the conversation worker, not the gateway**, revising the §1 component map.
  Two reasons: the outbox is `@zeddev/conversation`'s own table, and the gateway's one hard requirement is
  to acknowledge a webhook fast — a poor thing to ask of a process that also holds retrying, rate-limited
  sends. The queue's per-tenant fairness and its in-flight cap are what keep turn work and send work from
  starving each other in one process. Revisit if send volume and AI latency start competing for the same
  slots: the fix is a second queue and a second consumer, not a different table.
- **[DECISION] Five attempts, with the queue's own backoff between them, and no configuration key.** The
  handler records the row's terminal state itself and returns normally on the last attempt rather than
  letting the job dead-letter, because AC8 asks for the failure to be recorded *against the tenant* — the
  outbox row is where a per-tenant failed-delivery metric will read it, not the dead-letter table.
- **Credentials are loaded before the row is claimed, not after.** A tenant that disconnected between
  deciding an answer and sending it settles as `failed` / `not_connected` instead of rolling the whole
  attempt back and reaching the same answer on every retry. `connected` being the only state messages may
  be exchanged in makes this a correct outcome rather than a workaround.
- **The turn tests now prove delivery, not just decision.** Every live tenant in
  `src/lib/conversation/turns.test.ts` is given a real sealed access token and a registered account, so the
  existing burst and fallback tests assert what the customer was *sent*, down to the unsealing. The two
  assertions that read `delivery_state = 'pending'` now read `'sent'`, which is the visible shape of this
  increment.

### Follow-ups the outbound sender increment leaves open

- **The 24-hour window policy is still half-decided** (§4). Today the reply is recorded `expired`; whether
  an approved template should be sent instead is a cost decision, and `expired` is the state a template
  path would branch from.
- **A reconnect is only attempted when there is something to send.** A tenant with no traffic sits in
  `reconnecting` until its next reply, and `whatsapp-number-connection.md` AC6 wants recovery attempts to
  be *exhausted* before `error`. That bound — a stalled-reconnect sweep with an attempt policy — belongs to
  `services/scheduler`, which does not exist yet; `recovery_exhausted` is the reason waiting for it. **Closed by §4x.**
- **`delivery_updated_at` and `delivery_attempts` are written but nothing reads them yet.** They exist for
  the per-tenant failed-delivery metric `operator-health-monitoring.md` requires (P3).
- **A send that succeeds and then fails to record leaves the row `sending`**, and the next attempt calls it
  indeterminate — the right conservative answer, but it loses Meta's message id for a message that did
  arrive. Nothing can recover that without a delivery-receipt webhook, which the spec explicitly does not
  let the requirements depend on.
- **Delivery receipts are not consumed.** Meta reports `sent`/`delivered`/`read` on the same webhook the
  gateway already receives; wiring them would turn `sent` from "Meta accepted it" into "it arrived", and is
  the cheapest available upgrade to the indeterminate case.

## 4v. Findings from the image and voice understanding increment

- **[DECISION] A photo becomes text once, by its own model call, instead of travelling with the reply request.** Sending the bytes with every reply fails three ways: later turns would need them again and Meta's reference does not last; `client-conversation-visibility.md` AC4/AC5 want the client to read what was understood, so the text has to exist anyway; and photos in up to twenty turns of context would not survive a free-tier quota. The price is one extra call per media message, once.
- **[DECISION] Bytes are never stored**, revising the §1 component map, which had placed fetched media in object storage. Every spec that looks at media afterwards needs the derived text only, and a customer's photos are the most sensitive and most expensive thing the platform could hold. They stay in the worker's memory for the length of one call. **Worth confirming with the operator:** it means a client's transcript can show what a photo contained but never the photo itself. Reversing this is additive (store on retrieval), but cannot recover photos already discarded.
- **Understanding runs when a turn is about to be answered, not when a message arrives.** A photo sent while the bot is off or the conversation is paused therefore spends no bandwidth and no quota. It sits between two runs of `prepareTurn`, outside any transaction, and the second run is what notices the bot was switched off during a slow download. Consequence: a held message is never understood, so the future transcript shows it as an unexamined photo or voice note.
- **Every path ends in a recorded row, because an unsettled message would leave its turn, and so every later turn of that conversation, unanswered forever** (the §4s dead-letter risk). The turn job therefore settles on its last retrieval attempt rather than raising.
- **[DECISION] Three attempts at retrieval (`MEDIA_LIMITS.retrievalAttempts`), through the queue's backoff.** Fewer than the sender's five, because a customer is waiting on an answer not yet decided and the cost of giving up is only the fallback. Only retryable failures use them: a reference Meta no longer holds is terminal and settles at once. A provider failure also settles at once, because the port has spent its own retries and `generateReply` treats a failed reply the same way. Each round tries every pending message before raising, and rows already written survive the retry, so a turn with three photos and one failed download does not pay for three descriptions twice.
- **A technical failure and an unintelligible message are different fallback triggers.** A failed download or provider call gets `ai_error`; a blurry photo, silence, an unsupported format, or a model without the capability gets `low_confidence`. A client may word those differently, and "our system is having trouble" is false of a blurry photo. A turn with a caption or other text still goes to the model, with a note saying the media could not be viewed.
- **The unreadable verdict is a sentinel the model is asked to write, read loosely** (`readImageUnderstanding`), because a model asked for one word still writes "UNREADABLE." or bold. Only the whole answer counts: a description mentioning the word is still a description.
- **Transcripts are cleaned before storage, because the reply is written by a model shown them** (`cleanTranscript`). Square brackets and angle tags go whatever they hold; parentheses only around a known non-speech word; a time of day stays and only a bracketed time or a subtitle range is a timestamp. A transcript with no letter or digit left is no speech, which catches `[BLANK_AUDIO]`.
- **The media location from Meta is data, and the token goes where it points.** The adapter refuses a location with a different scheme from the configured root, so a token never travels in the clear; the host cannot be pinned without embedding Meta's hostnames. The location is a signed link and appears in no error. `phone_number_id` on the lookup makes Meta check the media was sent to this number, not merely that this token can see it.
- **`file_size` and `content-length` are claims, so the bound is enforced by counting what arrives.** A declared size past the limit stops before the download; a body no header admitted to is abandoned at the limit. A 200 carrying HTML or JSON is refused as a transient failure, because handed on it would come back as a confident description of an error page.
- **Tests were checked for teeth by mutation.** Twelve behaviours were broken one at a time (the last attempt raising, the second `prepareTurn`, the location check, the byte bound, transcript cleaning, and others) and each was caught.

### Follow-ups the media understanding increment leaves open

- **Neither path has run against a live model or against Meta.** The image prompt's quality, the sentinel's reliability, and whether Meta's download needs anything beyond the bearer token are all unverified. The §4p smoke test should cover a real photo and a real voice note before launch.
- **The largest audio WhatsApp allows may exceed the port's limit.** `MAX_REQUEST_MEDIA_BYTES` is 15 MiB and the Cloud API's documented audio limit is 16 MB, about 15.26 MiB, so a note in that small gap gets the fallback, as `too_large`. Opus at voice bitrates reaches that only after over an hour. `voice-message-understanding.md` AC7 allows fallback only if content cannot be understood, so strictly this is a known gap, accepted because the limit exists to stay under the provider's inline request limit.
- **A long voice note may outlast `AI_REQUEST_TIMEOUT`.** It then settles as `provider_failed` and gets the fallback. No live timing exists yet to size it against.
- **Long transcripts are cut at 20,000 code points** (`MEDIA_LIMITS.understandingMaxLength`, roughly twenty minutes of speech), marked with ` […]`, because the text is shown to the model in up to twenty later turns. The tail of a longer note is lost.
- **No language hint is sent, and the description language is a guess.** Both wait on language configuration (§4). The image prompt uses the caption's language or the photo's, else English, and a client reads this text in the future transcript.
- **The number of media calls in a turn is unbounded**, one per message, in sequence. The spec requires all images be considered, so there is no cap, but a large album costs its size in free-tier quota. Metrics (P3) should make this visible; `input_tokens` and `output_tokens` on `inbound_media_understandings` exist for that and nothing reads them yet.
- **A sealer failure while loading credentials still raises and can dead-letter the turn**, leaving the conversation `behind` as in §4s. That is an operator misconfiguration affecting everything else too, so it was left as is.
- **`readMediaUnderstandings` is still only called by tests.** The transcript reads understandings in its own timeline query (§4w), so this function is a test helper in practice.

---

## 4w. Findings from the client conversation visibility increment

- **A conversation exists once a message does.** Both reads start from `inbound_messages`, not `conversations`, because that row is created when the worker first looks at a customer. Starting there would hide a customer who just wrote until a job had run, and for as long as the worker was down, which is when a client most wants to look.
- **[DECISION] The transcript is ordered by one key: send time for a customer's message, decision time for the bot's, but never earlier than the latest message of the turn it answers, with the customer first on a tie.** The two clocks are different (Meta's, truncated to the second, and the database's), and a reply shown above its question is simply wrong. A reply is deliberately not placed directly under its own turn: a message written while the model was thinking really did come first. The position does not depend on delivery, so a reply does not move down the page when it is finally sent.
- **Known imprecision: within the second a reply was decided, a customer's message sorts above it even if it was sent just after,** because Meta's timestamp has one-second resolution. Harmless, and there is no signal left to do better with.
- **[DECISION] An undelivered answer is shown, with its delivery state.** Hiding it would make a failed send look like the bot never answered; showing it bare would tell the client a customer received something they did not. A client reading this has to act on `delivery.state`, so the future dashboard must not render every bot entry as delivered.
- **Cursors are compared as whole microseconds and built in SQL.** `decided_at` has microseconds and a JavaScript `Date` has milliseconds, so a cursor built from a `Date` sits before its own row and either repeats it or skips a neighbour. A mutation building the cursor from a `Date` is caught by the paging tests.
- **[DECISION] With no cursor, a transcript opens on its latest page, and `after` the last cursor returns only what is new.** Opening a long conversation wants where it has got to. An empty refresh keeps its place, which is what makes "new messages appear on next view" cheap to poll. `earlierCursor` is null at the start, and a forward walk ends on an empty page.
- **[DECISION] Both routes are POST with the customer in the body,** like resume, and not `GET ?customerId=`, because a phone number in a URL lands in every proxy's access log. The `Origin` check therefore applies to these reads too, which is harmless. The access record's resource is a fixed label, never the customer, because access records reach the operator; a test asserts the number stays out of the log and the record.
- **Another tenant's customer is a 404, identical to a number that never wrote.** It is not refused by a check: the read runs on a connection bound to the caller's tenant, and row-level security means the row is not there. A cursor is only a position, so one lifted from another tenant's page selects within the caller's own rows.
- **[DECISION] `pausedOnly` is added to the list though the spec does not ask for it,** because until `human-handoff.md` AC6's notification exists, this is the one way a client can find out a customer is waiting on them.
- **Meta's media reference is not exposed.** A stored message is described field by field rather than passing `content` through, so a storage detail cannot become part of the API by accident. A held photo reads as `not_examined`: nobody looked, per §4v, and the bytes were never kept.
- **`requireTenant` is now shared inside the package from `turns.ts`.** `delivery.ts` still has its own copy, and `@zeddev/bot` has a third with a different error code. Left alone as unrelated to this increment.
- **Tests were checked for teeth by mutation.** Seventeen behaviours were broken one at a time. The first run left one survivor: a key in milliseconds still sorted correctly because the fixture's microseconds matched insertion order. The fixture now disagrees with insertion order, and all are caught.

### Follow-ups the conversation visibility increment leaves open

- **The end-customer's WhatsApp display name is not captured.** The spec says "number or name if known", and the platform knows only the number: the gateway reads past `contacts[].profile.name`. Worth confirming with the operator whether a client wants it, since it is more personal data held, and adding it means a column and a gateway change. Messages already stored would have no name.
- **The list aggregates every message of the tenant on each read.** Fine at low volume and it keeps one source of truth, but it grows with a tenant's history rather than its customer count. If it becomes slow, the fix is a `last_activity_at` on `conversations` maintained under the existing lock, plus handling for a customer with no row yet. No measurement exists yet.
- **Search by part of a number is a sequential filter** over that same aggregate, for the same reason.
- **`conversation-memory.md` AC10 (pre-reset messages stay visible) has no test,** because the reset does not exist. It should hold by construction: the transcript does not read the context, and nothing a reset could do touches these tables.
- **`client-offboarding-and-data-retention.md` AC7 (reactivation restores history) needs offboarding** (P4). Nothing here is cached, so it should hold.
- **A list page can miss a conversation that becomes active while the client is paging,** because recency moves. Reopening the list shows it. The transcript has no such issue, because its order is fixed.

## 4x. Findings from the scheduler increment

- **[DECISION] Recovery is bounded by an attempt budget, not a time window.** The spec leaves the bound to implementation. A window keeps running while the platform itself is off, so a laptop asleep overnight would wake to every interrupted tenant in `error`, which is terminal until the client reconnects by hand. An attempt budget only spends what was actually tried. Defaults: 12 attempts, 1 minute doubling to a 30-minute cap, half of each wait randomised, which comes to roughly three hours. They lean generous because of what is on the far side: `error` switches the client's bot off.
- **An attempt is counted when it is settled, not when it is claimed, and only for a recoverable answer.** So a scheduler that dies mid-probe spends nothing, and neither does a defect on this platform: that says nothing about the client's link. This is the same reasoning `feedConnection` in `delivery.ts` gives. A failure Meta says retrying cannot fix (a revoked token, a blocked business) goes to `error` at once with Meta's reason, because AC9 and AC12 need the actual answer on the connection rather than `recovery_exhausted` hours later.
- **[DECISION] No leader election.** Claiming an attempt advances `recovery_next_at` under the row lock, so several scheduler instances can sweep at once and whichever commits first owns the attempt. `purgeSucceeded` is an idempotent delete. A leader would be one more thing that has to fail over (`component-independence.md`), so tasks are required to tolerate concurrency instead, and `schedule.ts` says so.
- **The count lives on the connection row, and a trigger resets it.** It has to survive a restart and be shared between instances. The reset is `BEFORE UPDATE` on any state change, so every way out of `reconnecting` is covered: a send succeeding, a client disconnecting, a probe settling. A NULL `recovery_next_at` means "due now", so entering the state needs nothing written, and no backfill was needed (row-level security would have made that a per-tenant `DO` block).
- **The cross-tenant read uses the existing platform scope, with no new scope or policy.** `listConnectionsDueForRecovery` returns tenant ids only, from the one table whose platform policy already permits reading connection health across tenants. Every write happens under that tenant's own binding.
- **`probeCloudLink` is now the single definition of a working link**, in `cloud.ts`: business not blocked, number reachable, subscription in place. It was inline in the API's `probeAndSend`, and recovery would otherwise have been a second copy that could drift. Subscribing is idempotent, which makes re-establishing a lapsed subscription the one repair available from this side.
- **A probe never sends a message.** There is nobody to send one to, and it would cost money. So a number that is only rate limited returns to `connected` while its sends are still throttled, and the next refused send moves it back. That is the right reading of the vocabulary, since a throughput limit is not a broken link and readiness holds through both states, but it means `connected` here proves less than it does after onboarding's round trip.
- **Testing the tests found one that proved nothing.** Four deliberate breaks were applied after everything passed. Removing the due-time check from the claim survived, because an instant fake probe let the first sweep settle before the others reached the row; the concurrency test now holds the probe open and also asserts on the claim directly. A payload-deletion assertion in the purge test was also removed: a job's payload is deleted when it succeeds, so it passed with or without the purge.

### Follow-ups the scheduler increment leaves open

- **A long outage on this platform's own side spends real allowance.** Connections already `reconnecting` when the platform's network fails count those failures as recoverable, and past about three hours they reach `error`. `error` has no automatic way back (`CONNECTION_TRANSITIONS` has no `error → connected` edge), so the client must reconnect by hand. Worth deciding whether an unreachable Meta (as opposed to Meta answering with a failure) should count at all, or whether `recovery_exhausted` should keep being probed.
- **A permanent local failure never ends.** A tenant whose token cannot be unsealed (for example, a retired sealing key) is logged as `whatsapp.recovery.defect` and stays `reconnecting`, retried every sweep, because it must not be blamed on the client. Only the stalled-reconnect alert in `operator-proactive-alerting.md` will surface it, and that is not built.
- **`Retry-After` is ignored by probes.** Meta's hint is available on the error but the wait comes from the backoff alone.
- **A late answer can land on a later stay in `reconnecting`.** Settling checks the state, not which stay the probe was claimed in. The window is one probe long and the effect is corrected by the next send or sweep, so no generation counter was added.
- **The scheduler polls.** One indexed query a minute, which `cost-efficient-operation.md`'s idle-cost goal tolerates less gladly than the queue's `LISTEN`. This is the always-on tension §3 already records.
- **Adding a queue means adding it to the purge task** in `src/services/scheduler/start.ts`, which names `INBOUND_QUEUE` only because that is the only queue.
- **Not exercised live.** Tests use the scripted Cloud API, and the image was verified by building it, by confirming it refuses to start without configuration, and by Compose parsing it. It has not run in a full Compose stack, and no probe has reached real Meta.

---

## 4y. Findings from the metrics and operator health increment

- **[DECISION] The operator's numbers come from a table that cannot hold text.** Every number is derived from rows that also carry content (`inbound_messages.content`, `conversation_turn_outcomes.message`), and row-level security cannot grant part of a row. So `tenant_metric_buckets` holds only ids, hours, and counts, and it is the one new table with a platform policy. A test asserts its column types, which makes "numbers, never content" a property of the schema instead of a promise about each query.
- **[DECISION] Counted by triggers, in the transaction that made the event true.** Application-level counting can be lost to a crash between the event and the count, or repeated by a retried job. An `AFTER INSERT` trigger also does not fire for a row `ON CONFLICT DO NOTHING` skipped, so a redelivered webhook counts once with no extra code.
- **[DECISION] The triggers are deferred to commit.** All of a tenant's work in an hour shares one row. Written mid-transaction, that row lock would be held across everything after it and taken before locks other transactions take in the opposite order (settling a delivery goes on to lock the connection). At commit it is always the last lock taken, which rules out a cycle. A test asserts the row is not written until commit.
- **Only the first settlement of a delivery counts.** `settleDelivery`'s updates are not guarded by the current state, so a worker that lost its lease can report after another finished. The trigger counts only a move out of `pending` or `sending`, so one message is never counted twice. The cost is that a delivery recorded `failed` and later reported `sent` stays counted as failed.
- **[DECISION] Ninety days of retention, as a constant.** The spec requires a defined window. The API that answers "is this retained?" and the scheduler that deletes have to agree, and two separately configured services could disagree, which would show exactly what AC8 forbids. A range that reaches past retention at all is unavailable as a whole, and its numbers are null rather than zero.
- **What the numbers mean.** A failed response is a fallback with trigger `ai_error`; an out-of-scope or low-confidence fallback is the bot working. A withheld turn is not an attempt. A reply that missed the 24-hour window is reported but left out of the error rate, because it means a reply was late and not that anything is failing. Response time runs from the turn's first message to the answer being sent, including the quiet period, because the customer waits through that too. The single `errorRate` is both kinds of failure over both chances to fail, so it stays within 0 and 1 even when one turn fails twice.
- **[DECISION] Hours are UTC, by the three-argument `date_trunc`.** The two-argument form follows the session's zone, which would put half-hour-offset zones on different hour boundaries from the reader's.
- **[DECISION] A dashboard stays current by polling `GET /v1/operator/connections`.** It reads the current state of every tenant, so there is no cursor to miss a transition that commits out of id order, and it costs one join. Server-sent events would need a held connection and `LISTEN` per API instance for a requirement the spec leaves without a latency bound. The metrics are a separate, heavier read, asked for when the operator changes what they are viewing.
- **The unusual-tenant thresholds are judgement calls** (`HEALTH_THRESHOLDS`): at least 10 attempts, an error rate of 20%, or at least 5% and double the tenant's previous seven days; an average response of 5 minutes, or double that same week. They have not been checked against real traffic. `assessHealth` is the function operator alerting should reuse.
- **Testing the tests.** Sixteen deliberate breaks were applied after everything passed. Fifteen were caught. The one survivor, letting more states through the delivery trigger's `WHEN`, is an equivalent mutant: the function ignores those states. The first round also showed that deferral had no test, which is why it now has one.

### Follow-ups the metrics increment leaves open

- **Counting starts at the migration.** There is no backfill, because no deployment has carried real traffic. A deployment with history would show zero for the time before it, inside the retention window, which AC8 would not accept.
- **An average only.** A rollup can add sums and counts but not percentiles, and the spec accepts "average/typical". A p95 would need a histogram per hour.
- **No paging on the all-tenant view.** The spec forbids omitting a tenant, and sorting is over derived values. The cost grows with tenants times hours in the window, so a 30-day view of many tenants deserves a look when there are many tenants.
- **Not counted:** media understanding failures on their own, AI token usage (still written and still unread), queue depth, and `inbound_rejections`.
- **Offboarding (P4) must decide what happens to these rows.** They are deleted with the tenant by cascade, but nothing yet applies the offboarding retention window to them.
- **Not exercised live.** The counters are proven against a real PostgreSQL and the worker's real pipeline with a scripted Cloud API. No screen shows them yet.

## 4z. Findings from the knowledge selection increment

- **Selecting can lose a fact, so it only happens when it has to.** **[DECISION]** Knowledge within `KNOWLEDGE_SELECTION.promptBudget` (12,000 characters, about 3,000 tokens) goes into the prompt whole. Only past that is it ranked. A tenant at the entry limits would otherwise send about 100,000 tokens with every customer message, and on a free tier that ends in rate limits and the `ai_error` fallback for every customer. The port had no size check to catch this.
- **Lexical ranking, not embeddings.** **[DECISION]** BM25 over character trigrams, computed in process, nothing stored. The AI port has no embedding capability, a provider swap would strand every stored vector, and a vector index is another always-on cost for at most 100 entries. Trigrams need no language list or stemmer, and they tolerate how customers type: `entregam` finds `Entregamos`, `garantai` finds `garantia`. Accents and case are folded first. Worst case (100 full-size entries) measured 60–90 ms, and only an over-budget tenant pays it.
- **Three rules exist because of how selection fails.** An entry is whole or absent, since cutting one can drop the "except Sundays" that makes the rest true. The budget is always spent, unmatched entries filling it oldest first, since a message matching nothing may still be about something the client phrased differently. And the prompt says when it holds a selection (`partial`), since otherwise a fact left out reads as a fact denied and the bot tells a customer the business lacks something it has; the instruction is to take the `low_confidence` fallback instead.
- **The query is the last four turns, each older one counting half.** "And on Saturdays?" names no topic. The bot's own turns count, because "yes please" answers what the bot offered. The platform's bracketed notes about photos and voice messages do not, or every entry mentioning a photo would rank up.
- **`generateReply` calls it**, so the preview and the live path cannot select differently (`behavior-rules-configuration.md` AC16, tested). `knowledgeDirectives` is still the only renderer of knowledge.
- **The rules are held by tests that fail when the rule is removed.** Each of ranking, accent folding, the turn window, excluding notes, skipping past an oversized entry, and the `partial` mark was removed in turn to confirm a test fails. Two tests written first turned out to pass with any ranking, because their budgets could never fit the deciding entry, and were corrected.

### Follow-ups the knowledge selection increment leaves open

- **Documents.** When upload lands, a document must reach `selectKnowledge` as chunks no longer than `KNOWLEDGE_LIMITS.entryMaxLength`, or the guarantee that the most relevant item fits the budget stops holding. `knowledgeDirectives` needs them too.
- **Not exercised against a live model.** Tests prove what the model is shown, through the real worker and PostgreSQL. Whether a real model obeys the partial-knowledge sentence, or avoids contradicting a fact (AC5, AC6), has not been checked.
- **The budget and ranking constants are judgement, not measurement.** There is no real tenant traffic yet to tune `promptBudget` or the turn weights against. How often a tenant is over budget is not logged.

---

## 4aa. Findings from the dashboard increment

- **[DECISION] The dashboard service forwards `/v1/` to the API rather than relying on a reverse proxy.** §1 requires one origin, and a laptop has no proxy to arrange it, so the service that owns the origin does, on every tier. It holds no data and stays up while the API is down, answering in the API's own error shape. It counts as a proxy: `API_TRUSTED_PROXY_HOPS` includes it, so `compose.yaml` defaults that to 1, and a VPS with TLS in front sets 2. `API_PUBLIC_BASE_URL` is now the address of `web`, and the API has no published port in Compose.
- **[DECISION] No build step for the browser either.** Browser modules are TypeScript in `ui/`, type-stripped once at startup by `node:module`'s `stripTypeScriptTypes`, the same transformation Node applies to the services, and held in a table so no part of a URL reaches the filesystem. The `--disable-warning=ExperimentalWarning` in the Dockerfile is because that function is still marked experimental in Node 24.
- **[DECISION] A screen never touches the DOM.** It is a closure with `load`, `view`, and handlers, so `contract.test.ts` drives every page against the real API with only `fetch`. `shell.ts` is the one browser-only file and is deliberately thin.
- **[DECISION] Markup is made only by the `html` tagged template, which escapes.** The transcript renders text written by anyone with a phone. The page CSP has no `'unsafe-inline'`, so inline styles and scripts are off the table as well. Confirmed in Chrome: a message carrying `<img onerror>` and `<script>` renders as text and runs nothing.
- **[DECISION] Which conversation or tenant is open is held in memory and never in the address,** because a customer's phone number must not reach a URL. The cost is that a refresh returns to the list.
- **[DECISION] The operator dashboard polls the cheap `GET /v1/operator/connections` and re-reads health only when a state changed.** Filtering and sorting stay on the server so "not connected" has one definition.
- **Adding `lib: dom` to the shared TypeScript project breaks server code.** DOM's `Headers`, `BodyInit`, and `ReadableStream` replace Node's and four unrelated files stopped compiling. `shell.ts` has its own project (`ui/tsconfig.json`), and `npm run typecheck` runs both.
- **A real browser found what `node:test` could not.** The form was disabled before its values were read, and a disabled button is not a submitter, so "Preview without saving" silently saved. Read a form's values before changing its controls.

### Follow-ups the dashboard increment leaves open

- `credential-and-secret-handling.md` AC6 says a client sees that a credential is configured "and when". The screen says "Configured", because `setup.number` carries no timestamp. It needs a `configuredAt` from `@zeddev/vault` metadata.
- Screens still to come with their blocked features: language setting, document upload, memory reset, offboarding.
- `API_PUBLIC_BASE_URL` with a path prefix is accepted by the API but does not work end to end: pages use absolute `/assets/` and `/v1/` paths, and the operator cookie is `Path=/v1/operator`.
- The browser walkthrough was a one-off script, not part of `npm test`. `shell.ts` therefore has no automated coverage; `contract.test.ts` stops at the screens.
- No password-strength hint beyond a sentence on signup: no route exposes the minimum length.

---

## 4ab. Findings from the AI provider verification increment

- **[DECISION] The candidate is a second configuration slot, `AI_CANDIDATE_*`, read only by the API.** `ai-provider-portability.md` AC4 asks that a new model be confirmed before it serves live conversations. A slot that only `services/api` loads means no setting can route a customer to the candidate: the conversation worker is built from `AI_*` alone, and a structural test (`verification.test.ts`) fails the build if any other service names `loadAiCandidateSettings`, `AI_CANDIDATE_CONFIG_SCHEMA`, or `candidateAi`. The alternative, a traffic-splitting "canary" in the worker, would have put real customers on an unverified model, which is what AC4 exists to prevent.
- **[DECISION] Promotion and revert are one move: exchange each `AI_*` value with its `AI_CANDIDATE_*` counterpart and restart the API and the worker.** After a promotion the previous provider sits in the candidate slot, still verifiable and one exchange from being restored (AC5). A promote button was not built: the selection is configuration (AC1), and the API cannot rewrite a deployment's environment on any of the three tiers. The operator screen says how instead.
- **The two slots share one validator, `settingsFrom` in `src/lib/ai/config.ts`.** A candidate held to looser rules could pass verification and then refuse to start once promoted. Each issue names the key in its own slot (`AI_CANDIDATE_CAPABILITIES`, not `AI_CAPABILITIES`). The candidate runs under the shared `AI_REQUEST_TIMEOUT` and `AI_MAX_ATTEMPTS`, so it is judged on the budget it would serve under. A candidate key set while `AI_CANDIDATE_PROVIDER=none` is refused, not ignored.
- **The suite (`verifyAiProvider`, `src/lib/conversation/verification.ts`) drives the live functions, never its own prompt.** A made-up bakery (`VERIFICATION_CONFIGURATION`) goes through `generateReply` for three text checks (`reply` quotes a fact it was given, `handoff` on a request for a person, `decline` on a topic a rule says to avoid) and through `understandMedia` for `vision` (a generated solid red PNG) and `audio` (a generated second of WAV silence). The text checks exist mainly because a model that ignores the tagged output protocol fails silently live, as a rise in `unusable_output` fallbacks and handoffs never taken.
- **Why made-up and not a tenant's configuration:** the operator has no access to any tenant's configuration (`tenant-data-isolation.md`), and a fixed business makes two providers verified weeks apart comparable.
- **What it cannot judge.** The platform holds no recording of speech, so `audio` proves only that the transcription model and its credential answer. The clip is WAV, not a WhatsApp voice note's Ogg Opus, because producing Opus would need an encoder; both are in the port's accepted set. Whether a reply *reads* well is left to the operator, which is why every check returns what came back.
- **A capability the active provider has and the candidate lacks is reported (`capabilityGaps`), and its check is skipped, not failed.** The spec makes such a gap the operator's decision to accept.
- **`MediaVerdict` gained an optional `cause`** (the `ai_generation` error behind `provider_failed`), so verification can show `ai.unauthorized` and not just "failed". It is never stored.
- **New operator action `platform.ai.verify`**, separate from `platform.health.read`, because each use spends AI quota that every tenant shares. It is the first operator action that is not a read; it still touches no tenant. The route shares the preview's `FixedWindowRateLimiter` under the key `platform:ai-verification`, which no tenant id can equal, so verification neither starves nor is starved by a tenant's previews.
- **Routes:** `GET /v1/operator/ai-provider` now also returns `candidate` (a descriptor or `null`). The new `POST /v1/operator/ai-provider/verify` takes `{ "target": "active" | "candidate" }` and returns 409 `ai.no_candidate` when the slot is empty. The operator dashboard has an "AI provider" card with both descriptors, verify buttons, and a results table.
- **Flake seen once, not caused by this change:** the first `npm run check` straight after `db:up` on a cold Docker Desktop cancelled 30 tests. Fixture setup hit a statement timeout (SQLSTATE 57014) under full parallel load. An immediate re-run passed all 1282 tests.

### Follow-ups the verification increment leaves open

- **Neither adapter has run the suite against a real upstream yet.** This is the natural form of the §4p smoke test: put the real Gemini key in the candidate slot and press "Verify the candidate".
- A verification result is not kept. An operator who wants a record before promoting has only the `access_records` row for `platform.ai.verify`, which says that a verification ran but not its outcome.
- The suite is English-only. Once language configuration lands (blocked on §4), a check in the configured language would be worth adding.

---

## 5. Principal risks

- **Meta onboarding is the critical path.** The WhatsApp Business Cloud API requires a Meta app, business
  verification, and a per-client authorization flow. It is the longest external lead time in the project
  and the one least under the operator's control. Start it before it is needed.
- **Isolation is easy to claim and hard to prove.** `tenant-data-isolation.md`'s guarantees are absolute
  and adversarially worded. Database-enforced policies plus explicit cross-tenant negative tests from the
  first migration onward are far cheaper than retrofitting them.
- **Provider portability decays without a second adapter.** One adapter will inevitably leak provider
  assumptions into the port. The second adapter is the test.
- **Content leakage into operator-visible surfaces** is a quiet failure mode: it will not break anything,
  it will simply violate the guarantee. Redaction at the logger boundary in P0 is the mitigation.
