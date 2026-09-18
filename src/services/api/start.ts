/**
 * Bringing the API up, and taking it down again cleanly.
 *
 * The order below is the contract, and each step exists because skipping it
 * produces a service that starts, answers requests, and is wrong:
 *
 * 1. **Every configuration key, all at once.** Each package's schema is parsed and
 *    every failure is collected before anything is thrown, so a new deployment
 *    tier learns its whole list of missing values in one attempt —
 *    `environment-portability.md` AC7. Parsing schema by schema and stopping at
 *    the first would be exactly the guess-and-restart loop `loadConfig` itself
 *    refuses to be.
 * 2. **Refuse a database role that bypasses row-level security.** A superuser or
 *    `BYPASSRLS` role silently disables every tenant isolation policy while
 *    appearing to work (IMPLEMENTATION_PLAN.md §4c). `@zeddev/identity` is the
 *    first code whose correctness rests entirely on those policies, so this is the
 *    first service where skipping the check is a live hole.
 * 3. **Migrate.** Advisory-locked and idempotent, so several instances starting at
 *    once converge rather than race.
 * 4. **Prove the mail server accepts us**, before a client signs up and waits for a
 *    link that a wrong credential guaranteed would never come.
 * 5. **Listen.** Only now — a process that accepts connections before steps 1–4
 *    have passed is the "partially functional state" AC7 forbids.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type RawEnv } from '@zeddev/config';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig, type Pool } from '@zeddev/db';
import { ConfigurationError, type ConfigIssue } from '@zeddev/errors';
import { IdentityService, loadIdentityPolicy, type IdentityServiceOptions } from '@zeddev/identity';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { loadSmtpSettings, SmtpMailer, type Mailer } from '@zeddev/mail';
import { migrateToLatest } from '@zeddev/schema';
import { createApi, type Api } from './app.ts';
import { loadServerSettings, type ServerSettings } from './config.ts';

export interface StartOptions {
  readonly sink?: LogSink | undefined;
  /** Replace the SMTP adapter. Tests use this; a deployment never does. */
  readonly mailer?: Mailer | undefined;
  /** Test-only scrypt cost. See `IdentityServiceOptions.credentialParams` for why this is not configuration. */
  readonly credentialParams?: IdentityServiceOptions['credentialParams'];
}

export interface RunningApi {
  readonly server: Server;
  readonly api: Api;
  readonly pool: Pool;
  readonly settings: ServerSettings;
  /** The bound address — useful when the configured port was 0. */
  readonly url: string;
  /** Stop accepting, finish in-flight work within the grace period, release everything. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Run each loader, collecting every configuration issue across all of them.
 *
 * A loader that throws anything other than `ConfigurationError` is a defect, not
 * a misconfiguration, and is rethrown immediately.
 */
export function loadAll<T extends readonly (() => unknown)[]>(
  loaders: T,
): { [K in keyof T]: T[K] extends () => infer R ? R : never } {
  const issues: ConfigIssue[] = [];
  const results = loaders.map((load) => {
    try {
      return load();
    } catch (error) {
      if (!(error instanceof ConfigurationError)) throw error;
      issues.push(...error.issues);
      return undefined;
    }
  });
  if (issues.length > 0) throw new ConfigurationError(issues);
  return results as { [K in keyof T]: T[K] extends () => infer R ? R : never };
}

export async function startApi(env: RawEnv = process.env, options: StartOptions = {}): Promise<RunningApi> {
  const [database, policy, smtp, settings, logging] = loadAll([
    () => loadDatabaseConfig(env),
    () => loadIdentityPolicy(env),
    // Parsed even when a test supplies its own mailer, so a deployment missing a
    // MAIL_* key fails here rather than at the first signup.
    () => loadSmtpSettings(env),
    () => loadServerSettings(env),
    () => loadConfig(LOGGING_CONFIG_SCHEMA, env),
  ] as const);

  const logger = new Logger({
    level: logging.LOG_LEVEL,
    bindings: { service: 'api' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });

  const pool = createPool(database, { applicationName: 'zeddev-api' });
  const mailer = options.mailer ?? new SmtpMailer(smtp, { logger });

  try {
    await assertTenantIsolationEnforceable(pool, { logger });
    await migrateToLatest(pool, { logger });
    await mailer.verifyAccess();
  } catch (error) {
    await mailer.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }

  const identity = new IdentityService({
    pool,
    policy,
    logger,
    ...(options.credentialParams === undefined ? {} : { credentialParams: options.credentialParams }),
  });
  const api = createApi({ identity, mailer, pool, settings, logger });

  const server = createServer(api.handler);
  server.requestTimeout = settings.requestTimeoutMs;
  // Node's default. Stated because it constrains the proxy in front: a proxy
  // whose own idle timeout is *longer* than this can reuse a socket this side has
  // just closed, and the request sent on it is lost.
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  logger.info('api.started', { port: address.port });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('api.stopping', { windowMs: settings.shutdownGraceMs });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // `close` waits for keep-alive connections that may never send another
      // request; idle ones can go now, busy ones get the grace period.
      server.closeIdleConnections();
      const forced = setTimeout(() => server.closeAllConnections(), settings.shutdownGraceMs);
      await closed;
      clearTimeout(forced);

      const drained = await api.outbox.drain(settings.shutdownGraceMs);
      if (!drained) logger.warn('api.mail.undelivered_at_shutdown', { count: api.outbox.pending });

      await mailer.close().catch((error: unknown) => logger.error('api.stop.mailer_failed', error));
      await pool.end().catch((error: unknown) => logger.error('api.stop.pool_failed', error));
      logger.info('api.stopped');
    })();
    return stopping;
  };

  return { server, api, pool, settings, url: `http://${host}:${address.port}`, stop };
}
