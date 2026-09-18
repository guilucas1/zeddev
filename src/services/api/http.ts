/**
 * HTTP primitives: reading a request, shaping a reply, and turning the error
 * taxonomy into status codes.
 *
 * Hand-written over `node:http` rather than taken from a framework, for the reason
 * IMPLEMENTATION_PLAN.md §1 gives for every other dependency this platform
 * declined: the needed subset is small and closed — exact-match routes, one JSON
 * body type, cookies — and a framework is a supply-chain and upgrade cost carried
 * against a near-zero-fixed-cost premise.
 *
 * The one piece of real policy here is `toReply`. It is where the errors
 * `@zeddev/identity` raises become what a caller is allowed to see, so it is where
 * `authentication-and-access.md` AC3 and AC9 either hold or quietly stop holding:
 * an `AuthenticationError` must produce the same bytes whatever caused it, and an
 * unclassified failure must produce nothing but a code and a request id.
 */

import type { IncomingMessage } from 'node:http';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  TransientTransportError,
  ValidationError,
} from '@zeddev/errors';

/** A reply, as data. Handlers return these rather than writing to the socket, so they are testable as values. */
export interface Reply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly cookies?: readonly string[];
}

/**
 * A failure that belongs to the transport rather than to the domain.
 *
 * Deliberately not a `ZedError`. The taxonomy in `@zeddev/errors` is closed
 * because each kind is a branch some spec-mandated behaviour keys off; "the body
 * was not JSON" and "wrong method" are HTTP facts that nothing outside this
 * service ever branches on, and adding them there would widen a vocabulary every
 * other package must then consider.
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly headers: Readonly<Record<string, string>>;

  constructor(status: number, code: string, headers: Readonly<Record<string, string>> = {}) {
    super(code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * Map any thrown value to what the caller may see.
 *
 * Note what never reaches the body: an error's `message`, for every class except
 * `ConflictError`. Messages are free text and accumulate interpolated data over
 * time; the one exception is conflict, because `client-signup-and-tenancy.md` AC3
 * requires a duplicate signup be "rejected with a clear reason", and that reason
 * is authored in `@zeddev/identity` rather than composed from input.
 */
export function toReply(error: unknown, requestId: string): Reply {
  if (error instanceof HttpError) {
    return { status: error.status, headers: error.headers, body: { error: { code: error.code, requestId } } };
  }
  if (error instanceof ValidationError) {
    return {
      status: 400,
      body: { error: { code: error.code, issues: error.issues.map(({ key, reason }) => ({ key, reason })), requestId } },
    };
  }
  if (error instanceof AuthenticationError) {
    // Identical for every cause by construction: `AuthenticationError` carries no
    // reason, and nothing from its context is copied here.
    return { status: 401, body: { error: { code: 'auth.failed', requestId } } };
  }
  if (error instanceof AuthorizationError) {
    return { status: 403, body: { error: { code: 'auth.forbidden', requestId } } };
  }
  if (error instanceof NotFoundError) {
    return { status: 404, body: { error: { code: error.code, requestId } } };
  }
  if (error instanceof ConflictError) {
    return { status: 409, body: { error: { code: error.code, message: error.message, requestId } } };
  }
  if (error instanceof TransientTransportError) {
    const seconds = Math.max(1, Math.ceil((error.retryAfterMs ?? 1000) / 1000));
    return {
      status: 503,
      headers: { 'retry-after': String(seconds) },
      body: { error: { code: 'service.unavailable', requestId } },
    };
  }
  return { status: 500, body: { error: { code: 'internal', requestId } } };
}

/**
 * Read and parse a JSON object body.
 *
 * JSON is required, not merely accepted, and that is a security control as much
 * as a format choice: a cross-site HTML form can only send
 * `application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`, so
 * a state-changing endpoint that insists on `application/json` cannot be driven
 * by a forged form without a CORS preflight — which this service never answers.
 *
 * The size bound is enforced while reading rather than after, so an oversized
 * body is refused without being buffered.
 */
