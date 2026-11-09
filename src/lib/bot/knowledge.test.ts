/**
 * Business knowledge — freeform entries — against a real PostgreSQL.
 *
 * What these tests can prove today is the *instruction layer*: that what a client
 * writes is exactly what the reply path reads and renders into the bot's
 * instructions — every current entry, the latest edit and not the previous one,
 * nothing once removed, one tenant's entries and never another's. The same facts
 * in the worker's real prompt are covered in `@zeddev/conversation`'s `turns.test.ts`,
 * and which entries a prompt carries in `knowledge-selection.test.ts`. Whether a
 * model then answers consistently with them needs a live model. Document upload (AC3, AC4, and the document halves of AC5, AC8, AC12) is not
 * built yet.
 *
 * Isolation and "the next reply reflects the change" are row-level-security and
 * transaction facts, which is why this suite needs a real database: the reply
 * path's read is simulated as its own tenant-bound transaction, the same shape the
 * conversation worker will use.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Connection, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConflictError, DefectError, NotFoundError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import { transitionConnection } from '@zeddev/whatsapp';
import { readBotStatus } from './activation.ts';
import {
  createKnowledgeEntry,
  deleteKnowledgeEntry,
  describeKnowledge,
  describeKnowledgeStatus,
  KNOWLEDGE_LIMITS,
  KNOWLEDGE_RECOMMENDATION,
  knowledgeDirectives,
  parseKnowledgeEntryCreateInput,
  parseKnowledgeEntryUpdateInput,
  readKnowledge,
  updateKnowledgeEntry,
  type KnowledgeConfiguration,
  type KnowledgeEntry,
} from './knowledge.ts';
import { savePersona } from './persona.ts';

const SPEC = 'business-knowledge-configuration.md';

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

describe('business knowledge entries', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Knowledge Shop ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  function as<T>(tenant: string, fn: (tx: Connection) => Promise<T>): Promise<T> {
    return withTenant(pool, tenant, fn);
  }

  /** What the reply path would read for `tenant`, in a transaction of its own. */
  function replyConfiguration(tenant: string): Promise<KnowledgeConfiguration> {
    return as(tenant, (tx) => readKnowledge(tx));
  }

  /** The knowledge section the next reply for `tenant` would carry. */
  async function nextReplyDirectives(tenant: string): Promise<string | undefined> {
    return knowledgeDirectives(await replyConfiguration(tenant));
  }

  function add(tenant: string, content: string): Promise<KnowledgeEntry> {
    return as(tenant, (tx) => createKnowledgeEntry(tx, { content }));
  }

  before(async () => {
    db = await createTestDatabase('bot_knowledge');
    pool = db.pool;
    await migrateToLatest(pool);
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    SPEC,
    'AC1 with no knowledge configured the section is empty and knowledge can be added',
    'a never-configured tenant reads no entries, is not configured, and the reply carries no knowledge section',
    async () => {
      const tenant = await newTenant();
      const configuration = await replyConfiguration(tenant);
      assert.deepEqual(configuration, { entries: [] });
      assert.equal(knowledgeDirectives(configuration), undefined);
      const view = describeKnowledge(configuration);
      assert.deepEqual(view.entries, []);
      assert.equal(view.configured, false);
      assert.deepEqual(view.limits, KNOWLEDGE_LIMITS);

      await add(tenant, 'We open at 9am.');
      assert.equal((await replyConfiguration(tenant)).entries.length, 1);
    },
  );

  specTest(
    SPEC,
    'AC2 a saved freeform entry is confirmed and appears in the list',
    'the save returns the stored entry, and the list shows it in the client’s own words, with no structure required',
    async () => {
      const tenant = await newTenant();
      const text = 'We offer free delivery within 10km.\n\nOrders over €50 ship free anywhere in the country.';
      const saved = await add(tenant, `  ${text}\r\n`);
      assert.match(saved.id, /^[0-9a-f-]{36}$/);
      assert.equal(saved.content, text);

      const listed = describeKnowledge(await replyConfiguration(tenant));
      assert.equal(listed.configured, true);
      assert.deepEqual(
        listed.entries.map((entry) => [entry.id, entry.content]),
        [[saved.id, text]],
      );
    },
  );

  specTest(
    SPEC,
    'AC6 a configured fact reaches the bot as a fact it must not contradict',
    'the reply instructions carry the entry verbatim, framed as true and not to be contradicted',
    async () => {
      const tenant = await newTenant();
      await add(tenant, 'Store hours are 9am-6pm, Monday to Saturday.');
      const directives = (await nextReplyDirectives(tenant))!;
      assert.match(directives, /never state anything that contradicts them/);
      assert.match(directives, /- "Store hours are 9am-6pm, Monday to Saturday\."/);
    },
  );

  specTest(
    SPEC,
    'AC5 the bot draws on every configured knowledge source',
    'every entry reaches the reply instructions in the order it was added, a multi-line entry as one quoted string',
    async () => {
      const tenant = await newTenant();
      await add(tenant, 'Delivery is free within 10km.');
      await add(tenant, 'Returns:\n- within 30 days\n- with a receipt');
      await add(tenant, 'We are closed on public holidays.');
      const lines = (await nextReplyDirectives(tenant))!.split('\n');
      assert.deepEqual(lines.slice(1), [
        '- "Delivery is free within 10km."',
        '- "Returns:\\n- within 30 days\\n- with a receipt"',
        '- "We are closed on public holidays."',
      ]);
    },
  );

  specTest(
    SPEC,
    'AC7 an edit or removal applies to the next reply without any further action',
    'the next reply’s read sees the edited text, never the old one, and then nothing once removed',
    async () => {
      const tenant = await newTenant();
      const entry = await add(tenant, 'Store hours are 9am-6pm.');
      await add(tenant, 'We deliver on weekdays.');

      const edited = await as(tenant, (tx) =>
        updateKnowledgeEntry(tx, { id: entry.id, content: 'Store hours are 10am-8pm.' }),
      );
      assert.equal(edited.id, entry.id);
      assert.equal(edited.content, 'Store hours are 10am-8pm.');
      assert.ok(edited.updatedAt.getTime() >= entry.updatedAt.getTime());
      let directives = (await nextReplyDirectives(tenant))!;
      assert.match(directives, /10am-8pm/);
      assert.doesNotMatch(directives, /9am-6pm/);
      // An edit keeps the entry's place in the list.
      assert.equal((await replyConfiguration(tenant)).entries[0]!.id, entry.id);

      await as(tenant, (tx) => deleteKnowledgeEntry(tx, { id: entry.id }));
      directives = (await nextReplyDirectives(tenant))!;
      assert.doesNotMatch(directives, /Store hours/);
      assert.match(directives, /We deliver on weekdays/);
    },
  );

  specTest(
    SPEC,
    'AC8 a removed sole source of a fact is no longer asserted as configured knowledge',
    'removing the only entry stating a fact removes it from the instructions, and removing the last entry removes the section',
    async () => {
      const tenant = await newTenant();
      const only = await add(tenant, 'We sell gift cards.');
      assert.match((await nextReplyDirectives(tenant))!, /gift cards/);
      await as(tenant, (tx) => deleteKnowledgeEntry(tx, { id: only.id }));
      assert.equal(await nextReplyDirectives(tenant), undefined);
      assert.equal(describeKnowledge(await replyConfiguration(tenant)).configured, false);
    },
  );

  specTest(
    SPEC,
    'AC9 zero business knowledge does not block minimum readiness',
    'a tenant with a persona and a connection is ready with no knowledge, and adding or removing knowledge changes nothing',
    async () => {
      const tenant = await newTenant();
      await as(tenant, (tx) => transitionConnection(tx, 'connecting'));
      await as(tenant, (tx) => transitionConnection(tx, 'connected'));
      await as(tenant, (tx) => savePersona(tx, { botName: 'Pip' }));
      const before = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(before.ready, true);
      assert.deepEqual(before.unmetConditions, []);

      const entry = await add(tenant, 'We open at 9am.');
      await as(tenant, (tx) => deleteKnowledgeEntry(tx, { id: entry.id }));
      const after = await as(tenant, (tx) => readBotStatus(tx));
      assert.equal(after.ready, true);
      assert.deepEqual(after.unmetConditions, []);
    },
  );

  specTest(
    SPEC,
    'AC10 unconfigured knowledge is shown as recommended but not required',
    'the status summary says not configured, not required, with a recommendation — and drops the recommendation once configured',
    async () => {
      const tenant = await newTenant();
      assert.deepEqual(describeKnowledgeStatus(await replyConfiguration(tenant)), {
        configured: false,
        required: false,
        recommendation: KNOWLEDGE_RECOMMENDATION,
      });
      assert.match(KNOWLEDGE_RECOMMENDATION, /not required/);
      await add(tenant, 'We open at 9am.');
      assert.deepEqual(describeKnowledgeStatus(await replyConfiguration(tenant)), {
        configured: true,
        required: false,
        recommendation: null,
      });
    },
  );

  specTest(
    SPEC,
    'AC11 each client’s bot reflects only its own knowledge',
    'another tenant’s entry id is not found for edit or delete, and neither tenant reads the other’s entries',
    async () => {
      const alpha = await newTenant();
      const beta = await newTenant();
      const alphaEntry = await add(alpha, 'Alpha delivers on Sundays.');
      await add(beta, 'Beta never delivers.');

      await assert.rejects(
        as(beta, (tx) => updateKnowledgeEntry(tx, { id: alphaEntry.id, content: 'hijacked' })),
        NotFoundError,
      );
      await assert.rejects(as(beta, (tx) => deleteKnowledgeEntry(tx, { id: alphaEntry.id })), NotFoundError);

      const alphaDirectives = (await nextReplyDirectives(alpha))!;
      const betaDirectives = (await nextReplyDirectives(beta))!;
      assert.match(alphaDirectives, /Alpha delivers on Sundays/);
      assert.doesNotMatch(alphaDirectives, /Beta/);
      assert.match(betaDirectives, /Beta never delivers/);
      assert.doesNotMatch(betaDirectives, /Alpha/);

      // Row-level security, not the query's WHERE clause, is what hides the row.
      const raw = await as(beta, (tx) =>
        tx.query(`SELECT id FROM bot_knowledge_entries WHERE id = $1`, [alphaEntry.id]),
      );
      assert.equal(raw.rows.length, 0);
    },
  );

  specTest(
    SPEC,
    'AC12 the client can review and manage every configured entry in one list',
    'the list shows every entry with its id and timestamps, in the order added, each addressable for edit and removal',
    async () => {
      const tenant = await newTenant();
      const first = await add(tenant, 'First fact.');
      const second = await add(tenant, 'Second fact.');
      const view = describeKnowledge(await replyConfiguration(tenant));
      assert.deepEqual(
        view.entries.map((entry) => entry.id),
        [first.id, second.id],
      );
      for (const entry of view.entries) {
        assert.equal(typeof entry.createdAt, 'string');
        assert.equal(typeof entry.updatedAt, 'string');
      }
    },
  );

  unitTest('an unrecognised, missing, blank, non-string, or oversized entry is refused with every issue named', () => {
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryCreateInput({})), ['content: is required']);
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryCreateInput({ content: ' \n\t ' })), ['content: is required']);
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryCreateInput({ content: 42 })), ['content: must be a string']);
    assert.deepEqual(
      issuesOf(() => parseKnowledgeEntryCreateInput({ content: 'x'.repeat(KNOWLEDGE_LIMITS.entryMaxLength + 1) })),
      [`content: must be at most ${KNOWLEDGE_LIMITS.entryMaxLength} characters`],
    );
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryCreateInput({ content: 'a\u0000b' })), [
      'content: must not contain control characters',
    ]);
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryCreateInput({ content: 'ok', title: 'Hours' })), [
      'title: is not a recognised field',
    ]);
    assert.deepEqual(issuesOf(() => parseKnowledgeEntryUpdateInput({ id: 'nope' })), [
      'content: is required',
      'id: must be a knowledge entry id',
    ]);
    // A reason never echoes the submitted text: it is client content.
    const secret = 'Zq7vXk-never-echo';
    for (const issue of issuesOf(() => parseKnowledgeEntryCreateInput({ content: `${secret}\u0007` }))) {
      assert.ok(!issue.includes(secret));
    }
  });

  unitTest('the entry length limit is counted in characters, and the database agrees at the boundary', async () => {
    const tenant = await newTenant();
    const emoji = '😀'.repeat(KNOWLEDGE_LIMITS.entryMaxLength);
    const saved = await add(tenant, emoji);
    assert.equal(saved.content, emoji);
    assert.throws(() => parseKnowledgeEntryCreateInput({ content: `${emoji}x` }), ValidationError);

    // Past the application, the CHECK refuses what the validator refuses.
    for (const content of ['', '   padded   ', 'x'.repeat(KNOWLEDGE_LIMITS.entryMaxLength + 1)]) {
      await assert.rejects(
        as(tenant, (tx) =>
          tx.query(`INSERT INTO bot_knowledge_entries (tenant_id, content) VALUES (app.current_tenant_id(), $1)`, [
            content,
          ]),
        ),
        /bot_knowledge_entries_content_check/,
      );
    }
  });

  unitTest('the entry cap holds under concurrent additions racing for the last slot', async () => {
    const tenant = await newTenant();
    await as(tenant, async (tx) => {
      for (let i = 1; i < KNOWLEDGE_LIMITS.maxEntries; i += 1) {
        await tx.query(`INSERT INTO bot_knowledge_entries (tenant_id, content) VALUES (app.current_tenant_id(), $1)`, [
          `Fact ${i}`,
        ]);
      }
    });
    const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => add(tenant, `Racer ${i}`)));
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') {
        assert.ok(outcome.reason instanceof ConflictError);
        assert.equal(outcome.reason.code, 'bot.knowledge_entries_limit');
      }
    }
    assert.equal((await replyConfiguration(tenant)).entries.length, KNOWLEDGE_LIMITS.maxEntries);
  });

  unitTest('editing or removing an entry that does not exist is not found, and unchanged text keeps updatedAt', async () => {
    const tenant = await newTenant();
    const missing = '00000000-0000-4000-8000-000000000000';
    await assert.rejects(as(tenant, (tx) => updateKnowledgeEntry(tx, { id: missing, content: 'x' })), NotFoundError);
    await assert.rejects(as(tenant, (tx) => deleteKnowledgeEntry(tx, { id: missing })), NotFoundError);

    const entry = await add(tenant, 'Same text.');
    const again = await as(tenant, (tx) => updateKnowledgeEntry(tx, { id: entry.id.toUpperCase(), content: 'Same text.' }));
    assert.equal(again.updatedAt.getTime(), entry.updatedAt.getTime());
  });

  unitTest('every operation refuses a connection with no tenant bound, and the platform scope sees no entries', async () => {
    const tenant = await newTenant();
    await add(tenant, 'Private fact.');
    await withPlatformScope(pool, async (tx) => {
      await assert.rejects(readKnowledge(tx), DefectError);
      await assert.rejects(createKnowledgeEntry(tx, { content: 'x' }), DefectError);
      const visible = await tx.query(`SELECT id FROM bot_knowledge_entries`);
      assert.equal(visible.rows.length, 0);
    });
  });
});
