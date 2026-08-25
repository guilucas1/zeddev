# Client Signup and Tenancy

## Purpose

Enable a new client business to sign up for the platform entirely on their own and receive a dedicated, isolated tenant (account, configuration space, data space) with no involvement from the operator. This spec covers only account creation and tenant provisioning, not WhatsApp connection or go-live activation.

## Behavioral Requirements

- A prospective client must be able to create a new account without any manual step performed by the operator.
- The system must collect, at minimum, the information required to identify the client business and secure the account (e.g., business name, contact email, password or equivalent credential).
- The system must verify that the signup email address is valid and controlled by the signer before the account is treated as active.
- The system must reject signup attempts using an email address already associated with an existing account.
- The system must enforce a minimum credential strength standard at signup.
- Upon successful signup, the system must automatically provision a new tenant dedicated to that client business, with no operator action required.
- Each newly provisioned tenant must be created in a manner that guarantees isolation from every other client's tenant, per the guarantees defined in `tenant-data-isolation.md`.
- Tenant provisioning must complete (or visibly fail) within a bounded, predictable time after signup, without leaving the account in an indeterminate state.
- If tenant provisioning fails after account creation, the system must surface the failure to the client and must not leave the client with a usable account pointing at a broken or partial tenant.
- The system must prevent a client from accessing or referencing any tenant other than their own at any point during or after signup.
- The system must allow the client to log in to their account after signup using the credentials they set.
- The system must associate the signing user as the initial owner/administrator of the newly created tenant.
- The system must let the client identify their own business within the product (e.g., a tenant/business name) as part of or immediately following signup.
- The system must not require any operator-side approval, review, or manual gating step between signup submission and tenant availability.
- The system must prevent creation of a usable, isolated tenant for an account that has not completed email verification.
- The system must handle concurrent signups from different clients without cross-contaminating tenant data or configuration.
- The system must give the client a way to recover access (e.g., password reset) without operator involvement.

## Acceptance Criteria

- Given a prospective client with no existing account, when they complete the signup form with valid, unique information, then a new account is created and a dedicated tenant is provisioned without any operator interaction.
- Given a client has just signed up, when tenant provisioning completes, then the client can log in and land in a workspace scoped exclusively to their own tenant.
- Given a client submits signup with an email already tied to an existing account, when they submit, then the signup is rejected with a clear reason and no duplicate account or tenant is created.
- Given a client submits signup with a password/credential below the minimum strength standard, when they submit, then the signup is rejected and no account or tenant is created.
- Given a client has signed up but not yet verified their email, when they attempt to log in or use the product, then they are blocked from accessing a fully provisioned, isolated tenant until verification completes.
- Given a client completes email verification, when verification succeeds, then their tenant becomes accessible without any additional operator step.
- Given tenant provisioning fails for any reason after account creation, when the failure occurs, then the client is shown an error state and is not granted access to a partial or broken tenant, and no other client's tenant is affected.
- Given two different clients sign up at effectively the same time, when both complete signup, then each ends up with their own distinct, correctly isolated tenant containing no data or configuration from the other.
- Given a client is logged into their tenant, when they attempt to view, reference, or act on another tenant's data or configuration through any product surface, then the action is denied.
- Given a client has signed up and verified, when they inspect their account, then they are identified as the owner/administrator of their tenant.
- Given a client forgets their password, when they use the account recovery flow, then they regain access to their existing tenant without operator involvement and without creating a second tenant.

## Out of Scope

- Connecting a client's WhatsApp number to their tenant/bot — covered in the WhatsApp connection spec.
- The exhaustive isolation guarantees and mechanisms for tenant data, conversation history, and configuration — covered in `tenant-data-isolation.md`. This spec only requires that a new tenant is created in a manner consistent with those guarantees.
- Marking onboarding as complete and turning the bot live for end-customers — covered in `bot-activation-control.md`.
- Client offboarding, account closure, and data retention/deletion — covered in `client-offboarding-and-data-retention.md`; signup is the mirror-image starting point of that lifecycle but this spec does not duplicate its details.
- Operator ability to suspend or deactivate a client's account/bot — not required in v1; not covered here.
- Billing, payment collection, and subscription plan selection during signup.
- Multi-user access within a single client's tenant (inviting teammates, roles beyond the initial owner) beyond establishing the initial owner/administrator.
- Any operator-facing admin console or operator-initiated tenant creation flow.

## Open Questions / Assumptions

- Assumed signup requires only business name, email, and password (or equivalent) as minimum viable fields; additional business details (industry, size, etc.) are assumed optional/deferred to later configuration, not signup itself.
- Assumed "bounded, predictable time" for provisioning does not need a specific numeric SLA in this spec; an exact threshold (e.g., seconds vs. minutes) is left open for implementation/design phase.
- Assumed each client business maps to exactly one tenant at signup (no multi-tenant-per-client or tenant-switching concept in v1).
- Assumed email/password is the credential mechanism; if social/SSO login is desired, this spec would need revision.
- Assumed there is no CAPTCHA/anti-abuse requirement specified explicitly, but flagged as a likely necessary control against automated/spam signups — left as an open question for the interview owner to confirm scope.
- Assumed "minimum credential strength standard" does not need exact rules defined here (e.g., character count, complexity) — left to implementation phase.
