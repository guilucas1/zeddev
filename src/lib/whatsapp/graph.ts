/**
 * The real adapter: Meta's Graph API.
 *
 * Deliberately a *single attempt* per call. Every caller of this port already
 * sits behind something that retries with a policy suited to its own deadline —
 * the durable queue for outbound sends, and for the connect flow a client who is
 * watching a screen and would rather be told what went wrong than wait through
 * three silent backoffs. A retry loop here would be a third, invisible policy
 * layered under both.
 *
 * `fetch` rather than the hand-written transport `@zeddev/storage` uses, for the
 * same reason `@zeddev/ai` does: nothing here signs an exact header set, and
 * `fetch`'s abort signal covers a stalled body as well as a stalled connect.
 */

import { TransientTransportError } from '@zeddev/errors';
import {
  assertCloudCredentials,
  assertMediaRequest,
  assertSendableText,
  cloudFailure,
  mediaTooLarge,
  unreachableContext,
  type BusinessAccountProfile,
  type CloudCredentials,
  type CloudDescriptor,
  type MediaRequest,
  type NumberProfile,
  type RetrievedMedia,
  type SendDeterminacy,
  type SentMessage,
  type WhatsAppCloud,
} from './cloud.ts';

export interface GraphCloudSettings {
  /** The versioned Graph API root, supplied as configuration and never defaulted. */
  readonly baseUrl: string;
  /** The platform's Meta app id — what a WABA must be subscribed to. */
  readonly appId: string;
  readonly requestTimeoutMs: number;
}

export interface GraphCloudDependencies {
  readonly fetch?: typeof fetch | undefined;
}

/** Meta returns its errors under a single `error` object on every endpoint. */
interface MetaError {
  readonly message?: unknown;
  readonly code?: unknown;
  readonly error_subcode?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asText(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value !== '' ? value : fallback;
}

/**
 * Lowercase the enumerations Meta returns in SCREAMING_CASE.
 *
 * The port's vocabulary is lowercase because it is compared against lowercase
 * constants everywhere else in the platform; normalising at the decode boundary
 * means no comparison downstream has to remember which casing Meta used for
 * which field.
 */
function normalizeEnum(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : fallback;
}

/**
 * The failure codes that prove the request was never written.
 *
 * Name resolution, a refused connection, an unreachable host, and a rejected
 * certificate all happen before any byte Meta could act on leaves this process.
 * Anything else — a reset mid-exchange, a timeout, an undici socket error — may
 * have been received and acted on before the answer was lost.
 */
const NEVER_SENT_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_INVALID_URL',
]);

/**
 * Could Meta have acted on a request that `fetch` rejected?
 *
 * `unknown` unless proven otherwise, deliberately. `fetch` reports "I could not
 * complete this" for two very different situations, and the error shape does not
 * separate them: one where nothing was sent, and one where something was sent and
 * the answer was lost. Only the first is safe to repeat, so only the first is
 * claimed, and only on the evidence of a cause code that cannot occur after the
 * request was written. Guessing the other way is how an end customer gets the
 * same reply twice.
 */
function determinacyOf(cause: unknown): SendDeterminacy {
  for (let node: unknown = cause, depth = 0; node !== undefined && node !== null && depth < 8; depth += 1) {
    const record = node as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === 'string' && NEVER_SENT_CODES.has(record.code)) return 'none';
    node = record.cause;
  }
  return 'unknown';
}

/** Meta documents `file_size` as a number and has been seen to send it as a string. */
function asByteCount(value: unknown): number | undefined {
  const count = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : undefined;
}

/**
 * A success status on a media download that is not media.
 *
 * A CDN can answer a client it does not like with a 200 and a web page. Handed on,
 * those bytes would reach an AI provider as a "photo" and come back as a confident
 * description of an error page, so they are refused here as the transient failure
 * they are.
 */
const NOT_MEDIA_CONTENT_TYPE = /^(text\/html|application\/json)\b/i;

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

export class GraphWhatsAppCloud implements WhatsAppCloud {
  readonly descriptor: CloudDescriptor;
  readonly #settings: GraphCloudSettings;
  readonly #fetch: typeof fetch;
  readonly #root: string;

  constructor(settings: GraphCloudSettings, deps: GraphCloudDependencies = {}) {
    this.#settings = settings;
    this.#fetch = deps.fetch ?? fetch;
    this.#root = settings.baseUrl.replace(/\/+$/, '');
    this.descriptor = Object.freeze({ baseUrl: this.#root, appId: settings.appId });
  }

  /**
   * One Graph exchange.
   *
   * A network failure, a timeout, and an abort all become transient: none of them
   * is evidence about the credentials, and treating them as terminal would move a
   * working tenant's connection to `error` because a DNS lookup blipped.
   */
  async #call(
    operation: string,
    credentials: CloudCredentials,
    request: {
      readonly method: 'GET' | 'POST' | 'DELETE';
      readonly path: string;
      readonly query?: Readonly<Record<string, string>> | undefined;
      readonly body?: unknown;
    },
  ): Promise<unknown> {
    const url = new URL(`${this.#root}${request.path}`);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value);

    const headers: Record<string, string> = {
      authorization: `Bearer ${credentials.accessToken.expose()}`,
      accept: 'application/json',
    };
    if (request.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: request.method,
        headers,
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
        signal: AbortSignal.timeout(this.#settings.requestTimeoutMs),
      });
    } catch (cause) {
      throw new TransientTransportError(`WhatsApp Cloud API ${operation} did not complete.`, {
        code: 'whatsapp.cloud.unreachable',
        context: unreachableContext(operation, determinacyOf(cause)),
        cause,
      });
    }

