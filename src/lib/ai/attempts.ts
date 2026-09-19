/**
 * The retry loop and failure classification, shared by every adapter and the fake.
 *
 * Shared for the same reason `request.ts` is: whether a 429 is retried, how long a
 * timeout is, and which failures reach the reply path as "try again later" versus
 * "this will never work" must not depend on which provider is configured. Each
 * adapter supplies only one attempt — encode, send, decode — and reports a failed
 * attempt as an HTTP status; everything after that is decided here, once.
 *
 * The fake reports its scripted failures as the same statuses and runs through
 * this same loop, so the conformance suite's retry assertions hold for it for the
 * same reason they hold for the real adapters, rather than by imitation.
 */

import { AiGenerationError, AiRequestRejectedError, ZedError } from '@zeddev/errors';
import type { Backoff, Clock } from '@zeddev/time';

export type AttemptOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      /**
       * The HTTP status the failure is judged by. An adapter whose upstream reports
       * a condition under a misleading status (Gemini answers a bad API key with
       * 400) reports the status that condition means, so the loop needs no
       * provider-specific branch.
       */
      readonly status: number;
      readonly retryAfterMs?: number | undefined;
      /** The upstream's machine-readable error code, if it gave one. Never its message. */
      readonly providerCode?: string | undefined;
    };

export interface AttemptPolicy {
  readonly provider: string;
  readonly operation: 'generate' | 'transcribe';
  readonly maxAttempts: number;
  readonly timeoutMs: number;
  readonly clock: Clock;
  readonly backoff: Backoff;
}

/**
 * The longest `Retry-After` the loop will honour inside one call.
 *
 * A free-tier quota answers 429 both for "too many this minute" and "none left
 * today", and only the headers tell them apart. Waiting out the first keeps the
 * reply; waiting out the second holds a worker for hours while the customer hears
 * nothing. Beyond this, the call fails now and the reply path falls back.
 */
export const MAX_RETRY_WAIT_MS = 20_000;

/** How much of an error body is read to find its code. Error bodies are small; one that is not is not an error body. */
export const MAX_ERROR_BODY_BYTES = 16 * 1024;

const TRANSIENT_STATUSES = new Set([408, 425, 429]);

class AttemptTimedOut extends Error {}

export async function runAttempts<T>(
  policy: AttemptPolicy,
  callerSignal: AbortSignal | undefined,
  attempt: (signal: AbortSignal) => Promise<AttemptOutcome<T>>,
): Promise<T> {
  for (let n = 1; ; n += 1) {
    callerSignal?.throwIfAborted();
    const failure = await once(policy, callerSignal, attempt);
    if (failure.ok) return failure.value;

    const transient = failure.status === 0 || failure.status >= 500 || TRANSIENT_STATUSES.has(failure.status);
    const context = {
      operation: policy.operation,
      status: failure.status === 0 ? null : failure.status,
      attempts: n,
      providerCode: failure.providerCode ?? null,
      retryAfterMs: failure.retryAfterMs ?? null,
    };

    if (!transient) {
      throw new AiRequestRejectedError('The AI provider rejected the request', {
        code: rejectionCode(failure.status),
        provider: policy.provider,
        context,
      });
    }

    const exhausted = n >= policy.maxAttempts;
    const tooLong = failure.retryAfterMs !== undefined && failure.retryAfterMs > MAX_RETRY_WAIT_MS;
    if (exhausted || tooLong) {
      throw new AiGenerationError('The AI provider did not produce a response', {
        code: failure.code,
        provider: policy.provider,
        context,
      });
    }

    const wait = Math.max(policy.backoff(n), failure.retryAfterMs ?? 0);
    await policy.clock.sleep(wait, { signal: callerSignal });
  }
}

type Failure = { ok: false; status: number; code: string; retryAfterMs?: number | undefined; providerCode?: string | undefined };

async function once<T>(
  policy: AttemptPolicy,
  callerSignal: AbortSignal | undefined,
  attempt: (signal: AbortSignal) => Promise<AttemptOutcome<T>>,
): Promise<{ ok: true; value: T } | Failure> {
  // The timeout runs on the injected clock rather than `AbortSignal.timeout`, so a
  // test holding a FakeClock decides when a stalled provider has stalled for too
  // long, the same way it decides when a backoff has elapsed.
  const controller = new AbortController();
  const cancelTimer = policy.clock.setTimer(policy.timeoutMs, () => controller.abort(new AttemptTimedOut()));
  const onCallerAbort = (): void => controller.abort(callerSignal?.reason);
  callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  try {
    const outcome = await attempt(controller.signal);
    if (outcome.ok) return outcome;
    return {
      ok: false,
      status: outcome.status,
      code: outcome.status === 429 ? 'ai.rate_limited' : 'ai.unavailable',
      retryAfterMs: outcome.retryAfterMs,
      providerCode: outcome.providerCode,
    };
  } catch (error) {
    if (callerSignal?.aborted) throw callerSignal.reason;
    if (controller.signal.reason instanceof AttemptTimedOut) {
      return { ok: false, status: 0, code: 'ai.timeout' };
    }
    // A decoding failure the adapter already classified is final, not a network blip.
    if (error instanceof ZedError) throw error;
    // Anything else is the request not completing: refused connection, reset, DNS.
    return { ok: false, status: 0, code: 'ai.unreachable' };
  } finally {
    cancelTimer();
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
}

function rejectionCode(status: number): string {
  if (status === 401 || status === 403) return 'ai.unauthorized';
  if (status === 404) return 'ai.not_found';
  return 'ai.request_rejected';
}

/** `Retry-After` as delay-seconds or an HTTP date. Anything else is ignored rather than guessed at. */
export function parseRetryAfter(header: string | null, now: Date): number | undefined {
  if (header === null) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now.getTime());
}

/**
 * An upstream error code, if it is shaped like one.
 *
 * Providers' error *messages* routinely quote the request back — "invalid value at
 * contents[1].parts[0]: '<the customer's words>'" — so they are never read. Codes
 * are enum-like; anything not shaped like one is dropped rather than risk carrying
 * content into an operator-visible diagnostic.
 */
export function safeProviderCode(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') return undefined;
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

/** Read a bounded error body and parse it as JSON, or `undefined`. */
export async function readErrorBody(response: Response): Promise<unknown> {
  try {
    const text = await response.text();
    if (text.length > MAX_ERROR_BODY_BYTES) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** A 2xx body that is not the shape the provider documents. Retryable: a gateway mid-deploy produces these. */
export function malformedResponse(provider: string, operation: string): AiGenerationError {
  return new AiGenerationError('The AI provider returned a response that could not be read', {
    code: 'ai.malformed_response',
    provider,
    context: { operation },
  });
}

export function emptyResponse(provider: string, operation: string): AiGenerationError {
  return new AiGenerationError('The AI provider returned no text', {
    code: 'ai.empty_response',
    provider,
    context: { operation },
  });
}

/**
 * The provider withheld its reply on content grounds. Not retried: the same
 * conversation will be withheld again, and the customer is better served by the
 * client's fallback now than by the same refusal three times.
 */
export function contentFiltered(provider: string, operation: string, providerCode: string | undefined): AiRequestRejectedError {
  return new AiRequestRejectedError('The AI provider withheld its response', {
    code: 'ai.content_filtered',
    provider,
    context: { operation, providerCode: providerCode ?? null },
  });
}
