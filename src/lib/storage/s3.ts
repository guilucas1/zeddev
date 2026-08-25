/**
 * The S3-compatible adapter — the real one.
 *
 * "S3-compatible" rather than "S3" is the load-bearing word.
 * `environment-portability.md` requires the same artifact run on a laptop, a
 * low-cost VPS, and a managed cloud provider, differing only by configuration,
 * and `cost-efficient-operation.md` forbids infrastructure that exists merely to
 * be there. A container on the laptop, the same container on the VPS, and a
 * managed bucket in the cloud all speak this protocol, so all three are the same
 * adapter reached through different values of `STORAGE_ENDPOINT_HOST`. There is
 * no second adapter and no branch — which is the point, since a branch on which
 * tier is running is exactly what AC5 forbids.
 *
 * ## Addressing style is configuration, not detection
 *
 * The one genuine protocol difference between a self-hosted endpoint and a
 * managed one is how the bucket is addressed: in the path (`/bucket/key`) or in
 * the hostname (`bucket.host/key`). It would be easy and wrong to detect this —
 * "if the host is an IP address, use path style" is environment detection wearing
 * a disguise. It is `STORAGE_ADDRESSING_STYLE` instead.
 *
 * ## What integrity means here
 *
 * Every write sends `x-amz-content-sha256`, so the remote verifies the bytes it
 * received against the bytes we sent and rejects a truncated upload rather than
 * storing it. The same digest is stored as user metadata and re-checked on read,
 * which closes the other half: a body that changed at rest, or a response
 * assembled from the wrong object, fails loudly instead of becoming a knowledge
 * document the bot answers from. `business-knowledge-configuration.md` requires
 * an upload that cannot be processed be *reported*, and silent corruption is the
 * one failure mode that reports nothing.
 */

import { InternalError, isRetryable, toDiagnostic } from '@zeddev/errors';
import type { Logger } from '@zeddev/logging';
import type { Secret } from '@zeddev/secrets';
import { normalizeTenantId, type TenantId } from '@zeddev/tenancy';
import { exponentialBackoff, SystemClock, type Backoff, type Clock } from '@zeddev/time';
import { createTransport, type Transport, type TransportResponse } from './http.ts';
import { mapS3Failure, parseListPage } from './s3wire.ts';
import {
  canonicalQuery,
  EMPTY_PAYLOAD_SHA256,
  sha256Hex,
  signRequest,
  type SigningCredentials,
} from './sigv4.ts';
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

export const ADDRESSING_STYLES = ['path', 'virtual-host'] as const;
export type AddressingStyle = (typeof ADDRESSING_STYLES)[number];

/** Where the body's digest is kept so a read can be checked against it. */
const SHA256_METADATA_HEADER = 'x-amz-meta-content-sha256';

export interface S3ObjectStoreOptions {
  readonly host: string;
  readonly port?: number | undefined;
  readonly tls: boolean;
  readonly bucket: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret<string>;
  readonly sessionToken?: Secret<string> | undefined;
  readonly addressingStyle?: AddressingStyle | undefined;
  /** Prepended to every key. Lets one bucket carry more than one deployment. */
  readonly keyPrefix?: string | undefined;
  readonly requestTimeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly maxObjectBytes?: number | undefined;
  readonly maxSockets?: number | undefined;
  /**
   * How many keys one listing request returns.
   *
   * Exposed only so the conformance suite can set it low enough to force
   * pagination. An untested continuation-token loop is a `deleteTenant` that
   * works until a tenant crosses the page boundary and then silently stops
   * short — which would break a promise
   * `client-offboarding-and-data-retention.md` describes as irreversible.
   */
  readonly listPageSize?: number | undefined;
  readonly backoff?: Backoff | undefined;
  readonly clock?: Clock | undefined;
  readonly logger?: Logger | undefined;
  /** Injected in tests to provoke failures a real server will not produce on demand. */
  readonly transport?: Transport | undefined;
}

interface S3Request {
  readonly method: string;
  readonly key?: string | undefined;
  readonly query?: readonly (readonly [string, string])[] | undefined;
  readonly body?: Buffer | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly operation: string;
  readonly objectId?: string | undefined;
  /** Statuses that are an outcome rather than a failure — 404 on a HEAD, say. */
  readonly tolerate?: readonly number[] | undefined;
}

export class S3ObjectStore implements ObjectStore {
  readonly #options: S3ObjectStoreOptions;
  readonly #transport: Transport;
  readonly #ownTransport: { close(): void } | undefined;
  readonly #clock: Clock;
  readonly #backoff: Backoff;
  readonly #maxAttempts: number;
  readonly #prefix: string;
  readonly #addressingStyle: AddressingStyle;
  readonly #logger: Logger | undefined;

