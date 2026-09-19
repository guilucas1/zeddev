/**
 * Bringing the gateway up, and taking it down again cleanly.
 *
 * The same contract as the API's `start.ts`, for the same reasons: every
 * configuration key reported at once (`environment-portability.md` AC7); refuse a
 * database role that bypasses row-level security, because the gateway writes
 * every inbound message into a tenant-scoped table and under such a role
 * attribution would be the only thing between tenants; migrate (advisory-locked,
 * so this service and the API converge whichever starts first —
 * `component-independence.md` wants neither to need the other up); and only then
 * listen, because a gateway that acknowledged a notification before it could
 * store one would lose it.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadAll, loadConfig, type RawEnv } from '@zeddev/config';
import { assertTenantIsolationEnforceable, createPool, loadDatabaseConfig, type Pool } from '@zeddev/db';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { PostgresQueue } from '@zeddev/queue';
import { migrateToLatest } from '@zeddev/schema';
import { INBOUND_QUEUE, loadWhatsAppConfig } from '@zeddev/whatsapp';
import { createGateway } from './app.ts';
import { loadGatewaySettings, type GatewaySettings } from './config.ts';

export interface StartGatewayOptions {
  readonly sink?: LogSink | undefined;
}

export interface RunningGateway {
  readonly server: Server;
  readonly pool: Pool;
  readonly settings: GatewaySettings;
  /** The bound address — useful when the configured port was 0. */
  readonly url: string;
  /** Stop accepting, finish in-flight notifications within the grace period, release everything. Idempotent. */
  stop(): Promise<void>;
}

export async function startGateway(
  env: RawEnv = process.env,
  options: StartGatewayOptions = {},
): Promise<RunningGateway> {
  const [database, whatsapp, settings, logging] = loadAll([
    () => loadDatabaseConfig(env),
    () => loadWhatsAppConfig(env),
    () => loadGatewaySettings(env),
    () => loadConfig(LOGGING_CONFIG_SCHEMA, env),
  ] as const);

  const logger = new Logger({
    level: logging.LOG_LEVEL,
    bindings: { service: 'whatsapp-gateway' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });
  const pool = createPool(database, { applicationName: 'zeddev-whatsapp-gateway' });

  try {
    await assertTenantIsolationEnforceable(pool, { logger });
    await migrateToLatest(pool, { logger });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  // Producer only: the gateway never claims, so it never holds the LISTEN
  // connection a consumer would.
  const scheduler = new PostgresQueue({ name: INBOUND_QUEUE, pool, logger });
  const gateway = createGateway({ pool, scheduler, whatsapp, settings, logger });

  const server = createServer(gateway.handler);
  server.requestTimeout = settings.requestTimeoutMs;
  server.keepAliveTimeout = 5_000;

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(settings.port, settings.host, () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }

  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  logger.info('gateway.started', { port: address.port });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('gateway.stopping', { windowMs: settings.shutdownGraceMs });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const forced = setTimeout(() => server.closeAllConnections(), settings.shutdownGraceMs);
      await closed;
      clearTimeout(forced);
      await scheduler.close().catch((error: unknown) => logger.error('gateway.stop.queue_failed', error));
      await pool.end().catch((error: unknown) => logger.error('gateway.stop.pool_failed', error));
      logger.info('gateway.stopped');
    })();
    return stopping;
  };

  return { server, pool, settings, url: `http://${host}:${address.port}`, stop };
}
