/**
 * Reading conversations back — `client-conversation-visibility.md`.
 *
 * Read-only views over what the reply path stores. There is no copy of a
 * conversation "for display", so what a client reads here is what the worker
 * decided and the sender sent, and nothing can drift out of step with it.
 *
 * ## A conversation exists once a message does
 *
 * Both reads start from `inbound_messages`, not `conversations`. The `conversations`
 * row is created when the worker first looks at a customer, so starting there would
 * hide a customer who has just written from the client until a job has run, and hide
 * them for as long as the worker is down, which is exactly when a client most wants
 * to look. Every other kind of message counts too: one held while the bot was off or
 * the conversation paused was still received (`human-handoff.md` AC7), and the client
 * is the only one who can answer it.
 *
 * ## The order of a transcript
 *
 * A customer's messages are ordered by when they were sent, as everywhere else. A bot
 * message is placed by when it was decided, which is the database's clock, and
 * compared against send times that are Meta's and truncated to the second. Those can
 * disagree by more than a reply takes, and a reply listed above the question it
 * answers is simply wrong. So a bot message is never placed earlier than the latest
 * message of the turn it answers, and on a tie the customer's message comes first.
 *
 * A reply is deliberately not placed directly under its own turn. If the customer
 * wrote again while the model was thinking, the second message really did come first,
 * and "in the order they occurred" is what the spec asks for.
 *
 * The position does not move once written: it does not depend on delivery, so a reply
 * does not jump down the page when it is finally sent.
 *
 * ## An undelivered answer is shown, and says so
 *
 * A bot message appears from the moment it is decided, with its delivery state. Hiding
 * it until sent would make a failed send look like the bot never answered, and showing
 * it without the state would tell the client a customer received something they did not.
 *
 * ## Cursors are built in SQL
 *
 * `decided_at` has microseconds and a JavaScript `Date` has milliseconds. A cursor built
 * from a `Date` would sit slightly before the row it came from, so that row would come
 * back on the next page, or a neighbour within the same millisecond would be skipped.
 * The key is therefore read and compared as whole microseconds, never through a `Date`.
 *
 * ## Paging the list
 *
 * The list is ordered by recency, which changes as customers write. A conversation that
 * becomes active while a client is paging moves to the top, so it may be missed on a
 * later page until the list is reopened. That is the ordinary behaviour of a list
 * ordered by something that moves, and the alternative is a stale snapshot held
 * somewhere. The transcript has no such issue, because its order is fixed.
 *
 * ## Why the customer goes in the body
 *
 * Both routes are POST with the end-customer in a JSON body, like resuming a
 * conversation, because a phone number in a URL ends up in every proxy's access log,
 * and the phone number is exactly what `tenant-data-isolation.md` keeps away from
 * operator-visible diagnostics. It is the same reasoning that puts tokens in a URL
 * fragment.
 *
 * Nothing here takes a tenant. Everything runs on a connection already bound to one, so
 * another tenant's customer is not refused so much as not there: it reads the same as a
 * number that never wrote (AC8).
 */

import type { FallbackTrigger } from '@zeddev/bot';
import type { Connection } from '@zeddev/db';
import { NotFoundError, ValidationError } from '@zeddev/errors';
import type { InboundContent, InboundMessageType } from '@zeddev/whatsapp';
import type { DeliveryFailure, DeliveryState } from './delivery.ts';
import type { MediaUnderstandingFailure } from './media.ts';
import {
  describeConversationHandoff,
  readConversationHandoff,
  readHandoffHistory,
  requireTenant,
  WHATSAPP_ID,
  type ConversationHandoffStatus,
  type HandoffEvent,
  type InboundDisposition,
  type WithheldReason,
} from './turns.ts';

/**
 * How much one page may hold. A long-running customer's transcript has no natural end,
 * and one entry can hold 20,000 characters of transcribed speech, so an unbounded read
 * is an unbounded response. Every entry stays reachable through the cursors.
 */
