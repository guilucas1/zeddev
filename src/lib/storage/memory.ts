/**
 * The in-memory fake.
 *
 * The trap this package is most exposed to, restated from IMPLEMENTATION_PLAN.md
 * §4d: a fake is the easiest place in a system to prove nothing. If this one
 * accepts a ref from another tenant while the real adapter refuses it, or skips
 * the checksum the real adapter verifies, then every test written above the port
 * is evidence about a system nobody deploys — and nothing fails to say so.
 *
 * So the fake is not a simplification. It shares the key derivation, the tenant
 * check, the content-type grammar, the size limit, and the integrity check with
 * the real adapter, by calling the same functions in `types.ts` rather than by
 * reimplementing them. What it replaces is only the *storage*: a `Map` where
 * there was a network.
 *
 * The one intended difference is the time source, and it is the same difference
 * the queue's fake has. The real adapter timestamps from the remote's
 * `Last-Modified`, because a client with a fast clock must not be able to make an
 * object look newer than it is; the fake takes time from an injected `Clock`, so a
 * test can drive a retention window rather than wait out one measured in weeks.
 */

import { InternalError, NotFoundError } from '@zeddev/errors';
import { normalizeTenantId, type TenantId } from '@zeddev/tenancy';
import { SystemClock, type Clock } from '@zeddev/time';
import { sha256Hex } from './sigv4.ts';
import {
  assertContentType,
  assertOwnedBy,
  assertWithinSizeLimit,
  DEFAULT_MAX_OBJECT_BYTES,
  kindPrefix,
  newObjectId,
  objectKey,
  parseObjectKey,
  tenantPrefix,
  type ObjectKind,
  type ObjectMetadata,
  type ObjectRef,
  type ObjectStore,
  type ObjectSummary,
  type PutOptions,
  type StoredObject,
  type TenantObjectStore,
} from './types.ts';

export interface InMemoryObjectStoreOptions {
  readonly maxObjectBytes?: number | undefined;
  readonly keyPrefix?: string | undefined;
  readonly clock?: Clock | undefined;
}

interface StoredEntry {
  readonly body: Buffer;
  readonly contentType: string;
  readonly sha256: string;
  readonly storedAt: Date;
}

