/**
 * The AI provider port.
 *
 * This file is the whole contract between the platform and whichever model is
 * generating replies. `ai-provider-portability.md` requires that swapping the
 * provider need no change to "behavior-defining code", and the only way that holds
 * is if behaviour-defining code can see nothing but this file: no provider name in
 * a request, no provider-shaped field in a result, no vendor type leaking through.
 *
 * What the port deliberately does not own:
 *
 *   - **What to say.** `instructions` arrive already rendered. Persona, rules,
 *     disclosure, handoff, and knowledge are rendered by `@zeddev/bot`; a provider
 *     adapter that added its own sentence would make the bot behave differently per
 *     provider, which is exactly the AC2 drift the spec forbids.
 *   - **Which customer or tenant.** No request carries a tenant id. The provider is
 *     a platform-wide selection (AC6), so there is nothing for one to select on,
 *     and a tenant id sent to a third party is data that did not need to leave.
 *   - **Fallback.** A failure is thrown as an `ai_generation` error and the reply
 *     path decides. The port never substitutes text of its own, because
 *     `fallback-response-behavior.md` requires fallback text be the client's own
 *     words, sent verbatim.
 */

import type { Secret } from '@zeddev/secrets';

/**
 * What a configured model can do.
 *
 * Declared by the operator, not discovered: a model's capabilities are a property
 * of the model, which an adapter cannot probe without spending quota, and
 * `ai-provider-portability.md` makes a capability gap after a swap "the operator's
 * decision to accept". Declaring it is how that decision is written down — and how
 * the reply path learns to route an image to fallback instead of into a request the
 * model will reject.
 */
export const AI_CAPABILITIES = ['text', 'vision', 'audio'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/**
 * Every provider the platform can be pointed at. Adding a name here without an
 * entry in `AI_PROVIDERS` (registry.ts) is a type error.
 */
export const AI_PROVIDER_NAMES = ['gemini', 'openai_compatible'] as const;
export type AiProviderName = (typeof AI_PROVIDER_NAMES)[number];

/**
 * Image types the port accepts: the intersection of what both adapters' upstreams
 * take inline. An intersection rather than a union so that a swap cannot turn an
 * image that worked yesterday into a rejection today (AC3).
 */
export const AI_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AiImageMediaType = (typeof AI_IMAGE_MEDIA_TYPES)[number];

/**
 * Audio types the port accepts, on the same intersection rule. A WhatsApp voice
 * note is `audio/ogg` (Opus), which is the case that matters; other WhatsApp audio
 * types (AMR, AAC, MP4) are not accepted by every upstream and are refused here
 * rather than by one provider and not the other.
 */
export const AI_AUDIO_MEDIA_TYPES = ['audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/flac'] as const;
export type AiAudioMediaType = (typeof AI_AUDIO_MEDIA_TYPES)[number];

/**
 * Upper bound on the media bytes in one request.
 *
 * Media travels inline and base64 inflates it by a third; the smallest inline limit
 * among the supported upstreams is 20 MB per request, and 15 MiB of raw bytes stays
 * under it after encoding. Refusing here gives the reply path one predictable
 * rejection instead of a provider-specific one.
 */
export const MAX_REQUEST_MEDIA_BYTES = 15 * 1024 * 1024;

/** Output bound used when a request names none. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImagePart {
  readonly type: 'image';
  readonly mediaType: AiImageMediaType;
  readonly data: Uint8Array;
}

export type CustomerPart = TextPart | ImagePart;

/**
 * One side's contribution to the conversation.
 *
 * Only the customer sends images; what the bot said is always text. That asymmetry
 * is enforced by the type rather than by a runtime check, because an adapter asked
 * to put an image in the model's own turn has no faithful encoding for it.
 */
export type ConversationTurn =
  | { readonly role: 'customer'; readonly parts: readonly CustomerPart[] }
  | { readonly role: 'bot'; readonly text: string };

export interface GenerationRequest {
  /** The rendered system instructions. Sent unchanged. */
  readonly instructions: string;
  /** Oldest first. The last turn must be the customer's. */
  readonly turns: readonly ConversationTurn[];
  readonly maxOutputTokens?: number | undefined;
  /** In `[0, 2]`. Omitted means the provider's default. */
  readonly temperature?: number | undefined;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface GenerationResult {
  readonly text: string;
  /**
   * The model stopped at the output bound rather than finishing. Returned rather
   * than thrown: a truncated reply may still be usable, and whether it is belongs
   * to the reply path, not the transport.
   */
  readonly truncated: boolean;
  /**
   * Reported by the provider when it reports it. `cost-efficient-operation.md`
   * requires cost be explainable by usage, and this is the usage.
   */
  readonly usage: TokenUsage | undefined;
}

export interface AudioInput {
  readonly mediaType: AiAudioMediaType;
  readonly data: Uint8Array;
}

export interface TranscriptionRequest {
  readonly audio: AudioInput;
  /**
   * The language the speaker is expected to use, as a BCP 47 tag (`pt-BR`, `en`).
   * A hint, not a filter: `voice-message-understanding.md` still wants the words
   * if the customer speaks another language.
   */
  readonly languageHint?: string | undefined;
}

export interface TranscriptionResult {
  /** Empty when the audio held no intelligible speech. That is an answer, not a failure. */
  readonly text: string;
  readonly usage: TokenUsage | undefined;
}

export interface AiCallOptions {
  /** Aborts the call, including any backoff wait between attempts. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Which provider and model is active.
 *
 * `ai-provider-portability.md` AC8 requires the operator be able to tell. It carries
 * no credential and no endpoint: the base URL can embed a tenant of a hosted
 * gateway, and neither is needed to answer "which model is answering".
 */
export interface AiProviderDescriptor {
  readonly provider: AiProviderName | 'memory';
  readonly model: string;
  /** The model used for `transcribe`, when it differs from `model`. */
  readonly transcriptionModel: string;
  readonly capabilities: readonly AiCapability[];
}

export interface AiProvider {
  readonly descriptor: AiProviderDescriptor;
  supports(capability: AiCapability): boolean;
  /**
   * Generate the bot's next reply.
   *
   * Throws `AiGenerationError` (retryable) or `AiRequestRejectedError` (not) —
   * both `kind: 'ai_generation'`, which is what fallback routes on. Transient
   * upstream failures are retried inside the call, up to the configured attempts;
   * a thrown retryable error means those attempts are spent.
   */
  generate(request: GenerationRequest, options?: AiCallOptions): Promise<GenerationResult>;
  /** Transcribe a voice note. Requires the `audio` capability. Same error contract as `generate`. */
  transcribe(request: TranscriptionRequest, options?: AiCallOptions): Promise<TranscriptionResult>;
}

/** Everything an adapter needs, whichever adapter it is. Built from the environment by `loadAiSettings`. */
export interface AiSettings {
  readonly provider: AiProviderName;
  /** The API root, e.g. `…/v1beta` for Gemini or `…/v1` for an OpenAI-compatible server. */
  readonly baseUrl: string;
  /** Empty means send no credential, which is correct for a local model server and nothing else. */
  readonly apiKey: Secret<string>;
  readonly model: string;
  /** Empty means transcribe with `model`. */
  readonly transcriptionModel: string;
  readonly capabilities: readonly AiCapability[];
  readonly requestTimeoutMs: number;
  readonly maxAttempts: number;
}
