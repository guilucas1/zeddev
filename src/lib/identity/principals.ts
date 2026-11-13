/**
 * Who is acting, and what each kind of principal is permitted to do.
 *
 * `authentication-and-access.md` states the access boundary in an unusually
 * specific way. It does not merely say the operator should not change a client's
 * bot activation state — it says the denial must be enforced "as an access-control
 * rule rather than merely the absence of a button in an interface" (AC16, AC17),
 * and that a transcript must be refused "through any surface, including a
 * diagnostic or support-tooling path" (AC15). Read together, those rule out the
 * usual arrangement where each route decides for itself: a rule scattered across
 * routes is a rule that a new route can silently omit, and the spec is explicit
 * that a *new surface* is exactly the thing that must not be able to grant what
 * the old ones deny.
 *
 * So permission is a table, here, and it is keyed by the action rather than by
 * the principal. Adding an action without deciding who may perform it is a type
 * error, not an oversight — which is the same technique `TENANT_SCOPED_TABLES`
 * uses to make a missing row-level-security policy a build failure rather than a
 * silent loss of isolation.
 *
 * ## Why the table maps action → principal type and not the reverse
 *
 * A `Record<PrincipalType, Action[]>` would express the same permissions and
 * would rot differently: the failure mode of a new action is that it appears in
 * neither list and is therefore denied to everyone, which looks like a bug and
 * gets "fixed" by adding it to both. Keying by action means a new action must
 * name its principal to compile, and there is exactly one place to look to answer
 * "who can do this?".
 *
 * ## What this module is not
 *
 * It is not tenant isolation. Isolation is enforced below the application by
 * row-level security (`@zeddev/db`'s tenant context), and nothing here weakens or
 * substitutes for it. This is the layer above: given that a caller is provably
 * acting as tenant X, may they perform *this* operation at all? An operator, for
 * whom no tenant binding exists, is refused here rather than at the database,
 * because the database cannot express "this row is visible but this verb is not".
 */

import { AuthorizationError } from '@zeddev/errors';
import type { TenantId } from '@zeddev/tenancy';

export const PRINCIPAL_TYPES = ['client', 'operator'] as const;
export type PrincipalType = (typeof PRINCIPAL_TYPES)[number];

/**
 * A client acting inside exactly one tenant.
 *
 * `tenantId` is present and non-optional because there is no such thing as a
 * client principal without one: `authentication-and-access.md` requires every
 * authenticated client session resolve "to exactly one tenant, with that tenant
 * binding established by the system from the authenticated identity itself".
 * Making the field optional would create a representable state — an
 * authenticated client with no tenant — that the spec says cannot exist, and
 * every consumer would then need a branch for it that could only ever be wrong.
 */
export interface ClientPrincipal {
  readonly type: 'client';
  readonly accountId: string;
  readonly tenantId: TenantId;
  readonly sessionId: string;
}

/**
 * The platform operator, scoped platform-wide.
 *
 * Note the absence of a tenant field, mirroring the absence of a `tenant_id`
 * column on the `operators` table. An operator has no tenant to be bound to, so
 * there is no value a bug could supply that would make operator code take a
 * client's path.
 */
export interface OperatorPrincipal {
  readonly type: 'operator';
  readonly operatorId: string;
  readonly sessionId: string;
}

export type Principal = ClientPrincipal | OperatorPrincipal;

/** The identifier recorded in an access record for this principal. */
export function principalId(principal: Principal): string {
  return principal.type === 'client' ? principal.accountId : principal.operatorId;
}

/**
 * Every action whose permission depends on principal type, and the type that
 * holds it.
 *
 * The client entries are not padding. Three of them —
 * `tenant.activation.change`, `tenant.offboard`, `tenant.delete` — exist
 * precisely so the operator's *lack* of them is stated somewhere a test can read,
 * per AC16 and AC17. Two more — `conversation.read`, `conversation.memory.read` —
 * are the surfaces AC15 names, and their being client-only is the access-control
 * half of the guarantee whose data half is the absence of a platform-scope policy
 * on any table holding conversation content.
 *
 * The operator entries are the complete list of what
 * `operator-health-monitoring.md` and `operator-proactive-alerting.md` grant, and
 * apart from AI provider verification they are all reads. There is no operator
 * action that writes tenant state,
 * because `tenant-data-isolation.md` gives the operator visibility and never
 * authority.
 */
export const ACTION_PRINCIPALS = {
  // Tenant configuration and lifecycle — the client's own, and only theirs.
  'tenant.configuration.read': 'client',
  'tenant.configuration.write': 'client',
  'tenant.activation.change': 'client',
  'tenant.offboard': 'client',
  'tenant.delete': 'client',
  'tenant.reactivate': 'client',
  'whatsapp.connection.manage': 'client',
  'knowledge.manage': 'client',

  // Conversation content. AC15: denied to the operator through every surface.
  'conversation.read': 'client',
  'conversation.memory.read': 'client',
  'conversation.memory.reset': 'client',
  'handoff.manage': 'client',

  // Account self-service.
  'account.password.change': 'client',
  'account.session.end': 'client',

  // Platform-wide, read-only, operator-only.
  'platform.health.read': 'operator',
  'platform.metrics.read': 'operator',
  'platform.notifications.read': 'operator',
  'platform.access_records.read': 'operator',
  // ai-provider-portability.md AC4. Not a read, but it touches no tenant: it puts a
  // made-up business to a provider. Its own action, apart from the health read,
  // because each use spends AI quota every tenant's conversations share.
  'platform.ai.verify': 'operator',
} as const;

export type Action = keyof typeof ACTION_PRINCIPALS;

/** Every action, sorted. Exposed so a test can assert the table is exhaustive. */
export const ACTIONS = Object.keys(ACTION_PRINCIPALS).sort() as readonly Action[];

/** Which principal type holds `action`. */
export function actionPrincipalType(action: Action): PrincipalType {
  return ACTION_PRINCIPALS[action];
}

/** Whether `principal` may perform `action`. Pure, so it is cheap to assert on. */
export function permits(principal: Principal, action: Action): boolean {
  return principal.type === ACTION_PRINCIPALS[action];
}

/**
 * Refuse `principal` if it may not perform `action`.
 *
 * Throws rather than returning a boolean, on purpose. A boolean permission check
 * fails open when someone forgets to branch on it — `checkPermission(...)` on its
 * own line reads as enforcement and does nothing. A throw cannot be ignored by
 * omission.
 *
 * The error carries the principal *type* and the action, never the principal's
 * identifier: `AuthorizationError`'s context reaches logs, and `principal` there
 * is a classification.
 */
export function authorize(principal: Principal, action: Action): void {
  if (!permits(principal, action)) {
    throw new AuthorizationError({ principal: principal.type, action });
  }
}

/** Narrow to a client principal, refusing an operator. Used at tenant-scoped entry points. */
export function requireClient(principal: Principal, action: Action): ClientPrincipal {
  authorize(principal, action);
  // Unreachable unless the action table says an operator may perform a
  // client-shaped action, which is a mistake in the table rather than at runtime.
  if (principal.type !== 'client') {
    throw new AuthorizationError({ principal: principal.type, action });
  }
  return principal;
}

/** Narrow to an operator principal, refusing a client. */
export function requireOperator(principal: Principal, action: Action): OperatorPrincipal {
  authorize(principal, action);
  if (principal.type !== 'operator') {
    throw new AuthorizationError({ principal: principal.type, action });
  }
  return principal;
}