export const TRANSCRIPT_LIMITS = {
  defaultPage: 50,
  maxPage: 200,
} as const;

export const CONVERSATION_LIST_FIELDS = ['activeSince', 'customer', 'cursor', 'limit', 'pausedOnly'] as const;
export const TRANSCRIPT_FIELDS = ['after', 'before', 'customerId', 'limit'] as const;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

type Issue = { key: string; reason: string };

function refuseUnknown(body: Readonly<Record<string, unknown>>, fields: readonly string[], issues: Issue[]): void {
  const known = new Set(fields);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
}

function readLimit(raw: unknown, issues: Issue[]): number {
  if (raw === undefined) return TRANSCRIPT_LIMITS.defaultPage;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > TRANSCRIPT_LIMITS.maxPage) {
    issues.push({ key: 'limit', reason: `must be a whole number from 1 to ${TRANSCRIPT_LIMITS.maxPage}` });
    return TRANSCRIPT_LIMITS.defaultPage;
  }
  return raw;
}

// Whole microseconds, then what breaks a tie. Bounded so a tampered cursor is refused
// here as a bad request rather than overflowing a bigint in the database as a 500.
const TRANSCRIPT_CURSOR = /^-?[0-9]{1,18}\.[01]\.[0-9]{1,18}$/;
const LIST_CURSOR = /^-?[0-9]{1,18}\.[0-9]{1,32}$/;
const INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:[0-9]{2})$/;
/** What people put in a phone number that a WhatsApp id does not have. */
const NUMBER_PUNCTUATION = /[\s()+.-]/g;

export interface ConversationListQuery {
  /** Part of the end-customer's number, in digits. */
  readonly customer: string | undefined;
  /** Only conversations with activity at or after this instant. */
  readonly activeSince: Date | undefined;
  /**
   * Only conversations waiting on a person. Not in the spec's minimum, but until
   * `human-handoff.md` AC6's notification exists this is the one way a client can
   * find out a customer is waiting.
   */
  readonly pausedOnly: boolean;
  readonly limit: number;
  readonly cursor: string | undefined;
}

export function parseConversationListInput(body: Readonly<Record<string, unknown>>): ConversationListQuery {
  const issues: Issue[] = [];
  refuseUnknown(body, CONVERSATION_LIST_FIELDS, issues);

  let customer: string | undefined;
  if (body.customer !== undefined) {
    // A client searches with the number as they have it written down.
    const digits = typeof body.customer === 'string' ? body.customer.replace(NUMBER_PUNCTUATION, '') : '';
    if (WHATSAPP_ID.test(digits)) customer = digits;
    else issues.push({ key: 'customer', reason: 'must be part of a phone number: up to 32 digits' });
  }

  let activeSince: Date | undefined;
  if (body.activeSince !== undefined) {
    const parsed = typeof body.activeSince === 'string' && INSTANT.test(body.activeSince) ? new Date(body.activeSince) : undefined;
    if (parsed !== undefined && !Number.isNaN(parsed.getTime())) activeSince = parsed;
    else issues.push({ key: 'activeSince', reason: 'must be an ISO 8601 instant with an offset' });
  }

  if (body.pausedOnly !== undefined && typeof body.pausedOnly !== 'boolean') {
    issues.push({ key: 'pausedOnly', reason: 'must be true or false' });
  }

  let cursor: string | undefined;
  if (body.cursor !== undefined) {
    if (typeof body.cursor === 'string' && LIST_CURSOR.test(body.cursor)) cursor = body.cursor;
    else issues.push({ key: 'cursor', reason: 'must be a cursor from an earlier page' });
  }

  const limit = readLimit(body.limit, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { customer, activeSince, pausedOnly: body.pausedOnly === true, limit, cursor };
}

export interface TranscriptQuery {
  readonly customerId: string;
  /** The page ending just before this cursor. With neither cursor, the latest page. */
  readonly before: string | undefined;
  /** The page starting just after this cursor. */
  readonly after: string | undefined;
  readonly limit: number;
}

export function parseTranscriptInput(body: Readonly<Record<string, unknown>>): TranscriptQuery {
  const issues: Issue[] = [];
  refuseUnknown(body, TRANSCRIPT_FIELDS, issues);

  const customerId = body.customerId;
  if (typeof customerId !== 'string' || !WHATSAPP_ID.test(customerId)) {
    issues.push({ key: 'customerId', reason: 'is required and must be a WhatsApp id: digits only' });
  }

  const readCursor = (key: 'before' | 'after'): string | undefined => {
    const raw = body[key];
    if (raw === undefined) return undefined;
    if (typeof raw === 'string' && TRANSCRIPT_CURSOR.test(raw)) return raw;
    issues.push({ key, reason: 'must be a cursor from an earlier page' });
    return undefined;
  };
  const before = readCursor('before');
  const after = readCursor('after');
  if (before !== undefined && after !== undefined) {
    issues.push({ key: 'after', reason: 'cannot be combined with before' });
  }

  const limit = readLimit(body.limit, issues);
  if (issues.length > 0) throw new ValidationError(issues);
  return { customerId: customerId as string, before, after, limit };
}

// ---------------------------------------------------------------------------
// The conversation list
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  /** The end-customer's WhatsApp number: the only identity of theirs the platform keeps. */
  readonly customerId: string;
  /** The latest message in either direction. */
  readonly lastActivityAt: Date;
  readonly handoff: ConversationHandoffStatus;
}

