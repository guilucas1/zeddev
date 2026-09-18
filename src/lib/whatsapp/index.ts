/**
 * `@zeddev/whatsapp` — a tenant's WhatsApp number connection.
 *
 * A domain library with no HTTP and, so far, no Meta client. It owns the
 * connection health state that `whatsapp-number-connection.md` defines and that
 * readiness, operator monitoring, and alerting all read: the fixed vocabulary,
 * which moves between states are legal, the reason an `error` must carry, and the
 * timestamped history. The WhatsApp gateway (P2) will drive transitions from what
 * it observes at Meta; today the client's manual disconnect is the only caller
 * that can.
 *
 * Every function takes a connection the caller has already bound to one tenant,
 * as in `@zeddev/bot`, so none can be pointed at another tenant's number.
 */

export {
  CONNECTION_ERROR_REASONS,
  CONNECTION_STATES,
  CONNECTION_TRANSITIONS,
  connectionHistory,
  describeConnection,
  disconnectWhatsApp,
  ERROR_REASON_DESCRIPTIONS,
  readConnection,
  transitionConnection,
  type ConnectionErrorReason,
  type ConnectionState,
  type ConnectionStatus,
  type ConnectionTransition,
} from './connection.ts';
