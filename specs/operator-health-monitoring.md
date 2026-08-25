# Operator Health Monitoring

## Purpose
Give the platform operator a single place to see, across every client tenant, whether each tenant's bot is connected and working, and to review aggregated usage/error/performance metrics per tenant — so the operator can support clients and catch problems early, without ever accessing any tenant's end-customer conversation content.

## Behavioral Requirements
- The system must display, for every client tenant on the platform, the tenant's current WhatsApp connection health state, using the state vocabulary defined in `whatsapp-number-connection.md` (connected, connecting, reconnecting, error, disconnected).
- The system must display the connection health state for all tenants together in one consolidated view, not require the operator to open each tenant individually to learn its state.
- The system must allow the operator to open a single tenant's detail view to see that tenant's connection state, state-transition history, and metrics in more depth.
- The system must display, per tenant, the last-known-good (last "connected") timestamp for that tenant's connection.
- The system must display, per tenant, a specific error reason when a tenant's connection is in an "error" state, if that reason is available (per `whatsapp-number-connection.md`).
- The system must display, per tenant, aggregated message volume metrics over selectable time windows (e.g., messages sent, messages received).
- The system must display, per tenant, aggregated error-rate metrics over selectable time windows (e.g., count/percentage of failed bot responses, failed message deliveries).
- The system must display, per tenant, aggregated response-time metrics over selectable time windows (e.g., average/typical time for the bot to respond to an end-customer message).
- The system must let the operator identify, without opening each tenant individually, which tenants currently have a non-"connected" connection state.
- The system must let the operator identify, without opening each tenant individually, which tenants have unusually elevated error rates or degraded response times relative to their own recent normal, or against a defined threshold.
- The system must let the operator sort or filter the multi-tenant view by connection state and by metric values (e.g., error rate, message volume).
- The system must never display, in any operator-facing monitoring view, any end-customer conversation transcript, message content, or conversation memory for any tenant.
- The system must ensure that any error diagnostics, logs, or drill-down detail shown to the operator are limited to operational/technical information (e.g., error codes, timestamps, retry counts) and exclude conversation content or free-text message excerpts.
- The system must keep the connection health state shown to the operator current enough to reflect a tenant's actual state without requiring a manual refresh initiated by the operator for basic viewing (state updates propagate to the view on their own).
- The system must make historical metrics for a tenant retrievable for a defined retention window, not only the current/live value.
- The system must scope the operator's monitoring access to cover all tenants on the platform; a tenant's monitoring data must not be omitted from the operator's view based on tenant size, plan, or activity level.
- The system must present metrics numerically/statistically (counts, rates, durations) only — never as derived text that could reconstruct or hint at conversation content.

## Acceptance Criteria
- Given the operator opens the monitoring dashboard, when the dashboard loads, then it lists every client tenant on the platform along with each tenant's current connection health state.
- Given a tenant's connection state changes (e.g., from "connected" to "error"), when the operator is viewing the dashboard, then the updated state is reflected in the dashboard without the operator needing to manually reload to see the change.
- Given a tenant is in "error" state with a known reason, when the operator views that tenant's detail, then the specific error reason is displayed.
- Given the operator selects a time window (e.g., last 24 hours, last 7 days) for a tenant, when the selection is applied, then message volume, error rate, and response time metrics for that tenant update to reflect that window.
- Given multiple tenants have varying connection states, when the operator filters the dashboard by "not connected," then only tenants whose state is connecting, reconnecting, error, or disconnected are shown.
- Given multiple tenants have varying error rates, when the operator sorts the dashboard by error rate, then tenants are ordered accordingly and the operator can identify the highest-error tenants at a glance.
- Given a tenant's historical metrics fall within the defined retention window, when the operator requests a past date range within that window, then the historical metrics for that range are retrievable and displayed.
- Given a tenant's historical metrics fall outside the defined retention window, when the operator requests a past date range beyond that window, then the system indicates the data is unavailable rather than silently showing incomplete or fabricated data.
- Given the operator is viewing any monitoring screen (dashboard, tenant detail, error diagnostics, logs), when the operator inspects any element on that screen, then no end-customer conversation transcript, message text, or conversation memory is visible or accessible from that screen.
- Given a new client tenant is onboarded, when onboarding completes and the tenant has any connection or usage activity, then that tenant appears in the operator's monitoring dashboard alongside all other tenants.
- Given a tenant generates zero traffic in a selected time window, when the operator views that tenant's metrics for that window, then the metrics display as zero/no-activity rather than being omitted or erroring.

## Out of Scope
- Proactive/push-style alerting or notification when a tenant's health or metrics cross a concerning threshold — see `operator-proactive-alerting.md`. This spec covers the operator checking a dashboard, not the platform pushing a notification to the operator.
- Definition and transition logic of the connection health states themselves (connected/disconnected/error/reconnecting/connecting) — see `whatsapp-number-connection.md`; this spec only displays those states.
- Any access to end-customer conversation transcripts, message content, or conversation memory by the operator — explicitly forbidden here; that access belongs only to the client that owns the data, per `client-conversation-visibility.md`.
- The client-facing view of a tenant's own connection status and metrics (as seen by the client themselves) — covered by `whatsapp-number-connection.md` and any client-facing metrics spec, not this operator-facing spec.
- Billing, cost-allocation, or plan-tier reporting derived from usage metrics — left to a future billing-specific spec.
- Operator actions taken in response to observed health/metrics (e.g., manually intervening in a tenant's connection, contacting a client) — this spec covers visibility only, not operator response workflows.
- Tenant onboarding/offboarding workflow mechanics — see `client-signup-and-tenancy.md` and `client-offboarding-and-data-retention.md`.
- Underlying data isolation guarantees that ensure operator visibility doesn't leak cross-tenant data — see `tenant-data-isolation.md`.

## Open Questions / Assumptions
- Assumed the exact metric list is: message volume, error rate, response time, plus connection health state and last-known-good timestamp; additional metrics (e.g., cost, active conversation count, handoff rate) were not specified in the interview and may need to be added later.
- Assumed a historical metrics retention window is required but its exact length (e.g., 30 days, 90 days) was not specified in the interview; left as an implementation-time decision.
- Assumed "unusually elevated" error rate / degraded response time detection in the dashboard is a passive visual/sortable signal (not a push notification, which belongs to `operator-proactive-alerting.md`) and that exact thresholds are an implementation-time decision.
- Assumed "current enough without manual refresh" means near-real-time propagation is desired but does not require a specific maximum latency bound; exact freshness guarantees are left open for a later phase.
- Assumed selectable time windows (e.g., 24h, 7d, 30d) are the right granularity for metrics review; exact preset options are left open for design.
- Assumed the multi-tenant list view and single-tenant detail view are both required outcomes of this spec, per the interview's mention of "per-client" status plus the need to support many tenants at once.
