/**
 * Test-only exports.
 *
 * Kept behind a separate subpath rather than on the main one so a service cannot
 * reach the fake by accident. A production import of `InMemoryObjectStore` would
 * be an object store that loses every uploaded knowledge document on restart —
 * and the failure would look like nothing at all until a deploy, because the
 * writes all succeed.
 */

export { InMemoryObjectStore, type InMemoryObjectStoreOptions } from './memory.ts';
export {
  runStorageConformance,
  type HarnessOptions,
  type StorageFixture,
  type StorageHarness,
} from './conformance.ts';
export {
  createTestBucket,
  storageTestConfigured,
  SKIP_REASON,
  type TestBucket,
} from './fixtures.ts';
