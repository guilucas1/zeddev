/**
 * The dashboard process entrypoint: `node src/services/web/main.ts`.
 *
 * Nothing but wiring, as in the other services' `main.ts`: signals and an exit
 * code. A configuration failure is reported both as one JSON record per key and as
 * plain text on standard error, because a log pipeline that is not set up yet — the
 * usual case on a first deploy — identifies nothing.
 */

import { ConfigurationError } from '@zeddev/errors';
import { Logger } from '@zeddev/logging';
import { startWeb } from './start.ts';

const logger = new Logger({ bindings: { service: 'web' } });

try {
  const running = await startWeb();
  let signalled = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (signalled) return;
      signalled = true;
      running.stop().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
} catch (error) {
  if (error instanceof ConfigurationError) {
    for (const issue of error.issues) {
      logger.error('web.startup.config_invalid', error, { configKey: issue.key, reason: issue.reason });
    }
    process.stderr.write(`${error.message}\n`);
  } else {
    logger.error('web.startup.failed', error);
  }
  process.exitCode = 1;
  // A container that hangs instead of exiting is never restarted by its orchestrator.
  setTimeout(() => process.exit(1), 2000).unref();
}
