/**
 * The WhatsApp connection state machine — `whatsapp-number-connection.md`.
 *
 * ## What lives where
 *
 * The *vocabulary* is enforced by the database (a CHECK on
 * `whatsapp_connections.state`, and one pairing `error` with a reason), and so is
 * the *history*: a trigger appends every change to
 * `whatsapp_connection_transitions`, so a caller cannot change the state without
 * it being recorded (AC10). What lives here is which moves are legal, because
 * that is a rule about intent — "a disconnected number cannot become connected
 * without first being verified" — and it reads better as a table than as SQL.
 *
 * Readiness is not decided here either. A trigger in migration 0007 re-evaluates
 * the tenant's bot readiness in the same transaction as every state change, and
 * switches an active bot off when the connection enters a state that does not
 * count (`bot-activation-control.md`). This module does not call into
 * `@zeddev/bot`, and must not need to: a path that changes the state without
 * going through here is still covered.
 *
 * ## What is not here yet
 *
 * Authorizing a number with Meta and verifying it can send and receive — the
 * part that earns `connecting → connected` — is the WhatsApp gateway's (P2).
 * `transitionConnection` records that outcome; it does not establish it, so no
 * client-facing surface may call it with `connected`.
 */

import type { Connection } from '@zeddev/db';
import { ConflictError, DefectError, ValidationError } from '@zeddev/errors';

/** The fixed vocabulary. Mirrored by a CHECK constraint in migration 0006. */
export const CONNECTION_STATES = ['connecting', 'connected', 'reconnecting', 'error', 'disconnected'] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

/**
 * Why a connection is in `error`, with the human-readable text the spec requires
 * be surfaced (AC12).
 *
 * `business_verification_required` is kept separate from the technical reasons on
 * purpose: AC9 requires Meta-side business verification be shown "as a distinct
 * blocking condition (not a generic technical error)", because no amount of
 * retrying on the platform's side resolves it. Mirrored by a CHECK constraint in
 * migration 0006.
 */
export const ERROR_REASON_DESCRIPTIONS = {
  authorization_revoked:
    "The platform's permission to use this WhatsApp number was revoked. Reconnect the number to grant it again.",
  number_disconnected: 'The number was disconnected on the WhatsApp side. Reconnect it to continue.',
  rate_limited: 'WhatsApp is limiting how many messages this number may send. The limit lifts on its own.',
  configuration_invalid: 'The WhatsApp configuration for this number is invalid. Reconnect the number to correct it.',
  business_verification_required:
    'Meta requires your business to complete (or renew) business verification. This must be resolved with Meta ' +
    'before the number can be connected; the platform cannot resolve it for you.',
  verification_failed: 'The platform could not confirm that this number can send and receive messages.',
  recovery_exhausted: 'The connection was interrupted and could not be restored automatically. Reconnect the number.',
} as const satisfies Record<string, string>;
export type ConnectionErrorReason = keyof typeof ERROR_REASON_DESCRIPTIONS;
export const CONNECTION_ERROR_REASONS = Object.keys(ERROR_REASON_DESCRIPTIONS) as readonly ConnectionErrorReason[];

/**
 * The legal moves, keyed by the state being left.
 *
 * - Only `connecting` and `reconnecting` lead to `connected`: a number becomes
 *   connected by being verified or by recovering, never directly from
 *   `disconnected` or `error` (the spec's "not ... based solely on the client
 *   submitting credentials").
 * - `reconnecting` is reachable only from `connected` — it means "a previously
 *   connected number was interrupted".
 * - The client may disconnect from any state that has a number (AC7, plus
 *   cancelling a `connecting` attempt).
 * - `error → error` is legal so a reason can change (rate-limited, then recovery
 *   exhausted) and the change is recorded.
 */
export const CONNECTION_TRANSITIONS: Readonly<Record<ConnectionState, readonly ConnectionState[]>> = {
  disconnected: ['connecting'],
  connecting: ['connected', 'error', 'disconnected'],
  connected: ['reconnecting', 'error', 'disconnected'],
  reconnecting: ['connected', 'error', 'disconnected'],
  error: ['connecting', 'error', 'disconnected'],
};

/** A tenant's connection as the client and operator see it. */
export interface ConnectionStatus {
  readonly state: ConnectionState;
  readonly errorReason: ConnectionErrorReason | null;
  /** The last moment the number was known to be `connected`, or null if it never was. */
  readonly lastKnownGoodAt: Date | null;
  /** When the state last changed, or null for a tenant that has never had a connection. */
  readonly changedAt: Date | null;
}

export interface ConnectionTransition {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly errorReason: ConnectionErrorReason | null;
  readonly occurredAt: Date;
}

interface ConnectionRow {
  state: ConnectionState;
  error_reason: ConnectionErrorReason | null;
  last_known_good_at: Date | null;
  changed_at: Date;
}

const COLUMNS = 'state, error_reason, last_known_good_at, changed_at';

/** The vocabulary's "no connection has ever been established". */
const NEVER_CONNECTED: ConnectionStatus = {
  state: 'disconnected',
  errorReason: null,
  lastKnownGoodAt: null,
  changedAt: null,
};

function fromRow(row: ConnectionRow): ConnectionStatus {
  return {
    state: row.state,
    errorReason: row.error_reason,
    lastKnownGoodAt: row.last_known_good_at,
    changedAt: row.changed_at,
  };
}

/**
 * Refuse a connection with no tenant bound, for the reason `@zeddev/bot` gives:
 * row-level security would fail closed, and for a read that is indistinguishable
 * from "never connected".
 */
function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, {
      code: 'whatsapp.tenant_unbound',
    });
  }
}

