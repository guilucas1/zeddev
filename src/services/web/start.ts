/**
 * Bringing the dashboard up, and taking it down again cleanly.
 *
 * Every configuration key is checked and every asset prepared before the listener
 * opens, so a process that accepts connections can serve them. It does not wait
 * for the API: the two start and restart independently (`component-independence.md`).
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadAll, loadConfig, type RawEnv } from '@zeddev/config';
import { Logger, LOGGING_CONFIG_SCHEMA, type LogSink } from '@zeddev/logging';
import { createWeb } from './app.ts';
import { loadAssets } from './assets.ts';
import { loadWebSettings, type WebSettings } from './config.ts';

export interface StartWebOptions {
  readonly sink?: LogSink | undefined;
}

export interface RunningWeb {
  readonly server: Server;
  readonly settings: WebSettings;
  /** The bound address — useful when the configured port was 0. */
  readonly url: string;
  /** Stop accepting and finish in-flight requests within the grace period. Idempotent. */
  stop(): Promise<void>;
}

export async function startWeb(env: RawEnv = process.env, options: StartWebOptions = {}): Promise<RunningWeb> {
  const [settings, logging] = loadAll([() => loadWebSettings(env), () => loadConfig(LOGGING_CONFIG_SCHEMA, env)] as const);

  const logger = new Logger({
    level: logging.LOG_LEVEL,
    bindings: { service: 'web' },
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  });

  const web = createWeb({ settings, assets: loadAssets(), logger });
  const server = createServer(web.handler);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(settings.port, settings.host, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  logger.info('web.started', { port: address.port });

  let stopping: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      logger.info('web.stopping', { windowMs: settings.shutdownGraceMs });
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      const forced = setTimeout(() => server.closeAllConnections(), settings.shutdownGraceMs);
      await closed;
      clearTimeout(forced);
      logger.info('web.stopped');
    })();
    return stopping;
  };

  return { server, settings, url: `http://${host}:${address.port}`, stop };
}
