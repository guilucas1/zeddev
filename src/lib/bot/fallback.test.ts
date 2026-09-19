/**
 * Fallback messages, against a real PostgreSQL.
 *
 * What is tested here is the configuration layer: which text the reply path
 * would send for each trigger, that it is never blank, that an edit is what the
 * next fallback sends, and that the preview is that same text. The criteria about
 * the reply path itself — handoff taking precedence (AC6, AC7), the occurrence
 * record (AC10), exactly one message per triggering message (AC13) — need P2's
 * reply path and are not claimed here.
 *
 * The database's CHECK constraints mirror the TypeScript limit and trigger list;
 * the last group asserts they agree, for the reason `persona.test.ts` gives.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import {
  describeFallbackMessages,
  FALLBACK_LIMITS,
  FALLBACK_TRIGGERS,
  fallbackMessageFor,
  parseFallbackInput,
  PLATFORM_DEFAULT_FALLBACK_MESSAGES,
  previewFallbackDraft,
  readFallbackMessages,
  resolveFallbackMessage,
  saveFallbackMessages,
  type FallbackTrigger,
  type ResolvedFallback,
} from './fallback.ts';

const SPEC = 'fallback-response-behavior.md';

/** The issues a rejected submission reported, as `key: reason` strings. */
function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ValidationError, `expected a ValidationError, got ${String(error)}`);
    return error.issues.map(({ key, reason }) => `${key}: ${reason}`);
  }
  assert.fail('the submission was accepted');
}

