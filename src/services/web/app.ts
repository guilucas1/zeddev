/**
 * The dashboard's HTTP surface: pages, their assets, and the forward to the API.
 *
 * Why this service forwards at all: §1 decided the dashboard and the API share one
 * origin, because session cookies are `SameSite=Strict` and the API answers no
 * CORS. A laptop has no reverse proxy to arrange that, so the service that owns
 * the origin does it, and every tier runs the same path. A managed platform's
 * router can send `/v1/` to the API directly and nothing here needs to change.
 *
 * This service holds no state and no data. While the API is down it still serves
 * the pages, and each forwarded request answers in the API's own error shape, so
 * the dashboard says the platform is unavailable instead of failing to load
 * (`component-independence.md`).
 */

import { randomUUID } from 'node:crypto';
import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { HttpError, SECURITY_HEADERS } from '@zeddev/http';
import type { Logger } from '@zeddev/logging';
import type { Asset, Assets } from './assets.ts';
import type { WebSettings } from './config.ts';
import { isPagePath } from './ui/paths.ts';

/**
 * What a page may do. Everything it loads comes from this origin, and in
 * particular there is no `'unsafe-inline'`: the transcript screen renders text
 * written by the public, so markup that somehow got through escaping still could
 * not run.
 */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const PAGE_HEADERS: Readonly<Record<string, string>> = {
  ...SECURITY_HEADERS,
  'content-security-policy': PAGE_CSP,
  // Revalidated each time rather than cached for a period: there is no
  // fingerprinted filename to bust, and the ETag makes an unchanged asset a 304.
  'cache-control': 'no-cache',
};

/** The prefix forwarded to the API. Anything else is this service's own. */
const API_PREFIX = '/v1/';

const UPSTREAM_RETRY_AFTER_SECONDS = 5;

/** Never forwarded: they describe one connection, not the request (RFC 9110 §7.6.1). */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function endToEnd(headers: IncomingHttpHeaders): Record<string, string | string[]> {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((token) => token.trim().toLowerCase());
  const kept: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name) || named.includes(name)) continue;
    kept[name] = value;
  }
  return kept;
}

/**
 * The address chain, with this hop's own observation appended.
 *
 * Appended, never replaced: `clientAddress` in the API counts back from the end,
 * so whatever a caller wrote further left is already ignored. Replacing the header
 * would erase what a trusted proxy in front of this service recorded.
 */
function forwardedFor(existing: string | string[] | undefined, peer: string | undefined): string {
  const earlier = Array.isArray(existing) ? existing.join(', ') : existing;
  const self = peer ?? 'unknown';
  return earlier === undefined || earlier === '' ? self : `${earlier}, ${self}`;
}

export interface WebDependencies {
  readonly settings: WebSettings;
  readonly assets: Assets;
  readonly logger: Logger;
}

export interface Web {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

function sendAsset(request: IncomingMessage, response: ServerResponse, asset: Asset, status = 200): void {
  const headers = { ...PAGE_HEADERS, etag: asset.etag, 'content-type': asset.contentType };
  if (status === 200 && request.headers['if-none-match'] === asset.etag) {
    response.writeHead(304, headers);
    response.end();
    return;
  }
  response.writeHead(status, { ...headers, 'content-length': asset.body.length });
  response.end(request.method === 'HEAD' ? undefined : asset.body);
}

export function createWeb({ settings, assets, logger }: WebDependencies): Web {
  const send = settings.apiUpstream.protocol === 'https:' ? httpsRequest : httpRequest;

  function forward(request: IncomingMessage, response: ServerResponse): void {
    const requestId = randomUUID();
    let answered = false;

    const fail = (error: unknown): void => {
      if (answered) return;
      answered = true;
      logger.error('web.upstream.failed', error, { route: API_PREFIX, method: request.method ?? 'unknown', requestId });
      if (response.headersSent) {
        // Part of the answer is already on the wire, so an error reply cannot
        // follow it. Closing is the only signal that it is incomplete.
        response.destroy();
        return;
      }
      // Discarded rather than abandoned: an unread body takes the socket with it,
      // and then this reply never arrives (IMPLEMENTATION_PLAN.md §4h).
      request.resume();
      sendJson(
        response,
        503,
        // Names the API, so the dashboard can tell this from the API's own 503 for an
        // unreachable database (component-independence.md AC9).
        { error: { code: 'service.unavailable', component: 'api', requestId } },
        { 'retry-after': String(UPSTREAM_RETRY_AFTER_SECONDS) },
      );
    };

    let upstream: ClientRequest;
    try {
      upstream = send(
        {
          protocol: settings.apiUpstream.protocol,
          hostname: settings.apiUpstream.hostname,
          port: settings.apiUpstream.port,
          method: request.method,
          // The whole request target, query included, unchanged. The host above is
          // fixed by configuration, so nothing here can redirect the request elsewhere.
          path: request.url,
          headers: {
            ...endToEnd(request.headers),
            host: settings.apiUpstream.host,
            'x-forwarded-for': forwardedFor(request.headers['x-forwarded-for'], request.socket.remoteAddress),
          },
          timeout: settings.upstreamTimeoutMs,
          // No connection pool. A pooled socket the API has just closed loses the
          // request sent on it, and a retry cannot be safe for a POST; a fresh
          // connection on an internal network costs far less than that.
          agent: false,
        },
        (answer) => {
          answered = true;
          response.writeHead(answer.statusCode ?? 502, endToEnd(answer.headers));
          answer.on('error', (error) => {
            logger.error('web.upstream.interrupted', error, { route: API_PREFIX, requestId });
            response.destroy();
          });
          answer.pipe(response);
        },
      );
    } catch (error) {
      fail(error);
      return;
    }

    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', fail);
    // A browser that navigated away has no use for the answer.
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.on('error', (error) => upstream.destroy(error));
    request.pipe(upstream);
  }

  function handler(request: IncomingMessage, response: ServerResponse): void {
    const target = request.url ?? '/';
    const path = target.split(/[?#]/, 1)[0]!;

    if (path.startsWith(API_PREFIX)) {
      forward(request, response);
      return;
    }

    if (path === '/health/live' || path === '/health/ready') {
      // Ready does not look at the API: this service can do its job, serving the
      // dashboard, whether or not the API is up. An orchestrator restarting it
      // for the API's outage would only add a second outage.
      sendJson(response, 200, { status: path === '/health/live' ? 'live' : 'ready' });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      request.resume();
      const error = new HttpError(405, 'route.method_not_allowed');
      sendJson(response, error.status, { error: { code: error.code, requestId: randomUUID() } }, { allow: 'GET, HEAD' });
      return;
    }

    const file = assets.files.get(path);
    if (file !== undefined) {
      sendAsset(request, response, file);
      return;
    }

    if (isPagePath(path)) {
      sendAsset(request, response, assets.shell);
      return;
    }

    // The shell again, so an unknown address gets a page with navigation rather
    // than a blank error; the status still says it does not exist.
    sendAsset(request, response, assets.shell, 404);
  }

  return { handler };
}
