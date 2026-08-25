# Message Delivery Reliability

## Purpose

Defines the transport-level guarantees the system provides for every inbound and outbound WhatsApp message once a tenant's number is connected: accepting and acknowledging inbound notifications, attributing them to the correct tenant, suppressing duplicates, preserving per-customer ordering, surviving restarts, retrying failed outbound sends, and recording delivery outcomes for operator visibility — the reliability of the pipe between WhatsApp and the bot, independent of what the bot says or how the connection itself is established.

## Behavioral Requirements

- The system must accept inbound message notifications from the WhatsApp Business Cloud API for any tenant whose number is in the "connected" state per `whatsapp-number-connection.md`.
- The system must acknowledge receipt of an inbound notification promptly and independently of how long generating a reply takes; reply generation must never block or delay acknowledgement, because a slow acknowledgement causes the upstream platform to redeliver the notification.
- The system must verify that an inbound notification genuinely originates from the WhatsApp Business Cloud API and must reject and record any notification that fails this verification rather than processing it.
- The system must attribute every inbound message to exactly one tenant, determined from the receiving WhatsApp number, per `tenant-data-isolation.md`.
- The system must reject and record a notification that cannot be confidently attributed to a tenant rather than processing it against a guessed tenant.
- The system must recognise a redelivered inbound message as the same message it has already seen and must not process it a second time, must not store it a second time in the transcript, and must not send a second reply on account of it, even when the redelivery arrives after the original processing has completed.
- The system must process messages from a given end-customer in the order that end-customer sent them, not merely in the order they happened to arrive, and out-of-order arrival must not corrupt the turn grouping defined in `message-burst-aggregation.md` or the context maintained in `conversation-memory.md`.
- The system must ensure that an inbound message that has already been acknowledged is not lost if a component restarts before a reply is produced for it; the message must still be processed once the component recovers, consistent with `component-independence.md`.
- The system must retry an outbound reply that fails to send for a transient reason, with backoff, up to a defined retry allowance.
- The system must ensure that retrying an outbound send does not result in the end-customer receiving the same reply more than once.
- The system must record a failure against the tenant when an outbound reply cannot be delivered after the retry allowance is exhausted, so it is reflected in the failed-delivery metrics required by `operator-health-monitoring.md`, rather than silently dropping the reply.
- The system must treat an outbound delivery failure as distinct from the bot being unable to produce an answer, the latter being governed by `fallback-response-behavior.md`.
- The system must feed a send failure that indicates the connection itself is broken (for example, revoked authorization) into the connection state transitions defined in `whatsapp-number-connection.md`, rather than treating it only as a per-message delivery failure.
- The system must recognise WhatsApp's 24-hour customer service window — the WhatsApp Business Cloud API only permits free-form business-initiated messages within 24 hours of the end-customer's most recent message — and must detect when a reply would fall outside that window.
- The system must not silently fail when a reply would fall outside the 24-hour window; it must record the occurrence for operator visibility.
- The system must still receive, attribute, deduplicate, and retain a message received while the bot is off per `bot-activation-control.md`, or while a conversation is paused per `human-handoff.md`, even though no reply is produced for it.
- The system must not produce a reply to a message received for a tenant that has offboarded per `client-offboarding-and-data-retention.md`.
- The system must retrieve, for an inbound message that references an image or voice note, that media for understanding per `image-message-understanding.md` and `voice-message-understanding.md` respectively, up to a defined retry allowance.
- The system must hand a media retrieval that continues to fail after its retry allowance is exhausted to `fallback-response-behavior.md` rather than leaving the message unprocessed indefinitely.
- The system must account for the fact that media references provided by the upstream platform are not durable indefinitely, and must not assume a media object remains retrievable arbitrarily long after the inbound notification was received.
- The system must contain a failure, backlog, or surge on one tenant's message path so it does not delay or degrade another tenant's message path, per `tenant-data-isolation.md`.
- The system must ensure that diagnostics recorded for operator consumption about message delivery contain operational information only (e.g., error codes, timestamps, retry counts) and exclude message content, per `operator-health-monitoring.md`.

## Acceptance Criteria