describe('fallback messages', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  /** A fresh tenant, created the way signup creates one. */
  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Fallback Bakery ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  function save(tenant: string, body: Record<string, unknown>) {
    return withTenant(pool, tenant, (tx) => saveFallbackMessages(tx, body));
  }

  /** What the reply path would send for `trigger`, in a transaction of its own. */
  function sent(tenant: string, trigger: FallbackTrigger): Promise<ResolvedFallback> {
    return withTenant(pool, tenant, (tx) => fallbackMessageFor(tx, trigger));
  }

  async function sentForEveryTrigger(tenant: string): Promise<string[]> {
    const messages: string[] = [];
    for (const trigger of FALLBACK_TRIGGERS) messages.push((await sent(tenant, trigger)).message);
    return messages;
  }

  before(async () => {
    db = await createTestDatabase('bot');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    SPEC,
    'AC1 a client’s custom fallback message is sent, not a generic platform message',
    'a configured shared message is what every trigger sends, with none of the platform defaults',
    async () => {
      const tenant = await newTenant();
      await save(tenant, { sharedMessage: 'Oops — ring us on the shop phone and we will sort it out.' });
      for (const trigger of FALLBACK_TRIGGERS) {
        const fallback = await sent(tenant, trigger);
        assert.equal(fallback.message, 'Oops — ring us on the shop phone and we will sort it out.');
        assert.notEqual(fallback.message, PLATFORM_DEFAULT_FALLBACK_MESSAGES[trigger]);
      }
    },
  );

  specTest(
    SPEC,
    'AC2 a client with no fallback configured gets the platform default',
    'a never-configured tenant sends the platform default for every trigger, and none is blank',
    async () => {
      const tenant = await newTenant();
      for (const trigger of FALLBACK_TRIGGERS) {
        const fallback = await sent(tenant, trigger);
        assert.deepEqual(fallback, {
          trigger,
          message: PLATFORM_DEFAULT_FALLBACK_MESSAGES[trigger],
          source: 'platform_default',
        });
        assert.notEqual(fallback.message.trim(), '');
      }
    },
  );

  specTest(
    SPEC,
    'AC3 distinct messages per trigger are each sent for their own trigger',
    'error, low-confidence, and out-of-scope each send their own configured message',
    async () => {
      const tenant = await newTenant();
      await save(tenant, {
        triggerMessages: {
          ai_error: 'Our system hiccupped.',
          low_confidence: 'I am not sure — could you say that another way?',
          out_of_scope: 'That is not something we handle.',
        },
      });
      assert.deepEqual(await sentForEveryTrigger(tenant), [
        'Our system hiccupped.',
        'I am not sure — could you say that another way?',
        'That is not something we handle.',
      ]);
    },
  );

  specTest(
    SPEC,
    'AC4 a single shared fallback message is sent for all three triggers',
    'only a shared message configured: every trigger sends it, and it is a complete configuration',
    async () => {
      const tenant = await newTenant();
      const saved = await save(tenant, { sharedMessage: 'Sorry, we cannot help with that here.' });
      assert.deepEqual(saved.triggerMessages, { ai_error: null, low_confidence: null, out_of_scope: null });
      assert.deepEqual(await sentForEveryTrigger(tenant), Array(3).fill('Sorry, we cannot help with that here.'));
      assert.ok((await sent(tenant, 'low_confidence')).source === 'shared');
    },
  );

  specTest(
    SPEC,
    'AC5 when AI generation fails outright the end-customer still receives a fallback',
    'the error fallback resolves from stored text alone, with no AI involved, in every configuration',
    async () => {
      // Structural: `fallbackMessageFor` takes a connection and a trigger and
      // nothing else, so no provider exists that could fail it. What remains to
      // prove is that it answers non-blank in every shape of configuration.
      const tenant = await newTenant();
      const configurations: Record<string, unknown>[] = [
        {},
        { sharedMessage: 'Shared.' },
        { triggerMessages: { out_of_scope: 'Only out-of-scope.' } },
        { sharedMessage: 'Shared.', triggerMessages: { ai_error: 'Error-specific.' } },
      ];
      const expected = [PLATFORM_DEFAULT_FALLBACK_MESSAGES.ai_error, 'Shared.', PLATFORM_DEFAULT_FALLBACK_MESSAGES.ai_error, 'Error-specific.'];
      for (const [index, body] of configurations.entries()) {
        await save(tenant, body);
        assert.equal((await sent(tenant, 'ai_error')).message, expected[index]);
      }
    },
  );

  specTest(
    SPEC,
    'AC8 the fallback sent is exactly the text the client wrote in their own voice',
    'multi-line text with emoji and punctuation comes back from the reply path character for character',
    async () => {
      const tenant = await newTenant();
      const voice = 'Ahoy! 🏴‍☠️ Our parrot ate that answer…\nGive us a shout on deck and we’ll sort ye out, matey!';
      await save(tenant, { triggerMessages: { low_confidence: voice } });
      const fallback = await sent(tenant, 'low_confidence');
      assert.equal(fallback.message, voice);
      assert.equal(fallback.source, 'trigger');
    },
  );

  specTest(
    SPEC,
    'AC9 a disclaimer the client included in the fallback text is sent unchanged',
    'a fallback text containing a required disclaimer is sent whole, with nothing removed or altered',
    async () => {
      const tenant = await newTenant();
      const disclaimer = 'This is not medical advice; for emergencies call your local emergency number.';
      const text = `Sorry, I can’t answer that here.\n\n${disclaimer}`;
      await save(tenant, { sharedMessage: text });
      for (const trigger of FALLBACK_TRIGGERS) {
        const fallback = await sent(tenant, trigger);
        assert.equal(fallback.message, text);
        assert.ok(fallback.message.endsWith(disclaimer));
      }
    },
  );

  specTest(
    SPEC,
    'AC11 an edited fallback message is what the next fallback sends',
    'after an edit the next read sends the new text, and a message left out of the edit is cleared',
    async () => {
      const tenant = await newTenant();
      await save(tenant, { sharedMessage: 'First version.', triggerMessages: { out_of_scope: 'Not our area.' } });
      assert.equal((await sent(tenant, 'out_of_scope')).message, 'Not our area.');

      const edited = await save(tenant, { sharedMessage: 'Second version.' });
      assert.equal(edited.triggerMessages.out_of_scope, null);
      assert.deepEqual(await sentForEveryTrigger(tenant), Array(3).fill('Second version.'));

      // Clearing everything returns to the defaults, and deletes the row rather
      // than storing an all-empty one.
      const cleared = await save(tenant, { sharedMessage: '   ', triggerMessages: { ai_error: '' } });
      assert.equal(cleared.updatedAt, null);
      assert.equal((await sent(tenant, 'ai_error')).source, 'platform_default');
      const rows = await withTenant(pool, tenant, (tx) => tx.query('SELECT 1 FROM bot_fallback_messages'));
      assert.equal(rows.rows.length, 0);
    },
  );

  specTest(
    SPEC,
    'AC12 a preview renders the same content the end-customer would receive',
    'the saved view’s preview, a draft preview of the same submission, and what the reply path sends are identical',
    async () => {
      const tenant = await newTenant();
      const body = { sharedMessage: 'Shared text.', triggerMessages: { low_confidence: 'Say again?' } };
      const draft = previewFallbackDraft(body);
      await save(tenant, body);
      const view = describeFallbackMessages(await withTenant(pool, tenant, (tx) => readFallbackMessages(tx)));
      const reply: ResolvedFallback[] = [];
      for (const trigger of FALLBACK_TRIGGERS) reply.push(await sent(tenant, trigger));
      assert.deepEqual(view.preview, reply);
      assert.deepEqual(draft, reply);
      assert.deepEqual(
        reply.map(({ source }) => source),
        ['shared', 'trigger', 'shared'],
      );
    },
  );

  unitTest('one tenant’s fallback messages are invisible to, and never sent by, another tenant', async () => {
    const alpha = await newTenant();
    const beta = await newTenant();
    await save(alpha, { sharedMessage: 'Alpha private fallback.' });
    assert.equal((await sent(beta, 'ai_error')).source, 'platform_default');
    const raw = await withTenant(pool, beta, (tx) => tx.query('SELECT * FROM bot_fallback_messages'));
    assert.equal(raw.rows.length, 0);
    // Beta clearing its own configuration does not reach Alpha's row.
    await save(beta, {});
    assert.equal((await sent(alpha, 'ai_error')).message, 'Alpha private fallback.');
  });

  unitTest('the operator’s platform scope sees no fallback message', async () => {
    const tenant = await newTenant();
    await save(tenant, { sharedMessage: 'Client-authored text.' });
    const rows = await withPlatformScope(pool, (tx) => tx.query('SELECT * FROM bot_fallback_messages'));
    assert.equal(rows.rows.length, 0);
  });

  unitTest('a connection with no tenant bound is refused as a defect, not read as "nothing configured"', async () => {
    await assert.rejects(() => pool.transaction((tx) => readFallbackMessages(tx)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => fallbackMessageFor(tx, 'ai_error')), DefectError);
    await assert.rejects(() => pool.transaction((tx) => saveFallbackMessages(tx, { sharedMessage: 'x' })), DefectError);
  });

  // -------------------------------------------------------------------------
  // The database agreeing with the library
  // -------------------------------------------------------------------------

  unitTest('the length limit is counted in characters and agrees with the database at the boundary', async () => {
    const tenant = await newTenant();
    const longest = '🥐'.repeat(FALLBACK_LIMITS.messageMaxLength);
    assert.equal(longest.length, FALLBACK_LIMITS.messageMaxLength * 2);
    const body: Record<string, unknown> = { sharedMessage: longest, triggerMessages: {} };
    for (const trigger of FALLBACK_TRIGGERS) (body.triggerMessages as Record<string, string>)[trigger] = longest;
    const saved = await save(tenant, body);
    assert.equal(saved.sharedMessage, longest);

    for (const column of ['shared_message', ...FALLBACK_TRIGGERS.map((trigger) => `${trigger}_message`)]) {
      await assert.rejects(() =>
        withTenant(pool, tenant, (tx) => tx.query(`UPDATE bot_fallback_messages SET ${column} = $1`, [`${longest}🥐`])),
      );
      await assert.rejects(() =>
        withTenant(pool, tenant, (tx) => tx.query(`UPDATE bot_fallback_messages SET ${column} = ''`)),
      );
    }
  });

  unitTest('every trigger has its own column, and the table has no message column without a trigger', async () => {
    const columns = await withTenant(pool, await newTenant(), (tx) =>
      tx.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'bot_fallback_messages' AND column_name LIKE '%\\_message'
          ORDER BY column_name`,
      ),
    );
    assert.deepEqual(
      columns.rows.map((row) => row.column_name),
      ['shared_message', ...FALLBACK_TRIGGERS.map((trigger) => `${trigger}_message`)].sort(),
    );
  });

  unitTest('an all-empty configuration cannot be stored by any path', async () => {
    const tenant = await newTenant();
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) =>
        tx.query(`INSERT INTO bot_fallback_messages (tenant_id) VALUES (app.current_tenant_id())`),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation and resolution, without a database
// ---------------------------------------------------------------------------

unitTest('every problem in a fallback submission is reported at once, and no submitted value is echoed', () => {
  const secret = 'zq-needle-never-echoed';
  const issues = issuesOf(() =>
    parseFallbackInput({
      sharedMessage: `${secret}${'x'.repeat(1000)}`,
      triggerMessages: { ai_error: 42, low_confidence: `bad\u0007bell ${secret}`, escalate: secret },
      colour: secret,
    }),
  );
  assert.deepEqual(issues, [
    'colour: is not a recognised field',
    'sharedMessage: must be at most 1000 characters',
    'triggerMessages.ai_error: must be a string',
    'triggerMessages.escalate: is not a recognised trigger (expected one of: ai_error, low_confidence, out_of_scope)',
    'triggerMessages.low_confidence: must not contain control characters',
  ]);
  assert.ok(issues.every((issue) => !issue.includes(secret)));
  assert.deepEqual(issuesOf(() => parseFallbackInput({ triggerMessages: ['ai_error'] })), [
    'triggerMessages: must be an object keyed by trigger (ai_error, low_confidence, out_of_scope)',
  ]);
});

unitTest('messages are normalised: line endings, NFC, surrounding whitespace, and blank as not configured', () => {
  const input = parseFallbackInput({
    sharedMessage: '  Line one\r\nLine two\tend  ',
    triggerMessages: { ai_error: 'Café', low_confidence: '   ', out_of_scope: null },
  });
  assert.equal(input.sharedMessage, 'Line one\nLine two\tend');
  assert.equal(input.triggerMessages.ai_error, 'Café');
  assert.equal(input.triggerMessages.low_confidence, null);
  assert.equal(input.triggerMessages.out_of_scope, null);
});

unitTest('resolution prefers the trigger’s own message, then the shared one, then the platform default', () => {
  const configuration = parseFallbackInput({ sharedMessage: 'Shared.', triggerMessages: { ai_error: 'Own.' } });
  assert.deepEqual(resolveFallbackMessage(configuration, 'ai_error'), { trigger: 'ai_error', message: 'Own.', source: 'trigger' });
  assert.deepEqual(resolveFallbackMessage(configuration, 'out_of_scope'), {
    trigger: 'out_of_scope',
    message: 'Shared.',
    source: 'shared',
  });
  const partial = parseFallbackInput({ triggerMessages: { ai_error: 'Own.' } });
  assert.deepEqual(resolveFallbackMessage(partial, 'low_confidence'), {
    trigger: 'low_confidence',
    message: PLATFORM_DEFAULT_FALLBACK_MESSAGES.low_confidence,
    source: 'platform_default',
  });
});

unitTest('every trigger has a platform default that fits the message limit', () => {
  assert.deepEqual(Object.keys(PLATFORM_DEFAULT_FALLBACK_MESSAGES), [...FALLBACK_TRIGGERS]);
  for (const trigger of FALLBACK_TRIGGERS) {
    const message = PLATFORM_DEFAULT_FALLBACK_MESSAGES[trigger];
    // Parsed as if a client had typed it: the default must be something the
    // database would also accept as a configured message.
    assert.equal(parseFallbackInput({ sharedMessage: message }).sharedMessage, message);
  }
});
