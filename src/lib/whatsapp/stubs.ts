/**
 * A local HTTP server speaking Meta's Graph wire format, for testing the real
 * adapter.
 *
 * Why a stub, when `@zeddev/storage` and `@zeddev/mail` insist on real servers:
 * those servers (MinIO, Mailpit) are free, local, and deterministic. Meta is none
 * of the three — it needs a real business, a real number, and real money, and it
 * cannot be asked to revoke a token, withdraw a business verification, or rate
 * limit on demand. Every acceptance criterion in `whatsapp-number-connection.md`
 * is about exactly those answers.
 *
 * What keeps the stub honest is that it does not merely reply — it *decodes*.
 * Each request is parsed from the documented Graph shape back into the port's own
 * vocabulary and handed to the same `ScriptedCloudBackend` the in-memory adapter
 * uses, so a conformance assertion about "what the number was asked to send" is
 * an assertion about what went over the socket.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { isAnswerLost, isScriptedFailure, ScriptedCloudBackend, type ScriptedFailure } from './memory.ts';

/** Every HTTP request as it arrived, for assertions about the wire itself. */
export interface WireRecord {
  readonly method: string;
  readonly path: string;
  readonly search: string;
  readonly authorization: string | undefined;
}

export interface GraphStub {
  /** The value for `WHATSAPP_API_BASE_URL`. */
  readonly baseUrl: string;
  readonly backend: ScriptedCloudBackend;
  readonly wire: readonly WireRecord[];
  close(): Promise<void>;
}

/**
 * The versioned root Meta requires. Part of the *path*, deliberately, so the
 * adapter is exercised against a base URL that carries a version — which is how
 * the real one is configured, and how a version bump stays a configuration change.
 */
const BASE_PATH = '/v21.0';

const MISSING_TOKEN: ScriptedFailure = {
  status: 401,
  code: 190,
  message: 'An access token is required to request this resource.',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendFailure(res: ServerResponse, failure: ScriptedFailure): void {
  send(res, failure.status, {
    error: {
      message: failure.message ?? 'Request failed.',
      type: 'OAuthException',
      code: failure.code,
      ...(failure.subcode === undefined ? {} : { error_subcode: failure.subcode }),
      fbtrace_id: 'stub',
    },
  });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return {};
  }
}

function bearer(req: IncomingMessage): string {
  const header = req.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer (.+)$/.exec(header) : null;
  if (match === null) throw MISSING_TOKEN;
  return match[1]!;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * Dispatch one decoded Graph request.
 *
 * The two `GET /{id}` forms are told apart by the field list the adapter asked
 * for, which is the only thing that distinguishes them on the wire — Meta itself
 * resolves the node by id. Decoding it this way means a change to the adapter's
 * field list shows up here as an unroutable request rather than as a silently
 * wrong answer.
 */
function route(
  backend: ScriptedCloudBackend,
  token: string,
  method: string,
  segments: readonly string[],
  fields: string,
  body: unknown,
): unknown {
  const [id, collection] = segments;
  if (id === undefined) throw MISSING_TOKEN;

  if (collection === undefined && method === 'GET' && fields.includes('display_phone_number')) {
    const profile = backend.describeNumber(token, id);
    return {
      id: profile.phoneNumberId,
      display_phone_number: profile.displayNumber,
      verified_name: profile.verifiedName,
      quality_rating: profile.qualityRating.toUpperCase(),
      code_verification_status: profile.numberVerification.toUpperCase(),
    };
  }

  if (collection === undefined && method === 'GET' && fields.includes('account_review_status')) {
    const profile = backend.describeBusinessAccount(token, id);
    return {
      id: profile.businessAccountId,
      name: profile.name,
      account_review_status: profile.reviewStatus.toUpperCase(),
      owner_business_info: { id: `owner-${profile.businessAccountId}`, name: profile.name, verification_status: profile.verificationStatus },
    };
  }

  if (collection === 'subscribed_apps') {
    if (method === 'POST') {
      backend.subscribeApp(token, id);
      return { success: true };
    }
    if (method === 'DELETE') {
      backend.unsubscribeApp(token, id);
      return { success: true };
    }
    if (method === 'GET') {
      return {
        data: backend
          .listSubscribedApps(token, id)
          .map((appId) => ({ whatsapp_business_api_data: { id: appId, name: `app-${appId}` } })),
      };
    }
  }

  if (collection === 'messages' && method === 'POST') {
    const payload = asRecord(body);
    const text = asRecord(payload['text']);
    const sent = backend.sendText(token, id, String(payload['to'] ?? ''), String(text['body'] ?? ''));
    return {
      messaging_product: 'whatsapp',
      contacts: [{ input: String(payload['to'] ?? ''), wa_id: String(payload['to'] ?? '') }],
      messages: [{ id: sent.messageId }],
    };
  }

  throw { status: 400, code: 100, subcode: 33, message: 'Unsupported request.' } satisfies ScriptedFailure;
}

export async function startGraphStub(): Promise<GraphStub> {
  const backend = new ScriptedCloudBackend();
  const wire: WireRecord[] = [];

  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://stub');
      wire.push({
        method: req.method ?? '',
        path: url.pathname,
        search: url.search,
        authorization: typeof req.headers.authorization === 'string' ? '<present>' : undefined,
      });
      const body = await readBody(req);
      try {
        if (!url.pathname.startsWith(`${BASE_PATH}/`)) throw MISSING_TOKEN;
        const token = bearer(req);
        const segments = url.pathname.slice(BASE_PATH.length + 1).split('/');
        send(res, 200, route(backend, token, req.method ?? 'GET', segments, url.searchParams.get('fields') ?? '', body));
      } catch (error) {
        // The backend did the work and then declared its answer lost, so the
        // wire has to lose it too: the socket goes away with nothing written on
        // it. Answering with an error instead would tell the adapter the send
        // did not happen, which is exactly the thing that is not known.
        if (isAnswerLost(error)) res.socket?.destroy();
        else if (isScriptedFailure(error)) sendFailure(res, error);
        // A decoding failure in the stub is a test failure and should read like one.
        else send(res, 500, { stubError: error instanceof Error ? error.message : String(error) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { address, port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://${address}:${port}${BASE_PATH}`,
    backend,
    wire,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
