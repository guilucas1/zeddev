/**
 * Prompt assembly and the reply output protocol.
 *
 * Two layers, tested separately because they fail differently:
 *
 * - **What the model is told.** `replyInstructions` is pure, so the order and
 *   presence of each section is asserted directly, and `readReplyConfiguration`
 *   is tested against a real PostgreSQL because "the tenant's own configuration,
 *   and only it" is a row-level-security fact.
 * - **What the model's answer becomes.** `interpretReply` is the only reader of
 *   the output protocol, and its job is to fail safe: every shape of output that
 *   is not a clean reply must become a decision the platform can act on without
 *   sending the customer something broken. Those tests enumerate the shapes.
 *
 * `generateReply` and `previewReply` run against `InMemoryAiProvider`, which goes
 * through the same request normalisation and retry loop as the real adapters, so
 * "the preview saw the same instructions as a live reply" is asserted against
 * what the model was actually shown.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { InMemoryAiProvider, type ObservedGeneration } from '@zeddev/ai/testing';
import { withIdentityScope, withTenant, type Connection, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { behaviorDirectives, createBehaviorRule, saveBehaviorInstructions, type BehaviorConfiguration, type BehaviorRule } from './behavior.ts';
import { saveDisclosureSetting } from './disclosure.ts';
import { PLATFORM_DEFAULT_FALLBACK_MESSAGES, saveFallbackMessages, readFallbackMessages } from './fallback.ts';
import { saveHandoffSettings, type HandoffPolicy } from './handoff.ts';
import { createKnowledgeEntry } from './knowledge.ts';
import { savePersona, type Persona } from './persona.ts';
import {
  generateReply,
  interpretReply,
  parsePreviewInput,
  previewReply,
  readReplyConfiguration,
  REPLY_LIMITS,
  replyInstructions,
  type ReplyConfiguration,
} from './reply.ts';

const NOW = new Date('2026-09-19T12:00:00Z');

function rule(id: string, overrides: Partial<BehaviorRule> = {}): BehaviorRule {
  return {
    id,
    kind: 'never',
    subject: `rule ${id}`,
    condition: null,
    action: 'respond',
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const PERSONA: Persona = {
  botName: 'Bia',
  formality: 'casual',
  styleTraits: [],
  freeformInstructions: null,
  updatedAt: NOW,
} as unknown as Persona;

const HANDOFF_ON: HandoffPolicy = { enabled: true, triggers: ['human_request', 'complaint'], customConditions: ['the customer asks for a refund'] };
const HANDOFF_OFF: HandoffPolicy = { enabled: false, triggers: ['human_request', 'complaint', 'out_of_scope'], customConditions: [] };

const BEHAVIOR: BehaviorConfiguration = {
  rules: [
    rule('00000000-0000-4000-8000-000000000001', { subject: 'quote competitor prices' }),
    rule('00000000-0000-4000-8000-000000000002', { enabled: false, action: 'handoff' }),
    rule('00000000-0000-4000-8000-000000000003', { kind: 'avoid_topic', subject: 'legal advice', action: 'handoff' }),
    rule('00000000-0000-4000-8000-000000000004', { kind: 'avoid_topic', subject: 'politics', action: 'fallback' }),
  ],
  freeformInstructions: null,
};

function configuration(overrides: Partial<ReplyConfiguration> = {}): ReplyConfiguration {
  return {
    persona: PERSONA,
    disclosureMode: 'disclose',
    behavior: BEHAVIOR,
    handoff: HANDOFF_ON,
    knowledge: { entries: [] },
    ...overrides,
  };
}

function interpret(text: string, overrides: Partial<ReplyConfiguration> = {}, truncated = false) {
  return interpretReply({ text, truncated }, configuration(overrides));
}

// ---------------------------------------------------------------------------
// What the model is told
// ---------------------------------------------------------------------------

unitTest('the reply prompt composes every configured section, in a fixed order', () => {
  const text = replyInstructions(
    configuration({
      knowledge: {
        entries: [{ id: 'k', content: 'We open at 9.', createdAt: NOW, updatedAt: NOW } as never],
      },
    }),
    { conversationStart: true },
  );
  const order = [
    "You are a business's assistant on WhatsApp",
    'You are "Bia"',
    'This is the start of a new conversation',
    'The business provided the following facts',
    'The business set these rules',
    'A person from the business can take over',
    'How to answer:',
  ].map((marker) => {
    const at = text.indexOf(marker);
    assert.ok(at >= 0, `missing section: ${marker}`);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

unitTest('a section with nothing configured is absent from the reply prompt, not empty', () => {
  const text = replyInstructions(
    configuration({ persona: undefined, behavior: { rules: [], freeformInstructions: null } }),
    { conversationStart: false },
  );
  assert.doesNotMatch(text, /You are "/);
  assert.doesNotMatch(text, /The business set these rules/);
  assert.doesNotMatch(text, /provided the following facts/);
  assert.doesNotMatch(text, /\n\n\n/);
});

specTest(
  'behavior-rules-configuration.md',
  'AC4 a handoff-action rule routes to handoff',
  'each enabled rule is numbered in the prompt so a reply can name the rule whose handoff action it took',
  () => {
    const text = behaviorDirectives(BEHAVIOR)!;
    assert.match(text, /\[rule 1\] Never do this: "quote competitor prices"/);
    // The disabled rule takes no number, so numbering follows the enabled list.
    assert.match(text, /\[rule 2\] Do not discuss or engage with this topic: "legal advice".*naming this rule by its number/);
    assert.match(text, /\[rule 3\] Do not discuss or engage with this topic: "politics"/);
    assert.doesNotMatch(text, /\[rule 4\]/);
  },
);

specTest(
  'human-handoff.md',
  'AC1 with handoff disabled a would-be handoff gets fallback behaviour',
  'the output protocol offers the handoff form only while handoff is enabled',
  () => {
    assert.match(replyInstructions(configuration({ handoff: HANDOFF_ON }), { conversationStart: false }), /\[handoff\] human_request/);
    const off = replyInstructions(configuration({ handoff: HANDOFF_OFF }), { conversationStart: false });
    assert.doesNotMatch(off, /\[handoff\]/);
    assert.match(off, /\[fallback\] out_of_scope/);
  },
);

// ---------------------------------------------------------------------------
// What the model's answer becomes
// ---------------------------------------------------------------------------

unitTest('a tagged reply is sent without its tag, whether the message starts on the tag line or below it', () => {
  assert.deepEqual(interpret('[reply]\nHi! We open at 9 😊\nSee you soon.'), {
    path: 'reply',
    text: 'Hi! We open at 9 😊\nSee you soon.',
  });
  assert.deepEqual(interpret('\n  [REPLY] Hi there!\r\nBye'), { path: 'reply', text: 'Hi there!\nBye' });
});

unitTest('untagged output with no tag anywhere is accepted as the reply', () => {
  assert.deepEqual(interpret('  Sure — we deliver on Saturdays.  '), { path: 'reply', text: 'Sure — we deliver on Saturdays.' });
});

specTest(
  'text-conversation-handling.md',
  'AC7 no empty, malformed, or placeholder-broken message is sent',
  'output the platform cannot act on becomes the error fallback, never a message',
  () => {
    const unusable = { path: 'fallback', trigger: 'ai_error', cause: 'unusable_output' };
    assert.deepEqual(interpret(''), unusable);
    assert.deepEqual(interpret('  \n\n '), unusable);
    assert.deepEqual(interpret('[reply]'), unusable, 'a tag with no message');
    assert.deepEqual(interpret('[reply]\n   \n'), unusable);
    assert.deepEqual(interpret('Sure thing.\n[handoff] human_request'), unusable, 'a tag below the first line');
    assert.deepEqual(interpret('[reply]\nHello\n[fallback] out_of_scope'), unusable, 'two forms at once');
    assert.deepEqual(interpret('[reply]\nHello\u0000'), unusable, 'a control character');
    assert.deepEqual(interpret(`[reply]\n${'a'.repeat(REPLY_LIMITS.messageMaxLength + 1)}`), unusable, 'longer than one WhatsApp message');
    assert.deepEqual(interpret(`[reply]\n${'😊'.repeat(REPLY_LIMITS.messageMaxLength)}`).path, 'reply', 'the limit counts characters, not UTF-16 units');
  },
);

unitTest('a reply cut off by the output bound becomes the error fallback, but a cut-off handoff or fallback line still counts', () => {
  assert.deepEqual(interpret('[reply]\nOur opening hours are', {}, true), { path: 'fallback', trigger: 'ai_error', cause: 'truncated' });
  assert.deepEqual(interpret('[handoff] complaint\nI am so', {}, true), {
    path: 'handoff',
    reason: { kind: 'trigger', trigger: 'complaint' },
  });
  assert.deepEqual(interpret('[fallback] low_confidence', {}, true), { path: 'fallback', trigger: 'low_confidence', cause: 'declined' });
});

specTest(
  'fallback-response-behavior.md',
  'AC3 each trigger gets its own message',
  'the model declines with the trigger it names, and anything it cannot name is out of scope',
  () => {
    assert.deepEqual(interpret('[fallback] low_confidence'), { path: 'fallback', trigger: 'low_confidence', cause: 'declined' });
    assert.deepEqual(interpret('[FALLBACK]  out_of_scope \nignored'), { path: 'fallback', trigger: 'out_of_scope', cause: 'declined' });
    // ai_error is the platform's to raise, never the model's.
    assert.deepEqual(interpret('[fallback] ai_error'), { path: 'fallback', trigger: 'out_of_scope', cause: 'unusable_output' });
    assert.deepEqual(interpret('[fallback]'), { path: 'fallback', trigger: 'out_of_scope', cause: 'unusable_output' });
  },
);

specTest(
  'fallback-response-behavior.md',
  'AC6 with handoff enabled the message is routed to handoff instead of fallback',
  'a handoff line naming a configured trigger, custom condition, or handoff rule becomes a handoff',
  () => {
    assert.deepEqual(interpret('[handoff] human_request'), { path: 'handoff', reason: { kind: 'trigger', trigger: 'human_request' } });
    assert.deepEqual(interpret('[handoff] custom "the customer asks for a refund"'), {
      path: 'handoff',
      reason: { kind: 'custom_condition', condition: 'the customer asks for a refund' },
    });
    assert.deepEqual(interpret('[handoff] custom the customer asks for a refund'), {
      path: 'handoff',
      reason: { kind: 'custom_condition', condition: 'the customer asks for a refund' },
    });
    assert.deepEqual(interpret('[handoff] rule 2'), {
      path: 'handoff',
      reason: { kind: 'behavior_rule', ruleId: '00000000-0000-4000-8000-000000000003' },
    });
  },
);

specTest(
  'fallback-response-behavior.md',
  'AC7 with handoff disabled the configured fallback message is sent',
  'with handoff disabled every handoff line becomes the out-of-scope fallback',
  () => {
    for (const line of ['[handoff] human_request', '[handoff] rule 2', '[handoff] custom "the customer asks for a refund"']) {
      assert.deepEqual(interpret(line, { handoff: HANDOFF_OFF }), {
        path: 'fallback',
        trigger: 'out_of_scope',
        cause: 'handoff_unavailable',
      });
    }
  },
);

unitTest('a handoff line naming anything the prompt did not offer cannot pause a conversation', () => {
  // A trigger the client did not select, and a condition the client never wrote:
  // well-formed, but not configured — resolveHandoffSignal refuses them.
  assert.deepEqual(interpret('[handoff] out_of_scope'), { path: 'fallback', trigger: 'out_of_scope', cause: 'handoff_unavailable' });
  assert.deepEqual(interpret('[handoff] custom "something else"'), {
    path: 'fallback',
    trigger: 'out_of_scope',
    cause: 'handoff_unavailable',
  });
  // Not well-formed at all.
  const unusable = { path: 'fallback', trigger: 'out_of_scope', cause: 'unusable_output' };
  assert.deepEqual(interpret('[handoff] rule 1'), unusable, 'rule 1 is a respond rule, not a handoff rule');
  assert.deepEqual(interpret('[handoff] rule 3'), unusable, 'rule 3 is a fallback rule');
  assert.deepEqual(interpret('[handoff] rule 9'), unusable, 'no such rule');
  assert.deepEqual(interpret('[handoff] custom "unterminated'), unusable);
  assert.deepEqual(interpret('[handoff] please'), unusable);
  assert.deepEqual(interpret('[handoff]'), unusable);
});

// ---------------------------------------------------------------------------
// Generating a reply
// ---------------------------------------------------------------------------

const CUSTOMER_TURN = [{ role: 'customer', parts: [{ type: 'text', text: 'Do you sell gift cards?' }] }] as const;

unitTest('generateReply sends the assembled instructions and the conversation unchanged, and interprets the answer', async () => {
  const provider = new InMemoryAiProvider({ reply: () => '[reply]\nYes, from R$50.' });
  const outcome = await generateReply(provider, configuration(), CUSTOMER_TURN, { conversationStart: false });
  assert.deepEqual(outcome.decision, { path: 'reply', text: 'Yes, from R$50.' });
  assert.equal(outcome.failure, undefined);
  const seen = provider.backend.requests[0] as ObservedGeneration;
  assert.equal(seen.instructions, replyInstructions(configuration(), { conversationStart: false }));
  assert.deepEqual(seen.turns, [{ role: 'customer', parts: [{ type: 'text', text: 'Do you sell gift cards?' }] }]);
});

specTest(
  'fallback-response-behavior.md',
  'AC5 the AI generation step fails outright and the customer still receives a fallback',
  'a provider failure is decided as the ai_error fallback, not thrown',
  async () => {
    for (const failure of ['unauthorized', 'unavailable', 'filtered'] as const) {
      const provider = new InMemoryAiProvider({ maxAttempts: 1 });
      provider.backend.script({ kind: 'failure', failure });
      const outcome = await generateReply(provider, configuration(), CUSTOMER_TURN, { conversationStart: false });
      assert.deepEqual(outcome.decision, { path: 'fallback', trigger: 'ai_error', cause: 'generation_failed' }, failure);
      assert.equal(outcome.failure?.kind, 'ai_generation');
    }
    const empty = new InMemoryAiProvider();
    empty.backend.script({ kind: 'text', text: '   ' });
    const outcome = await generateReply(empty, configuration(), CUSTOMER_TURN, { conversationStart: false });
    assert.equal(outcome.decision.path, 'fallback');
  },
);

unitTest('parsePreviewInput requires one non-blank message no longer than a WhatsApp message', () => {
  assert.equal(parsePreviewInput({ message: '  Hi!\r\nAre you open?  ' }), 'Hi!\nAre you open?');
  const refused = (body: Record<string, unknown>): string[] => {
    try {
      parsePreviewInput(body);
    } catch (error) {
      assert.ok(error instanceof ValidationError);
      return error.issues.map(({ key, reason }) => `${key}: ${reason}`);
    }
    assert.fail('accepted');
  };
  assert.deepEqual(refused({}), ['message: is required and must be a string']);
  assert.deepEqual(refused({ message: '   ' }), ['message: must not be blank']);
  assert.deepEqual(refused({ message: 'a'.repeat(REPLY_LIMITS.messageMaxLength + 1) }), [
    `message: must be at most ${REPLY_LIMITS.messageMaxLength} characters`,
  ]);
  assert.deepEqual(refused({ message: 'hi', tenantId: 'x' }), ['tenantId: is not a recognised field']);
});

// ---------------------------------------------------------------------------
// Against a real PostgreSQL
// ---------------------------------------------------------------------------

describe('reply configuration and preview', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Reply Shop ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  function as<T>(tenant: string, fn: (tx: Connection) => Promise<T>): Promise<T> {
    return withTenant(pool, tenant, fn);
  }

  before(async () => {
    db = await createTestDatabase('bot_reply');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'text-conversation-handling.md',
    "AC2 each bot reply reflects its own business's configured persona",
    "each tenant's reply prompt is rendered from its own configuration and never another's",
    async () => {
      const formal = await newTenant();
      const casual = await newTenant();
      await as(formal, async (tx) => {
        await savePersona(tx, { botName: 'Sr. Almeida', formality: 'formal', styleTraits: [], freeformInstructions: null });
        await saveDisclosureSetting(tx, { mode: 'do_not_disclose' });
        await createBehaviorRule(tx, { kind: 'avoid_topic', subject: 'competitor prices', condition: null, action: 'handoff' });
        await saveHandoffSettings(tx, { enabled: true, triggers: ['complaint'], customConditions: [] });
        await createKnowledgeEntry(tx, { content: 'Closed on Sundays.' });
      });
      await as(casual, (tx) =>
        savePersona(tx, { botName: 'Bia', formality: 'casual', styleTraits: [], freeformInstructions: null }),
      );

      const mine = await as(formal, (tx) => readReplyConfiguration(tx));
      assert.equal(mine.persona?.botName, 'Sr. Almeida');
      assert.equal(mine.disclosureMode, 'do_not_disclose');
      assert.equal(mine.behavior.rules.length, 1);
      assert.deepEqual(mine.handoff, { enabled: true, triggers: ['complaint'], customConditions: [] });
      assert.equal(mine.knowledge.entries.length, 1);

      const theirs = await as(casual, (tx) => readReplyConfiguration(tx));
      const text = replyInstructions(theirs, { conversationStart: true });
      assert.match(text, /"Bia"/);
      for (const foreign of ['Almeida', 'competitor prices', 'Closed on Sundays']) {
        assert.ok(!text.includes(foreign), `another tenant's configuration reached the prompt: ${foreign}`);
      }
      // Defaults apply to what the casual tenant never configured.
      assert.equal(theirs.disclosureMode, 'disclose');
      assert.equal(theirs.handoff.enabled, false);
    },
  );

  unitTest('readReplyConfiguration refuses a connection with no tenant bound', async () => {
    await assert.rejects(
      withIdentityScope(pool, (tx) => readReplyConfiguration(tx)),
      (error: unknown) => error instanceof DefectError,
    );
  });

  specTest(
    'behavior-rules-configuration.md',
    'AC16 a preview against a sample message demonstrates the same constraints as a live conversation',
    'the preview shows the model exactly the prompt a live opening reply would carry, and resolves what the customer would receive',
    async () => {
      const tenant = await newTenant();
      await as(tenant, async (tx) => {
        await savePersona(tx, { botName: 'Bia', formality: null, styleTraits: [], freeformInstructions: null });
        await createBehaviorRule(tx, { kind: 'avoid_topic', subject: 'politics', condition: null, action: 'fallback' });
        await saveBehaviorInstructions(tx, { freeformInstructions: 'Always sign off with "— Bia".' });
        await saveFallbackMessages(tx, { sharedMessage: null, triggerMessages: { ai_error: null, low_confidence: null, out_of_scope: 'I only talk about cakes!' } });
      });
      const [replyConfiguration, fallback] = await as(tenant, async (tx) => [
        await readReplyConfiguration(tx),
        await readFallbackMessages(tx),
      ] as const);

      // The model declines under the rule: the preview shows the client's own
      // fallback text, resolved exactly as a live send would resolve it.
      const preview = new InMemoryAiProvider({ reply: () => '[fallback] out_of_scope' });
      const declined = await previewReply(preview, replyConfiguration, fallback, 'Who should I vote for?');
      assert.deepEqual(declined.preview, {
        outcome: 'fallback',
        trigger: 'out_of_scope',
        cause: 'declined',
        message: 'I only talk about cakes!',
        source: 'trigger',
      });

      // The same message through the live path, as a conversation's first turn.
      const live = new InMemoryAiProvider({ reply: () => '[fallback] out_of_scope' });
      const liveOutcome = await generateReply(
        live,
        replyConfiguration,
        [{ role: 'customer', parts: [{ type: 'text', text: 'Who should I vote for?' }] }],
        { conversationStart: true },
      );
      assert.deepEqual(liveOutcome.decision, declined.decision);
      const previewed = preview.backend.requests[0] as ObservedGeneration;
      const lived = live.backend.requests[0] as ObservedGeneration;
      assert.equal(previewed.instructions, lived.instructions);
      assert.deepEqual(previewed.turns, lived.turns);
      assert.match(previewed.instructions, /\[rule 1\] Do not discuss or engage with this topic: "politics"/);
      assert.match(previewed.instructions, /Always sign off with "— Bia"\./);

      // An answer is shown as the text the customer would receive.
      const answered = await previewReply(
        new InMemoryAiProvider({ reply: () => '[reply]\nWe have chocolate cake today. — Bia' }),
        replyConfiguration,
        fallback,
        'What cakes do you have?',
      );
      assert.deepEqual(answered.preview, { outcome: 'reply', text: 'We have chocolate cake today. — Bia' });

      // A provider failure previews the error fallback, here the platform default.
      const failing = new InMemoryAiProvider({ maxAttempts: 1 });
      failing.backend.script({ kind: 'failure', failure: 'unavailable' });
      const failed = await previewReply(failing, replyConfiguration, fallback, 'Hello?');
      assert.deepEqual(failed.preview, {
        outcome: 'fallback',
        trigger: 'ai_error',
        cause: 'generation_failed',
        message: PLATFORM_DEFAULT_FALLBACK_MESSAGES.ai_error,
        source: 'platform_default',
      });
    },
  );
});
