/**
 * Regenerate `docs/configuration.md` from the schemas that parse the environment.
 *
 * Run: `npm run config-reference`
 *
 * The document is generated rather than written because
 * `environment-portability.md` states its completeness as an *inspectable*
 * criterion, and a hand-maintained environment-variable reference stops being
 * complete on the second key anyone adds — silently, because the platform still
 * runs and only someone standing up a different tier finds out. A test in
 * `src/lib/deployment/index.test.ts` fails the build when the committed file
 * drifts from the schemas, which is what makes this a promise rather than an
 * intention.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPlatformReference, configKeys } from '../src/lib/deployment/index.ts';

const target = join(process.cwd(), 'docs', 'configuration.md');
writeFileSync(target, renderPlatformReference(), 'utf8');
process.stdout.write(`Wrote ${target} — ${configKeys().length} configuration keys.\n`);
