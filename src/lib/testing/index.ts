/**
 * Spec traceability for tests.
 *
 * Why this exists: IMPLEMENTATION_PLAN.md's cross-cutting item requires that every
 * Given/When/Then bullet across `specs/` map to at least one named test, because
 * without that mapping the question "is this spec done?" has no answer and the
 * plan's status becomes guesswork. A convention ("mention the spec in the test
 * name") decays silently; a helper that *records* the mapping and *fails* when the
 * mapping is wrong does not.
 *
 * Two properties earn their keep here:
 *
 *  1. The spec file is resolved against `specs/` at test-definition time. A typo
 *     or a spec rename fails the test run immediately, rather than leaving the
 *     criterion orphaned and quietly uncovered — which is the failure mode that
 *     makes traceability systems worthless after six months.
 *  2. Coverage is emitted as JSONL, one line per assertion, so it survives the
 *     process-per-file isolation that `node --test` uses. An in-memory registry
 *     would only ever see one file's worth of coverage.
 */

import { test, type TestContext } from 'node:test';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Repo root, found by walking up to the directory that contains `specs/`. */
function findRepoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'specs')) && existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate repo root (a directory containing specs/) from ${HERE}`);
}

export const REPO_ROOT = findRepoRoot();
export const SPECS_DIR = join(REPO_ROOT, 'specs');

let specFileCache: Set<string> | undefined;

/** The set of spec filenames that actually exist, e.g. `tenant-data-isolation.md`. */
export function knownSpecFiles(): ReadonlySet<string> {
  specFileCache ??= new Set(
    readdirSync(SPECS_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md'),
  );
  return specFileCache;
}

/** A single recorded spec-to-test mapping. */
export interface SpecCoverageEntry {
  readonly spec: string;
  readonly criterion: string;
  readonly test: string;
}

const COVERAGE_ENV = 'ZEDDEV_SPEC_COVERAGE_FILE';

function recordCoverage(entry: SpecCoverageEntry): void {
  const target = process.env[COVERAGE_ENV];
  if (target === undefined || target === '') return;
  mkdirSync(dirname(resolve(target)), { recursive: true });
  appendFileSync(resolve(target), `${JSON.stringify(entry)}\n`, 'utf8');
}

/**
 * Declare a test that covers a specific acceptance criterion of a specific spec.
 *
 * @param spec      Filename within `specs/`, e.g. `'tenant-data-isolation.md'`.
 * @param criterion Short identifier for the criterion, e.g. `'AC9'`, plus enough
 *                  words to be readable in a failure report.
 * @param name      What this test asserts.
 *
 * Throws at definition time if `spec` names a file that does not exist. That is
 * deliberate: a broken reference should break the build, not degrade quietly into
 * an untracked criterion.
 */
export function specTest(
  spec: string,
  criterion: string,
  name: string,
  fn: (t: TestContext) => void | Promise<void>,
): void {
  if (!knownSpecFiles().has(spec)) {
    const available = [...knownSpecFiles()].sort().join(', ');
    throw new Error(
      `specTest referenced unknown spec file "${spec}". Available specs: ${available}`,
    );
  }
  recordCoverage({ spec, criterion, test: name });
  test(`[${spec} ${criterion}] ${name}`, fn);
}

/**
 * Declare a test for behavior that is required by the implementation plan or by
 * an architectural decision rather than by a single spec criterion.
 *
 * Kept distinct from `specTest` so that spec coverage reporting is not diluted by
 * tests that were never traceable to a criterion in the first place.
 */
export function unitTest(name: string, fn: (t: TestContext) => void | Promise<void>): void {
  test(name, fn);
}

/** Read back an emitted coverage file. Used by the coverage report script. */
export function readCoverageFile(path: string): SpecCoverageEntry[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SpecCoverageEntry);
}

/**
 * Count the `Given ... when ... then ...` bullets in a spec's Acceptance Criteria
 * section.
 *
 * Used by the coverage report to show covered-vs-total per spec. Approximate by
 * nature — the specs are prose — so it is reported as a denominator for human
 * judgement, never asserted on. Encoding a hard threshold against a regex over
 * prose would produce a number that gets gamed rather than a signal that helps.
 */
export function countAcceptanceCriteria(specFile: string): number {
  const text = readFileSync(join(SPECS_DIR, specFile), 'utf8');
  const section = /^##\s+Acceptance Criteria\s*$/m.exec(text);
  if (section === null) return 0;
  const start = section.index + section[0].length;
  const nextHeading = /^##\s+/m.exec(text.slice(start));
  const body = nextHeading === null ? text.slice(start) : text.slice(start, start + nextHeading.index);
  return body.split('\n').filter((line) => /^\s*-\s+Given\b/i.test(line)).length;
}
