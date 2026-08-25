/**
 * Typed error taxonomy.
 *
 * Why this exists as a shared library rather than per-service error classes:
 * several specs hinge on *telling error classes apart*, not merely on reporting
 * that something failed.
 *
 *   - `whatsapp-number-connection.md` draws its `reconnecting` vs `error` state
 *     boundary on whether a failure is plausibly recoverable. That is the
 *     transient/terminal distinction, so it must be a property of the error
 *     itself and not a judgement call re-made at each call site.
 *   - `message-delivery-reliability.md` AC9 requires that a send failure meaning
 *     "authorization revoked" drive a *connection state transition*, not just a
 *     per-message failure record. That demands a distinguishable error class.
 *   - `fallback-response-behavior.md` applies when the bot could not produce an
 *     answer, but NOT when delivery failed. Conflating the two sends fallback
 *     text down a broken pipe, or stays silent when the customer deserves a reply.
 *
 * Every error also carries an operator-safe diagnostic form. `operator-health-
 * monitoring.md` AC9 and `message-delivery-reliability.md` AC17 both require that
 * operator-visible failure records contain operational information only —
 * error codes, timestamps, retry counts — and never message content.
 */

/**
 * The stable, closed vocabulary of failure kinds.
 *
 * Closed deliberately: adding a kind should be a considered act, because each
 * kind is a branch some spec-mandated behavior keys off. A catch-all kind would
 * quietly re-merge the distinctions this module exists to preserve.
 */
export const ERROR_KINDS = [
  'configuration',
  'tenant_access',
  'authentication',
  'authorization',
  'validation',
  'not_found',
  'conflict',
  'transient_transport',
  'terminal_transport',
  'connection_revoked',
  'ai_generation',
  'media_retrieval',
  'outside_service_window',
  'duplicate',
  'internal',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * Operational context permitted on an error.
 *
 * Typed as scalars only, on purpose. A nested object is where a message body,
 * a transcript, or a whole request payload gets attached "just for debugging",
 * and that is precisely the leak the monitoring specs forbid. Callers that want
 * to attach richer data must reduce it to a scalar first, which makes the
 * decision explicit rather than accidental.
 */
export type ErrorContext = Readonly<Record<string, string | number | boolean | null>>;

/** An operator-safe rendering of a failure. Contains no free text from a conversation. */
export interface Diagnostic {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly retryable: boolean;
  readonly context: ErrorContext;
  readonly cause?: Diagnostic | undefined;
}

export interface ZedErrorOptions {
  /** Machine-readable specific code, e.g. `config.missing`. Namespaced by convention. */
  readonly code: string;
  /** Operational scalars only — never conversation content, never secret values. */
  readonly context?: ErrorContext;
  readonly cause?: unknown;
}

/**
 * Base class for every error the platform raises deliberately.
 *
 * `retryable` is declared by the subclass rather than passed in, so that whether
 * a failure may be retried is a property of its *type*. Letting each throw site
 * choose would reintroduce the inconsistency this taxonomy removes.
 */
export abstract class ZedError extends Error {
  abstract readonly kind: ErrorKind;
  abstract readonly retryable: boolean;

  readonly code: string;
  readonly context: ErrorContext;

  constructor(message: string, options: ZedErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.context = Object.freeze({ ...(options.context ?? {}) });
  }

  /**
   * Render this error for an operator-visible surface or a log line.
   *
   * Note what is absent: `message`. The human-readable message is the one field
   * on an Error that tends to accumulate interpolated payload data over time
   * ("failed to send: <the message text>"). Excluding it from the diagnostic
   * means an operator surface built on `toDiagnostic()` cannot leak content even
   * if a future call site is careless with the message string.
   */
  toDiagnostic(): Diagnostic {
    const causeDiagnostic = this.cause instanceof ZedError ? this.cause.toDiagnostic() : undefined;
    return {
      kind: this.kind,
      code: this.code,
      retryable: this.retryable,
      context: this.context,
      cause: causeDiagnostic,
    };
  }

  toJSON(): Diagnostic {
    return this.toDiagnostic();
  }
}

/** A single problem with one configuration key. */
export interface ConfigIssue {
  readonly key: string;
  readonly reason: string;
}

/**
 * Configuration is missing or invalid.
 *
 * Carries *every* issue rather than the first. `environment-portability.md` AC7
 * requires a clear error identifying the missing/invalid configuration, and
 * `credential-and-secret-handling.md` AC2 the same for secrets. Reporting one key
 * at a time turns bringing the system up on a new tier into a guess-and-restart
 * loop, which is the manual, tribal-knowledge onboarding the portability spec
 * explicitly forbids.
 */
export class ConfigurationError extends ZedError {
  override readonly kind = 'configuration' as const;
  override readonly retryable = false;
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], options?: { readonly cause?: unknown }) {
    const sorted = [...issues].sort((a, b) => a.key.localeCompare(b.key));
    const detail = sorted.map((i) => `  - ${i.key}: ${i.reason}`).join('\n');
    super(
      `Invalid configuration (${sorted.length} problem${sorted.length === 1 ? '' : 's'}):\n${detail}`,
      {
        code: 'config.invalid',
        context: { issueCount: sorted.length },
        ...(options?.cause === undefined ? {} : { cause: options.cause }),
      },
    );
    this.issues = Object.freeze(sorted);
  }

  /** The offending keys, sorted. Useful for asserting on in tests. */
  get keys(): readonly string[] {
    return this.issues.map((i) => i.key);
  }
}