export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, StoredEntry>();
  readonly #clock: Clock;
  readonly #prefix: string;
  readonly #maxObjectBytes: number;
  #closed = false;

  constructor(options: InMemoryObjectStoreOptions = {}) {
    this.#clock = options.clock ?? new SystemClock();
    this.#prefix = options.keyPrefix ?? '';
    this.#maxObjectBytes = options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  forTenant(tenantId: string): TenantObjectStore {
    return new InMemoryTenantObjectStore(this, normalizeTenantId(tenantId));
  }

  async deleteTenant(tenantId: string): Promise<number> {
    const prefix = tenantPrefix(this.#prefix, tenantId);
    let removed = 0;
    for (const key of [...this.#objects.keys()]) {
      if (!key.startsWith(prefix)) continue;
      // Same guard as the real sweep: a key this platform did not write is
      // skipped rather than deleted, so a shared bucket is not collateral.
      if (parseObjectKey(this.#prefix, key) === undefined) continue;
      this.#objects.delete(key);
      removed += 1;
    }
    return removed;
  }

  async verifyAccess(): Promise<void> {
    if (this.#closed) {
      throw new InternalError('The in-memory object store is closed', {
        code: 'storage.closed',
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  /** Direct state access for tests that need to assert on what was stored. */
  inspect(): ReadonlyMap<string, StoredEntry> {
    return this.#objects;
  }

  /**
   * Replace an object's bytes without updating its recorded digest.
   *
   * Corruption at rest is the one failure the real adapter's integrity check
   * exists for and the one a real server will not produce on request. This makes
   * it drivable, so the conformance suite can assert that *both* adapters refuse
   * a body that does not match — the fake here, and the real one through its
   * injected transport in `s3.test.ts`.
   */
  corrupt(ref: ObjectRef, replacement: Buffer): void {
    const key = objectKey(this.#prefix, ref);
    const existing = this.#objects.get(key);
    if (existing === undefined) throw new NotFoundError('object');
    this.#objects.set(key, { ...existing, body: replacement });
  }

  get maxObjectBytes(): number {
    return this.#maxObjectBytes;
  }

  get keyPrefix(): string {
    return this.#prefix;
  }

  get clock(): Clock {
    return this.#clock;
  }

  read(key: string): StoredEntry | undefined {
    return this.#objects.get(key);
  }

  write(key: string, entry: StoredEntry): void {
    this.#objects.set(key, entry);
  }

  remove(key: string): void {
    this.#objects.delete(key);
  }

  keysUnder(prefix: string): string[] {
    // Sorted, because the real adapter's listing arrives in lexicographic key
    // order and a fake that returned insertion order would let a test depend on
    // an ordering the real one does not provide.
    return [...this.#objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

class InMemoryTenantObjectStore implements TenantObjectStore {
  readonly #store: InMemoryObjectStore;
  readonly tenantId: TenantId;

  constructor(store: InMemoryObjectStore, tenantId: TenantId) {
    this.#store = store;
    this.tenantId = tenantId;
  }

  async put(kind: ObjectKind, body: Buffer, options: PutOptions): Promise<ObjectMetadata> {
    assertContentType(options.contentType);
    assertWithinSizeLimit(body.length, this.#store.maxObjectBytes);

    const ref: ObjectRef = { tenantId: this.tenantId, kind, id: newObjectId() };
    const entry: StoredEntry = {
      // Copied, not referenced. A caller that reuses its buffer would otherwise
      // mutate stored data — which the real adapter cannot do, because the bytes
      // left the process.
      body: Buffer.from(body),
      contentType: options.contentType,
      sha256: sha256Hex(body),
      storedAt: this.#store.clock.now(),
    };
    this.#store.write(objectKey(this.#store.keyPrefix, ref), entry);
    return {
      ref,
      contentType: entry.contentType,
      sizeBytes: entry.body.length,
      sha256: entry.sha256,
      storedAt: entry.storedAt,
    };
  }

  async get(ref: ObjectRef): Promise<StoredObject> {
    assertOwnedBy(this.tenantId, ref);
    const entry = this.#store.read(objectKey(this.#store.keyPrefix, ref));
    if (entry === undefined) {
      throw new NotFoundError('object', { context: { objectId: ref.id, tenantId: this.tenantId } });
    }
    const actual = sha256Hex(entry.body);
    if (actual !== entry.sha256) {
      throw new InternalError('Stored object failed its integrity check', {
        code: 'storage.checksum_mismatch',
        context: { objectId: ref.id, tenantId: this.tenantId, bytes: entry.body.length },
      });
    }
    return {
      ref,
      body: Buffer.from(entry.body),
      contentType: entry.contentType,
      sizeBytes: entry.body.length,
      sha256: entry.sha256,
      storedAt: entry.storedAt,
    };
  }

  async head(ref: ObjectRef): Promise<ObjectMetadata> {
    assertOwnedBy(this.tenantId, ref);
    const entry = this.#store.read(objectKey(this.#store.keyPrefix, ref));
    if (entry === undefined) {
      throw new NotFoundError('object', { context: { objectId: ref.id, tenantId: this.tenantId } });
    }
    return {
      ref,
      contentType: entry.contentType,
      sizeBytes: entry.body.length,
      sha256: entry.sha256,
      storedAt: entry.storedAt,
    };
  }

  async delete(ref: ObjectRef): Promise<void> {
    assertOwnedBy(this.tenantId, ref);
    this.#store.remove(objectKey(this.#store.keyPrefix, ref));
  }

  async list(kind: ObjectKind): Promise<readonly ObjectSummary[]> {
    const prefix = kindPrefix(this.#store.keyPrefix, this.tenantId, kind);
    const out: ObjectSummary[] = [];
    for (const key of this.#store.keysUnder(prefix)) {
      const ref = parseObjectKey(this.#store.keyPrefix, key);
      if (ref === undefined || ref.tenantId !== this.tenantId) continue;
      const entry = this.#store.read(key);
      if (entry === undefined) continue;
      out.push({ ref, sizeBytes: entry.body.length, storedAt: entry.storedAt });
    }
    return out;
  }
}
