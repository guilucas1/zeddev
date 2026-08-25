/**
 * Why these tests matter: `environment-portability.md` AC7 is the difference
 * between "moving to a VPS took ten minutes" and "moving to a VPS took an
 * afternoon of restart-and-guess". The specific property that makes it the
 * former is that *all* problems are reported at once, so it is asserted directly
 * rather than assumed from the code shape.
 *
 * AC6 — the documented input list explains every behavioral difference between
 * tiers — is tested by generating the documentation from the schema and checking
 * it is complete. That is only meaningful because the generator and the parser
 * read the same declaration.
 */

import assert from 'node:assert/strict';
import { specTest, unitTest } from '@zeddev/testing';
import { ConfigurationError } from '@zeddev/errors';
import { Secret } from '@zeddev/secrets';
import {
  loadConfig,
  parseDuration,
  renderEnvTemplate,
  renderReference,
  type ConfigSchema,
} from './index.ts';

const SCHEMA = {
  DATABASE_URL: { type: 'url', description: 'PostgreSQL connection URL', protocols: ['postgres', 'postgresql'] },
  PORT: { type: 'integer', description: 'HTTP listen port', default: 8080, min: 1, max: 65535 },
  LOG_LEVEL: { type: 'enum', description: 'Minimum log level', values: ['debug', 'info', 'warn', 'error'], default: 'info' },
  BURST_WINDOW: { type: 'duration', description: 'Quiet period that closes a conversational turn', default: 8000 },
  AI_API_KEY: { type: 'string', description: 'AI provider API key', secret: true, minLength: 8 },
  BOT_DISCLOSURE_ENABLED: { type: 'boolean', description: 'Whether bots disclose they are automated', default: true },
} as const satisfies ConfigSchema;

const COMPLETE_ENV = {
  DATABASE_URL: 'postgres://user:pw@localhost:5432/zeddev',
  AI_API_KEY: 'test-api-key-value',
};

specTest(
  'environment-portability.md',
  'AC7 missing config fails startup clearly',
  'every missing required key is reported at once, not one per restart',
  () => {
    assert.throws(
      () => loadConfig(SCHEMA, {}),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        // Both required keys, in one report. Reporting only DATABASE_URL would
        // force a second start to discover AI_API_KEY.
        assert.deepEqual(error.keys, ['AI_API_KEY', 'DATABASE_URL']);
        assert.ok(error.message.includes('AI_API_KEY'));
        assert.ok(error.message.includes('DATABASE_URL'));
        return true;
      },
    );
  },
);

specTest(
  'environment-portability.md',
  'AC7 invalid config fails startup clearly',
  'invalid values are reported alongside missing ones, each naming its key and reason',
  () => {
    assert.throws(
      () => loadConfig(SCHEMA, { DATABASE_URL: 'not-a-url', PORT: 'eighty', LOG_LEVEL: 'verbose' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.keys, ['AI_API_KEY', 'DATABASE_URL', 'LOG_LEVEL', 'PORT']);
        const byKey = new Map(error.issues.map((i) => [i.key, i.reason]));
        assert.ok(byKey.get('DATABASE_URL')?.includes('valid absolute URL'));
        assert.ok(byKey.get('PORT')?.includes('number'));
        // Enumerations list the permitted values, so the fix is obvious.
        assert.ok(byKey.get('LOG_LEVEL')?.includes('debug, info, warn, error'));
        return true;
      },
    );
  },
);

specTest(
  'environment-portability.md',
  'AC7 no partial start on bad config',
  'a wrong URL scheme is rejected rather than accepted and failing later at connect time',
  () => {
    assert.throws(
      () => loadConfig(SCHEMA, { ...COMPLETE_ENV, DATABASE_URL: 'mysql://localhost/db' }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.ok(error.issues[0]?.reason.includes('postgres'));
        return true;
      },
    );
  },
);