export interface ConversationListPage {
  /** Most recently active first. */
  readonly conversations: readonly ConversationSummary[];
  /** Pass as `cursor` for the next page; undefined on the last. */
  readonly nextCursor: string | undefined;
}

/** One tenant's conversations, most recently active first (AC1, AC6). */
export async function listConversations(connection: Connection, query: ConversationListQuery): Promise<ConversationListPage> {
  requireTenant(connection, 'listConversations');
  const params: unknown[] = [];
  const param = (value: unknown, cast: string): string => {
    params.push(value);
    return `$${params.length}::${cast}`;
  };

  const conditions: string[] = [];
  // Digits only by now (`parseConversationListInput`), so it cannot hold a wildcard.
  if (query.customer !== undefined) conditions.push(`customer_id LIKE '%' || ${param(query.customer, 'text')} || '%'`);
  if (query.activeSince !== undefined) conditions.push(`last_activity_at >= ${param(query.activeSince, 'timestamptz')}`);
  if (query.pausedOnly) conditions.push('handoff_paused_at IS NOT NULL');
  if (query.cursor !== undefined) {
    const separator = query.cursor.indexOf('.');
    const micros = param(query.cursor.slice(0, separator), 'bigint');
    const customer = param(query.cursor.slice(separator + 1), 'text');
    conditions.push(`(micros < ${micros} OR (micros = ${micros} AND customer_id > ${customer}))`);
  }
  const limit = param(query.limit + 1, 'integer');

  const result = await connection.query<{
    customer_id: string;
    last_activity_at: Date;
    micros: string;
    handoff_paused_at: Date | null;
    handoff_reason: ConversationHandoffStatus['reason'] | null;
  }>(
    `WITH received AS (
       SELECT customer_id, max(sent_at) AS last_at FROM inbound_messages
        WHERE tenant_id = app.current_tenant_id()
        GROUP BY customer_id
     ), said AS (
       SELECT c.customer_id, max(o.decided_at) AS last_at
         FROM conversation_turn_outcomes o
         JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
        WHERE o.tenant_id = app.current_tenant_id() AND o.message IS NOT NULL
        GROUP BY c.customer_id
     ), summary AS (
       SELECT r.customer_id, GREATEST(r.last_at, s.last_at) AS last_activity_at, c.handoff_paused_at, c.handoff_reason
         FROM received r
         LEFT JOIN said s ON s.customer_id = r.customer_id
         LEFT JOIN conversations c ON c.tenant_id = app.current_tenant_id() AND c.customer_id = r.customer_id
     ), keyed AS (
       SELECT *, (extract(epoch FROM last_activity_at) * 1000000)::bigint AS micros FROM summary
     )
     SELECT customer_id, last_activity_at, micros::text AS micros, handoff_paused_at, handoff_reason
       FROM keyed
      ${conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`}
      ORDER BY keyed.micros DESC, customer_id
      LIMIT ${limit}`,
    params,
  );

  const page = result.rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    conversations: page.map((row) => ({
      customerId: row.customer_id,
      lastActivityAt: row.last_activity_at,
      handoff: {
        customerId: row.customer_id,
        paused: row.handoff_paused_at !== null,
        pausedAt: row.handoff_paused_at ?? undefined,
        reason: row.handoff_reason ?? undefined,
      },
    })),
    nextCursor: result.rows.length > query.limit && last !== undefined ? `${last.micros}.${last.customer_id}` : undefined,
  };
}

// ---------------------------------------------------------------------------
// The transcript
// ---------------------------------------------------------------------------

/**
 * What was made of a photo or voice note.
 *
 * `not_examined` is a message nobody has looked at: its turn has not been answered yet,
 * or it was held and never will be (`understandTurnMedia` runs only for a turn being
 * answered). The media itself is not kept, so there is nothing more to show of it.
 */
export type MediaRepresentation =
  | { readonly status: 'understood'; readonly text: string }
  | { readonly status: 'failed'; readonly failure: MediaUnderstandingFailure }
  | { readonly status: 'not_examined' };

interface CustomerEntryBase {
  readonly from: 'customer';
  readonly id: string;
  readonly at: Date;
  /** Why this message got no answer from the bot, when that is why. */
  readonly heldReason: WithheldReason | null;
}

export type CustomerEntry = CustomerEntryBase &
  (
    | { readonly type: 'text'; readonly text: string }
    | { readonly type: 'image'; readonly caption: string | null; readonly understanding: MediaRepresentation }
    | { readonly type: 'audio'; readonly voice: boolean; readonly understanding: MediaRepresentation }
    /** A type the platform cannot read, named as WhatsApp names it. */
    | { readonly type: 'unsupported'; readonly upstreamType: string }
  );

export interface BotEntry {
  readonly from: 'bot';
  /** The turn this answers. */
  readonly id: string;
  readonly at: Date;
  readonly kind: 'reply' | 'fallback';
  readonly text: string;
  /** Which situation produced a fallback (`fallback-response-behavior.md` AC10). */
  readonly fallbackTrigger: FallbackTrigger | null;
  readonly delivery: { readonly state: DeliveryState; readonly failure: DeliveryFailure | null };
}

export type TranscriptEntry = CustomerEntry | BotEntry;

export interface TranscriptPage {
  readonly customerId: string;
  readonly handoff: ConversationHandoffStatus;
  readonly handoffHistory: readonly HandoffEvent[];
  /** Oldest first, whichever way the page was reached. */
  readonly entries: readonly TranscriptEntry[];
  /** Pass as `before` for the page above this one; undefined when this is the start. */
  readonly earlierCursor: string | undefined;
  /**
   * Pass as `after` for what follows. Present even at the end of the transcript, so a
   * client can ask again later for only what is new (AC3). An empty page means nothing
   * has been added yet.
   */
  readonly laterCursor: string | undefined;
}

interface StoredMessage {
  readonly type: InboundMessageType;
  readonly upstreamType: string;
  readonly content: InboundContent;
  readonly understood: { readonly text: string | null; readonly failure: MediaUnderstandingFailure | null } | undefined;
}

function representation(understood: StoredMessage['understood']): MediaRepresentation {
  if (understood === undefined) return { status: 'not_examined' };
  if (understood.failure !== null) return { status: 'failed', failure: understood.failure };
  return { status: 'understood', text: understood.text ?? '' };
}

/**
 * The client's view of one stored message.
 *
 * Built field by field rather than passing `content` through. It holds Meta's media
 * reference, which is no use to a client and would make a storage detail part of the
 * API. It says nothing of the media's bytes, because those were never kept (§4v).
 */
export function describeStoredMessage(message: StoredMessage): DistributiveOmit<CustomerEntry, keyof CustomerEntryBase> {
  const content = message.content as Record<string, unknown>;
  switch (message.type) {
    case 'text':
      return { type: 'text', text: typeof content.text === 'string' ? content.text : '' };
    case 'image':
      return {
        type: 'image',
        caption: typeof content.caption === 'string' && content.caption.trim() !== '' ? content.caption : null,
        understanding: representation(message.understood),
      };
    case 'audio':
      return { type: 'audio', voice: content.voice === true, understanding: representation(message.understood) };
    case 'unsupported':
      return { type: 'unsupported', upstreamType: message.upstreamType };
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface TimelineRow {
  id: string;
  occurred_at: Date;
  micros: string;
  origin_rank: number;
  seq: string;
  message_type: InboundMessageType | null;
  upstream_type: string | null;
  content: InboundContent | null;
  understanding_exists: boolean;
  understood_text: string | null;
  understanding_failure: MediaUnderstandingFailure | null;
  disposition: InboundDisposition | null;
  withheld_reason: WithheldReason | null;
  outcome: 'reply' | 'fallback' | null;
  bot_message: string | null;
  fallback_trigger: FallbackTrigger | null;
  delivery_state: DeliveryState | null;
  delivery_failure: DeliveryFailure | null;
}

/** A message held at admission and one whose turn was withheld are the same thing to a client. */
function heldReasonOf(row: TimelineRow): WithheldReason | null {
  if (row.disposition === 'held_bot_inactive') return 'bot_inactive';
  if (row.disposition === 'held_handoff_paused') return 'handoff_paused';
  return row.withheld_reason;
}

function entryOf(row: TimelineRow): TranscriptEntry {
  if (row.origin_rank === 1) {
    return {
      from: 'bot',
      id: row.id,
      at: row.occurred_at,
      kind: row.outcome as 'reply' | 'fallback',
      text: row.bot_message as string,
      fallbackTrigger: row.fallback_trigger,
      delivery: { state: row.delivery_state as DeliveryState, failure: row.delivery_failure },
    };
  }
  return {
    from: 'customer',
    id: row.id,
    at: row.occurred_at,
    heldReason: heldReasonOf(row),
    ...describeStoredMessage({
      type: row.message_type as InboundMessageType,
      upstreamType: row.upstream_type as string,
      content: row.content as InboundContent,
      understood: row.understanding_exists ? { text: row.understood_text, failure: row.understanding_failure } : undefined,
    }),
  } as CustomerEntry;
}

function cursorOf(row: TimelineRow): string {
  return `${row.micros}.${row.origin_rank}.${row.seq}`;
}

/**
 * One page of the conversation with `customerId`, in the order it happened (AC2).
 *
 * With no cursor, the latest page: a client opening a conversation wants to see where it
 * has got to. `NotFoundError` when this tenant has no message from that number, which is
 * also what another tenant's customer looks like (AC8).
 */
export async function readTranscript(connection: Connection, query: TranscriptQuery): Promise<TranscriptPage> {
  requireTenant(connection, 'readTranscript');
  const exists = await connection.query(
    `SELECT 1 FROM inbound_messages WHERE tenant_id = app.current_tenant_id() AND customer_id = $1 LIMIT 1`,
    [query.customerId],
  );
  if (exists.rows.length === 0) throw new NotFoundError('a conversation with this customer');

  const params: unknown[] = [query.customerId, query.limit + 1];
  const forward = query.after !== undefined;
  const cursor = query.after ?? query.before;
  let where = '';
  if (cursor !== undefined) {
    params.push(...cursor.split('.'));
    where = `WHERE (micros, origin_rank, seq) ${forward ? '>' : '<'} ($3::bigint, $4::integer, $5::bigint)`;
  }
  const direction = forward ? 'ASC' : 'DESC';

  const result = await connection.query<TimelineRow>(
    `WITH timeline AS (
       SELECT m.id::text AS id, m.sent_at AS occurred_at, 0 AS origin_rank, m.position AS seq,
              m.message_type, m.upstream_type, m.content,
              u.inbound_message_id IS NOT NULL AS understanding_exists, u.understood_text,
              u.failure AS understanding_failure, d.disposition, o.withheld_reason,
              NULL::text AS outcome, NULL::text AS bot_message, NULL::text AS fallback_trigger,
              NULL::text AS delivery_state, NULL::text AS delivery_failure
         FROM inbound_messages m
         LEFT JOIN inbound_media_understandings u ON u.inbound_message_id = m.id
         LEFT JOIN inbound_dispositions d ON d.inbound_message_id = m.id
         LEFT JOIN conversation_turn_outcomes o ON o.turn_id = d.turn_id
        WHERE m.tenant_id = app.current_tenant_id() AND m.customer_id = $1
       UNION ALL
       SELECT o.turn_id::text,
              GREATEST(o.decided_at, (SELECT max(asked.sent_at)
                                        FROM inbound_dispositions ad
                                        JOIN inbound_messages asked ON asked.id = ad.inbound_message_id
                                       WHERE ad.turn_id = o.turn_id)),
              1, t.sequence,
              NULL, NULL, NULL, false, NULL, NULL, NULL, NULL,
              o.outcome, o.message, o.fallback_trigger, o.delivery_state, o.delivery_failure
         FROM conversation_turn_outcomes o
         JOIN conversation_turns t ON t.id = o.turn_id
         JOIN conversations c ON c.tenant_id = o.tenant_id AND c.id = o.conversation_id
        WHERE o.tenant_id = app.current_tenant_id() AND c.customer_id = $1 AND o.message IS NOT NULL
     ), keyed AS (
       SELECT *, (extract(epoch FROM occurred_at) * 1000000)::bigint AS micros FROM timeline
     )
     SELECT id, occurred_at, micros::text AS micros, origin_rank, seq::text AS seq, message_type, upstream_type, content,
            understanding_exists, understood_text, understanding_failure, disposition, withheld_reason,
            outcome, bot_message, fallback_trigger, delivery_state, delivery_failure
       FROM keyed
       ${where}
      ORDER BY keyed.micros ${direction}, keyed.origin_rank ${direction}, keyed.seq ${direction}
      LIMIT $2::integer`,
    params,
  );

  const overflow = result.rows.length > query.limit;
  const taken = result.rows.slice(0, query.limit);
  const rows = forward ? taken : taken.reverse();
  const first = rows[0];
  const last = rows.at(-1);

  return {
    customerId: query.customerId,
    handoff: await readConversationHandoff(connection, query.customerId),
    handoffHistory: await readHandoffHistory(connection, query.customerId),
    entries: rows.map(entryOf),
    // Going forward there is always something above: at the least, what the cursor named.
    earlierCursor: forward ? (first === undefined ? query.after : cursorOf(first)) : overflow && first !== undefined ? cursorOf(first) : undefined,
    laterCursor: last === undefined ? cursor : cursorOf(last),
  };
}

// ---------------------------------------------------------------------------
// As the API shows them
// ---------------------------------------------------------------------------

export function describeConversationSummary(summary: ConversationSummary) {
  return { ...describeConversationHandoff(summary.handoff), lastActivityAt: summary.lastActivityAt.toISOString() };
}

export function describeTranscript(page: TranscriptPage) {
  return {
    ...describeConversationHandoff(page.handoff),
    handoffHistory: page.handoffHistory.map((event) => ({
      event: event.event,
      reason: event.reason ?? null,
      occurredAt: event.occurredAt.toISOString(),
    })),
    entries: page.entries.map((entry) => ({ ...entry, at: entry.at.toISOString() })),
    earlierCursor: page.earlierCursor ?? null,
    laterCursor: page.laterCursor ?? null,
  };
}
