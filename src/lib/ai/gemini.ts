/**
 * The Google Gemini adapter (`generateContent`).
 *
 * The platform's default provider (IMPLEMENTATION_PLAN.md §2): its free tier covers
 * text, images, and audio in one provider, which is what lets
 * `cost-efficient-operation.md` hold with a single upstream.
 *
 * Transcription is a `generateContent` call too — Gemini has no separate speech
 * endpoint — with an instruction to transcribe and nothing else. Its wording is
 * fixed here rather than configurable, because it is part of how this adapter
 * speaks the port, not part of any tenant's bot.
 */

import type { AiProvider, AiCallOptions, AiCapability, AiProviderDescriptor, AiSettings, GenerationRequest, GenerationResult, TokenUsage, TranscriptionRequest, TranscriptionResult } from './types.ts';
import { AdapterCore, base64, type AdapterDependencies } from './adapter.ts';
import { asRecord, contentFiltered, emptyResponse, malformedResponse, runAttempts, safeProviderCode, tokenCount } from './attempts.ts';
import { normalizeGeneration, normalizeTranscription, type NormalizedTurn } from './request.ts';

/** Finish and block reasons meaning the provider withheld content, as opposed to failing to produce it. */
const WITHHELD = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY', 'OTHER_BLOCK']);

export const GEMINI_TRANSCRIPTION_INSTRUCTIONS =
  'You transcribe voice messages. Output only the words spoken in the audio, verbatim, in the language they ' +
  'were spoken in. Do not add a preamble, labels, speaker names, timestamps, translations, or commentary. ' +
  'If the audio contains no intelligible speech, output nothing.';

export function geminiTranscriptionPrompt(languageHint: string | undefined): string {
  return languageHint === undefined
    ? 'Transcribe this voice message.'
    : `Transcribe this voice message. The speaker is expected to use the language with BCP 47 tag "${languageHint}", but transcribe whatever language is actually spoken.`;
}

export class GeminiProvider implements AiProvider {
  readonly #core: AdapterCore;

  constructor(settings: AiSettings, deps: AdapterDependencies = {}) {
    this.#core = new AdapterCore(settings, deps);
  }

  get descriptor(): AiProviderDescriptor {
    return this.#core.descriptor;
  }

  supports(capability: AiCapability): boolean {
    return this.#core.descriptor.capabilities.includes(capability);
  }

