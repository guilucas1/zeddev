/**
 * The WhatsApp Business Cloud API port.
 *
 * `whatsapp-number-connection.md` names the Cloud API as "the sole integration
 * path for sending and receiving messages", so unlike the AI provider this port
 * has no second vendor to be portable across. It exists for a different reason:
 * every acceptance criterion in that spec is about what happens when Meta answers
 * something other than success — a revoked token, an unverified business, a rate
 * limit — and none of those can be provoked against the real API on demand. A
 * port with an in-memory fake and a wire-level stub is the only way those paths
 * are ever exercised.
 *
 * ## What the operations are for
 *
 * The set is deliberately small and is exactly what the connection flow and the
 * outbound sender need:
 *
 *   - `describeNumber` — proves the token is valid *and* scoped to this number,
 *     and yields the display number the client sees on their own status screen.
 *   - `describeBusinessAccount` — the only place Meta-side business verification
 *     is observable, which AC9 requires be surfaced as a distinct condition.
 *   - `subscribeApp` / `listSubscribedApps` / `unsubscribeApp` — the platform-side
 *     authorization step AC4 requires the client be guided through, and its
 *     reversal. Subscribing is what makes Meta deliver this number's messages to
 *     the platform's webhook at all, so it is the receive half of "able to send
 *     and receive".
 *   - `sendText` — the send half, and later the outbound sender's whole job.
 *
 * ## Why failures are classified here and not at the call site
 *
 * `ConnectionErrorReason` is the vocabulary the client's status screen, the
 * operator dashboard, and alerting all read. Deriving it from a Meta error code
 * is a decoding decision, and decoding belongs next to the wire format. If each
 * caller mapped codes itself, "authorization revoked" would mean one thing on the
 * connect path and another on the send path, and the state machine's guarantees
 * would be only as good as the least careful mapping.
 */

import { TerminalTransportError, TransientTransportError, ValidationError, type ErrorContext } from '@zeddev/errors';
import type { Secret } from '@zeddev/secrets';
import { ERROR_REASON_DESCRIPTIONS, type ConnectionErrorReason } from './connection.ts';

/**
 * What one tenant's number is reached with.
 *
 * The token is a `Secret`, so it cannot reach a log line even if an adapter
 * interpolates its credentials into a diagnostic — `credential-and-secret-
 * handling.md` AC5. The two ids are not secrets and are deliberately plain: they
 * identify the number in operator diagnostics.
 */
export interface CloudCredentials {
  readonly accessToken: Secret<string>;
  /** Meta's id for the phone number — the same value inbound notifications carry. */
  readonly phoneNumberId: string;
  /** Meta's id for the WhatsApp Business Account the number belongs to. */
  readonly businessAccountId: string;
}

export interface NumberProfile {
  readonly phoneNumberId: string;
  /** The number as Meta renders it for display, e.g. "+55 11 5555-0100". */
  readonly displayNumber: string;
  /** The business name Meta shows next to the number. */
  readonly verifiedName: string;
  /** Meta's quality rating, lowercased: `green` | `yellow` | `red` | `unknown`. */
  readonly qualityRating: string;
  /** Whether the number itself completed Meta's verification, lowercased. */
  readonly numberVerification: string;
}

export interface BusinessAccountProfile {
  readonly businessAccountId: string;
  readonly name: string;
  /**
   * The owning business's Meta verification status, lowercased, or `unknown` when
   * Meta did not return one. `unknown` is not treated as failure: AC9 asks for the
   * condition to be surfaced "to the extent that reason is available", and
   * inventing a blocking condition from a missing field would strand a client who
   * has done nothing wrong.
   */
  readonly verificationStatus: string;
  /** The account's review status, lowercased, or `unknown`. */
  readonly reviewStatus: string;
}

export interface SentMessage {
  /** Meta's id for the message, the same form inbound notifications use. */
  readonly messageId: string;
}

export interface CloudDescriptor {
  /** The API root in use, for operator diagnostics. Never a credential. */
  readonly baseUrl: string;
  /** The platform's Meta app id — what `listSubscribedApps` is checked against. */
  readonly appId: string;
}

export interface WhatsAppCloud {
  readonly descriptor: CloudDescriptor;
  describeNumber(credentials: CloudCredentials): Promise<NumberProfile>;
  describeBusinessAccount(credentials: CloudCredentials): Promise<BusinessAccountProfile>;
  /** Subscribe the platform's app to this account's webhooks. Idempotent. */
  subscribeApp(credentials: CloudCredentials): Promise<void>;
  /** The app ids Meta currently delivers this account's notifications to. */
  listSubscribedApps(credentials: CloudCredentials): Promise<readonly string[]>;
  /** Stop Meta delivering this account's notifications to the platform. Idempotent. */
  unsubscribeApp(credentials: CloudCredentials): Promise<void>;
  sendText(credentials: CloudCredentials, message: { readonly to: string; readonly body: string }): Promise<SentMessage>;
}

