/**
 * `@zeddev/storage` — the object storage port.
 *
 * Uploaded knowledge documents (`business-knowledge-configuration.md`) and
 * fetched WhatsApp media (`message-delivery-reliability.md`) are the two things
 * this platform holds that are not rows. They are held here.
 *
 * The port is deliberately narrow and deliberately does not take a key: see
 * `types.ts` for the four guarantees that shape it, chief among them that
 * `tenant-data-isolation.md`'s "even if guessed, reused, or supplied out of
 * context" has to be honoured without the row-level security that carries it
 * everywhere else in this system.
 *
 * `s3.ts` is the only adapter, because a laptop container, a VPS container, and a
 * managed cloud bucket all speak the same protocol and differ only in
 * `STORAGE_*` values — which is what `environment-portability.md` asks for.
 * `conformance.ts` is the single definition of the port's semantics and runs
 * against both that adapter and the in-memory fake.
 */

export { STORAGE_CONFIG_SCHEMA } from './config.ts';
export { createTransport, type Transport, type TransportRequest, type TransportResponse } from './http.ts';
export { ADDRESSING_STYLES, S3ObjectStore, type AddressingStyle, type S3ObjectStoreOptions } from './s3.ts';
export { mapS3Failure, parseListPage, type ListPage, type ListedKey } from './s3wire.ts';
export {
  EMPTY_PAYLOAD_SHA256,
  sha256Hex,
  signRequest,
  SIGNING_ALGORITHM,
  type SignableRequest,
  type SignedHeaders,
  type SigningContext,
  type SigningCredentials,
} from './sigv4.ts';
export {
  assertContentType,
  assertObjectId,
  assertOwnedBy,
  assertWithinSizeLimit,
  DEFAULT_MAX_OBJECT_BYTES,
  formatObjectRef,
  kindPrefix,
  newObjectId,
  objectKey,
  OBJECT_KINDS,
  parseObjectKey,
  parseObjectRef,
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
