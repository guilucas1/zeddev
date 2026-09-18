# WhatsApp Number Connection

## Purpose

Defines how a client tenant connects, verifies, monitors, disconnects, and replaces the single WhatsApp number that links their business to the chatbot, using the official WhatsApp Business Cloud API. Establishes the connection health state vocabulary that other specs (operator monitoring, proactive alerting, client-facing status) depend on.

## Behavioral Requirements

- The system must allow a client to initiate a WhatsApp number connection for their tenant entirely through self-service steps, without operator intervention.
- The system must connect exactly one WhatsApp number per tenant in v1; a tenant with an existing connected number must not be able to add a second concurrent number.
- The system must use the official WhatsApp Business Cloud API (Meta) as the sole integration path for sending and receiving messages on the connected number.
- The system must guide the client through any platform-side steps required to authorize the platform's access to their WhatsApp Business number (e.g., granting permissions, associating the number with the platform's Meta integration).
- The system must verify that the connection is functional (able to send and receive messages) before marking a number as connected.
- The system must expose a connection health state for each tenant's number at all times, drawn from a fixed, well-defined vocabulary (see State Vocabulary below).
- The system must transition a connection's state automatically in response to observable connectivity/authorization events, not only in response to user action.
- The system must record a timestamped history of state transitions for each tenant's connection sufficient to answer "when did this change and to what."
- The system must allow a client to manually disconnect their WhatsApp number at any time from a connected, error, or reconnecting state.
- The system must allow a client to replace their connected WhatsApp number with a different number, without requiring operator intervention.
- The system must ensure that during a number replacement, the previously connected number stops receiving/sending chatbot traffic for that tenant no later than the new number's connection is confirmed.
- The system must prevent a tenant from being left in an ambiguous state where two numbers are simultaneously treated as "the tenant's active number."
- The system must surface a specific, human-readable reason when a connection enters an error state (e.g., authorization revoked, number disconnected on Meta's side, rate-limited, configuration invalid), to the extent that reason is available from the WhatsApp Business Cloud API or platform-side checks.
- The system must attempt automatic recovery (reconnecting) for transient/interrupted connection issues before surfacing a terminal error state, where the underlying cause is plausibly transient.
- The system must make the current connection state and last-known-good timestamp visible to the client for their own tenant.
- The system must treat tenant offboarding as a trigger that disconnects the tenant's WhatsApp number as an outcome, without itself defining data retention/deletion behavior.
- The system must detect and surface when Meta-side business verification (or equivalent external prerequisite) is incomplete or has been revoked, as a distinct condition from a purely technical connectivity failure, since this blocks self-service completion until resolved externally.
- The system must not allow a tenant to be marked "connected" based solely on the client submitting credentials/configuration — connection status must reflect a verified, working link, not just submitted intent.

## State Vocabulary

- **connecting** — Client has initiated setup; the platform is completing authorization/verification steps and has not yet confirmed a working link. Not yet counted as connected.
- **connected** — The number is authorized and verified able to send/receive messages via the WhatsApp Business Cloud API. This is the only state in which the chatbot may exchange messages through this number.
- **reconnecting** — A previously connected number has experienced an interruption and the platform is automatically attempting to restore the link without client action. Distinct from error: implies an automatic recovery attempt is in progress and has not yet been exhausted. Being in `reconnecting` does not by itself revoke bot readiness (see `bot-activation-control.md`), whereas entering `error` or `disconnected` does (and `connecting` never satisfies it).
- **error** — The connection is not functional and automatic recovery either does not apply or has been exhausted; requires attention (client action, or external Meta-side resolution) to restore. Must carry a reason.
- **disconnected** — No number is actively connected for the tenant, whether because the client manually disconnected, offboarding occurred, or no connection has ever been established.

## Acceptance Criteria

- Given a client with no prior connection, when they complete the self-service connection flow and the platform verifies send/receive capability, then the tenant's state becomes "connected" and the client can see this status.
- Given a client with no prior connection, when they submit configuration/credentials but verification has not yet succeeded, then the tenant's state is "connecting," not "connected."
- Given a tenant already in "connected" state, when the client attempts to connect a second WhatsApp number without first disconnecting or replacing, then the system rejects the action and the original number remains the sole active number.
- Given a tenant in "connected" state, when the platform detects the number's connectivity has been interrupted for a cause it can plausibly recover from automatically, then the state transitions to "reconnecting" and the client can observe this.
- Given a tenant in "reconnecting" state, when the automatic recovery attempt succeeds, then the state transitions back to "connected" and the transition is recorded with a timestamp.
- Given a tenant in "reconnecting" state, when automatic recovery attempts are exhausted without success, then the state transitions to "error" with a surfaced reason.
- Given a tenant in "connected," "error," or "reconnecting" state, when the client manually disconnects, then the state transitions to "disconnected" and the chatbot no longer sends/receives via that number.
- Given a tenant in "connected" state, when the client initiates a number replacement and successfully connects a new number, then the old number is no longer treated as active for the tenant no later than the new number reaches "connected," and at no point are both numbers simultaneously active for that tenant.
- Given a tenant whose Meta-side business verification is incomplete or revoked, when the client attempts to complete or maintain a connection, then the system surfaces this as a distinct blocking condition (not a generic technical error) describing that external action is required.
- Given any state transition for a tenant's connection, when it occurs, then it is recorded with a timestamp and is retrievable as history for that tenant's connection.
- Given a tenant that completes offboarding, when offboarding processing runs, then the tenant's WhatsApp connection state transitions to "disconnected" as an outcome of offboarding.
- Given a tenant's connection is in "error" state, when the client or operator views the connection, then a specific reason for the error is displayed if available from the API or platform-side checks.

## Out of Scope

- Tenant/account signup, business identity creation, and initial tenant provisioning — see `client-signup-and-tenancy.md`.
- The go-live/activation toggle that controls whether the chatbot actively responds once a number is connected — see `bot-activation-control.md`.
- Operator-facing monitoring dashboards, uptime aggregation, and alert delivery mechanics built on top of these connection states — see `operator-health-monitoring.md` and `operator-proactive-alerting.md`.
- Data retention, message history deletion, and other offboarding data-handling policy — see `client-offboarding-and-data-retention.md`.
- Support for more than one WhatsApp number per tenant (explicitly out of scope for v1).
- Billing/plan implications of connecting, disconnecting, or replacing a number.
- Message content handling, conversation flows, or chatbot response logic once connected.

## Open Questions / Assumptions

- Assumed "replace number" is a distinct guided flow (not merely "disconnect then connect again") so the system can guarantee no ambiguous dual-active-number window; exact UX sequencing is left open for design.
- Assumed the platform can query the WhatsApp Business Cloud API for enough signal to distinguish "transient/recoverable" from "terminal" failures; if the API cannot reliably provide this distinction, the reconnecting-vs-error boundary may need revisiting in a later phase.
- Assumed a reasonable, bounded number of automatic reconnection attempts/time window before falling back to "error" is acceptable to define at implementation time rather than fixed in this spec.
- Assumed "last-known-good timestamp" (last time state was "connected") is the right minimal freshness signal to expose to the client; deeper analytics/uptime metrics are left to `operator-health-monitoring.md`.
- Assumed Meta-side business verification status is queryable or otherwise observable by the platform; if it is not directly observable, the platform may only be able to infer it indirectly from connection failures.
