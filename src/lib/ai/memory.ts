/**
 * The in-memory AI provider, and the scripted backend it shares with the HTTP stubs.
 *
 * `ScriptedBackend` is "the model" as a test sees it: a queue of outcomes to
 * produce, and a record of every request it was shown, in the port's own
 * vocabulary. The fake consults it in-process; the HTTP stubs in `stubs.ts` decode
 * each adapter's wire format back into the same vocabulary before consulting it.
 * That is what lets one conformance suite state "the model saw exactly this
 * conversation" and have it mean the same thing for all three.
 *
 * The fake is not an imitation of the adapters' retry and classification
 * behaviour: it reports each scripted failure as the HTTP status a real upstream
 * would send and goes through the same `runAttempts` loop, so it retries, gives up,
 * and classifies for the same reasons they do.
 */

import { SystemClock, type Backoff, type Clock } from '@zeddev/time';
import { contentFiltered, emptyResponse, runAttempts, type AttemptOutcome } from './attempts.ts';
import { normalizeGeneration, normalizeTranscription } from './request.ts';
import {
  AI_CAPABILITIES,
  type AiCallOptions,
  type AiCapability,
  type AiProvider,
  type AiProviderDescriptor,
  type GenerationRequest,
  type GenerationResult,
  type TokenUsage,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.ts';

/**
 * Failures a test can ask the model for. Each one is something a real upstream
 * actually does, and the stubs produce each in that upstream's real wire shape.
 */
export const SCRIPTED_FAILURES = [
  'rate_limited',
  'unavailable',
  'unauthorized',
  'not_found',
  'rejected',
  'filtered',
  'stall',
  'unreachable',
] as const;
export type ScriptedFailure = (typeof SCRIPTED_FAILURES)[number];

export type ScriptedOutcome =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly truncated?: boolean | undefined;
      readonly usage?: TokenUsage | undefined;
    }
  | { readonly kind: 'failure'; readonly failure: ScriptedFailure; readonly retryAfterMs?: number | undefined };

export type ObservedPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly mediaType: string; readonly data: Buffer };

export interface ObservedGeneration {
  readonly operation: 'generate';
  readonly model: string;
  readonly instructions: string;
  readonly turns: readonly { readonly role: 'customer' | 'bot'; readonly parts: readonly ObservedPart[] }[];
  readonly maxOutputTokens: number;
  readonly temperature: number | undefined;
}

export interface ObservedTranscription {
  readonly operation: 'transcribe';
  readonly model: string;
  readonly mediaType: string;
  readonly data: Buffer;
  /** As the upstream received it — a full tag for Gemini, an ISO 639-1 code for Whisper-style servers. */
  readonly languageHint: string | undefined;
}

export type ObservedRequest = ObservedGeneration | ObservedTranscription;

/** What the model replies when nothing was scripted. */
export const DEFAULT_SCRIPTED_REPLY = 'Scripted reply.';

export class ScriptedBackend {
  readonly #queue: ScriptedOutcome[] = [];
  readonly #requests: ObservedRequest[] = [];
  readonly #reply: (request: ObservedRequest) => string;

  constructor(reply?: (request: ObservedRequest) => string) {
    this.#reply = reply ?? ((): string => DEFAULT_SCRIPTED_REPLY);
  }

  /** Queue outcomes for the next requests, one each, in order. */
  script(...outcomes: ScriptedOutcome[]): void {
    this.#queue.push(...outcomes);
  }

  /** Every request the model was shown, oldest first. A retried call appears once per attempt. */
  get requests(): readonly ObservedRequest[] {
    return this.#requests;
  }

  /** Record a request and decide what to answer it with. */
  receive(request: ObservedRequest): ScriptedOutcome {
    this.#requests.push(request);
    return this.#queue.shift() ?? { kind: 'text', text: this.#reply(request) };
  }
}

/** The HTTP status each scripted failure arrives as. The stubs send exactly these. */
export const SCRIPTED_FAILURE_STATUS: Readonly<Record<Exclude<ScriptedFailure, 'filtered' | 'stall' | 'unreachable'>, number>> = {
  rate_limited: 429,
  unavailable: 503,
  unauthorized: 401,
  not_found: 404,
  rejected: 400,
};