  constructor(options: S3ObjectStoreOptions) {
    this.#options = options;
    if (options.transport === undefined) {
      const owned = createTransport({ maxSockets: options.maxSockets ?? 16 });
      this.#transport = owned;
      this.#ownTransport = owned;
    } else {
      this.#transport = options.transport;
      this.#ownTransport = undefined;
    }
    this.#clock = options.clock ?? new SystemClock();
    // A tighter curve than the queue's: this retry happens inside a request a
    // client may be waiting on, so the ceiling is seconds rather than minutes.
    // A failure that outlives it becomes the queue's problem, where the long
    // curve lives.
    this.#backoff = options.backoff ?? exponentialBackoff({ baseMs: 100, maxMs: 2000 });
    this.#maxAttempts = options.maxAttempts ?? 4;
    this.#prefix = options.keyPrefix ?? '';
    this.#addressingStyle = options.addressingStyle ?? 'path';
    this.#logger = options.logger;
  }

  forTenant(tenantId: string): TenantObjectStore {
    return new S3TenantObjectStore(this, normalizeTenantId(tenantId));
  }

  async deleteTenant(tenantId: string): Promise<number> {
    const prefix = tenantPrefix(this.#prefix, tenantId);
    let removed = 0;
    for await (const listed of this.#walk(prefix)) {
      // Parsed rather than deleted blind. A bucket may hold keys this platform
      // did not write — another application sharing it on a small deployment —
      // and a prefix sweep that deletes whatever it finds would take those with
      // it. `parseObjectKey` returning undefined is the guard.
      const ref = parseObjectKey(this.#prefix, listed.key);
      if (ref === undefined) continue;
      await this.request({
        method: 'DELETE',
        key: listed.key,
        operation: 'delete',
        objectId: ref.id,
        tolerate: [404],
      });
      removed += 1;
    }
    this.#logger?.info('storage.tenant.purged', {
      tenantId: normalizeTenantId(tenantId),
      bucket: this.#options.bucket,
      count: removed,
    });
    return removed;
  }

  async verifyAccess(): Promise<void> {
    // A *listing* rather than a HEAD on the bucket, and the reason is not
    // obvious enough to leave unwritten: an HTTP HEAD response carries no body
    // by definition, so S3's `<Error><Code>` document — the only thing that
    // distinguishes "no such bucket" from "wrong credential" from "denied" —
    // does not arrive. A HEAD-based preflight can therefore report only a bare
    // status, which turns every startup misconfiguration into the same
    // undiagnosable 403 and defeats the whole point of the check under
    // `environment-portability.md`.
    //
    // Listing one key costs the same round trip and proves more: that the
    // endpoint is reachable, that the credential verifies, that the bucket
    // exists, and that this identity may actually read it.
    await this.request({
      method: 'GET',
      query: [
        ['list-type', '2'],
        ['max-keys', '1'],
      ],
      operation: 'verify_access',
    });
  }

  async close(): Promise<void> {
    this.#ownTransport?.close();
  }

  /**
   * Create the bucket if it is absent.
   *
   * Explicit, never implicit on first write. Auto-creating on demand turns a
   * typo in `STORAGE_BUCKET` into a silently-created empty bucket that the
   * platform then happily writes a tenant's documents into — a data-loss shape
   * that looks exactly like success. Callers are the local development flow and
   * the test fixture; a managed cloud bucket is provisioned outside this code.
   */
  async ensureBucket(): Promise<void> {
    const head = await this.request({ method: 'HEAD', operation: 'head_bucket', tolerate: [404] });
    if (head.status === 404) {
      await this.request({ method: 'PUT', operation: 'create_bucket', tolerate: [409] });
    }
  }

  get maxObjectBytes(): number {
    return this.#options.maxObjectBytes ?? DEFAULT_MAX_OBJECT_BYTES;
  }

  get keyPrefix(): string {
    return this.#prefix;
  }

