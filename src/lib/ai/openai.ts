/**
 * The OpenAI-compatible adapter (`/chat/completions` and `/audio/transcriptions`).
 *
 * The second adapter IMPLEMENTATION_PLAN.md §2 asks for early, because
 * `ai-provider-portability.md` is unfalsifiable with one: a port with a single
 * implementation takes that implementation's shape without anyone noticing. This
 * wire format is the one most of the alternatives speak — OpenAI itself, Groq's
 * free tier, OpenRouter, and a local Ollama or llama.cpp server on a laptop with no
 * key at all — so the one adapter is several providers, chosen by `AI_BASE_URL`.
 *
 * `max_tokens` rather than OpenAI's newer `max_completion_tokens`: the compatible
 * servers this adapter exists for accept the former and not all accept the latter.
 */

import type { AiProvider, AiCallOptions, AiCapability, AiProviderDescriptor, AiSettings, AiAudioMediaType, GenerationRequest, GenerationResult, TokenUsage, TranscriptionRequest, TranscriptionResult } from './types.ts';
import { AdapterCore, base64, type AdapterDependencies } from './adapter.ts';
import { asRecord, contentFiltered, emptyResponse, malformedResponse, runAttempts, safeProviderCode, tokenCount } from './attempts.ts';
import { normalizeGeneration, normalizeTranscription, type NormalizedTurn } from './request.ts';

/**
 * Whisper-family servers infer the container from the file name's extension, not
 * from the part's content type, so the name has to be right.
 */
const AUDIO_FILE_NAMES: Readonly<Record<AiAudioMediaType, string>> = {
  'audio/ogg': 'voice.ogg',
  'audio/mpeg': 'voice.mp3',
  'audio/wav': 'voice.wav',
  'audio/flac': 'voice.flac',
};

export class OpenAiCompatibleProvider implements AiProvider {
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
    const normalized = normalizeGeneration(request, this.#core.descriptor.capabilities, 'openai_compatible');
    const body = JSON.stringify({
      model: this.#core.descriptor.model,
      messages: [{ role: 'system', content: normalized.instructions }, ...normalized.turns.map(encodeTurn)],
      max_tokens: normalized.maxOutputTokens,
      n: 1,
      stream: false,
      ...(normalized.temperature === undefined ? {} : { temperature: normalized.temperature }),
    });
    const json = await this.#call('generate', '/chat/completions', body, { 'content-type': 'application/json' }, options);
    return decodeChat(json);
  }

  async transcribe(request: TranscriptionRequest, options?: AiCallOptions): Promise<TranscriptionResult> {
    const normalized = normalizeTranscription(request, this.#core.descriptor.capabilities, 'openai_compatible');
    const { mediaType, data } = normalized.audio;
    const json = await this.#call(
      'transcribe',
      '/audio/transcriptions',
      // Built per attempt: a FormData body is a stream, and a retried stream is an empty one.
      () => {
        const form = new FormData();
        form.append('file', new Blob([Buffer.from(data.buffer, data.byteOffset, data.byteLength)], { type: mediaType }), AUDIO_FILE_NAMES[mediaType]);
        form.append('model', this.#core.descriptor.transcriptionModel);
        form.append('response_format', 'json');
        form.append('temperature', '0');
        // Whisper takes ISO 639-1 only; a region subtag or a three-letter code is not a hint it understands.
        const language = normalized.languageHint?.split('-')[0]?.toLowerCase();
        if (language !== undefined && language.length === 2) form.append('language', language);
        return form;
      },
      {},
      options,
    );
    const root = asRecord(json);
    if (root === undefined || typeof root['text'] !== 'string') throw malformedResponse('openai_compatible', 'transcribe');
    const usageRecord = asRecord(root['usage']);
    const input = tokenCount(usageRecord?.['input_tokens']);
    const output = tokenCount(usageRecord?.['output_tokens']);
    return {
      text: root['text'].trim(),
      usage: input === undefined || output === undefined ? undefined : { inputTokens: input, outputTokens: output },
    };
  }

  #call(
    operation: 'generate' | 'transcribe',
    path: string,
    body: string | (() => FormData),
    headers: Record<string, string>,
    options: AiCallOptions | undefined,
  ): Promise<unknown> {
    const core = this.#core;
    const allHeaders: Record<string, string> = { accept: 'application/json', ...headers };
    const key = core.settings.apiKey.expose();
    // No key means a local server; sending `Bearer ` with nothing after it makes some of them refuse.
    if (key !== '') allHeaders['authorization'] = `Bearer ${key}`;
    const url = core.url(path);
    return runAttempts(core.policy(operation), options?.signal, (signal) =>
      core.exchange(url, { headers: allHeaders, body: typeof body === 'string' ? body : body() }, signal, operation, readOpenAiError),
    );
  }
}

/**
 * A text-only customer turn is sent as a plain string rather than a one-element
 * content array: text-only models behind compatible servers commonly reject the
 * array form, and nothing is lost by the string.
 */
function encodeTurn(turn: NormalizedTurn): unknown {
  const role = turn.role === 'customer' ? 'user' : 'assistant';
  const only = turn.parts.length === 1 ? turn.parts[0] : undefined;
  if (only?.type === 'text') return { role, content: only.text };
  return {
    role,
    content: turn.parts.map((part) =>
      part.type === 'text'
        ? { type: 'text', text: part.text }
        : { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${base64(part.data)}` } },
    ),
  };
}

/** `{ error: { code, type } }`, where `code` may be a string, a number, or null. */
function readOpenAiError(body: unknown): { status?: number | undefined; code: string | undefined } {
  const error = asRecord(asRecord(body)?.['error']);
  return { code: safeProviderCode(error?.['code']) ?? safeProviderCode(error?.['type']) };
}

function decodeChat(json: unknown): GenerationResult {
  const choices = asRecord(json)?.['choices'];
  if (!Array.isArray(choices)) throw malformedResponse('openai_compatible', 'generate');
  const choice = asRecord(choices[0]);
  if (choice === undefined) throw emptyResponse('openai_compatible', 'generate');

  const finishReason = typeof choice['finish_reason'] === 'string' ? choice['finish_reason'] : undefined;
  const message = asRecord(choice['message']);
  if (finishReason === 'content_filter' || typeof message?.['refusal'] === 'string') {
    throw contentFiltered('openai_compatible', 'generate', safeProviderCode(finishReason ?? 'refusal'));
  }

  const content = message?.['content'];
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((c) => asRecord(c))
            .filter((c) => c?.['type'] === 'text' && typeof c['text'] === 'string')
            .map((c) => c!['text'] as string)
            .join('')
        : '';
  if (text.trim() === '') throw emptyResponse('openai_compatible', 'generate');

  return { text, truncated: finishReason === 'length', usage: chatUsage(asRecord(json)?.['usage']) };
}

function chatUsage(value: unknown): TokenUsage | undefined {
  const usage = asRecord(value);
  const input = tokenCount(usage?.['prompt_tokens']);
  const output = tokenCount(usage?.['completion_tokens']);
  return input === undefined || output === undefined ? undefined : { inputTokens: input, outputTokens: output };
}
