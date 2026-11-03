/**
 * Conversational turns — `message-burst-aggregation.md`.
 *
 * A turn is the unit a reply is generated for: consecutive messages from one
 * end-customer to one tenant, grouped while each arrives within the aggregation
 * window of the one before, and never for longer than the maximum turn duration
 * after the first. It is answered exactly once.
 *
 * ## Who decides what, and under which lock
 *
 * Every decision about one end-customer's messages is taken while holding that
 * customer's `conversations` row (`SELECT … FOR UPDATE`). Admission of new
 * messages, closing a turn, and recording its answer all take it, so two workers
 * can never both believe they own the open turn, and a message can never slip
 * into a turn at the instant it closes. Different end-customers — of the same
 * tenant or another — hold different rows and never wait on each other (burst
 * AC6, AC7).
 *
 * ## Time
 *
 * Whether a message joins a turn is judged by its `received_at` — when the
 * gateway stored it — never by when a worker got round to it. So a worker that
 * is behind still groups a burst exactly as a worker that was idle would have:
 * a message joins the open turn iff it arrived before that turn's `closes_at`.
 * Whether a turn is *due* to close is judged by the caller's `now`, which only
 * decides when work happens, not what the turn contains.
 *
 * ## Exactly one answer
 *
 * `conversation_turn_outcomes` is keyed by the turn, and the answer is recorded
 * only if none exists yet, under the lock. A job that runs twice (the queue is
 * at-least-once) may call the model twice, but can record — and so send — only
 * once (burst: "must not send more than one reply for the same turn, including
 * under retry"). Turns of one conversation are answered in order: a turn whose
 * predecessor is still unanswered waits, and recording an answer schedules the
 * next closed turn, so a slow reply can never be overtaken by a later one.
 */

import type { TokenUsage } from '@zeddev/ai';
import {
  fallbackMessageFor,
  mayAutoRespond,
  readReplyConfiguration,
  type FallbackCause,
  type FallbackSource,
  type FallbackTrigger,
  type HandoffSignal,
  type ReplyConfiguration,
  type ReplyDecision,
} from '@zeddev/bot';
import type { Connection } from '@zeddev/db';
import { DefectError, ValidationError } from '@zeddev/errors';
import type { EnqueueRequest, EnqueueResult } from '@zeddev/queue';
import type { InboundContent, InboundMessageType } from '@zeddev/whatsapp';
import { renderConversation, type ContextTurn, type RenderedConversation } from './context.ts';
import { scheduleDelivery } from './delivery.ts';
import type { MediaUnderstandingFailure, PendingMedia } from './media.ts';

/** What became of an inbound message. Mirrored by a CHECK in migration 0014. */
export const INBOUND_DISPOSITIONS = ['aggregated', 'held_bot_inactive', 'held_handoff_paused'] as const;
export type InboundDisposition = (typeof INBOUND_DISPOSITIONS)[number];

/** Mirrored by a CHECK in migration 0014. */
export const TURN_STATES = ['open', 'closed'] as const;
export type TurnState = (typeof TURN_STATES)[number];

/** How a turn was answered. Mirrored by a CHECK in migration 0014. */
export const TURN_OUTCOMES = ['reply', 'fallback', 'handoff', 'withheld'] as const;
export type TurnOutcomeKind = (typeof TURN_OUTCOMES)[number];

/** Why nothing was sent for a turn that was otherwise answerable. Mirrored by a CHECK in migration 0014. */
export const WITHHELD_REASONS = ['bot_inactive', 'handoff_paused'] as const;
export type WithheldReason = (typeof WITHHELD_REASONS)[number];

/** The job kind that closes and answers a turn. Consumed on `INBOUND_QUEUE` beside the inbound job. */
export const TURN_JOB_KIND = 'conversation_turn';

/**
 * Bounds on what is put in front of the model.
 *
 * `contextTurns` caps how many turns — the one being answered and those before
 * it — make up the conversation the model sees. `conversation-memory.md` puts
 * length limits out of scope, but an unbounded history is an unbounded prompt on
 * a free-tier quota; the reset policy (not built yet) is what normally bounds it.
 */
export const CONVERSATION_LIMITS = {
  contextTurns: 20,
} as const;

