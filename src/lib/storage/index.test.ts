/**
 * Tests that need no object storage server: the conformance suite against the
 * in-memory fake, key derivation, and the configuration schema.
 *
 * The key-derivation tests carry more weight here than their size suggests.
 * Everywhere else in this platform, tenant isolation is enforced by row-level
 * security below the application. In object storage there is no such floor —
 * what stands in for it is the key layout and the ownership check, both of which
 * are pure functions tested here. If `objectKey` were wrong, every isolation
 * assertion above it would still pass, because both the write and the read would
 * be wrong in the same direction.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { ConfigurationError, ValidationError } from '@zeddev/errors';
import { loadConfig, renderReference } from '@zeddev/config';
import { FakeClock } from '@zeddev/time';
import { specTest, unitTest } from '@zeddev/testing';
import {
  formatObjectRef,
  kindPrefix,
  newObjectId,
  objectKey,
  parseObjectKey,
  parseObjectRef,
  STORAGE_CONFIG_SCHEMA,
  tenantPrefix,
  type ObjectRef,
} from './index.ts';
import { InMemoryObjectStore, runStorageConformance, type StorageHarness } from './testing.ts';

const TENANTS = [
  'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  'cccccccc-3333-4333-8333-cccccccccccc',
];

const memoryHarness: StorageHarness = {
  label: 'in-memory',
  async create(options = {}) {
    const store = new InMemoryObjectStore({
      // A fake clock, so a retention window can be driven rather than waited
      // out. The real adapter takes its timestamps from the remote instead —
      // the one intended difference between the two, and the same one the
      // queue's fake has.
      clock: new FakeClock(),
      ...(options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes }),
    });
    return {
      store,
      tenants: TENANTS,
      async dispose() {
        await store.close();
      },
    };
  },
};

runStorageConformance(memoryHarness);

// ---------------------------------------------------------------------------
// Key derivation — the substitute for row-level security
// ---------------------------------------------------------------------------

describe('key derivation', () => {
  const ref: ObjectRef = {
    tenantId: TENANTS[0]!,
    kind: 'knowledge_document',
    id: '0123456789abcdef0123456789abcdef',
  };

  specTest(
    'tenant-data-isolation.md',
    'no identifier belonging to one tenant is valid for retrieving another tenant’s data',
    'the tenant id is the first path segment, so a tenant’s objects are contiguous',
    () => {
      // This ordering is what makes offboarding a single prefix sweep and what
      // leaves the door open to a bucket policy scoped to `<tenantId>/*` —
      // the object-storage analogue of the second database role recorded in
      // IMPLEMENTATION_PLAN.md §4c.
      assert.equal(
        objectKey('', ref),
        'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/knowledge_document/0123456789abcdef0123456789abcdef',
      );
      assert.ok(objectKey('', ref).startsWith(tenantPrefix('', ref.tenantId)));
      assert.ok(objectKey('', ref).startsWith(kindPrefix('', ref.tenantId, 'knowledge_document')));
    },
  );

  unitTest('a deployment prefix is applied to every derived key consistently', () => {
    assert.ok(objectKey('zed/', ref).startsWith('zed/'));
    assert.ok(tenantPrefix('zed/', ref.tenantId).startsWith('zed/'));
    assert.ok(objectKey('zed/', ref).startsWith(tenantPrefix('zed/', ref.tenantId)));
  });

  unitTest('a tenant id is normalised to one case before it becomes a key', () => {
    // Two cases would be two prefixes, and a `deleteTenant` sweep visits one.
    assert.equal(objectKey('', { ...ref, tenantId: ref.tenantId.toUpperCase() }), objectKey('', ref));
  });

  unitTest('a key round-trips back to the ref it was built from', () => {
    assert.deepEqual(parseObjectKey('', objectKey('', ref)), ref);
    assert.deepEqual(parseObjectKey('zed/', objectKey('zed/', ref)), ref);
    assert.deepEqual(parseObjectRef(formatObjectRef(ref)), ref);
  });

  unitTest('a key this platform did not write is not claimed as ours', () => {
    // The guard that stops a tenant sweep taking a co-tenant application's files
    // with it on a shared bucket.
    for (const foreign of [
      'some-other-app/data.json',
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/knowledge_document/not-hex',
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/unknown_kind/0123456789abcdef0123456789abcdef',
      'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa/knowledge_document/0123456789abcdef0123456789abcdef/extra',
      'not-a-uuid/knowledge_document/0123456789abcdef0123456789abcdef',
    ]) {
      assert.equal(parseObjectKey('', foreign), undefined, `should not claim ${foreign}`);
    }
    // And a key under a different deployment prefix is likewise not ours.
    assert.equal(parseObjectKey('zed/', objectKey('other/', ref)), undefined);
  });

  unitTest('a ref read back from our own storage that does not parse is an error', () => {
    // Deliberately different from the case above: foreign data is skipped, but a
    // ref we wrote ourselves that no longer parses is corruption, and silently
    // treating it as absent would lose the object rather than report it.
    assert.throws(() => parseObjectRef('nonsense'), ValidationError);
  });

  unitTest('minted identifiers are 128 bits and do not repeat', () => {
    const ids = new Set(Array.from({ length: 2000 }, newObjectId));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configuration', () => {
  const complete = {
    STORAGE_ENDPOINT_HOST: 'object-storage',
    STORAGE_BUCKET: 'zeddev',
    STORAGE_ACCESS_KEY_ID: 'local-access-key',
    STORAGE_SECRET_ACCESS_KEY: 'local-secret-key',
  };

  specTest(
    'environment-portability.md',
    'given a required configuration value is missing or invalid, when the system attempts to start, then it reports a clear error identifying the missing configuration',
    'every missing key is named at once rather than one per restart',
    () => {
      try {
        loadConfig(STORAGE_CONFIG_SCHEMA, {});
        assert.fail('expected a ConfigurationError');
      } catch (error) {
        assert.ok(error instanceof ConfigurationError);
        // All four at once. Reporting the first only would mean four restarts to
        // discover four missing values, which is the "partially starting"
        // behavior this criterion exists to rule out.
        assert.deepEqual(
          [...error.keys].sort(),
          [
            'STORAGE_ACCESS_KEY_ID',
            'STORAGE_BUCKET',
            'STORAGE_ENDPOINT_HOST',
            'STORAGE_SECRET_ACCESS_KEY',
          ],
        );
      }
    },
  );

  specTest(
    'credential-and-secret-handling.md',
    'given any log, diagnostic record, or error message produced by the system, when it is inspected, then it contains no secret value',
    'the secret key arrives wrapped so it cannot be serialised by accident',
    () => {
      const config = loadConfig(STORAGE_CONFIG_SCHEMA, complete);
      assert.equal(config.STORAGE_SECRET_ACCESS_KEY.expose(), 'local-secret-key');
      assert.ok(!JSON.stringify(config).includes('local-secret-key'));
      assert.ok(!String(config.STORAGE_SECRET_ACCESS_KEY).includes('local-secret-key'));

      // The access key id is not a secret and must stay legible, or a
      // credential mismatch becomes undiagnosable.
      assert.equal(config.STORAGE_ACCESS_KEY_ID, 'local-access-key');
    },
  );

  specTest(
    'environment-portability.md',
    'given the documented list of configuration inputs, when each is reviewed, then it is sufficient to explain every behavioral difference between deployments on different tiers',
    'everything that differs between a local endpoint and a managed one is a configuration key',
    () => {
      // The concrete claim: a laptop container and a managed cloud bucket are
      // reached by the same code, and every difference between them is a value
      // in this list. Addressing style is the one that would otherwise be
      // tempting to detect from the hostname, which is AC5's forbidden branch
      // wearing a disguise.
      const local = loadConfig(STORAGE_CONFIG_SCHEMA, {
        ...complete,
        STORAGE_TLS: 'false',
        STORAGE_ENDPOINT_PORT: '9000',
        STORAGE_ADDRESSING_STYLE: 'path',
      });
      const managed = loadConfig(STORAGE_CONFIG_SCHEMA, {
        ...complete,
        STORAGE_ENDPOINT_HOST: 'storage.example.com',
        STORAGE_ADDRESSING_STYLE: 'virtual-host',
      });

      assert.equal(local.STORAGE_TLS, false);
      assert.equal(local.STORAGE_ADDRESSING_STYLE, 'path');
      assert.equal(managed.STORAGE_TLS, true, 'TLS defaults on, so the insecure choice is explicit');
      assert.equal(managed.STORAGE_ENDPOINT_PORT, 443);
      assert.equal(managed.STORAGE_ADDRESSING_STYLE, 'virtual-host');
    },
  );

  unitTest('an unknown addressing style is refused rather than defaulted', () => {
    assert.throws(
      () => loadConfig(STORAGE_CONFIG_SCHEMA, { ...complete, STORAGE_ADDRESSING_STYLE: 'magic' }),
      ConfigurationError,
    );
  });

  unitTest('the reference documents every key, marking the secret as such', () => {
    const reference = renderReference(STORAGE_CONFIG_SCHEMA, { title: 'Object storage' });
    for (const key of Object.keys(STORAGE_CONFIG_SCHEMA)) {
      assert.ok(reference.includes(key), `${key} must appear in the generated reference`);
    }
    assert.match(reference, /STORAGE_SECRET_ACCESS_KEY[\s\S]*?\*\*\(secret\)\*\*/);
  });
});

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

