# Authentication and Access

## Purpose

Establish how the platform verifies who is acting — a client business's owner/administrator or the platform operator — before granting access to any tenant-scoped or platform-wide surface, and define the access boundaries that follow from each identity, so that every other spec's assumption of "identity is already established" has a concrete foundation.

## Behavioral Requirements

- The system must recognize exactly two distinct principal types, the CLIENT (an owner/administrator user of a single client business, scoped to exactly one tenant) and the OPERATOR (the solo platform operator, scoped platform-wide), and must treat their identities as two separate spaces that never overlap.
- The system must never allow an operator credential to authenticate as, or be treated as equivalent to, a client identity, and must never allow a client credential to grant operator-level access, under any circumstance.
- The system must allow a client to authenticate using the credentials established at signup per `client-signup-and-tenancy.md`.
- The system must prevent an account that has not completed email verification (per `client-signup-and-tenancy.md`) from authenticating into a usable tenant, even if the correct credentials are supplied.
- The system must respond to a failed client authentication attempt in a way that does not reveal whether the supplied email is associated with an existing account.
- The system must resolve every authenticated client session to exactly one tenant, with that tenant binding established by the system from the authenticated identity itself, never accepted from a tenant identifier, parameter, or assertion supplied by the caller.
- The system must treat the tenant binding produced by client authentication as the precondition that the guarantees in `tenant-data-isolation.md` depend on; nothing downstream may substitute a caller-supplied tenant reference for it.
- The system must expire a client's session after a defined period of inactivity and must also expire it after a defined absolute lifetime regardless of activity.
- The system must allow a client to explicitly log out, and logging out must immediately end that session's ability to access the tenant.
- The system must provide a self-service password reset for clients that requires no operator involvement, consistent with the recovery capability required by `client-signup-and-tenancy.md`.
- The system must respond to a password recovery request for an email that has no associated account in a way that does not reveal that the account does not exist.
- The system must invalidate a client's existing sessions whenever that client completes a password reset or a password change.
- The system must make any recovery link or code single-use and must expire it after a defined period.
- The system must throttle or temporarily lock out further authentication attempts against an account, or from a source, after a defined number of consecutive failed attempts, as a control-plane defense against credential guessing.
- The system must treat this login-attempt throttling as distinct from, and must not rely on, the end-customer message rate-limiting that is deferred out of v1 (see `text-conversation-handling.md` scope) — the two protect different surfaces and one does not substitute for the other.
- The system must require the operator to authenticate before reaching any operator-facing surface described in `operator-health-monitoring.md`, including the notification history described in `operator-proactive-alerting.md`.
- The system must deny unauthenticated access to any operator-facing surface, returning no tenant health data, aggregated metrics, or notification history to an unauthenticated caller.
- The system must allow an authenticated operator to read per-tenant connection health and aggregated metrics across all tenants, consistent with `operator-health-monitoring.md`.
- The system must deny an authenticated operator access to any end-customer conversation transcript, message content, or conversation memory through any path, including any general-purpose, diagnostic, or support-tooling surface, not only the primary monitoring dashboard, consistent with `tenant-data-isolation.md` and `client-conversation-visibility.md`.
- The system must enforce, as an access-control rule rather than merely the absence of a button in an interface, that the operator has no ability to change a client's bot activation state, per `bot-activation-control.md`.
- The system must enforce, as an access-control rule rather than merely the absence of a button in an interface, that the operator has no ability to offboard or delete a client's tenant, per `client-offboarding-and-data-retention.md`.
- The system must record authentication and authorization decisions (who authenticated, what identity resulted, what resource or surface was accessed or denied, and when) in sufficient detail to answer who accessed what and when.
- The system must exclude conversation content from those authentication/authorization records, consistent with the operator's exclusion from conversation content everywhere else in the platform.
- The system must prevent a tenant's credentials from authenticating once that tenant's data has been permanently deleted per `client-offboarding-and-data-retention.md`.
- The system must continue to allow a client to authenticate during the retention window that precedes permanent deletion, so that the client may reactivate their tenant within that window.

## Acceptance Criteria

