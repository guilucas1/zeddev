/**
 * The startup and shutdown contract, and the operator bootstrap.
 *
 * `environment-portability.md` AC7 is a claim about what happens *before* the
 * service does anything: a missing or invalid value produces a clear error naming
 * it, "rather than starting in a broken or partially functional state". The
 * tests here therefore assert on two things at once — that the error names every
 * offending key, and that nothing is listening afterwards.
 *
 * The superuser test is the one worth reading first. IMPLEMENTATION_PLAN.md §4c
 * records that a role exempt from row-level security disables all tenant
 * isolation while every query still succeeds. `assertTenantIsolationEnforceable`
 * has its own tests in `@zeddev/db`; this one proves the *service* calls it, which
 * is the part that was still a follow-up until now.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { after, before, describe } from 'node:test';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, type TestDatabase } from '@zeddev/db/testing';
import { ConfigurationError } from '@zeddev/errors';
import { IdentityService } from '@zeddev/identity';
import { Logger, MemorySink } from '@zeddev/logging';
import { InMemoryMailer } from '@zeddev/mail/testing';
import { REPO_ROOT, specTest, unitTest } from '@zeddev/testing';
import { runCli } from './cli.ts';
import { startApi } from './start.ts';

const FAST_SCRYPT = { N: 1024, r: 8, p: 1 } as const;
const PASSWORD = 'meadow-granite-vessel-8';

/** The keys a deployment must supply because they have no default. */
const REQUIRED_KEYS = [
  'API_PUBLIC_BASE_URL',
  'DATABASE_HOST',
  'DATABASE_NAME',
  'DATABASE_PASSWORD',
  'DATABASE_USER',
  'MAIL_FROM_ADDRESS',
  'MAIL_HOST',
];

function envFor(db: TestDatabase, overrides: Record<string, string> = {}): Record<string, string> {
  const options = db.options;
  return {
    DATABASE_HOST: options.host,
    DATABASE_PORT: String(options.port),
    DATABASE_NAME: options.database,
    DATABASE_USER: options.user,
    DATABASE_PASSWORD: options.password?.expose() ?? '',
    DATABASE_SSL_MODE: 'disable',
    MAIL_HOST: 'mail.invalid',
    MAIL_FROM_ADDRESS: 'no-reply@example.com',
    API_PUBLIC_BASE_URL: 'https://app.example.com',
    API_HTTP_HOST: '127.0.0.1',
    API_HTTP_PORT: '0',
    ...overrides,
  };
}

describe('startup configuration', () => {
  specTest(
    'environment-portability.md',
    'AC7 missing configuration is reported clearly rather than starting partially',
    'every missing key across every package is named in one error',
    async () => {
      await assert.rejects(startApi({}), (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.keys, REQUIRED_KEYS);
        return true;
      });
    },
  );

  unitTest('an invalid value is reported alongside the missing ones, not after them', async () => {
    await assert.rejects(startApi({ API_HTTP_PORT: 'eighty', IDENTITY_SESSION_INACTIVITY_TIMEOUT: '5' }), (error: unknown) => {
      assert.ok(error instanceof ConfigurationError);
      assert.ok(error.keys.includes('API_HTTP_PORT'));
      assert.ok(error.keys.includes('IDENTITY_SESSION_INACTIVITY_TIMEOUT'));
      assert.ok(error.keys.includes('DATABASE_HOST'));
      return true;
    });
  });

  specTest(
    'environment-portability.md',
    'AC7 missing configuration is reported clearly rather than starting partially',
    'the real process exits non-zero and prints every missing key',
    () => {
      // A child process with none of the platform's keys, but everything the OS
      // needs to start Node at all.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !/^(DATABASE|MAIL|API|IDENTITY|STORAGE|LOG|ZEDDEV)_/.test(key) && key !== 'LOG_LEVEL',
        ),
      );
      const result = spawnSync(process.execPath, [join('src', 'services', 'api', 'main.ts')], {
        cwd: REPO_ROOT,
        env,
        encoding: 'utf8',
        timeout: 20_000,
      });
      assert.equal(result.status, 1, result.stderr);
      for (const key of REQUIRED_KEYS) assert.match(result.stderr, new RegExp(`${key}: `));
      // The structured records name each key too, for whatever collects the logs.
      assert.match(result.stdout, /"configKey":"DATABASE_HOST"/);
    },
  );
});