/**
 * Meta's error codes, grouped by the connection state they justify.
 *
 * Every code the platform acts on is listed here rather than tested for inline,
 * so "what does Meta code 131042 mean to us?" has one answer that a test can
 * assert over the whole table.
 */
export const CLOUD_ERROR_CODES: Readonly<Record<ConnectionErrorReason | 'transient', readonly number[]>> = {
  // An expired, revoked, or wrong-app token, and the permission errors that mean
  // the client removed the platform's access on Meta's side.
  authorization_revoked: [10, 102, 190, 200, 299, 463, 467],
  // Meta blocks messaging until the business is verified or its appeal resolves.
  // Distinct from every technical failure because no retry resolves it (AC9).
  business_verification_required: [131031, 131042],
  // Throughput, not correctness: the same call succeeds later untouched.
  rate_limited: [4, 80007, 130429, 131048, 131056],
  // The credentials are usable but describe something that cannot send: a number
  // not registered with the Cloud API, a bad parameter, an unknown object id.
  configuration_invalid: [33, 100, 133005, 133006, 133010],
  // The number stopped being reachable on Meta's side.
  number_disconnected: [131021, 131026],
  // Meta's own trouble. Retried, never recorded as the tenant's fault.
  transient: [1, 2, 131000, 133004],
  // Not produced by a Meta code: these are the platform's own verdicts, reached
  // when a probe answers successfully but with the wrong answer, or when
  // automatic recovery gives up.
  verification_failed: [],
  recovery_exhausted: [],
};

const REASON_BY_CODE = new Map<number, ConnectionErrorReason | 'transient'>(
  Object.entries(CLOUD_ERROR_CODES).flatMap(([reason, codes]) =>
    codes.map((code) => [code, reason as ConnectionErrorReason | 'transient'] as const),
  ),
);

/**
 * What a Meta failure means for the tenant's connection.
 *
 * HTTP status is the fallback, not the primary signal: the Graph API answers many
 * distinct conditions with 400, and the body's `error.code` is what tells them
 * apart. A status of 429 or 5xx with no recognised code is transient, because
 * those are the two statuses whose meaning does not depend on the body.
 */
export function classifyCloudFailure(input: {
  readonly status: number;
  readonly code: number | undefined;
  readonly subcode: number | undefined;
}): ConnectionErrorReason | 'transient' {
  const byCode = input.code === undefined ? undefined : REASON_BY_CODE.get(input.code);
  if (byCode !== undefined) return byCode;
  const bySubcode = input.subcode === undefined ? undefined : REASON_BY_CODE.get(input.subcode);
  if (bySubcode !== undefined) return bySubcode;
  if (input.status === 429 || input.status >= 500) return 'transient';
  if (input.status === 401 || input.status === 403) return 'authorization_revoked';
  return 'configuration_invalid';
}

/** The key under which every cloud failure carries its connection reason. */
const REASON_FIELD = 'connectionReason';

/**
 * Raise the right error for a classified cloud failure.
 *
 * Transient failures become `TransientTransportError` (retryable) and everything
 * else `TerminalTransportError`, so `isRetryable` keeps working for callers that
 * do not care *why*. The reason travels in the error context rather than in a
 * bespoke error class because `ErrorContext` is scalars-only, which is exactly
 * the guarantee wanted here: no Meta message text — which quotes the request back,
 * and so could quote a token — can ride along with it.
 */
/**
 * The classified reasons a retry can still fix.
 *
 * `rate_limited` sits here as well as in the connection vocabulary, and the
 * distinction matters twice: the error must be *retryable* so the queue tries
 * again, and the connection must move to `reconnecting` rather than `error` —
 * `whatsapp-number-connection.md` asks for automatic recovery "where the
 * underlying cause is plausibly transient", and a throughput limit that lifts on
 * its own is the clearest case there is. Classifying it as terminal would take a
 * healthy tenant's bot off the air over a limit that expired a minute later.
 */
export const CLOUD_RECOVERABLE_REASONS: ReadonlySet<ConnectionErrorReason | 'transient'> = new Set([
  'transient',
  'rate_limited',
]);

