/**
 * Delivering a recorded answer — the outbound half of
 * `message-delivery-reliability.md`.
 *
 * `recordTurnOutcome` decides *what* the end customer is told and leaves it in
 * `conversation_turn_outcomes` with `delivery_state = 'pending'`. This module
 * takes it from there, and the whole of its difficulty is one sentence in the
 * spec: a transient failure must be retried (AC7) and the end customer must not
 * receive the same reply twice (AC7 again). The Cloud API has no idempotency key,
 * so those two are not jointly achievable by retrying harder — they are achieved
 * by knowing which failures left nothing behind.
 *
 * ## The state machine, and why it needs `sending`
 *
 *   pending → sending → sent
 *                     ↘ pending   (Meta answered "no"; safe to attempt again)
 *                     ↘ failed    (out of attempts, or the outcome is unknowable)
 *   pending → expired             (outside the 24-hour window; never attempted)
 *
 * The row is moved to `sending` in its own committed transaction *before* the
 * call, which is the same rule the connection flow follows for its verification
 * send. That is what makes a crash recoverable: an attempt that finds the row
 * already in `sending` knows a previous attempt got as far as calling Meta and
 * never came back to say what happened. It does not send again. A lost reply is
 * recorded and visible (AC8 provides for exactly that); a duplicate reply is
 * neither, and AC7 forbids it by name.
 *
 * ## The 24-hour customer service window
 *
 * The Cloud API only permits a free-form business message within 24 hours of the
 * end customer's most recent message. AC10 requires the platform detect this,
 * not fail silently, and record the occurrence. It does not say what to send
 * instead: the alternative is an approved template, which costs money per send
 * and is an open product decision (IMPLEMENTATION_PLAN.md §4). Until that is
 * answered the reply is not sent and the row is marked `expired` — which is the
 * conservative half of the decision and leaves the other half a configuration
 * change rather than a rewrite.
 *
 * ## Connection state feedback
 *
 * AC9 requires a send failure that indicts the connection itself to move the
 * connection, not merely the message. That happens here because this is where
 * such a failure is first observed: a terminal Meta reason moves the connection
 * to `error` with that reason, a recoverable one moves `connected` to
 * `reconnecting`, and a send that succeeds while `reconnecting` moves it back to
 * `connected`. This is the only thing in the platform that drives automatic
 * recovery, which is why it lives next to the only thing that regularly calls
 * Meta.
 */

import type { Connection } from '@zeddev/db';
import { DefectError, NotFoundError } from '@zeddev/errors';
import type { EnqueueRequest, EnqueueResult } from '@zeddev/queue';
import type { SecretSealer } from '@zeddev/secrets';
import {
  cloudFailureDeterminacy,
  cloudFailureReason,
  CLOUD_RECOVERABLE_REASONS,
  loadCloudCredentials,
  readConnection,
  transitionConnection,
  CONNECTION_TRANSITIONS,
  type CloudCredentials,
  type ConnectionErrorReason,
} from '@zeddev/whatsapp';

/** Mirrors the `delivery_state` CHECK in migration 0016; a test asserts they agree. */
export const DELIVERY_STATES = ['pending', 'sending', 'sent', 'failed', 'expired'] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

/** Mirrors the `delivery_failure` CHECK in migration 0016; a test asserts they agree. */
export const DELIVERY_FAILURES = ['window_expired', 'indeterminate', 'rejected', 'attempts_exhausted'] as const;
export type DeliveryFailure = (typeof DELIVERY_FAILURES)[number];

/** Names the handler that drains the outbox. */
export const DELIVERY_JOB_KIND = 'conversation_delivery';

/**
 * Who `secret_access_records` names when the sender unseals a tenant's token.
 *
 * A fixed name rather than a worker instance id: the audit trail's question is
 * "which part of the platform read this", and an id that changes with every
 * container restart answers a question nobody asked while making the real one
 * harder. `credential-and-secret-handling.md` AC14 asks for the principal, the
 * class, and the time, and this is the principal.
 */
export const DELIVERY_PRINCIPAL = 'system:outbound-sender';

