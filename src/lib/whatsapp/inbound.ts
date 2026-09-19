/**
 * Inbound WhatsApp messages — `message-delivery-reliability.md`.
 *
 * Everything the gateway needs between "bytes arrived" and "a message is stored
 * once and scheduled once", as functions a test can drive without a server:
 *
 * 1. **Authenticity** — `verifyWebhookSignature`. Meta signs every notification
 *    with the app secret (`X-Hub-Signature-256`); anything else is refused and
 *    recorded (AC2).
 * 2. **Shape** — `parseWebhookNotification` turns the upstream envelope into the
 *    platform's own vocabulary, per receiving number, and sets aside what it
 *    cannot read rather than guessing (a malformed part is recorded, the rest of
 *    the notification still counts).
 * 3. **Attribution** — `attributeInboundNumber`. The tenant is derived from the
 *    number that received the message, through `whatsapp_number_routes`, and
 *    never from anything else in the notification (AC3). No route, no tenant: the
 *    notification is refused and recorded, never processed against a guess.
 * 4. **Duplicate suppression** — `recordInboundMessage`. The stored message *is*
 *    the suppression record: `(tenant_id, external_id)` is unique, a redelivery
 *    inserts nothing, and the caller enqueues work only for a message that was
 *    actually inserted (AC4). Because the record is the message, it lives exactly
 *    as long as the message does, which answers the spec's open question about
 *    how long suppression must last with "as long as it could matter".
 * 5. **Ordering** — `listInboundMessages` orders by the end-customer's send time,
 *    not by arrival (AC5).
 *
 * What is deliberately *not* decided here is whether to reply. A message to a
 * bot that is switched off, or in a conversation paused for handoff, is received,
 * attributed, deduplicated, and stored exactly like any other (AC11, AC12); the
 * conversation worker asks `mayAutoRespond` in its own sending transaction.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { withInboundScope, type Connection, type Pool } from '@zeddev/db';
import { ConflictError, DefectError, ValidationError } from '@zeddev/errors';
import type { Secret } from '@zeddev/secrets';

/**
 * The queue inbound work is scheduled on, and the job kind. Shared constants
 * because the gateway enqueues and the conversation worker consumes, and a
 * spelling difference between two copies would be a queue nothing ever drains.
 */
export const INBOUND_QUEUE = 'inbound_messages';
export const INBOUND_JOB_KIND = 'inbound_message';

/**
 * What the platform understands. Everything else is stored as `unsupported` with
 * its upstream type name, so the reply path can answer it (with the fallback)
 * rather than the message silently vanishing. Mirrored by a CHECK in migration 0013.
 */
export const INBOUND_MESSAGE_TYPES = ['text', 'image', 'audio', 'unsupported'] as const;
export type InboundMessageType = (typeof INBOUND_MESSAGE_TYPES)[number];

/** Why a notification, or part of one, was refused. Mirrored by a CHECK in migration 0013. */
export const INBOUND_REJECTION_REASONS = [
  'signature_missing',
  'signature_invalid',
  'malformed',
  'unattributable',
] as const;
export type InboundRejectionReason = (typeof INBOUND_REJECTION_REASONS)[number];

export type InboundContent =
  | { readonly text: string }
  | { readonly mediaId: string; readonly mimeType: string; readonly caption?: string }
  | { readonly mediaId: string; readonly mimeType: string; readonly voice: boolean }
  | Readonly<Record<string, never>>;

/** One message as the upstream described it, normalised. */
export interface InboundMessage {
  /** The upstream's message id (`wamid.…`) — the duplicate-suppression key. */
  readonly externalId: string;
  /** The end-customer's WhatsApp id: their number, digits only. */
  readonly customerId: string;
  readonly type: InboundMessageType;
  /** The upstream's own type name, kept so an unsupported type can be told apart later. */
  readonly upstreamType: string;
  readonly content: InboundContent;
  /** When the end-customer sent it, per the upstream (one-second resolution). */
  readonly sentAt: Date;
}

/** Messages received on one number within one notification. */
export interface InboundBatch {
  /** The upstream id of the receiving number — what attribution keys on. */
  readonly phoneNumberId: string;
  readonly messages: readonly InboundMessage[];
}

export interface InboundRejection {
  readonly reason: InboundRejectionReason;
  /** The receiving number's upstream id, when the notification could be trusted to name it. */
  readonly phoneNumberId: string | null;
  readonly messageCount: number;
}

export interface ParsedNotification {
  readonly batches: readonly InboundBatch[];
  /** Parts that could not be read. Recorded, never processed. */
  readonly malformed: readonly InboundRejection[];
  /** Delivery receipts for outbound messages; not consumed yet (outbound is not built). */
  readonly statusCount: number;
}

// ---------------------------------------------------------------------------
// Authenticity
// ---------------------------------------------------------------------------

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/i;

