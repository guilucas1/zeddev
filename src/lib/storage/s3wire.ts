/**
 * Reading S3's responses: the two XML documents that matter, and the mapping of
 * failures onto the error taxonomy.
 *
 * ## Why a hand-written XML reader
 *
 * The same reason there is no HTTP client dependency, but with a sharper edge:
 * a general XML parser is a large attack surface (entity expansion, external
 * entities, namespace handling) pointed at a response from a network peer, and
 * none of that generality is needed. Exactly two documents are ever parsed —
 * `ListBucketResult` and `Error` — both flat, both defined by S3, both stable for
 * two decades. The reader below understands elements and the five predefined
 * entities and nothing else; it has no notion of a DOCTYPE, so there is no
 * expansion to bound.
 *
 * ## Why the remote's prose is dropped
 *
 * This is the §4c lesson from `@zeddev/db` applied a second time. PostgreSQL
 * quotes row data in its error text; S3 quotes the *key* in its `<Message>`, and
 * a key contains a tenant id. Under `operator-health-monitoring.md` AC9 and
 * `credential-and-secret-handling.md` none of that may reach an operator-visible
 * diagnostic, and — as §4c puts it — the prose has to be dropped at this
 * boundary rather than further downstream, because downstream is where someone
 * eventually logs it. So the mapper reads `<Code>` and the HTTP status, and the
 * message on the error it raises is written here, from those alone.
 */

import {
  AuthorizationError,
  ConfigurationError,
  ConflictError,
  DefectError,
  InternalError,
  NotFoundError,
  TerminalTransportError,
  TransientTransportError,
  ValidationError,
  type ZedError,
} from '@zeddev/errors';
import type { TransportResponse } from './http.ts';

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }
    if (body.startsWith('#')) return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    return ENTITIES[body] ?? whole;
  });
}

/**
 * The text of the first `<name>` element, or `undefined`.
 *
 * Scoped to a substring by the caller when the element name is ambiguous —
 * `<Key>` appears inside every `<Contents>` — rather than by building a tree,
 * because a tree is the part that would need the generality this avoids.
 */
export function elementText(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(xml);
  return match === null ? undefined : decodeEntities(match[1] ?? '');
}

/** Every `<name>...</name>` block, as raw inner XML. */
export function elementBlocks(xml: string, name: string): string[] {
  const pattern = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'g');
  const blocks: string[] = [];
  for (let match = pattern.exec(xml); match !== null; match = pattern.exec(xml)) {
    blocks.push(match[1] ?? '');
  }
  return blocks;
}

export interface ListedKey {
  readonly key: string;
  readonly sizeBytes: number;
  readonly lastModified: Date;
}

export interface ListPage {
  readonly keys: readonly ListedKey[];
  readonly nextContinuationToken: string | undefined;
}

export function parseListPage(xml: string): ListPage {
  const keys: ListedKey[] = [];
  for (const block of elementBlocks(xml, 'Contents')) {
    const key = elementText(block, 'Key');
    if (key === undefined) continue;
    keys.push({
      key,
      sizeBytes: Number(elementText(block, 'Size') ?? '0'),
      lastModified: new Date(elementText(block, 'LastModified') ?? 0),
    });
  }
  // `IsTruncated` is checked as well as the token's presence: a server that
  // reports truncation without a token would otherwise end the loop silently,
  // and a silent short listing is a `deleteTenant` that reports success while
  // leaving objects behind.
  const truncated = elementText(xml, 'IsTruncated') === 'true';
  const token = elementText(xml, 'NextContinuationToken');
  if (truncated && (token === undefined || token === '')) {
    throw new InternalError('Object storage reported a truncated listing with no continuation token', {
      code: 'storage.listing_truncated_without_token',
    });
  }
  return { keys, nextContinuationToken: truncated ? token : undefined };
}

/** The `<Code>` of an error document, or `undefined` for a body that is not one. */
export function parseErrorCode(body: Buffer): string | undefined {
  if (body.length === 0) return undefined;
  const code = elementText(body.toString('utf8'), 'Code');
  return code === undefined || code === '' ? undefined : code;
}

