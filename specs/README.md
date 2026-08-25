# Specs Index — AI WhatsApp Chatbot SaaS

This directory contains the Phase 1 (Define Requirements) output for the project: a multi-tenant SaaS
where a solo operator connects an AI-powered chatbot to each client business's own WhatsApp number, so
the bot handles conversations with that client's end-customers on their behalf.

Every file in this directory describes **what** the system must do — observable behavior and acceptance
criteria only. None of them prescribe code, folder structure, technology/vendor choices, or architecture.
Those decisions are made later, in the planning/building phases (see `IMPLEMENTATION_PLAN.md`, produced
in PLANNING mode, not here).

## Primary Jobs To Be Done

1. **Operator** — onboard a new client business and connect their WhatsApp number to an isolated chatbot
   instance, without affecting any other client's bot.
2. **Client** — have the chatbot hold a real AI-driven conversation with end-customers on WhatsApp, with
   no code required from the client.
3. **Client** — configure the bot's persona, tone, business knowledge, and rules, with no developer help.
4. **Client** — have the bot remember the context of an ongoing conversation with a given end-customer.
5. **Operator** — get visibility into each client's bot (connected? working? what's happening?) to support
   clients and catch problems early.
6. **Operator** — swap the underlying AI model/provider without re-architecting the system.
7. **Operator** — run the same codebase on a laptop (free), a cheap VPS (early production), and a more
   advanced cloud provider later (scale), with configuration-only differences between them.
8. **Operator** — keep the system's components (storage, messaging connection, AI/conversation logic,
   admin interface, etc.) independently deployable, restartable, scalable, and replaceable.
9. **Operator** — start at zero/near-zero ongoing cost and only take on more cost as usage justifies it.

## Key decisions from the requirements interview

These were resolved with the operator before any spec was written, and are authoritative across all specs
below unless a specific spec says otherwise:

- **WhatsApp integration**: official WhatsApp Business Cloud API (Meta) only — no unofficial/ToS-violating
  connection method. One WhatsApp number per client tenant in v1.
- **Onboarding**: fully self-service — a client signs up, configures, and connects WhatsApp themselves,
  with no operator involvement required. A tenant is considered ready to go live once WhatsApp is
  connected and minimum configuration is set; the client then flips an explicit go-live/pause toggle they
  fully control (the operator has no independent suspend capability in v1).
- **Bot configuration**: clients can use structured guided fields, freeform instructions text, and/or
  uploaded knowledge documents — in any combination — to set persona/tone, business knowledge, and
  behavior rules/guardrails.
- **Conversation memory**: the reset policy (what starts a "fresh" context with an end-customer) is
  configurable per client business, not fixed platform-wide.
- **Message types**: text, images, and voice notes (transcribed) are all in scope for v1. Documents/PDFs
  and video are out of scope for v1. Single language per client (no auto-detection/switching).
- **Human handoff**: available, but client-configurable whether it's enabled at all.
- **Fallback behavior**: when the bot can't produce a good answer and handoff isn't available, the
  fallback message/behavior is client-configurable.
- **Bot disclosure**: whether the bot tells end-customers it's automated/AI is a client choice — both
  modes must be supported.
- **Operator visibility**: connection health, aggregated metrics, and proactive alerting — but explicitly
  **no** access to conversation transcript content. Transcripts are visible only to the client business
  that owns them.
- **Availability**: bot is always-on, 24/7 — no business-hours concept in v1.
- **Abuse/rate-limiting and per-client cost caps**: explicitly deferred, not built in v1 (to be revisited
  once real usage patterns are known).
- **Operator-side suspend**: not needed in v1 — only the client controls their own bot's activation state.
- **Offboarding**: triggers a default retention window before deletion, but a client can request immediate,
  permanent deletion of their data at any time.

## Spec index

### Onboarding, connection & tenancy (JTBD 1)
- [`client-signup-and-tenancy.md`](./client-signup-and-tenancy.md) — self-service signup and isolated
  tenant provisioning.
- [`whatsapp-number-connection.md`](./whatsapp-number-connection.md) — connecting/disconnecting/replacing
  a client's WhatsApp Business number; connection health states.
- [`tenant-data-isolation.md`](./tenant-data-isolation.md) — the cross-cutting guarantee that no client's
  data or bot behavior can affect or be exposed to another client.
- [`bot-activation-control.md`](./bot-activation-control.md) — onboarding-complete/readiness gate plus the
  client-controlled go-live/pause toggle.
- [`client-offboarding-and-data-retention.md`](./client-offboarding-and-data-retention.md) — what happens
  to a client's data when they leave, retention window, and on-demand deletion.
- [`authentication-and-access.md`](./authentication-and-access.md) — how clients and the operator prove
  identity, and the separation between the two identity spaces. *(Added during planning — see below.)*
- [`credential-and-secret-handling.md`](./credential-and-secret-handling.md) — protection, rotation, and
  destruction of the platform's and each tenant's secrets. *(Added during planning — see below.)*