    const payload = await this.#readJson(operation, response);
    if (!response.ok) {
      const error = asRecord(asRecord(payload)['error']) as MetaError;
      throw cloudFailure(operation, {
        status: response.status,
        code: asNumber(error.code),
        subcode: asNumber(error.error_subcode),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    return payload;
  }

  /**
   * Read a body that may not be JSON.
   *
   * A gateway in front of Meta answers 502 with HTML, and letting `response.json()`
   * throw there would surface a JSON parse error instead of the transient failure
   * it actually is. An unparseable *success* body is a different matter — that is
   * an upstream contract violation and is reported as one.
   */
  async #readJson(operation: string, response: Response): Promise<unknown> {
    const text = await response.text().catch(() => '');
    if (text === '') return {};
    try {
      return JSON.parse(text) as unknown;
    } catch (cause) {
      if (response.ok) {
        // A 2xx means Meta accepted the request, so whatever it asked for has
        // very likely happened — the body simply could not be read back. Never
        // `none`: repeating a send on this footing is how a duplicate reply
        // reaches an end customer.
        throw new TransientTransportError(`WhatsApp Cloud API ${operation} returned a response that was not JSON.`, {
          code: 'whatsapp.cloud.malformed_response',
          context: { ...unreachableContext(operation, 'unknown'), status: response.status },
          cause,
        });
      }
      return {};
    }
  }

  async describeNumber(credentials: CloudCredentials): Promise<NumberProfile> {
    assertCloudCredentials(credentials);
    const payload = asRecord(
      await this.#call('describeNumber', credentials, {
        method: 'GET',
        path: `/${credentials.phoneNumberId}`,
        query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status' },
      }),
    );
    return {
      phoneNumberId: asText(payload['id'], credentials.phoneNumberId),
      displayNumber: asText(payload['display_phone_number']),
      verifiedName: asText(payload['verified_name']),
      qualityRating: normalizeEnum(payload['quality_rating'], 'unknown'),
      numberVerification: normalizeEnum(payload['code_verification_status'], 'unknown'),
    };
  }

  async describeBusinessAccount(credentials: CloudCredentials): Promise<BusinessAccountProfile> {
    assertCloudCredentials(credentials);
    // `owner_business_info` is a field expansion on the WhatsApp Business Account
    // node: the verification status belongs to the owning business, not to the
    // account, and asking for it here saves a second round trip and a second id
    // the client would otherwise have to supply.
    const payload = asRecord(
      await this.#call('describeBusinessAccount', credentials, {
        method: 'GET',
        path: `/${credentials.businessAccountId}`,
        query: { fields: 'id,name,account_review_status,owner_business_info{id,name,verification_status}' },
      }),
    );
    const owner = asRecord(payload['owner_business_info']);
    return {
      businessAccountId: asText(payload['id'], credentials.businessAccountId),
      name: asText(payload['name']),
      verificationStatus: normalizeEnum(owner['verification_status'], 'unknown'),
      reviewStatus: normalizeEnum(payload['account_review_status'], 'unknown'),
    };
  }

  async subscribeApp(credentials: CloudCredentials): Promise<void> {
    assertCloudCredentials(credentials);
    await this.#call('subscribeApp', credentials, {
      method: 'POST',
      path: `/${credentials.businessAccountId}/subscribed_apps`,
      body: {},
    });
  }

  async listSubscribedApps(credentials: CloudCredentials): Promise<readonly string[]> {
    assertCloudCredentials(credentials);
    const payload = asRecord(
      await this.#call('listSubscribedApps', credentials, {
        method: 'GET',
        path: `/${credentials.businessAccountId}/subscribed_apps`,
      }),
    );
    const data = Array.isArray(payload['data']) ? (payload['data'] as unknown[]) : [];
    return data
      .map((entry) => asText(asRecord(asRecord(entry)['whatsapp_business_api_data'])['id']))
      .filter((id) => id !== '');
  }

  async unsubscribeApp(credentials: CloudCredentials): Promise<void> {
    assertCloudCredentials(credentials);
    await this.#call('unsubscribeApp', credentials, {
      method: 'DELETE',
      path: `/${credentials.businessAccountId}/subscribed_apps`,
    });
  }

  /**
   * Media is two exchanges: the Graph API says where the bytes are, and the bytes
   * are fetched from there, with the same token.
   *
   * `phone_number_id` makes Meta check the media was sent to *this* number, rather
   * than merely being visible to this token — which matters for a token that spans
   * several numbers, and is the difference between "an id another tenant's customer
   * was given" being refused by Meta or served by it.
   */
  async fetchMedia(credentials: CloudCredentials, request: MediaRequest): Promise<RetrievedMedia> {
    assertCloudCredentials(credentials);
    assertMediaRequest(request);
    const described = asRecord(
      await this.#call('fetchMedia', credentials, {
        method: 'GET',
        path: `/${request.mediaId}`,
        query: { phone_number_id: credentials.phoneNumberId },
      }),
    );
    const declared = asByteCount(described['file_size']);
    if (declared !== undefined && declared > request.maxBytes) throw mediaTooLarge(request);
    const data = await this.#download(credentials, this.#mediaLocation(described['url']), request);
    return { mimeType: asText(described['mime_type']), data };
  }

  /**
   * Where Meta says the bytes are, checked before a token is sent there.
   *
   * The URL is data from a response, and the bearer token goes wherever it points.
   * The host cannot be pinned without embedding one of Meta's hostnames, and it
   * changes; what can be refused is a location that would carry the token in the
   * clear, or one that is not a URL at all. Never quoted in an error: it is a signed
   * link to a customer's media.
   */
  #mediaLocation(value: unknown): URL {
    let location: URL | undefined;
    try {
      location = new URL(asText(value));
    } catch {
      location = undefined;
    }
    if (location === undefined || location.protocol !== new URL(this.#root).protocol) {
      throw new TransientTransportError('WhatsApp Cloud API named no usable location for the media.', {
        code: 'whatsapp.cloud.malformed_response',
        context: unreachableContext('fetchMedia', 'none'),
      });
    }
    return location;
  }

  /**
   * Read the bytes, stopping at the bound rather than after it.
   *
   * `file_size` and `content-length` are both claims. Only counting what actually
   * arrives protects the process, so the body is read chunk by chunk and abandoned
   * the moment it passes the limit. The timeout covers the body as well as the
   * connect, because `fetch`'s signal stays armed until the stream ends.
   */
  async #download(credentials: CloudCredentials, location: URL, request: MediaRequest): Promise<Uint8Array> {
    const unreachable = (cause: unknown): TransientTransportError =>
      new TransientTransportError('WhatsApp Cloud API fetchMedia did not complete.', {
        code: 'whatsapp.cloud.unreachable',
        context: unreachableContext('fetchMedia', determinacyOf(cause)),
        cause,
      });

    let response: Response;
    try {
      response = await this.#fetch(location, {
        method: 'GET',
        headers: { authorization: `Bearer ${credentials.accessToken.expose()}` },
        signal: AbortSignal.timeout(this.#settings.requestTimeoutMs),
      });
    } catch (cause) {
      throw unreachable(cause);
    }
    if (!response.ok) {
      const error = asRecord(asRecord(await this.#readJson('fetchMedia', response))['error']) as MetaError;
      throw cloudFailure('fetchMedia', {
        status: response.status,
        code: asNumber(error.code),
        subcode: asNumber(error.error_subcode),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    if (NOT_MEDIA_CONTENT_TYPE.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel().catch(() => undefined);
      throw new TransientTransportError('WhatsApp Cloud API answered a media download with something that is not media.', {
        code: 'whatsapp.cloud.malformed_response',
        context: unreachableContext('fetchMedia', 'none'),
      });
    }
    const announced = asByteCount(response.headers.get('content-length'));
    if (announced !== undefined && announced > request.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw mediaTooLarge(request);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for await (const chunk of response.body ?? []) {
        total += chunk.byteLength;
        if (total > request.maxBytes) break;
        chunks.push(chunk);
      }
    } catch (cause) {
      throw unreachable(cause);
    }
    if (total > request.maxBytes) throw mediaTooLarge(request);
    return Buffer.concat(chunks, total);
  }

  async sendText(
    credentials: CloudCredentials,
    message: { readonly to: string; readonly body: string },
  ): Promise<SentMessage> {
    assertCloudCredentials(credentials);
    assertSendableText(message);
    const payload = asRecord(
      await this.#call('sendText', credentials, {
        method: 'POST',
        path: `/${credentials.phoneNumberId}/messages`,
        body: {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: message.to,
          type: 'text',
          // Link previews are off because a reply is generated text: a URL the
          // model produced should not become a rendered card vouched for by the
          // client's business.
          text: { preview_url: false, body: message.body },
        },
      }),
    );
    const messages = Array.isArray(payload['messages']) ? (payload['messages'] as unknown[]) : [];
    const id = asText(asRecord(messages[0])['id']);
    if (id === '') {
      throw new TransientTransportError('WhatsApp Cloud API accepted a send but named no message.', {
        code: 'whatsapp.cloud.malformed_response',
        context: { operation: 'sendText', connectionReason: 'transient' },
      });
    }
    return { messageId: id };
  }
}
