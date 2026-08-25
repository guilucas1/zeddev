# Client Offboarding and Data Retention

## Purpose

Define what happens to a client business's data (configuration, conversation history, WhatsApp connection, uploaded knowledge documents) when the client offboards from the platform, including the default retention window that follows offboarding and the client's right to request immediate, permanent deletion at any time.

## Behavioral Requirements

- The system must allow a client to initiate offboarding (cancel/stop using the platform) themselves, with no operator action required.
- Offboarding must be a client-initiated action only; the operator has no independent ability to offboard, suspend, or deactivate a client's tenant in v1, per `bot-activation-control.md`.
- Upon offboarding, the system must immediately stop the client's bot from auto-responding to end-customer messages.
- Upon offboarding, the system must immediately revoke the client's and their bot's active use of the connected WhatsApp number for sending or receiving new messages, without affecting any other tenant's WhatsApp connection.
- Upon offboarding, the system must place the client's tenant into a defined retention window during which the client's data (configuration, conversation history, WhatsApp connection details, uploaded knowledge documents) is retained rather than immediately deleted.
- During the retention window, the system must not use the offboarded client's data for any purpose other than fulfilling retention, deletion, or legally/contractually required functions (e.g., no further bot processing, no use in aggregate analytics beyond what already existed).
- The system must automatically and permanently delete all of an offboarded client's data at the end of the retention window, without requiring further client or operator action.
- The system must allow a client to request permanent deletion of their data at any time, independent of and without waiting for the retention window to elapse.
- The system must allow a client to request permanent deletion either at the moment of offboarding or at any later point during the retention window.
- The system must allow a client to request permanent deletion while still an active (non-offboarded) client, and such a request must trigger both offboarding and deletion.
- Once a client requests permanent deletion, the system must honor that request within a bounded, predictable turnaround time rather than leaving it pending indefinitely.
- A deletion request, once confirmed, must be irreversible: the client's configuration, conversation history, WhatsApp connection details, and uploaded knowledge documents must all be permanently removed and unrecoverable.
- The system must require explicit confirmation from the client before executing a permanent deletion request, distinguishing it from routine offboarding.
- The system must not permanently delete a client's data solely because they offboarded, before the retention window elapses, unless the client has explicitly requested earlier deletion.
- The system must allow an offboarded client, while still within the retention window, to reactivate/rejoin the platform, restoring access to their retained data, provided they have not requested permanent deletion.
- The system must NOT allow reactivation of a tenant whose data has already been permanently deleted; a client in that state must sign up again as a new tenant per `client-signup-and-tenancy.md`, with no continuity to the deleted tenant's prior data.
- The system must clearly communicate to the client, at the time of offboarding, that a retention window applies, what it means, and that they may request immediate deletion instead.
- The system must clearly communicate to the client, at the time of a deletion request, that the action is permanent and irreversible before it is finalized.
- The system must guarantee that offboarding, retention, and deletion of one client's tenant never affects any other client's data, configuration, connections, or bot behavior, per `tenant-data-isolation.md`.
- The system must record when a client's tenant was offboarded, when (or whether) a deletion request was made, and when permanent deletion actually occurred.
- The system must prevent an offboarded client's end-customers from receiving any further automated responses once offboarding takes effect.

## Acceptance Criteria

