/**
 * `@zeddev/conversation` — what happens to an end-customer's messages after the
 * gateway has stored them: grouping them into turns (`message-burst-aggregation.md`),
 * putting each closed turn and the conversation before it to the model
 * (`conversation-memory.md`), and recording the one answer each turn gets — a
 * reply, the client's fallback text, a handoff pause, or nothing because the bot
 * is off or the conversation paused.
 *
 * A domain library, like `@zeddev/bot`: no HTTP, no queue consumer loop. Every
 * function takes a connection already bound to one tenant. The
 * `conversation-worker` service runs `conversationHandlers` under `runConsumer`;
 * the API calls `resumeConversation`, and reads conversations back through
 * `transcript.ts` (`client-conversation-visibility.md`).
 *
 * Sending the recorded answer is here too (`delivery.ts`): an answer is recorded
 * with `delivery_state = 'pending'`, and the delivery handler drains that outbox,
 * detects the 24-hour customer service window, retries what Meta definitively
 * refused, refuses to repeat what it cannot know the fate of, and feeds a send
 * failure back into the connection state.
 */

export {
  claimDelivery,
  DELIVERY_FAILURES,
  DELIVERY_JOB_KIND,
  DELIVERY_LIMITS,
  DELIVERY_PRINCIPAL,
  DELIVERY_STATES,
  deliveryJob,
  readDelivery,
  scheduleDelivery,
  settleDelivery,
  type DeliveryAttemptOutcome,
  type DeliveryClaim,
  type DeliveryFailure,
  type DeliveryScheduler,
  type DeliverySettlement,
  type DeliveryState,
} from './delivery.ts';
export {
  cleanTranscript,
  IMAGE_UNDERSTANDING_INSTRUCTIONS,
  MEDIA_LIMITS,
  MEDIA_PRINCIPAL,
  MEDIA_UNDERSTANDING_FAILURES,
  readImageUnderstanding,
  readMediaUnderstandings,
  recordMediaUnderstanding,
  TECHNICAL_MEDIA_FAILURES,
  understandMedia,
  understandTurnMedia,
  type MediaJobContext,
  type MediaUnderstandingDependencies,
  type MediaUnderstandingFailure,
  type MediaVerdict,
  type PendingMedia,
  type StoredMediaUnderstanding,
} from './media.ts';
export {
  renderConversation,
  renderMessage,
  type ContextTurn,
  type RenderedConversation,
  type TurnMessage,
} from './context.ts';
export {
  admitPendingMessages,
  CONVERSATION_LIMITS,
  describeConversationHandoff,
  INBOUND_DISPOSITIONS,
  parseResumeInput,
  prepareTurn,
  readConversationHandoff,
  readHandoffHistory,
  recordTurnOutcome,
  RESUME_FIELDS,
  resumeConversation,
  TURN_JOB_KIND,
  TURN_OUTCOMES,
  TURN_STATES,
  WITHHELD_REASONS,
  type AdmissionResult,
  type AggregationPolicy,
  type ConversationHandoffStatus,
  type HandoffEvent,
  type InboundDisposition,
  type PreparedTurn,
  type RecordedOutcome,
  type TurnOutcomeKind,
  type TurnPreparation,
  type TurnScheduler,
  type TurnState,
  type WithheldReason,
} from './turns.ts';
export {
  CONVERSATION_LIST_FIELDS,
  describeConversationSummary,
  describeStoredMessage,
  describeTranscript,
  listConversations,
  parseConversationListInput,
  parseTranscriptInput,
  readTranscript,
  TRANSCRIPT_FIELDS,
  TRANSCRIPT_LIMITS,
  type BotEntry,
  type ConversationListPage,
  type ConversationListQuery,
  type ConversationSummary,
  type CustomerEntry,
  type MediaRepresentation,
  type TranscriptEntry,
  type TranscriptPage,
  type TranscriptQuery,
} from './transcript.ts';
export { conversationHandlers, type ConversationWorkerDependencies } from './worker.ts';