/** Credential-shaped failures. Retrying these forever is how a typo becomes an outage. */
const CREDENTIAL_CODES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidSecurity',
  'InvalidToken',
  'ExpiredToken',
]);

const THROTTLE_CODES = new Set(['SlowDown', 'RequestLimitExceeded', 'Throttling', 'TooManyRequests']);

function retryAfterMs(response: TransportResponse): number | undefined {
  const raw = response.headers['retry-after'];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export interface FailureContext {
  /** Opaque object id, safe to carry. Never a key, which contains a tenant id. */
  readonly objectId?: string | undefined;
  readonly operation: string;
}

/**
 * Map an unsuccessful response onto the taxonomy.
 *
 * Retryability is decided here by *class of failure*, and then never re-derived:
 * `fail()` in the queue and `withRetries()` in the adapter both read
 * `retryable` off the error, which is the invariant IMPLEMENTATION_PLAN.md §4c
 * introduced and §4d cashed in. A `SignatureDoesNotMatch` will fail identically
 * on every attempt, so spending the allowance to rediscover that only delays a
 * diagnosable configuration error reaching a human.
 */
export function mapS3Failure(response: TransportResponse, context: FailureContext): ZedError {
  const code = parseErrorCode(response.body);
  const status = response.status;
  const scalars = {
    statusCode: status,
    errorCode: code ?? null,
    action: context.operation,
    ...(context.objectId === undefined ? {} : { objectId: context.objectId }),
  };

  if (status === 404) {
    if (code === 'NoSuchBucket') {
      return new ConfigurationError([
        { key: 'STORAGE_BUCKET', reason: 'names a bucket that does not exist on the configured endpoint' },
      ]);
    }
    return new NotFoundError('object', { context: scalars });
  }

  if (code !== undefined && CREDENTIAL_CODES.has(code)) {
    return new ConfigurationError([
      {
        key: 'STORAGE_ACCESS_KEY_ID',
        reason: `rejected by the object storage endpoint (${code})`,
      },
      {
        key: 'STORAGE_SECRET_ACCESS_KEY',
        reason: `rejected by the object storage endpoint (${code})`,
      },
    ]);
  }

  if (status === 403) {
    if (code === 'RequestTimeTooSkewed') {
      // Not retryable and not configuration: the host clock is wrong, and no
      // value in the environment file will fix it. Naming it precisely is the
      // whole value here, because the symptom otherwise reads as bad credentials.
      return new TerminalTransportError('The host clock is too far from the object storage endpoint’s', {
        code: 'storage.request_time_too_skewed',
        context: scalars,
      });
    }
    return new AuthorizationError({ principal: 'storage-client', action: context.operation });
  }

  if (status === 429 || (code !== undefined && THROTTLE_CODES.has(code))) {
    const after = retryAfterMs(response);
    return new TransientTransportError('Object storage is throttling requests', {
      code: 'storage.throttled',
      context: scalars,
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }

  if (status >= 500) {
    const after = retryAfterMs(response);
    return new TransientTransportError('Object storage failed transiently', {
      code: `storage.${status}`,
      context: scalars,
      ...(after === undefined ? {} : { retryAfterMs: after }),
    });
  }

  if (status === 409 || status === 412) {
    return new ConflictError('Object storage rejected the request as conflicting', {
      code: `storage.${status}`,
      context: scalars,
    });
  }

  if (code === 'EntityTooLarge' || code === 'MaxMessageLengthExceeded') {
    return new ValidationError([
      { key: 'body', reason: 'exceeds the maximum object size the storage endpoint accepts' },
    ]);
  }

  if (status === 400) {
    // A 400 means this client built a request the remote could not parse. That
    // is a defect here, not a condition of the environment, and marking it
    // non-retryable is what stops it being rediscovered several times per upload.
    return new DefectError('Object storage rejected a malformed request', {
      code: `storage.${status}`,
      context: scalars,
    });
  }

  return new TerminalTransportError('Object storage rejected the request', {
    code: `storage.${status}`,
    context: scalars,
  });
}
