/**
 * Deployment bootstrap commands: `node src/services/api/cli.ts <command>`.
 *
 * ## `create-operator --email <address>`
 *
 * Creates the platform operator, reading the password from standard input.
 *
 * There is no operator signup route and there must not be one:
 * `@zeddev/identity` explains that a self-service route to creating the single
 * highest-value credential in the system is a route to creating a second one. So
 * the operator is created by whoever already holds the database configuration —
 * the person deploying — through this command, typically as
 *
 *     printf '%s\n' "$PASSWORD" | docker compose run --rm -T api \
 *       node src/services/api/cli.ts create-operator --email ops@example.com
 *
 * The password comes from standard input rather than an argument or an
 * environment variable. An argument appears in the process list for anyone on the
 * host to read, and an environment variable tends to be written into a Compose
 * file and committed — `credential-and-secret-handling.md` AC1 forbids a secret in
 * any artifact, and a standing variable holding the operator's password is one.
 *
 * The same startup checks as the service run first: the role must be subject to
 * row-level security, and the schema is migrated, so the command works on a fresh
 * database and cannot be the one path that writes as a superuser.
 */

import type { Readable, Writable } from 'node:stream';
import type { RawEnv } from '@zeddev/config';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig } from '@zeddev/db';
import { ConfigurationError, toDiagnostic, ZedError } from '@zeddev/errors';
import { IdentityService, loadIdentityPolicy, type IdentityServiceOptions } from '@zeddev/identity';
import { Logger, NullSink } from '@zeddev/logging';
import { migrateToLatest } from '@zeddev/schema';
import { loadAll } from './start.ts';

export interface CliIo {
  readonly env: RawEnv;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  /** Test-only scrypt cost; see `IdentityServiceOptions.credentialParams`. */
  readonly credentialParams?: IdentityServiceOptions['credentialParams'];
}

const USAGE = 'usage: cli.ts create-operator --email <address>   (password is read from standard input)\n';

/** The first line of standard input, without its line ending. */
async function readFirstLine(stdin: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    if (chunks.some((part) => part.includes(0x0a))) break;
  }
  return (Buffer.concat(chunks).toString('utf8').split(/\r?\n/, 1)[0] ?? '');
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Run one command; resolves to the process exit code. */
export async function runCli(args: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command !== 'create-operator') {
    io.stderr.write(USAGE);
    return 2;
  }
  const email = option(rest, '--email');
  if (email === undefined || email === '') {
    io.stderr.write(USAGE);
    return 2;
  }

  let database;
  let policy;
  try {
    [database, policy] = loadAll([() => loadDatabaseConfig(io.env), () => loadIdentityPolicy(io.env)] as const);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      io.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }

  const password = await readFirstLine(io.stdin);
  const logger = new Logger({ sink: new NullSink() });
  const pool = createPool(database, { applicationName: 'zeddev-api-cli' });
  try {
    await assertTenantIsolationEnforceable(pool);
    await migrateToLatest(pool, { logger });
    const identity = new IdentityService({
      pool,
      policy,
      logger,
      ...(io.credentialParams === undefined ? {} : { credentialParams: io.credentialParams }),
    });
    const created = await identity.createOperator({ email, password });
    io.stdout.write(`${JSON.stringify({ operatorId: created.operatorId })}\n`);
    return 0;
  } catch (error) {
    // The domain's own wording for the failures a deployer can act on — a weak
    // password, a taken address, a role that bypasses isolation — and only a
    // code for anything else, so an unexpected error cannot print a value.
    if (error instanceof ZedError && error.kind !== 'internal') {
      io.stderr.write(`${error.message}\n`);
    } else {
      io.stderr.write(`create-operator failed: ${toDiagnostic(error).code}\n`);
    }
    return 1;
  } finally {
    await pool.end();
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2), {
    env: process.env,
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  });
}
