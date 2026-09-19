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
 * the API calls `resumeConversation`.
 *
 * Sending the recorded answer to WhatsApp is not here. An answer is recorded with
 * `delivery_state = 'pending'` — the outbox the outbound sender drains.
 */

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
export { conversationHandlers, type ConversationWorkerDependencies } from './worker.ts';
