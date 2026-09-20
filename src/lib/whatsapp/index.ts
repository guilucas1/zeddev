/**
 * `@zeddev/whatsapp` — a tenant's WhatsApp number connection.
 *
 * A domain library with no HTTP of its own. It owns the connection health state
 * that `whatsapp-number-connection.md` defines and that readiness, operator
 * monitoring, and alerting all read: the fixed vocabulary, which moves between
 * states are legal, the reason an `error` must carry, and the timestamped
 * history.
 *
 * It also owns the Cloud API itself — a port (`cloud.ts`) with Meta's Graph API
 * behind it (`graph.ts`), an in-memory fake, and one conformance suite holding
 * both to the same answers — and the self-service flow that drives the state
 * machine with it (`onboarding.ts`): submit, verify by a real send-and-reply
 * round trip, replace, disconnect.
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
export {
  assertCloudCredentials,
  assertSendableText,
  businessVerificationBlocked,
  classifyCloudFailure,
  cloudFailure,
  cloudFailureDeterminacy,
  cloudFailureReason,
  describeCloudFailure,
  CLOUD_ERROR_CODES,
  CLOUD_RECOVERABLE_REASONS,
  SEND_DETERMINACY,
  META_ID,
  TRANSIENT_FAILURE_DESCRIPTION,
  WHATSAPP_ADDRESS,
  type BusinessAccountProfile,
  type CloudCredentials,
  type CloudDescriptor,
  type NumberProfile,
  type SendDeterminacy,
  type SentMessage,
  type WhatsAppCloud,
} from './cloud.ts';
export {
  loadGraphCloudSettings,
  loadWhatsAppConfig,
  WHATSAPP_CONFIG_SCHEMA,
  type WhatsAppConfig,
} from './config.ts';
export { GraphWhatsAppCloud, type GraphCloudDependencies, type GraphCloudSettings } from './graph.ts';
export {
  abandonVerification,
  beginVerification,
  CONNECTION_LIMITS,
  connectionCodeMessage,
  CONNECTION_STEPS,
  consumeVerificationReply,
  currentStep,
  describeConnectionSetup,
  digestVerificationCode,
  disconnectNumber,
  expireStaleVerification,
  generateVerificationCode,
  loadCloudCredentials,
  parseCredentialSubmission,
  parseVerificationRequest,
  readConnectedNumber,
  readVerification,
  recordVerificationSent,
  submitCredentials,
  VERIFICATION_FAILURES,
  VERIFICATION_OUTCOMES,
  type ConnectedNumber,
  type ConnectionStepKey,
  type CredentialSubmission,
  type PendingVerification,
  type SubmitOptions,
  type VerificationFailure,
  type VerificationOutcome,
  type VerificationReplyOutcome,
  type VerificationSummary,
} from './onboarding.ts';
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