/**
 * Check `X-Hub-Signature-256` against the raw body.
 *
 * Over the *raw bytes*, never over a re-serialised parse: the signature covers
 * what Meta sent, and `JSON.stringify(JSON.parse(body))` is not that (escapes and
 * whitespace differ), so verifying the re-serialised form would reject genuine
 * notifications — or, worse, a lenient comparison would start accepting forged
 * ones. Compared in constant time so the check leaks nothing about how close a
 * forgery came.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: Secret,
): 'valid' | 'signature_missing' | 'signature_invalid' {
  if (header === undefined || header.trim() === '') return 'signature_missing';
  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (match === null) return 'signature_invalid';
  const presented = Buffer.from(match[1]!.toLowerCase(), 'hex');
  const expected = createHmac('sha256', appSecret.expose()).update(rawBody).digest();
  return timingSafeEqual(presented, expected) ? 'valid' : 'signature_invalid';
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

const DIGITS = /^[0-9]{1,32}$/;
// Printable ASCII only. Upstream ids are base64-ish; anything else is not one.
const EXTERNAL_ID = /^[\x21-\x7e]{1,256}$/;
const UPSTREAM_TYPE = /^[a-z_]{1,40}$/;
const MIME_TYPE = /^[a-z0-9.+-]{1,64}\/[a-z0-9.+-]{1,64}$/;
const TIMESTAMP = /^[0-9]{1,12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * PostgreSQL's `jsonb` cannot hold U+0000 and refuses the whole row if it sees
 * one. A NUL in an end-customer's text carries no meaning, so it is removed
 * rather than letting one character make the message unstorable — which, given
 * the upstream redelivers anything not acknowledged, would be a redelivery loop.
 */
function storable(text: string): string {
  return text.replaceAll('\u0000', '');
}

/** Normalise a media object, or undefined if it is not one. */
function media(value: unknown): { mediaId: string; mimeType: string; rest: Record<string, unknown> } | undefined {
  if (!isRecord(value)) return undefined;
  const { id, mime_type: mimeType } = value;
  if (typeof id !== 'string' || !DIGITS.test(id)) return undefined;
  if (typeof mimeType !== 'string') return undefined;
  // WhatsApp sends audio as e.g. "audio/ogg; codecs=opus"; the parameters say
  // nothing the provider port uses, and `imageMediaType`/`audioMediaType` in
  // `@zeddev/ai` key on the bare type.
  const bare = mimeType.split(';')[0]!.trim().toLowerCase();
  if (!MIME_TYPE.test(bare)) return undefined;
  return { mediaId: id, mimeType: bare, rest: value };
}

/** One upstream message, or undefined if it cannot be read. */
export function parseInboundMessage(value: unknown): InboundMessage | undefined {
  if (!isRecord(value)) return undefined;
  const { id, from, timestamp, type } = value;
  if (typeof id !== 'string' || !EXTERNAL_ID.test(id)) return undefined;
  if (typeof from !== 'string' || !DIGITS.test(from)) return undefined;
  if (typeof timestamp !== 'string' || !TIMESTAMP.test(timestamp)) return undefined;
  if (typeof type !== 'string' || !UPSTREAM_TYPE.test(type)) return undefined;
  const sentAt = new Date(Number(timestamp) * 1000);
  const base = { externalId: id, customerId: from, upstreamType: type, sentAt };

  switch (type) {
    case 'text': {
      const text = isRecord(value.text) ? value.text.body : undefined;
      if (typeof text !== 'string') return undefined;
      return { ...base, type: 'text', content: { text: storable(text) } };
    }
    case 'image': {
      const image = media(value.image);
      if (image === undefined) return undefined;
      const caption = image.rest.caption;
      return {
        ...base,
        type: 'image',
        content:
          typeof caption === 'string' && caption !== ''
            ? { mediaId: image.mediaId, mimeType: image.mimeType, caption: storable(caption) }
            : { mediaId: image.mediaId, mimeType: image.mimeType },
      };
    }
    case 'audio': {
      const audio = media(value.audio);
      if (audio === undefined) return undefined;
      return {
        ...base,
        type: 'audio',
        content: { mediaId: audio.mediaId, mimeType: audio.mimeType, voice: audio.rest.voice === true },
      };
    }
    default:
      // Stickers, video, documents, locations, reactions, and the upstream's own
      // "unsupported". Stored so the conversation has a record of them and the
      // reply path can answer; their bodies are not read.
      return { ...base, type: 'unsupported', content: {} };
  }
}

/**
 * Turn a notification into per-number batches.
 *
 * Only `messages` changes carry inbound messages. Anything the parser cannot read
 * is reported in `malformed` against the receiving number when that much was
 * readable, and the readable remainder still goes through: one bad message in a
 * notification must not cost the good ones beside it, because the upstream will
 * not redeliver a notification that was acknowledged.
 */
