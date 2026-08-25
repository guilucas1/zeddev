/**
 * Structured logging with redaction enforced at the logger boundary.
 *
 * Two specs make this a correctness requirement rather than a hygiene preference:
 *
 *   - `operator-health-monitoring.md` AC9: on any monitoring screen — dashboard,
 *     tenant detail, error diagnostics, *logs* — no end-customer transcript,
 *     message text, or conversation memory is visible or accessible.
 *   - `credential-and-secret-handling.md` AC5: no log, diagnostic record, error
 *     message, metric, alert, or notification contains a secret value.
 *   - `message-delivery-reliability.md` AC17 narrows it further: a failure record
 *     an operator inspects contains error codes, timestamps, and retry counts —
 *     and nothing else.
 *
 * The design follows from one observation: these are guarantees about what is
 * *absent*, and absence cannot be established by auditing call sites. There will
 * always be one more call site. So the boundary itself is built so that leaking is
 * not expressible.
 *
 * Three mechanisms, each closing a different escape route:
 *
 *  1. **No free-text channel.** A log call takes a dotted event name, not a
 *     message string. `log.info('webhook.received', {...})` has nowhere to
 *     interpolate a message body into. An event name that does not match the
 *     identifier grammar is replaced, so `log.info(\`got ${text}\`)` cannot leak
 *     either.
 *  2. **Allowlisted fields, not denylisted.** A denylist ("redact keys named
 *     `password`") fails open the first time a field is called `pw`, or `body`,
 *     or `text`. The allowlist fails closed: anything not named in
 *     `OPERATIONAL_FIELDS` is redacted, so a new field leaks nothing until
 *     someone deliberately adds it here.
 *  3. **Scalars only.** Even an allowlisted key redacts a non-scalar value.
 *     Nested objects are how a whole request payload arrives "just for
 *     debugging".
 *
 * Redacted fields are emitted as `[redacted]` rather than dropped, on purpose:
 * the attempt stays visible in the log so it can be found and corrected, while
 * the value never appears.
 */

import { createHash } from 'node:crypto';
import { isSecret } from '@zeddev/secrets';
import { toDiagnostic, type Diagnostic } from '@zeddev/errors';
import { SystemClock, type Clock } from '@zeddev/time';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const REDACTED = '[redacted]';

/**
 * The complete set of field names permitted in a log record.
 *
 * This is the single source of truth for "what may be logged", and it is
 * deliberately short. Every entry is operational: an identifier, a state name, a
 * count, a duration, or a classification. None of them can hold conversation
 * content or a credential.
 *
 * Adding a name here is the one place where the redaction guarantee is decided.
 * That is the point — it makes the decision reviewable in a diff instead of
 * distributed across hundreds of call sites.
 */
export const OPERATIONAL_FIELDS = new Set<string>([
  // Routing and identity. Note what is absent: no end-customer phone number and
  // no display name. `client-conversation-visibility.md` gives the *client* the
  // right to search their own conversations by end-customer identity, but the
  // operator-facing log is not that surface, so logs carry only an opaque ref.
  'tenantId',
  'conversationId',
  'messageId',
  'endCustomerRef',
  'principal',
  'principalType',
  'sessionId',
  'requestId',
  'traceId',
  'component',
  'service',
  'instanceId',

  // Message delivery and queueing.
  'externalId',
  'direction',
  'messageType',
  'mediaId',
  'attempt',
  'retryCount',
  'retryAfterMs',
  'queue',
  'jobId',
  'deduplicated',
  'acknowledged',

  // Connection lifecycle. `reason` carries the surfaced error reason that
  // `whatsapp-number-connection.md` AC6/AC12 require be visible; it holds an
  // upstream status description, never message content.
  'connectionState',
  'previousState',
  'connectionId',
  'phoneNumberRef',
  'reason',
  'lastKnownGoodAt',

  // Error classification, per the taxonomy in `@zeddev/errors`.
  'errorKind',
  'errorCode',
  'retryable',
  'statusCode',
  'issueCount',

  // Metrics. `operator-health-monitoring.md` requires these be numeric or
  // statistical only, never derived text that could hint at content.
  'durationMs',
  'latencyMs',
  'elapsedMs',
  'count',
  'bytes',
  'rate',
  'tokenCount',
  'windowMs',

  // Configuration and providers.
  'provider',
  'model',
  'configKey',
  'keyId',
  'secretClass',
  'secretRef',
  'version',

  // Outcomes and access control.
  'outcome',
  'action',
  'resource',
  'allowed',
  'boundTenantId',
  'requestedTenantId',
  'errorType',
  'invalidEvent',
]);

/** Values that may appear in a log record. Anything else is redacted. */
type Scalar = string | number | boolean | null;

export type LogFields = Record<string, unknown>;

export interface LogRecord {
  readonly at: string;
  readonly level: LogLevel;
  readonly event: string;
  readonly fields: Readonly<Record<string, Scalar>>;
  readonly error?: Diagnostic | undefined;
}

export interface LogSink {
  write(record: LogRecord): void;
}

/**
 * Event names must be dotted lowercase identifiers, e.g. `webhook.received`.
 *
 * This grammar is the mechanism that closes the free-text channel: no sentence
 * containing a customer's message can match it, so an interpolated string is
 * rejected structurally rather than by review.
 */
const EVENT_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;

function sanitizeEvent(event: string): { event: string; valid: boolean } {
  return EVENT_PATTERN.test(event) ? { event, valid: true } : { event: 'log.invalid_event', valid: false };
}

