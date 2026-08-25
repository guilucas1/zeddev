/**
 * The HTTP transport, and the seam that makes the adapter testable.
 *
 * `node:http`/`node:https` rather than `fetch`. Two reasons, both about control:
 * SigV4 signs an exact set of headers, and `fetch` (via undici) adds its own —
 * harmless today, because a remote verifies only the headers named in
 * `SignedHeaders`, but it is a behaviour of a dependency sitting underneath a
 * signature, which is not somewhere to accept surprises. And a per-request
 * timeout that covers a stalled *body* rather than only a stalled connect is
 * awkward to express with `fetch` and trivial here.
 *
 * `Transport` is a function type on purpose. It is the single seam the S3
 * adapter is built against, so the retry policy, the error mapping, and the XML
 * parsing can all be tested against synthesised responses — including the ones
 * a real server will not produce on demand, like a `SlowDown` burst or a body
 * that fails its checksum. Everything a real server *will* produce is tested
 * against a real server instead. The division is deliberate: the transport seam
 * covers what cannot be provoked, never what can.
 */

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { TransientTransportError } from '@zeddev/errors';

export interface TransportRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Buffer | undefined;
  readonly timeoutMs: number;
}

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export interface Transport {
  (request: TransportRequest): Promise<TransportResponse>;
}

/**
 * Keepalive, and a cap on sockets.
 *
 * Keepalive because a TLS handshake per object is the dominant cost of storing a
 * small document, and `cost-efficient-operation.md` makes bandwidth and CPU
 * things that scale with usage — a handshake per request makes them scale
 * steeply. The socket cap is the same lever `DATABASE_POOL_MAX` is: it is what
 * lets the platform fit on the smallest of the three tiers in
 * `environment-portability.md`.
 */
export interface AgentOptions {
  readonly maxSockets: number;
}

export function createTransport(options: AgentOptions): Transport & { close(): void } {
  const shared = { keepAlive: true, maxSockets: options.maxSockets, keepAliveMsecs: 30_000 };
  let httpAgent: HttpAgent | undefined;
  let httpsAgent: HttpsAgent | undefined;

  const transport = (req: TransportRequest): Promise<TransportResponse> => {
    const secure = req.url.protocol === 'https:';
    if (secure) {
      httpsAgent ??= new HttpsAgent(shared);
      return send(req, httpsRequest, httpsAgent);
    }
    httpAgent ??= new HttpAgent(shared);
    return send(req, httpRequest, httpAgent);
  };

  transport.close = (): void => {
    httpAgent?.destroy();
    httpsAgent?.destroy();
    httpAgent = undefined;
    httpsAgent = undefined;
  };

  return transport;
}

type RequestFn = typeof httpRequest;

function send(
  req: TransportRequest,
  requestFn: RequestFn,
  agent: HttpAgent | HttpsAgent | undefined,
): Promise<TransportResponse> {
  return new Promise<TransportResponse>((resolve, reject) => {
    // The whole exchange, not just the connect, is bounded. A remote that
    // accepts a connection and then stalls mid-body is indistinguishable from a
    // fast one until the deadline, and an unbounded read is how a single wedged
    // upload occupies a worker slot indefinitely — which is `AC16`'s "one
    // tenant's problem delays another's" arriving by a different route.
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clientRequest.destroy();
      reject(error);
    };

    const timer = setTimeout(() => {
      fail(
        new TransientTransportError('Timed out talking to object storage', {
          code: 'storage.request_timeout',
          context: { elapsedMs: req.timeoutMs },
        }),
      );
    }, req.timeoutMs);
    timer.unref?.();

    const clientRequest = requestFn(
      {
        method: req.method,
        protocol: req.url.protocol,
        hostname: req.url.hostname,
        port: req.url.port === '' ? undefined : Number(req.url.port),
        path: `${req.url.pathname}${req.url.search}`,
        headers: { ...req.headers },
        ...(agent === undefined ? {} : { agent }),
      },
      (response) => {
        // Chunks accumulated by hand rather than piped, matching the framing
        // style in `@zeddev/db`'s connection: the body is bounded and is needed
        // whole (to hash it), so there is nothing a stream would buy.
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          const headers: Record<string, string> = {};
          for (const [name, value] of Object.entries(response.headers)) {
            if (value === undefined) continue;
            headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
          }
          resolve({
            status: response.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks),
          });
        });
        response.on('error', (error: Error) =>
          fail(
            new TransientTransportError('Object storage response failed mid-body', {
              code: 'storage.response_failed',
              context: { errorType: error.constructor.name },
              cause: error,
            }),
          ),
        );
      },
    );

    clientRequest.on('error', (error: Error) =>
      // Deliberately transient, including for DNS and connection-refused. A
      // wrong hostname is a configuration error, but so is a container that has
      // not finished starting, and the two are indistinguishable from here.
      // `verifyAccess()` is where a genuinely unreachable endpoint is turned
      // into a startup failure with a diagnosable cause.
      fail(
        new TransientTransportError('Could not reach object storage', {
          code: 'storage.unreachable',
          context: { errorType: error.constructor.name },
          cause: error,
        }),
      ),
    );

    if (req.body !== undefined) clientRequest.write(req.body);
    clientRequest.end();
  });
}