/**
 * An operation attempted to reach data belonging to a tenant other than the one
 * bound to the caller's identity.
 *
 * `tenant-data-isolation.md` AC9 requires that an identifier belonging to tenant
 * A be refused in a context authenticated as tenant B. This error is what that
 * refusal looks like; the `requestedTenantId`/`boundTenantId` pair is retained
 * because a cross-tenant attempt is a security event worth being able to audit.
 */
export class TenantAccessError extends ZedError {
  override readonly kind = 'tenant_access' as const;
  override readonly retryable = false;

  constructor(details: {
    readonly boundTenantId: string;
    readonly requestedTenantId?: string | undefined;
    readonly resource?: string | undefined;
  }) {
    super('Access denied: resource does not belong to the authenticated tenant', {
      code: 'tenant.access_denied',
      context: {
        boundTenantId: details.boundTenantId,
        requestedTenantId: details.requestedTenantId ?? null,
        resource: details.resource ?? null,
      },
    });
  }
}

/**
 * Authentication failed.
 *
 * Carries no indication of *why*. `authentication-and-access.md` AC3 and AC9
 * require that a login or recovery attempt for a non-existent account be
 * indistinguishable from one for an existing account. Encoding the reason here
 * would make it available to leak, so the distinction is simply never made.
 */
export class AuthenticationError extends ZedError {
  override readonly kind = 'authentication' as const;
  override readonly retryable = false;

  constructor(options?: { readonly context?: ErrorContext }) {
    super('Authentication failed', {
      code: 'auth.failed',
      ...(options?.context === undefined ? {} : { context: options.context }),
    });
  }
}

/**
 * The caller is authenticated but not permitted to perform this action.
 *
 * `authentication-and-access.md` AC15-AC17 and AC21-AC22 require these be
 * enforced as access-control rules rather than absent UI controls: an operator
 * must be refused a conversation transcript, refused a bot activation change,
 * and refused a tenant deletion, and each principal type's session must be
 * refused at the other's surfaces.
 */
export class AuthorizationError extends ZedError {
  override readonly kind = 'authorization' as const;
  override readonly retryable = false;

  constructor(details: { readonly principal: string; readonly action: string }) {
    super('Not permitted', {
      code: 'auth.forbidden',
      context: { principal: details.principal, action: details.action },
    });
  }
}

/** Caller-supplied input failed validation. Carries per-field reasons, never field values. */
export class ValidationError extends ZedError {
  override readonly kind = 'validation' as const;
  override readonly retryable = false;
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[]) {
    const sorted = [...issues].sort((a, b) => a.key.localeCompare(b.key));
    super(`Validation failed: ${sorted.map((i) => `${i.key} (${i.reason})`).join(', ')}`, {
      code: 'validation.failed',
      context: { issueCount: sorted.length },
    });
    this.issues = Object.freeze(sorted);
  }
}

