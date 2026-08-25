# Credential and Secret Handling

## Purpose
Define how the platform protects every secret it holds — per-tenant WhatsApp credentials, client and operator authentication credentials, and the platform's own AI provider and infrastructure credentials — from disclosure, misuse, and cross-tenant exposure, at rest, in transit through the system's own surfaces, and across rotation, revocation, and deletion.

## Behavioral Requirements
- The system must recognize and protect the following classes of secret: each tenant's WhatsApp Business Cloud API access credentials; client account authentication credentials; the operator's own authentication credentials; AI provider credentials held at the platform level; and any credentials the platform itself depends on for its storage or infrastructure dependencies.
- The system must never embed a secret in source code or in any build artifact; every secret must be supplied to the running system as external configuration, consistent with `environment-portability.md`.
- A secret must never be committed to version control.
- The system must fail to start with a clear, diagnosable error when a required secret is absent, rather than starting in a degraded or insecure state, mirroring how `environment-portability.md` words its startup-failure requirement.
- The system must store client account authentication credentials only in a form from which the original cannot be recovered, such that possession of the stored form alone does not allow authentication as that client.
- The system must protect per-tenant WhatsApp credentials and AI provider credentials at rest such that reading the underlying stored data alone is insufficient to use them, since these secrets must remain usable by the system and therefore cannot be irreversibly transformed the way authentication credentials can.
- The system must never write a secret to any log, diagnostic record, error message, metric, alert, or notification, including those produced by `operator-health-monitoring.md` and `operator-proactive-alerting.md`; where a secret must be referenced for support purposes, it must be identified by a non-sensitive reference or a redacted form rather than its value.
- The system must never return a secret to a client through any product surface after it has been supplied; a client may see that a credential is configured and when it was configured, but never its value.
- The system must ensure no tenant's secret is readable by, usable by, or inferable from any other tenant's context, and that no tenant's stored credential is usable to act on another tenant's behalf even if the stored form is obtained out of context, restating `tenant-data-isolation.md` at the credential level.
- The system must allow a tenant's WhatsApp credentials to be replaced without downtime for other tenants and without requiring redeployment, consistent with the disconnect and replace flows in `whatsapp-number-connection.md`.
- The system must allow the platform's AI provider credentials to be replaced without code changes, consistent with `ai-provider-portability.md`.
- The system must ensure a revoked or superseded credential stops working immediately and does not remain usable from any cached copy.
- The system must surface a tenant's WhatsApp credentials being revoked on Meta's side through the connection state and reason vocabulary defined in `whatsapp-number-connection.md`, rather than failing opaquely.
- The system must destroy all of a tenant's secrets, along with that tenant's other data, when the tenant is permanently deleted per `client-offboarding-and-data-retention.md`, and those secrets must not survive in any cached, backed-up, or archived copy, mirroring that spec's assumption that backups are purged on the same schedule.
- The system must limit access to any secret to only the components that actually need it to function.
- The system must prevent the operator from reading any tenant's WhatsApp credential value through any operator-facing surface, consistent with `authentication-and-access.md` and `tenant-data-isolation.md`.
- The system must record any access to or change of a secret in a way that identifies who, what, and when, without recording the secret's value.
- The system must satisfy its at-rest and in-use protection requirements on all three environment tiers named in `environment-portability.md` — a personal computer, a low-cost VPS, and a managed cloud provider — using only configuration differences, and must not depend on a capability available on only one tier.

