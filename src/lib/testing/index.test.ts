/**
 * Why these tests matter: the traceability helper's whole value is that a broken
 * spec reference fails loudly. If `specTest` silently accepted a misspelled or
 * renamed spec file, the criterion it claimed to cover would become invisible —
 * and the plan's "is this spec done?" question would get a confidently wrong
 * answer. So the failure path is the thing worth testing.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPO_ROOT,
  SPECS_DIR,
  countAcceptanceCriteria,
  knownSpecFiles,
  specTest,
  unitTest,
} from './index.ts';

unitTest('the repo root is located by finding the directory that holds specs/', () => {
  assert.ok(existsSync(join(REPO_ROOT, 'specs')));
  assert.ok(existsSync(join(REPO_ROOT, 'package.json')));
  assert.ok(existsSync(join(REPO_ROOT, 'IMPLEMENTATION_PLAN.md')));
});

unitTest('every spec in specs/ is discoverable, and the README index is not one of them', () => {
  const specs = knownSpecFiles();

  assert.ok(specs.size >= 20, `expected the full spec set, found ${specs.size}`);
  assert.ok(specs.has('tenant-data-isolation.md'));
  assert.ok(specs.has('whatsapp-number-connection.md'));
  // The README indexes the specs; counting it would inflate coverage denominators.
  assert.ok(!specs.has('README.md'));
});

unitTest('specTest rejects a spec filename that does not exist', () => {
  // The load-bearing behavior: a rename or typo breaks the build instead of
  // orphaning the criterion.
  assert.throws(
    () => specTest('tenant-data-isolation.MD', 'AC1', 'wrong case', () => {}),
    /unknown spec file/,
  );
  assert.throws(
    () => specTest('tenant-isolation.md', 'AC1', 'misspelled', () => {}),
    /unknown spec file/,
  );
  assert.throws(() => specTest('specs/tenant-data-isolation.md', 'AC1', 'path not name', () => {}), /unknown spec file/);
});

unitTest('the failure message lists the available specs, so the fix is immediate', () => {
  assert.throws(
    () => specTest('nonexistent.md', 'AC1', 'x', () => {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes('tenant-data-isolation.md'));
      return true;
    },
  );
});

unitTest('acceptance criteria are countable from a spec, giving coverage a denominator', () => {
  // Approximate by nature — the specs are prose. Reported for human judgement,
  // never asserted against a threshold, because a threshold over a regex gets
  // gamed rather than satisfied.
  const count = countAcceptanceCriteria('tenant-data-isolation.md');
  assert.ok(count > 0, 'tenant-data-isolation.md has an Acceptance Criteria section');

  for (const spec of knownSpecFiles()) {
    assert.ok(
      countAcceptanceCriteria(spec) > 0,
      `${spec} has no parseable "Given ..." acceptance criteria — either the spec is ` +
        `missing them or its format drifted from the rest of specs/`,
    );
  }
});

unitTest('SPECS_DIR points at the real specs directory', () => {
  assert.equal(SPECS_DIR, join(REPO_ROOT, 'specs'));
});

specTest(
  'tenant-data-isolation.md',
  'AC1 self-check',
  'specTest registers a passing test under its spec and criterion',
  () => {
    // Proves the happy path runs at all; the interesting assertions above are
    // about the failure path.
    assert.ok(true);
  },
);