export class NotFoundError extends ZedError {
  override readonly kind = 'not_found' as const;
  override readonly retryable = false;

  constructor(resource: string, options?: { readonly context?: ErrorContext }) {
    super(`Not found: ${resource}`, {
      code: 'resource.not_found',
      context: { resource, ...(options?.context ?? {}) },
    });
  }
}

export class ConflictError extends ZedError {
  override readonly kind = 'conflict' as const;
  override readonly retryable = false;

  constructor(message: string, options: ZedErrorOptions) {
    super(message, options);
  }
}

/**
 * A transport failure that may plausibly succeed on retry.
 *
 * This is the error class that drives `whatsapp-number-connection.md`'s
 * `reconnecting` state and `message-delivery-reliability.md` AC7's retry
 * allowance. `retryAfterMs` is carried so a server-supplied backoff hint
 * (a rate-limit response, say) survives to the retry scheduler rather than
 * being replaced by a guess.
 */
export class TransientTransportError extends ZedError {
  override readonly kind = 'transient_transport' as const;
  override readonly retryable = true;
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: ZedErrorOptions & { readonly retryAfterMs?: number | undefined },
  ) {
    super(message, options);
    this.retryAfterMs = options.retryAfterMs;
  }

  override toDiagnostic(): Diagnostic {
    return {
      ...super.toDiagnostic(),
      context: { ...this.context, retryAfterMs: this.retryAfterMs ?? null },
    };
  }
}

/**
 * A transport failure that will not succeed on retry.
 *
 * Retrying these is not merely wasteful — under `cost-efficient-operation.md`
 * it spends free-tier allowance on calls that cannot succeed, and it delays the
 * transition to `error` that `whatsapp-number-connection.md` AC6 requires once
 * recovery attempts are exhausted.
 */
export class TerminalTransportError extends ZedError {
  override readonly kind = 'terminal_transport' as const;
  override readonly retryable = false;

  constructor(message: string, options: ZedErrorOptions) {
    super(message, options);
  }
}

/**
 * The connection's authorization has been revoked upstream.
 *
 * Deliberately NOT a subclass of TerminalTransportError. `message-delivery-
 * reliability.md` AC9 requires this specific condition drive a connection state
 * transition rather than only a per-message failure record, and
 * `credential-and-secret-handling.md` AC11 requires the tenant's connection state
 * and reason reflect the revocation instead of an opaque failure. A subclass
 * would be swallowed by an `instanceof TerminalTransportError` handler written
 * before this distinction mattered, silently losing the state transition.
 */
export class ConnectionRevokedError extends ZedError {
  override readonly kind = 'connection_revoked' as const;
  override readonly retryable = false;

  constructor(details: {
    readonly tenantId: string;
    readonly reason: string;
    readonly cause?: unknown;
  }) {
    super('WhatsApp connection authorization has been revoked', {
      code: 'connection.revoked',
      context: { tenantId: details.tenantId, reason: details.reason },
      ...(details.cause === undefined ? {} : { cause: details.cause }),
    });
  }
}

/**
 * The AI provider failed to produce a reply.
 *
 * Distinct from every transport error because `fallback-response-behavior.md`
 * triggers on this and not on a delivery failure. Marked retryable: a provider
 * timeout or rate-limit is usually worth one more attempt before falling back.
 */
export class AiGenerationError extends ZedError {
  override readonly kind = 'ai_generation' as const;
  override readonly retryable = true;

  constructor(
    message: string,
    options: ZedErrorOptions & { readonly provider?: string | undefined },
  ) {
    super(message, {
      ...options,
      context: { ...(options.context ?? {}), provider: options.provider ?? null },
    });
  }
}

/**
 * Media referenced by an inbound message could not be retrieved.
 *
 * `message-delivery-reliability.md` AC14/AC15 give media retrieval its own retry
 * allowance and route exhaustion to fallback rather than leaving the message
 * unprocessed — so it needs to be distinguishable from a generic transport error.
 */
export class MediaRetrievalError extends ZedError {
  override readonly kind = 'media_retrieval' as const;
  override readonly retryable = true;

