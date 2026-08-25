/**
 * The single definition of what the object storage port means.
 *
 * Runs unchanged against the in-memory fake and against a real S3-compatible
 * server. That is the whole point: `IMPLEMENTATION_PLAN.md` §4d records that a
 * fake which behaves differently from its real counterpart turns every test above
 * the port into evidence about a system nobody deploys, and — worse — nothing
 * fails to reveal it. A shared suite is what makes the two adapters
 * substitutable in fact rather than by assertion.
 *
 * Read this file to learn the port's semantics. `types.ts` states the guarantees;
 * this is where they are checked.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { NotFoundError, TenantAccessError, ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import type { ObjectRef, ObjectStore } from './types.ts';

export interface HarnessOptions {
  readonly maxObjectBytes?: number | undefined;
}

export interface StorageFixture {
  readonly store: ObjectStore;
  /** At least three, isolated per fixture so tests cannot contaminate each other. */
  readonly tenants: readonly string[];
  dispose(): Promise<void>;
}

export interface StorageHarness {
  readonly label: string;
  create(options?: HarnessOptions): Promise<StorageFixture>;
}

const PDF = 'application/pdf';

export function runStorageConformance(harness: StorageHarness): void {
  describe(`object storage conformance: ${harness.label}`, () => {
    async function withFixture(
      options: HarnessOptions,
      body: (fixture: StorageFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await harness.create(options);
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    }

    const name = (what: string): string => `[${harness.label}] ${what}`;

    // -----------------------------------------------------------------------
    // Round trip and listing
    // -----------------------------------------------------------------------

    specTest(
      'business-knowledge-configuration.md',
      'when the client uploads a valid document, then the system confirms the upload succeeded and the document appears in the list of configured knowledge',
      name('a stored document is readable and appears in the tenant listing'),
      async () => {
        await withFixture({}, async ({ store, tenants }) => {
          const tenant = store.forTenant(tenants[0]!);
          const body = Buffer.from('Q: what are your hours?\nA: nine to five.', 'utf8');

          const stored = await tenant.put('knowledge_document', body, { contentType: PDF });
          assert.equal(stored.sizeBytes, body.length);
          assert.equal(stored.ref.tenantId, tenants[0]!.toLowerCase());

          const read = await tenant.get(stored.ref);
          assert.deepEqual(read.body, body, 'the bytes read back must be the bytes written');
          assert.equal(read.contentType, PDF);
          assert.equal(read.sha256, stored.sha256);

          const listed = await tenant.list('knowledge_document');
          assert.deepEqual(
            listed.map((item) => item.ref.id),
            [stored.ref.id],
          );
          assert.equal(listed[0]!.sizeBytes, body.length);
        });
      },
    );

    unitTest(name('binary content survives the round trip unchanged'), async () => {
      // Every byte value, so a transport that mangles high bytes, treats the body
      // as UTF-8, or trims a trailing NUL is caught. WhatsApp voice notes and
      // images are the real payloads and none of them are text.
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const body = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
        const stored = await tenant.put('inbound_media', body, { contentType: 'audio/ogg' });
        const read = await tenant.get(stored.ref);
        assert.deepEqual(read.body, body);
      });
    });

    unitTest(name('an empty body is a valid object, not an absent one'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const stored = await tenant.put('knowledge_document', Buffer.alloc(0), { contentType: PDF });
        const read = await tenant.get(stored.ref);
        assert.equal(read.body.length, 0);
        assert.equal((await tenant.list('knowledge_document')).length, 1);
      });
    });

    unitTest(name('kinds partition a tenant’s namespace'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const document = await tenant.put('knowledge_document', Buffer.from('doc'), {
          contentType: PDF,
        });
        await tenant.put('inbound_media', Buffer.from('media'), { contentType: 'image/jpeg' });

        const documents = await tenant.list('knowledge_document');
        assert.deepEqual(
          documents.map((item) => item.ref.id),
          [document.ref.id],
          'listing documents must not walk a tenant’s unbounded inbound media',
        );
      });
    });

    unitTest(name('head reports metadata without reading the body'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const body = Buffer.from('a reference document');
        const stored = await tenant.put('knowledge_document', body, { contentType: PDF });
        const head = await tenant.head(stored.ref);
        assert.equal(head.sizeBytes, body.length);
        assert.equal(head.sha256, stored.sha256);
        assert.equal(head.contentType, PDF);
      });
    });

    unitTest(name('every stored object gets a distinct identifier'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const refs = await Promise.all(
          Array.from({ length: 8 }, () =>
            tenant.put('knowledge_document', Buffer.from('same bytes'), { contentType: PDF }),
          ),
        );
        const ids = new Set(refs.map((item) => item.ref.id));
        assert.equal(ids.size, 8, 'identical content must not collide onto one key');
        for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
      });
    });

    // -----------------------------------------------------------------------
    // Tenant isolation
    // -----------------------------------------------------------------------

    specTest(
      'tenant-data-isolation.md',
      'given a request supplies an identifier belonging to tenant A, when made in a context authenticated as tenant B, then the system denies access rather than returning tenant A’s data',
      name('a ref from another tenant is refused on every operation that takes one'),
      async () => {
        await withFixture({}, async ({ store, tenants }) => {
          const alice = store.forTenant(tenants[0]!);
          const bob = store.forTenant(tenants[1]!);
          const secret = Buffer.from('alice’s private price list');
          const stored = await alice.put('knowledge_document', secret, { contentType: PDF });

          // Exactly the spec's scenario: a real, valid identifier, supplied out
          // of context. Not a malformed one — a malformed one would be caught by
          // validation and would prove nothing about isolation.
          await assert.rejects(() => bob.get(stored.ref), TenantAccessError);
          await assert.rejects(() => bob.head(stored.ref), TenantAccessError);
          await assert.rejects(() => bob.delete(stored.ref), TenantAccessError);

          // And the refusal did not destroy anything on the way.
          const stillThere = await alice.get(stored.ref);
          assert.deepEqual(stillThere.body, secret);
        });
      },
    );

    specTest(
      'tenant-data-isolation.md',
      'given tenant A has uploaded knowledge documents, when tenant B’s bot answers, then it draws only on tenant B’s own documents',
      name('a tenant’s listing never contains another tenant’s objects'),
      async () => {
        await withFixture({}, async ({ store, tenants }) => {
          const alice = store.forTenant(tenants[0]!);
          const bob = store.forTenant(tenants[1]!);
          const carol = store.forTenant(tenants[2]!);

          const aliceRef = await alice.put('knowledge_document', Buffer.from('a'), {
            contentType: PDF,
          });
          await carol.put('knowledge_document', Buffer.from('c'), { contentType: PDF });

          assert.deepEqual(await bob.list('knowledge_document'), []);

          const bobRef = await bob.put('knowledge_document', Buffer.from('b'), { contentType: PDF });
          const bobListing = await bob.list('knowledge_document');
          assert.deepEqual(
            bobListing.map((item) => item.ref.id),
            [bobRef.ref.id],
          );
          assert.ok(
            !bobListing.some((item) => item.ref.id === aliceRef.ref.id),
            'tenant B must not see tenant A’s document even by identifier',
          );
        });
      },
    );

    specTest(
      'tenant-data-isolation.md',
      'no identifier belonging to one tenant is valid for another tenant’s data, even if guessed',
      name('a ref forged by swapping in the caller’s own tenant id does not resolve'),
      async () => {
        await withFixture({}, async ({ store, tenants }) => {
          const alice = store.forTenant(tenants[0]!);
          const bob = store.forTenant(tenants[1]!);
          const stored = await alice.put('knowledge_document', Buffer.from('alice'), {
            contentType: PDF,
          });

          // The attack the ownership check alone would not stop: rather than
          // presenting Alice's ref, Bob presents Alice's *object id* under his
          // own tenant id, which passes `assertOwnedBy` cleanly. The key layout
          // is what defeats it — the object lives under Alice's prefix and there
          // is nothing at Bob's.
          const forged: ObjectRef = { ...stored.ref, tenantId: bob.tenantId };
          await assert.rejects(() => bob.get(forged), NotFoundError);
          await assert.rejects(() => bob.head(forged), NotFoundError);
        });
      },
    );

    // -----------------------------------------------------------------------
    // Rejected uploads leave nothing behind
    // -----------------------------------------------------------------------

    specTest(
      'business-knowledge-configuration.md',
      'when the client uploads a file that cannot be processed, then the system reports the failure and the document does not appear as an active knowledge source',
      name('an oversized upload is reported and stores nothing'),
      async () => {
        await withFixture({ maxObjectBytes: 64 }, async ({ store, tenants }) => {
          const tenant = store.forTenant(tenants[0]!);

          await assert.rejects(
            () => tenant.put('knowledge_document', Buffer.alloc(65), { contentType: PDF }),
            ValidationError,
            'the client must be told the upload did not succeed',
          );

          // The half that is easy to get wrong: reporting the failure correctly
          // while the bytes already landed leaves an orphan no index row points
          // at and no offboarding sweep has a reason to expect.
          assert.deepEqual(
            await tenant.list('knowledge_document'),
            [],
            'a rejected upload must not appear as an active knowledge source',
          );
        });
      },
    );

    unitTest(name('an upload at exactly the limit is accepted'), async () => {
      // The off-by-one on a rejection path, which nobody notices until a client
      // reports that a document "sometimes" fails.
      await withFixture({ maxObjectBytes: 64 }, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const stored = await tenant.put('knowledge_document', Buffer.alloc(64), {
          contentType: PDF,
        });
        assert.equal(stored.sizeBytes, 64);
      });
    });

    unitTest(name('a content type that could forge a request header is refused'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        for (const contentType of [
          'application/pdf\r\nx-amz-acl: public-read',
          'application/pdf\nHost: elsewhere',
          'not a media type',
          '',
        ]) {
          await assert.rejects(
            () => tenant.put('knowledge_document', Buffer.from('x'), { contentType }),
            ValidationError,
            `should refuse ${JSON.stringify(contentType)}`,
          );
        }
        assert.deepEqual(await tenant.list('knowledge_document'), []);
      });
    });

    unitTest(name('a media type carrying a charset parameter is accepted'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const stored = await tenant.put('knowledge_document', Buffer.from('hi'), {
          contentType: 'text/plain; charset=utf-8',
        });
        const read = await tenant.get(stored.ref);
        assert.match(read.contentType, /text\/plain/);
      });
    });

    // -----------------------------------------------------------------------
    // Absence and deletion
    // -----------------------------------------------------------------------

    unitTest(name('reading an object that was never stored raises NotFound'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const absent: ObjectRef = {
          tenantId: tenant.tenantId,
          kind: 'knowledge_document',
          id: 'f'.repeat(32),
        };
        await assert.rejects(() => tenant.get(absent), NotFoundError);
        await assert.rejects(() => tenant.head(absent), NotFoundError);
      });
    });

    unitTest(name('deleting is idempotent so a failed sweep can simply be re-run'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        const stored = await tenant.put('knowledge_document', Buffer.from('x'), {
          contentType: PDF,
        });
        await tenant.delete(stored.ref);
        await tenant.delete(stored.ref);
        await assert.rejects(() => tenant.get(stored.ref), NotFoundError);
      });
    });

    specTest(
      'client-offboarding-and-data-retention.md',
      'given a client’s data has been permanently deleted, when anyone attempts to retrieve or restore it, then no documents are recoverable',
      name('deleting a tenant removes every object it owns, of every kind'),
      async () => {
        await withFixture({}, async ({ store, tenants }) => {
          const departing = store.forTenant(tenants[0]!);
          const staying = store.forTenant(tenants[1]!);

          // Enough objects to cross a listing page boundary. An untested
          // continuation-token loop is a sweep that stops short and reports
          // success — which would break a promise this spec calls irreversible.
          const refs = [];
          for (let index = 0; index < 7; index += 1) {
            refs.push(
              await departing.put('knowledge_document', Buffer.from(`doc-${index}`), {
                contentType: PDF,
              }),
            );
          }
          for (let index = 0; index < 5; index += 1) {
            refs.push(
              await departing.put('inbound_media', Buffer.from(`media-${index}`), {
                contentType: 'image/jpeg',
              }),
            );
          }
          const survivor = await staying.put('knowledge_document', Buffer.from('keep me'), {
            contentType: PDF,
          });

          const removed = await store.deleteTenant(departing.tenantId);
          assert.equal(removed, refs.length, 'every object must be accounted for');

          for (const stored of refs) {
            await assert.rejects(
              () => departing.get(stored.ref),
              NotFoundError,
              'no document may remain recoverable after permanent deletion',
            );
          }
          assert.deepEqual(await departing.list('knowledge_document'), []);
          assert.deepEqual(await departing.list('inbound_media'), []);

          // The other half, which a prefix sweep gets wrong by being too broad.
          const kept = await staying.get(survivor.ref);
          assert.deepEqual(kept.body, Buffer.from('keep me'));
        });
      },
    );

    unitTest(name('deleting a tenant twice is safe and reports nothing the second time'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        await tenant.put('knowledge_document', Buffer.from('x'), { contentType: PDF });
        assert.equal(await store.deleteTenant(tenant.tenantId), 1);
        assert.equal(await store.deleteTenant(tenant.tenantId), 0);
      });
    });

    unitTest(name('deleting a tenant that never stored anything succeeds'), async () => {
      // Offboarding runs for every departing client, including one that
      // uploaded nothing. Raising here would make the retention-window job fail
      // for the simplest possible tenant.
      await withFixture({}, async ({ store, tenants }) => {
        assert.equal(await store.deleteTenant(tenants[2]!), 0);
      });
    });

    // -----------------------------------------------------------------------
    // Input validation at the boundary
    // -----------------------------------------------------------------------

    specTest(
      'tenant-data-isolation.md',
      'no identifier belonging to one tenant is valid for another tenant’s data, even if supplied out of context',
      name('a tenant id that is not a tenant id is refused before it becomes a key'),
      async () => {
        await withFixture({}, async ({ store }) => {
          for (const bad of ['', '..', '../evil', 'not-a-uuid', 'a/b']) {
            assert.throws(() => store.forTenant(bad), ValidationError, `should refuse ${bad}`);
          }
          await assert.rejects(() => store.deleteTenant('../everything'), ValidationError);
        });
      },
    );

    unitTest(name('a malformed object id is refused rather than fetched'), async () => {
      await withFixture({}, async ({ store, tenants }) => {
        const tenant = store.forTenant(tenants[0]!);
        for (const id of ['', '../../etc/passwd', 'ABCDEF', 'g'.repeat(32)]) {
          await assert.rejects(
            () => tenant.get({ tenantId: tenant.tenantId, kind: 'knowledge_document', id }),
            ValidationError,
            `should refuse ${JSON.stringify(id)}`,
          );
        }
      });
    });

    unitTest(name('verifyAccess succeeds against a reachable, correctly configured store'), async () => {
      await withFixture({}, async ({ store }) => {
        await store.verifyAccess();
      });
    });
  });
}
