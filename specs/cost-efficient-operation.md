# Cost-Efficient Operation

## Purpose
The platform must be operable at zero or near-zero ongoing cost while a client tenant's usage/volume is low, and any cost growth must track real usage/client volume rather than being front-loaded — so the solo operator can onboard early clients without committing to fixed costs before revenue or usage justifies them.

## Behavioral Requirements
- The system must be operable, end-to-end (bot conversations, hosting, storage), using only free-tier or no-cost AI usage and free-tier or no-cost hosting resources when overall platform usage/client volume is low.
- The system must not require the operator to commit to a paid hosting plan, reserved capacity, or a minimum-spend AI provider commitment in order to onboard the platform's first client tenant(s).
- The system must allow the operator to run and support multiple client tenants simultaneously within free-tier or near-zero-cost resource limits, up to whatever ceiling those free/lowest-cost tiers impose.
- The system's resource consumption (AI usage, hosting compute/storage/bandwidth) must scale with actual conversation/message volume rather than being provisioned or charged at a fixed rate independent of usage.
- The system must not require any tenant-independent fixed-cost infrastructure to exist merely to support the possibility of future tenants; infrastructure costs must be attributable to onboarded, active usage.
- The system must remain functional (not degrade in core chatbot behavior for end-customers) while operating within free-tier or lowest-cost-tier constraints at low volume.
- The system must support moving to a paid tier or higher-cost resource only as a deliberate, cost-increasing step taken because usage/volume has grown, not as an unavoidable default.
- The system's cost profile must be describable, at any point in the platform's operation, in terms that correlate observed usage/client volume to expected cost — i.e., cost growth must be explainable by usage growth, not by fixed baseline charges.

## Acceptance Criteria
- Given the platform has zero or one active client tenant with low message volume, when the operator reviews what the platform is running on, then all AI usage and hosting resources in use are available at no cost (free tier) at that volume.
- Given the platform is running entirely on free-tier or no-cost resources, when a new client tenant is onboarded within the remaining capacity of those free tiers, then no paid plan, reserved capacity, or minimum spend is required to complete that onboarding.
- Given client volume/usage grows over time, when the operator compares platform cost at a higher-volume point against an earlier lower-volume point, then cost has increased in a way attributable to the increased usage/volume, not to a fixed cost that was already being paid regardless of usage.
- Given the platform is operating at low volume within free-tier limits, when end-customers interact with the bot through any onboarded tenant, then the bot responds normally with no degradation in core conversational behavior attributable to operating on free/lowest-cost tiers.
- Given usage/volume approaches or exceeds a free-tier or lowest-cost-tier limit, when the operator takes action to increase capacity, then that action is a deliberate, visible step (e.g., opting into a paid tier) rather than something the system silently forces before that point is reached.
- Given the operator has not onboarded any client tenant yet, when the operator examines ongoing platform costs, then no meaningful fixed cost is being incurred solely to keep the platform available for future onboarding.

## Out of Scope
- Per-client AI usage/cost caps or enforcement mechanisms (e.g., blocking or throttling a tenant that exceeds a usage threshold) — explicitly excluded from v1 by design decision. The operator will only be able to monitor aggregate usage/metrics per client (see `operator-health-monitoring.md`), not enforce limits. This exclusion is deliberate, not an oversight, and is expected to be revisited in a future spec once real usage patterns from live clients are known.
- The specific mechanism, dashboard, or metrics by which the operator observes usage/cost-relevant activity per client — see `operator-health-monitoring.md`; this spec concerns the cost-consciousness outcome itself, not monitoring UI/mechanics.
- The architectural mechanism that makes it possible to swap AI providers to chase lower cost or better free tiers — see `ai-provider-portability.md`; this spec concerns the resulting cost outcome, not the swappability mechanism.
- The architectural mechanism that makes it possible to move hosting environments to chase lower cost or better free tiers — see `environment-portability.md`; this spec concerns the resulting cost outcome, not the portability mechanism.
- Billing the operator's own clients, pricing plans, or revenue model — this spec is about the operator's own infrastructure/AI cost exposure, not client-facing pricing.
- Proactive alerting when cost or usage approaches a concerning level — see `operator-proactive-alerting.md` if such alerting is in scope there; this spec does not define alert delivery.
- Specific numeric free-tier limits, provider names, or hosting platforms — implementation detail left open for a later phase.

## Open Questions / Assumptions
- Assumed "near-zero ongoing cost" at low volume means $0 is achievable but not strictly guaranteed in all cases (e.g., a minimal fixed cost like a domain or number registration may be unavoidable outside the system's control); such non-platform costs are treated as out of scope for this spec.
- Assumed "low usage/client volume" is intentionally left unquantified here (no specific tenant count or message volume threshold was given in the interview); exact free-tier ceilings are an implementation-time decision dependent on which providers/hosts are ultimately chosen.
- Assumed the requirement to avoid fixed costs applies specifically to costs proportional to tenant capacity/idle readiness, not to genuinely one-time setup costs (e.g., a one-time domain purchase) — those are treated as outside this spec's concern.
- Assumed "cost should scale with usage" implies acceptable step-function scaling (e.g., crossing a free-tier boundary triggers a new paid tier) rather than requiring perfectly linear/continuous cost-to-usage correlation; exact scaling shape is left open.
- Assumed this spec does not require the system to automatically select the cheapest available provider/tier on its own — that decision is assumed to remain a deliberate operator action, consistent with `ai-provider-portability.md` and `environment-portability.md` providing the swappability rather than automating provider selection.
