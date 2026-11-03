/**
 * Reading conversations back, against a real PostgreSQL.
 *
 * The rows are written directly, at chosen instants, rather than driven through the
 * worker. What is under test is how a read orders and pages what is stored, and that
 * depends on `sent_at` and `decided_at` disagreeing in ways the worker's own clock would
 * not produce on demand. One test in `turns.test.ts` covers the real pipeline.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { saveDisclosureSetting, type HandoffSignal } from '@zeddev/bot';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { NotFoundError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import {
  describeStoredMessage,
  describeTranscript,
  listConversations,
  parseConversationListInput,
  parseTranscriptInput,
  readTranscript,
  TRANSCRIPT_LIMITS,
  type ConversationListQuery,
  type TranscriptEntry,
} from './transcript.ts';
import { readConversationHandoff, resumeConversation } from './turns.ts';

const VISIBILITY = 'client-conversation-visibility.md';
const HANDOFF = 'human-handoff.md';
const DISCLOSURE = 'bot-disclosure-setting.md';
const ISOLATION = 'tenant-data-isolation.md';
const FALLBACK = 'fallback-response-behavior.md';

const T0 = Date.parse('2026-03-02T10:00:00.000Z');
const at = (seconds: number): Date => new Date(T0 + seconds * 1000);

const PHONE_NUMBER_ID = '4400000001';
const HUMAN_REQUEST: HandoffSignal = { kind: 'trigger', trigger: 'human_request' };

function issueKeys(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    return error.issues.map((issue) => issue.key);
  }
  assert.fail('expected a validation error');
}

const listAll: ConversationListQuery = {
  customer: undefined,
  activeSince: undefined,
  pausedOnly: false,
  limit: TRANSCRIPT_LIMITS.defaultPage,
  cursor: undefined,
};

function textOf(entry: TranscriptEntry | undefined): string {
  assert.ok(entry !== undefined);
  return 'text' in entry ? entry.text : `<${entry.type}>`;
}

describe('reading conversations back', () => {
  unitTest('a stored message is described without Meta media reference, and an empty caption is no caption', () => {
    const described = describeStoredMessage({
      type: 'image',
      upstreamType: 'image',
      content: { mediaId: '9001', mimeType: 'image/jpeg', caption: '   ' },
      understood: { text: 'A red bicycle', failure: null },
    });
    assert.deepEqual(described, {
      type: 'image',
      caption: null,
      understanding: { status: 'understood', text: 'A red bicycle' },
    });
    assert.ok(!JSON.stringify(described).includes('9001'), 'a storage detail leaked into the API');
  });

  unitTest('a media message nobody looked at reads as not examined, not as understood or failed', () => {
    assert.deepEqual(
      describeStoredMessage({
        type: 'audio',
        upstreamType: 'audio',
        content: { mediaId: '1', mimeType: 'audio/ogg', voice: true },
        understood: undefined,
      }),
      { type: 'audio', voice: true, understanding: { status: 'not_examined' } },
    );
  });

  unitTest('the list input takes a number as people write it, and refuses anything else by name', () => {
    assert.equal(parseConversationListInput({ customer: '+55 (11) 5555-0100' }).customer, '551155550100');
    assert.deepEqual(parseConversationListInput({}), listAll);
    assert.equal(parseConversationListInput({ activeSince: '2026-03-02T10:00:00-03:00' }).activeSince?.toISOString(), '2026-03-02T13:00:00.000Z');
    assert.deepEqual(issueKeys(() => parseConversationListInput({ customer: 'a%' })), ['customer']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ customer: '---' })), ['customer']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ activeSince: 'yesterday' })), ['activeSince']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ activeSince: '2026-03-02' })), ['activeSince']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ pausedOnly: 'yes' })), ['pausedOnly']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ tenantId: 'x' })), ['tenantId']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ limit: 0 })), ['limit']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ limit: TRANSCRIPT_LIMITS.maxPage + 1 })), ['limit']);
    assert.deepEqual(issueKeys(() => parseConversationListInput({ limit: 1.5 })), ['limit']);
    // Past a bigint, so it has to be refused here rather than reach the database.
    assert.deepEqual(issueKeys(() => parseConversationListInput({ cursor: `${'9'.repeat(30)}.1` })), ['cursor']);
  });

  unitTest('the transcript input needs a customer, and at most one direction', () => {
    assert.deepEqual(issueKeys(() => parseTranscriptInput({})), ['customerId']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '+1 555' })), ['customerId']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '1', tenantId: 'x' })), ['tenantId']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '1', before: '1.0.1', after: '1.0.1' })), ['after']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '1', before: "1.0.1' OR 1=1" })), ['before']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '1', after: '1.2.1' })), ['after']);
    assert.deepEqual(issueKeys(() => parseTranscriptInput({ customerId: '1', after: `${'9'.repeat(30)}.0.1` })), ['after']);
    assert.equal(parseTranscriptInput({ customerId: '1', after: '-5.1.7' }).after, '-5.1.7');
  });
});

describe('conversation reads', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let tenantCounter = 0;
  let messageCounter = 0;

  before(async () => {
    db = await createTestDatabase('transcript');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  async function tenant(): Promise<string> {
    tenantCounter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Transcript Tailor ${tenantCounter}`],
      );
      return created.rows[0]!.id;
    });
  }

  interface Stored {
    readonly type?: 'text' | 'image' | 'audio' | 'unsupported';
    readonly upstreamType?: string;
    readonly content: Record<string, unknown>;
    readonly sentAt: Date;
    readonly receivedAt?: Date;
  }

  /** A message as the gateway stores it. */
  function store(tenantId: string, customer: string, message: Stored): Promise<string> {
    messageCounter += 1;
    const external = `wamid.transcript-${messageCounter}`;
    return withTenant(pool, tenantId, async (tx) => {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO inbound_messages
           (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
         VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         RETURNING id`,
        [
          external,
          PHONE_NUMBER_ID,
          customer,
          message.type ?? 'text',
          message.upstreamType ?? message.type ?? 'text',
          JSON.stringify(message.content),
          message.sentAt,
          message.receivedAt ?? message.sentAt,
        ],
      );
      return inserted.rows[0]!.id;
    });
  }

  const say = (tenantId: string, customer: string, text: string, sentAt: Date): Promise<string> =>
    store(tenantId, customer, { content: { text }, sentAt });

  async function conversationOf(tenantId: string, customer: string): Promise<string> {
    return withTenant(pool, tenantId, async (tx) => {
      await tx.query(
        `INSERT INTO conversations (tenant_id, customer_id) VALUES (app.current_tenant_id(), $1)
         ON CONFLICT (tenant_id, customer_id) DO NOTHING`,
        [customer],
      );
      const found = await tx.query<{ id: string }>('SELECT id FROM conversations WHERE customer_id = $1', [customer]);
      return found.rows[0]!.id;
    });
  }

  interface Answer {
    readonly text?: string;
    readonly decidedAt: Date | string;
    readonly kind?: 'reply' | 'fallback' | 'withheld';
    readonly delivery?: 'pending' | 'sent' | 'failed' | 'expired';
  }

  /** A closed turn over `messageIds`, and what the worker decided for it. */
  async function answer(tenantId: string, customer: string, messageIds: readonly string[], outcome: Answer): Promise<string> {
    const conversation = await conversationOf(tenantId, customer);
    return withTenant(pool, tenantId, async (tx) => {
      const opened = new Date(T0 - 60_000);
      const turn = await tx.query<{ id: string }>(
        `INSERT INTO conversation_turns (tenant_id, conversation_id, state, opened_at, closes_at, deadline_at, closed_at)
         VALUES (app.current_tenant_id(), $1, 'closed', $2, $2, $2, $2) RETURNING id`,
        [conversation, opened],
      );
      const turnId = turn.rows[0]!.id;
      for (const id of messageIds) {
        await tx.query(
          `INSERT INTO inbound_dispositions (inbound_message_id, tenant_id, conversation_id, turn_id, disposition)
           VALUES ($1, app.current_tenant_id(), $2, $3, 'aggregated')`,
          [id, conversation, turnId],
        );
      }
      const kind = outcome.kind ?? 'reply';
      const says = kind !== 'withheld';
      const delivery = says ? (outcome.delivery ?? 'sent') : null;
      await tx.query(
        `INSERT INTO conversation_turn_outcomes
           (turn_id, tenant_id, conversation_id, outcome, message, fallback_trigger, fallback_cause, fallback_source,
            withheld_reason, delivery_state, delivery_failure, delivery_message_id, decided_at)
         VALUES ($1, app.current_tenant_id(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::timestamptz)`,
        [
          turnId,
          conversation,
          kind,
          says ? (outcome.text ?? 'ok') : null,
          kind === 'fallback' ? 'ai_error' : null,
          kind === 'fallback' ? 'generation_failed' : null,
          kind === 'fallback' ? 'shared' : null,
          kind === 'withheld' ? 'bot_inactive' : null,
          delivery,
          delivery === 'failed' ? 'rejected' : delivery === 'expired' ? 'window_expired' : null,
          delivery === 'sent' ? `wamid.out-${turnId}` : null,
          outcome.decidedAt instanceof Date ? outcome.decidedAt.toISOString() : outcome.decidedAt,
        ],
      );
      return turnId;
    });
  }

  async function hold(tenantId: string, customer: string, id: string, disposition: 'held_bot_inactive' | 'held_handoff_paused'): Promise<void> {
    const conversation = await conversationOf(tenantId, customer);
    await withTenant(pool, tenantId, (tx) =>
      tx.query(
        `INSERT INTO inbound_dispositions (inbound_message_id, tenant_id, conversation_id, disposition)
         VALUES ($1, app.current_tenant_id(), $2, $3)`,
        [id, conversation, disposition],
      ),
    );
  }

  async function pause(tenantId: string, customer: string, reason: HandoffSignal): Promise<void> {
    const conversation = await conversationOf(tenantId, customer);
    await withTenant(pool, tenantId, async (tx) => {
      await tx.query(`UPDATE conversations SET handoff_paused_at = now(), handoff_reason = $2::jsonb WHERE id = $1`, [
        conversation,
        JSON.stringify(reason),
      ]);
      await tx.query(
        `INSERT INTO conversation_handoff_events (tenant_id, conversation_id, event, reason)
         VALUES (app.current_tenant_id(), $1, 'paused', $2::jsonb)`,
        [conversation, JSON.stringify(reason)],
      );
    });
  }

  async function understood(tenantId: string, messageId: string, text: string | null, failure: string | null): Promise<void> {
    await withTenant(pool, tenantId, (tx) =>
      tx.query(
        `INSERT INTO inbound_media_understandings (inbound_message_id, tenant_id, understood_text, failure, attempts)
         VALUES ($1, app.current_tenant_id(), $2, $3, 1)`,
        [messageId, text, failure],
      ),
    );
  }

  const list = (tenantId: string, query: Partial<ConversationListQuery> = {}) =>
    withTenant(pool, tenantId, (tx) => listConversations(tx, { ...listAll, ...query }));

  const transcript = (tenantId: string, customerId: string, query: { before?: string; after?: string; limit?: number } = {}) =>
    withTenant(pool, tenantId, (tx) =>
      readTranscript(tx, {
        customerId,
        before: query.before,
        after: query.after,
        limit: query.limit ?? TRANSCRIPT_LIMITS.maxPage,
      }),
    );

  // -------------------------------------------------------------------------
  // The list
  // -------------------------------------------------------------------------

  specTest(VISIBILITY, 'AC1 a client sees an entry for each of their end-customers', 'one entry per end-customer, including one the worker has not reached yet', async () => {
    const client = await tenant();
    const answered = '15550000001';
    const untouched = '15550000002';
    const first = await say(client, answered, 'first', at(0));
    await say(client, answered, 'second', at(1));
    await answer(client, answered, [first], { text: 'hi', decidedAt: at(2) });
    // No `conversations` row exists for this one: the worker has not looked yet.
    await say(client, untouched, 'just wrote', at(3));

    const page = await list(client);
    assert.deepEqual(page.conversations.map((entry) => entry.customerId), [untouched, answered]);
    assert.equal(page.conversations[0]!.handoff.paused, false);
    assert.equal(page.nextCursor, undefined);
    assert.deepEqual((await list(await tenant())).conversations, [], 'a client with no conversations sees none');
  });

  specTest(VISIBILITY, 'AC6 a search by identity or recency returns the matching conversations', 'filtering by part of the number, by recency, and by waiting on a person', async () => {
    const client = await tenant();
    await say(client, '5511555500001', 'old', at(0));
    await say(client, '5511555500002', 'recent', at(100));
    await say(client, '4420790000003', 'newest', at(200));
    await pause(client, '5511555500001', HUMAN_REQUEST);

    const customers = async (query: Partial<ConversationListQuery>) =>
      (await list(client, query)).conversations.map((entry) => entry.customerId);

    assert.deepEqual(await customers({}), ['4420790000003', '5511555500002', '5511555500001'], 'most recent first');
    assert.deepEqual(await customers({ customer: '55115555' }), ['5511555500002', '5511555500001'], 'by the start of the number');
    assert.deepEqual(await customers({ customer: '00003' }), ['4420790000003'], 'by the end of the number');
    assert.deepEqual(await customers({ customer: '999' }), []);
    assert.deepEqual(await customers({ activeSince: at(100) }), ['4420790000003', '5511555500002'], 'the boundary is inclusive');
    assert.deepEqual(await customers({ activeSince: at(100), customer: '5511' }), ['5511555500002'], 'filters combine');
    assert.deepEqual(await customers({ pausedOnly: true }), ['5511555500001']);
  });

  specTest(VISIBILITY, 'AC6 a search by identity or recency returns the matching conversations', "recency counts the bot's messages as well as the customer's", async () => {
    const client = await tenant();
    const quiet = await say(client, '15550000011', 'long ago', at(0));
    await say(client, '15550000012', 'more recently', at(50));
    await answer(client, '15550000011', [quiet], { text: 'answered late', decidedAt: at(100) });
    const page = await list(client);
    assert.deepEqual(page.conversations.map((entry) => entry.customerId), ['15550000011', '15550000012']);
    assert.deepEqual(page.conversations[0]!.lastActivityAt, at(100));
    assert.equal((await list(client, { activeSince: at(60) })).conversations.length, 1);
  });

  unitTest("a turn that said nothing is not activity", async () => {
    const client = await tenant();
    const message = await say(client, '15550000013', 'hello', at(0));
    await answer(client, '15550000013', [message], { kind: 'withheld', decidedAt: at(500) });
    const [entry] = (await list(client)).conversations;
    assert.deepEqual(entry!.lastActivityAt, at(0));
    assert.equal((await transcript(client, '15550000013')).entries.length, 1, 'and it adds nothing to the transcript');
  });

  unitTest('the list pages through every conversation once, across ties on recency', async () => {
    const client = await tenant();
    const customers = ['15550000021', '15550000022', '15550000023', '15550000024', '15550000025'];
    for (const customer of customers) await say(client, customer, 'same instant', at(0));
    await say(client, '15550000020', 'later', at(5));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await list(client, { limit: 2, cursor });
      seen.push(...page.conversations.map((entry) => entry.customerId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor !== undefined);
    assert.deepEqual(seen, ['15550000020', ...customers]);
    assert.equal(pages, 3, 'the last page is known to be last, with no empty page after it');
  });

  // -------------------------------------------------------------------------
  // The transcript
  // -------------------------------------------------------------------------

  specTest(VISIBILITY, 'AC2 a transcript shows every message in chronological order, attributed', 'both sides in order, each attributed, ordered by send time rather than arrival', async () => {
    const client = await tenant();
    const customer = '15550000031';
    // Delivered to the platform out of order: the later message arrives first.
    const second = await store(client, customer, { content: { text: 'second' }, sentAt: at(1), receivedAt: at(2) });
    const first = await store(client, customer, { content: { text: 'first' }, sentAt: at(0), receivedAt: at(3) });
    await answer(client, customer, [first, second], { text: 'the answer', decidedAt: at(4) });
    const third = await say(client, customer, 'third', at(5));
    await answer(client, customer, [third], { text: 'another answer', decidedAt: at(6) });

    const { entries } = await transcript(client, customer);
    assert.deepEqual(
      entries.map((entry) => [entry.from, textOf(entry)]),
      [
        ['customer', 'first'],
        ['customer', 'second'],
        ['bot', 'the answer'],
        ['customer', 'third'],
        ['bot', 'another answer'],
      ],
    );
    assert.deepEqual(entries[0]!.at, at(0));
  });

  specTest(VISIBILITY, 'AC2 a transcript shows every message in chronological order, attributed', 'a reply is never placed above the message it answers, whatever the two clocks say', async () => {
    const client = await tenant();
    const customer = '15550000032';
    // Meta's clock is ahead of the database's by more than the reply took.
    const asked = await say(client, customer, 'question', at(100));
    await answer(client, customer, [asked], { text: 'answer', decidedAt: at(98) });
    const { entries } = await transcript(client, customer);
    assert.deepEqual(entries.map((entry) => entry.from), ['customer', 'bot']);
    assert.deepEqual(entries[1]!.at, at(100), 'and it reads as no earlier than the question');
  });

  specTest(VISIBILITY, 'AC2 a transcript shows every message in chronological order, attributed', 'a message written while the model was thinking stays above the reply that came after it', async () => {
    const client = await tenant();
    const customer = '15550000033';
    const asked = await say(client, customer, 'question', at(0));
    await say(client, customer, 'also this', at(7));
    await answer(client, customer, [asked], { text: 'answer to the first', decidedAt: at(9) });
    const { entries } = await transcript(client, customer);
    assert.deepEqual(entries.map(textOf), ['question', 'also this', 'answer to the first']);
  });

  specTest(FALLBACK, 'AC10 a record exists showing a fallback occurred and which trigger caused it', 'a fallback reads as a fallback in the transcript, with its trigger', async () => {
    const client = await tenant();
    const customer = '15550000034';
    const asked = await say(client, customer, 'question', at(0));
    await answer(client, customer, [asked], { kind: 'fallback', text: 'Sorry, one moment.', decidedAt: at(1) });
    const bot = (await transcript(client, customer)).entries[1]!;
    assert.ok(bot.from === 'bot');
    assert.equal(bot.kind, 'fallback');
    assert.equal(bot.text, 'Sorry, one moment.');
    assert.equal(bot.fallbackTrigger, 'ai_error');
  });

  unitTest('an answer that was not delivered is shown, and says so', async () => {
    const client = await tenant();
    const customer = '15550000035';
    const states = ['pending', 'failed', 'expired', 'sent'] as const;
    for (const [index, delivery] of states.entries()) {
      const asked = await say(client, customer, `question ${index}`, at(index * 10));
      await answer(client, customer, [asked], { text: `answer ${index}`, decidedAt: at(index * 10 + 1), delivery });
    }
    const bots = (await transcript(client, customer)).entries.filter((entry) => entry.from === 'bot');
    assert.deepEqual(
      bots.map((entry) => (entry.from === 'bot' ? entry.delivery : undefined)),
      [
        { state: 'pending', failure: null },
        { state: 'failed', failure: 'rejected' },
        { state: 'expired', failure: 'window_expired' },
        { state: 'sent', failure: null },
      ],
    );
  });

  unitTest('a message whose answer was withheld or that was held says why it went unanswered', async () => {
    const client = await tenant();
    const customer = '15550000036';
    const withheld = await say(client, customer, 'withheld', at(0));
    await answer(client, customer, [withheld], { kind: 'withheld', decidedAt: at(1) });
    const held = await say(client, customer, 'held', at(2));
    await hold(client, customer, held, 'held_bot_inactive');
    await say(client, customer, 'undecided', at(3));
    const { entries } = await transcript(client, customer);
    assert.deepEqual(
      entries.map((entry) => (entry.from === 'customer' ? entry.heldReason : 'bot')),
      ['bot_inactive', 'bot_inactive', null],
    );
  });

  specTest(VISIBILITY, 'AC3 new messages from both sides appear when the conversation is viewed again', 'a re-open shows both new messages, and asking after the last cursor returns only what is new', async () => {
    const client = await tenant();
    const customer = '15550000041';
    const first = await say(client, customer, 'first', at(0));
    await answer(client, customer, [first], { text: 'reply one', decidedAt: at(1) });
    const opened = await transcript(client, customer);
    assert.equal(opened.entries.length, 2);

    const nothingYet = await transcript(client, customer, { after: opened.laterCursor! });
    assert.deepEqual(nothingYet.entries, []);
    assert.equal(nothingYet.laterCursor, opened.laterCursor, 'an empty refresh keeps the place');

    const second = await say(client, customer, 'second', at(10));
    await answer(client, customer, [second], { text: 'reply two', decidedAt: at(11) });

    assert.deepEqual((await transcript(client, customer)).entries.map(textOf), ['first', 'reply one', 'second', 'reply two']);
    const fresh = await transcript(client, customer, { after: opened.laterCursor! });
    assert.deepEqual(fresh.entries.map(textOf), ['second', 'reply two']);
  });

  specTest(VISIBILITY, 'AC4 a voice message shows its transcription or understood content', 'a voice note reads as what was said, and one that failed says it failed', async () => {
    const client = await tenant();
    const customer = '15550000042';
    const voice = { mediaId: '7', mimeType: 'audio/ogg', voice: true };
    const heard = await store(client, customer, { type: 'audio', content: voice, sentAt: at(0) });
    await understood(client, heard, 'I would like to change my booking', null);
    const lost = await store(client, customer, { type: 'audio', content: voice, sentAt: at(1) });
    await understood(client, lost, null, 'no_speech');
    const { entries } = await transcript(client, customer);
    assert.deepEqual(
      entries.map(({ at: _at, id: _id, ...rest }) => rest),
      [
        { from: 'customer', heldReason: null, type: 'audio', voice: true, understanding: { status: 'understood', text: 'I would like to change my booking' } },
        { from: 'customer', heldReason: null, type: 'audio', voice: true, understanding: { status: 'failed', failure: 'no_speech' } },
      ],
    );
  });

  specTest(VISIBILITY, 'AC5 an image shows what the bot understood from it', 'a photo reads as what was seen, with its caption, and carries no media reference', async () => {
    const client = await tenant();
    const customer = '15550000043';
    const photo = await store(client, customer, {
      type: 'image',
      content: { mediaId: '880011', mimeType: 'image/jpeg', caption: 'is this fixable?' },
      sentAt: at(0),
    });
    await understood(client, photo, 'A red bicycle with a flat rear tyre.', null);
    await store(client, customer, { type: 'unsupported', upstreamType: 'location', content: {}, sentAt: at(1) });
    const page = await transcript(client, customer);
    const [image, other] = page.entries;
    assert.ok(image?.from === 'customer' && image.type === 'image');
    assert.equal(image.caption, 'is this fixable?');
    assert.deepEqual(image.understanding, { status: 'understood', text: 'A red bicycle with a flat rear tyre.' });
    assert.ok(other?.from === 'customer' && other.type === 'unsupported');
    assert.equal(other.upstreamType, 'location');
    assert.ok(!JSON.stringify(describeTranscript(page)).includes('880011'));
  });

  specTest(VISIBILITY, 'AC7 a paused conversation shows its transcript, handoff status, and reason', 'held messages and the reason it was flagged are all visible while paused', async () => {
    const client = await tenant();
    const customer = '15550000051';
    await say(client, customer, 'a person please', at(0));
    await pause(client, customer, HUMAN_REQUEST);
    const later = await store(client, customer, { type: 'image', content: { mediaId: '1', mimeType: 'image/png' }, sentAt: at(9) });
    await hold(client, customer, later, 'held_handoff_paused');

    const page = await transcript(client, customer);
    assert.equal(page.handoff.paused, true);
    assert.deepEqual(page.handoff.reason, HUMAN_REQUEST);
    assert.equal(page.entries.length, 2);
    const held = page.entries[1]!;
    assert.ok(held.from === 'customer' && held.type === 'image');
    assert.equal(held.heldReason, 'handoff_paused');
    assert.deepEqual(held.understanding, { status: 'not_examined' }, 'nobody looked at a photo sent during the pause');

    const [summary] = (await list(client)).conversations;
    assert.equal(summary!.handoff.paused, true, 'and the list says so too');
    assert.deepEqual(summary!.handoff.reason, HUMAN_REQUEST);
  });

  specTest(HANDOFF, 'AC11 the client can see whether a conversation is paused or handled normally', 'the list and the transcript agree with the conversation state', async () => {
    const client = await tenant();
    const normal = '15550000052';
    const paused = '15550000053';
    await say(client, normal, 'hello', at(0));
    await say(client, paused, 'hello', at(1));
    await pause(client, paused, HUMAN_REQUEST);
    assert.equal((await transcript(client, normal)).handoff.paused, false);
    assert.equal((await transcript(client, paused)).handoff.paused, true);
    assert.deepEqual((await list(client, { pausedOnly: true })).conversations.map((entry) => entry.customerId), [paused]);
    assert.deepEqual(
      await withTenant(pool, client, (tx) => readConversationHandoff(tx, paused)),
      (await transcript(client, paused)).handoff,
    );
  });

  specTest(HANDOFF, 'AC12 a resumed conversation shows when it was handed off, why, and when it resumed', 'the handoff history travels with the transcript and survives the resume', async () => {
    const client = await tenant();
    const customer = '15550000054';
    await say(client, customer, 'a person please', at(0));
    await pause(client, customer, HUMAN_REQUEST);
    await withTenant(pool, client, (tx) => resumeConversation(tx, customer));
    const page = await transcript(client, customer);
    assert.equal(page.handoff.paused, false);
    assert.deepEqual(page.handoffHistory.map((event) => [event.event, event.reason]), [
      ['paused', HUMAN_REQUEST],
      ['resumed', undefined],
    ]);
    const described = describeTranscript(page);
    assert.equal(described.handoffHistory[1]!.reason, null);
    assert.equal(typeof described.handoffHistory[1]!.occurredAt, 'string');
  });

  specTest(DISCLOSURE, 'AC6 messages already sent before a mode change remain unchanged', 'the transcript keeps what was sent after the disclosure setting changes', async () => {
    const client = await tenant();
    const customer = '15550000055';
    const asked = await say(client, customer, 'are you a robot?', at(0));
    await answer(client, customer, [asked], { text: 'I am an automated assistant.', decidedAt: at(1) });
    const before = await transcript(client, customer);
    await withTenant(pool, client, (tx) => saveDisclosureSetting(tx, { mode: 'do_not_disclose' }));
    assert.deepEqual((await transcript(client, customer)).entries, before.entries);
  });

  // -------------------------------------------------------------------------
  // Paging
  // -------------------------------------------------------------------------

  /**
   * Five answers whose `decided_at` values share a millisecond and differ only in
   * microseconds, out of step with the order they were recorded in.
   */
  async function closeTogether(client: string, customer: string): Promise<void> {
    const asked = await say(client, customer, 'question', at(0));
    await answer(client, customer, [asked], { text: 'a1', decidedAt: '2026-03-02T10:00:10.123101Z' });
    for (const [index, micros] of ['105', '102', '104', '103'].entries()) {
      const next = await say(client, customer, `q${index}`, at(0));
      await answer(client, customer, [next], { text: `a${index + 2}`, decidedAt: `2026-03-02T10:00:10.123${micros}Z` });
    }
  }

  const EXPECTED_ORDER = ['question', 'q0', 'q1', 'q2', 'q3', 'a1', 'a3', 'a5', 'a4', 'a2'];

  unitTest('walking forward reaches every entry once, including ones within the same millisecond', async () => {
    const client = await tenant();
    const customer = '15550000061';
    await closeTogether(client, customer);

    const start = await transcript(client, customer, { limit: 2 });
    assert.deepEqual(start.entries.map(textOf), ['a4', 'a2'], 'with no cursor, the latest page');
    assert.ok(start.earlierCursor !== undefined);

    // From the very beginning, using a cursor earlier than anything stored.
    const seen: string[] = [];
    let after = '0.0.0';
    for (;;) {
      const page = await transcript(client, customer, { after, limit: 3 });
      if (page.entries.length === 0) break;
      seen.push(...page.entries.map(textOf));
      after = page.laterCursor!;
    }
    assert.deepEqual(seen, EXPECTED_ORDER);
  });

  unitTest('walking backward reaches every entry once and stops at the start', async () => {
    const client = await tenant();
    const customer = '15550000062';
    await closeTogether(client, customer);

    const pages: string[][] = [];
    let before: string | undefined;
    do {
      const page = await transcript(client, customer, before === undefined ? { limit: 4 } : { before, limit: 4 });
      pages.unshift(page.entries.map(textOf));
      before = page.earlierCursor;
    } while (before !== undefined);
    assert.deepEqual(pages.flat(), EXPECTED_ORDER);
    assert.equal(pages.length, 3);
  });

  unitTest('a forward page can walk back to what came before it', async () => {
    const client = await tenant();
    const customer = '15550000063';
    await closeTogether(client, customer);
    const opening = await transcript(client, customer, { after: '0.0.0', limit: 3 });
    assert.deepEqual(opening.entries.map(textOf), ['question', 'q0', 'q1']);
    const middle = await transcript(client, customer, { after: opening.laterCursor!, limit: 3 });
    const back = await transcript(client, customer, { before: middle.earlierCursor!, limit: 3 });
    assert.deepEqual(back.entries.map(textOf), ['question', 'q0', 'q1']);
  });

  // -------------------------------------------------------------------------
  // Isolation
  // -------------------------------------------------------------------------

  specTest(VISIBILITY, "AC8 access to another client's conversation is denied or returns no data", "another tenant's customer does not exist, even when the same number writes to both", async () => {
    const alpha = await tenant();
    const beta = await tenant();
    const onlyAlpha = '15550000071';
    const both = '15550000072';
    await say(alpha, onlyAlpha, 'for alpha', at(0));
    await say(alpha, both, 'to alpha', at(1));
    await say(beta, both, 'to beta', at(2));

    await assert.rejects(transcript(beta, onlyAlpha), NotFoundError);
    assert.deepEqual((await list(beta, { customer: onlyAlpha })).conversations, []);
    assert.deepEqual((await list(beta)).conversations.map((entry) => entry.customerId), [both]);
    assert.deepEqual((await transcript(alpha, both)).entries.map(textOf), ['to alpha']);
    assert.deepEqual((await transcript(beta, both)).entries.map(textOf), ['to beta']);
  });

  specTest(ISOLATION, "AC10 a client's view shows only their own end-customers' conversations", "a cursor from one tenant's page shows nothing of another's", async () => {
    const alpha = await tenant();
    const beta = await tenant();
    const customer = '15550000073';
    await say(alpha, customer, 'alpha one', at(0));
    await say(beta, customer, 'beta one', at(1));
    const betaCursor = (await transcript(beta, customer)).laterCursor!;
    const stolen = await transcript(alpha, customer, { before: betaCursor });
    assert.deepEqual(stolen.entries.map(textOf), ['alpha one'], 'a cursor is a position, and only selects within the bound tenant');
    assert.deepEqual(
      (await list(alpha, { cursor: `${T0 * 1000 + 5_000_000}.${customer}` })).conversations.map((entry) => entry.customerId),
      [customer],
    );
  });

  specTest(VISIBILITY, 'AC9 no conversation content is visible to the operator', 'the platform scope reads nothing from any table these views are made of', async () => {
    const client = await tenant();
    const customer = '15550000074';
    const asked = await say(client, customer, 'private', at(0));
    await answer(client, customer, [asked], { text: 'also private', decidedAt: at(1) });
    await understood(client, asked, 'seen', null);
    await pause(client, customer, HUMAN_REQUEST);
    for (const table of [
      'inbound_messages',
      'inbound_media_understandings',
      'inbound_dispositions',
      'conversations',
      'conversation_turns',
      'conversation_turn_outcomes',
      'conversation_handoff_events',
    ]) {
      const rows = await withPlatformScope(pool, async (tx) => (await tx.query(`SELECT 1 FROM ${table}`)).rows);
      assert.deepEqual(rows, [], `the platform scope can read ${table}`);
    }
  });

  unitTest('reading needs a tenant-bound connection', async () => {
    await assert.rejects(
      withPlatformScope(pool, (tx) => listConversations(tx, listAll)),
      /requires a tenant-bound connection/,
    );
  });
});