specTest(
  'environment-portability.md',
  'AC6 documented inputs explain every behavioral difference',
  'the reference documentation is generated from the schema, so it cannot be incomplete',
  () => {
    const reference = renderReference(SCHEMA, { title: 'API service configuration' });

    for (const key of Object.keys(SCHEMA)) {
      assert.ok(reference.includes(`\`${key}\``), `${key} must appear in the generated reference`);
    }
    // Required vs optional is what an operator needs to know to bring up a new tier.
    assert.match(reference, /`DATABASE_URL`.*\| yes \|/);
    assert.match(reference, /`PORT`.*\| no \|.*`8080`/);
    assert.ok(reference.includes('**(secret)**'), 'secrets are marked so they are not committed');
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC1 no secret embedded in source or build artifact',
  'the generated reference and env template show a placeholder, never a real secret default',
  () => {
    const withSecretDefault = {
      AI_API_KEY: { type: 'string', description: 'AI provider key', secret: true, default: 'should-never-be-printed' },
    } as const satisfies ConfigSchema;

    const reference = renderReference(withSecretDefault);
    assert.ok(!reference.includes('should-never-be-printed'));
    assert.ok(reference.includes('`<secret>`'));

    const template = renderEnvTemplate(withSecretDefault);
    assert.ok(!template.includes('should-never-be-printed'));
    assert.equal(template.includes('AI_API_KEY='), true);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC5 no secret value in any log or diagnostic',
  'a secret-typed config value is wrapped so it cannot be serialized by accident',
  () => {
    const config = loadConfig(SCHEMA, COMPLETE_ENV);

    assert.ok(config.AI_API_KEY instanceof Secret);
    assert.equal(config.AI_API_KEY.expose(), 'test-api-key-value');
    // The realistic hazard: someone logs the whole config object at startup.
    assert.ok(!JSON.stringify(config).includes('test-api-key-value'));
    // Non-secret values stay plain, so ordinary use is not burdened.
    assert.equal(config.PORT, 8080);
  },
);

unitTest('defaults apply when a key is absent, and every key without a default is required', () => {
  const config = loadConfig(SCHEMA, COMPLETE_ENV);

  assert.equal(config.PORT, 8080);
  assert.equal(config.LOG_LEVEL, 'info');
  assert.equal(config.BURST_WINDOW, 8000);
  assert.equal(config.BOT_DISCLOSURE_ENABLED, true);
  assert.equal(config.DATABASE_URL, COMPLETE_ENV.DATABASE_URL);
});

unitTest('an empty string is treated as absent, because orchestrators materialise unset vars that way', () => {
  // Compose and several PaaS providers turn an unset variable into "". Treating
  // it as a supplied value produces a failure far from its cause.
  const config = loadConfig(SCHEMA, { ...COMPLETE_ENV, PORT: '', LOG_LEVEL: '   ' });
  assert.equal(config.PORT, 8080);
  assert.equal(config.LOG_LEVEL, 'info');

  assert.throws(() => loadConfig(SCHEMA, { ...COMPLETE_ENV, DATABASE_URL: '' }), ConfigurationError);
});

unitTest('durations require an explicit unit', () => {
  // "3600" is ambiguous between seconds and milliseconds, and guessing wrong
  // changes a memory-reset window by a factor of a thousand.
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('30s'), 30_000);
  assert.equal(parseDuration('5m'), 300_000);
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('7d'), 604_800_000);
  assert.equal(parseDuration('1.5h'), 5_400_000);

  assert.equal(parseDuration('3600'), undefined);
  assert.equal(parseDuration('30 s'), undefined);
  assert.equal(parseDuration('abc'), undefined);
  assert.equal(parseDuration('-5s'), undefined);

  assert.throws(
    () => loadConfig(SCHEMA, { ...COMPLETE_ENV, BURST_WINDOW: '8000' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.issues[0]?.reason.includes('explicit unit'));
      return true;
    },
  );
});

unitTest('booleans accept the spellings that appear in real compose files', () => {
  for (const [raw, expected] of [
    ['true', true], ['TRUE', true], ['1', true], ['yes', true], ['on', true],
    ['false', false], ['0', false], ['no', false], ['off', false],
  ] as const) {
    const config = loadConfig(SCHEMA, { ...COMPLETE_ENV, BOT_DISCLOSURE_ENABLED: raw });
    assert.equal(config.BOT_DISCLOSURE_ENABLED, expected, `for ${raw}`);
  }

  assert.throws(
    () => loadConfig(SCHEMA, { ...COMPLETE_ENV, BOT_DISCLOSURE_ENABLED: 'maybe' }),
    ConfigurationError,
  );
});

unitTest('numeric bounds are enforced', () => {
  assert.throws(() => loadConfig(SCHEMA, { ...COMPLETE_ENV, PORT: '0' }), ConfigurationError);
  assert.throws(() => loadConfig(SCHEMA, { ...COMPLETE_ENV, PORT: '99999' }), ConfigurationError);
  assert.throws(() => loadConfig(SCHEMA, { ...COMPLETE_ENV, PORT: '80.5' }), ConfigurationError);
  assert.equal(loadConfig(SCHEMA, { ...COMPLETE_ENV, PORT: '3000' }).PORT, 3000);
});

unitTest('string length and pattern constraints are enforced', () => {
  assert.throws(
    () => loadConfig(SCHEMA, { ...COMPLETE_ENV, AI_API_KEY: 'short' }),
    (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.issues[0]?.reason.includes('at least 8'));
      return true;
    },
  );
});

unitTest('the returned config is frozen, so no component can mutate it after startup', () => {
  // Configuration parsed once at startup is only a single source of truth if it
  // stays immutable afterwards.
  const config = loadConfig(SCHEMA, COMPLETE_ENV);
  assert.throws(() => {
    (config as Record<string, unknown>)['PORT'] = 9999;
  }, TypeError);
});

unitTest('the env template leaves required keys blank so omitting one still fails fast', () => {
  const template = renderEnvTemplate(SCHEMA);

  assert.ok(template.includes('DATABASE_URL='), 'required key present but blank');
  assert.ok(template.includes('PORT=8080'), 'optional key carries its default');
  assert.ok(template.includes('# one of: debug, info, warn, error'));
  // The template must be usable as-is, so a copied template that is not filled
  // in produces the AC7 error rather than a silently wrong default.
  assert.throws(() => loadConfig(SCHEMA, { PORT: '8080' }), ConfigurationError);
});