describe('integrity', () => {
  specTest(
    'business-knowledge-configuration.md',
    'when the client uploads a file that cannot be processed, then the system reports the failure rather than silently discarding it',
    'a stored object whose bytes changed is reported, not returned',
    async () => {
      // Silent corruption is the one failure mode that reports nothing: a
      // truncated knowledge document produces confidently wrong bot answers,
      // and nothing downstream can tell those from correct ones.
      const store = new InMemoryObjectStore({ clock: new FakeClock() });
      const tenant = store.forTenant(TENANTS[0]!);
      const stored = await tenant.put('knowledge_document', Buffer.from('our refund policy is 30 days'), {
        contentType: 'text/plain',
      });

      store.corrupt(stored.ref, Buffer.from('our refund policy is 3 days'));

      await assert.rejects(
        () => tenant.get(stored.ref),
        (error: unknown) =>
          error instanceof Error && /integrity check/i.test(error.message),
      );
    },
  );

  specTest(
    'operator-health-monitoring.md',
    'the operator sees status and aggregate numbers only, and cannot open any client’s message content',
    'an integrity failure names the object without quoting its content',
    async () => {
      const store = new InMemoryObjectStore({ clock: new FakeClock() });
      const tenant = store.forTenant(TENANTS[0]!);
      const marker = 'zq-canary-phrase-not-in-any-identifier';
      const stored = await tenant.put('knowledge_document', Buffer.from(marker), {
        contentType: 'text/plain',
      });
      store.corrupt(stored.ref, Buffer.from(`${marker} tampered`));

      try {
        await tenant.get(stored.ref);
        assert.fail('expected an integrity failure');
      } catch (error) {
        const serialised = JSON.stringify(error);
        assert.ok(!serialised.includes(marker), 'content must not reach a diagnostic');
        assert.ok(serialised.includes(stored.ref.id), 'the opaque object id must be there to act on');
      }
    },
  );
});
