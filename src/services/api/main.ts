/**
 * The API process entrypoint: `node src/services/api/main.ts`.
 *
 * Deliberately nothing but wiring — every behaviour worth testing lives in
 * `start.ts`, which the tests drive in-process. What is left here is what only a
 * real process has: signals and an exit code.
 *
 * A configuration failure is reported twice, on purpose: one JSON record per
 * offending key for whatever collects the logs, and the whole list as plain text
 * on standard error for the person at the terminal who has just run the image on
 * a new tier. `environment-portability.md` AC7 asks that the error *identify* the
 * missing value, and a log pipeline that is not set up yet identifies nothing.
 */

import { ConfigurationError } from '@zeddev/errors';
import { Logger } from '@zeddev/logging';
import { startApi } from './start.ts';

const logger = new Logger({ bindings: { service: 'api' } });

try {
  const running = await startApi();
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
      logger.error('api.startup.config_invalid', error, { configKey: issue.key, reason: issue.reason });
    }
    process.stderr.write(`${error.message}\n`);
  } else {
    logger.error('api.startup.failed', error);
  }
  process.exitCode = 1;
  // Everything startApi opened is closed on failure, so the loop should drain on
  // its own; this bounds the wait if something does not, because a container
  // that hangs instead of exiting is never restarted by its orchestrator.
  setTimeout(() => process.exit(1), 2000).unref();
}