- Given an active client, When the client initiates offboarding, Then the bot immediately stops auto-responding to end-customer messages and the WhatsApp connection is no longer usable by the tenant, with no operator action involved.
- Given a client has just offboarded, When offboarding completes, Then the client's data enters a defined retention window and is not deleted immediately.
- Given a client's data is within the retention window, When the retention window elapses with no deletion request made, Then all of that client's data (configuration, conversation history, WhatsApp connection details, uploaded knowledge documents) is automatically and permanently deleted without further action.
- Given a client (active or already offboarded), When the client requests permanent deletion of their data and confirms the request, Then the system permanently deletes all of that client's data within a bounded, predictable turnaround time, without waiting for the retention window to elapse.
- Given a client requests permanent deletion, When the request is submitted but not yet confirmed, Then the system requires explicit confirmation and communicates that the action is irreversible before proceeding.
- Given a client's data has been permanently deleted, When anyone (client, operator, or system process) attempts to retrieve or restore it, Then no configuration, conversation history, connection details, or documents are recoverable.
- Given a client is within the retention window and has not requested deletion, When the client chooses to reactivate, Then the client regains access to their previously retained configuration, conversation history, connection state (subject to reconnecting WhatsApp per `whatsapp-number-connection.md`), and documents.
- Given a client's data has already been permanently deleted, When that client attempts to reactivate or log back in to the same tenant, Then the system does not restore any prior data and directs them to sign up as a new tenant if they wish to use the platform again.
- Given a client offboards, When the offboarding is processed, Then no other client's tenant data, configuration, connections, or bot behavior is affected in any way.
- Given a client offboards or requests deletion, When the action occurs, Then the system records the offboarding timestamp, any deletion request timestamp, and the actual permanent deletion timestamp.
- Given an active client requests immediate permanent deletion without a separate prior offboarding step, When the request is confirmed, Then the system treats it as both offboarding and deletion: the bot stops responding, the WhatsApp connection is revoked, and the data is permanently deleted within the bounded turnaround time.
- Given a client's tenant is offboarded and pending deletion, When an end-customer sends a message to the previously connected WhatsApp number, Then the end-customer receives no automated response from the platform.

## Out of Scope

- Tenant creation, initial signup, and provisioning — see `client-signup-and-tenancy.md`; this spec is its mirror-image counterpart for the end of the client lifecycle.
- The detailed technical isolation guarantees and mechanisms that ensure one client's offboarding/deletion cannot affect another's — see `tenant-data-isolation.md`.
- The client-controlled bot on/off toggle used during normal (non-offboarding) operation — see `bot-activation-control.md`. Offboarding is a distinct, further state beyond simply pausing the bot.
- Any operator-initiated suspension, deactivation, or forced offboarding of a client — explicitly out of scope for v1; only the client can trigger offboarding or deletion of their own tenant.
- Mechanics of establishing or reconnecting a WhatsApp number connection — see `whatsapp-number-connection.md`.
- Billing implications of offboarding (e.g., final invoicing, refunds, subscription cancellation mechanics).
- Legal, regulatory, or contractual data retention obligations that might override or extend the default retention window (e.g., statutory recordkeeping requirements) — not addressed here beyond noting the window is configurable/decidable in a later phase.
- Export or download of a client's data prior to deletion (data portability) — not addressed in this spec.
- Backup/archival copy retention and deletion timing relative to the live-data retention window described here.

## Open Questions / Assumptions

- The exact duration of the default retention window is not specified in this spec and is an open question for a later phase to decide (e.g., could range from days to months depending on business/legal needs).
- The exact turnaround time for honoring an explicit deletion request is not specified here and is left open; assumed to be materially faster than passively waiting out the full retention window, but no specific number of hours/days is defined.
- Assumed "offboarding" and "deletion request" are two distinct client actions (offboarding alone does not imply immediate deletion; deletion can be requested with or without a prior separate offboarding step) — this spec treats a deletion request made while still active as implicitly triggering offboarding too.
- Assumed reactivation during the retention window is desired/allowed (i.e., offboarding is not necessarily final until either the window elapses or deletion is explicitly requested) — this was not explicitly confirmed in the interview and should be validated.
- Assumed data portability/export is not required as part of offboarding in v1; if clients need to extract their data before it is deleted, that would need to be added as a requirement in a future revision.
- Assumed backups/archives, if any exist per a future implementation, are expected to be purged on the same schedule as live data by the end of the retention window or upon confirmed deletion request, consistent with the isolation spec's assumption that isolation applies to backups too — exact backup purge timing is left to implementation.
- Assumed the confirmation step for permanent deletion can be a single explicit in-product confirmation (not a multi-step or delayed cooling-off process) — exact confirmation UX is left open for a later phase.
