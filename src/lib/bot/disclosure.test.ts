/**
 * The disclosure setting, against a real PostgreSQL.
 *
 * What is tested here is the configuration layer: which mode a reply would
 * follow, that a never-chosen bot has the platform default, that a change is
 * what the next reply follows, and the instruction text each mode renders into
 * the prompt. Whether the model's actual output obeys that text (AC1–AC4 at the
 * output level) needs P2's reply path and the AI port, and is not claimed here —
 * the same boundary `behavior.test.ts` draws. AC6 (past messages unchanged) needs
 * a transcript, which does not exist yet.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { withIdentityScope, withPlatformScope, withTenant, type Pool } from '@zeddev/db';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { DefectError, ValidationError } from '@zeddev/errors';
import { migrateToLatest } from '@zeddev/schema';
import { specTest, unitTest } from '@zeddev/testing';
import {
  describeDisclosureSetting,
  DISCLOSURE_MODES,
  disclosureDirectives,
  disclosureModeFor,
  parseDisclosureInput,
  PLATFORM_DEFAULT_DISCLOSURE_MODE,
  readDisclosureSetting,
  saveDisclosureSetting,
  type DisclosureMode,
} from './disclosure.ts';

const SPEC = 'bot-disclosure-setting.md';

/** Would a reply prompt carrying `text` tell the model to say it is automated? */
const TELLS_IT_TO_DISCLOSE = /must open with a clear statement|answer clearly that you are an automated AI assistant/;

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