/** The tenant's current connection state. */
export async function readConnection(connection: Connection): Promise<ConnectionStatus> {
  requireTenant(connection, 'readConnection');
  const result = await connection.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM whatsapp_connections WHERE tenant_id = app.current_tenant_id()`,
  );
  const row = result.rows[0];
  return row === undefined ? NEVER_CONNECTED : fromRow(row);
}

/**
 * Move the tenant's connection to `to`, refusing a move the state machine does
 * not allow.
 *
 * The current row is locked before the move is judged, so two concurrent
 * transitions serialise and the second is judged against the first's result
 * rather than against a state that no longer holds.
 *
 * `reason` is required for `error` and refused otherwise — the same rule the
 * database's paired CHECK enforces, checked here first so the caller gets a
 * validation error naming the field instead of a constraint violation.
 */
export async function transitionConnection(
  connection: Connection,
  to: ConnectionState,
  options: { readonly reason?: ConnectionErrorReason | undefined } = {},
): Promise<ConnectionStatus> {
  requireTenant(connection, 'transitionConnection');
  const reason = options.reason ?? null;
  if (to === 'error' && reason === null) {
    throw new ValidationError([{ key: 'reason', reason: 'is required when the connection enters error' }]);
  }
  if (to !== 'error' && reason !== null) {
    throw new ValidationError([{ key: 'reason', reason: 'is only recorded for the error state' }]);
  }
  if (reason !== null && !(CONNECTION_ERROR_REASONS as readonly string[]).includes(reason)) {
    throw new ValidationError([{ key: 'reason', reason: `must be one of: ${CONNECTION_ERROR_REASONS.join(', ')}` }]);
  }

  const locked = await connection.query<ConnectionRow>(
    `SELECT ${COLUMNS} FROM whatsapp_connections WHERE tenant_id = app.current_tenant_id() FOR UPDATE`,
  );
  const current = locked.rows[0];
  const from: ConnectionState = current?.state ?? 'disconnected';
  if (!CONNECTION_TRANSITIONS[from].includes(to) || (from === 'error' && to === 'error' && current?.error_reason === reason)) {
    throw new ConflictError(`The WhatsApp connection cannot move from ${from} to ${to}.`, {
      code: 'whatsapp.connection.illegal_transition',
      context: { from, to },
    });
  }

  // Last-known-good is stamped on entering `connected` and on leaving it, so it
  // is the last moment the link was known to work either way.
  const touchesConnected = to === 'connected' || from === 'connected';
  const result =
    current === undefined
      ? await connection.query<ConnectionRow>(
          `INSERT INTO whatsapp_connections (tenant_id, state, error_reason, last_known_good_at)
           VALUES (app.current_tenant_id(), $1, $2, CASE WHEN $3::boolean THEN now() END)
           RETURNING ${COLUMNS}`,
          [to, reason, touchesConnected],
        )
      : await connection.query<ConnectionRow>(
          `UPDATE whatsapp_connections
              SET state              = $1,
                  error_reason       = $2,
                  last_known_good_at = CASE WHEN $3::boolean THEN now() ELSE last_known_good_at END,
                  changed_at         = now()
            WHERE tenant_id = app.current_tenant_id()
            RETURNING ${COLUMNS}`,
          [to, reason, touchesConnected],
        );
  return fromRow(result.rows[0]!);
}

/**
 * The client's manual disconnect (AC7).
 *
 * Idempotent: disconnecting a number that is already disconnected is what the
 * client asked for, not a conflict, and it records nothing because nothing
 * changed.
 */
export async function disconnectWhatsApp(connection: Connection): Promise<ConnectionStatus> {
  requireTenant(connection, 'disconnectWhatsApp');
  const current = await readConnection(connection);
  if (current.state === 'disconnected') return current;
  return transitionConnection(connection, 'disconnected');
}

/** The tenant's transition history, newest first (AC10). */
export async function connectionHistory(
  connection: Connection,
  options: { readonly limit?: number } = {},
): Promise<ConnectionTransition[]> {
  requireTenant(connection, 'connectionHistory');
  const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
  const result = await connection.query<{
    from_state: ConnectionState;
    to_state: ConnectionState;
    error_reason: ConnectionErrorReason | null;
    occurred_at: Date;
  }>(
    `SELECT from_state, to_state, error_reason, occurred_at
       FROM whatsapp_connection_transitions
      WHERE tenant_id = app.current_tenant_id()
      ORDER BY id DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => ({
    from: row.from_state,
    to: row.to_state,
    errorReason: row.error_reason,
    occurredAt: row.occurred_at,
  }));
}

/** The connection as the client's screen shows it, with the error reason spelled out (AC12). */
export function describeConnection(
  status: ConnectionStatus,
  history: readonly ConnectionTransition[] = [],
): {
  readonly state: ConnectionState;
  readonly error: { readonly reason: ConnectionErrorReason; readonly description: string } | null;
  readonly lastKnownGoodAt: string | null;
  readonly changedAt: string | null;
  readonly history: readonly {
    readonly from: ConnectionState;
    readonly to: ConnectionState;
    readonly errorReason: ConnectionErrorReason | null;
    readonly occurredAt: string;
  }[];
} {
  return {
    state: status.state,
    error:
      status.errorReason === null
        ? null
        : { reason: status.errorReason, description: ERROR_REASON_DESCRIPTIONS[status.errorReason] },
    lastKnownGoodAt: status.lastKnownGoodAt?.toISOString() ?? null,
    changedAt: status.changedAt?.toISOString() ?? null,
    history: history.map((entry) => ({
      from: entry.from,
      to: entry.to,
      errorReason: entry.errorReason,
      occurredAt: entry.occurredAt.toISOString(),
    })),
  };
}
