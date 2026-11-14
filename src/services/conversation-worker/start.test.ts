/**
 * The worker end to end: real PostgreSQL, the real queue, the real consumer loop,
 * real time. Only the model is faked.
 *
 * The library tests (`@zeddev/conversation`) drive the handlers with a simulated
 * clock and pin down what a turn is. This file proves the process around them:
 * that a message stored and scheduled the way the gateway does it gets exactly one
 * answer, with nobody calling a handler by hand — including the turn's delayed
 * job, which has to wake a sleeping consumer when its window runs out rather than
 * whenever the consumer's idle timeout next lets it look.
 *
 * WhatsApp is faked at the port, not at the process: the worker builds its own
 * sealer from `VAULT_SEALING_KEYS` and unseals the tenant's real access token to
 * send, so what this file proves is the whole outbound path bar the socket to
 * Meta — which `@zeddev/whatsapp`'s conformance suite covers against a wire-level
 * stub.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider, type ObservedGeneration } from '@zeddev/ai/testing';
import { createBehaviorRule, createKnowledgeEntry, saveFallbackMessages, savePersona, setBotActive } from '@zeddev/bot';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConfigurationError } from '@zeddev/errors';
import { MemorySink } from '@zeddev/logging';
import { PostgresQueue } from '@zeddev/queue';
import { generateSealingKey, parseSealingKey, SecretSealer } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import {
  INBOUND_JOB_KIND,
  INBOUND_QUEUE,
  recordInboundMessage,
  submitCredentials,
  transitionConnection,
} from '@zeddev/whatsapp';
import { InMemoryWhatsAppCloud, ScriptedCloudBackend } from '@zeddev/whatsapp/testing';
import { loadWorkerSettings } from './config.ts';
import { startWorker, type RunningWorker } from './start.ts';

const APP_ID = '3090001111';
const BUSINESS_ACCOUNT_ID = '20220002222';
const SEALING_KEY = generateSealingKey('worker');

function envFor(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string> {
  const options = db.options;
  return {
    DATABASE_HOST: options.host,
    DATABASE_PORT: String(options.port),
    DATABASE_NAME: options.database,
    DATABASE_USER: options.user,
    DATABASE_PASSWORD: options.password?.expose() ?? '',
    DATABASE_SSL_MODE: 'disable',
    AI_BASE_URL: 'https://example.com/v1beta',
    AI_MODEL: 'gemini-2.5-flash',
    VAULT_SEALING_KEYS: SEALING_KEY,
    WHATSAPP_API_BASE_URL: 'https://example.com/v21.0',
    WHATSAPP_APP_ID: APP_ID,
    WHATSAPP_APP_SECRET: ['worker', 'app', 'secret'].join('-'),
    WHATSAPP_WEBHOOK_VERIFY_TOKEN: ['worker', 'verify', 'token'].join('-'),
    WORKER_AGGREGATION_WINDOW: '600ms',
    WORKER_MAX_TURN_DURATION: '3s',
    ...overrides,
  };
}

unitTest('startup names every missing worker key at once', async () => {
  await assert.rejects(startWorker({}), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    // The WhatsApp keys are here because the worker sends replies, and the
    // schema is loaded whole rather than split — one key, one definition. The
    // cost is that the worker also demands the two the gateway alone uses.
    assert.deepEqual(error.keys, [
      'AI_BASE_URL',
      'AI_MODEL',
      'DATABASE_HOST',
      'DATABASE_NAME',
      'DATABASE_PASSWORD',
      'DATABASE_USER',
      'VAULT_SEALING_KEYS',
      'WHATSAPP_API_BASE_URL',
      'WHATSAPP_APP_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_WEBHOOK_VERIFY_TOKEN',
    ]);
    return true;
  });
});

unitTest('a maximum turn duration shorter than the aggregation window is refused', () => {
  assert.throws(
    () => loadWorkerSettings({ WORKER_AGGREGATION_WINDOW: '10s', WORKER_MAX_TURN_DURATION: '5s' }),
    (error: unknown) => error instanceof ConfigurationError && error.keys.includes('WORKER_MAX_TURN_DURATION'),
  );
  const defaults = loadWorkerSettings({});
  assert.ok(defaults.aggregationWindowMs > 0 && defaults.maxTurnDurationMs >= defaults.aggregationWindowMs);
});

describe('conversation worker', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let worker: RunningWorker;
  const provider = new InMemoryAiProvider();
  const cloudBackend = new ScriptedCloudBackend();
  const sink = new MemorySink();
  // The same keys the worker will build its own sealer from, so a token sealed
  // by this fixture is one the worker can actually unseal.
  const sealer = new SecretSealer([parseSealingKey(SEALING_KEY, 'VAULT_SEALING_KEYS')]);
  let counter = 0;
  const tokens = new Map<string, string>();

  before(async () => {
    db = await createTestDatabase('worker');
    pool = db.pool;
    // The idle wait is left long on purpose: a turn must be answered because its
    // delayed job woke the consumer, not because the consumer happened to look.
    worker = await startWorker(envFor(db), {
      ai: provider,
      cloud: new InMemoryWhatsAppCloud({ appId: APP_ID, backend: cloudBackend }),
      sink,
      idleWaitMs: 60_000,
    });
  });

  after(async () => {
    await worker?.stop();
    await db?.drop();
  });

  async function liveTenant(): Promise<{ tenant: string; phoneNumberId: string }> {
    counter += 1;
    const phoneNumberId = String(800_000_000 + counter);
    const tenant = await withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Worker Winery ${counter}`],
      );
      return created.rows[0]!.id;
    });
    const token = ['worker', String(counter), 'token'].join('-');
    tokens.set(tenant, token);
    cloudBackend.register({ token, phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, appId: APP_ID });
    await withTenant(pool, tenant, async (tx) => {
      await submitCredentials(
        tx,
        sealer,
        { phoneNumberId, businessAccountId: BUSINESS_ACCOUNT_ID, accessToken: token },
        { principal: 'worker-test' },
      );
      await transitionConnection(tx, 'connected');
      await savePersona(tx, { botName: 'Vera' });
      await setBotActive(tx, true);
    });
    return { tenant, phoneNumberId };
  }

  /** What the gateway does with one accepted message: store it and schedule it, together. */
  async function deliver(
    tenant: string,
    phoneNumberId: string,
    customerId: string,
    externalId: string,
    message: string | { readonly voiceNote: string },
  ) {
    const scheduler = new PostgresQueue({ name: INBOUND_QUEUE, pool });
    await withTenant(pool, tenant, async (tx) => {
      const stored = await recordInboundMessage(tx, phoneNumberId, {
        externalId,
        customerId,
        ...(typeof message === 'string'
          ? { type: 'text', upstreamType: 'text', content: { text: message } }
          : { type: 'audio', upstreamType: 'audio', content: { mediaId: message.voiceNote, mimeType: 'audio/ogg', voice: true } }),
        sentAt: new Date(),
      });
      if (stored.created) {
        await scheduler.enqueueWithin(tx, {
          kind: INBOUND_JOB_KIND,
          payload: { inboundMessageId: stored.id },
          partitionKey: customerId,
          dedupeKey: externalId,
        });
      }
    });
  }

  /** What this customer was actually sent, in order. */
  function sentTo(customer: string): string[] {
    return cloudBackend.sends.filter((send) => send.to === customer).map((send) => send.body);
  }

  function outcomes(tenant: string) {
    return withTenant(pool, tenant, async (tx) => {
      const result = await tx.query<{ outcome: string; message: string | null }>(
        'SELECT outcome, message FROM conversation_turn_outcomes ORDER BY decided_at',
      );
      return result.rows;
    });
  }

  async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, label: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const value = await read();
      if (done(value)) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  specTest(
    'message-burst-aggregation.md',
    'AC1 three messages inside the window get exactly one reply',
    'a burst delivered through the queue is answered once, after the window, by the running worker',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      provider.backend.script({ kind: 'text', text: '[reply]\nHappy to help with both!' });
      const started = Date.now();
      await deliver(tenant, phoneNumberId, '15551230001', 'wamid.worker-1', 'hi');
      await deliver(tenant, phoneNumberId, '15551230001', 'wamid.worker-2', 'two questions');
      const answered = await eventually(() => outcomes(tenant), (rows) => rows.length > 0, 'the turn to be answered');
      const elapsed = Date.now() - started;

      assert.deepEqual(answered, [{ outcome: 'reply', message: 'Happy to help with both!' }]);
      assert.ok(elapsed >= 600, `answered after ${elapsed} ms, before the aggregation window could elapse`);
      assert.ok(elapsed < 5_000, `answered after ${elapsed} ms — the consumer slept past the turn's due time`);
      // Nothing more arrives for it, however long we wait.
      await new Promise((resolve) => setTimeout(resolve, 800));
      assert.equal((await outcomes(tenant)).length, 1);
      // And it was actually sent — by the running process, over the port, with
      // the tenant's own token unsealed on the way. One copy, for two messages.
      await eventually(
        async () => sentTo('15551230001'),
        (sends) => sends.length > 0,
        'the reply to be delivered',
      );
      assert.deepEqual(sentTo('15551230001'), ['Happy to help with both!']);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC4 a redelivered message is not stored again and not replied to again',
    'a redelivery stored nothing, so the worker answers the turn once',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      await deliver(tenant, phoneNumberId, '15551230002', 'wamid.worker-dup', 'hello');
      await deliver(tenant, phoneNumberId, '15551230002', 'wamid.worker-dup', 'hello');
      await eventually(() => outcomes(tenant), (rows) => rows.length > 0, 'the turn to be answered');
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      assert.equal((await outcomes(tenant)).length, 1);
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'AC14 media retrieval is retried up to its allowance',
    'through the real queue, a failed retrieval comes back after its backoff and the voice note is answered',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      const customer = '15551230003';
      cloudBackend.registerMedia({ token: tokens.get(tenant)!, mediaId: '8801', mimeType: 'audio/ogg', data: Uint8Array.of(1, 2, 3) });
      cloudBackend.failNext('downloadMedia', { status: 503, code: 999999 });
      provider.backend.script({ kind: 'text', text: 'Do you open on Sunday?' }, { kind: 'text', text: '[reply]\nYes, from ten.' });

      await deliver(tenant, phoneNumberId, customer, 'wamid.worker-voice', { voiceNote: '8801' });
      await eventually(async () => sentTo(customer), (sends) => sends.length > 0, 'the voice note to be answered');

      assert.deepEqual(sentTo(customer), ['Yes, from ten.']);
      const settled = await withTenant(pool, tenant, async (tx) =>
        (await tx.query<{ attempts: number; understood_text: string }>('SELECT attempts, understood_text FROM inbound_media_understandings')).rows,
      );
      assert.deepEqual(
        settled.map((row) => ({ ...row })),
        [{ attempts: 2, understood_text: 'Do you open on Sunday?' }],
        'the attempt number must be the one the queue counted',
      );
    },
  );

  unitTest(
    'a real message through the running worker is counted as received, answered and sent, with what the customer waited',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      provider.backend.script({ kind: 'text', text: '[reply]\nCounted.' });
      await deliver(tenant, phoneNumberId, '15551230777', 'wamid.counted-1', 'hello');
      await eventually(async () => sentTo('15551230777'), (sends) => sends.length > 0, 'the reply to be delivered');

      const counts = () =>
        withPlatformScope(pool, async (tx) => {
          const rows = await tx.query<{ received: number; answered: number; sent: number; timed: number; waited: number }>(
            `SELECT SUM(messages_received)::int AS received, SUM(turns_answered)::int AS answered, SUM(messages_sent)::int AS sent,
                    SUM(responses_timed)::int AS timed, SUM(response_ms_total)::int AS waited
               FROM tenant_metric_buckets WHERE tenant_id = $1`,
            [tenant],
          );
          return rows.rows[0]!;
        });
      const counted = await eventually(counts, (row) => row.sent === 1, 'the send to be counted');
      assert.equal(counted.received, 1);
      assert.equal(counted.answered, 1);
      assert.equal(counted.timed, 1);
      assert.ok(counted.waited >= 600, `recorded ${counted.waited} ms, shorter than the aggregation window`);
    },
  );

  // -------------------------------------------------------------------------
  // Text conversation handling, through the running process
  //
  // `@zeddev/bot` proves what a prompt says and how the model's answer is read;
  // these prove the process around them: the message the gateway stored is what
  // the model is shown, the configuration in the prompt is the tenant's own as
  // committed, and the words the customer receives are the model's answer or the
  // tenant's own fallback text, never anything else. Whether a real model's
  // answer is *correct* is outside what a fake can show and is the verification
  // suite's job (`verifyAiProvider`, which runs a knowledge question too).
  // -------------------------------------------------------------------------

  /** The one generation request whose customer turns contain `needle`. */
  function generationShowing(needle: string): ObservedGeneration {
    const matching = provider.backend.requests.filter(
      (request): request is ObservedGeneration =>
        request.operation === 'generate' &&
        request.turns.some((turn) => turn.parts.some((part) => part.type === 'text' && part.text.includes(needle))),
    );
    assert.equal(matching.length, 1, `expected one generation showing ${JSON.stringify(needle)}`);
    return matching[0]!;
  }

  /** The text of the last thing the customer said, as the model was shown it. */
  function lastCustomerText(generation: ObservedGeneration): string {
    const turn = generation.turns.at(-1)!;
    assert.equal(turn.role, 'customer');
    return turn.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');
  }

  specTest(
    'text-conversation-handling.md',
    'AC1 a question covered by the configured knowledge is answered using that knowledge',
    "the question reaches the model with the tenant's knowledge in its prompt, and the answer reaches the customer as written",
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      const fact = 'We deliver within Lisbon only; delivery there is free above 30 euros.';
      await withTenant(pool, tenant, async (tx) => {
        await createKnowledgeEntry(tx, { content: fact });
        await createKnowledgeEntry(tx, { content: 'Gift wrapping costs 2 euros.' });
      });
      const customer = '15551230101';
      const question = 'Do you deliver to Porto?';
      const answer = 'Sorry, we only deliver within Lisbon. There, delivery is free above 30 euros.';
      provider.backend.script({ kind: 'text', text: `[reply]\n${answer}` });

      await deliver(tenant, phoneNumberId, customer, 'wamid.text-knowledge', question);
      await eventually(async () => sentTo(customer), (sends) => sends.length > 0, 'the answer to be delivered');

      const seen = generationShowing(question);
      assert.ok(seen.instructions.includes(fact), 'the knowledge the question is about was not in the prompt');
      assert.equal(lastCustomerText(seen), question);
      assert.deepEqual(sentTo(customer), [answer]);
    },
  );

  specTest(
    'text-conversation-handling.md',
    "AC2 each bot reply reflects its own business's configured persona",
    "two live tenants answering the same message are each prompted with their own persona, and each customer gets their own tenant's answer",
    async () => {
      const formal = await liveTenant();
      const casual = await liveTenant();
      await withTenant(pool, formal.tenant, (tx) =>
        savePersona(tx, { botName: 'Dona Helena', formality: 'formal', styleTraits: [], freeformInstructions: 'Address customers as "o senhor" or "a senhora".' }),
      );
      await withTenant(pool, casual.tenant, (tx) =>
        savePersona(tx, { botName: 'Zé', formality: 'casual', styleTraits: [], freeformInstructions: 'Keep it short and friendly, emoji welcome.' }),
      );
      const message = (n: string) => `Are you open on Saturday? (${n})`;

      // One at a time, so each scripted answer is the one its own turn consumes.
      provider.backend.script({ kind: 'text', text: '[reply]\nGood afternoon. Yes, we are open on Saturday from nine.' });
      await deliver(formal.tenant, formal.phoneNumberId, '15551230201', 'wamid.persona-formal', message('formal'));
      await eventually(async () => sentTo('15551230201'), (sends) => sends.length > 0, 'the formal answer');
      provider.backend.script({ kind: 'text', text: '[reply]\nYep! Saturday from 9 😄' });
      await deliver(casual.tenant, casual.phoneNumberId, '15551230202', 'wamid.persona-casual', message('casual'));
      await eventually(async () => sentTo('15551230202'), (sends) => sends.length > 0, 'the casual answer');

      const formalPrompt = generationShowing(message('formal')).instructions;
      const casualPrompt = generationShowing(message('casual')).instructions;
      assert.match(formalPrompt, /"Dona Helena"/);
      assert.match(formalPrompt, /o senhor/);
      assert.match(casualPrompt, /"Zé"/);
      assert.match(casualPrompt, /emoji welcome/);
      for (const [prompt, foreign] of [
        [formalPrompt, ['Zé', 'emoji welcome']],
        [casualPrompt, ['Dona Helena', 'o senhor']],
      ] as const) {
        for (const text of foreign) assert.ok(!prompt.includes(text), `another tenant's persona reached the prompt: ${text}`);
      }
      assert.deepEqual(sentTo('15551230201'), ['Good afternoon. Yes, we are open on Saturday from nine.']);
      assert.deepEqual(sentTo('15551230202'), ['Yep! Saturday from 9 😄']);
    },
  );

  specTest(
    'text-conversation-handling.md',
    'AC5 a message that would prompt a rule violation gets a reply that complies with the rule',
    "the tenant's rule is in the prompt, and a model that declines under it sends the tenant's own fallback text, not its words",
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      const declined = 'We can only help with questions about our own products.';
      await withTenant(pool, tenant, async (tx) => {
        await createBehaviorRule(tx, {
          kind: 'never',
          subject: 'discuss the prices of competitor products',
          condition: null,
          action: 'fallback',
        });
        await saveFallbackMessages(tx, { triggerMessages: { out_of_scope: declined } });
      });
      const customer = '15551230301';
      const question = 'Is the bakery across the street cheaper than you?';
      provider.backend.script({ kind: 'text', text: '[fallback] out_of_scope' });

      await deliver(tenant, phoneNumberId, customer, 'wamid.text-rule', question);
      await eventually(async () => sentTo(customer), (sends) => sends.length > 0, 'the declining answer');

      const prompt = generationShowing(question).instructions;
      assert.match(prompt, /\[rule 1\] Never do this: "discuss the prices of competitor products"\./);
      assert.match(prompt, /take the "fallback" action/);
      assert.deepEqual(sentTo(customer), [declined]);
      assert.deepEqual(await outcomes(tenant), [{ outcome: 'fallback', message: declined }]);
    },
  );

  specTest(
    'text-conversation-handling.md',
    'AC6 a text message containing emoji, unusual punctuation, or line breaks is still processed',
    'emoji, line breaks, punctuation and mixed casing reach the model unchanged, and a reply carrying them reaches the customer unchanged',
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      const customer = '15551230601';
      const message = 'Oi!!! 😍😍\n\nVocês têm bolo de CHOCOLATE??? (sem glúten…) 🎂🍫\n— obrigada!! ;-) #42 @loja';
      const answer = 'Temos sim! 🎂\n\nBolo de chocolate sem glúten: €18,50 (encomenda com 24h…).\n— Até já! 😊';
      provider.backend.script({ kind: 'text', text: `[reply]\n${answer}` });

      await deliver(tenant, phoneNumberId, customer, 'wamid.text-emoji', message);
      await eventually(async () => sentTo(customer), (sends) => sends.length > 0, 'the answer to be delivered');

      assert.equal(lastCustomerText(generationShowing('bolo de CHOCOLATE')), message);
      assert.deepEqual(sentTo(customer), [answer]);
    },
  );

  specTest(
    'text-conversation-handling.md',
    'AC7 no empty, malformed, or placeholder-broken message is sent',
    "model output the platform cannot act on sends the tenant's error fallback, never the output itself",
    async () => {
      const { tenant, phoneNumberId } = await liveTenant();
      const apology = 'Our assistant is having trouble right now; we will reply soon.';
      await withTenant(pool, tenant, (tx) => saveFallbackMessages(tx, { triggerMessages: { ai_error: apology } }));
      const unusable = [
        ['15551230701', ''],
        ['15551230702', '[reply]\n   '],
        ['15551230703', 'Sure, we are open.\n[handoff] human_request'],
      ] as const;

      for (const [customer, output] of unusable) {
        provider.backend.script({ kind: 'text', text: output });
        await deliver(tenant, phoneNumberId, customer, `wamid.unusable-${customer}`, `hello from ${customer}`);
        await eventually(async () => sentTo(customer), (sends) => sends.length > 0, `the fallback for ${customer}`);
        assert.deepEqual(sentTo(customer), [apology], `output ${JSON.stringify(output)} must become the error fallback`);
      }
      assert.ok(
        cloudBackend.sends.every((send) => send.body.trim() !== '' && !/^\s*\[(reply|handoff|fallback)\]/im.test(send.body)),
        'an empty or tag-carrying message was sent',
      );
    },
  );

  specTest(
    'text-conversation-handling.md',
    'AC8 the reply is sent as text on the same WhatsApp conversation thread the customer messaged from',
    'each reply goes to the customer who wrote, from the business number they wrote to, even when one person writes to two businesses at once',
    async () => {
      const first = await liveTenant();
      const second = await liveTenant();
      const person = '15551230801';
      const other = '15551230802';
      // Concurrent on purpose: each turn takes whatever answer it is given, so
      // what is asserted is where each answer went, not which one it was.
      await Promise.all([
        deliver(first.tenant, first.phoneNumberId, person, 'wamid.thread-1', 'hi first shop'),
        deliver(second.tenant, second.phoneNumberId, person, 'wamid.thread-2', 'hi second shop'),
        deliver(first.tenant, first.phoneNumberId, other, 'wamid.thread-3', 'hi from someone else'),
      ]);
      const threads = () =>
        cloudBackend.sends
          .filter((send) => send.to === person || send.to === other)
          .map((send) => `${send.phoneNumberId}->${send.to}`)
          .sort();
      await eventually(async () => threads(), (sent) => sent.length >= 3, 'all three replies');
      await new Promise((resolve) => setTimeout(resolve, 300));

      assert.deepEqual(
        threads(),
        [`${first.phoneNumberId}->${person}`, `${first.phoneNumberId}->${other}`, `${second.phoneNumberId}->${person}`].sort(),
      );
    },
  );

  specTest(
    'component-independence.md',
    'AC9 the affected component is identifiable',
    'the worker, which listens on no port, reports itself while running and records a clean stop',
    async () => {
      const second = await startWorker(envFor(db), { ai: provider, sink: new MemorySink() });
      const heartbeat = () => withPlatformScope(pool, async (tx) =>
        (await tx.query<{ component: string; stopped: boolean }>(
          'SELECT component, stopped_at IS NOT NULL AS stopped FROM component_heartbeats WHERE instance_id = $1',
          [second.instanceId],
        )).rows[0],
      );
      assert.deepEqual(await heartbeat(), { component: 'conversation-worker', stopped: false });
      // Idempotent: two signals during shutdown are harmless.
      await Promise.all([second.stop(), second.stop()]);
      assert.deepEqual(await heartbeat(), { component: 'conversation-worker', stopped: true });
    },
  );
});
