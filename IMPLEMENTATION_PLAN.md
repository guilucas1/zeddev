# Implementation Plan

**Status as of 2026-08-25:** P0 foundation mostly landed. `src/` now contains eight dependency-free
workspace packages (`@zeddev/errors`, `@zeddev/time`, `@zeddev/secrets`, `@zeddev/logging`,
`@zeddev/config`, `@zeddev/testing`, `@zeddev/db`, `@zeddev/schema`) and 143 passing tests, of which
37 run against a real PostgreSQL. Persistence, migrations, and database-enforced tenant isolation are
in place and proven by cross-tenant negative tests. The remaining P0 items are `queue`, `storage`, and
container definitions.

Run `npm run db:up` then `npm run check` before assuming any of the above still holds. `npm run check`
now *refuses* to pass without a database, because the database-backed suites are where every tenant
isolation guarantee is verified and a green run without them proves considerably less than it looks.

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
  free-tier hosts; and the operator's existing tooling in this repo (`parse_stream.js`) is already Node.
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
- `src/lib/queue` — job enqueue/consume port over Postgres, with at-least-once delivery, backoff, and a
  dead-letter path.
- `src/lib/storage` — S3-compatible object storage port.
- **[DONE]** `src/lib/testing` — in-memory fakes for every port, plus a spec-traceability helper so each test can
  declare which spec file and acceptance criterion it covers.
- Container definitions: one Dockerfile per service, a Compose file for laptop and VPS, and a documented
  environment-variable reference. `environment-portability.md` requires the config input list be complete
  enough to explain every behavioral difference between tiers. The reference should be *generated* from
  the config schemas via `renderReference()` rather than written, so it cannot drift — that is the whole
  reason `@zeddev/config` has that function.
- **[DONE]** Baseline database schema and migrations for tenants, users, and the audit/event records that
  several specs require. Delivered as `@zeddev/schema`: `tenants`, `tenant_lifecycle_events`, `accounts`,
  `client_sessions`, `account_tokens`, `operators`, `operator_sessions`, `access_records`,
  `tenant_secrets`, `secret_access_records`.

> **P0 remaining scope.** `queue`, `storage`, and container definitions. The queue is unblocked now —
> it is built on `@zeddev/db`, and `LISTEN`/`NOTIFY` support is already in the client so a worker can
> wait for work rather than poll (idle cost near zero, per `cost-efficient-operation.md`). §4c records
> the fairness constraint the queue must satisfy, which is not obvious from the schema.

### P1 — Control plane (a client can sign up, configure, and reach "ready")

- Client signup: business name, email, credential strength enforcement, duplicate-email rejection, email
  verification, and **transactional tenant provisioning** — `client-signup-and-tenancy.md` requires that a
  provisioning failure never leave a usable account pointing at a partial tenant.
- Client authentication: login, session issuance with inactivity and absolute lifetimes, logout, password
  change, self-service reset with single-use expiring tokens, session invalidation on credential change,
  and failed-attempt lockout. Per `authentication-and-access.md`.
- Tenant binding derived from the authenticated identity and never accepted from caller input. This is the
  precondition the whole of `tenant-data-isolation.md` rests on.
- Operator authentication as a **separate identity space** from client authentication, with enforcement
  that no client credential can reach operator surfaces and no operator credential can act as a client.
- Persona and tone configuration: structured fields (bot name required, formality, style traits) plus
  optional freeform text, both applied together, with length limits and independent clearing of the
  freeform field. This is the only configuration gating readiness.
- Language configuration with a platform default, per `language-configuration.md`.
- Readiness evaluation and the client-controlled activation toggle, including re-evaluation when a
  condition is later lost, and the record of first-ready and every on/off transition. Per
  `bot-activation-control.md`.
- Business knowledge configuration: freeform entries plus document upload, with upload failures surfaced
  rather than silently dropped, and a combined listing view.
- Behavior rules configuration: individually addressable structured rules with enable/disable/edit/delete
  lifecycles, plus freeform instructions, both binding simultaneously.
- Fallback message configuration with per-trigger variants, a platform default, and preview.
- Bot disclosure setting.
- Human handoff enable/disable and trigger configuration.
- Conversation memory reset policy configuration (inactivity window plus manual reset).

### P2 — Data plane (the bot actually holds conversations)

- WhatsApp connection flow: guided self-service authorization, send/receive verification before marking
  connected, and rejection of a second concurrent number. `whatsapp-number-connection.md` is explicit that
  submitted credentials alone must never produce a "connected" state.
- Connection state machine over the fixed vocabulary (connecting / connected / reconnecting / error /
  disconnected) with timestamped transition history, surfaced error reasons, bounded automatic
  reconnection, and Meta-side business-verification failure as a distinct condition.
- Number replacement as a distinct guided flow that structurally cannot produce a dual-active window.
- Inbound webhook endpoint: authenticity verification, prompt acknowledgement decoupled from processing,
  tenant attribution from the receiving number, and rejection-with-record for anything unattributable.
- **Inbound deduplication.** The highest-risk correctness requirement in the data plane: Meta redelivers,
  and a missed duplicate check means a double reply and a corrupted transcript.
- Per-end-customer ordering and durability of accepted-but-unprocessed messages across a worker restart.
- Burst aggregation into conversational turns, with the quiet-period window, the maximum turn extension,
  mixed-type combination, and exactly-one-reply-per-turn. Per `message-burst-aggregation.md`.
- `src/lib/ai` provider port with declared capabilities (text generation, vision, audio transcription),
  a registry, and configuration-driven selection.
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
  spec-coverage` reports per-spec coverage. Current state: 12 of 27 specs have covering tests, 63
  spec-linked assertions; `tenant-data-isolation.md` is at 9 of 10 criteria and
  `credential-and-secret-handling.md` at 14 of 15. The 15 uncovered specs are all P1-P4 features not
  yet built.

---

## 3. Cross-spec conflicts found — these need resolution, not just implementation

- **Transient disconnect permanently pauses the bot.** `bot-activation-control.md` requires the bot be
  turned off when a readiness condition is lost, and that restoring the condition does *not* turn it back
  on — the client must act. `whatsapp-number-connection.md` introduces a `reconnecting` state for
  transient blips that recover automatically without client action. Read together, a momentary network
  interruption silently pauses a client's bot until they happen to notice and re-enable it.
  **Recommendation:** treat readiness as satisfied by `connected` *or* `reconnecting`, and only drop
  readiness on `error` or `disconnected`. Needs the operator's confirmation before building.
- **"New conversation" is undefined for disclosure.** `bot-disclosure-setting.md` requires a disclosure
  statement at the start of every new conversation and flags the session boundary as an open question.
  `conversation-memory.md` already defines exactly that boundary via its reset policy.
  **Recommendation:** define disclosure's "new conversation" as the memory-reset boundary, so there is one
  concept rather than two that can drift apart.
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
- **Fallback tone versus fallback availability.** `fallback-response-behavior.md` requires fallback
  messages reflect configured persona and tone, *and* requires they be sendable when AI generation has
  failed. Those are only compatible if the fallback text is stored as literal, client-authored text rather
  than generated at send time. Worth stating explicitly in implementation so nobody "improves" it into an
  AI-generated fallback.

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
  the system with visibility across every tenant. Blocks the P1 operator auth item if the answer is yes.
- Whether signup needs CAPTCHA or equivalent anti-abuse. `client-signup-and-tenancy.md` flags this as a
  likely necessary control that was never confirmed in scope.
- Whether formality and communication style are required for readiness or safely defaulted — currently
  only the bot name is confirmed as required.
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
