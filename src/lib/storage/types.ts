/**
 * The object storage port: uploaded knowledge documents and fetched WhatsApp media.
 *
 * Four guarantees are non-negotiable here, and each one is why the port has the
 * shape it has rather than the shape an S3 SDK would suggest.
 *
 * **1. A caller cannot name an object.** `tenant-data-isolation.md` requires that
 * "no identifier, credential, or reference belonging to one tenant ... is valid
 * for retrieving or acting on another tenant's data, **even if guessed, reused,
 * or supplied out of context**". Everywhere else in this platform that claim is
 * honoured by the database: row-level security applies the tenant filter below
 * the application, so forgetting it fails closed. Object storage offers nothing
 * equivalent — a bucket is a flat keyspace and `GET /bucket/<key>` is `GET
 * /bucket/<key>` no matter who asks.
 *
 * So the isolation has to be structural in a different way: **there is no
 * operation on this port that takes a key**. `put` mints the identifier; it is
 * never supplied. `get`, `head`, and `delete` take an `ObjectRef`, which carries
 * the tenant that owns it, and they are reachable only through a
 * `TenantObjectStore` already bound to one tenant. A ref from another tenant is
 * refused by `assertOwnedBy` *before* any request leaves the process, so the
 * guarantee does not depend on the bucket being configured correctly, on the
 * credentials being narrowly scoped, or on the remote answering at all.
 *
 * This is application-layer enforcement, which §1 of IMPLEMENTATION_PLAN.md
 * rightly distrusts — but the objection there was that a `WHERE tenant_id = ?`
 * convention "fails open the first time someone forgets the clause". The
 * difference is that a clause can be forgotten and a *missing parameter* cannot:
 * there is no overload of `get` that omits the tenant, because the tenant is on
 * the handle. Object ids are also 128 random bits, so the enumeration attack the
 * spec's word "guessed" is aiming at has nothing to enumerate. Neither of those
 * is as strong as row-level security, and the honest mitigation is written down
 * in IMPLEMENTATION_PLAN.md: the authoritative index of which objects exist
 * belongs in PostgreSQL under RLS, and this port stores bytes.
 *
 * **2. A rejected upload leaves nothing behind.**
 * `business-knowledge-configuration.md` requires that the system "reject a
 * document upload that fails to process ... and tell the client the upload did
 * not succeed, **without silently discarding it**". The inverse failure is worse
 * and easier to write: an upload that is rejected to the client after the bytes
 * already landed leaves an orphan nobody will ever delete, including at
 * offboarding. Every rejection this port can make — size, content type, tenant —
 * is made before the write.
 *
 * **3. Deletion is complete and re-runnable.**
 * `client-offboarding-and-data-retention.md` requires that after deletion "no
 * configuration, conversation history, connection details, or documents are
 * recoverable". `deleteTenant` sweeps a prefix rather than a list, because a list
 * can be incomplete and a prefix cannot, and it is idempotent so a partial sweep
 * that failed halfway can simply be run again.
 *
 * **4. Nothing here can leak content into an operator's view.** Object bodies are
 * client documents and end-customer media. `operator-health-monitoring.md` AC9
 * forbids that content reaching operator diagnostics, so no error raised from
 * this package carries a body, a filename, or a remote server's prose — only the
 * opaque object id, the kind, and a status code.
 *
 * ## What is deliberately absent
 *
 * No display name, no original filename, no tags. Those are client-supplied text
 * that belongs in the tenant-scoped database row that indexes the object, where
 * RLS protects it and where the client's "list of configured knowledge" is
 * actually assembled. Putting them here would make the object store a second,
 * unprotected copy of the same content.
 *
 * No streaming. Bodies are buffered, bounded by `maxObjectBytes`. WhatsApp caps
 * inbound media well below that and knowledge documents are small; in exchange,
 * every write can be hashed before it is sent (so the remote verifies integrity
 * rather than trusting us) and the size rejection in (2) can happen before the
 * first byte moves. Revisit if the platform ever accepts large media.
 */