- Given a tenant whose number is "connected," when the WhatsApp Business Cloud API delivers an inbound message notification, then the system acknowledges receipt without waiting for a reply to be generated.
- Given an inbound notification that fails authenticity verification, when it is received, then the system rejects it, records the rejection, and does not process it as a message.
- Given an inbound notification whose receiving WhatsApp number cannot be confidently matched to a tenant, when it is received, then the system rejects it, records the rejection, and does not process it against any tenant.
- Given an inbound message that has already been processed and replied to, when the WhatsApp Business Cloud API redelivers the same notification, then the system recognises it as already-seen, does not store it again in the transcript, and does not send a second reply.
- Given an end-customer sends multiple messages in quick succession, when those notifications are delivered out of the order they were sent, then the system processes and stores them in the order the end-customer actually sent them.
- Given an inbound message has been acknowledged but the component responsible for generating a reply restarts before doing so, when the component recovers, then the message is still processed and a reply is produced for it.
- Given an outbound reply fails to send for a transient reason, when the system retries within the defined retry allowance and a retry succeeds, then the end-customer receives exactly one copy of the reply.
- Given an outbound reply fails to send for a transient reason and every retry within the defined retry allowance also fails, when the retry allowance is exhausted, then the system records the failure against the tenant such that it is reflected in that tenant's failed-delivery metrics, and does not silently discard the reply.
- Given an outbound send fails with an error indicating the connection's authorization has been revoked, when the failure is observed, then the connection state transition defined in `whatsapp-number-connection.md` is triggered, not only a per-message failure record.
- Given more than 24 hours have elapsed since an end-customer's most recent message and the system attempts to send that end-customer a reply, when the send is attempted, then the system detects that the attempt falls outside WhatsApp's customer service window, does not silently fail, and records the occurrence.
- Given a tenant whose bot is turned off per `bot-activation-control.md`, when an end-customer sends a message, then the system receives, attributes, deduplicates, and retains the message without producing a reply.
- Given a conversation paused for human handoff per `human-handoff.md`, when the end-customer sends a further message, then the system receives, attributes, deduplicates, and retains the message without producing a bot reply.
- Given a tenant that has completed offboarding per `client-offboarding-and-data-retention.md`, when a message arrives referencing that tenant's former number, then no reply is produced.
- Given an inbound message references an image or voice note, when the system attempts to retrieve that media, then it retries up to the defined retry allowance before treating the retrieval as failed.
- Given a media retrieval fails after its retry allowance is exhausted, when this occurs, then the message is handled per `fallback-response-behavior.md` rather than left unprocessed.
- Given one tenant's message path is experiencing a failure, backlog, or traffic surge, when another tenant's messages are processed during the same period, then the other tenant's processing latency and success rate are unaffected.
- Given an operator views delivery diagnostics for any tenant, when they inspect any failure record, then it contains only operational information (error codes, timestamps, retry counts) and no message content.

## Out of Scope

- Establishing, verifying, and recovering the WhatsApp connection itself, and its state vocabulary — see `whatsapp-number-connection.md`.
- Grouping consecutive inbound messages into a single conversational turn — see `message-burst-aggregation.md`.
- Generating the content of a reply, whether text, image-derived, or voice-derived — see `text-conversation-handling.md`, `image-message-understanding.md`, and `voice-message-understanding.md`.
- What the bot says or does when it cannot produce a confident answer — see `fallback-response-behavior.md`.
- Proactively alerting an operator when delivery failures or the 24-hour-window occurrence cross a concerning threshold — see `operator-proactive-alerting.md`.
- End-customer rate limiting and abuse protection, explicitly deferred for v1.
- WhatsApp message templates and their approval process, beyond noting the 24-hour customer service window constraint above.

## Open Questions / Assumptions

- The exact retry count, backoff shape, and acknowledgement timeout for both inbound acknowledgement and outbound send retries are left open for the implementation phase.
- How long a duplicate-suppression record must be kept before it can be discarded is left open; assumed it must at least exceed the upstream platform's own redelivery window so a late redelivery is still recognised.
- What the system should do when a reply falls outside the 24-hour customer service window — drop the reply, or send an approved template message instead — is left as an open product decision, since template messages carry cost implications relevant to `cost-efficient-operation.md`.
- Whether inbound ordering must be preserved only within a single end-customer's own messages, or more broadly (e.g., across an end-customer's messages interleaved with system-side events), is left open; this spec assumes per-end-customer ordering is the binding requirement.
- Assumed outbound delivery receipts from the WhatsApp Business Cloud API are available as a signal the system may use to confirm successful delivery, but this spec's requirements do not depend on receipts being available or reliable.
- Assumed the defined retry allowance for media retrieval may reasonably differ from the retry allowance for outbound message sends; exact values for each are left to implementation.
