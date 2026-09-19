/**
 * The webhook handler: what Meta talks to.
 *
 * Two routes that matter, and each exists to satisfy one side of the upstream's
 * contract:
 *
 * - `GET /v1/whatsapp/webhook` — the subscription handshake. Meta sends the verify
 *   token the operator typed into its dashboard and expects the challenge echoed.
 * - `POST /v1/whatsapp/webhook` — a notification. The reply is the
 *   acknowledgement, and the rule for it is the heart of this service:
 *
 *   **200 means "durably stored, do not send again"; anything else means "send
 *   again".** So a 200 is written only after every message in the notification is
 *   either committed and scheduled, or refused and recorded — never before (a
 *   restart would lose an acknowledged message, AC6) and never after anything
 *   slower than one short transaction per receiving number (a slow acknowledgement
 *   makes Meta redeliver, AC1). Nothing here waits for a reply to be generated;
 *   reply generation reads the scheduled job in another process entirely.
 *
 * Status choices, and why:
 *
 * - A bad or missing signature is 401 and is recorded (AC2). Meta signs
 *   everything it sends, so this is someone else, and an error costs them nothing.
 * - A notification that is authentic but cannot be used — unreadable, or for a
 *   number no tenant owns — is **200** and recorded (AC3). Redelivery cannot
 *   change the outcome, and a non-200 would have Meta retry it for days.
 * - A database failure is 503. Nothing was acknowledged, so Meta redelivers, and
 *   any batch that did commit before the failure is suppressed as a duplicate.
 */

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { withTenant, type Connection, type Pool } from '@zeddev/db';
import { HttpError, readBody, SECURITY_HEADERS } from '@zeddev/http';
import { endCustomerRef, type Logger } from '@zeddev/logging';
import type { EnqueueRequest, EnqueueResult } from '@zeddev/queue';
import {
  attributeInboundNumber,
  INBOUND_JOB_KIND,
  parseWebhookNotification,
  recordInboundMessage,
  recordInboundRejection,
  verifyWebhookSignature,
  type InboundBatch,
  type InboundRejection,
  type WhatsAppConfig,
} from '@zeddev/whatsapp';
import type { GatewaySettings } from './config.ts';

export const WEBHOOK_PATH = '/v1/whatsapp/webhook';

/**
 * The one queue operation the gateway performs. `PostgresQueue.enqueueWithin`
 * satisfies it; it is an interface here so the dependency is on the capability —
 * scheduling inside the caller's transaction — rather than on the class.
 */
export interface InboundScheduler {
  enqueueWithin(connection: Connection, request: EnqueueRequest): Promise<EnqueueResult>;
}

export interface GatewayDependencies {
  readonly pool: Pool;
  readonly scheduler: InboundScheduler;
  readonly whatsapp: WhatsAppConfig;
  readonly settings: Pick<GatewaySettings, 'maxBodyBytes'>;
  readonly logger: Logger;
}

export interface Gateway {
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
}