  constructor(options: {
    readonly mediaId: string;
    readonly retryCount: number;
    readonly cause?: unknown;
  }) {
    super('Failed to retrieve media referenced by an inbound message', {
      code: 'media.retrieval_failed',
      context: { mediaId: options.mediaId, retryCount: options.retryCount },
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/**
 * A reply would fall outside WhatsApp's 24-hour customer service window.
 *
 * `message-delivery-reliability.md` AC10 requires this be detected and recorded
 * rather than silently failing. What the platform then *does* — drop the reply or
 * send an approved template — is an unresolved product decision tracked in
 * IMPLEMENTATION_PLAN.md section 4; this error exists so the condition is
 * representable and recordable regardless of which way that decision goes.
 */
export class OutsideServiceWindowError extends ZedError {
  override readonly kind = 'outside_service_window' as const;
  override readonly retryable = false;

  constructor(details: { readonly tenantId: string; readonly hoursSinceLastInbound: number }) {
    super('Reply falls outside the 24-hour customer service window', {
      code: 'delivery.outside_service_window',
      context: {
        tenantId: details.tenantId,
        hoursSinceLastInbound: details.hoursSinceLastInbound,
      },
    });
  }
}

/**
 * An inbound notification has already been processed.
 *
 * `message-delivery-reliability.md` AC4 requires a redelivered notification not
 * be stored again and not produce a second reply. This is a *signal*, not a
 * failure — the correct handling is to acknowledge and stop.
 */
export class DuplicateError extends ZedError {
  override readonly kind = 'duplicate' as const;
  override readonly retryable = false;

  constructor(details: { readonly resource: string; readonly externalId: string }) {
    super('Already processed', {
      code: 'delivery.duplicate',
      context: { resource: details.resource, externalId: details.externalId },
    });
  }
}

/** An unexpected internal failure. Retryable, since the cause is by definition unknown. */
export class InternalError extends ZedError {
  override readonly kind = 'internal' as const;
  override readonly retryable = true;

  constructor(message: string, options?: Partial<ZedErrorOptions>) {
    super(message, { ...options, code: options?.code ?? 'internal.error' });
  }
}

/**
 * A defect in this codebase: the operation is malformed and cannot succeed.
 *
 * Shares the `internal` kind with `InternalError` but inverts `retryable`, and
 * that inversion is the entire reason it exists. `InternalError` is retryable
 * because an unknown cause might clear; a *known* programming defect — a SQL
 * syntax error, a reference to a table that does not exist, a call with the wrong
 * arity — will produce the identical failure on every attempt. Retrying it burns
 * the free-tier allowance `cost-efficient-operation.md` assumes stays unspent and
 * delays surfacing the bug.
 *
 * Kept as a distinct class rather than a `retryable` constructor argument because
 * the taxonomy's central invariant is that whether a failure may be retried is a
 * property of its *type*. Letting a throw site choose is what produced the
 * inconsistency this module exists to remove.
 */
export class DefectError extends ZedError {
  override readonly kind = 'internal' as const;
  override readonly retryable = false;

  constructor(message: string, options?: Partial<ZedErrorOptions>) {
    super(message, { ...options, code: options?.code ?? 'internal.defect' });
  }
}

/**
 * Whether a failure may be retried.
 *
 * Unknown errors — anything not from this taxonomy — are treated as NOT
 * retryable. Failing closed matters here: an unrecognised error retried against
 * a paid or rate-limited API burns allowance that `cost-efficient-operation.md`
 * assumes stays within the free tier, and it delays the `error` transition that
 * surfaces the problem to the operator.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof ZedError ? error.retryable : false;
}

/**
 * Coerce any thrown value into an operator-safe diagnostic.
 *
 * Non-ZedError values contribute only their constructor name. Their `message`
 * is discarded on purpose: a third-party library's error message is exactly the
 * kind of string that can embed a request body, and `operator-health-
 * monitoring.md` AC9 does not carve out an exception for errors the platform
 * did not author.
 */
export function toDiagnostic(error: unknown): Diagnostic {
  if (error instanceof ZedError) return error.toDiagnostic();
  const name = error instanceof Error ? error.constructor.name : typeof error;
  return {
    kind: 'internal',
    code: 'internal.unclassified',
    retryable: false,
    context: { errorType: name },
  };
}