- Given a client with verified email and correct credentials, when they log in, then they land in a session scoped exclusively to their own tenant.
- Given a client whose email has not been verified, when they attempt to log in with correct credentials, then they are denied access to a usable tenant.
- Given a login attempt with an email that has no associated account and one with an email that does, when both attempts fail, then the response given to the caller is indistinguishable between the two cases.
- Given an authenticated client session, when any request within that session is processed, then the tenant it acts on is the one bound to that session by the system, and no tenant identifier supplied by the caller is honored in its place.
- Given a client session that has been idle beyond the defined inactivity period, when the client next makes a request, then the session is no longer valid and re-authentication is required.
- Given a client session that has existed beyond the defined absolute lifetime, when the client next makes a request, then the session is no longer valid even if the client has been continuously active.
- Given a client logged into an active session, when the client logs out, then that session can no longer be used to access the tenant, including from any other device or tab where it was open.
- Given a client requests a password reset for their own registered email, when they complete the reset flow, then their password is changed and every existing session for that account is invalidated.
- Given a password recovery request for an email with no associated account, when the request is submitted, then the system responds as it would for a registered email, without indicating the account does not exist.
- Given a recovery link or code that has already been used once, when it is presented again, then it is rejected.
- Given a recovery link or code older than its defined expiry period, when it is presented, then it is rejected as expired.
- Given repeated failed login attempts against a single account or from a single source beyond the defined threshold, when the next attempt is made, then the system throttles or temporarily locks out further attempts rather than continuing to evaluate credentials at full rate.
- Given an unauthenticated caller, when they request any operator-facing monitoring or notification-history surface, then access is denied and no tenant or notification data is returned.
- Given an authenticated operator, when they view the monitoring dashboard or notification history, then they can see per-tenant connection health and aggregated metrics across all tenants.
- Given an authenticated operator, when they attempt to retrieve an end-customer conversation transcript, message content, or conversation memory through any surface, including a diagnostic or support-tooling path, then the request is denied.
- Given an authenticated operator, when they attempt to change a client's bot activation state through any surface or direct request, then the action is denied regardless of whether an interface control exists for it.
- Given an authenticated operator, when they attempt to offboard or delete a client's tenant through any surface or direct request, then the action is denied regardless of whether an interface control exists for it.
- Given any authentication or authorization event, when the operator or an auditor later reviews the access records, then they can determine who accessed what and when, and the records contain no conversation content.
- Given a tenant whose data has been permanently deleted per `client-offboarding-and-data-retention.md`, when someone attempts to authenticate with that tenant's former client credentials, then authentication fails.
- Given a tenant within its retention window after offboarding but before permanent deletion, when the client authenticates with their existing credentials, then authentication succeeds and they can proceed to reactivate the tenant.
- Given a valid client session token or credential, when it is presented to any operator-facing surface, then it is rejected as insufficient for operator access.
- Given a valid operator session token or credential, when it is presented to any client tenant-scoped surface, then it is rejected as insufficient for client access.

## Out of Scope

- What a principal may do with tenant data once identity is established, and the isolation guarantees themselves — see `tenant-data-isolation.md`; this spec covers only how identity is established and the access boundaries that follow from it.
- Account creation, email verification mechanics, and initial credential setup at signup — see `client-signup-and-tenancy.md`; this spec covers authenticating with credentials already established there.
- Multi-user access within a single tenant, teammate invitations, and any role beyond the initial owner/administrator — not in v1, consistent with `client-signup-and-tenancy.md`.
- Social login or single sign-on as an authentication mechanism — not addressed in v1.
- Multi-factor authentication for either principal type — not decided here; flagged under Open Questions.
- End-customer identity and authentication — end-customers are identified by their WhatsApp number and never authenticate to this platform; see `text-conversation-handling.md` and `whatsapp-number-connection.md`.
- End-customer message rate limiting on the conversation path — deferred out of v1; distinct from the control-plane login-attempt throttling required in this spec.
- The client-facing display of conversation transcripts and health/usage data once access is granted — see `client-conversation-visibility.md` and `operator-health-monitoring.md`.
- Client or operator ability to change bot activation state or perform offboarding — see `bot-activation-control.md` and `client-offboarding-and-data-retention.md`; this spec only restates that the operator is denied those actions as an access-control matter.

## Open Questions / Assumptions

- Assumed exact session inactivity timeout and absolute session lifetime values are left open; a bound of each kind must be defined at implementation time.
- Assumed exact failed-login lockout threshold and lockout/throttle duration are left open; specific numbers must be defined at implementation time.
- Whether multi-factor authentication is required for the operator is a genuine open question, not assumed either way here; because the operator identity is platform-wide and spans every tenant, it is the single highest-value credential in the system and this should be revisited before launch.
- Whether the operator authenticates through the same login surface as clients (with a distinct outcome) or through an entirely separate surface is left open, provided the two identity spaces remain strictly separate regardless of which is chosen.
- Assumed a single operator identity for v1, consistent with `tenant-data-isolation.md`'s assumption that additional platform-side staff roles, if introduced later, would require re-evaluation of these access boundaries.
- Assumed recovery link/code expiry duration is left as an implementation-time decision, with no specific numeric value prescribed here.
- Assumed the exact retention window during which a client may still authenticate to reactivate an offboarded tenant is defined by `client-offboarding-and-data-retention.md`, not by this spec.
