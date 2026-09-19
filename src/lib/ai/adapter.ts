/**
 * What every real adapter shares besides the retry loop: its injected
 * dependencies, its descriptor, and its HTTP plumbing.
 *
 * `fetch` rather than the hand-written `node:http` transport `@zeddev/storage`
 * uses. That transport exists because SigV4 signs an exact header set and `fetch`
 * adds its own underneath a signature; neither AI upstream signs requests, so the
 * reason does not carry over, and `fetch` already gives both things this port
 * needs — an abort signal that covers a stalled body as well as a stalled connect,
 * and native multipart for audio uploads.
 */

import { exponentialBackoff, SystemClock, type Backoff, type Clock } from '@zeddev/time';
import { malformedResponse, parseRetryAfter, readErrorBody, type AttemptOutcome, type AttemptPolicy } from './attempts.ts';
import type { AiProviderDescriptor, AiSettings } from './types.ts';

export interface AdapterDependencies {
  readonly clock?: Clock | undefined;
  /** Delay between attempts. Defaults to `DEFAULT_AI_BACKOFF`. */
  readonly backoff?: Backoff | undefined;
  readonly fetch?: typeof fetch | undefined;
}

/**
 * Half a second doubling to eight, fully jittered. A free-tier rate limit is
 * per-minute, so the curve's job is to get a reply out inside the window a customer
 * will wait for one, not to ride out a long outage — that is what the queue's own,
 * much longer, retry is for.
 */
export const DEFAULT_AI_BACKOFF: Backoff = exponentialBackoff({ baseMs: 500, maxMs: 8_000 });

export class AdapterCore {
  readonly settings: AiSettings;
  readonly descriptor: AiProviderDescriptor;
  readonly clock: Clock;
  readonly #backoff: Backoff;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(settings: AiSettings, deps: AdapterDependencies) {
    this.settings = settings;
    this.clock = deps.clock ?? new SystemClock();
    this.#backoff = deps.backoff ?? DEFAULT_AI_BACKOFF;
    this.#fetch = deps.fetch ?? fetch;
    this.#baseUrl = settings.baseUrl.replace(/\/+$/, '');
    this.descriptor = Object.freeze({
      provider: settings.provider,
      model: settings.model,
      transcriptionModel: settings.transcriptionModel === '' ? settings.model : settings.transcriptionModel,
      capabilities: Object.freeze([...settings.capabilities]),
    });
  }

  url(path: string): URL {
    return new URL(`${this.#baseUrl}${path}`);
  }

  policy(operation: 'generate' | 'transcribe'): AttemptPolicy {
    return {
      provider: this.settings.provider,
      operation,
      maxAttempts: this.settings.maxAttempts,
      timeoutMs: this.settings.requestTimeoutMs,
      clock: this.clock,
      backoff: this.#backoff,
    };
  }

  /**
   * One HTTP exchange. A non-2xx becomes a failed outcome carrying the status, the
   * `Retry-After`, and whatever code `readCode` can find in the error body; a 2xx
   * becomes its parsed JSON, or a malformed-response error if it has none.
   */
  async exchange(
    url: URL,
    init: { readonly headers: Record<string, string>; readonly body: string | FormData },
    signal: AbortSignal,
    operation: string,
    readCode: (errorBody: unknown) => { status?: number | undefined; code: string | undefined },
  ): Promise<AttemptOutcome<unknown>> {
    const response = await this.#fetch(url, { method: 'POST', headers: init.headers, body: init.body, signal });
    if (!response.ok) {
      const { status, code } = readCode(await readErrorBody(response));
      return {
        ok: false,
        status: status ?? response.status,
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), this.clock.now()),
        providerCode: code,
      };
    }
    try {
      return { ok: true, value: (await response.json()) as unknown };
    } catch (error) {
      // A body cut off by our own timeout is a timeout, not a malformed response.
      if (signal.aborted) throw error;
      throw malformedResponse(this.settings.provider, operation);
    }
  }
}

export function base64(data: Uint8Array): string {
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}
