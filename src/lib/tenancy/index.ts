/**
 * The tenant identifier, and the one rule about its shape.
 *
 * This is four lines of regex in its own package, which needs justifying.
 *
 * The rule is load-bearing in two subsystems that must not depend on each other.
 * `@zeddev/db` needs it because `set_config` accepts any text: a malformed tenant
 * id is stored happily and only fails later at the `::uuid` cast inside a policy,
 * where the error is attributed to whichever query ran next rather than to the
 * caller that supplied it. `@zeddev/storage` needs it for a sharper reason — the
 * tenant id is a *path segment* in every object key, so a value containing `/`
 * or `..` does not merely fail, it silently relocates one tenant's object into
 * another tenant's namespace. That is `tenant-data-isolation.md`'s "even if
 * guessed, reused, or supplied out of context" failing in the one direction the
 * spec calls out.
 *
 * Two subsystems, one invariant, and a security guarantee that holds only if
 * both enforce it identically. Copying the regex is how they come to differ:
 * someone relaxes one to accept an uppercase variant, or a legacy id, and the
 * other keeps rejecting it — or worse, the other keeps accepting it. So it has
 * one home. `@zeddev/storage` must not depend on `@zeddev/db` (an object store
 * that drags in a PostgreSQL wire client is a component-independence violation
 * per `component-independence.md`), which is why the home is neither of them.
 */

import { ValidationError } from '@zeddev/errors';

/**
 * A tenant identifier.
 *
 * An alias rather than a branded type: branding would need a constructor at every
 * boundary, and the values arrive from the database as plain strings. The alias
 * documents intent at call sites; `assertTenantId` is what enforces it.
 */
export type TenantId = string;

/**
 * Case-insensitive because PostgreSQL renders `uuid` lowercase but callers may
 * hand back a value that passed through a system that uppercased it. Note that
 * the *storage key* built from a tenant id is therefore case-sensitive where the
 * id is not — see `normalizeTenantId`.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `value` is a well-formed tenant identifier. */
export function isTenantId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Reject anything that is not a tenant identifier, naming the offending key. */
export function assertTenantId(tenantId: string): void {
  if (!isTenantId(tenantId)) {
    throw new ValidationError([{ key: 'tenantId', reason: 'must be a UUID' }]);
  }
}

/**
 * The canonical form used anywhere a tenant id is compared as text.
 *
 * Object storage has no notion of case-insensitive keys, so `A1B2.../doc/x` and
 * `a1b2.../doc/x` are two different objects in the same bucket. A tenant whose id
 * reached the store in one case and is later looked up in the other would appear
 * to have lost its data — and, worse, `deleteTenant` would sweep only one of the
 * two prefixes, leaving data behind after
 * `client-offboarding-and-data-retention.md` promised it was unrecoverable. So
 * every key is built from the normalized form.
 */
export function normalizeTenantId(tenantId: string): TenantId {
  assertTenantId(tenantId);
  return tenantId.toLowerCase();
}