describe('disclosure setting', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let pool: Pool;
  let counter = 0;

  /** A fresh tenant, created the way signup creates one. */
  async function newTenant(): Promise<string> {
    counter += 1;
    return withIdentityScope(pool, async (tx) => {
      const created = await tx.query<{ id: string }>(
        `INSERT INTO tenants (business_name, provisioning_state) VALUES ($1, 'ready') RETURNING id`,
        [`Disclosure Deli ${counter}`],
      );
      return created.rows[0]!.id;
    });
  }

  function choose(tenant: string, mode: DisclosureMode) {
    return withTenant(pool, tenant, (tx) => saveDisclosureSetting(tx, { mode }));
  }

  /** The mode the reply path would follow, in a transaction of its own. */
  function followed(tenant: string): Promise<DisclosureMode> {
    return withTenant(pool, tenant, (tx) => disclosureModeFor(tx));
  }

  /** The disclosure section of the prompt the reply path would assemble. */
  async function directives(tenant: string, conversationStart: boolean): Promise<string> {
    return disclosureDirectives(await followed(tenant), { conversationStart });
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
    'AC8 a bot never configured is assigned the platform default automatically',
    'a new tenant follows the platform default, "disclose", with nothing configured or seeded',
    async () => {
      const tenant = await newTenant();
      assert.equal(PLATFORM_DEFAULT_DISCLOSURE_MODE, 'disclose');
      assert.equal(await followed(tenant), 'disclose');
      const setting = await withTenant(pool, tenant, (tx) => readDisclosureSetting(tx));
      assert.deepEqual(setting, { mode: 'disclose', source: 'platform_default', updatedAt: null });
    },
  );

  specTest(
    SPEC,
    'AC1 in disclose mode a new conversation’s reply identifies the bot as automated/AI',
    'a disclosing bot’s first-turn instructions require opening with an automated/AI statement',
    async () => {
      const tenant = await newTenant();
      await choose(tenant, 'disclose');
      const text = await directives(tenant, true);
      assert.match(text, /start of a new conversation/);
      assert.match(text, /must open with a clear statement that the customer is talking to an automated AI assistant, not a human/);
    },
  );

  specTest(
    SPEC,
    'AC2 in disclose mode a question about the bot’s nature is answered as automated/AI at any point',
    'a disclosing bot is told to affirm it is automated whenever asked, on the first turn and every later one',
    async () => {
      const tenant = await newTenant();
      await choose(tenant, 'disclose');
      for (const conversationStart of [true, false]) {
        const text = await directives(tenant, conversationStart);
        assert.match(text, /at any point in the conversation, whether they are talking to a human or a bot/);
        assert.match(text, /answer clearly that you are an automated AI assistant, not a human/);
      }
      // Later turns do not repeat the opening statement.
      assert.doesNotMatch(await directives(tenant, false), /must open with/);
    },
  );

  specTest(
    SPEC,
    'AC3 in do-not-disclose mode the initial response contains no automated/AI statement',
    'a non-disclosing bot’s first-turn instructions forbid volunteering it and ask for no statement',
    async () => {
      const tenant = await newTenant();
      await choose(tenant, 'do_not_disclose');
      const text = await directives(tenant, true);
      assert.doesNotMatch(text, TELLS_IT_TO_DISCLOSE);
      assert.match(text, /Do not state or suggest, on your own initiative, that you are an automated system or an AI/);
      assert.match(text, /not when the conversation starts/);
    },
  );

  specTest(
    SPEC,
    'AC4 in do-not-disclose mode no disclosure is ever sent when the customer never asks',
    'no turn of a non-disclosing bot’s conversation is instructed to disclose, and none is told to deny',
    async () => {
      const tenant = await newTenant();
      await choose(tenant, 'do_not_disclose');
      for (const conversationStart of [true, false]) {
        const text = await directives(tenant, conversationStart);
        assert.doesNotMatch(text, TELLS_IT_TO_DISCLOSE);
        assert.match(text, /not later/);
        // The spec does not require denial; that is behaviour rules' territory.
        assert.doesNotMatch(text, /human/);
      }
    },
  );

  specTest(
    SPEC,
    'AC5 a changed mode is what the next new conversation follows',
    'switching both ways takes effect on the next read, with nothing cached',
    async () => {
      const tenant = await newTenant();
      await choose(tenant, 'do_not_disclose');
      assert.doesNotMatch(await directives(tenant, true), TELLS_IT_TO_DISCLOSE);
      const switched = await choose(tenant, 'disclose');
      assert.equal(switched.mode, 'disclose');
      assert.match(await directives(tenant, true), /must open with a clear statement/);
      await choose(tenant, 'do_not_disclose');
      assert.equal(await followed(tenant), 'do_not_disclose');
    },
  );

  specTest(
    SPEC,
    'AC7 two bots each behave only according to their own setting',
    'one tenant disclosing and another not: each reads its own mode, and neither can see the other’s row',
    async () => {
      const alpha = await newTenant();
      const beta = await newTenant();
      await choose(alpha, 'disclose');
      await choose(beta, 'do_not_disclose');
      assert.equal(await followed(alpha), 'disclose');
      assert.equal(await followed(beta), 'do_not_disclose');
      const visible = await withTenant(pool, beta, (tx) =>
        tx.query<{ tenant_id: string }>('SELECT tenant_id FROM bot_disclosure_settings'),
      );
      assert.deepEqual(
        visible.rows.map((row) => row.tenant_id),
        [beta],
      );
      // A tenant that never chose is untouched by either.
      assert.equal(await followed(await newTenant()), PLATFORM_DEFAULT_DISCLOSURE_MODE);
    },
  );

  specTest(
    SPEC,
    'AC9 the configuration view displays the currently active mode accurately',
    'the view shows the defaulted mode before any choice and the chosen mode after, with its source',
    async () => {
      const tenant = await newTenant();
      const view = async () => describeDisclosureSetting(await withTenant(pool, tenant, (tx) => readDisclosureSetting(tx)));

      const initial = await view();
      assert.equal(initial.mode, 'disclose');
      assert.equal(initial.source, 'platform_default');
      assert.equal(initial.updatedAt, null);
      assert.deepEqual(initial.modes, ['disclose', 'do_not_disclose']);
      assert.equal(initial.platformDefault, 'disclose');

      await choose(tenant, 'do_not_disclose');
      const chosen = await view();
      assert.equal(chosen.mode, 'do_not_disclose');
      assert.equal(chosen.source, 'client');
      assert.equal(typeof chosen.updatedAt, 'string');
      assert.equal(chosen.mode, await followed(tenant));

      // Choosing the default mode explicitly is still a choice.
      await choose(tenant, 'disclose');
      assert.equal((await view()).source, 'client');
    },
  );

  unitTest('the setting survives changes to other configuration of the same bot', async () => {
    const tenant = await newTenant();
    await choose(tenant, 'do_not_disclose');
    await withTenant(pool, tenant, (tx) =>
      tx.query(`INSERT INTO bot_personas (tenant_id, bot_name) VALUES (app.current_tenant_id(), 'Deli Bot')`),
    );
    await withTenant(pool, tenant, (tx) => tx.query(`DELETE FROM bot_personas`));
    assert.equal(await followed(tenant), 'do_not_disclose');
  });

  unitTest('the operator’s platform scope sees no disclosure setting', async () => {
    const tenant = await newTenant();
    await choose(tenant, 'do_not_disclose');
    const rows = await withPlatformScope(pool, (tx) => tx.query('SELECT * FROM bot_disclosure_settings'));
    assert.equal(rows.rows.length, 0);
  });

  unitTest('a connection with no tenant bound is refused as a defect, not read as the default', async () => {
    await assert.rejects(() => pool.transaction((tx) => readDisclosureSetting(tx)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => disclosureModeFor(tx)), DefectError);
    await assert.rejects(() => pool.transaction((tx) => saveDisclosureSetting(tx, { mode: 'disclose' })), DefectError);
  });

  unitTest('an invalid submission changes nothing', async () => {
    const tenant = await newTenant();
    await choose(tenant, 'do_not_disclose');
    await assert.rejects(
      () => withTenant(pool, tenant, (tx) => saveDisclosureSetting(tx, { mode: 'sometimes' })),
      ValidationError,
    );
    assert.equal(await followed(tenant), 'do_not_disclose');
  });

  unitTest('the library’s mode list and the database’s CHECK agree', async () => {
    const tenant = await newTenant();
    for (const mode of DISCLOSURE_MODES) assert.equal((await choose(tenant, mode)).mode, mode);
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) => tx.query(`UPDATE bot_disclosure_settings SET mode = 'sometimes'`)),
    );
    await assert.rejects(() =>
      withTenant(pool, tenant, (tx) => tx.query(`UPDATE bot_disclosure_settings SET mode = NULL`)),
    );
  });
});