/**
 * The aggregation window and the maximum turn duration.
 *
 * Platform-wide, per the spec's v1 assumption, and set by the worker's
 * configuration (`WORKER_AGGREGATION_WINDOW`, `WORKER_MAX_TURN_DURATION`).
 */
export interface AggregationPolicy {
  /** Quiet period after the latest message before the turn closes. */
  readonly windowMs: number;
  /** Longest a turn stays open after its first message, however many follow. */
  readonly maxTurnMs: number;
}

/**
 * Scheduling a turn's job inside the caller's transaction — so a turn that
 * exists always has a job that will close it, and neither can commit without the
 * other. `PostgresQueue.enqueueWithin` satisfies it.
 */
export interface TurnScheduler {
  enqueueWithin(connection: Connection, request: EnqueueRequest): Promise<EnqueueResult>;
}

export function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'conversation.tenant_unbound' });
  }
}

/** An end-customer's WhatsApp id, as `inbound_messages.customer_id` constrains it. */
export const WHATSAPP_ID = /^[0-9]{1,32}$/;

function assertPolicy(policy: AggregationPolicy): void {
  if (!(policy.windowMs > 0) || !(policy.maxTurnMs >= policy.windowMs)) {
    throw new DefectError('the aggregation window must be positive and no longer than the maximum turn duration', {
      code: 'conversation.policy_invalid',
    });
  }
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

interface ConversationRow {
  id: string;
  customer_id: string;
  handoff_paused_at: Date | null;
  handoff_reason: HandoffSignal | null;
}

/**
 * The end-customer's conversation, created on first contact, locked for the rest
 * of the caller's transaction. The one lock every turn decision is taken under.
 */
async function lockConversation(connection: Connection, customerId: string): Promise<ConversationRow> {
  await connection.query(
    `INSERT INTO conversations (tenant_id, customer_id) VALUES (app.current_tenant_id(), $1)
     ON CONFLICT (tenant_id, customer_id) DO NOTHING`,
    [customerId],
  );
  const result = await connection.query<ConversationRow>(
    `SELECT id, customer_id, handoff_paused_at, handoff_reason FROM conversations
      WHERE tenant_id = app.current_tenant_id() AND customer_id = $1
      FOR UPDATE`,
    [customerId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new DefectError('a conversation was created but could not be read back', { code: 'conversation.lost' });
  }
  return row;
}

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

interface TurnRow {
  id: string;
  sequence: string;
  conversation_id: string;
  state: TurnState;
  opened_at: Date;
  closes_at: Date;
  deadline_at: Date;
}

const TURN_COLUMNS = 'id, sequence::text AS sequence, conversation_id, state, opened_at, closes_at, deadline_at';

function turnJob(turnId: string, dedupeKey: string, delayMs: number): EnqueueRequest {
  return {
    kind: TURN_JOB_KIND,
    // The id only: the turn's messages are read from their rows under the lock,
    // never from a copy that could disagree with them.
    payload: { turnId },
    dedupeKey,
    // Deliberately no partition key. The inbound jobs of this end-customer are
    // partitioned by customer, and a delayed turn job at the head of that
    // partition would hold back the very messages it is waiting to receive.
    // Ordering between the two is the conversation lock's job, not the queue's.
    delayMs: Math.max(0, Math.ceil(delayMs)),
  };
}

export interface AdmissionResult {
  /** Messages aggregated into a turn. */
  readonly aggregated: number;
  /** Messages held because the bot was off or the conversation paused. */
  readonly held: number;
  /** Turns this admission opened. */
  readonly openedTurns: readonly string[];
}

/**
 * Decide what becomes of every message of `customerId` that has not been decided
 * yet, oldest arrival first, under the conversation lock.
 *
 * Pulling every pending message rather than the one named by the job is what
 * makes admission idempotent and order-safe: a re-run job finds nothing pending,
 * and a message whose own job is still queued behind is admitted as soon as any
 * job for that customer — or the turn it belongs to — looks.
 *
 * - Conversation paused for handoff: held (`human-handoff.md` AC7) — received and
 *   retained, never aggregated toward a reply.
 * - Bot off: held (`bot-activation-control.md`; burst AC9) — not aggregated, so
 *   turning the bot on later does not answer them.
 * - Otherwise: joins the open turn if it arrived before that turn's `closes_at`,
 *   which then moves to the window after this message, bounded by the turn's
 *   deadline; else the open turn is closed and the message opens a new one, whose
 *   job is scheduled here, in this transaction.
 */
export async function admitPendingMessages(
  connection: Connection,
  customerId: string,
  policy: AggregationPolicy,
  scheduler: TurnScheduler,
  now: Date,
): Promise<AdmissionResult> {
  requireTenant(connection, 'admitPendingMessages');
  assertPolicy(policy);
  if (!WHATSAPP_ID.test(customerId)) {
    throw new ValidationError([{ key: 'customerId', reason: 'must be a WhatsApp id: digits only' }]);
  }
  const conversation = await lockConversation(connection, customerId);
  return admitLocked(connection, conversation, policy, scheduler, now);
}

async function admitLocked(
  connection: Connection,
  conversation: ConversationRow,
  policy: AggregationPolicy,
  scheduler: TurnScheduler,
  now: Date,
): Promise<AdmissionResult> {
  const pending = await connection.query<{ id: string; received_at: Date }>(
    `SELECT m.id, m.received_at FROM inbound_messages m
      WHERE m.tenant_id = app.current_tenant_id() AND m.customer_id = $1
        AND NOT EXISTS (SELECT 1 FROM inbound_dispositions d WHERE d.inbound_message_id = m.id)
      ORDER BY m.received_at, m.position`,
    [conversation.customer_id],
  );
  if (pending.rows.length === 0) return { aggregated: 0, held: 0, openedTurns: [] };

  const paused = conversation.handoff_paused_at !== null;
  const active = paused ? false : await mayAutoRespond(connection);
  if (paused || !active) {
    const disposition: InboundDisposition = paused ? 'held_handoff_paused' : 'held_bot_inactive';
    for (const message of pending.rows) {
      await connection.query(
        `INSERT INTO inbound_dispositions (inbound_message_id, tenant_id, conversation_id, disposition)
         VALUES ($1, app.current_tenant_id(), $2, $3)`,
        [message.id, conversation.id, disposition],
      );
    }
    return { aggregated: 0, held: pending.rows.length, openedTurns: [] };
  }

  const openedTurns: string[] = [];
  let open = (
    await connection.query<TurnRow>(
      `SELECT ${TURN_COLUMNS} FROM conversation_turns
        WHERE tenant_id = app.current_tenant_id() AND conversation_id = $1 AND state = 'open'`,
      [conversation.id],
    )
  ).rows[0];

  for (const message of pending.rows) {
    const arrived = message.received_at;
    if (open !== undefined && arrived.getTime() <= open.closes_at.getTime()) {
      // Restart the window from this message, never beyond the deadline. The
      // turn's scheduled job fires at the old `closes_at`, finds the turn not yet
      // due, and reschedules itself — so extending needs no new job.
      const extended = new Date(Math.min(arrived.getTime() + policy.windowMs, open.deadline_at.getTime()));
      if (extended.getTime() > open.closes_at.getTime()) {
        await connection.query(
          `UPDATE conversation_turns SET closes_at = $2
            WHERE tenant_id = app.current_tenant_id() AND id = $1`,
          [open.id, extended],
        );
        open = { ...open, closes_at: extended };
      }
    } else {
      if (open !== undefined) {
        // This message arrived after the open turn's window ran out, so that turn
        // is over whether or not its job has run yet. Its job is still scheduled
        // and will answer it; closing it here only stops it taking this message.
        await closeTurn(connection, open.id, open.closes_at);
      }
      const deadline = new Date(arrived.getTime() + policy.maxTurnMs);
      const closesAt = new Date(Math.min(arrived.getTime() + policy.windowMs, deadline.getTime()));
      const created = await connection.query<TurnRow>(
        `INSERT INTO conversation_turns (tenant_id, conversation_id, opened_at, closes_at, deadline_at)
         VALUES (app.current_tenant_id(), $1, $2, $3, $4)
         RETURNING ${TURN_COLUMNS}`,
        [conversation.id, arrived, closesAt, deadline],
      );
      open = created.rows[0]!;
      openedTurns.push(open.id);
      await scheduler.enqueueWithin(
        connection,
        turnJob(open.id, `turn:${open.id}:${closesAt.getTime()}`, closesAt.getTime() - now.getTime()),
      );
    }
    await connection.query(
      `INSERT INTO inbound_dispositions (inbound_message_id, tenant_id, conversation_id, turn_id, disposition)
       VALUES ($1, app.current_tenant_id(), $2, $3, 'aggregated')`,
      [message.id, conversation.id, open.id],
    );
  }
  return { aggregated: pending.rows.length, held: 0, openedTurns };
}

async function closeTurn(connection: Connection, turnId: string, at: Date): Promise<void> {
  await connection.query(
    `UPDATE conversation_turns SET state = 'closed', closed_at = $2
      WHERE tenant_id = app.current_tenant_id() AND id = $1 AND state = 'open'`,
    [turnId, at],
  );
}

// ---------------------------------------------------------------------------
// Closing and preparing a turn
// ---------------------------------------------------------------------------

/** Everything needed to generate one turn's answer, read in one transaction. */
export interface PreparedTurn {
  readonly turnId: string;
  readonly conversationId: string;
  readonly customerId: string;
  /** The conversation as the model sees it, ending with this turn. */
  readonly conversation: RenderedConversation;
  readonly configuration: ReplyConfiguration;
  /**
   * True when the bot has said nothing yet in this conversation — the boundary
   * `bot-disclosure-setting.md`'s "start of every new conversation" keys on.
   */
  readonly conversationStart: boolean;
  /**
   * Photos and voice notes of this turn nobody has looked at yet. The worker settles
   * these and prepares the turn again, so `conversation` then holds what they said.
   */
  readonly pendingMedia: readonly PendingMedia[];
}

export type TurnPreparation =
  /** Answered already — by an earlier run of this job, or never needed again. */
  | { readonly status: 'answered' }
  /** Still accepting messages; a job was scheduled for the new `closesAt`. */
  | { readonly status: 'open'; readonly closesAt: Date }
  /** Closed, but an earlier turn of this conversation is unanswered; its answer will schedule this one. */
  | { readonly status: 'behind'; readonly earlierTurnId: string }
  /** Answered without the model: nothing may be sent (bot off, conversation paused). */
  | { readonly status: 'decided'; readonly outcome: RecordedOutcome }
  | { readonly status: 'ready'; readonly turn: PreparedTurn };

/**
 * Close `turnId` if its window has run out, and gather what answering it needs.
 *
 * Messages still pending for this end-customer are admitted first, so one that
 * arrived inside the window but whose own job has not run yet still joins the
 * turn it belongs to — a worker that is behind must not split a burst.
 *
 * Nothing slow happens here: the model is called by the caller after this
 * transaction commits, so a slow provider holds no database connection or lock.
 */
export async function prepareTurn(
  connection: Connection,
  turnId: string,
  policy: AggregationPolicy,
  scheduler: TurnScheduler,
  now: Date,
): Promise<TurnPreparation> {
  requireTenant(connection, 'prepareTurn');
  assertPolicy(policy);

  const located = await connection.query<{ customer_id: string }>(
    `SELECT c.customer_id FROM conversation_turns t
       JOIN conversations c ON c.tenant_id = t.tenant_id AND c.id = t.conversation_id
      WHERE t.tenant_id = app.current_tenant_id() AND t.id::text = $1`,
    [turnId],
  );
  const customerId = located.rows[0]?.customer_id;
  // A turn the bound tenant cannot see — deleted with its tenant, or another
  // tenant's id — has nothing left to answer.
  if (customerId === undefined) return { status: 'answered' };

  const conversation = await lockConversation(connection, customerId);
  if (await outcomeExists(connection, turnId)) return { status: 'answered' };
  await admitLocked(connection, conversation, policy, scheduler, now);

  let turn = (await readTurn(connection, turnId))!;
  if (turn.state === 'open') {
    if (now.getTime() < turn.closes_at.getTime()) {
      await scheduler.enqueueWithin(
        connection,
        turnJob(turn.id, `turn:${turn.id}:${turn.closes_at.getTime()}`, turn.closes_at.getTime() - now.getTime()),
      );
      return { status: 'open', closesAt: turn.closes_at };
    }
    await closeTurn(connection, turn.id, turn.closes_at);
    turn = { ...turn, state: 'closed' };
  }

  const earlier = await connection.query<{ id: string }>(
    `SELECT t.id FROM conversation_turns t
      WHERE t.tenant_id = app.current_tenant_id() AND t.conversation_id = $1 AND t.sequence < $2::bigint
        AND NOT EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id = t.id)
      ORDER BY t.sequence
      LIMIT 1`,
    [conversation.id, turn.sequence],
  );
  if (earlier.rows[0] !== undefined) return { status: 'behind', earlierTurnId: earlier.rows[0].id };

  const withheld = await withheldReason(connection, conversation);
  if (withheld !== undefined) {
    const outcome = await insertOutcome(connection, conversation, turn.id, { outcome: 'withheld', reason: withheld });
    await scheduleNext(connection, conversation.id, turn, scheduler);
    return { status: 'decided', outcome };
  }

  const context = await readContext(connection, conversation.id, turn.sequence);
  const configuration = await readReplyConfiguration(connection);
  return {
    status: 'ready',
    turn: {
      turnId: turn.id,
      conversationId: conversation.id,
      customerId,
      conversation: renderConversation(context.turns),
      configuration,
      conversationStart: !context.botHasSpoken,
      pendingMedia: context.pendingMedia,
    },
  };
}

async function readTurn(connection: Connection, turnId: string): Promise<TurnRow | undefined> {
  const result = await connection.query<TurnRow>(
    `SELECT ${TURN_COLUMNS} FROM conversation_turns WHERE tenant_id = app.current_tenant_id() AND id::text = $1`,
    [turnId],
  );
  return result.rows[0];
}

async function outcomeExists(connection: Connection, turnId: string): Promise<boolean> {
  const result = await connection.query(
    `SELECT 1 FROM conversation_turn_outcomes WHERE tenant_id = app.current_tenant_id() AND turn_id::text = $1`,
    [turnId],
  );
  return result.rows.length > 0;
}

async function withheldReason(connection: Connection, conversation: ConversationRow): Promise<WithheldReason | undefined> {
  if (conversation.handoff_paused_at !== null) return 'handoff_paused';
  if (!(await mayAutoRespond(connection))) return 'bot_inactive';
  return undefined;
}

interface ContextRow {
  turn_id: string;
  sequence: string;
  message_id: string | null;
  message_type: InboundMessageType | null;
  upstream_type: string | null;
  content: InboundContent | null;
  understanding_exists: boolean;
  understood_text: string | null;
  understanding_failure: MediaUnderstandingFailure | null;
  bot_message: string | null;
}

/** The media of the turn being answered that has no understanding yet, in send order. */
function pendingMediaOf(rows: readonly ContextRow[]): PendingMedia[] {
  const current = rows.at(-1)?.turn_id;
  const pending: PendingMedia[] = [];
  for (const row of rows) {
    if (row.turn_id !== current || row.understanding_exists || row.message_id === null) continue;
    if (row.message_type !== 'image' && row.message_type !== 'audio') continue;
    const content = row.content as { readonly mediaId?: unknown; readonly mimeType?: unknown; readonly caption?: unknown };
    if (typeof content.mediaId !== 'string' || typeof content.mimeType !== 'string') continue;
    pending.push({
      messageId: row.message_id,
      kind: row.message_type,
      mediaId: content.mediaId,
      mimeType: content.mimeType,
      caption: typeof content.caption === 'string' ? content.caption : undefined,
    });
  }
  return pending;
}

/**
 * The last `CONVERSATION_LIMITS.contextTurns` turns up to and including the one
 * at `sequence`, each with its aggregated messages in the order the end-customer
 * sent them (burst: "in the order the end-customer actually sent them"; AC3).
 *
 * Held messages are not part of it: they were never put to the bot, and a reply
 * built on messages the customer sent while the bot was off would be answering
 * them after all.
 */
async function readContext(
  connection: Connection,
  conversationId: string,
  sequence: string,
): Promise<{ turns: ContextTurn[]; botHasSpoken: boolean; pendingMedia: PendingMedia[] }> {
  const result = await connection.query<ContextRow>(
    `WITH recent AS (
       SELECT id, sequence FROM conversation_turns
        WHERE tenant_id = app.current_tenant_id() AND conversation_id = $1 AND sequence <= $2::bigint
        ORDER BY sequence DESC
        LIMIT $3
     )
     SELECT r.id AS turn_id, r.sequence::text AS sequence,
            m.id AS message_id, m.message_type, m.upstream_type, m.content,
            u.inbound_message_id IS NOT NULL AS understanding_exists, u.understood_text,
            u.failure AS understanding_failure, o.message AS bot_message
       FROM recent r
       LEFT JOIN inbound_dispositions d ON d.turn_id = r.id
       LEFT JOIN inbound_messages m ON m.id = d.inbound_message_id
       LEFT JOIN inbound_media_understandings u ON u.inbound_message_id = m.id
       LEFT JOIN conversation_turn_outcomes o ON o.turn_id = r.id
      ORDER BY r.sequence, m.sent_at, m.position`,
    [conversationId, sequence, CONVERSATION_LIMITS.contextTurns],
  );
  const turns: ContextTurn[] = [];
  let current: { id: string; messages: ContextTurn['messages'][number][]; botMessage: string | undefined } | undefined;
  for (const row of result.rows) {
    if (current === undefined || current.id !== row.turn_id) {
      current = { id: row.turn_id, messages: [], botMessage: row.bot_message ?? undefined };
      turns.push(current);
    }
    if (row.message_type !== null && row.content !== null && row.upstream_type !== null) {
      current.messages.push({
        type: row.message_type,
        upstreamType: row.upstream_type,
        content: row.content,
        understanding: row.understanding_exists
          ? { text: row.understood_text ?? undefined, failure: row.understanding_failure ?? undefined }
          : undefined,
      });
    }
  }

  const spoken = await connection.query(
    `SELECT 1 FROM conversation_turn_outcomes
      WHERE tenant_id = app.current_tenant_id() AND conversation_id = $1 AND message IS NOT NULL
      LIMIT 1`,
    [conversationId],
  );
  return { turns, botHasSpoken: spoken.rows.length > 0, pendingMedia: pendingMediaOf(result.rows) };
}

// ---------------------------------------------------------------------------
// Recording the answer
// ---------------------------------------------------------------------------

/** What was recorded for a turn. */
export type RecordedOutcome =
  | { readonly outcome: 'reply'; readonly message: string }
  | {
      readonly outcome: 'fallback';
      readonly message: string;
      readonly trigger: FallbackTrigger;
      readonly cause: FallbackCause;
      readonly source: FallbackSource;
    }
  | { readonly outcome: 'handoff'; readonly reason: HandoffSignal }
  | { readonly outcome: 'withheld'; readonly reason: WithheldReason };

type OutcomeInput =
  | { readonly outcome: 'reply'; readonly message: string }
  | { readonly outcome: 'fallback'; readonly trigger: FallbackTrigger; readonly cause: FallbackCause }
  | { readonly outcome: 'handoff'; readonly reason: HandoffSignal }
  | { readonly outcome: 'withheld'; readonly reason: WithheldReason };

/**
 * Record the answer to a prepared turn, once.
 *
 * Re-checks, under the lock, what may have changed while the model was thinking:
 * if the bot was switched off or the conversation paused in the meantime, the
 * answer is withheld rather than sent (`bot-activation-control.md`: off means no
 * automated reply "from the moment" it is off). The fallback text is resolved
 * here, in this transaction, from what the client has saved now — literal text,
 * never generated (`fallback-response-behavior.md`) — and recorded with its
 * trigger and cause (fallback AC10). A handoff pauses the conversation and is
 * logged as a handoff event (`human-handoff.md` AC2–AC5, AC12).
 *
 * `recorded: false` means an answer already existed — a duplicate run — and
 * nothing was changed.
 */
export async function recordTurnOutcome(
  connection: Connection,
  turn: Pick<PreparedTurn, 'turnId' | 'customerId'>,
  decision: ReplyDecision,
  scheduler: TurnScheduler,
  usage?: TokenUsage | undefined,
): Promise<{ readonly recorded: boolean; readonly outcome: RecordedOutcome | undefined }> {
  requireTenant(connection, 'recordTurnOutcome');
  const conversation = await lockConversation(connection, turn.customerId);
  const row = await readTurn(connection, turn.turnId);
  if (row === undefined || row.conversation_id !== conversation.id || (await outcomeExists(connection, turn.turnId))) {
    return { recorded: false, outcome: undefined };
  }

  const withheld = await withheldReason(connection, conversation);
  const input: OutcomeInput =
    withheld !== undefined
      ? { outcome: 'withheld', reason: withheld }
      : decision.path === 'reply'
        ? { outcome: 'reply', message: decision.text }
        : decision.path === 'fallback'
          ? { outcome: 'fallback', trigger: decision.trigger, cause: decision.cause }
          : { outcome: 'handoff', reason: decision.reason };
  const outcome = await insertOutcome(connection, conversation, row.id, input, usage);
  // The outbox and the job that drains it commit together, so an answer that
  // exists always has something coming to send it, and a rolled-back answer
  // leaves no job behind to send an answer that was never recorded.
  if ('message' in outcome) {
    await scheduleDelivery(connection, scheduler, { turnId: row.id, customerId: conversation.customer_id });
  }
  await scheduleNext(connection, conversation.id, row, scheduler);
  return { recorded: true, outcome };
}

async function insertOutcome(
  connection: Connection,
  conversation: ConversationRow,
  turnId: string,
  input: OutcomeInput,
  usage?: TokenUsage | undefined,
): Promise<RecordedOutcome> {
  let recorded: RecordedOutcome;
  if (input.outcome === 'fallback') {
    const resolved = await fallbackMessageFor(connection, input.trigger);
    recorded = { ...input, message: resolved.message, source: resolved.source };
  } else {
    recorded = input;
  }

  await connection.query(
    `INSERT INTO conversation_turn_outcomes
       (turn_id, tenant_id, conversation_id, outcome, message, fallback_trigger, fallback_cause, fallback_source,
        handoff_reason, withheld_reason, delivery_state, input_tokens, output_tokens)
     VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12)`,
    [
      turnId,
      conversation.id,
      recorded.outcome,
      'message' in recorded ? recorded.message : null,
      recorded.outcome === 'fallback' ? recorded.trigger : null,
      recorded.outcome === 'fallback' ? recorded.cause : null,
      recorded.outcome === 'fallback' ? recorded.source : null,
      recorded.outcome === 'handoff' ? JSON.stringify(recorded.reason) : null,
      recorded.outcome === 'withheld' ? recorded.reason : null,
      'message' in recorded ? 'pending' : null,
      usage?.inputTokens ?? null,
      usage?.outputTokens ?? null,
    ],
  );

  if (recorded.outcome === 'handoff') {
    const reason = JSON.stringify(recorded.reason);
    await connection.query(
      `UPDATE conversations SET handoff_paused_at = now(), handoff_reason = $2::jsonb
        WHERE tenant_id = app.current_tenant_id() AND id = $1`,
      [conversation.id, reason],
    );
    await connection.query(
      `INSERT INTO conversation_handoff_events (tenant_id, conversation_id, event, reason, turn_id)
       VALUES (app.current_tenant_id(), $1, 'paused', $2::jsonb, $3)`,
      [conversation.id, reason, turnId],
    );
  }
  return recorded;
}

/** Schedule the next closed turn of the conversation, which waited behind this one. */
async function scheduleNext(
  connection: Connection,
  conversationId: string,
  answered: TurnRow,
  scheduler: TurnScheduler,
): Promise<void> {
  const next = await connection.query<{ id: string }>(
    `SELECT t.id FROM conversation_turns t
      WHERE t.tenant_id = app.current_tenant_id() AND t.conversation_id = $1 AND t.sequence > $2::bigint
        AND t.state = 'closed'
        AND NOT EXISTS (SELECT 1 FROM conversation_turn_outcomes o WHERE o.turn_id = t.id)
      ORDER BY t.sequence
      LIMIT 1`,
    [conversationId, answered.sequence],
  );
  const id = next.rows[0]?.id;
  if (id !== undefined) await scheduler.enqueueWithin(connection, turnJob(id, `turn:${id}:after:${answered.id}`, 0));
}

// ---------------------------------------------------------------------------
// Handoff pause and resume
// ---------------------------------------------------------------------------

export interface ConversationHandoffStatus {
  readonly customerId: string;
  readonly paused: boolean;
  readonly pausedAt: Date | undefined;
  readonly reason: HandoffSignal | undefined;
}

function handoffStatus(row: ConversationRow): ConversationHandoffStatus {
  return {
    customerId: row.customer_id,
    paused: row.handoff_paused_at !== null,
    pausedAt: row.handoff_paused_at ?? undefined,
    reason: row.handoff_reason ?? undefined,
  };
}

/** A conversation's handoff status as the API shows it. */
export function describeConversationHandoff(status: ConversationHandoffStatus): {
  readonly customerId: string;
  readonly paused: boolean;
  readonly pausedAt: string | null;
  readonly reason: HandoffSignal | null;
} {
  return {
    customerId: status.customerId,
    paused: status.paused,
    pausedAt: status.pausedAt?.toISOString() ?? null,
    reason: status.reason ?? null,
  };
}

/** Request fields for resuming a conversation. Anything else is refused by name. */
export const RESUME_FIELDS = ['customerId'] as const;

/** Validate a resume request: the end-customer's WhatsApp id. */
export function parseResumeInput(body: Readonly<Record<string, unknown>>): string {
  const issues: { key: string; reason: string }[] = [];
  const known = new Set<string>(RESUME_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
  const raw = body.customerId;
  if (typeof raw !== 'string' || !WHATSAPP_ID.test(raw)) {
    issues.push({ key: 'customerId', reason: 'is required and must be a WhatsApp id: digits only' });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return raw as string;
}

/**
 * Resume automated replies in a conversation paused for handoff
 * (`human-handoff.md` AC9), and record when and how (AC12).
 *
 * Only messages arriving from now on are answered: those held during the pause
 * were for the person who took over, and stay held. Resuming a conversation that
 * is not paused changes nothing and records nothing, so a double click is
 * harmless. There is deliberately no path from switching handoff off to resuming
 * (AC13): a paused conversation waits for this call.
 */
export async function resumeConversation(connection: Connection, customerId: string): Promise<ConversationHandoffStatus> {
  requireTenant(connection, 'resumeConversation');
  const existing = await connection.query<ConversationRow>(
    `SELECT id, customer_id, handoff_paused_at, handoff_reason FROM conversations
      WHERE tenant_id = app.current_tenant_id() AND customer_id = $1
      FOR UPDATE`,
    [customerId],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    return { customerId, paused: false, pausedAt: undefined, reason: undefined };
  }
  if (row.handoff_paused_at === null) return handoffStatus(row);
  await connection.query(
    `UPDATE conversations SET handoff_paused_at = NULL, handoff_reason = NULL
      WHERE tenant_id = app.current_tenant_id() AND id = $1`,
    [row.id],
  );
  await connection.query(
    `INSERT INTO conversation_handoff_events (tenant_id, conversation_id, event) VALUES (app.current_tenant_id(), $1, 'resumed')`,
    [row.id],
  );
  return { customerId, paused: false, pausedAt: undefined, reason: undefined };
}

/** Whether a conversation is paused for handoff, and why (`human-handoff.md` AC11). */
export async function readConversationHandoff(connection: Connection, customerId: string): Promise<ConversationHandoffStatus> {
  requireTenant(connection, 'readConversationHandoff');
  const result = await connection.query<ConversationRow>(
    `SELECT id, customer_id, handoff_paused_at, handoff_reason FROM conversations
      WHERE tenant_id = app.current_tenant_id() AND customer_id = $1`,
    [customerId],
  );
  const row = result.rows[0];
  return row === undefined ? { customerId, paused: false, pausedAt: undefined, reason: undefined } : handoffStatus(row);
}

export interface HandoffEvent {
  readonly event: 'paused' | 'resumed';
  readonly reason: HandoffSignal | undefined;
  readonly occurredAt: Date;
}

/** A conversation's pauses and resumptions, oldest first (`human-handoff.md` AC12). */
export async function readHandoffHistory(connection: Connection, customerId: string): Promise<HandoffEvent[]> {
  requireTenant(connection, 'readHandoffHistory');
  const result = await connection.query<{ event: 'paused' | 'resumed'; reason: HandoffSignal | null; occurred_at: Date }>(
    `SELECT e.event, e.reason, e.occurred_at FROM conversation_handoff_events e
       JOIN conversations c ON c.tenant_id = e.tenant_id AND c.id = e.conversation_id
      WHERE e.tenant_id = app.current_tenant_id() AND c.customer_id = $1
      ORDER BY e.id`,
    [customerId],
  );
  return result.rows.map((row) => ({ event: row.event, reason: row.reason ?? undefined, occurredAt: row.occurred_at }));
}