export function parseWebhookNotification(payload: unknown): ParsedNotification {
  const batches: InboundBatch[] = [];
  const malformed: InboundRejection[] = [];
  let statusCount = 0;

  if (!isRecord(payload) || payload.object !== 'whatsapp_business_account' || !Array.isArray(payload.entry)) {
    return { batches, malformed: [{ reason: 'malformed', phoneNumberId: null, messageCount: 0 }], statusCount };
  }

  for (const entry of payload.entry) {
    for (const change of arrayOf(isRecord(entry) ? entry.changes : undefined)) {
      if (!isRecord(change) || change.field !== 'messages' || !isRecord(change.value)) continue;
      const value = change.value;
      const rawMessages = arrayOf(value.messages);
      statusCount += arrayOf(value.statuses).length;
      if (rawMessages.length === 0) continue;

      const metadata = value.metadata;
      const phoneNumberId = isRecord(metadata) ? metadata.phone_number_id : undefined;
      if (typeof phoneNumberId !== 'string' || !DIGITS.test(phoneNumberId)) {
        malformed.push({ reason: 'malformed', phoneNumberId: null, messageCount: rawMessages.length });
        continue;
      }

      const messages: InboundMessage[] = [];
      let unreadable = 0;
      for (const raw of rawMessages) {
        const message = parseInboundMessage(raw);
        if (message === undefined) unreadable += 1;
        else messages.push(message);
      }
      if (unreadable > 0) malformed.push({ reason: 'malformed', phoneNumberId, messageCount: unreadable });
      if (messages.length > 0) batches.push({ phoneNumberId, messages });
    }
  }
  return { batches, malformed, statusCount };
}

// ---------------------------------------------------------------------------
// Routes and attribution
// ---------------------------------------------------------------------------

function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, {
      code: 'whatsapp.tenant_unbound',
    });
  }
}

/**
 * Route a receiving number to the bound tenant.
 *
 * Called by the connection flow while the connection is `connecting` — the number
 * is known once the client has authorized it, and messages must reach the tenant
 * from then on, because verifying the link "able to send and receive" before
 * marking it connected needs a message to arrive. Refused in any other state:
 * routing a number to a `disconnected` tenant would make a number the tenant gave
 * up attributable again, and the migration's trigger removes the route on every
 * move to `disconnected` precisely so that cannot happen.
 *
 * A tenant has at most one route, so assigning replaces the tenant's previous
 * number rather than adding a second (v1's single-number rule). A number already
 * routed to another tenant is a conflict: one number, one tenant.
 */
export async function assignPhoneNumber(connection: Connection, phoneNumberId: string): Promise<void> {
  requireTenant(connection, 'assignPhoneNumber');
  if (!DIGITS.test(phoneNumberId)) {
    throw new ValidationError([{ key: 'phoneNumberId', reason: 'must be the upstream numeric phone number id' }]);
  }
  const state = await connection.query<{ state: string }>(
    'SELECT state FROM whatsapp_connections WHERE tenant_id = app.current_tenant_id() FOR UPDATE',
  );
  if (state.rows[0]?.state !== 'connecting') {
    throw new ConflictError('A number can only be assigned while the connection is being set up.', {
      code: 'whatsapp.number.not_connecting',
    });
  }
  await connection.query('DELETE FROM whatsapp_number_routes WHERE tenant_id = app.current_tenant_id()');
  const inserted = await connection.query(
    `INSERT INTO whatsapp_number_routes (phone_number_id, tenant_id)
     VALUES ($1, app.current_tenant_id())
     ON CONFLICT (phone_number_id) DO NOTHING
     RETURNING phone_number_id`,
    [phoneNumberId],
  );
  if (inserted.rows.length === 0) {
    throw new ConflictError('This WhatsApp number is already connected to another account.', {
      code: 'whatsapp.number.in_use',
    });
  }
}

/** The bound tenant's routed number, if it has one. */
export async function readPhoneNumber(connection: Connection): Promise<string | undefined> {
  requireTenant(connection, 'readPhoneNumber');
  const result = await connection.query<{ phone_number_id: string }>(
    'SELECT phone_number_id FROM whatsapp_number_routes WHERE tenant_id = app.current_tenant_id()',
  );
  return result.rows[0]?.phone_number_id;
}

/**
 * The tenant a receiving number belongs to, or undefined.
 *
 * The only cross-tenant read on the inbound path, and it reads one table holding
 * one fact: which tenant a number routes to. Undefined means the notification
 * must be refused — there is no second guess.
 */
