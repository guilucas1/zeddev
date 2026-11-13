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
import { createAiProvider, loadAiCandidateSettings, loadAiSettings, type AiProvider } from '@zeddev/ai';
import { loadAll, loadConfig, type RawEnv } from '@zeddev/config';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig, type Pool } from '@zeddev/db';
import { IdentityService, loadIdentityPolicy, type IdentityServiceOptions } from '@zeddev/identity';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { loadSmtpSettings, SmtpMailer, type Mailer } from '@zeddev/mail';
import { migrateToLatest } from '@zeddev/schema';
import { loadSealer } from '@zeddev/vault';
import { GraphWhatsAppCloud, loadGraphCloudSettings, loadWhatsAppConfig, type WhatsAppCloud } from '@zeddev/whatsapp';
import { createApi, type Api } from './app.ts';
import { loadServerSettings, type ServerSettings } from './config.ts';

export interface StartOptions {
  readonly sink?: LogSink | undefined;
  /** Replace the SMTP adapter. Tests use this; a deployment never does. */
  readonly mailer?: Mailer | undefined;
  /** Replace the configured AI provider. Tests use this; a deployment never does. */
  readonly ai?: AiProvider | undefined;
  /** Replace the candidate provider. Tests use this; a deployment never does. */
  readonly candidateAi?: AiProvider | undefined;
  /** Replace the WhatsApp Cloud API. Tests use this; a deployment never does. */
  readonly cloud?: WhatsAppCloud | undefined;
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

export async function startApi(env: RawEnv = process.env, options: StartOptions = {}): Promise<RunningApi> {
  const [database, policy, smtp, ai, candidate, settings, logging, sealer, whatsapp] = loadAll([
    () => loadDatabaseConfig(env),
    () => loadIdentityPolicy(env),
    // Parsed even when a test supplies its own mailer, so a deployment missing a
    // MAIL_* key fails here rather than at the first signup.
    () => loadSmtpSettings(env),
    // Likewise parsed even when a test supplies its own provider. Not verified at
    // startup: proving a credential works costs a generation from the quota every
    // tenant's conversations share, and a wrong one surfaces on the first preview
    // as a logged `ai_generation` failure rather than silently.
    () => loadAiSettings(env),
    // The candidate slot (ai-provider-portability.md AC4). Only this service reads
    // it, and only operator verification is handed what it builds.
    () => loadAiCandidateSettings(env),
    () => loadServerSettings(env),
    () => loadConfig(LOGGING_CONFIG_SCHEMA, env),
    // The sealing keys. Built here, not inside `@zeddev/whatsapp`, so a missing
    // or malformed key is one of the failures reported in this same list rather
    // than a crash at the first connect — `credential-and-secret-handling.md`
    // AC2 asks for exactly that.
    () => loadSealer(env),
    () => loadWhatsAppConfig(env),
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
  const api = createApi({
    identity,
    mailer,
    ai: options.ai ?? createAiProvider(ai),
    candidateAi: options.candidateAi ?? (candidate === undefined ? undefined : createAiProvider(candidate)),
    cloud: options.cloud ?? new GraphWhatsAppCloud(loadGraphCloudSettings(env)),
    sealer,
    verificationTtlMs: whatsapp.WHATSAPP_VERIFICATION_TTL,
    pool,
    settings,
    logger,
  });

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

export { loadAll } from '@zeddev/config';