import { ValidationError } from '@zeddev/errors';
import { TenantAccessError } from '@zeddev/errors';
import { normalizeTenantId, type TenantId } from '@zeddev/tenancy';
import { randomBytes } from 'node:crypto';

/**
 * What an object is for.
 *
 * Part of the key, so it partitions a tenant's namespace: listing a tenant's
 * knowledge documents must not walk their inbound media, which is unbounded in a
 * way documents are not. It is also the coarse retention boundary — media may
 * eventually age out on a different schedule from documents, and a scheme where
 * that requires reading every object to find out which is which is a scheme that
 * will not be implemented.
 */
export const OBJECT_KINDS = ['knowledge_document', 'inbound_media'] as const;
export type ObjectKind = (typeof OBJECT_KINDS)[number];

/**
 * A handle to one stored object.
 *
 * Carries its owning tenant so that a ref which has travelled through a database
 * row, a queue payload, or an HTTP request still knows what it belongs to, and
 * can be refused when it turns up in the wrong context. A bare id could not be
 * refused, because there would be nothing to compare.
 */
export interface ObjectRef {
  readonly tenantId: TenantId;
  readonly kind: ObjectKind;
  /** Opaque, minted by `put`. 32 lowercase hex characters — 128 random bits. */
  readonly id: string;
}

/** What `list` can report. Deliberately narrow: see `ObjectMetadata` for why. */
export interface ObjectSummary {
  readonly ref: ObjectRef;
  readonly sizeBytes: number;
  readonly storedAt: Date;
}

/**
 * Everything known about a stored object without reading its body.
 *
 * `contentType` and `sha256` are absent from `ObjectSummary` because a listing
 * response does not carry user metadata — retrieving them costs one request per
 * object. Modelling that difference rather than papering over it keeps a caller
 * from writing a loop that looks like a listing and is in fact N round trips.
 */
export interface ObjectMetadata extends ObjectSummary {
  readonly contentType: string;
  /** Lowercase hex SHA-256 of the body, as computed when it was written. */
  readonly sha256: string;
}

export interface StoredObject extends ObjectMetadata {
  readonly body: Buffer;
}

export interface PutOptions {
  /**
   * Media type of the body.
   *
   * Required rather than defaulted. A document stored as
   * `application/octet-stream` because nobody passed anything is a document the
   * knowledge ingestion pipeline cannot route, and the failure surfaces far from
   * the upload that caused it.
   */
  readonly contentType: string;
}

/**
 * Object storage scoped to exactly one tenant.
 *
 * Every method that names an existing object takes an `ObjectRef` and refuses one
 * belonging to another tenant. There is intentionally no method that takes a key.
 */
export interface TenantObjectStore {
  readonly tenantId: TenantId;

  /** Store `body` and mint an identifier for it. Rejects before writing anything. */
  put(kind: ObjectKind, body: Buffer, options: PutOptions): Promise<ObjectMetadata>;

  /**
   * Read an object, verifying it against the checksum recorded when it was
   * written. A body that does not match raises rather than being returned: a
   * truncated knowledge document produces confidently wrong bot answers, which is
   * far more expensive to notice than an error.
   */
  get(ref: ObjectRef): Promise<StoredObject>;

  /** Metadata only. Raises `NotFoundError` if the object is absent. */
  head(ref: ObjectRef): Promise<ObjectMetadata>;

  /**
   * Remove an object. Idempotent — deleting an absent object succeeds.
   *
   * Idempotent because the callers are retry loops and offboarding sweeps.
   * "Already gone" is the outcome both of them wanted, and raising there would
   * mean a sweep that failed halfway cannot simply be run again.
   */
  delete(ref: ObjectRef): Promise<void>;

  /** Every object of `kind` this tenant owns, oldest key first. */
  list(kind: ObjectKind): Promise<readonly ObjectSummary[]>;
}

