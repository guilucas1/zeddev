/**
 * AWS Signature Version 4, hand-written.
 *
 * Same reasoning as `@zeddev/db`'s hand-written PostgreSQL client, recorded in
 * IMPLEMENTATION_PLAN.md §1: every dependency is a supply-chain and maintenance
 * cost carried by a platform whose premise is near-zero fixed cost, and the
 * needed subset here is small and closed. SigV4 is a published, versioned,
 * frozen algorithm — the "v4" is in its name — and the AWS SDK that implements
 * it is, at the time of writing, several hundred packages.
 *
 * The obvious objection is that a hand-written signer is where subtle bugs live.
 * Two things answer it, and they are different in kind:
 *
 *   - The algorithm has **published test vectors**. `sigv4.test.ts` asserts the
 *     canonical request, the string to sign, and the final signature against
 *     AWS's own documented worked example, byte for byte. That is an external
 *     oracle, not a self-consistency check, which is the thing a hand-written
 *     crypto routine most needs and most rarely has.
 *   - Every request the adapter makes is verified by a **real** S3-compatible
 *     server in `s3.test.ts`. A signer that is subtly wrong does not return
 *     subtly wrong data; it returns 403. There is no fake server in this package,
 *     for the same reason there is no fake PostgreSQL in `@zeddev/db`.
 *
 * ## What is not implemented
 *
 * Chunked (`STREAMING-AWS4-HMAC-SHA256-PAYLOAD`) signing, because bodies are
 * buffered — see `types.ts` for why. Presigned URLs, because nothing in the specs
 * asks an end customer or a browser to fetch an object directly; if the client
 * dashboard ever serves a document download, it proxies it, which keeps the
 * tenant check on the path. `UNSIGNED-PAYLOAD` is deliberately never used: the
 * payload hash is what makes the remote verify the body it received against the
 * body we sent, and dropping it would move integrity from "checked" to "assumed".
 */

import { createHash, createHmac } from 'node:crypto';
import type { Secret } from '@zeddev/secrets';

export const SIGNING_ALGORITHM = 'AWS4-HMAC-SHA256';

export interface SigningCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: Secret<string>;
  /** Present only for temporary credentials issued by an STS-style provider. */
  readonly sessionToken?: Secret<string> | undefined;
}

export interface SignableRequest {
  readonly method: string;
  /** Path, already split into unencoded segments. See `canonicalUri`. */
  readonly path: string;
  /** Query parameters as supplied; sorted and encoded here. */
  readonly query: readonly (readonly [string, string])[];
  /** Headers to sign. `host` must be among them; `x-amz-*` are added by `signRequest`. */
  readonly headers: Readonly<Record<string, string>>;
  /** Lowercase hex SHA-256 of the body, or of the empty string for a bodiless request. */
  readonly payloadSha256: string;
}

export interface SigningContext {
  readonly credentials: SigningCredentials;
  readonly region: string;
  readonly service: string;
  /** The instant the request is signed. AWS rejects a skew beyond ±15 minutes. */
  readonly signedAt: Date;
}

/** SHA-256 of the empty string. The payload hash for every bodiless request. */
export const EMPTY_PAYLOAD_SHA256 = createHash('sha256').update('').digest('hex');

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Percent-encoding per SigV4's rules, which are *not* `encodeURIComponent`'s.
 *
 * Three differences, each of which silently produces a 403 rather than an error:
 * `!`, `'`, `(`, `)`, and `*` must be encoded (`encodeURIComponent` leaves them);
 * hex digits must be uppercase; and a space is `%20`, never `+`. The unreserved
 * set below is the one the specification names — `A-Z a-z 0-9 - . _ ~` — and
 * everything else goes through, including UTF-8 multibyte sequences, one encoded
 * byte at a time.
 */