/**
 * Reduce one field value to a loggable scalar, or redact it.
 *
 * Order matters: `Secret` is checked before anything else, so a secret is
 * redacted even if it somehow arrives under an allowlisted key. Defence in
 * depth — the allowlist and the `Secret` wrapper each independently prevent the
 * leak, and neither relies on the other being correct.
 */
function sanitizeValue(value: unknown): Scalar {
  if (isSecret(value)) return REDACTED;
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : REDACTED;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  // Objects, arrays, functions, symbols. A nested structure is how an entire
  // payload arrives in a log line, so none of them survive.
  return REDACTED;
}

function sanitizeFields(fields: LogFields): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = OPERATIONAL_FIELDS.has(key) ? sanitizeValue(value) : REDACTED;
  }
  return out;
}

/** Writes newline-delimited JSON. The default sink in every deployment tier. */
export class JsonLinesSink implements LogSink {
  readonly #stream: { write(chunk: string): unknown };

  constructor(stream: { write(chunk: string): unknown } = process.stdout) {
    this.#stream = stream;
  }

  write(record: LogRecord): void {
    this.#stream.write(`${JSON.stringify(record)}\n`);
  }
}

/** Collects records in memory. For tests, and for asserting on what was *not* logged. */
export class MemorySink implements LogSink {
  readonly records: LogRecord[] = [];

  write(record: LogRecord): void {
    this.records.push(record);
  }

  /** Every record serialized — the form an assertion about leakage should use. */
  serialized(): string {
    return this.records.map((r) => JSON.stringify(r)).join('\n');
  }

  clear(): void {
    this.records.length = 0;
  }
}

/** Discards everything. Useful when a component under test needs a logger but not its output. */
export class NullSink implements LogSink {
  write(): void {
    // intentionally empty
  }
}

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly level?: LogLevel;
  readonly clock?: Clock;
  /** Fields merged into every record from this logger, sanitized on the way in. */
  readonly bindings?: LogFields;
}

export class Logger {
  readonly #sink: LogSink;
  readonly #level: LogLevel;
  readonly #clock: Clock;
  readonly #bindings: Readonly<Record<string, Scalar>>;

  constructor(options: LoggerOptions = {}) {
    this.#sink = options.sink ?? new JsonLinesSink();
    this.#level = options.level ?? 'info';
    this.#clock = options.clock ?? new SystemClock();
    // Bindings are sanitized once here rather than on every record. They are
    // frozen so a caller holding a reference cannot mutate them into a leak
    // after construction.
    this.#bindings = Object.freeze(sanitizeFields(options.bindings ?? {}));
  }

  /**
   * A logger carrying additional context.
   *
   * The child re-sanitizes: inherited bindings are already clean, but new ones
   * are not, and a child must not be a way around the boundary.
   */
  child(bindings: LogFields): Logger {
    return new Logger({
      sink: this.#sink,
      level: this.#level,
      clock: this.#clock,
      bindings: { ...this.#bindings, ...bindings },
    });
  }

  debug(event: string, fields: LogFields = {}): void {
    this.#log('debug', event, fields);
  }

  info(event: string, fields: LogFields = {}): void {
    this.#log('info', event, fields);
  }

  warn(event: string, fields: LogFields = {}): void {
    this.#log('warn', event, fields);
  }

  /**
   * Log a failure.
   *
   * The error is passed separately from the fields and rendered through
   * `toDiagnostic()`, which strips the human-readable message. That message is
   * the field most likely to have accumulated interpolated payload data, and it
   * is the one thing an error carries that the monitoring specs cannot permit.
   */
  error(event: string, error?: unknown, fields: LogFields = {}): void {
    this.#log('error', event, fields, error);
  }

  #log(level: LogLevel, event: string, fields: LogFields, error?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.#level]) return;

    const { event: safeEvent, valid } = sanitizeEvent(event);
    const diagnostic = error === undefined ? undefined : toDiagnostic(error);

    const merged: Record<string, Scalar> = {
      ...this.#bindings,
      ...sanitizeFields(fields),
      ...(valid ? {} : { invalidEvent: true }),
      ...(diagnostic === undefined
        ? {}
        : { errorKind: diagnostic.kind, errorCode: diagnostic.code, retryable: diagnostic.retryable }),
    };

    this.#sink.write({
      at: this.#clock.now().toISOString(),
      level,
      event: safeEvent,
      fields: merged,
      // The diagnostic's own context is already constrained to scalars by the
      // error taxonomy, and it is what `message-delivery-reliability.md` AC17
      // means by "error codes, timestamps, retry counts".
      error: diagnostic,
    });
  }
}

/**
 * A stable pseudonymous reference for an end customer, for use in logs.
 *
 * Derived per-tenant, so the same phone number under two tenants yields two
 * different refs. That is required, not incidental: a shared ref would let anyone
 * with access to logs correlate one end customer's activity across tenants, which
 * is precisely the cross-tenant inference `tenant-data-isolation.md` exists to
 * prevent.
 *
 * The tenant-scoped salt means this is a pseudonym, not an anonymisation — it is
 * intended to make logs *useful* without putting an end customer's phone number
 * on an operator's screen.
 */
export function endCustomerRef(tenantId: string, endCustomerIdentifier: string): string {
  return createHash('sha256').update(`${tenantId}:${endCustomerIdentifier}`).digest('hex').slice(0, 16);
}