### Conversation & AI behavior (JTBD 2)
- [`text-conversation-handling.md`](./text-conversation-handling.md) — core text-in/text-out AI
  conversation handling.
- [`image-message-understanding.md`](./image-message-understanding.md) — understanding images
  end-customers send.
- [`voice-message-understanding.md`](./voice-message-understanding.md) — understanding voice notes
  end-customers send.
- [`fallback-response-behavior.md`](./fallback-response-behavior.md) — client-configurable behavior when
  the bot can't produce a good answer.
- [`bot-disclosure-setting.md`](./bot-disclosure-setting.md) — client choice of whether the bot discloses
  it's automated/AI.
- [`human-handoff.md`](./human-handoff.md) — client-configurable handoff of a conversation to a human.
- [`message-burst-aggregation.md`](./message-burst-aggregation.md) — grouping an end-customer's rapid
  consecutive messages into one conversational turn with one reply. *(Added during planning — see below.)*
- [`message-delivery-reliability.md`](./message-delivery-reliability.md) — inbound webhook acceptance,
  deduplication, ordering, and outbound send/retry guarantees. *(Added during planning — see below.)*

### Bot configuration (JTBD 3)
- [`persona-and-tone-configuration.md`](./persona-and-tone-configuration.md) — configuring the bot's
  identity, voice, and communication style.
- [`business-knowledge-configuration.md`](./business-knowledge-configuration.md) — supplying business facts
  via freeform text and/or uploaded documents.
- [`behavior-rules-configuration.md`](./behavior-rules-configuration.md) — configuring do's/don'ts and
  guardrails.
- [`language-configuration.md`](./language-configuration.md) — choosing the single language the bot
  replies in. *(Added during planning — see below.)*

### Conversation memory (JTBD 4)
- [`conversation-memory.md`](./conversation-memory.md) — per-end-customer conversation context and its
  client-configurable reset policy.

### Operator visibility (JTBD 5)
- [`operator-health-monitoring.md`](./operator-health-monitoring.md) — per-client connection health and
  aggregated metrics, explicitly excluding conversation content.
- [`operator-proactive-alerting.md`](./operator-proactive-alerting.md) — proactive operator notification
  when a client's bot has problems.
- [`client-conversation-visibility.md`](./client-conversation-visibility.md) — the client's own visibility
  into their end-customers' conversation transcripts.

### Platform portability & architecture outcomes (JTBD 6, 7, 8)
- [`ai-provider-portability.md`](./ai-provider-portability.md) — swapping the underlying AI provider/model
  without re-architecting.
- [`environment-portability.md`](./environment-portability.md) — running the same codebase across a
  laptop, a low-cost VPS, and a managed cloud provider via configuration only.
- [`component-independence.md`](./component-independence.md) — independent deployability, restartability,
  scalability, and replaceability of the system's components.

### Cost (JTBD 9)
- [`cost-efficient-operation.md`](./cost-efficient-operation.md) — operating at zero/near-zero cost at low
  volume, with cost scaling only as usage grows.

## Specs added during planning

The five specs marked above were written during the planning phase, after a gap analysis of the original
twenty-two against the product goal. Each closes a requirement that some existing spec depended on but no
spec owned:

- `language-configuration.md` — `text-conversation-handling.md` and `voice-message-understanding.md` both
  require "the single language configured for that client business", but nothing defined configuring it;
  `persona-and-tone-configuration.md` and `business-knowledge-configuration.md` each disclaim it.
- `message-burst-aggregation.md` — `voice-message-understanding.md` defers multi-message burst handling to
  `text-conversation-handling.md`, which never mentions bursts, and `image-message-understanding.md`
  requires multi-image turns while leaving the grouping window undefined. This spec is now the single
  source of truth for what one conversational turn is.
- `authentication-and-access.md` — `tenant-data-isolation.md` and `client-conversation-visibility.md` both
  push authentication out of scope and hand it to nobody, and operator authentication to the
  platform-wide surfaces in `operator-health-monitoring.md` was entirely unspecified.
- `message-delivery-reliability.md` — nothing covered webhooks, duplicate inbound delivery, ordering,
  outbound retry, or WhatsApp's 24-hour customer service window, yet `operator-health-monitoring.md`
  already requires a "failed message deliveries" metric that nothing produced.
- `credential-and-secret-handling.md` — nothing mentioned protection at rest, though
  `tenant-data-isolation.md` requires per-tenant WhatsApp credentials be unusable across tenants.

They follow the same behavior-only convention as the rest of this directory.

## Notes for the next phase

- Every spec's **Open Questions / Assumptions** section flags things left unresolved on purpose (exact
  retention window length, exact reset-policy options, exact metrics list, etc.) — review these before or
  during planning, since several are genuinely open rather than obvious defaults.
- `IMPLEMENTATION_PLAN.md` now exists at the repository root. It records the technology and sequencing
  decisions this directory deliberately avoids, the cross-spec conflicts found during planning, and the
  subset of the open questions above that actually block work.
