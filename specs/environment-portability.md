# Environment Portability

## Purpose
The exact same system must be able to run, unmodified, on the operator's personal computer, on a low-cost VPS, and on a more advanced managed cloud provider, at different points in the product's lifecycle. Moving the system between these environments must be achievable through configuration changes alone, never through code changes or environment-specific code paths.

## Behavioral Requirements
- The system must start up and become fully functional on the operator's personal computer, given only environment-appropriate configuration values.
- The system must start up and become fully functional on a low-cost VPS, given only environment-appropriate configuration values.
- The system must start up and become fully functional on a more advanced managed cloud provider, given only environment-appropriate configuration values.
- The system's codebase must be identical (byte-for-byte, same build artifact or same source) across all three target environments; no environment-specific fork, branch, or variant of the codebase may exist.
- The system must not contain logic that branches its behavior based on detecting which environment tier it is running on (e.g., no "if running on a personal computer, do X; if running in the cloud, do Y").
- The system must expose a complete, documented set of configuration inputs sufficient to account for every behavioral difference needed to run on a given environment (e.g., resource limits, external network addresses, credentials, storage locations).
- The system must treat every environment-specific value (e.g., external addresses, credentials, resource limits, storage locations) as an externally supplied configuration input, never as a value embedded in the code.
- The system must apply the same startup sequence, same functional behavior, and same feature set regardless of which of the three environment tiers it is deployed to, once given correct configuration for that environment.
- The system must be movable from one environment tier to another (e.g., personal computer to VPS, VPS to managed cloud) without requiring a code change, a code rebuild for a different target, or a new code release.
- The system must fail with a clear, diagnosable configuration error when required configuration for the target environment is missing or invalid, rather than silently falling back to incorrect behavior or partially starting.
- The system must not require manual, undocumented, or tribal-knowledge steps to run on any of the three environment tiers beyond supplying the documented configuration inputs.
- The system must support all multi-tenant functionality (serving multiple client businesses concurrently) identically across all three environment tiers, subject only to the resource capacity of the tier in use.
- The system must allow configuration for a given environment to be produced, reviewed, and validated without executing or modifying application code.

## Acceptance Criteria
- Given the unmodified codebase and a documented set of configuration values appropriate for the operator's personal computer, when the system is started on the operator's personal computer, then the system becomes fully functional (able to onboard/operate at least one tenant end-to-end) without any code edit.
- Given the unmodified codebase and a documented set of configuration values appropriate for a low-cost VPS, when the system is started on that VPS, then the system becomes fully functional without any code edit.
- Given the unmodified codebase and a documented set of configuration values appropriate for a managed cloud provider, when the system is started on that provider, then the system becomes fully functional without any code edit.
- Given a system instance already running on one environment tier, when the operator prepares to move it to a different environment tier, then the only required changes are to configuration values; no source file, build step targeting a specific environment, or conditional code path is touched.
- Given the system's source code, when it is inspected for environment-detection branching (e.g., "if environment == X"), then no such branching affecting functional behavior is found.
- Given the documented list of configuration inputs, when each input is reviewed, then it is sufficient by itself to explain every observed behavioral difference between two deployments of the system on different environment tiers.
- Given a required configuration value is missing or invalid for the target environment, when the system attempts to start, then it reports a clear error identifying the missing/invalid configuration rather than starting in a broken or partially functional state.
- Given the system is running correctly on any one of the three environment tiers, when an operator inspects its externally observable behavior (features available, tenant operations supported, API/interaction surface), then that behavior is indistinguishable from the same system running on either of the other two tiers, aside from differences explainable purely by configured resource limits or capacity.
- Given multiple client tenants are configured on a running instance, when that instance is on any of the three environment tiers, then all tenants' bot functionality operates identically, limited only by the resource capacity of that tier.

## Out of Scope
- Whether individual components of the system can be deployed, scaled, or updated independently of one another — see `component-independence.md`.
- The cost-consciousness rationale and cost-related acceptance criteria for operating across the personal computer / VPS / managed cloud environments — see `cost-efficient-operation.md`.
- Naming, selecting, or evaluating specific hosting providers, VPS vendors, or cloud platforms — intentionally excluded; this spec is environment-agnostic by design.
- The specific mechanism, format, or tooling used to supply configuration (e.g., files, environment variables, a secrets manager) — left open for a later implementation phase.
- Tenant onboarding workflow mechanics — see `client-signup-and-tenancy.md`.
- Data isolation guarantees between tenants — see `tenant-data-isolation.md`.
- Operator-facing monitoring of tenant health once running — see `operator-health-monitoring.md`.
- Performance/scaling behavior under load beyond what a given tier's resource capacity allows — not addressed here.

## Open Questions / Assumptions
- Assumed "fully functional" means capable of onboarding and operating at least one client tenant end-to-end (WhatsApp connection through bot response), consistent with other specs' definitions of core functionality; an exact minimum feature checklist per environment was not specified in the interview.
- Assumed the three environment tiers are fixed as: (a) operator's personal computer, (b) low-cost VPS, (c) managed cloud provider, per the interview; no additional or intermediate tiers are in scope.
- Assumed "configuration changes only" excludes rebuilding/recompiling with different build-time flags targeted at a specific environment; a single build artifact or source tree must serve all tiers. This was not explicitly confirmed in the interview but follows from "no code changes."
- Assumed resource-limit differences between tiers (e.g., lower concurrency on a personal computer) are an acceptable and expected configuration-driven difference, not a violation of behavioral equivalence, as reflected in the acceptance criteria's "aside from differences explainable purely by configured resource limits or capacity" carve-out.
- Assumed this spec covers the system's own portability requirement only, not the operator's manual effort/runbook for performing a migration between tiers; migration procedure documentation is treated as an implementation detail, not a behavioral requirement.