// ---------------------------------------------------------------------------
// Validation and rendering, without a database
// ---------------------------------------------------------------------------

unitTest('a submission is refused with every issue, naming the modes', () => {
  assert.deepEqual(issuesOf(() => parseDisclosureInput({ mode: 'sometimes', colour: 'red' })), [
    'colour: is not a recognised field',
    'mode: must be one of: disclose, do_not_disclose',
  ]);
  assert.deepEqual(issuesOf(() => parseDisclosureInput({})), ['mode: must be one of: disclose, do_not_disclose']);
  assert.deepEqual(issuesOf(() => parseDisclosureInput({ mode: true })), ['mode: must be one of: disclose, do_not_disclose']);
  // Exact values only: no case-folding or trimming that would widen "exactly two modes".
  assert.deepEqual(issuesOf(() => parseDisclosureInput({ mode: 'Disclose' })), ['mode: must be one of: disclose, do_not_disclose']);
  for (const mode of DISCLOSURE_MODES) assert.equal(parseDisclosureInput({ mode }), mode);
});

unitTest('the platform default is one of the two modes', () => {
  assert.ok(DISCLOSURE_MODES.includes(PLATFORM_DEFAULT_DISCLOSURE_MODE));
  assert.equal(DISCLOSURE_MODES.length, 2);
});