export async function attributeInboundNumber(pool: Pool, phoneNumberId: string): Promise<string | undefined> {
  if (!DIGITS.test(phoneNumberId)) return undefined;
  return withInboundScope(pool, async (tx) => {
    const result = await tx.query<{ tenant_id: string }>(
      'SELECT tenant_id FROM whatsapp_number_routes WHERE phone_number_id = $1',
      [phoneNumberId],
    );
    return result.rows[0]?.tenant_id;
  });
}

/**
 * Record a refused notification, or part of one (AC2, AC3).
 *
 * Operational fields only — the table has no column that could hold a body or a
 * sender (AC17). A number id is recorded only when the notification could be
 * trusted to name one: from an unauthentic request it is attacker-chosen text,
 * so callers pass null for those.
 */
export async function recordInboundRejection(pool: Pool, rejection: InboundRejection): Promise<void> {
  const phoneNumberId =
    rejection.phoneNumberId !== null && DIGITS.test(rejection.phoneNumberId) ? rejection.phoneNumberId : null;
  await withInboundScope(pool, (tx) =>
    tx.query('INSERT INTO inbound_rejections (reason, phone_number_id, message_count) VALUES ($1, $2, $3)', [
      rejection.reason,
      phoneNumberId,
      Math.max(0, Math.trunc(rejection.messageCount)),
    ]),
  );
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StoredInboundMessage extends InboundMessage {
  readonly id: string;
  readonly phoneNumberId: string;
  readonly receivedAt: Date;
}

interface InboundRow {
  id: string;
  external_id: string;
  phone_number_id: string;
  customer_id: string;
  message_type: InboundMessageType;
  upstream_type: string;
  content: InboundContent;
  sent_at: Date;
  received_at: Date;
}

const COLUMNS =
  'id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at';

function fromRow(row: InboundRow): StoredInboundMessage {
  return {
    id: row.id,
    externalId: row.external_id,
    phoneNumberId: row.phone_number_id,
    customerId: row.customer_id,
    type: row.message_type,
    upstreamType: row.upstream_type,
    content: row.content,
    sentAt: row.sent_at,
    receivedAt: row.received_at,
  };
}

/**
 * Store one inbound message for the bound tenant, once.
 *
 * `created: false` means this message was already stored — a redelivery — and the
 * caller must not schedule it again. The caller schedules in this same
 * transaction, so "stored" and "scheduled" commit together or not at all: stored
 * but unscheduled would never be answered, and scheduled but unstored would
 * escape duplicate suppression.
 */
export async function recordInboundMessage(
  connection: Connection,
  phoneNumberId: string,
  message: InboundMessage,
): Promise<{ readonly id: string; readonly created: boolean }> {
  requireTenant(connection, 'recordInboundMessage');
  const inserted = await connection.query<{ id: string }>(
    `INSERT INTO inbound_messages
       (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at)
     VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (tenant_id, external_id) DO NOTHING
     RETURNING id`,
    [
      message.externalId,
      phoneNumberId,
      message.customerId,
      message.type,
      message.upstreamType,
      JSON.stringify(message.content),
      message.sentAt,
    ],
  );
  const created = inserted.rows[0];
  if (created !== undefined) return { id: created.id, created: true };

  const existing = await connection.query<{ id: string }>(
    'SELECT id FROM inbound_messages WHERE tenant_id = app.current_tenant_id() AND external_id = $1',
    [message.externalId],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    throw new DefectError('an inbound insert conflicted but no stored message was found', {
      code: 'whatsapp.inbound.lost',
    });
  }
  return { id: row.id, created: false };
}

/** One stored message of the bound tenant, by the platform's id. */
export async function readInboundMessage(
  connection: Connection,
  id: string,
): Promise<StoredInboundMessage | undefined> {
  requireTenant(connection, 'readInboundMessage');
  const result = await connection.query<InboundRow>(
    `SELECT ${COLUMNS} FROM inbound_messages
      WHERE tenant_id = app.current_tenant_id() AND id::text = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : fromRow(row);
}

/**
 * The bound tenant's inbound messages, in the order the end-customer sent them
 * (AC5) — by the upstream's send time, with arrival order breaking ties within
 * the same second, where the upstream gives nothing finer to order by.
 */
export async function listInboundMessages(
  connection: Connection,
  options: { readonly customerId?: string | undefined; readonly limit?: number | undefined } = {},
): Promise<StoredInboundMessage[]> {
  requireTenant(connection, 'listInboundMessages');
  const limit = Math.max(1, Math.min(options.limit ?? 100, 1000));
  const result = await connection.query<InboundRow>(
    `SELECT ${COLUMNS} FROM inbound_messages
      WHERE tenant_id = app.current_tenant_id()
        AND ($1::text IS NULL OR customer_id = $1)
      ORDER BY sent_at, position
      LIMIT $2`,
    [options.customerId ?? null, limit],
  );
  return result.rows.map(fromRow);
}
