/**
 * Why these tests matter: this package holds a security invariant, not a
 * convenience check. The path-traversal cases below are the ones that decide
 * whether `tenant-data-isolation.md` holds in object storage, where a tenant id
 * is a path segment rather than a bound parameter — a `/` that slips through
 * does not raise an error anywhere, it writes one tenant's object under another
 * tenant's prefix and every later read succeeds.
 */

import assert from 'node:assert/strict';
import { ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { assertTenantId, isTenantId, normalizeTenantId } from './index.ts';

const VALID = 'a1b2c3d4-1111-4222-8333-444455556666';

unitTest('accepts a well-formed uuid in either case', () => {
  assert.equal(isTenantId(VALID), true);
  assert.equal(isTenantId(VALID.toUpperCase()), true);
});

specTest(
  'tenant-data-isolation.md',
  'no identifier belonging to one tenant is valid for retrieving another tenant\'s data, even if supplied out of context',
  'a tenant id that would escape its own key prefix is rejected',
  () => {
    // Each of these is well-formed enough to look plausible in a log and would,
    // unchecked, resolve to a key outside the tenant's own namespace.
    const escapes = [
      '../a1b2c3d4-1111-4222-8333-444455556666',
      'a1b2c3d4-1111-4222-8333-444455556666/../../other',
      'a1b2c3d4-1111-4222-8333-444455556666/knowledge_document',
      '..',
      '',
      '   ',
      'a1b2c3d4-1111-4222-8333-444455556666\n',
    ];
    for (const candidate of escapes) {
      assert.equal(isTenantId(candidate), false, `should reject ${JSON.stringify(candidate)}`);
      assert.throws(() => assertTenantId(candidate), ValidationError);
    }
  },
);

unitTest('the rejection names the key so a caller can act on it', () => {
  try {
    assertTenantId('not-a-uuid');
    assert.fail('expected a ValidationError');
  } catch (error) {
    assert.ok(error instanceof ValidationError);
    assert.deepEqual(error.issues, [{ key: 'tenantId', reason: 'must be a UUID' }]);
  }
});

specTest(
  'client-offboarding-and-data-retention.md',
  'when anyone attempts to retrieve or restore deleted data, then no documents are recoverable',
  'normalizing to one case is what makes a prefix sweep able to reach every key',
  () => {
    // The failure this prevents: an id that reached the store uppercased writes
    // to a prefix that a lowercased `deleteTenant` sweep never visits, so data
    // survives a deletion the platform reported as complete.
    assert.equal(normalizeTenantId(VALID.toUpperCase()), VALID);
    assert.equal(normalizeTenantId(VALID), VALID);
    assert.throws(() => normalizeTenantId('nope'), ValidationError);
  },
);