describe('api startup against a database', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;

  before(async () => {
    db = await createTestDatabase('api_start');
  });

  after(async () => {
    await db?.drop();
  });

  specTest(
    'environment-portability.md',
    'AC1 the unmodified codebase becomes functional from documented configuration alone',
    'from configuration alone the service migrates, becomes ready, onboards a client, and stops cleanly',
    async () => {
      const mailer = new InMemoryMailer();
      const sink = new MemorySink();
      const running = await startApi(envFor(db), { mailer, sink, credentialParams: FAST_SCRYPT });
      try {
        const ready = await fetch(`${running.url}/health/ready`);
        assert.equal(ready.status, 200);

        const signup = await fetch(`${running.url}/v1/signup`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ businessName: 'Start Co', email: 'start@example.com', password: PASSWORD }),
        });
        assert.equal(signup.status, 201);
      } finally {
        await running.stop();
      }

      // Shutdown drained the outbox rather than dropping the message.
      assert.equal(mailer.delivered.length, 1);
      assert.equal(running.server.listening, false);
      assert.match(sink.serialized(), /"event":"db\.isolation_verified"/);
      assert.match(sink.serialized(), /"event":"api\.stopped"/);
      // Idempotent: a second signal during shutdown is harmless.
      await running.stop();
    },
  );

  specTest(
    'tenant-data-isolation.md',
    'the database role must be subject to tenant isolation',
    'the service refuses to start as a role that bypasses row-level security',
    async () => {
      const env = envFor(db, {
        DATABASE_USER: process.env.ZEDDEV_TEST_DATABASE_USER ?? 'postgres',
        DATABASE_PASSWORD: process.env.ZEDDEV_TEST_DATABASE_PASSWORD ?? '',
      });
      await assert.rejects(
        startApi(env, { mailer: new InMemoryMailer(), sink: new MemorySink() }),
        (error: unknown) => {
          assert.ok(error instanceof ConfigurationError);
          assert.deepEqual(error.keys, ['DATABASE_USER']);
          return true;
        },
      );
    },
  );

  specTest(
    'environment-portability.md',
    'AC7 missing configuration is reported clearly rather than starting partially',
    'a mail server that refuses the configured credentials stops startup before anything listens',
    async () => {
      const mailer = new InMemoryMailer();
      mailer.setAccessFailure(new ConfigurationError([{ key: 'MAIL_PASSWORD', reason: 'was rejected' }]));
      await assert.rejects(startApi(envFor(db), { mailer, sink: new MemorySink() }), (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.deepEqual(error.keys, ['MAIL_PASSWORD']);
        return true;
      });
    },
  );

  describe('create-operator', () => {
    function io(stdin: string, env: Record<string, string>): {
      stdout: PassThrough;
      stderr: PassThrough;
      output(): { out: string; err: string };
      args: Parameters<typeof runCli>[1];
    } {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      stdout.on('data', (chunk: Buffer) => out.push(chunk));
      stderr.on('data', (chunk: Buffer) => err.push(chunk));
      return {
        stdout,
        stderr,
        output: () => ({ out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString() }),
        args: { env, stdin: Readable.from([stdin]), stdout, stderr, credentialParams: FAST_SCRYPT },
      };
    }

    specTest(
      'authentication-and-access.md',
      'the operator is a separate identity space',
      'the bootstrap creates an operator who can then log in, and only with the password from standard input',
      async () => {
        const run = io(`${PASSWORD}\n`, envFor(db));
        const code = await runCli(['create-operator', '--email', 'ops@example.com'], run.args);
        assert.equal(code, 0, run.output().err);
        assert.match(run.output().out, /"operatorId":"[0-9a-f-]{36}"/);
        assert.doesNotMatch(run.output().out + run.output().err, new RegExp(PASSWORD));

        const identity = new IdentityService({
          pool: db.pool,
          policy: {
            sessionInactivityMs: 60_000,
            sessionAbsoluteLifetimeMs: 120_000,
            maxFailedAttempts: 5,
            lockoutMs: 30_000,
            emailVerificationTtlMs: 60_000,
            passwordResetTtlMs: 60_000,
            minPasswordLength: 12,
          },
          credentialParams: FAST_SCRYPT,
          logger: new Logger({ sink: new MemorySink() }),
        });
        const session = await identity.operatorLogIn({ email: 'ops@example.com', password: PASSWORD });
        assert.ok(session.operatorId.length > 0);

        const again = io(`${PASSWORD}\n`, envFor(db));
        assert.equal(await runCli(['create-operator', '--email', 'ops@example.com'], again.args), 1);
        assert.match(again.output().err, /already registered/);
      },
    );

    unitTest('a weak password is refused with the reason and without the value', async () => {
      // A needle that cannot occur in the reason text itself.
      const run = io('qz7x\r\n', envFor(db));
      assert.equal(await runCli(['create-operator', '--email', 'weak@example.com'], run.args), 1);
      assert.match(run.output().err, /password/);
      assert.ok(!run.output().err.includes('qz7x'));
    });

    unitTest('usage errors exit 2 without touching the database', async () => {
      const run = io('', {});
      assert.equal(await runCli(['create-operator'], run.args), 2);
      assert.equal(await runCli(['drop-everything'], run.args), 2);
      assert.match(run.output().err, /usage:/);
    });

    unitTest('missing database configuration is reported, not attempted', async () => {
      const run = io(`${PASSWORD}\n`, {});
      assert.equal(await runCli(['create-operator', '--email', 'x@example.com'], run.args), 1);
      assert.match(run.output().err, /DATABASE_HOST/);
    });
  });
});