export interface ObjectStore {
  /** A handle bound to one tenant. The only route to any object. */
  forTenant(tenantId: string): TenantObjectStore;

  /**
   * Delete every object belonging to one tenant, returning how many were removed.
   *
   * Deliberately on the root store rather than the tenant handle, and deliberately
   * verbose to call: this is the irreversible half of
   * `client-offboarding-and-data-retention.md`, and every use of it should be
   * visible in a diff. Sweeps a prefix rather than a list so that an object whose
   * index row was already lost is still reached.
   */
  deleteTenant(tenantId: string): Promise<number>;

  /**
   * Fail fast if the configured bucket cannot be reached or written.
   *
   * `environment-portability.md` requires the system "fail with a clear,
   * diagnosable configuration error when required configuration for the target
   * environment is missing or invalid, rather than silently ... partially
   * starting". A bucket name typo is not detectable from configuration alone, so
   * this is the check that turns it into a startup failure instead of a failed
   * upload for the first client who tries one.
   */
  verifyAccess(): Promise<void>;

  close(): Promise<void>;
}

const OBJECT_ID_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Mint an object identifier.
 *
 * 128 bits from the CSPRNG, not a UUIDv4 and not a counter. A counter is
 * enumerable, which is exactly what `tenant-data-isolation.md`'s "even if
 * guessed" is about. A UUID would be fine cryptographically but carries hyphens
 * and a version nibble, and the flat hex form makes the key a pure `[0-9a-f]`
 * string — no percent-encoding question ever arises when it is signed into a
 * request URI.
 */
export function newObjectId(): string {
  return randomBytes(16).toString('hex');
}

/** Reject anything that is not a minted object id, before it becomes a key. */
export function assertObjectId(id: string): void {
  if (!OBJECT_ID_PATTERN.test(id)) {
    throw new ValidationError([{ key: 'objectId', reason: 'must be 32 lowercase hex characters' }]);
  }
}