export async function readJsonObject(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (contentType !== 'application/json') {
    // Drain so the connection can be reused; the body is never looked at.
    request.resume();
    throw new HttpError(415, 'request.unsupported_media_type');
  }

  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new HttpError(413, 'request.too_large');
  }

  // A chunked body declares no length, so the bound is also enforced while
  // reading. Past it the remainder is read and discarded rather than abandoned:
  // leaving a `for await` early destroys the request stream, and with it the
  // socket the 413 was supposed to be written to. `API_REQUEST_TIMEOUT` bounds
  // how long a caller can keep the discard going.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= maxBytes) chunks.push(buffer);
  }
  if (size > maxBytes) throw new HttpError(413, 'request.too_large');

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request.malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'request.malformed');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Pull named string fields out of a body, reporting every problem at once.
 *
 * Every problem at once for the same reason `loadConfig` does it: a form that
 * reports one field per submission is a guess-and-resubmit loop. The issues name
 * the field and never echo its value — a password is exactly the kind of value
 * that must not be reflected back into a response, a proxy log, or an error
 * tracker.
 */
export function stringFields<K extends string>(
  body: Record<string, unknown>,
  keys: readonly K[],
): Record<K, string> {
  const issues: { key: string; reason: string }[] = [];
  const out = {} as Record<K, string>;
  for (const key of keys) {
    const value = body[key];
    if (value === undefined || value === null) issues.push({ key, reason: 'is required' });
    else if (typeof value !== 'string') issues.push({ key, reason: 'must be a string' });
    else out[key] = value;
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return out;
}

/** Parse a `Cookie` header. Later duplicates do not override earlier ones, matching browser precedence. */
export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  if (header === undefined) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

export interface CookieOptions {
  readonly path: string;
  readonly secure: boolean;
  /** Absent means clear the cookie. */
  readonly expires?: Date | undefined;
}

/**
 * Serialise a session cookie.
 *
 * `HttpOnly` so that a script injected into the dashboard cannot read the
 * session, and `SameSite=Strict` so that the browser never attaches it to a
 * request another site initiated — which together with the JSON-only bodies and
 * the `Origin` check makes cross-site request forgery need three independent
 * failures rather than one.
 *
 * The expiry sent to the browser is the session's *absolute* lifetime. The
 * inactivity bound is enforced by the server on every request; a browser cannot
 * implement a sliding window, and pretending it could would mean refreshing the
 * cookie on every response.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, `Path=${options.path}`, 'HttpOnly', 'SameSite=Strict'];
  if (options.secure) parts.push('Secure');
  parts.push(
    options.expires === undefined
      ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
      : `Expires=${options.expires.toUTCString()}`,
  );
  if (options.expires === undefined) parts.push('Max-Age=0');
  return parts.join('; ');
}

/**
 * The address a request came from, trusting exactly `trustedHops` proxies.
 *
 * Each trusted proxy appends the address it received the request from, so with
 * `n` trusted hops the client is the `n`th address counting back from the TCP
 * peer. Anything further left was written by the caller and is ignored: a client
 * that sends `X-Forwarded-For: 1.2.3.4` through one proxy produces
 * `1.2.3.4, <real>` and is correctly identified as `<real>`.
 *
 * With zero trusted hops the header is not read at all, which is the only safe
 * reading when nothing is known about what stands in front of the service.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | readonly string[] | undefined,
  trustedHops: number,
): string {
  const remote = peer ?? 'unknown';
  if (trustedHops === 0 || forwardedFor === undefined) return remote;
  const header = typeof forwardedFor === 'string' ? forwardedFor : forwardedFor.join(',');
  const chain = [
    ...header
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
    remote,
  ];
  return chain[Math.max(0, chain.length - 1 - trustedHops)]!;
}

/**
 * Headers on every response.
 *
 * `no-store` because nearly every response here either sets a session or
 * describes one, and a shared cache holding either is a session handed to the
 * next person behind the same proxy. The CSP forbids everything because this
 * service returns JSON, never a document: if a browser is ever induced to render
 * a response, nothing in it can execute or be framed.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