export function cloudFailure(
  operation: string,
  input: {
    readonly status: number;
    readonly code: number | undefined;
    readonly subcode: number | undefined;
    readonly retryAfterMs?: number | undefined;
    readonly cause?: unknown;
  },
): TransientTransportError | TerminalTransportError {
  const reason = classifyCloudFailure(input);
  const context: ErrorContext = {
    operation,
    status: input.status,
    metaCode: input.code ?? null,
    [REASON_FIELD]: reason,
  };
  if (CLOUD_RECOVERABLE_REASONS.has(reason)) {
    return new TransientTransportError(`WhatsApp Cloud API ${operation} failed and may succeed on retry.`, {
      code: 'whatsapp.cloud.transient',
      context,
      ...(input.retryAfterMs === undefined ? {} : { retryAfterMs: input.retryAfterMs }),
      ...(input.cause === undefined ? {} : { cause: input.cause }),
    });
  }
  return new TerminalTransportError(`WhatsApp Cloud API ${operation} failed and will not succeed on retry.`, {
    code: 'whatsapp.cloud.rejected',
    context,
    ...(input.cause === undefined ? {} : { cause: input.cause }),
  });
}

/**
 * Read the connection reason back off an error raised by this port.
 *
 * Returns `undefined` for anything else, so a caller can tell "Meta rejected us
 * for reason X" from "our own code threw", and never mislabels a defect as a
 * connection problem the client is asked to fix.
 */
export function cloudFailureReason(error: unknown): ConnectionErrorReason | 'transient' | undefined {
  if (!(error instanceof TransientTransportError) && !(error instanceof TerminalTransportError)) return undefined;
  const value = error.context[REASON_FIELD];
  return typeof value === 'string' ? (value as ConnectionErrorReason | 'transient') : undefined;
}

/**
 * What to tell a client about a failure that was not their connection's fault.
 *
 * `ERROR_REASON_DESCRIPTIONS` covers every reason the *connection* can be in, and
 * `transient` is deliberately not one of them — a transient failure never becomes
 * a connection state. It still has to be explainable to a client whose attempt
 * just failed, and the explanation matters: told nothing, they will assume their
 * credentials are wrong and re-enter them.
 */
export const TRANSIENT_FAILURE_DESCRIPTION =
  'WhatsApp could not be reached just now. Nothing appears to be wrong with your number or your token; try again in a moment.';

/** One sentence for any classified cloud failure, connection reason or not. */
export function describeCloudFailure(reason: ConnectionErrorReason | 'transient'): string {
  return reason === 'transient' ? TRANSIENT_FAILURE_DESCRIPTION : ERROR_REASON_DESCRIPTIONS[reason];
}

/**
 * Whether Meta considers the owning business verified enough to message.
 *
 * `unknown` on both fields means Meta told us nothing, which is not the same as
 * telling us no — see the note on `verificationStatus`.
 */
export function businessVerificationBlocked(profile: BusinessAccountProfile): boolean {
  if (profile.reviewStatus === 'rejected') return true;
  return profile.verificationStatus !== 'unknown' && profile.verificationStatus !== 'verified';
}

/** Meta ids are numeric strings; a value that is not one would be a path injection. */
export const META_ID = /^[0-9]{1,32}$/;

/**
 * A WhatsApp address in E.164 without the leading `+`, which is the only form the
 * Cloud API accepts and the form inbound notifications arrive in.
 */
export const WHATSAPP_ADDRESS = /^[1-9][0-9]{6,17}$/;

/**
 * A message the Cloud API will accept.
 *
 * Checked by both adapters rather than by the fake alone, so the conformance
 * suite's 'an empty reply is refused' holds for the real one too. An empty body
 * is worth refusing here because Meta answers it with a generic parameter error
 * that classifies as `configuration_invalid` — which would move a healthy
 * connection towards `error` over a bug in reply generation.
 */
export function assertSendableText(message: { readonly to: string; readonly body: string }): void {
  const issues = [];
  if (!WHATSAPP_ADDRESS.test(message.to)) {
    issues.push({ key: 'to', reason: 'must be an E.164 number without a leading +' });
  }
  if (message.body.trim() === '') issues.push({ key: 'body', reason: 'is required' });
  if (issues.length > 0) throw new ValidationError(issues);
}

export function assertCloudCredentials(credentials: CloudCredentials): void {
  const issues = [];
  if (!META_ID.test(credentials.phoneNumberId)) {
    issues.push({ key: 'phoneNumberId', reason: 'must be the numeric id Meta assigned to the number' });
  }
  if (!META_ID.test(credentials.businessAccountId)) {
    issues.push({ key: 'businessAccountId', reason: 'must be the numeric id of the WhatsApp Business Account' });
  }
  if (credentials.accessToken.expose().trim() === '') {
    issues.push({ key: 'accessToken', reason: 'is required' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
}
