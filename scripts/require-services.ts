/**
 * Fail the commit gate when the integration services are not configured.
 *
 * This exists because of a specific way a test suite lies. The database-backed
 * and storage-backed suites skip themselves when their endpoints are unset —
 * which is right, since not every machine has Docker — but the result is a fully
 * green `npm run check` in which every assertion about tenant isolation was
 * never run. IMPLEMENTATION_PLAN.md §4b already records the same shape of
 * mistake once: `npm test` passing while nothing was typechecked.
 *
 * A green gate that proves less than it appears to is worse than a red one,
 * because it is trusted. So `check` requires both services, and `check:offline`
 * exists for the case where Docker genuinely is not available — named so that
 * choosing it is a visible decision rather than an accident.
 *
 * Object storage joined the database here rather than being allowed to skip
 * quietly, for the same reason and one more: the object store is the only place
 * in the platform where tenant isolation is *not* enforced below the application
 * by row-level security. Its isolation tests are therefore the ones least
 * affordable to skip.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENV_FILE = join(process.cwd(), '.env.test');
const envFileContents = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';

interface Service {
  readonly label: string;
  readonly variable: string;
  readonly command: string;
  readonly covers: string;
}

const SERVICES: readonly Service[] = [
  {
    label: 'PostgreSQL',
    variable: 'ZEDDEV_TEST_DATABASE_HOST',
    command: 'npm run db:up',
    covers: '@zeddev/db and @zeddev/schema — row-level security, migrations, tenant isolation',
  },
  {
    label: 'object storage',
    variable: 'ZEDDEV_TEST_STORAGE_HOST',
    command: 'npm run storage:up',
    covers: '@zeddev/storage — request signing, listing pagination, per-tenant object isolation',
  },
  {
    label: 'SMTP',
    variable: 'ZEDDEV_TEST_MAIL_HOST',
    command: 'npm run mail:up',
    covers:
      '@zeddev/mail — the SMTP conversation, message encoding, and dot-stuffing. Skipping it leaves only the fake, which cannot disagree with the encoder it shares',
  },
];

const missing = SERVICES.filter(
  (service) =>
    process.env[service.variable] === undefined &&
    !new RegExp(`^${service.variable}=`, 'm').test(envFileContents),
);

if (missing.length > 0) {
  const lines = [
    '',
    'Some integration suites cannot run, so `check` would pass without verifying',
    'what they cover:',
    '',
  ];
  for (const service of missing) {
    lines.push(`  ${service.label}`);
    lines.push(`    start with:  ${service.command}`);
    lines.push(`    covers:      ${service.covers}`);
    lines.push('');
  }
  lines.push('Each command writes its settings into .env.test, which `npm test` loads');
  lines.push('automatically, and each leaves the other command\'s settings alone.');
  lines.push('');
  lines.push('If Docker is unavailable, run `npm run check:offline` instead — and note that');
  lines.push('it does not cover any of the above.');
  lines.push('');
  process.stderr.write(lines.join('\n'));
  process.exit(1);
}
