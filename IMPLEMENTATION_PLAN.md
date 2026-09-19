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

**Every remaining P1 item is blocked on a §4 operator decision:** language configuration on the
supported-language list, document upload on accepted document formats and size limits, memory reset policy on
the default inactivity window. The next unblocked work is P2: the inbound webhook/dedup path (gateway service),
and prompt assembly (one function composing the `@zeddev/bot` directive renderers into `instructions` for
`@zeddev/ai`). Behaviour-rules AC16 (preview) is now unblocked too, since the AI port exists.

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
- **[DECISION] PostgreSQL as the single persistent store**, carrying relational data, the job queue, and
  vector embeddings for knowledge retrieval. Rationale: `cost-efficient-operation.md` forbids
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
- `object-storage` — uploaded knowledge documents and fetched WhatsApp media. S3-compatible port so a
  local container and a cloud bucket are the same adapter.
- `services/whatsapp-gateway` — inbound webhook verification, acknowledgement, deduplication, tenant
  attribution, enqueue; outbound send with retry; owns the connection state machine.
- `services/conversation-worker` — burst aggregation, memory assembly, prompt construction, AI calls,
  rule enforcement, handoff decisions, fallback execution.
- `services/api` — client and operator HTTP API: auth, configuration, transcripts, metrics.
- `services/scheduler` — timer-driven work: reconnection attempts, stalled-reconnect detection, alert
  evaluation and suppression, retention-window deletion, memory reset evaluation.
- `services/web` — client dashboard and operator dashboard.

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

> **P0 is complete.** Still-open follow-ups, carried forward rather than blocking anything: setting
> `maxInFlightPerTenant` and calling `purgeSucceeded` from the scheduler (queue, §4d), and calling
> `verifyAccess()` from any service that holds an object store (storage, §4e) — none does yet, which is
> also why object storage (MinIO) is not in `compose.yaml`: there is nothing in it to run against.

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
  (preview) is not implemented. See §4k.
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

- WhatsApp connection flow: guided self-service authorization, send/receive verification before marking
  connected, and rejection of a second concurrent number. `whatsapp-number-connection.md` is explicit that
  submitted credentials alone must never produce a "connected" state.
- **[DONE]** The state, its fixed vocabulary (connecting / connected / reconnecting / error /
  disconnected), the legal-transition table, timestamped transition history, and surfaced error reasons —
  including Meta-side business-verification failure as a distinct condition
  (`business_verification_required`) — in `@zeddev/whatsapp` plus migration `0006_whatsapp_connection`. What
  remains is *driving* it: the gateway observing Meta signals, bounded automatic reconnection in the
  scheduler (attempt policy undecided), and offboarding transitioning to `disconnected`.
- Number replacement as a distinct guided flow that structurally cannot produce a dual-active window.
- Inbound webhook endpoint: authenticity verification, prompt acknowledgement decoupled from processing,
  tenant attribution from the receiving number, and rejection-with-record for anything unattributable.
- **Inbound deduplication.** The highest-risk correctness requirement in the data plane: Meta redelivers,
  and a missed duplicate check means a double reply and a corrupted transcript.
- Per-end-customer ordering and durability of accepted-but-unprocessed messages across a worker restart.
- Burst aggregation into conversational turns, with the quiet-period window, the maximum turn extension,
  mixed-type combination, and exactly-one-reply-per-turn. Per `message-burst-aggregation.md`.
- **[DONE]** `src/lib/ai` provider port with declared capabilities (text generation, vision, audio transcription),
  a registry, and configuration-driven selection. Two adapters (Gemini, OpenAI-compatible), an in-memory fake,
  and a shared conformance suite. AC1, AC2, AC3, AC5, AC8 covered; AC4 (verification mode) is P4; AC6/AC7 are
  structural (no tenant on any port call, instructions sent unchanged) but have no dedicated test. See §4p.
- **[DECISION] Default provider: Google Gemini free tier**, because it covers text, vision, and audio in
  one free-tier provider, which keeps the v1 dependency count at one. A second adapter should be built
  early — the portability requirement in `ai-provider-portability.md` is unfalsifiable with only one
  adapter, so building the second is really a test of the first.
- Prompt assembly from tenant configuration: persona, tone, language, disclosure mode, behavior rules,
  retrieved knowledge, and conversation memory. This is the single point where most configuration specs
  become observable behavior, so it needs the densest test coverage.
- Conversation memory: per-end-customer-per-tenant context, unified across text/image/voice, inactivity
  and manual reset, and the guarantee that reset affects active context only and never the stored
  transcript.
- Knowledge retrieval grounding over configured freeform entries and ingested documents.
- Outbound send with transient retry and backoff, exactly-once delivery from the end-customer's
  perspective, terminal-failure recording feeding the operator metrics, and connection-state feedback when
  a send failure indicates the connection itself is broken.
- 24-hour customer service window detection and handling — **blocked on a product decision**, see §4.
- Fallback execution across all three triggers, including the path where AI generation itself failed and
  the message must come from stored literal text rather than being generated.
- Image understanding, including captions, multiple images per turn, and text visible within images.
  Derived understanding must be **persisted**, not transient — `client-conversation-visibility.md`
  requires the client see what the bot understood from an image in the transcript.
- Voice note transcription, with transcription artifacts stripped from replies, and transcript persistence
  for the same reason.
- Human handoff: trigger detection, per-conversation pause, client notification with identifying context,
  continued receipt and retention of messages while paused, client-initiated resume, and a system-side
  resumption condition.

### P3 — Visibility

- Metrics collection: per-tenant message volume, error rate, response time, and failed deliveries, at a
  granularity that supports the selectable time windows the operator dashboard needs.