  /** One request, with retries, mapped onto the taxonomy. */
  async request(spec: S3Request): Promise<TransportResponse> {
    const tolerate = spec.tolerate ?? [];
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        const response = await this.#send(spec);
        if (response.status < 300 || tolerate.includes(response.status)) return response;
        throw mapS3Failure(response, { operation: spec.operation, objectId: spec.objectId });
      } catch (error) {
        lastError = error;
        // Retryability is read off the error's type, never re-derived from the
        // status here. That invariant is what lets a credential failure stop on
        // attempt one while a `SlowDown` uses the whole allowance.
        if (!isRetryable(error) || attempt === this.#maxAttempts) throw error;
        const diagnostic = toDiagnostic(error);
        const advised = diagnostic.context['retryAfterMs'];
        const delayMs =
          typeof advised === 'number' && advised > 0 ? advised : this.#backoff(attempt);
        this.#logger?.warn('storage.request.retrying', {
          bucket: this.#options.bucket,
          action: spec.operation,
          attempt,
          retryAfterMs: delayMs,
          errorCode: diagnostic.code,
          ...(spec.objectId === undefined ? {} : { objectId: spec.objectId }),
        });
        await this.#clock.sleep(delayMs);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new InternalError('Object storage request failed', { code: 'storage.unknown' });
  }

  async #send(spec: S3Request): Promise<TransportResponse> {
    const { url, path } = this.#address(spec.key, spec.query);
    const payloadSha256 = spec.body === undefined ? EMPTY_PAYLOAD_SHA256 : sha256Hex(spec.body);
    const credentials: SigningCredentials = {
      accessKeyId: this.#options.accessKeyId,
      secretAccessKey: this.#options.secretAccessKey,
      ...(this.#options.sessionToken === undefined
        ? {}
        : { sessionToken: this.#options.sessionToken }),
    };
    const headers: Record<string, string> = {
      host: url.port === '' ? url.hostname : `${url.hostname}:${url.port}`,
      ...spec.headers,
    };
    // Signed, because an unsigned Content-Length is a length an intermediary can
    // change. Always present, including at zero, so the remote never has to guess
    // whether a body is coming.
    if (spec.method !== 'GET' && spec.method !== 'HEAD') {
      headers['content-length'] = String(spec.body?.length ?? 0);
    }

    const signed = signRequest(
      {
        credentials,
        region: this.#options.region,
        service: 's3',
        signedAt: this.#clock.now(),
      },
      {
        method: spec.method,
        path,
        query: spec.query ?? [],
        headers,
        payloadSha256,
      },
    );

    return this.#transport({
      method: spec.method,
      url,
      headers: signed.headers,
      ...(spec.body === undefined ? {} : { body: spec.body }),
      timeoutMs: this.#options.requestTimeoutMs ?? 30_000,
    });
  }

  /**
   * Build the URL and the *unencoded* path to sign.
   *
   * Both are returned because they must agree and are produced differently: the
   * URL needs the path already encoded, while the signer encodes it itself. Deriving
   * one from the other by decoding is the shape of bug that makes a key
   * containing a `%` unreachable.
   */
  #address(
    key: string | undefined,
    query: readonly (readonly [string, string])[] | undefined,
  ): { url: URL; path: string } {
    const scheme = this.#options.tls ? 'https' : 'http';
    const authority =
      this.#addressingStyle === 'virtual-host'
        ? `${this.#options.bucket}.${this.#options.host}`
        : this.#options.host;
    const port = this.#options.port === undefined ? '' : `:${this.#options.port}`;
    const path =
      this.#addressingStyle === 'virtual-host'
        ? `/${key ?? ''}`
        : `/${this.#options.bucket}${key === undefined ? '' : `/${key}`}`;

    const url = new URL(`${scheme}://${authority}${port}`);
    url.pathname = path;
    // The query string is written with the signer's own encoder rather than
    // `URLSearchParams`, which is not the same function: it renders a space as
    // `+` where SigV4 requires `%20`. Sending one form and signing another is a
    // 403 that appears only for the values that happen to contain the character
    // — here, a continuation token — which is to say, only once a tenant has
    // enough objects to paginate.
    if (query !== undefined && query.length > 0) url.search = canonicalQuery(query);
    return { url, path };
  }

  /** Every key under `prefix`, following continuation tokens to the end. */
  async *#walk(prefix: string): AsyncGenerator<{ key: string; sizeBytes: number; lastModified: Date }> {
    let token: string | undefined;
    do {
      const query: (readonly [string, string])[] = [
        ['list-type', '2'],
        ['prefix', prefix],
        ['max-keys', String(this.#options.listPageSize ?? 1000)],
      ];
      if (token !== undefined) query.push(['continuation-token', token]);
      const response = await this.request({ method: 'GET', query, operation: 'list' });
      const page = parseListPage(response.body.toString('utf8'));
      for (const listed of page.keys) yield listed;
      token = page.nextContinuationToken;
    } while (token !== undefined);
  }

  async listUnder(prefix: string): Promise<ObjectSummary[]> {
    const out: ObjectSummary[] = [];
    for await (const listed of this.#walk(prefix)) {
      const ref = parseObjectKey(this.#prefix, listed.key);
      if (ref === undefined) continue;
      out.push({ ref, sizeBytes: listed.sizeBytes, storedAt: listed.lastModified });
    }
    return out;
  }
}

class S3TenantObjectStore implements TenantObjectStore {
  readonly #store: S3ObjectStore;
  readonly tenantId: TenantId;

  constructor(store: S3ObjectStore, tenantId: TenantId) {
    this.#store = store;
    this.tenantId = tenantId;
  }

  async put(kind: ObjectKind, body: Buffer, options: PutOptions): Promise<ObjectMetadata> {
    // Every rejection this method can make happens here, before a byte moves.
    assertContentType(options.contentType);
    assertWithinSizeLimit(body.length, this.#store.maxObjectBytes);

    const ref: ObjectRef = { tenantId: this.tenantId, kind, id: newObjectId() };
    const sha256 = sha256Hex(body);
    const key = objectKey(this.#store.keyPrefix, ref);

    await this.#store.request({
      method: 'PUT',
      key,
      body,
      headers: { 'content-type': options.contentType, [SHA256_METADATA_HEADER]: sha256 },
      operation: 'put',
      objectId: ref.id,
    });

    return {
      ref,
      contentType: options.contentType,
      sizeBytes: body.length,
      sha256,
      storedAt: new Date(),
    };
  }

  async get(ref: ObjectRef): Promise<StoredObject> {
    assertOwnedBy(this.tenantId, ref);
    const response = await this.#store.request({
      method: 'GET',
      key: objectKey(this.#store.keyPrefix, ref),
      operation: 'get',
      objectId: ref.id,
    });

    const recorded = response.headers[SHA256_METADATA_HEADER];
    const actual = sha256Hex(response.body);
    if (recorded !== undefined && recorded !== actual) {
      // Loud, not silent. A knowledge document that lost bytes produces bot
      // answers that are wrong rather than absent, and nothing downstream can
      // tell the difference. No content in the diagnostic — only the opaque id.
      throw new InternalError('Stored object failed its integrity check', {
        code: 'storage.checksum_mismatch',
        context: { objectId: ref.id, tenantId: this.tenantId, bytes: response.body.length },
      });
    }

    return {
      ref,
      body: response.body,
      contentType: response.headers['content-type'] ?? 'application/octet-stream',
      sizeBytes: response.body.length,
      sha256: actual,
      storedAt: parseDate(response.headers['last-modified']),
    };
  }

  async head(ref: ObjectRef): Promise<ObjectMetadata> {
    assertOwnedBy(this.tenantId, ref);
    const response = await this.#store.request({
      method: 'HEAD',
      key: objectKey(this.#store.keyPrefix, ref),
      operation: 'head',
      objectId: ref.id,
    });
    const sha256 = response.headers[SHA256_METADATA_HEADER];
    if (sha256 === undefined) {
      throw new InternalError('Stored object is missing its recorded digest', {
        code: 'storage.missing_digest',
        context: { objectId: ref.id, tenantId: this.tenantId },
      });
    }
    return {
      ref,
      contentType: response.headers['content-type'] ?? 'application/octet-stream',
      sizeBytes: Number(response.headers['content-length'] ?? '0'),
      sha256,
      storedAt: parseDate(response.headers['last-modified']),
    };
  }

  async delete(ref: ObjectRef): Promise<void> {
    assertOwnedBy(this.tenantId, ref);
    await this.#store.request({
      method: 'DELETE',
      key: objectKey(this.#store.keyPrefix, ref),
      operation: 'delete',
      objectId: ref.id,
      tolerate: [404],
    });
  }

  async list(kind: ObjectKind): Promise<readonly ObjectSummary[]> {
    const listed = await this.#store.listUnder(kindPrefix(this.#store.keyPrefix, this.tenantId, kind));
    // Belt and braces: the prefix already scopes this to one tenant, but a
    // listing is the one place a remote's answer decides what a caller sees, and
    // a bucket-side misconfiguration returning a wider result must not surface
    // as another tenant's objects. Filtering costs nothing and removes the
    // dependency on the remote getting the prefix right.
    return listed.filter((summary) => summary.ref.tenantId === this.tenantId);
  }
}

function parseDate(raw: string | undefined): Date {
  if (raw === undefined) return new Date(0);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}
