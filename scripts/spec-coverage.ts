/**
 * Spec coverage report.
 *
 * Answers the question IMPLEMENTATION_PLAN.md's cross-cutting item exists to make
 * answerable: which specs have tests behind them, and which have none at all?
 *
 * Run: `npm run spec-coverage`
 *
 * The per-spec denominator is a count of `- Given ...` bullets, which is
 * approximate because the specs are prose. It is printed for judgement, never
 * asserted on — a hard threshold over a regex gets gamed rather than met. The
 * number that actually matters is the list of specs with zero covering tests,
 * because that is where "is this done?" currently has no answer.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_ROOT,
  countAcceptanceCriteria,
  knownSpecFiles,
  readCoverageFile,
} from '../src/lib/testing/index.ts';

const workDir = mkdtempSync(join(tmpdir(), 'zeddev-coverage-'));
const coverageFile = join(workDir, 'coverage.jsonl');

try {
  execFileSync('node', ['--test', 'src/**/*.test.ts'], {
    cwd: REPO_ROOT,
    env: { ...process.env, ZEDDEV_SPEC_COVERAGE_FILE: coverageFile },
    stdio: 'ignore',
  });
} catch {
  // A failing suite still produces coverage records for the tests that were
  // defined, and the report is more useful than a bare exit code when something
  // is red. The test run itself is what gates the build, not this script.
  process.stderr.write('note: the test suite did not pass; coverage below reflects declared tests\n\n');
}

const entries = readCoverageFile(coverageFile);
rmSync(workDir, { recursive: true, force: true });

const bySpec = new Map<string, Set<string>>();
for (const entry of entries) {
  const criteria = bySpec.get(entry.spec) ?? new Set<string>();
  criteria.add(entry.criterion);
  bySpec.set(entry.spec, criteria);
}

const specs = [...knownSpecFiles()].sort();
const uncovered: string[] = [];

process.stdout.write('Spec coverage\n');
process.stdout.write('='.repeat(78));
process.stdout.write('\n');
process.stdout.write('spec'.padEnd(46) + 'criteria'.padStart(10) + 'AC bullets'.padStart(12) + '\n');
process.stdout.write('-'.repeat(78));
process.stdout.write('\n');

for (const spec of specs) {
  const covered = bySpec.get(spec)?.size ?? 0;
  const total = countAcceptanceCriteria(spec);
  if (covered === 0) uncovered.push(spec);
  const marker = covered === 0 ? ' !' : '  ';
  process.stdout.write(
    `${marker}${spec.padEnd(44)}${String(covered).padStart(10)}${String(total).padStart(12)}\n`,
  );
}

process.stdout.write('-'.repeat(78));
process.stdout.write('\n');
process.stdout.write(
  `${specs.length} specs, ${bySpec.size} with covering tests, ${entries.length} spec-linked assertions\n\n`,
);

if (uncovered.length > 0) {
  process.stdout.write(`Specs with no covering test yet (${uncovered.length}):\n`);
  for (const spec of uncovered) process.stdout.write(`  - ${spec}\n`);
}