function assertObjectKind(kind: string): asserts kind is ObjectKind {
  if (!(OBJECT_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError([
      { key: 'kind', reason: `must be one of ${OBJECT_KINDS.join(', ')}` },
    ]);
  }
}

/**
 * Refuse a ref that belongs to someone else.
 *
 * The single choke point for guarantee (1). It runs before any request is built,
 * so the refusal costs nothing and cannot be defeated by a permissive bucket
 * policy, an over-scoped credential, or a remote that answers a key it should
 * not. Both adapters call it; the conformance suite asserts both do.
 */
export function assertOwnedBy(boundTenantId: TenantId, ref: ObjectRef): void {
  const owner = normalizeTenantId(ref.tenantId);
  if (owner !== boundTenantId) {
    throw new TenantAccessError({
      boundTenantId,
      requestedTenantId: owner,
      resource: 'object',
    });
  }
  assertObjectKind(ref.kind);
  assertObjectId(ref.id);
}

/**
 * The key layout: `<prefix><tenantId>/<kind>/<id>`.
 *
 * Tenant first, and that ordering is the whole design. It makes offboarding a
 * single prefix sweep, it makes a tenant's objects contiguous so a listing does
 * not scan the bucket, and it leaves the door open to enforcing isolation a
 * second time in infrastructure — an IAM policy or a bucket policy conditioned on
 * `<tenantId>/*` is expressible against this layout and is not expressible
 * against a layout that puts kind or date first. That second enforcement is the
 * object-storage analogue of the "second database role" hardening already
 * recorded in IMPLEMENTATION_PLAN.md §4c, and this layout is what keeps it cheap.
 */
export function objectKey(prefix: string, ref: ObjectRef): string {
  const tenantId = normalizeTenantId(ref.tenantId);
  assertObjectKind(ref.kind);
  assertObjectId(ref.id);
  return `${prefix}${tenantId}/${ref.kind}/${ref.id}`;
}

/** The prefix covering everything one tenant owns — what `deleteTenant` sweeps. */
export function tenantPrefix(prefix: string, tenantId: string): string {
  return `${prefix}${normalizeTenantId(tenantId)}/`;
}

/** The prefix covering one kind for one tenant — what `list` walks. */
export function kindPrefix(prefix: string, tenantId: string, kind: ObjectKind): string {
  assertObjectKind(kind);
  return `${tenantPrefix(prefix, tenantId)}${kind}/`;
}

/**
 * Recover a ref from a key, or `undefined` if the key is not one of ours.
 *
 * `undefined` rather than a throw because the caller is a listing loop over a
 * bucket that may legitimately hold keys this platform did not write — a
 * hand-placed file, another application sharing the bucket on a small
 * deployment. Those must be skipped, not reported as data corruption, and above
 * all must not be deleted by a tenant sweep.
 */
export function parseObjectKey(prefix: string, key: string): ObjectRef | undefined {
  if (!key.startsWith(prefix)) return undefined;
  const parts = key.slice(prefix.length).split('/');
  if (parts.length !== 3) return undefined;
  const [tenantId, kind, id] = parts as [string, string, string];
  if (!OBJECT_ID_PATTERN.test(id)) return undefined;
  if (!(OBJECT_KINDS as readonly string[]).includes(kind)) return undefined;
  try {
    return { tenantId: normalizeTenantId(tenantId), kind: kind as ObjectKind, id };
  } catch {
    return undefined;
  }
}

/**
 * Render a ref as one string, for storage in a database column or a queue payload.
 *
 * A single column rather than three keeps the ref atomic: three columns can be
 * updated independently, and a row holding tenant A's id with tenant B's object
 * id is a row that would pass `assertOwnedBy` in tenant A's context.
 */
export function formatObjectRef(ref: ObjectRef): string {
  return objectKey('', ref);
}

/** Inverse of `formatObjectRef`. Raises rather than returning `undefined`: a ref read back from our own storage that does not parse is corruption, not foreign data. */
export function parseObjectRef(raw: string): ObjectRef {
  const ref = parseObjectKey('', raw);
  if (ref === undefined) {
    throw new ValidationError([{ key: 'objectRef', reason: 'is not a well-formed object reference' }]);
  }
  return ref;
}

/**
 * Media types are written into an HTTP header, so a newline in one is request
 * splitting — a client-supplied upload header becoming a second, forged request
 * to the storage backend. The grammar below is deliberately narrower than RFC
 * 9110's: a token, a slash, a token, and optional `; key=value` parameters.
 */
const CONTENT_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+(?:\s*;\s*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~"-]+)*$/;

export function assertContentType(contentType: string): void {
  if (contentType.length > 255 || !CONTENT_TYPE_PATTERN.test(contentType)) {
    throw new ValidationError([
      { key: 'contentType', reason: 'must be a media type such as application/pdf' },
    ]);
  }
}

/**
 * The default ceiling on one object, in bytes.
 *
 * 32 MiB: comfortably above WhatsApp's own inbound media limits and above any
 * plausible FAQ document, and low enough that buffering one in memory on the
 * smallest host in `environment-portability.md`'s three tiers is not the thing
 * that decides how much RAM the platform needs. Configurable because the tier
 * that can afford more is exactly the tier that is allowed to differ by
 * configuration alone.
 */
export const DEFAULT_MAX_OBJECT_BYTES = 32 * 1024 * 1024;

/**
 * Reject an oversized body before it is written.
 *
 * `business-knowledge-configuration.md` requires an unprocessable upload be
 * reported rather than silently discarded; rejecting *after* the write would
 * report it correctly and still leave the bytes behind, where no index row points
 * at them and no offboarding sweep is guaranteed to have a reason to look.
 */
export function assertWithinSizeLimit(sizeBytes: number, maxObjectBytes: number): void {
  if (sizeBytes > maxObjectBytes) {
    throw new ValidationError([
      { key: 'body', reason: `exceeds the maximum object size of ${maxObjectBytes} bytes` },
    ]);
  }
}
