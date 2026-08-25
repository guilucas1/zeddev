/**
 * `@zeddev/identity` — who is acting, and what follows from that.
 *
 * This package is the concrete foundation `authentication-and-access.md` says
 * every other spec's "identity is already established" assumption needs. It owns
 * four things and deliberately nothing else:
 *
 *   - **Signup and tenant provisioning** (`client-signup-and-tenancy.md`), including
 *     the transactional guarantee that a failure never leaves a usable account
 *     pointing at a partial tenant.
 *   - **Two identity spaces that never overlap** — clients scoped to one tenant,
 *     the operator scoped platform-wide — kept apart by separate tables, separate
 *     token prefixes, and separate code paths rather than by a role column.
 *   - **Sessions**: issuance, the inactivity and absolute bounds, logout,
 *     invalidation on credential change, and the derivation of the tenant binding
 *     that `tenant-data-isolation.md` rests on.
 *   - **The access boundary**: a table mapping each action to the principal type
 *     that holds it, so that a new surface cannot grant what existing surfaces
 *     deny.
 *
 * What it does not own: HTTP, cookies, and mail delivery. The first two belong to
 * the API service. The third is a transport port that does not exist yet — signup
 * returns the verification token rather than sending it, and IMPLEMENTATION_PLAN.md
 * tracks the mail port as the follow-up that makes the loop closable end to end.
 */

export {
  IDENTITY_CONFIG_SCHEMA,
  loadIdentityPolicy,
  type IdentityConfig,
  type IdentityPolicy,
} from './config.ts';

export {
  assertBusinessName,
  assertEmail,
  assertPasswordStrength,
  emailLocalPart,
  normalizeEmail,
  passwordProblems,
  MAX_BUSINESS_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  type PasswordContext,
} from './credentials.ts';

export {
  claimedTokenKind,
  hashToken,
  hasTokenKind,
  mintToken,
  TOKEN_KINDS,
  TOKEN_PREFIXES,
  type MintedToken,
  type TokenKind,
} from './tokens.ts';

export {
  ACTION_PRINCIPALS,
  ACTIONS,
  actionPrincipalType,
  authorize,
  permits,
  principalId,
  PRINCIPAL_TYPES,
  requireClient,
  requireOperator,
  type Action,
  type ClientPrincipal,
  type OperatorPrincipal,
  type Principal,
  type PrincipalType,
} from './principals.ts';

export {
  ACCESS_PRINCIPAL_TYPES,
  DENIAL_REASONS,
  recordAccess,
  recordAccessOutOfBand,
  type AccessPrincipalType,
  type AccessRecordInput,
  type DenialReason,
} from './access.ts';

export {
  IdentityService,
  type ClientSessionIssued,
  type IdentityServiceOptions,
  type OperatorSessionIssued,
  type SignUpInput,
  type SignUpResult,
  type TenantProvisioning,
  type TokenIssued,
} from './service.ts';