export const DELIVERY_LIMITS = {
  /**
   * WhatsApp's customer service window. Fixed by Meta, not by this platform, so
   * it is a constant rather than a setting: a deployment that configured it
   * differently would only be configuring how wrong it is.
   */
  customerServiceWindowMs: 24 * 60 * 60 * 1000,
  /**
   * Attempts before the reply is recorded as undelivered.
   *
   * Five, with the queue's own backoff between them, spans the length of an
   * ordinary Meta rate-limit or blip without keeping a reply in flight so long
   * that the customer has moved on. It is deliberately smaller than the window
   * above: a reply that is still being retried when the 24 hours run out cannot
   * be sent at all.
   */
  maxAttempts: 5,
} as const;

/** What `claimDelivery` decided, under the outcome row's lock. */
export type DeliveryClaim =
  | { readonly status: 'ready'; readonly credentials: CloudCredentials; readonly to: string; readonly body: string }
  /** Already settled — sent, failed, expired, or the row is gone with its tenant. */
  | { readonly status: 'settled'; readonly state: DeliveryState | undefined }
  /** A previous attempt reached Meta and never reported back. Recorded, never repeated. */
  | { readonly status: 'indeterminate' }
  | { readonly status: 'expired' }
  /** The tenant no longer has a number to send from. */
  | { readonly status: 'disconnected' };

/** What `settleDelivery` was told about an attempt that has returned. */
export type DeliveryAttemptOutcome =
  | { readonly status: 'sent'; readonly messageId: string }
  | { readonly status: 'failed'; readonly error: unknown; readonly attemptsRemaining: number };

export interface DeliveryScheduler {
  enqueueWithin(connection: Connection, request: EnqueueRequest): Promise<EnqueueResult>;
}

function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'conversation.tenant_unbound' });
  }
}

/**
 * The job that will deliver this turn's answer, enqueued in the transaction that
 * records the answer.
 *
 * Partitioned by end customer so one customer's replies leave in the order they
 * were decided — the outbound counterpart of the inbound ordering AC5 requires.
 * The dedupe key is the turn, which makes a second enqueue for the same turn a
 * no-op forever: the turn is the primary key of the thing being delivered, so
 * "deliver this turn twice" has no meaning to express.
 */
export function deliveryJob(turnId: string, customerId: string): EnqueueRequest {
  return {
    kind: DELIVERY_JOB_KIND,
    payload: { turnId },
    partitionKey: `delivery:${customerId}`,
    dedupeKey: `delivery:${turnId}`,
    maxAttempts: DELIVERY_LIMITS.maxAttempts,
  };
}

export async function scheduleDelivery(
  connection: Connection,
  scheduler: DeliveryScheduler,
  input: { readonly turnId: string; readonly customerId: string },
): Promise<EnqueueResult> {
  requireTenant(connection, 'scheduleDelivery');
  return scheduler.enqueueWithin(connection, deliveryJob(input.turnId, input.customerId));
}

interface OutcomeRow {
  message: string | null;
  delivery_state: DeliveryState | null;
  delivery_attempts: number;
  customer_id: string;
}

/**
 * Take the row for one attempt.
 *
 * Everything decided here is decided under `FOR UPDATE` on the outcome row, so
 * two workers holding the same job (the queue is at-least-once) cannot both
 * reach `sending`. The row is left in `sending` when this returns `ready`, and
 * the caller must reach `settleDelivery` or leave a recoverable record behind.
 */