## Acceptance Criteria
- Given the system's source code or any build artifact, when it is inspected for secrets, then no WhatsApp credential, client credential, operator credential, AI provider credential, or infrastructure credential is found embedded in it.
- Given a required secret is missing from the environment's configuration, when the system attempts to start, then it fails with a clear error identifying the missing secret rather than starting in a partially functional or insecure state.
- Given a client account authentication credential has been stored, when the stored form is inspected in isolation, then the original credential cannot be recovered from it and it cannot be used directly to authenticate as that client.
- Given a tenant's WhatsApp credential or the platform's AI provider credential has been stored, when the underlying stored data is read without the system's protection mechanism, then the value obtained is insufficient to use that credential.
- Given any log, diagnostic record, error message, metric, alert, or notification produced by the system, when it is inspected, then it contains no secret value, using a non-sensitive reference or redacted form wherever a secret must be identified.
- Given a client whose credential (e.g., a connected WhatsApp number's underlying access token) has been configured, when the client views their own configuration through any product surface, then they see that the credential is configured and when, but never its value.
- Given two tenants A and B, when tenant A's stored credential is obtained out of context, then it cannot be used to read, send, or act on tenant B's behalf, and no operation performed in tenant B's context can read or use tenant A's credential.
- Given a tenant's WhatsApp credential needs to be replaced, when the replacement is performed, then it completes without downtime for any other tenant and without a redeployment of the system.
- Given the platform's AI provider credential needs to be replaced, when the replacement is performed, then it takes effect without any code change.
- Given a credential is revoked or superseded, when any subsequent operation attempts to use the old value, including from a cached copy, then that operation fails.
- Given a tenant's WhatsApp credentials are revoked on Meta's side, when the platform next attempts to use the connection, then the tenant's connection state and reason reflect that revocation per the vocabulary in `whatsapp-number-connection.md`, rather than an opaque or generic failure.
- Given a tenant is permanently deleted per `client-offboarding-and-data-retention.md`, when the deletion process completes, then none of that tenant's secrets remain retrievable from live storage, caches, backups, or archives.
- Given the operator uses any operator-facing surface, when the operator attempts to view a tenant's WhatsApp credential value, then no such value is displayed or retrievable.
- Given a secret is accessed or changed, when that event is later reviewed, then a record exists identifying who performed it, what secret class was involved, and when it occurred, and that record contains no secret value.
- Given the system is deployed on the personal computer, low-cost VPS, and managed cloud provider tiers described in `environment-portability.md`, when its secret protection behavior is compared across the three, then the same protection outcomes hold on each, differing only by configuration.

## Out of Scope
- Who may authenticate to the system and what a session or role grants once authenticated — see `authentication-and-access.md`.
- The isolation guarantees between tenants generally, beyond the credential-specific restatement here — see `tenant-data-isolation.md`.
- The WhatsApp connection lifecycle, state vocabulary, and self-service connect/disconnect/replace flows themselves — see `whatsapp-number-connection.md`.
- Which AI provider is selected or how provider switching is performed functionally — see `ai-provider-portability.md`.
- End-customer conversation content, which is sensitive but is not a credential and is governed by `tenant-data-isolation.md` and `client-conversation-visibility.md`.
- Verifying the authenticity of inbound webhook notifications — see `message-delivery-reliability.md`; the shared secret that enables that verification is itself in scope of this spec as a class of credential requiring protection.
- General infrastructure and network hardening, penetration testing, and compliance certification.

## Open Questions / Assumptions
- Whether periodic proactive rotation of long-lived credentials is required in v1, or whether on-demand revocation alone is sufficient, is left open; if proactive rotation is required, the rotation interval is left to be defined at implementation time.
- The exact mechanism satisfying at-rest protection on each environment tier is left open, per `environment-portability.md`'s stance that specific technical means are an implementation-phase decision.
- Whether the protection boundary must defend against an attacker who has obtained the running host itself, or only against disclosure of stored data at rest, needs a product decision, since it materially changes what is required of any protection mechanism.
- How long secret-access records are retained is left open.
- Assumed a single operator identity for v1, consistent with `tenant-data-isolation.md`; if additional platform-side staff roles are introduced later, their access to secrets should be re-evaluated.
- Meeting these protection requirements at zero cost on the free or low-cost tiers relevant to `cost-efficient-operation.md` is a real constraint on the eventual choice of mechanism, since a managed cloud provider may offer a dedicated secret-management capability that a personal computer or low-cost VPS does not.