  async generate(request: GenerationRequest, options?: AiCallOptions): Promise<GenerationResult> {
    const normalized = normalizeGeneration(request, this.#core.descriptor.capabilities, 'gemini');
    const body = {
      systemInstruction: { parts: [{ text: normalized.instructions }] },
      contents: normalized.turns.map(encodeTurn),
      generationConfig: {
        candidateCount: 1,
        maxOutputTokens: normalized.maxOutputTokens,
        ...(normalized.temperature === undefined ? {} : { temperature: normalized.temperature }),
      },
    };
    const json = await this.#call('generate', this.#core.descriptor.model, body, options);
    const decoded = decode(json, 'generate');
    if (decoded.text.trim() === '') throw emptyResponse('gemini', 'generate');
    return decoded;
  }

  async transcribe(request: TranscriptionRequest, options?: AiCallOptions): Promise<TranscriptionResult> {
    const normalized = normalizeTranscription(request, this.#core.descriptor.capabilities, 'gemini');
    const body = {
      systemInstruction: { parts: [{ text: GEMINI_TRANSCRIPTION_INSTRUCTIONS }] },
      contents: [
        {
          role: 'user',
          parts: [
            { text: geminiTranscriptionPrompt(normalized.languageHint) },
            { inlineData: { mimeType: normalized.audio.mediaType, data: base64(normalized.audio.data) } },
          ],
        },
      ],
      generationConfig: { candidateCount: 1, temperature: 0 },
    };
    const json = await this.#call('transcribe', this.#core.descriptor.transcriptionModel, body, options);
    const decoded = decode(json, 'transcribe');
    return { text: decoded.text.trim(), usage: decoded.usage };
  }

  #call(operation: 'generate' | 'transcribe', model: string, body: unknown, options: AiCallOptions | undefined): Promise<unknown> {
    const core = this.#core;
    // The key travels in a header, never as the `?key=` query parameter Google's
    // examples use: a URL is what access logs, proxies, and error traces record.
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    const key = core.settings.apiKey.expose();
    if (key !== '') headers['x-goog-api-key'] = key;
    const url = core.url(`/models/${encodeURIComponent(model)}:generateContent`);
    const payload = JSON.stringify(body);
    return runAttempts(core.policy(operation), options?.signal, (signal) =>
      core.exchange(url, { headers, body: payload }, signal, operation, readGeminiError),
    );
  }
}

function encodeTurn(turn: NormalizedTurn): unknown {
  return {
    role: turn.role === 'customer' ? 'user' : 'model',
    parts: turn.parts.map((part) =>
      part.type === 'text' ? { text: part.text } : { inlineData: { mimeType: part.mediaType, data: base64(part.data) } },
    ),
  };
}

/**
 * `{ error: { code, status, details: [{ reason }] } }`. Gemini reports an invalid
 * API key as 400 `INVALID_ARGUMENT` with reason `API_KEY_INVALID`; reported here as
 * the 401 it means, so the operator sees `ai.unauthorized` — a credential to fix —
 * rather than `ai.request_rejected`, which points at the code.
 */
function readGeminiError(body: unknown): { status?: number | undefined; code: string | undefined } {
  const error = asRecord(asRecord(body)?.['error']);
  const details = Array.isArray(error?.['details']) ? (error['details'] as unknown[]) : [];
  const reason = details.map((d) => safeProviderCode(asRecord(d)?.['reason'])).find((r) => r !== undefined);
  const code = reason ?? safeProviderCode(error?.['status']);
  return { status: reason === 'API_KEY_INVALID' ? 401 : undefined, code };
}

function decode(json: unknown, operation: 'generate' | 'transcribe'): GenerationResult {
  const root = asRecord(json);
  if (root === undefined) throw malformedResponse('gemini', operation);

  const candidates = root['candidates'];
  if (!Array.isArray(candidates) || candidates.length === 0) {
    const blockReason = asRecord(root['promptFeedback'])?.['blockReason'];
    if (blockReason !== undefined) throw contentFiltered('gemini', operation, safeProviderCode(blockReason));
    throw emptyResponse('gemini', operation);
  }

  const candidate = asRecord(candidates[0]);
  if (candidate === undefined) throw malformedResponse('gemini', operation);
  const finishReason = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : undefined;
  if (finishReason !== undefined && WITHHELD.has(finishReason)) {
    throw contentFiltered('gemini', operation, safeProviderCode(finishReason));
  }

  const parts = asRecord(candidate['content'])?.['parts'];
  const text = Array.isArray(parts)
    ? parts
        .map((p) => asRecord(p))
        // A thinking model may return its reasoning as parts marked `thought`; it is
        // not the reply and must never reach a customer.
        .filter((p) => p !== undefined && p['thought'] !== true && typeof p['text'] === 'string')
        .map((p) => p!['text'] as string)
        .join('')
    : '';

  return { text, truncated: finishReason === 'MAX_TOKENS', usage: usage(root['usageMetadata']) };
}

function usage(value: unknown): TokenUsage | undefined {
  const meta = asRecord(value);
  const input = tokenCount(meta?.['promptTokenCount']);
  const output = tokenCount(meta?.['candidatesTokenCount']);
  if (input === undefined || output === undefined) return undefined;
  // Reasoning tokens are billed as output, so they count toward usage even though
  // they never reach the customer.
  return { inputTokens: input, outputTokens: output + (tokenCount(meta?.['thoughtsTokenCount']) ?? 0) };
}