export async function claimDelivery(
  connection: Connection,
  sealer: SecretSealer,
  turnId: string,
  now: Date,
): Promise<DeliveryClaim> {
  requireTenant(connection, 'claimDelivery');
  const locked = await connection.query<OutcomeRow>(
    `SELECT o.message, o.delivery_state, o.delivery_attempts, c.customer_id
       FROM conversation_turn_outcomes o
       JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
      WHERE o.tenant_id = app.current_tenant_id() AND o.turn_id = $1
        FOR UPDATE OF o`,
    [turnId],
  );
  const row = locked.rows[0];
  if (row === undefined || row.delivery_state === null || row.message === null) {
    return { status: 'settled', state: row?.delivery_state ?? undefined };
  }
  if (row.delivery_state === 'sending') {
    // A previous attempt called Meta and never said what happened. Meta may have
    // delivered it; nothing here can find out, and sending again is the one
    // outcome AC7 rules out.
    await finish(connection, turnId, 'failed', 'indeterminate', undefined);
    return { status: 'indeterminate' };
  }
  if (row.delivery_state !== 'pending') return { status: 'settled', state: row.delivery_state };

  if (await outsideCustomerServiceWindow(connection, row.customer_id, now)) {
    await finish(connection, turnId, 'expired', 'window_expired', undefined);
    return { status: 'expired' };
  }

  // Loaded *before* the row moves to `sending`, so a tenant with nothing to send
  // from settles here instead of rolling the whole attempt back and arriving at
  // the same answer on every retry. The connection may legitimately have been
  // disconnected between deciding the answer and sending it — the vocabulary
  // says `connected` is the only state messages may be exchanged in.
  let credentials: CloudCredentials;
  try {
    credentials = await loadCloudCredentials(connection, sealer, { principal: DELIVERY_PRINCIPAL });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
    await finish(connection, turnId, 'failed', 'rejected', 'not_connected');
    return { status: 'disconnected' };
  }

  await connection.query(
    `UPDATE conversation_turn_outcomes
        SET delivery_state = 'sending', delivery_attempts = delivery_attempts + 1, delivery_updated_at = now()
      WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
    [turnId],
  );

  return { status: 'ready', credentials, to: row.customer_id, body: row.message };
}

/**
 * Has the 24-hour window closed?
 *
 * Measured from the end customer's most recent message, which is what the rule
 * is about — and from the timestamp *they* sent it with rather than from when
 * the platform stored it, so a delay anywhere in the pipeline cannot make the
 * window look wider than Meta will treat it as.
 *
 * A customer with no stored message at all cannot be replied to under this rule
 * either, and that is not a degenerate case: it is what an offboarded-and-purged
 * conversation looks like.
 */
async function outsideCustomerServiceWindow(connection: Connection, customerId: string, now: Date): Promise<boolean> {
  const latest = await connection.query<{ sent_at: Date }>(
    `SELECT sent_at FROM inbound_messages
      WHERE tenant_id = app.current_tenant_id() AND customer_id = $1
      ORDER BY sent_at DESC LIMIT 1`,
    [customerId],
  );
  const sentAt = latest.rows[0]?.sent_at;
  if (sentAt === undefined) return true;
  return now.getTime() - sentAt.getTime() > DELIVERY_LIMITS.customerServiceWindowMs;
}

async function finish(
  connection: Connection,
  turnId: string,
  state: 'failed' | 'expired',
  failure: DeliveryFailure,
  reason: string | undefined,
): Promise<void> {
  await connection.query(
    `UPDATE conversation_turn_outcomes
        SET delivery_state = $2, delivery_failure = $3, delivery_reason = $4, delivery_updated_at = now()
      WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
    [turnId, state, failure, reason ?? null],
  );
}

/** What `settleDelivery` did, for the caller's log and for its retry decision. */
export interface DeliverySettlement {
  readonly state: DeliveryState;
  readonly failure: DeliveryFailure | undefined;
  /** The classified connection reason, when Meta gave one. Operational, never content. */
  readonly reason: ConnectionErrorReason | 'transient' | undefined;
  /** True when the caller should raise, so the queue retries with backoff. */
  readonly retry: boolean;
}

/**
 * Record what became of an attempt, and move the connection if the answer was
 * about the connection rather than about the message.
 */
