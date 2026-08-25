# Operator Proactive Alerting

## Purpose

Ensures the operator learns about client-impacting problems (connection loss, error spikes, and other conditions defined in `operator-health-monitoring.md` and `whatsapp-number-connection.md`) by being actively notified, rather than having to watch a dashboard. Defines when a notification must fire and what guarantee exists that it reaches the operator.

## Behavioral Requirements

- The system must notify the operator via at least one active channel (a channel that pushes to the operator, as opposed to a channel the operator must open to check) whenever a tenant's WhatsApp connection transitions into the "error" state, as defined in `whatsapp-number-connection.md`.
- The system must notify the operator when a tenant's WhatsApp connection transitions into "reconnecting" and remains there without returning to "connected" for longer than a defined threshold, rather than only at final "error."
- The system must notify the operator when a tenant's error rate or other anomaly signal crosses an "error spike" threshold, as defined in `operator-health-monitoring.md`.
- The system must notify the operator for every tenant on the platform independently — an incident on one tenant must not be suppressed, delayed, or merged away because another tenant is also experiencing an incident.
- The system must identify which tenant a notification concerns, and which underlying condition (connection state, error spike, or other defined health signal) triggered it.
- The system must not require the operator to have a dashboard open, or to be actively polling any view, to receive a notification.
- The system must deliver a notification for a qualifying event within a bounded, defined time of that event being detected by the underlying health/connection monitoring.
- The system must avoid re-notifying the operator repeatedly for the same ongoing, unresolved incident on the same tenant within a defined suppression window, while still notifying again if the condition escalates or a new distinct condition arises on the same tenant.
- The system must notify the operator when a previously alerted condition for a tenant resolves (e.g., connection returns to "connected," error rate returns to normal), so the operator knows the incident ended without needing to check.
- The system must record every notification the system attempted to send to the operator, including the triggering condition, the tenant, the time triggered, and whether delivery succeeded, in a form the operator (or a later audit) can retrieve.
- The system must continue to attempt operator notification for a qualifying event even if one delivery attempt on the active channel fails, up to a defined retry allowance.
- The system must treat a failure to deliver a notification to the operator as itself an observable condition (e.g., logged/recorded), so silent notification failures are not indistinguishable from "nothing happened."

## Acceptance Criteria

- Given a tenant's WhatsApp connection transitions to "error," when the transition is recorded, then the operator receives a notification identifying the tenant and the error reason within the defined delivery time bound.
- Given a tenant's WhatsApp connection enters "reconnecting" and has not returned to "connected" after the defined threshold duration, when that threshold is crossed, then the operator receives a notification, even though the connection has not reached a terminal "error" state.
- Given a tenant's error rate crosses the "error spike" threshold defined in `operator-health-monitoring.md`, when the crossing is detected, then the operator receives a notification identifying the tenant and the spike condition.
- Given two different tenants both enter an alerting condition at the same time, when notifications are generated, then the operator receives a distinct notification for each tenant, and neither is dropped because of the other.
- Given a tenant is already in an alerted, unresolved "error" state, when the same underlying condition persists without escalation, then the operator is not sent a duplicate notification more often than the defined suppression window allows.
- Given a tenant's alerted condition escalates (e.g., moves from a warning-level threshold to a more severe one) while still unresolved, when the escalation is detected, then the operator receives a new notification despite being within the suppression window for the original alert.
- Given a tenant's connection returns from "error" or "reconnecting" to "connected," when this recovery is recorded, then the operator receives a notification that the condition has resolved for that tenant.
- Given a notification attempt is made, when delivery on the active channel fails, then the system retries up to the defined retry allowance and records each attempt's outcome.
- Given all retry attempts for a notification fail, when the retries are exhausted, then the failure is recorded as an observable condition rather than silently discarded.
- Given any notification the system has sent or attempted, when the operator or an auditor queries notification history, then the tenant, triggering condition, timestamp, and delivery outcome are retrievable.
- Given no qualifying condition has occurred for a tenant, when the operator checks notification history, then no notification exists for that tenant during that period.

## Out of Scope

- Definitions of what constitutes "connection down," specific connection states, and their transitions — see `whatsapp-number-connection.md`.
- Definitions of "error spike," error-rate calculation, health metrics, and dashboard-style visibility — see `operator-health-monitoring.md`.
- The specific notification channel or technology (e.g., email, SMS, push, chat integration) — left as an implementation decision.
- Operator suspension powers or any new control/remediation action the operator can take in response to a notification — explicitly out of scope for v1.
- Client-facing notifications to the tenant's own end-customers or business owner about their own bot's status.
- Notification preference management (e.g., operator configuring channel, quiet hours) beyond the requirement that some active channel exists.
- Alerting for conditions not defined in `operator-health-monitoring.md` or `whatsapp-number-connection.md` (e.g., billing, infrastructure-level alerting unrelated to tenant bot health).

## Open Questions / Assumptions

- Assumed a "reconnecting too long" threshold is needed as a distinct trigger from terminal "error," since a stalled reconnection could otherwise go unnoticed for an extended period; exact duration left open.
- Assumed a suppression/de-duplication window is necessary to avoid notification fatigue from a single ongoing incident; exact window length left open for later phases.
- Assumed "escalation" (e.g., warning-level to severe-level spike) should bypass suppression and re-notify; exact severity tiers are defined by `operator-health-monitoring.md`, not here.
- Assumed a bounded delivery-time guarantee (e.g., "within N minutes of detection") is required to make "proactive" testable, but the exact N is left open as an implementation/product decision.
- Assumed a bounded retry allowance (count and/or duration) for failed delivery attempts is required to avoid infinite retry loops; exact count left open.
- Assumed resolution notifications (incident cleared) are in scope since they are part of the operator knowing "something went wrong" has a full lifecycle, not just onset.
- Assumed notification history retention duration follows the same policy as other operational/audit data on the platform; not redefined here.
