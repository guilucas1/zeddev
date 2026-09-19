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
 * It also owns the inbound half of `message-delivery-reliability.md` below the
 * HTTP layer (`inbound.ts`): webhook authenticity, attribution of a notification
 * to a tenant by its receiving number, and storing each message exactly once.
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
export { loadWhatsAppConfig, WHATSAPP_CONFIG_SCHEMA, type WhatsAppConfig } from './config.ts';
export {
  assignPhoneNumber,
  attributeInboundNumber,
  INBOUND_JOB_KIND,
  INBOUND_MESSAGE_TYPES,
  INBOUND_QUEUE,
  INBOUND_REJECTION_REASONS,
  listInboundMessages,
  parseInboundMessage,
  parseWebhookNotification,
  readInboundMessage,
  readPhoneNumber,
  recordInboundMessage,
  recordInboundRejection,
  verifyWebhookSignature,
  type InboundBatch,
  type InboundContent,
  type InboundMessage,
  type InboundMessageType,
  type InboundRejection,
  type InboundRejectionReason,
  type ParsedNotification,
  type StoredInboundMessage,
} from './inbound.ts';