export async function settleDelivery(
  connection: Connection,
  turnId: string,
  outcome: DeliveryAttemptOutcome,
): Promise<DeliverySettlement> {
  requireTenant(connection, 'settleDelivery');

  if (outcome.status === 'sent') {
    await connection.query(
      `UPDATE conversation_turn_outcomes
          SET delivery_state = 'sent', delivery_message_id = $2, delivery_failure = NULL,
              delivery_reason = NULL, delivery_updated_at = now()
        WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
      [turnId, outcome.messageId],
    );
    // A number that was recovering has just been observed working. This is the
    // only evidence of recovery the platform has, and AC5 of
    // `whatsapp-number-connection.md` wants the return to `connected` recorded.
    await moveConnection(connection, 'connected', undefined);
    return { state: 'sent', failure: undefined, reason: undefined, retry: false };
  }

  const reason = cloudFailureReason(outcome.error);
  const recoverable = reason !== undefined && CLOUD_RECOVERABLE_REASONS.has(reason);
  await feedConnection(connection, reason, recoverable);

  if (cloudFailureDeterminacy(outcome.error) === 'unknown') {
    await finish(connection, turnId, 'failed', 'indeterminate', reason);
    return { state: 'failed', failure: 'indeterminate', reason, retry: false };
  }

  // Meta answered, so nothing was delivered and repeating the call is safe.
  if (!recoverable) {
    await finish(connection, turnId, 'failed', 'rejected', reason);
    return { state: 'failed', failure: 'rejected', reason, retry: false };
  }
  if (outcome.attemptsRemaining <= 0) {
    await finish(connection, turnId, 'failed', 'attempts_exhausted', reason);
    return { state: 'failed', failure: 'attempts_exhausted', reason, retry: false };
  }

  await connection.query(
    `UPDATE conversation_turn_outcomes
        SET delivery_state = 'pending', delivery_reason = $2, delivery_updated_at = now()
      WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
    [turnId, reason ?? null],
  );
  return { state: 'pending', failure: undefined, reason, retry: true };
}

/**
 * Turn a send failure into a connection transition, where it is one.
 *
 * A failure with no classified reason came from this platform, not from Meta, and
 * says nothing about the link — moving the connection on it would take a healthy
 * tenant's bot off the air over a local bug.
 */
async function feedConnection(
  connection: Connection,
  reason: ConnectionErrorReason | 'transient' | undefined,
  recoverable: boolean,
): Promise<void> {
  if (reason === undefined) return;
  if (recoverable) {
    await moveConnection(connection, 'reconnecting', undefined);
    return;
  }
  await moveConnection(connection, 'error', reason as ConnectionErrorReason);
}

/**
 * Move the connection if the move is legal, and do nothing if it is not.
 *
 * Checked rather than caught. A send failure arriving while the client happens to
 * be disconnecting is an ordinary race, not a conflict anyone needs told about,
 * and letting `transitionConnection` raise here would fail a delivery attempt
 * over the state of something else entirely.
 */
async function moveConnection(
  connection: Connection,
  to: 'connected' | 'reconnecting' | 'error',
  reason: ConnectionErrorReason | undefined,
): Promise<void> {
  const current = await readConnection(connection);
  if (!CONNECTION_TRANSITIONS[current.state].includes(to)) return;
  if (to === 'error' && current.state === 'error' && current.errorReason === reason) return;
  await transitionConnection(connection, to, reason === undefined ? {} : { reason });
}

/** The delivery state of one turn's answer, for tests and for the client's transcript. */
export async function readDelivery(
  connection: Connection,
  turnId: string,
): Promise<
  | {
      readonly state: DeliveryState;
      readonly attempts: number;
      readonly failure: DeliveryFailure | null;
      readonly reason: string | null;
      readonly messageId: string | null;
    }
  | undefined
> {
  requireTenant(connection, 'readDelivery');
  const result = await connection.query<{
    delivery_state: DeliveryState | null;
    delivery_attempts: number;
    delivery_failure: DeliveryFailure | null;
    delivery_reason: string | null;
    delivery_message_id: string | null;
  }>(
    `SELECT delivery_state, delivery_attempts, delivery_failure, delivery_reason, delivery_message_id
       FROM conversation_turn_outcomes
      WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
    [turnId],
  );
  const row = result.rows[0];
  if (row === undefined || row.delivery_state === null) return undefined;
  return {
    state: row.delivery_state,
    attempts: row.delivery_attempts,
    failure: row.delivery_failure,
    reason: row.delivery_reason,
    messageId: row.delivery_message_id,
  };
}