export interface InMemoryAiProviderOptions {
  readonly capabilities?: readonly AiCapability[] | undefined;
  readonly model?: string | undefined;
  readonly maxAttempts?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly clock?: Clock | undefined;
  /** Defaults to no delay, so a test that scripts a retry does not wait for it. */
  readonly backoff?: Backoff | undefined;
  /** Reply to anything not scripted. Defaults to `DEFAULT_SCRIPTED_REPLY`. */
  readonly reply?: ((request: ObservedRequest) => string) | undefined;
}

export class InMemoryAiProvider implements AiProvider {
  readonly descriptor: AiProviderDescriptor;
  readonly backend: ScriptedBackend;
  readonly #maxAttempts: number;
  readonly #timeoutMs: number;
  readonly #clock: Clock;
  readonly #backoff: Backoff;

  constructor(options: InMemoryAiProviderOptions = {}) {
    const model = options.model ?? 'memory-model';
    this.descriptor = Object.freeze({
      provider: 'memory',
      model,
      transcriptionModel: model,
      capabilities: Object.freeze([...(options.capabilities ?? AI_CAPABILITIES)]),
    });
    this.backend = new ScriptedBackend(options.reply);
    this.#maxAttempts = options.maxAttempts ?? 3;
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#clock = options.clock ?? new SystemClock();
    this.#backoff = options.backoff ?? ((): number => 0);
  }

  supports(capability: AiCapability): boolean {
    return this.descriptor.capabilities.includes(capability);
  }

  async generate(request: GenerationRequest, options?: AiCallOptions): Promise<GenerationResult> {
    const normalized = normalizeGeneration(request, this.descriptor.capabilities, 'memory');
    const outcome = await runAttempts(this.#policy('generate'), options?.signal, (signal) =>
      this.#attempt(
        {
          operation: 'generate',
          model: this.descriptor.model,
          instructions: normalized.instructions,
          turns: normalized.turns.map((turn) => ({
            role: turn.role,
            parts: turn.parts.map((part): ObservedPart =>
              part.type === 'text' ? part : { type: 'image', mediaType: part.mediaType, data: Buffer.from(part.data) },
            ),
          })),
          maxOutputTokens: normalized.maxOutputTokens,
          temperature: normalized.temperature,
        },
        signal,
      ),
    );
    if (outcome.text.trim() === '') throw emptyResponse('memory', 'generate');
    return { text: outcome.text, truncated: outcome.truncated ?? false, usage: outcome.usage };
  }

  async transcribe(request: TranscriptionRequest, options?: AiCallOptions): Promise<TranscriptionResult> {
    const normalized = normalizeTranscription(request, this.descriptor.capabilities, 'memory');
    const outcome = await runAttempts(this.#policy('transcribe'), options?.signal, (signal) =>
      this.#attempt(
        {
          operation: 'transcribe',
          model: this.descriptor.transcriptionModel,
          mediaType: normalized.audio.mediaType,
          data: Buffer.from(normalized.audio.data),
          languageHint: normalized.languageHint,
        },
        signal,
      ),
    );
    return { text: outcome.text.trim(), usage: outcome.usage };
  }

  #policy(operation: 'generate' | 'transcribe'): Parameters<typeof runAttempts>[0] {
    return {
      provider: 'memory',
      operation,
      maxAttempts: this.#maxAttempts,
      timeoutMs: this.#timeoutMs,
      clock: this.#clock,
      backoff: this.#backoff,
    };
  }

  async #attempt(
    request: ObservedRequest,
    signal: AbortSignal,
  ): Promise<AttemptOutcome<Extract<ScriptedOutcome, { kind: 'text' }>>> {
    const outcome = this.backend.receive(request);
    if (outcome.kind === 'text') return { ok: true, value: outcome };
    switch (outcome.failure) {
      case 'filtered':
        throw contentFiltered('memory', request.operation, 'SAFETY');
      case 'stall':
        // Hold until the attempt is aborted — by its timeout or by the caller —
        // exactly as a real request to a wedged upstream would.
        await new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason);
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        throw new Error('unreachable');
      case 'unreachable':
        throw new Error('connection refused');
      default:
        return { ok: false, status: SCRIPTED_FAILURE_STATUS[outcome.failure], retryAfterMs: outcome.retryAfterMs };
    }
  }
}
