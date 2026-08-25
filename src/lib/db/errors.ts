/**
 * Map PostgreSQL server errors onto the platform error taxonomy.
 *
 * Two requirements shape this module, and they pull in the same direction.
 *
 * **The taxonomy is closed.** `@zeddev/errors` documents that adding an error
 * kind should be a considered act, because each kind is a branch some spec-
 * mandated behavior keys off. So there is no `DatabaseError`: a database failure
 * is always *already* one of the existing kinds. A deadlock is a transient
 * transport failure and should be retried; a unique violation is a conflict and
 * should be reported to the client; a row-level-security refusal is a tenant
 * access violation and is a security event. Inventing a `DatabaseError` would
 * merge all three into one branch, and the first caller to write
 * `catch (e) { if (e instanceof DatabaseError) retry() }` would retry a unique
 * violation forever.
 *
 * **The server's error text is untrusted.** PostgreSQL's `message` and `detail`
 * fields quote the offending data: a unique violation reads
 * `Key (email)=(...) already exists`, a check violation quotes the failing row,
 * and a foreign-key violation quotes the key. Under
 * `operator-health-monitoring.md` AC9 and `credential-and-secret-handling.md`
 * AC5, none of that may reach an operator-visible diagnostic. So the mapping
 * carries the SQLSTATE, the constraint name, the table name, and nothing else.
 * Everything the server wrote in prose is dropped at this boundary rather than
 * further downstream, because downstream is where someone eventually logs it.
 */

import {
  ConfigurationError,
  ConflictError,
  DefectError,
  InternalError,
  TenantAccessError,
  TransientTransportError,
  ValidationError,
  type ZedError,
} from '@zeddev/errors';

/** The subset of an ErrorResponse that is safe to keep. */
export interface PostgresFailure {
  readonly sqlstate: string;
  readonly severity: string;
  /** Schema metadata, not row data — safe to surface. */
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly routine: string | undefined;
}

/** Extract the non-sensitive fields of an ErrorResponse. Drops `M`, `D`, `H`. */
export function toPostgresFailure(fields: Readonly<Record<string, string>>): PostgresFailure {
  return {
    sqlstate: fields['C'] ?? '',
    severity: fields['S'] ?? fields['V'] ?? 'ERROR',
    constraint: fields['n'],
    table: fields['t'],
    column: fields['c'],
    routine: fields['R'],
  };
}

/**
 * SQLSTATE codes that mean "this may work if you try again".
 *
 * Enumerated by class where the whole class qualifies:
 *   - `08` connection exception — the connection died mid-statement.
 *   - `40` transaction rollback — serialization failure, deadlock detected.
 *   - `53` insufficient resources — out of connections, disk, or memory.
 *   - `57` operator intervention — admin shutdown, statement cancelled.
 *
 * `55P03` (lock not available) is called out individually because class `55`
 * otherwise contains `55006` (object in use), which will not clear on its own.
 */
const RETRYABLE_CLASSES = new Set(['08', '40', '53', '57']);
const RETRYABLE_CODES = new Set(['55P03', '55006']);

/**
 * SQLSTATE codes that mean the *deployment* is misconfigured, not that a request
 * was bad. These must surface as configuration errors so that a bad
 * `DATABASE_*` value produces the diagnosable startup failure
 * `environment-portability.md` AC7 requires, rather than looking like a
 * transient blip that retries forever.
 */
const CONFIGURATION_CLASSES = new Set(['28', '3D', '3F']);

/** `42501` is emitted both for a missing GRANT and for a row-level-security refusal. */
const INSUFFICIENT_PRIVILEGE = '42501';

/**
 * Constraint-violation codes that mean the caller's data was wrong.
 *
 * `23505` (unique violation) is deliberately excluded and mapped to a conflict:
 * `client-signup-and-tenancy.md` AC3 requires a duplicate email be rejected
 * "with a clear reason", and a conflict is a different thing for a caller to act
 * on than a malformed field.
 */
const VALIDATION_CODES = new Set([
  '23502', // not null violation
  '23503', // foreign key violation
  '23514', // check violation
  '23P01', // exclusion violation
  '22001', // string data right truncation
  '22003', // numeric value out of range
  '22007', // invalid datetime format
  '22P02', // invalid text representation
  '22023', // invalid parameter value
]);

export interface FailureContext {
  /**
   * The tenant bound to the session when the failure occurred, if any.
   *
   * Supplied by the connection rather than inferred, so that a row-level-security
   * refusal can be reported as the specific cross-tenant access violation
   * `tenant-data-isolation.md` AC9 describes, complete with which tenant context
   * the attempt was made from. Without it the violation degrades into a generic
   * permissions error, which is exactly the audit trail that spec needs to exist.
   */
  readonly boundTenantId?: string | undefined;
}

/**
 * Translate a server failure into the platform taxonomy.
 *
 * Note that nothing here reads the server's `message`. The returned error's own
 * message is written by this module from the SQLSTATE alone, so it is safe to
 * print anywhere — which is what makes the guarantee hold even when a future
 * caller does the careless thing.
 */
export function mapPostgresFailure(failure: PostgresFailure, context: FailureContext = {}): ZedError {
  const { sqlstate } = failure;
  const sqlClass = sqlstate.slice(0, 2);
  const scalars = {
    sqlstate,
    constraint: failure.constraint ?? null,
    table: failure.table ?? null,
    column: failure.column ?? null,
  };

  if (RETRYABLE_CLASSES.has(sqlClass) || RETRYABLE_CODES.has(sqlstate)) {
    return new TransientTransportError(`Database operation failed transiently (SQLSTATE ${sqlstate})`, {
      code: `db.${sqlstate}`,
      context: scalars,
    });
  }

  if (CONFIGURATION_CLASSES.has(sqlClass)) {
    return new ConfigurationError([
      {
        key: 'DATABASE_*',
        reason: `the database rejected the connection or the target database does not exist (SQLSTATE ${sqlstate})`,
      },
    ]);
  }

  if (sqlstate === INSUFFICIENT_PRIVILEGE) {
    return new TenantAccessError({
      boundTenantId: context.boundTenantId ?? 'none',
      resource: failure.table ?? 'unknown',
    });
  }

  if (sqlstate === '23505') {
    return new ConflictError('A uniqueness constraint was violated', {
      code: `db.${sqlstate}`,
      context: scalars,
    });
  }

  if (VALIDATION_CODES.has(sqlstate)) {
    return new ValidationError([
      { key: failure.column ?? failure.constraint ?? 'row', reason: `rejected by the database (SQLSTATE ${sqlstate})` },
    ]);
  }

  // Class 42 is "syntax error or access rule violation" — an undefined table, a
  // malformed statement, a function called with the wrong arity. Every one of
  // them is a defect in this codebase that will fail identically on every
  // attempt, so it must be non-retryable. Class 25 is "invalid transaction
  // state", which likewise means this code got the transaction sequencing wrong.
  if (sqlClass === '42' || sqlClass === '25') {
    return new DefectError(`Malformed database operation (SQLSTATE ${sqlstate})`, {
      code: `db.${sqlstate}`,
      context: scalars,
    });
  }

  // Genuinely unrecognised. `InternalError` is retryable, which is the right
  // default when the cause is unknown: one more attempt is cheap, and the
  // alternative is failing a request that a blip would have let through.
  return new InternalError(`Unhandled database failure (SQLSTATE ${sqlstate})`, {
    code: `db.${sqlstate === '' ? 'unknown' : sqlstate}`,
    context: scalars,
  });
}
