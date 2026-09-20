/**
 * Turns, against a real PostgreSQL, driven through the worker's own job handlers.
 *
 * The queue is replaced by `JobBoard`, a scheduler that records every job the
 * handlers schedule and runs the due ones when told. That is the one fake here,
 * and it is there for time: the aggregation window is judged against each
 * message's stored `received_at`, so the tests store messages at chosen instants
 * and move a `FakeClock` past them, rather than sleeping through real windows.
 * Everything else — admission, the conversation lock, the outcome's uniqueness,
 * the fallback text, the pause — is the real database doing it.
 *
 * The model is `InMemoryAiProvider`, and what the tests assert about it is what
 * it was *shown*: that three messages reached it as one turn, in send order, with
 * the earlier conversation before them. What the model then says is scripted.
 *
 * WhatsApp is `InMemoryWhatsAppCloud`, for the reason its conformance suite gives:
 * a revoked token and a rate limit cannot be provoked against the real Cloud API
 * on demand, and both adapters are held to identical answers elsewhere. Every
 * live tenant here is given a real sealed access token, so a test that asserts a
 * reply was *delivered* is asserting about the same code path production runs,
 * down to the unsealing.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider, type ObservedGeneration } from '@zeddev/ai/testing';
import { FALLBACK_CAUSES, FALLBACK_TRIGGERS, saveFallbackMessages, saveHandoffSettings, savePersona, setBotActive, setHandoffEnabled } from '@zeddev/bot';
import { withIdentityScope, withTenant, type Connection, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ValidationError } from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import type { ClaimedJob, EnqueueRequest, EnqueueResult } from '@zeddev/queue';
import { migrateToLatest } from '@zeddev/schema';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { FakeClock } from '@zeddev/time';
import {
  INBOUND_JOB_KIND,
  INBOUND_QUEUE,
  listInboundMessages,
  readConnection,
  submitCredentials,
  transitionConnection,
} from '@zeddev/whatsapp';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';
import {
  CONVERSATION_LIMITS,
  INBOUND_DISPOSITIONS,
  parseResumeInput,
  prepareTurn,
  readConversationHandoff,
  readHandoffHistory,
  recordTurnOutcome,
  resumeConversation,
  TURN_JOB_KIND,
  TURN_OUTCOMES,
  TURN_STATES,
  WITHHELD_REASONS,
  type AggregationPolicy,
  type TurnScheduler,
} from './turns.ts';
import { DELIVERY_FAILURES, DELIVERY_JOB_KIND, DELIVERY_LIMITS, DELIVERY_STATES, readDelivery } from './delivery.ts';
import { conversationHandlers } from './worker.ts';

const BURST = 'message-burst-aggregation.md';
const MEMORY = 'conversation-memory.md';
const DELIVERY = 'message-delivery-reliability.md';
const HANDOFF = 'human-handoff.md';
const FALLBACK = 'fallback-response-behavior.md';
const ACTIVATION = 'bot-activation-control.md';

const POLICY: AggregationPolicy = { windowMs: 5_000, maxTurnMs: 30_000 };
const T0 = new Date('2026-03-02T10:00:00.000Z');

/** The Meta app every tenant's number is authorized to, as the platform's one app. */
const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220002222';

/**
 * One backend for the whole file, one adapter per world.
 *
 * Shared because a tenant is created before its world is, and keyed by token, so
 * two tenants can never reach each other's account. `sends` is therefore
 * cumulative across the file: every assertion about it is a delta or a filter,
 * never a total.
 */
const cloudBackend = new ScriptedCloudBackend();
const sealer = new SecretSealer([parseSealingKey(generateSealingKey('turns'), 'VAULT_SEALING_KEYS')]);

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

interface BoardJob {
  readonly id: string;
  readonly tenantId: string;
  readonly request: EnqueueRequest;
  readonly runAt: number;
  done: boolean;
}

interface RunOptions {
  /** Record a handler's failure instead of rethrowing it. */
  readonly tolerateFailures?: boolean | undefined;
  /** Job kinds to leave unrun, so the test can act between two stages. */
  readonly hold?: readonly string[] | undefined;
}

interface BoardFailure {
  readonly jobId: string;
  readonly kind: string;
  readonly error: unknown;
}

/**
 * A scheduler that remembers what it was asked to run and when. Honours
 * `dedupeKey` the way the real queue does, because the handlers rely on it.
 */
class JobBoard implements TurnScheduler {
  readonly jobs: BoardJob[] = [];
  /** What a tolerated handler failure left behind, for the test to inspect. */
  readonly failures: BoardFailure[] = [];
  readonly #clock: FakeClock;
  #next = 1;

  constructor(clock: FakeClock) {
    this.#clock = clock;
  }

  async enqueueWithin(connection: Connection, request: EnqueueRequest): Promise<EnqueueResult> {
    const tenantId = connection.boundTenantId!;
    const existing = this.jobs.find(
      (job) => job.tenantId === tenantId && request.dedupeKey !== undefined && job.request.dedupeKey === request.dedupeKey,
    );
    if (existing !== undefined) return { jobId: existing.id, created: false };
    const job = {
      id: `job-${this.#next++}`,
      tenantId,
      request,
      runAt: this.#clock.now().getTime() + (request.delayMs ?? 0),
      done: false,
    };
    this.jobs.push(job);
    return { jobId: job.id, created: true };
  }

  due(): BoardJob[] {
    const now = this.#clock.now().getTime();
    return this.jobs.filter((job) => !job.done && job.runAt <= now).sort((a, b) => a.runAt - b.runAt);
  }
}

function claimed(job: BoardJob, attempt = 1): ClaimedJob {
  return {
    id: job.id,
    tenantId: job.tenantId,
    queue: INBOUND_QUEUE,
    kind: job.request.kind,
    payload: job.request.payload,
    attempt,
    maxAttempts: 5,
    enqueuedAt: new Date(job.runAt),
  };
}

