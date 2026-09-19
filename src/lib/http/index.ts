/**
 * `@zeddev/http` — the few HTTP primitives more than one service needs.
 *
 * Every service is hand-written over `node:http` rather than a framework, for the
 * reason IMPLEMENTATION_PLAN.md §1 gives for every dependency the platform
 * declined. That makes the handful of pieces with a real trap in them — reading a
 * bounded body without destroying the socket the refusal must be written to, the
 * headers every response carries — the pieces a second service would otherwise
 * copy. A copy is where a fix to one stops reaching the other, so they live here.
 *
 * Deliberately not here: routing, status mapping, and cookies. Those are policy,
 * and each service's policy differs — the API maps the error taxonomy for a
 * dashboard; the WhatsApp gateway answers an upstream that retries on anything
 * but 200.
 */

import type { IncomingMessage } from 'node:http';

/**
 * A failure that belongs to the transport rather than to the domain.
 *
 * Deliberately not a `ZedError`. The taxonomy in `@zeddev/errors` is closed
 * because each kind is a branch some spec-mandated behaviour keys off; "the body
 * was not JSON" and "wrong method" are HTTP facts that nothing outside a service
 * ever branches on, and adding them there would widen a vocabulary every other
 * package must then consider.
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
 * Read a request body, refusing one larger than `maxBytes` with a 413.
 *
 * The bound is enforced while reading rather than after, so an oversized body is
 * never buffered. Past the bound the remainder is read and *discarded* rather
 * than abandoned: leaving a `for await` early destroys the request stream, and
 * with it the socket the 413 was supposed to be written to, so the caller would
 * see a reset connection instead of an answer (IMPLEMENTATION_PLAN.md §4h). The
 * service's request timeout bounds how long a caller can keep the discard going.
 *
 * The bytes are returned untouched. That matters to a caller that authenticates
 * a body by its signature: the signature covers these exact bytes, and parsing
 * and re-serialising first would verify something the sender never signed.
 */
export async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new HttpError(413, 'request.too_large');
  }

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size <= maxBytes) chunks.push(buffer);
  }
  if (size > maxBytes) throw new HttpError(413, 'request.too_large');
  return Buffer.concat(chunks);
}

/**
 * Headers on every response.
 *
 * `no-store` because nearly every response either sets a session or describes
 * one, and a shared cache holding either is a session handed to the next person
 * behind the same proxy. The CSP forbids everything because no service here
 * returns a document: if a browser is ever induced to render a response, nothing
 * in it can execute or be framed.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
};