- Client conversation visibility: conversation list, full chronological transcript with attribution,
  representations of image and voice content, search/filter by end-customer identity and recency, and
  handoff status with trigger reason.
- Operator health dashboard: consolidated all-tenant view, per-tenant detail with transition history,
  last-known-good timestamps, error reasons, sorting and filtering by state and metric, historical
  metrics within a retention window with explicit unavailability beyond it, and state updates propagating
  without manual refresh.
- Operator proactive alerting: error-state and stalled-reconnect and error-spike triggers, per-tenant
  independence, suppression windows with escalation bypass, resolution notifications, delivery retry, and
  a queryable notification history including delivery outcomes.

### P4 — Lifecycle and portability proof

- Offboarding: immediate stop of auto-responses, WhatsApp revocation, entry into the retention window,
  reactivation during the window, automatic deletion at window end, and on-demand permanent deletion with
  explicit irreversibility confirmation. Deletion must reach secrets and any backup or archived copy.
- AI provider verification mode — exercising a candidate provider before it serves live traffic — and
  revert to the prior provider. Required by `ai-provider-portability.md` and easy to skip until it is
  needed urgently, which is the wrong time to build it.
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
  AC3, AC5, AC8; `voice-message-understanding.md` gained its first two at the port layer.)

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
  redelivery interval.
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

- `services/web` must implement `/verify-email` and `/reset-password` pages that read the token from the
  URL fragment and POST it to the API as JSON. Until that exists, the links `services/api` mails land on
  nothing.
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
- The persona screen in `services/web` does not exist. `GET /v1/bot/persona` already returns the options
  and limits the form needs, so the form has no reason to hard-code them.

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
  an attempt/time policy, which `whatsapp-number-connection.md` leaves to implementation.
- The P2 reply path must call `mayAutoRespond` in its sending transaction; its tests should assert that.
- Concurrent *first* transitions for a tenant with no `whatsapp_connections` row can race on the INSERT and
  one fails with a unique violation; harmless at the volume a single client's connect flow produces, but the
  gateway should retry it.
- Readiness currently requires only persona and a connection, as the spec assumes. If business knowledge or
  behavior rules ever gate readiness, that is a new clause in `app.bot_readiness_unmet`, a new trigger, and
  a new entry in `READINESS_CONDITIONS` (a test asserts the TS list equals the SQL function's output).
- The web screens for status/toggle/connection do not exist (`services/web`).

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

- AC16 (preview against a sample message) is not implemented — it needs the AI port. When built, the
  preview must go through the *same* prompt-assembly path as a live reply, not a separate one, or the
  preview can pass while the live path disagrees.
- P2's reply output protocol must define the `"handoff"`/`"fallback"` action names `behaviorDirectives` emits
  and resolve a `handoff` action against `human-handoff.md`'s enabled/disabled state at reply time.
- AC2–AC8 need output-level tests once P2's reply path exists; today's tests only prove the instruction layer
  is correct.
- The web screen for rules does not exist (`services/web`).
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
- Handoff precedence (AC6/AC7) is resolved at reply time against human-handoff configuration, which does
  not exist yet.
- A behaviour rule with action `fallback` needs a trigger mapping — recommend `out_of_scope` — decided as
  part of P2's reply output protocol (see §4k's open `"handoff"`/`"fallback"` action-name question).
- Confidence detection and scope detection are both upstream of this increment and remain undefined.
- `PLATFORM_DEFAULT_FALLBACK_MESSAGES` is English-only; when language configuration lands, defaults become
  per-language, since `language-configuration.md` requires fallback text in the configured language.
- The spec's own new open question: whether the fallback screen should show the client's active behaviour
  rules and persona, to help the client author compliant text.
- The web screen for fallback configuration does not exist (`services/web`).

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
- The web screen for disclosure does not exist (`services/web`).

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
- P2's reply output protocol must carry the condition name the directives ask for (`[human_request]`,
  `[complaint]`, `[out_of_scope]`, `[custom]` + text) and map it to a `HandoffSignal`.
- The system-side resumption condition (AC10) is undefined; the spec leaves it to a later phase.
- The spec's "unless the client's trigger configuration explicitly says otherwise" (cross-conversation scope)
  is not offered; handoff state is per conversation only.
- The notification channel is still a §4 decision.
- The web screen for handoff does not exist (`services/web`).

---

## 4o. Findings from the business knowledge (freeform entries) increment

- **An entry is one block of text and nothing else.** **[DECISION]** No title, category, or tags: AC2 requires
  "without any required structure", and an optional title would become a field the screen nags for. An edit
  replaces the text in place and keeps the id and list position (`position` identity column, same reason as
  §4k: two entries created in one transaction share `now()`).
- **Limits: 4000 characters per entry, 100 entries per tenant.** **[DECISION]** The spec assumes no limit and
  leaves any to implementation. Until retrieval exists, the reply path renders every entry into every prompt,
  so the cap bounds prompt cost on a free-tier provider; bulk knowledge belongs in documents. The per-entry
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
- Retrieval: if the reply path ever selects a subset of entries instead of all of them, it must pass the subset
  through `knowledgeDirectives`, not render entries itself.
- AC5–AC8 need output-level tests once P2's reply path and AI port exist.
- The web screen for knowledge does not exist (`services/web`).

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

- **No service loads `AI_*` yet.** The keys are in `docs/configuration.md` but not in `compose.yaml`; they
  belong to the conversation worker, and to `services/api` once preview (behaviour-rules AC16) is built.
- AC8 needs an operator-visible surface (e.g. `GET /v1/operator/ai-provider` returning `descriptor`) once a
  service holds the provider.
- AC4 verification mode and a candidate-provider configuration: P4.
- AC7: an output-level check that no provider identity reaches an end-customer needs the reply path.

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
