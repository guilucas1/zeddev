/**
 * Fail the commit gate when the integration database is not configured.
 *
 * This exists because of a specific way a test suite lies. The database-backed
 * suites skip themselves when `ZEDDEV_TEST_DATABASE_HOST` is unset — which is
 * right, since not every machine has Docker — but the result is a fully green
 * `npm run check` in which every assertion about tenant isolation was never run.
 * IMPLEMENTATION_PLAN.md §4b already records the same shape of mistake once:
 * `npm test` passing while nothing was typechecked.
 *
 * A green gate that proves less than it appears to is worse than a red one,
 * because it is trusted. So `check` requires the database, and `check:offline`
 * exists for the case where Docker genuinely is not available — named so that
 * choosing it is a visible decision rather than an accident.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ENV_FILE = join(process.cwd(), '.env.test');
const configured = process.env['ZEDDEV_TEST_DATABASE_HOST'] !== undefined || existsSync(ENV_FILE);

if (!configured) {
  process.stderr.write(
    [
      '',
      'The database-backed test suites cannot run, so `check` would pass without',
      'verifying tenant isolation, row-level security, or the migration runner.',
      '',
      'Start the database:',
      '',
      '    npm run db:up',
      '',
      'It writes .env.test, which `npm test` loads automatically.',
      '',
      'If Docker is unavailable, run `npm run check:offline` instead — and note that',
      'it does not cover anything in @zeddev/db or @zeddev/schema.',
      '',
    ].join('\n'),
  );
  process.exit(1);
}