export function uriEncode(value: string, encodeSlash: boolean): string {
  const bytes = Buffer.from(value, 'utf8');
  let out = '';
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39) ||
      char === '-' ||
      char === '.' ||
      char === '_' ||
      char === '~'
    ) {
      out += char;
    } else if (char === '/' && !encodeSlash) {
      out += '/';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/**
 * The canonical URI: every path segment encoded, separators left alone.
 *
 * S3 is the exception to AWS's general rule of double-encoding the path — for S3
 * the path is encoded exactly once. Since this signer serves only S3-compatible
 * endpoints, single encoding is what it does, and that is worth stating because
 * a signer copied from a non-S3 context is the classic source of this bug.
 */
export function canonicalUri(path: string): string {
  if (path === '') return '/';
  return uriEncode(path, false);
}

/**
 * The canonical query string: encoded, then sorted by encoded key then value.
 *
 * Sorting after encoding, not before. The two orders differ whenever a character
 * sorts differently from its percent-escape, and the remote sorts after.
 */
export function canonicalQuery(query: readonly (readonly [string, string])[]): string {
  return query
    .map(([key, value]) => [uriEncode(key, true), uriEncode(value, true)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

interface CanonicalHeaders {
  readonly canonical: string;
  readonly signed: string;
}

/**
 * Header names lowercased and sorted, values trimmed and inner runs of
 * whitespace collapsed.
 *
 * The collapsing matters: a value that arrives with two spaces is transmitted
 * with two spaces but signed with one unless it is normalised, and the remote
 * normalises. This is the second-most common SigV4 bug after the encoding rules
 * above, and it only shows up for values a human typed — such as a media type
 * with a space after its semicolon.
 */
export function canonicalHeaders(headers: Readonly<Record<string, string>>): CanonicalHeaders {
  const entries = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return {
    canonical: entries.map(([name, value]) => `${name}:${value}\n`).join(''),
    signed: entries.map(([name]) => name).join(';'),
  };
}

export function canonicalRequest(request: SignableRequest): string {
  const { canonical, signed } = canonicalHeaders(request.headers);
  return [
    request.method.toUpperCase(),
    canonicalUri(request.path),
    canonicalQuery(request.query),
    canonical,
    signed,
    request.payloadSha256,
  ].join('\n');
}

/** `YYYYMMDDTHHMMSSZ`, which is an ISO instant with the separators removed. */
export function amzDate(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function credentialScope(at: Date, region: string, service: string): string {
  return `${amzDate(at).slice(0, 8)}/${region}/${service}/aws4_request`;
}

export function stringToSign(context: SigningContext, canonical: string): string {
  return [
    SIGNING_ALGORITHM,
    amzDate(context.signedAt),
    credentialScope(context.signedAt, context.region, context.service),
    sha256Hex(canonical),
  ].join('\n');
}

/**
 * The signing key: four chained HMACs, narrowing the secret to one date, one
 * region, one service.
 *
 * The narrowing is the point — a derived key that leaked would be useless
 * tomorrow, in another region, or against another service. Not cached here even
 * though it is stable for a day, because caching it means holding derived key
 * material in a long-lived object for the sake of four HMACs of a few dozen
 * bytes each, which is not a trade worth making.
 */
export function signingKey(secretAccessKey: string, at: Date, region: string, service: string): Buffer {
  const dateKey = hmac(Buffer.from(`AWS4${secretAccessKey}`, 'utf8'), amzDate(at).slice(0, 8));
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, 'aws4_request');
}

export interface SignedHeaders {
  readonly headers: Readonly<Record<string, string>>;
  /** Exposed for the test vectors; nothing in the adapter reads it. */
  readonly signature: string;
}

/**
 * Sign a request, returning the complete set of headers to send.
 *
 * `x-amz-content-sha256` and `x-amz-date` are added here rather than by the
 * caller, and are therefore always signed. A caller that could add them would be
 * a caller that could forget to, and an unsigned `x-amz-date` is a request whose
 * replay window is set by whoever intercepts it.
 */
export function signRequest(context: SigningContext, request: SignableRequest): SignedHeaders {
  const timestamp = amzDate(context.signedAt);
  const headers: Record<string, string> = {
    ...request.headers,
    'x-amz-date': timestamp,
    'x-amz-content-sha256': request.payloadSha256,
  };
  if (context.credentials.sessionToken !== undefined) {
    headers['x-amz-security-token'] = context.credentials.sessionToken.expose();
  }

  const canonical = canonicalRequest({ ...request, headers });
  const { signed } = canonicalHeaders(headers);
  const key = signingKey(
    context.credentials.secretAccessKey.expose(),
    context.signedAt,
    context.region,
    context.service,
  );
  const signature = hmac(key, stringToSign(context, canonical)).toString('hex');
  const scope = credentialScope(context.signedAt, context.region, context.service);

  return {
    headers: {
      ...headers,
      authorization:
        `${SIGNING_ALGORITHM} Credential=${context.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signed}, Signature=${signature}`,
    },
    signature,
  };
}