interface Reply {
  readonly status: number;
  readonly body?: unknown;
  /** Plain text instead of JSON — only the handshake echo uses it. */
  readonly text?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** The challenge is echoed into a response, so only a token-shaped value is. */
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function createGateway(dependencies: GatewayDependencies): Gateway {
  const { pool, scheduler, whatsapp, settings, logger } = dependencies;
  const verifyTokenDigest = digest(whatsapp.WHATSAPP_WEBHOOK_VERIFY_TOKEN.expose());

  async function record(rejection: InboundRejection, requestId: string): Promise<void> {
    logger.warn('gateway.inbound.rejected', {
      requestId,
      reason: rejection.reason,
      count: rejection.messageCount,
    });
    await recordInboundRejection(pool, rejection);
  }

  function handshake(query: URLSearchParams): Reply {
    const mode = query.get('hub.mode');
    const token = query.get('hub.verify_token') ?? '';
    const challenge = query.get('hub.challenge') ?? '';
    // Compared as digests so the comparison is constant-time whatever the lengths.
    const matches = timingSafeEqual(digest(token), verifyTokenDigest);
    if (mode !== 'subscribe' || !matches || !CHALLENGE.test(challenge)) {
      logger.warn('gateway.handshake.refused', { outcome: 'refused' });
      return { status: 403, body: { error: { code: 'webhook.handshake_refused' } } };
    }
    logger.info('gateway.handshake.accepted', { outcome: 'accepted' });
    return { status: 200, text: challenge };
  }

  /** Store and schedule one receiving number's messages, as one transaction. */
  async function accept(tenantId: string, batch: InboundBatch, requestId: string): Promise<void> {
    // Stored and scheduled in the order the end-customer sent them, not the order
    // the notification lists them: the queue runs one customer's jobs in enqueue
    // order, so this is where send order becomes processing order (AC5). Across
    // notifications the worker re-reads by send time; see `listInboundMessages`.
    const inSentOrder = [...batch.messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
    await withTenant(pool, tenantId, async (tx) => {
      for (const message of inSentOrder) {
        const stored = await recordInboundMessage(tx, batch.phoneNumberId, message);
        const fields = {
          requestId,
          tenantId,
          messageId: stored.id,
          externalId: message.externalId,
          endCustomerRef: endCustomerRef(tenantId, message.customerId),
          messageType: message.type,
          deduplicated: !stored.created,
        };
        if (!stored.created) {
          // Already stored — and therefore already scheduled, in the transaction
          // that stored it. Scheduling again is exactly the second reply AC4
          // forbids.
          logger.info('gateway.inbound.duplicate', fields);
          continue;
        }
        const job = await scheduler.enqueueWithin(tx, {
          kind: INBOUND_JOB_KIND,
          // A reference, not a copy: the stored row is the single source of the
          // message, and a second copy in the job payload could only disagree.
          payload: { inboundMessageId: stored.id },
          // One end-customer's messages run one at a time (the queue digests the
          // key, so the number never reaches the cross-tenant routing table).
          partitionKey: message.customerId,
          dedupeKey: message.externalId,
        });
        logger.info('gateway.inbound.accepted', { ...fields, jobId: job.jobId });
      }
    });
  }

  async function receive(request: IncomingMessage, requestId: string): Promise<Reply> {
    const raw = await readBody(request, settings.maxBodyBytes);
    const header = request.headers['x-hub-signature-256'];
    const verdict = verifyWebhookSignature(raw, Array.isArray(header) ? header[0] : header, whatsapp.WHATSAPP_APP_SECRET);
    if (verdict !== 'valid') {
      // Nothing from an unauthentic body is trusted, so not even the number id it
      // claims is recorded.
      await record({ reason: verdict, phoneNumberId: null, messageCount: 0 }, requestId).catch((error: unknown) =>
        logger.error('gateway.rejection.record_failed', error, { requestId }),
      );
      return { status: 401, body: { error: { code: 'webhook.signature_invalid' } } };
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      payload = undefined;
    }
    const parsed = parseWebhookNotification(payload);
    for (const rejection of parsed.malformed) await record(rejection, requestId);

    for (const batch of parsed.batches) {
      const tenantId = await attributeInboundNumber(pool, batch.phoneNumberId);
      if (tenantId === undefined) {
        await record(
          { reason: 'unattributable', phoneNumberId: batch.phoneNumberId, messageCount: batch.messages.length },
          requestId,
        );
        continue;
      }
      await accept(tenantId, batch, requestId);
    }

    if (parsed.statusCount > 0) {
      // Outbound delivery receipts. Nothing sends yet, so nothing consumes them;
      // acknowledged so Meta does not keep redelivering them.
      logger.debug('gateway.statuses.ignored', { requestId, count: parsed.statusCount });
    }
    return { status: 200, body: { status: 'received' } };
  }

  async function dispatch(request: IncomingMessage, requestId: string): Promise<{ route: string; reply: Reply; failure?: unknown }> {
    const target = (request.url ?? '/').split('#', 1)[0]!;
    const mark = target.indexOf('?');
    const path = mark === -1 ? target : target.slice(0, mark);
    const query = mark === -1 ? '' : target.slice(mark + 1);
    try {
      if (path === '/health/live' && request.method === 'GET') {
        return { route: path, reply: { status: 200, body: { status: 'live' } } };
      }
      if (path === '/health/ready' && request.method === 'GET') {
        try {
          await pool.query('SELECT 1');
          return { route: path, reply: { status: 200, body: { status: 'ready' } } };
        } catch {
          return { route: path, reply: { status: 503, body: { status: 'unavailable', component: 'database' } } };
        }
      }
      if (path === WEBHOOK_PATH) {
        if (request.method === 'GET') return { route: path, reply: handshake(new URLSearchParams(query)) };
        if (request.method === 'POST') return { route: path, reply: await receive(request, requestId) };
        request.resume();
        return { route: path, reply: { status: 405, headers: { allow: 'GET, POST' }, body: { error: { code: 'route.method_not_allowed' } } } };
      }
      request.resume();
      return { route: 'unmatched', reply: { status: 404, body: { error: { code: 'route.not_found' } } } };
    } catch (error) {
      if (error instanceof HttpError) {
        return { route: path, reply: { status: error.status, headers: error.headers, body: { error: { code: error.code } } } };
      }
      // Not acknowledged, so Meta redelivers; what did commit is suppressed then.
      return {
        route: path,
        reply: { status: 503, headers: { 'retry-after': '1' }, body: { error: { code: 'service.unavailable' } } },
        failure: error,
      };
    }
  }

  function write(response: ServerResponse, reply: Reply, requestId: string): void {
    const headers: Record<string, string> = { ...SECURITY_HEADERS, ...(reply.headers ?? {}), 'x-request-id': requestId };
    const payload = reply.text ?? JSON.stringify(reply.body ?? {});
    headers['content-type'] = reply.text === undefined ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
    headers['content-length'] = String(Buffer.byteLength(payload));
    response.writeHead(reply.status, headers);
    response.end(payload);
  }

  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const requestId = randomUUID();
    const started = performance.now();
    void dispatch(request, requestId).then(({ route, reply, failure }) => {
      try {
        if (!response.headersSent && !response.destroyed) write(response, reply, requestId);
      } catch {
        response.destroy();
      }
      const fields = {
        requestId,
        method: request.method ?? 'UNKNOWN',
        route,
        statusCode: reply.status,
        durationMs: Math.round(performance.now() - started),
      };
      if (reply.status >= 500) logger.error('gateway.request.failed', failure, fields);
      else if (route.startsWith('/health/')) logger.debug('gateway.request', fields);
      else logger.info('gateway.request', fields);
    });
  };

  return { handler };
}