describe('conversation turns', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;
  let numberCounter = 700_000_000;
  let messageCounter = 0;

  before(async () => {
    db = await createTestDatabase('conversation');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  /** One isolated world per test: its own clock, board, model, and log. */
  function world() {
    const clock = new FakeClock(T0);
    const board = new JobBoard(clock);
    const provider = new InMemoryAiProvider();
    const sink = new MemorySink();
    const logger = new Logger({ level: 'debug', sink });
    const cloud = new InMemoryWhatsAppCloud({ appId: APP_ID, backend: cloudBackend });
    const handlers = conversationHandlers({
      pool,
      provider,
      scheduler: board,
      policy: POLICY,
      clock,
      logger,
      cloud,
      sealer,
    });

    /**
     * Run every job that is due now, including ones those jobs schedule, until
     * none is.
     *
     * A handler that raises is rethrown unless the caller asked otherwise, so a
     * defect in the turn path fails the test that provoked it rather than being
     * absorbed. Delivery tests opt out because a failed send *is* the subject:
     * the failure goes to `board.failures` and the job is left for the test to
     * re-drive with the next attempt number, which is what the real queue does
     * after its backoff.
     */
    async function runDue(options: RunOptions = {}): Promise<void> {
      const held = new Set(options.hold ?? []);
      for (
        let job = board.due().find((entry) => !held.has(entry.request.kind));
        job !== undefined;
        job = board.due().find((entry) => !held.has(entry.request.kind))
      ) {
        job.done = true;
        try {
          await handlers[job.request.kind]!(claimed(job));
        } catch (error) {
          if (options.tolerateFailures !== true) throw error;
          board.failures.push({ jobId: job.id, kind: job.request.kind, error });
        }
      }
    }

    /** Move the clock to `offsetMs` after T0 and run what is due. */
    async function advanceTo(offsetMs: number, options: RunOptions = {}): Promise<void> {
      const target = at(offsetMs).getTime();
      const delta = target - clock.now().getTime();
      if (delta > 0) await clock.advance(delta);
      await runDue(options);
    }

    /**
     * Re-drive this tenant's delivery job as attempt `attempt`, and hand back
     * whatever it raised.
     *
     * The board is not a queue and has no backoff; what matters to these tests is
     * that the handler sees the attempt number the queue would have given it,
     * because that is what decides whether the allowance is exhausted.
     */
    async function deliverAgain(tenant: string, attempt: number): Promise<unknown> {
      const job = board.jobs.find((entry) => entry.tenantId === tenant && entry.request.kind === DELIVERY_JOB_KIND);
      assert.ok(job !== undefined, 'no delivery job was scheduled for this tenant');
      job.done = true;
      return handlers[DELIVERY_JOB_KIND]!(claimed(job, attempt)).then(
        () => undefined,
        (error: unknown) => error,
      );
    }

    /**
     * Store a message the way the gateway would — the row, then its job in the
     * same breath — but at a chosen arrival instant, so the window is testable.
     */
    async function receive(
      tenant: string,
      customer: string,
      message:
        | { text: string }
        | { image: { caption?: string } }
        | { voice: true }
        | { unsupported: string },
      times: { receivedMs: number; sentMs?: number },
    ): Promise<string> {
      messageCounter += 1;
      const [type, upstreamType, content] =
        'text' in message
          ? (['text', 'text', { text: message.text }] as const)
          : 'image' in message
            ? ([
                'image',
                'image',
                message.image.caption === undefined
                  ? { mediaId: '111', mimeType: 'image/jpeg' }
                  : { mediaId: '111', mimeType: 'image/jpeg', caption: message.image.caption },
              ] as const)
            : 'voice' in message
              ? (['audio', 'audio', { mediaId: '222', mimeType: 'audio/ogg', voice: true }] as const)
              : (['unsupported', message.unsupported, {}] as const);
      const phone = await withTenant(pool, tenant, async (tx) => {
        const route = await tx.query<{ phone_number_id: string }>('SELECT phone_number_id FROM whatsapp_number_routes');
        return route.rows[0]!.phone_number_id;
      });
      const id = await withTenant(pool, tenant, async (tx) => {
        const inserted = await tx.query<{ id: string }>(
          `INSERT INTO inbound_messages
             (tenant_id, external_id, phone_number_id, customer_id, message_type, upstream_type, content, sent_at, received_at)
           VALUES (app.current_tenant_id(), $1, $2, $3, $4, $5, $6::jsonb, $7, $8)
           RETURNING id`,
          [
            `wamid.turns-${messageCounter}`,
            phone,
            customer,
            type,
            upstreamType,
            JSON.stringify(content),
            at(times.sentMs ?? times.receivedMs),
            at(times.receivedMs),
          ],
        );
        const stored = inserted.rows[0]!.id;
        await board.enqueueWithin(tx, { kind: INBOUND_JOB_KIND, payload: { inboundMessageId: stored }, partitionKey: customer });
        return stored;
      });
      return id;
    }

    /** Every generation request the model saw, oldest first. */
    function generations(): ObservedGeneration[] {
      return provider.backend.requests.filter((r): r is ObservedGeneration => r.operation === 'generate');
    }

    return { clock, board, provider, sink, handlers, runDue, advanceTo, deliverAgain, receive, generations };
  }

  /** A tenant whose bot is live: connected number, a persona, switched on. */
  async function liveTenant(): Promise<string> {
    counter += 1;
    numberCounter += 1;
    const tenant = await withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Turns Tailor ${counter}`],
      );
      return created.rows[0]!.id;
    });
    // Registered at "Meta" first, then submitted here, which is the order the
    // real flow has: the number exists on Meta's side before the client hands
    // the platform a token for it.
    const token = ['turns', String(counter), 'token'].join('-');
    cloudBackend.register({
      token,
      phoneNumberId: String(numberCounter),
      businessAccountId: BUSINESS_ACCOUNT_ID,
      appId: APP_ID,
    });
    await withTenant(pool, tenant, async (tx) => {
      await submitCredentials(
        tx,
        sealer,
        {
          phoneNumberId: String(numberCounter),
          businessAccountId: BUSINESS_ACCOUNT_ID,
          accessToken: token,
        },
        { principal: 'turns-test' },
      );
      await transitionConnection(tx, 'connected');
      await savePersona(tx, { botName: `Ana ${counter}` });
      await setBotActive(tx, true);
    });
    return tenant;
  }

  interface OutcomeRow {
    turn_id: string;
    outcome: string;
    message: string | null;
    fallback_trigger: string | null;
    fallback_cause: string | null;
    fallback_source: string | null;
    handoff_reason: unknown;
    withheld_reason: string | null;
    delivery_state: string | null;
  }

  /** The tenant's recorded turn outcomes for one end-customer, oldest turn first. */
  function outcomesOf(tenant: string, customer: string): Promise<readonly OutcomeRow[]> {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<OutcomeRow>(
        `SELECT o.turn_id, o.outcome, o.message, o.fallback_trigger, o.fallback_cause, o.fallback_source,
                o.handoff_reason, o.withheld_reason, o.delivery_state
           FROM conversation_turn_outcomes o
           JOIN conversation_turns t ON t.id = o.turn_id
           JOIN conversations c ON c.id = t.conversation_id
          WHERE c.customer_id = $1
          ORDER BY t.sequence`,
        [customer],
      );
      return result.rows;
    });
  }

  /** The tenant's turns for one end-customer, with how many messages each holds. */
  function turnsOf(tenant: string, customer: string) {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ id: string; state: string; messages: number }>(
        `SELECT t.id, t.state, (SELECT count(*)::int FROM inbound_dispositions d WHERE d.turn_id = t.id) AS messages
           FROM conversation_turns t JOIN conversations c ON c.id = t.conversation_id
          WHERE c.customer_id = $1
          ORDER BY t.sequence`,
        [customer],
      );
      return result.rows;
    });
  }

  function dispositionsOf(tenant: string, customer: string) {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ disposition: string }>(
        `SELECT d.disposition FROM inbound_dispositions d
           JOIN inbound_messages m ON m.id = d.inbound_message_id
          WHERE m.customer_id = $1
          ORDER BY m.received_at, m.position`,
        [customer],
      );
      return result.rows.map((row) => row.disposition);
    });
  }

  /** The text of each customer and bot turn the model was shown, one string per turn. */
  function shown(generation: ObservedGeneration): string[] {
    return generation.turns.map(
      (turn) => `${turn.role}: ${turn.parts.map((part) => (part.type === 'text' ? part.text : `<${part.mediaType}>`)).join(' | ')}`,
    );
  }

  // -------------------------------------------------------------------------
  // Grouping
  // -------------------------------------------------------------------------

  specTest(BURST, 'AC1 three messages inside the window get exactly one reply', 'three messages inside the window become one turn with exactly one reply', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000001';
    w.provider.backend.script({ kind: 'text', text: '[reply]\nWe open at nine, and yes, we deliver.' });

    await w.receive(tenant, customer, { text: 'hi' }, { receivedMs: 0 });
    await w.receive(tenant, customer, { text: 'when do you open' }, { receivedMs: 2_000 });
    await w.receive(tenant, customer, { text: 'and do you deliver?' }, { receivedMs: 4_000 });
    await w.advanceTo(4_000);
    assert.equal(w.generations().length, 0, 'nothing is generated while the turn is still open');

    // The first message's window would have closed at 5 s; the third moved it to 9 s.
    await w.advanceTo(5_000);
    assert.equal(w.generations().length, 0, 'the window restarts from the latest message');
    await w.advanceTo(9_000);

    const outcomes = await outcomesOf(tenant, customer);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, 'reply');
    assert.equal(outcomes[0]!.message, 'We open at nine, and yes, we deliver.');
    // The whole path, not just the decision: one turn produced one answer and the
    // customer was sent it exactly once.
    assert.equal(outcomes[0]!.delivery_state, 'sent');
    assert.deepEqual(
      cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body),
      ['We open at nine, and yes, we deliver.'],
    );
    assert.equal(w.generations().length, 1, 'one model call for the whole turn');
    assert.deepEqual(shown(w.generations()[0]!), ['customer: hi\n\nwhen do you open\n\nand do you deliver?']);
    assert.deepEqual(
      (await turnsOf(tenant, customer)).map((turn) => [turn.state, turn.messages]),
      [['closed', 3]],
    );
  });

  specTest(BURST, 'AC3 a burst is presented to reply generation in the order it was sent', 'a turn is shown to the model in the order the messages were sent, not the order they arrived', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000002';
    // Sent at 0, 1, 2 s; delivered 2nd, 3rd, 1st.
    await w.receive(tenant, customer, { text: 'second' }, { receivedMs: 1_000, sentMs: 1_000 });
    await w.receive(tenant, customer, { text: 'third' }, { receivedMs: 2_000, sentMs: 2_000 });
    await w.receive(tenant, customer, { text: 'first' }, { receivedMs: 3_000, sentMs: 0 });
    await w.advanceTo(8_000);
    assert.deepEqual(shown(w.generations()[0]!), ['customer: first\n\nsecond\n\nthird']);
  });

  specTest(DELIVERY, 'AC5 out-of-order notifications are processed and stored in sent order', 'messages delivered out of order are combined in the order the end-customer sent them', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000003';
    await w.receive(tenant, customer, { text: 'B' }, { receivedMs: 0, sentMs: 500 });
    await w.receive(tenant, customer, { text: 'A' }, { receivedMs: 100, sentMs: 0 });
    await w.advanceTo(6_000);
    assert.deepEqual(shown(w.generations()[0]!), ['customer: A\n\nB']);
    assert.equal((await turnsOf(tenant, customer)).length, 1, 'one turn: the late arrival did not split it');
  });

  unitTest('a mixed burst is one turn, each message rendered by its own type', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000004';
    await w.receive(tenant, customer, { voice: true }, { receivedMs: 0 });
    await w.receive(tenant, customer, { image: { caption: 'this one, in blue' } }, { receivedMs: 1_000 });
    await w.receive(tenant, customer, { text: 'how much?' }, { receivedMs: 2_000 });
    await w.advanceTo(7_000);
    assert.equal((await outcomesOf(tenant, customer)).length, 1);
    const [turn] = shown(w.generations()[0]!);
    assert.match(turn!, /^customer: \[The customer sent a voice message, which could not be listened to\.\]/);
    assert.match(turn!, /The photo's caption:\]\n\nthis one, in blue\n\nhow much\?$/);
  });

  specTest(BURST, 'AC4 the maximum turn extension still produces a reply', 'a customer who never pauses still gets a reply when the maximum turn duration is reached', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000005';
    // Every 4 s, each inside the 5 s window of the last, from 0 s to 36 s.
    for (let ms = 0; ms <= 36_000; ms += 4_000) {
      await w.receive(tenant, customer, { text: `part ${ms / 1000}` }, { receivedMs: ms });
      await w.advanceTo(ms);
    }
    const turns = await turnsOf(tenant, customer);
    // 0..28 s are the first turn (its deadline is 30 s); 32 s arrives after it closed.
    assert.deepEqual(turns.map((turn) => turn.messages), [8, 2]);
    assert.equal(turns[0]!.state, 'closed');
    const outcomes = await outcomesOf(tenant, customer);
    assert.equal(outcomes.length, 1, 'the first turn was answered at its deadline, while messages kept coming');
    assert.equal(outcomes[0]!.turn_id, turns[0]!.id);
  });

  specTest(BURST, 'AC5 a message after the reply was sent starts a new turn', 'a message after the reply was recorded starts a new turn', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000006';
    await w.receive(tenant, customer, { text: 'first question' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, customer, { text: 'follow-up' }, { receivedMs: 7_000 });
    await w.advanceTo(13_000);
    assert.deepEqual((await turnsOf(tenant, customer)).map((turn) => turn.messages), [1, 1]);
    assert.equal((await outcomesOf(tenant, customer)).length, 2);
  });

  specTest(MEMORY, 'AC1 a reply reflects an earlier message of the same conversation', 'a later turn is answered with the earlier turns and the bot’s replies in front of the model', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000007';
    w.provider.backend.script(
      { kind: 'text', text: '[reply]\nThe blue one is 40.' },
      { kind: 'text', text: '[reply]\nYes, in medium too.' },
    );
    await w.receive(tenant, customer, { text: 'price of the blue shirt?' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, customer, { text: 'do you have it in medium?' }, { receivedMs: 60_000 });
    await w.advanceTo(66_000);
    assert.deepEqual(shown(w.generations()[1]!), [
      'customer: price of the blue shirt?',
      'bot: The blue one is 40.',
      'customer: do you have it in medium?',
    ]);
  });

  unitTest('the model is shown at most CONVERSATION_LIMITS.contextTurns turns', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000008';
    const turns = CONVERSATION_LIMITS.contextTurns + 2;
    for (let index = 0; index < turns; index += 1) {
      await w.receive(tenant, customer, { text: `message ${index}` }, { receivedMs: index * 10_000 });
      await w.advanceTo(index * 10_000 + 6_000);
    }
    const last = w.generations().at(-1)!;
    const customerTurns = last.turns.filter((turn) => turn.role === 'customer');
    assert.equal(customerTurns.length, CONVERSATION_LIMITS.contextTurns);
    assert.deepEqual(customerTurns.at(-1)!.parts, [{ type: 'text', text: `message ${turns - 1}` }]);
    assert.deepEqual(customerTurns[0]!.parts, [{ type: 'text', text: `message ${turns - CONVERSATION_LIMITS.contextTurns}` }]);
  });

  unitTest('the disclosure opening is asked for on the first reply of a conversation only', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000009';
    await w.receive(tenant, customer, { text: 'hello' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, customer, { text: 'again' }, { receivedMs: 20_000 });
    await w.advanceTo(26_000);
    const [first, second] = w.generations();
    assert.match(first!.instructions, /This is the start of a new conversation\./);
    assert.doesNotMatch(second!.instructions, /This is the start of a new conversation\./);
  });

  // -------------------------------------------------------------------------
  // Isolation between end-customers and tenants
  // -------------------------------------------------------------------------

  specTest(BURST, 'AC6 two end-customers of one business are never merged', 'two end-customers of one business bursting at once each get their own single reply', async () => {
    const w = world();
    const tenant = await liveTenant();
    await w.receive(tenant, '15550000010', { text: 'Ana: one' }, { receivedMs: 0 });
    await w.receive(tenant, '15550000011', { text: 'Bea: one' }, { receivedMs: 500 });
    await w.receive(tenant, '15550000010', { text: 'Ana: two' }, { receivedMs: 1_000 });
    await w.receive(tenant, '15550000011', { text: 'Bea: two' }, { receivedMs: 1_500 });
    await w.advanceTo(7_000);
    assert.equal((await outcomesOf(tenant, '15550000010')).length, 1);
    assert.equal((await outcomesOf(tenant, '15550000011')).length, 1);
    const seen = w.generations().map((generation) => shown(generation).join(' / ')).sort();
    assert.deepEqual(seen, ['customer: Ana: one\n\nAna: two', 'customer: Bea: one\n\nBea: two']);
  });

  specTest(MEMORY, 'AC4 two end-customers of one business never share context', "one end-customer's conversation never appears in another's context", async () => {
    const w = world();
    const tenant = await liveTenant();
    await w.receive(tenant, '15550000012', { text: 'my order number is 5541' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, '15550000013', { text: 'what is my order number?' }, { receivedMs: 10_000 });
    await w.advanceTo(16_000);
    assert.deepEqual(shown(w.generations()[1]!), ['customer: what is my order number?']);
  });

  specTest(BURST, 'AC7 bursts to two businesses are answered each in its own context', 'bursts to two businesses at once are aggregated and answered each in its own business', async () => {
    const w = world();
    const first = await liveTenant();
    const second = await liveTenant();
    // The same end-customer writing to both businesses.
    const customer = '15550000014';
    await w.receive(first, customer, { text: 'to the first business' }, { receivedMs: 0 });
    await w.receive(second, customer, { text: 'to the second business' }, { receivedMs: 200 });
    await w.advanceTo(6_000);
    assert.equal((await outcomesOf(first, customer)).length, 1);
    assert.equal((await outcomesOf(second, customer)).length, 1);
    const seen = w.generations().map((generation) => shown(generation).join(' / ')).sort();
    assert.deepEqual(seen, ['customer: to the first business', 'customer: to the second business']);
  });

  specTest(MEMORY, 'AC5 two businesses never share conversation context', "a business's context never includes another business's conversation", async () => {
    const w = world();
    const first = await liveTenant();
    const second = await liveTenant();
    const customer = '15550000015';
    await w.receive(first, customer, { text: 'secret for the first business' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(second, customer, { text: 'hello second business' }, { receivedMs: 10_000 });
    await w.advanceTo(16_000);
    assert.deepEqual(shown(w.generations()[1]!), ['customer: hello second business']);
  });

  unitTest("a turn id is useless under another tenant's binding", async () => {
    const w = world();
    const owner = await liveTenant();
    const other = await liveTenant();
    await w.receive(owner, '15550000016', { text: 'hi' }, { receivedMs: 0 });
    await w.advanceTo(1_000);
    const [turn] = await turnsOf(owner, '15550000016');
    const attempt = await withTenant(pool, other, (tx) => prepareTurn(tx, turn!.id, POLICY, w.board, at(60_000)));
    assert.deepEqual(attempt, { status: 'answered' });
    assert.equal((await turnsOf(owner, '15550000016'))[0]!.state, 'open', "the owner's turn was not touched");
  });

  specTest(BURST, 'AC8 every message of a turn is stored individually', 'every message of an aggregated turn is still stored individually, as sent', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000017';
    for (const [index, text] of ['one', 'two', 'three'].entries()) {
      await w.receive(tenant, customer, { text }, { receivedMs: index * 1_000 });
    }
    await w.advanceTo(8_000);
    const stored = await withTenant(pool, tenant, (tx) => listInboundMessages(tx, { customerId: customer }));
    assert.deepEqual(stored.map((message) => message.content), [{ text: 'one' }, { text: 'two' }, { text: 'three' }]);
    assert.equal((await outcomesOf(tenant, customer)).length, 1);
  });

  // -------------------------------------------------------------------------
  // Exactly one answer
  // -------------------------------------------------------------------------

  unitTest('re-running an inbound job admits nothing twice', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000018';
    await w.receive(tenant, customer, { text: 'once' }, { receivedMs: 0 });
    await w.advanceTo(0);
    const inbound = w.board.jobs.find((job) => job.request.kind === INBOUND_JOB_KIND && job.tenantId === tenant)!;
    await w.handlers[INBOUND_JOB_KIND]!(claimed(inbound, 2));
    assert.deepEqual(await dispositionsOf(tenant, customer), ['aggregated']);
    assert.equal((await turnsOf(tenant, customer)).length, 1);
  });

  specTest(DELIVERY, 'AC6 an acknowledged message survives a restart of the component producing the reply', 'a turn job that dies after generating and is run again still records one answer', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000019';
    await w.receive(tenant, customer, { text: 'hello?' }, { receivedMs: 0 });
    await w.advanceTo(5_000);
    const turnJobs = w.board.jobs.filter((job) => job.request.kind === TURN_JOB_KIND && job.tenantId === tenant);
    // The worker restarts; the lease expires; the same job runs again.
    await w.handlers[TURN_JOB_KIND]!(claimed(turnJobs[0]!, 2));
    const outcomes = await outcomesOf(tenant, customer);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, 'reply');
  });

  specTest(FALLBACK, 'AC13 one fallback message per triggering message', 'two concurrent answers to one turn record — and so send — one message', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000020';
    await w.receive(tenant, customer, { text: 'hello' }, { receivedMs: 0 });
    await w.advanceTo(1_000);
    const prepared = await withTenant(pool, tenant, (tx) => prepareTurn(tx, (w.board.jobs.at(-1)!.request.payload as { turnId: string }).turnId, POLICY, w.board, at(6_000)));
    assert.equal(prepared.status, 'ready');
    if (prepared.status !== 'ready') return;
    const decision = { path: 'fallback', trigger: 'low_confidence', cause: 'declined' } as const;
    const results = await Promise.all([
      withTenant(pool, tenant, (tx) => recordTurnOutcome(tx, prepared.turn, decision, w.board)),
      withTenant(pool, tenant, (tx) => recordTurnOutcome(tx, prepared.turn, decision, w.board)),
    ]);
    assert.deepEqual(results.map((result) => result.recorded).sort(), [false, true]);
    assert.equal((await outcomesOf(tenant, customer)).length, 1);
  });

  unitTest('a later turn waits for the earlier one and sees its reply', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000021';
    await w.receive(tenant, customer, { text: 'first' }, { receivedMs: 0 });
    await w.advanceTo(0);
    const firstTurnJob = w.board.jobs.find((job) => job.request.kind === TURN_JOB_KIND && job.tenantId === tenant)!;
    // The first turn's job is slow to run; meanwhile a second turn opens and closes.
    firstTurnJob.done = true;
    await w.receive(tenant, customer, { text: 'second' }, { receivedMs: 10_000 });
    await w.advanceTo(16_000);
    assert.equal((await outcomesOf(tenant, customer)).length, 0, 'the second turn did not overtake the first');
    assert.match(w.sink.serialized(), /conversation\.turn\.waiting/);

    await w.handlers[TURN_JOB_KIND]!(claimed(firstTurnJob));
    await w.runDue();
    const outcomes = await outcomesOf(tenant, customer);
    assert.equal(outcomes.length, 2, 'answering the first scheduled the second');
    assert.deepEqual(shown(w.generations()[1]!), ['customer: first', 'bot: Scripted reply.', 'customer: second']);
  });

  // -------------------------------------------------------------------------
  // Bot off
  // -------------------------------------------------------------------------

  specTest(BURST, 'AC9 messages sent while the bot is off produce no aggregated reply', 'messages sent while the bot is off are held, and turning it on does not answer them', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000022';
    await withTenant(pool, tenant, (tx) => setBotActive(tx, false));
    await w.receive(tenant, customer, { text: 'anyone there?' }, { receivedMs: 0 });
    await w.receive(tenant, customer, { text: 'hello??' }, { receivedMs: 1_000 });
    await w.advanceTo(10_000);
    assert.deepEqual(await dispositionsOf(tenant, customer), ['held_bot_inactive', 'held_bot_inactive']);
    assert.equal((await turnsOf(tenant, customer)).length, 0);

    await withTenant(pool, tenant, (tx) => setBotActive(tx, true));
    await w.advanceTo(20_000);
    assert.equal(w.generations().length, 0, 'switching on answered nothing retroactively');

    await w.receive(tenant, customer, { text: 'new question' }, { receivedMs: 30_000 });
    await w.advanceTo(36_000);
    assert.deepEqual(shown(w.generations()[0]!), ['customer: new question']);
  });

  specTest(ACTIVATION, 'AC6 turning an active bot off stops auto-responding immediately', 'a bot switched off while a turn was being answered sends nothing for it', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000023';
    await w.receive(tenant, customer, { text: 'hi' }, { receivedMs: 0 });
    await w.advanceTo(1_000);
    const turnId = (await turnsOf(tenant, customer))[0]!.id;
    const prepared = await withTenant(pool, tenant, (tx) => prepareTurn(tx, turnId, POLICY, w.board, at(6_000)));
    assert.equal(prepared.status, 'ready');
    if (prepared.status !== 'ready') return;
    // The model is thinking; the client switches the bot off.
    await withTenant(pool, tenant, (tx) => setBotActive(tx, false));
    await withTenant(pool, tenant, (tx) =>
      recordTurnOutcome(tx, prepared.turn, { path: 'reply', text: 'too late' }, w.board),
    );
    const [outcome] = await outcomesOf(tenant, customer);
    assert.equal(outcome!.outcome, 'withheld');
    assert.equal(outcome!.withheld_reason, 'bot_inactive');
    assert.equal(outcome!.message, null, 'nothing waits to be sent');
  });

  specTest(ACTIVATION, 'AC5 turning a ready bot on starts auto-responding with no business-hours restriction', 'a live bot answers a message at any hour', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000024';
    // 03:30 on a Sunday, UTC.
    const night = new Date('2026-03-08T03:30:00.000Z').getTime() - T0.getTime();
    await w.receive(tenant, customer, { text: 'are you open?' }, { receivedMs: night });
    await w.advanceTo(night + 6_000);
    assert.equal((await outcomesOf(tenant, customer))[0]!.outcome, 'reply');
  });

  // -------------------------------------------------------------------------
  // Handoff
  // -------------------------------------------------------------------------

  async function handoffTenant(): Promise<string> {
    const tenant = await liveTenant();
    await withTenant(pool, tenant, (tx) =>
      saveHandoffSettings(tx, { enabled: true, triggers: ['human_request', 'complaint', 'out_of_scope'], customConditions: [] }),
    );
    return tenant;
  }

  specTest(HANDOFF, 'AC2 with handoff enabled an explicit request to speak to a person flags the conversation', 'a customer asking for a person pauses the conversation, with the reason recorded', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000025';
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'I want to talk to a person' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const [outcome] = await outcomesOf(tenant, customer);
    assert.equal(outcome!.outcome, 'handoff');
    assert.deepEqual(outcome!.handoff_reason, { kind: 'trigger', trigger: 'human_request' });
    assert.equal(outcome!.message, null, 'a handoff sends no bot message');
    const status = await withTenant(pool, tenant, (tx) => readConversationHandoff(tx, customer));
    assert.equal(status.paused, true);
    assert.deepEqual(status.reason, { kind: 'trigger', trigger: 'human_request' });
  });

  specTest(FALLBACK, 'AC6 with handoff enabled the handoff is taken instead of the fallback', 'with handoff enabled, a handoff answer pauses rather than sending the fallback', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000026';
    w.provider.backend.script({ kind: 'text', text: '[handoff] complaint' });
    await w.receive(tenant, customer, { text: 'this is the third time my order is wrong' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const [outcome] = await outcomesOf(tenant, customer);
    assert.equal(outcome!.outcome, 'handoff');
    assert.equal(outcome!.fallback_trigger, null);
  });

  specTest(FALLBACK, 'AC7 with handoff disabled the configured fallback is sent', 'with handoff disabled, a would-be handoff sends the fallback text instead', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000027';
    await withTenant(pool, tenant, (tx) => saveFallbackMessages(tx, { sharedMessage: 'Sorry — we will get back to you.' }));
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'a human please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const [outcome] = await outcomesOf(tenant, customer);
    assert.equal(outcome!.outcome, 'fallback');
    assert.equal(outcome!.message, 'Sorry — we will get back to you.');
    assert.equal(outcome!.fallback_cause, 'handoff_unavailable');
    assert.equal((await withTenant(pool, tenant, (tx) => readConversationHandoff(tx, customer))).paused, false);
  });

  specTest(HANDOFF, 'AC7 a handed-off conversation gets no automated reply but keeps receiving messages', 'messages to a paused conversation are received and retained, never answered', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000028';
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, customer, { text: 'hello?' }, { receivedMs: 10_000 });
    await w.receive(tenant, customer, { text: 'still there?' }, { receivedMs: 11_000 });
    await w.advanceTo(30_000);
    assert.deepEqual(await dispositionsOf(tenant, customer), ['aggregated', 'held_handoff_paused', 'held_handoff_paused']);
    assert.equal(w.generations().length, 1, 'no model call after the pause');
    assert.equal((await outcomesOf(tenant, customer)).length, 1);
  });

  specTest(BURST, 'AC10 no aggregated reply during a handoff pause, normal turns after resumption', 'no aggregated reply during a handoff pause; normal turns again after resumption', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000029';
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, customer, { text: 'during the pause' }, { receivedMs: 10_000 });
    await w.advanceTo(20_000);
    await withTenant(pool, tenant, (tx) => resumeConversation(tx, customer));
    await w.receive(tenant, customer, { text: 'after the pause' }, { receivedMs: 30_000 });
    await w.advanceTo(36_000);
    const outcomes = await outcomesOf(tenant, customer);
    assert.deepEqual(outcomes.map((outcome) => outcome.outcome), ['handoff', 'reply']);
    // The held message was for the person who took over; it is not answered now.
    // The handoff turn got no bot message, so the port merges it with the next.
    assert.deepEqual(shown(w.generations()[1]!), ['customer: person please\n\nafter the pause']);
  });

  specTest(HANDOFF, 'AC8 other conversations keep auto-responding while one is handed off', 'one paused conversation does not stop the bot answering the others', async () => {
    const w = world();
    const tenant = await handoffTenant();
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, '15550000030', { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await w.receive(tenant, '15550000031', { text: 'opening hours?' }, { receivedMs: 10_000 });
    await w.advanceTo(16_000);
    assert.equal((await outcomesOf(tenant, '15550000031'))[0]!.outcome, 'reply');
  });

  specTest(HANDOFF, 'AC9 a resumed conversation is auto-responded to again', 'resuming a paused conversation makes the bot answer subsequent messages', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000032';
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const status = await withTenant(pool, tenant, (tx) => resumeConversation(tx, customer));
    assert.equal(status.paused, false);
    await w.receive(tenant, customer, { text: 'thanks, one more thing' }, { receivedMs: 20_000 });
    await w.advanceTo(26_000);
    assert.equal((await outcomesOf(tenant, customer)).at(-1)!.outcome, 'reply');
  });

  specTest(HANDOFF, 'AC11 a conversation shows whether it is paused for handoff', 'the conversation reports whether it is paused for handoff or under normal handling', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000033';
    assert.equal((await withTenant(pool, tenant, (tx) => readConversationHandoff(tx, customer))).paused, false);
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    assert.equal((await withTenant(pool, tenant, (tx) => readConversationHandoff(tx, customer))).paused, true);
  });

  specTest(HANDOFF, 'AC12 the history shows when and why a conversation was handed off and when it was resumed', 'the history shows when the conversation was handed off, why, and when it was resumed', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000034';
    w.provider.backend.script({ kind: 'text', text: '[handoff] complaint' });
    await w.receive(tenant, customer, { text: 'this is unacceptable' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await withTenant(pool, tenant, (tx) => resumeConversation(tx, customer));
    // A second resume changes nothing and records nothing.
    await withTenant(pool, tenant, (tx) => resumeConversation(tx, customer));
    const history = await withTenant(pool, tenant, (tx) => readHandoffHistory(tx, customer));
    assert.deepEqual(
      history.map((event) => [event.event, event.reason]),
      [
        ['paused', { kind: 'trigger', trigger: 'complaint' }],
        ['resumed', undefined],
      ],
    );
    assert.ok(history[0]!.occurredAt.getTime() <= history[1]!.occurredAt.getTime());
  });

  specTest(HANDOFF, 'AC13 disabling handoff does not resume an already paused conversation', 'switching handoff off does not resume a conversation already paused', async () => {
    const w = world();
    const tenant = await handoffTenant();
    const customer = '15550000035';
    w.provider.backend.script({ kind: 'text', text: '[handoff] human_request' });
    await w.receive(tenant, customer, { text: 'person please' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await withTenant(pool, tenant, (tx) => setHandoffEnabled(tx, { enabled: false }));
    await w.receive(tenant, customer, { text: 'hello?' }, { receivedMs: 20_000 });
    await w.advanceTo(30_000);
    assert.equal((await withTenant(pool, tenant, (tx) => readConversationHandoff(tx, customer))).paused, true);
    assert.deepEqual((await dispositionsOf(tenant, customer)).at(-1), 'held_handoff_paused');
  });

  unitTest('a resume request names an end-customer and nothing else', () => {
    assert.equal(parseResumeInput({ customerId: '15550000036' }), '15550000036');
    assert.throws(() => parseResumeInput({}), ValidationError);
    assert.throws(() => parseResumeInput({ customerId: '+1 555' }), ValidationError);
    assert.throws(() => parseResumeInput({ customerId: '1555', tenantId: 'x' }), ValidationError);
  });

  // -------------------------------------------------------------------------
  // Fallback
  // -------------------------------------------------------------------------

  specTest(FALLBACK, 'AC5 when AI generation fails outright the end-customer still receives a fallback', 'a failed model call still answers the turn, with the error fallback text', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000037';
    await withTenant(pool, tenant, (tx) =>
      saveFallbackMessages(tx, { triggerMessages: { ai_error: 'Our assistant is having trouble — we will reply soon.' } }),
    );
    w.provider.backend.script(
      { kind: 'failure', failure: 'unavailable' },
      { kind: 'failure', failure: 'unavailable' },
      { kind: 'failure', failure: 'unavailable' },
    );
    await w.receive(tenant, customer, { text: 'hello' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const [outcome] = await outcomesOf(tenant, customer);
    assert.equal(outcome!.outcome, 'fallback');
    assert.equal(outcome!.message, 'Our assistant is having trouble — we will reply soon.');
    assert.equal(outcome!.fallback_trigger, 'ai_error');
    assert.equal(outcome!.fallback_cause, 'generation_failed');
    assert.equal(outcome!.fallback_source, 'trigger');
    // The client's own fallback text is what went out, verbatim — the §3
    // resolution that a fallback is never rewritten by the model.
    assert.equal(outcome!.delivery_state, 'sent');
    assert.deepEqual(
      cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body),
      ['Our assistant is having trouble — we will reply soon.'],
    );
    assert.match(w.sink.serialized(), /conversation\.turn\.generation_failed/);
  });

  specTest(FALLBACK, 'AC10 a fallback is recorded with the trigger that caused it', 'a fallback is recorded with the trigger that caused it', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000038';
    w.provider.backend.script({ kind: 'text', text: '[fallback] out_of_scope' });
    await w.receive(tenant, customer, { text: 'can you do my taxes?' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const [outcome] = await outcomesOf(tenant, customer);
    assert.deepEqual(
      [outcome!.outcome, outcome!.fallback_trigger, outcome!.fallback_cause, outcome!.fallback_source],
      ['fallback', 'out_of_scope', 'declined', 'platform_default'],
    );
  });

  specTest(FALLBACK, 'AC11 an edited fallback message is what the next fallback sends', 'an edited fallback message is what the next fallback records', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000039';
    await withTenant(pool, tenant, (tx) => saveFallbackMessages(tx, { sharedMessage: 'Old wording.' }));
    w.provider.backend.script({ kind: 'text', text: '[fallback] low_confidence' }, { kind: 'text', text: '[fallback] low_confidence' });
    await w.receive(tenant, customer, { text: 'q1' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    await withTenant(pool, tenant, (tx) => saveFallbackMessages(tx, { sharedMessage: 'New wording.' }));
    await w.receive(tenant, customer, { text: 'q2' }, { receivedMs: 20_000 });
    await w.advanceTo(26_000);
    assert.deepEqual((await outcomesOf(tenant, customer)).map((outcome) => outcome.message), ['Old wording.', 'New wording.']);
  });

  specTest(BURST, 'AC11 a turn with an unintelligible voice note still gets exactly one reply', 'a turn with an unreadable voice note beside clear text still gets exactly one reply', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000040';
    await w.receive(tenant, customer, { text: 'I need to change my booking' }, { receivedMs: 0 });
    await w.receive(tenant, customer, { voice: true }, { receivedMs: 1_000 });
    await w.advanceTo(7_000);
    const outcomes = await outcomesOf(tenant, customer);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]!.outcome, 'reply');
    assert.equal(w.generations().length, 1);
  });

  unitTest('a turn with nothing understood goes to the fallback without a model call', async () => {
    const w = world();
    const tenant = await liveTenant();
    await w.receive(tenant, '15550000041', { voice: true }, { receivedMs: 0 });
    await w.receive(tenant, '15550000042', { unsupported: 'sticker' }, { receivedMs: 0 });
    await w.receive(tenant, '15550000043', { image: {} }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    assert.equal(w.generations().length, 0);
    const triggers = [];
    for (const customer of ['15550000041', '15550000042', '15550000043']) {
      const [outcome] = await outcomesOf(tenant, customer);
      triggers.push([outcome!.outcome, outcome!.fallback_trigger, outcome!.fallback_cause]);
    }
    assert.deepEqual(triggers, [
      ['fallback', 'low_confidence', 'not_understood'],
      ['fallback', 'out_of_scope', 'not_understood'],
      ['fallback', 'low_confidence', 'not_understood'],
    ]);
  });

  unitTest('the turn log carries identifiers and outcomes, never message or reply text', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000044';
    w.provider.backend.script({ kind: 'text', text: '[reply]\nZebra-quartz reply marker' });
    await w.receive(tenant, customer, { text: 'Xylophone-question marker' }, { receivedMs: 0 });
    await w.advanceTo(6_000);
    const log = w.sink.serialized();
    assert.match(log, /conversation\.turn\.answered/);
    assert.doesNotMatch(log, /Xylophone|Zebra/);
    assert.doesNotMatch(log, new RegExp(customer));
  });

  // -------------------------------------------------------------------------
  // Delivery — message-delivery-reliability.md's outbound half
  // -------------------------------------------------------------------------

  /** What this customer was actually sent, in order. */
  function sentTo(customer: string): string[] {
    return cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body);
  }

  /** The tenant's connection as the client and operator would see it. */
  async function connectionOf(tenant: string): Promise<{ state: string; errorReason: string | null }> {
    return withTenant(pool, tenant, async (tx) => {
      const status = await readConnection(tx);
      return { state: status.state, errorReason: status.errorReason };
    });
  }

  async function deliveryOf(tenant: string, customer: string): Promise<ReturnType<typeof readDelivery>> {
    const [outcome] = await outcomesOf(tenant, customer);
    assert.ok(outcome !== undefined, 'no outcome was recorded');
    return withTenant(pool, tenant, (tx) => readDelivery(tx, outcome.turn_id));
  }

  specTest(
    DELIVERY,
    'AC7 a transient send failure is retried and the end customer receives exactly one copy',
    'a rejection Meta answered is retried, and the retry that succeeds is the only message sent',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000050';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nWe are open until six.' });
      cloudBackend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });

      await w.receive(tenant, customer, { text: 'are you open?' }, { receivedMs: 0 });
      await w.advanceTo(6_000, { tolerateFailures: true });

      // The first attempt failed for a reason a retry can fix, so the row is back
      // to pending — not failed — and the handler raised so the queue will retry.
      assert.equal((await deliveryOf(tenant, customer))?.state, 'pending');
      assert.equal(w.board.failures.length, 1);
      assert.deepEqual(sentTo(customer), []);

      assert.equal(await w.deliverAgain(tenant, 2), undefined, 'the retry should succeed');
      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'sent');
      assert.equal(delivery?.attempts, 2, 'both attempts are counted against the allowance');
      assert.ok(delivery?.messageId !== null);
      assert.deepEqual(sentTo(customer), ['We are open until six.'], 'exactly one copy reached the customer');
    },
  );

  specTest(
    DELIVERY,
    'AC7 a transient send failure is retried and the end customer receives exactly one copy',
    'a send whose answer never came back is recorded and never repeated, because it may have arrived',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000051';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nYes, we deliver.' });
      cloudBackend.loseNext('sendText');

      await w.receive(tenant, customer, { text: 'do you deliver?' }, { receivedMs: 0 });
      await w.advanceTo(6_000, { tolerateFailures: true });

      // It did in fact reach Meta. Nothing here can know that, which is the point:
      // the only safe reading of "no answer" is "do not send it again".
      assert.deepEqual(sentTo(customer), ['Yes, we deliver.']);
      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'failed');
      assert.equal(delivery?.failure, 'indeterminate');
      assert.equal(w.board.failures.length, 0, 'an unknowable outcome is settled, not retried');

      // And a job that runs again — the queue is at-least-once — still sends nothing.
      assert.equal(await w.deliverAgain(tenant, 2), undefined);
      assert.deepEqual(sentTo(customer), ['Yes, we deliver.']);
    },
  );

  specTest(
    DELIVERY,
    'AC7 a transient send failure is retried and the end customer receives exactly one copy',
    'a process that dies mid-send leaves the row claimed, and the next attempt records rather than repeats',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000052';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nSee you then.' });
      await w.receive(tenant, customer, { text: 'tomorrow?' }, { receivedMs: 0 });

      // Stop the world between claiming the row and sending: exactly the state a
      // killed worker leaves behind.
      await w.advanceTo(6_000, { tolerateFailures: true });
      const [outcome] = await outcomesOf(tenant, customer);
      await withTenant(pool, tenant, async (tx) => {
        await tx.query(
          `UPDATE conversation_turn_outcomes
              SET delivery_state = 'sending', delivery_message_id = NULL
            WHERE tenant_id = app.current_tenant_id() AND turn_id = $1`,
          [outcome!.turn_id],
        );
      });
      const before = sentTo(customer).length;

      assert.equal(await w.deliverAgain(tenant, 2), undefined);
      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'failed');
      assert.equal(delivery?.failure, 'indeterminate');
      assert.equal(sentTo(customer).length, before, 'a claimed row is never sent a second time');
    },
  );

  specTest(
    DELIVERY,
    'AC8 an exhausted retry allowance is recorded against the tenant, not silently discarded',
    'the last attempt records the failure with its reason and count instead of dropping the reply',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000053';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nWe will be in touch.' });
      for (let i = 0; i < DELIVERY_LIMITS.maxAttempts; i += 1) {
        cloudBackend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });
      }

      await w.receive(tenant, customer, { text: 'hello' }, { receivedMs: 0 });
      await w.advanceTo(6_000, { tolerateFailures: true });
      for (let attempt = 2; attempt <= DELIVERY_LIMITS.maxAttempts; attempt += 1) {
        await w.deliverAgain(tenant, attempt);
      }

      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'failed');
      assert.equal(delivery?.failure, 'attempts_exhausted');
      assert.equal(delivery?.reason, 'rate_limited', 'the operator is told which limit it was');
      assert.equal(delivery?.attempts, DELIVERY_LIMITS.maxAttempts);
      assert.deepEqual(sentTo(customer), []);

      // The reply itself is still there. AC8 forbids discarding it, not failing it.
      const [outcome] = await outcomesOf(tenant, customer);
      assert.equal(outcome!.message, 'We will be in touch.');
    },
  );

  specTest(
    DELIVERY,
    'AC9 a send failure indicating revoked authorization moves the connection, not only the message',
    'a revoked token puts the connection into error with its own reason, where the client can see it',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000054';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nCertainly.' });
      cloudBackend.failNext('sendText', { status: 401, code: 190, message: 'Session invalidated' });

      await w.receive(tenant, customer, { text: 'hi' }, { receivedMs: 0 });
      await w.advanceTo(6_000, { tolerateFailures: true });

      assert.deepEqual(await connectionOf(tenant), { state: 'error', errorReason: 'authorization_revoked' });
      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'failed');
      assert.equal(delivery?.failure, 'rejected', 'a revoked token is not worth a retry');
      assert.equal(w.board.failures.length, 0);
    },
  );

  specTest(
    'whatsapp-number-connection.md',
    'AC4 an interruption the platform can recover from moves the connection to reconnecting',
    'a rate limit moves a connected number to reconnecting rather than error, and a later send restores it',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000055';
      w.provider.backend.script(
        { kind: 'text', text: '[reply]\nOne moment.' },
        { kind: 'text', text: '[reply]\nAll set.' },
      );
      cloudBackend.failNext('sendText', { status: 429, code: 130429, message: 'Rate limit hit' });

      await w.receive(tenant, customer, { text: 'hi' }, { receivedMs: 0 });
      await w.advanceTo(6_000, { tolerateFailures: true });
      assert.deepEqual(await connectionOf(tenant), { state: 'reconnecting', errorReason: null });

      // The retry is the recovery attempt: it succeeding is the only evidence the
      // platform gets that the link is back.
      await w.deliverAgain(tenant, 2);
      assert.deepEqual(await connectionOf(tenant), { state: 'connected', errorReason: null });
      assert.deepEqual(sentTo(customer), ['One moment.']);
    },
  );

  specTest(
    DELIVERY,
    'AC10 a reply outside the 24-hour customer service window is detected and recorded, not silently dropped',
    'a reply decided more than 24 hours after the customer last wrote is recorded as expired and never sent',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000056';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nSorry for the delay.' });

      // The message arrives now but was *sent* over a day ago — which is what the
      // window is measured from, and what a long enough outage produces.
      await w.receive(tenant, customer, { text: 'still there?' }, {
        receivedMs: 0,
        sentMs: -(DELIVERY_LIMITS.customerServiceWindowMs + 60_000),
      });
      await w.advanceTo(6_000);

      const delivery = await deliveryOf(tenant, customer);
      assert.equal(delivery?.state, 'expired');
      assert.equal(delivery?.failure, 'window_expired');
      assert.equal(delivery?.attempts, 0, 'nothing was attempted, so nothing is counted');
      assert.deepEqual(sentTo(customer), []);

      // The answer is still on the row. AC10 asks for the occurrence to be
      // recorded, which is not the same as the reply ceasing to exist.
      const [outcome] = await outcomesOf(tenant, customer);
      assert.equal(outcome!.message, 'Sorry for the delay.');
    },
  );

  specTest(
    DELIVERY,
    'AC17 delivery diagnostics contain operational information only',
    'the delivery log carries states, reasons, and references — never the reply text or the customer number',
    async () => {
      const w = world();
      const tenant = await liveTenant();
      const customer = '15550000057';
      w.provider.backend.script({ kind: 'text', text: '[reply]\nJuniper-lantern delivery marker' });
      await w.receive(tenant, customer, { text: 'Obsidian-kettle question marker' }, { receivedMs: 0 });
      await w.advanceTo(6_000);

      const log = w.sink.serialized();
      assert.match(log, /conversation\.delivery\.settled/);
      assert.doesNotMatch(log, /Juniper|Obsidian/);
      assert.doesNotMatch(log, new RegExp(customer));
    },
  );

  unitTest('a tenant that disconnected before its answer went out records the failure rather than retrying forever', async () => {
    const w = world();
    const tenant = await liveTenant();
    const customer = '15550000058';
    w.provider.backend.script({ kind: 'text', text: '[reply]\nToo late.' });
    await w.receive(tenant, customer, { text: 'hello' }, { receivedMs: 0 });

    // Decided while connected, disconnected before the send — an ordinary race
    // between a client on a settings screen and a worker on a queue.
    await w.advanceTo(6_000, { hold: [DELIVERY_JOB_KIND] });
    await withTenant(pool, tenant, (tx) => transitionConnection(tx, 'disconnected'));
    await w.runDue();

    const delivery = await deliveryOf(tenant, customer);
    assert.equal(delivery?.state, 'failed');
    assert.equal(delivery?.reason, 'not_connected');
    assert.deepEqual(sentTo(customer), []);
  });

  // -------------------------------------------------------------------------
  // The vocabularies and the CHECK constraints agree
  // -------------------------------------------------------------------------

  async function checkValues(table: string, column: string): Promise<string[]> {
    const result = await pool.query<{ definition: string }>(
        `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
          WHERE c.conrelid = $1::regclass AND c.contype = 'c'`,
        [table],
    );
    const definition = result.rows
      .map((row) => row.definition)
      .find((text) => new RegExp(`^CHECK \\(\\(?${column} = ANY|^CHECK \\(\\(${column} = ANY`).test(text));
    assert.ok(definition !== undefined, `no value-list CHECK on ${table}.${column}`);
    return [...definition.matchAll(/'([a-z_]+)'::text/g)].map((match) => match[1]!).sort();
  }

  unitTest('the TypeScript vocabularies match the migration CHECK constraints', async () => {
    assert.deepEqual(await checkValues('inbound_dispositions', 'disposition'), [...INBOUND_DISPOSITIONS].sort());
    assert.deepEqual(await checkValues('conversation_turns', 'state'), [...TURN_STATES].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'outcome'), [...TURN_OUTCOMES].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'withheld_reason'), [...WITHHELD_REASONS].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'fallback_trigger'), [...FALLBACK_TRIGGERS].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'fallback_cause'), [...FALLBACK_CAUSES].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'delivery_state'), [...DELIVERY_STATES].sort());
    assert.deepEqual(await checkValues('conversation_turn_outcomes', 'delivery_failure'), [...DELIVERY_FAILURES].sort());
  });
});
