/**
 * `@zeddev/ai` — the AI provider port, and the adapters that make it swappable.
 *
 * What it owns: turning a rendered prompt and a conversation into a reply, and a
 * voice note into its words, through whichever provider the operator configured —
 * with one definition of what a valid request is, what is retried, and what a
 * failure means, shared by every adapter.
 *
 * What it does not own: what the bot says (`@zeddev/bot` renders instructions),
 * which tenant is speaking (no request carries one), and what happens when a call
 * fails (the reply path falls back, per `fallback-response-behavior.md`).
 *
 * Import `InMemoryAiProvider` from `@zeddev/ai/testing`, never from here.
 */

export { AdapterCore, DEFAULT_AI_BACKOFF, type AdapterDependencies } from './adapter.ts';
export { MAX_ERROR_BODY_BYTES, MAX_RETRY_WAIT_MS, parseRetryAfter, runAttempts, safeProviderCode, type AttemptOutcome, type AttemptPolicy } from './attempts.ts';
export {
  AI_CANDIDATE_CONFIG_SCHEMA,
  AI_CONFIG_SCHEMA,
  loadAiCandidateSettings,
  loadAiConfig,
  loadAiSettings,
  type AiCandidateConfig,
  type AiConfig,
} from './config.ts';
export { GEMINI_TRANSCRIPTION_INSTRUCTIONS, GeminiProvider, geminiTranscriptionPrompt } from './gemini.ts';
export { OpenAiCompatibleProvider } from './openai.ts';
export { AI_PROVIDERS, createAiProvider, type ProviderEntry } from './registry.ts';
export {
  audioMediaType,
  imageMediaType,
  normalizeGeneration,
  normalizeTranscription,
  type NormalizedGeneration,
  type NormalizedTranscription,
  type NormalizedTurn,
} from './request.ts';
export {
  AI_AUDIO_MEDIA_TYPES,
  AI_CAPABILITIES,
  AI_IMAGE_MEDIA_TYPES,
  AI_PROVIDER_NAMES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_REQUEST_MEDIA_BYTES,
  type AiAudioMediaType,
  type AiCallOptions,
  type AiCapability,
  type AiImageMediaType,
  type AiProvider,
  type AiProviderDescriptor,
  type AiProviderName,
  type AiSettings,
  type AudioInput,
  type ConversationTurn,
  type CustomerPart,
  type GenerationRequest,
  type GenerationResult,
  type ImagePart,
  type TextPart,
  type TokenUsage,
  type TranscriptionRequest,
  type TranscriptionResult,
} from './types.ts';
