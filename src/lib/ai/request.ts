/**
 * Request validation and normalisation, shared by every adapter and the fake.
 *
 * One function decides what a valid request is and what shape it is sent in, so
 * that "the same conversation" means the same thing to every provider. If each
 * adapter merged turns or checked capabilities itself, a swap could change what the
 * model is shown — two consecutive customer messages arriving as one turn under one
 * provider and as two under the next — which is behavioural drift
 * `ai-provider-portability.md` AC2 forbids, and none of it visible in a diff.
 *
 * The fake runs this too, which is what makes a test written against the fake
 * evidence about the real adapters.
 */

import { AiRequestRejectedError, ValidationError, type ConfigIssue } from '@zeddev/errors';
import {
  AI_AUDIO_MEDIA_TYPES,
  AI_IMAGE_MEDIA_TYPES,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_REQUEST_MEDIA_BYTES,
  type AiAudioMediaType,
  type AiCapability,
  type AiImageMediaType,
  type AudioInput,
  type CustomerPart,
  type GenerationRequest,
  type TranscriptionRequest,
} from './types.ts';

/**
 * A turn after normalisation: roles strictly alternate, and adjacent text parts
 * within a turn are joined. A bot turn is always exactly one text part.
 */
export interface NormalizedTurn {
  readonly role: 'customer' | 'bot';
  readonly parts: readonly CustomerPart[];
}

export interface NormalizedGeneration {
  readonly instructions: string;
  readonly turns: readonly NormalizedTurn[];
  readonly maxOutputTokens: number;
  readonly temperature: number | undefined;
}

export interface NormalizedTranscription {
  readonly audio: AudioInput;
  readonly languageHint: string | undefined;
}

/** Separator for joining adjacent texts. A paragraph break reads as "and then", which is what adjacency means. */
const JOIN = '\n\n';

const MAX_OUTPUT_TOKENS_CEILING = 65_536;

/** BCP 47 in the shape the platform uses: a 2–3 letter language, optionally followed by subtags. */
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * Map a media type as it arrives from WhatsApp (`audio/ogg; codecs=opus`) onto the
 * port's vocabulary. `undefined` means the port cannot carry it, and the reply path
 * should treat the message as media it could not understand.
 */
export function imageMediaType(raw: string): AiImageMediaType | undefined {
  const base = baseMediaType(raw);
  return (AI_IMAGE_MEDIA_TYPES as readonly string[]).includes(base) ? (base as AiImageMediaType) : undefined;
}

export function audioMediaType(raw: string): AiAudioMediaType | undefined {
  const base = baseMediaType(raw);
  const aliased = base === 'audio/mp3' ? 'audio/mpeg' : base === 'audio/x-wav' ? 'audio/wav' : base;
  return (AI_AUDIO_MEDIA_TYPES as readonly string[]).includes(aliased)
    ? (aliased as AiAudioMediaType)
    : undefined;
}

function baseMediaType(raw: string): string {
  return (raw.split(';')[0] ?? '').trim().toLowerCase();
}

export function normalizeGeneration(
  request: GenerationRequest,
  capabilities: readonly AiCapability[],
  provider: string,
): NormalizedGeneration {
  const issues: ConfigIssue[] = [];

  if (typeof request.instructions !== 'string' || request.instructions.trim() === '') {
    issues.push({ key: 'instructions', reason: 'must be a non-empty string' });
  }

  const maxOutputTokens = request.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS_CEILING) {
    issues.push({ key: 'maxOutputTokens', reason: `must be an integer in [1, ${MAX_OUTPUT_TOKENS_CEILING}]` });
  }
  const temperature = request.temperature;
  if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) {
    issues.push({ key: 'temperature', reason: 'must be a number in [0, 2]' });
  }

  if (request.turns.length === 0) {
    issues.push({ key: 'turns', reason: 'must contain at least one turn' });
  } else if (request.turns.at(-1)?.role !== 'customer') {
    // A request ending on the bot's own words asks the model to reply to itself.
    issues.push({ key: 'turns', reason: "must end with the customer's turn" });
  }

  let usesImages = false;
  let mediaBytes = 0;
  const turns: { role: 'customer' | 'bot'; parts: CustomerPart[] }[] = [];

  request.turns.forEach((turn, i) => {
    const incoming: CustomerPart[] = [];
    if (turn.role === 'bot') {
      if (typeof turn.text !== 'string' || turn.text.trim() === '') {
        issues.push({ key: `turns[${i}].text`, reason: 'must be non-empty' });
        return;
      }
      incoming.push({ type: 'text', text: turn.text });
    } else {
      if (turn.parts.length === 0) {
        issues.push({ key: `turns[${i}].parts`, reason: 'must contain at least one part' });
        return;
      }
      turn.parts.forEach((part, j) => {
        if (part.type === 'text') {
          if (typeof part.text !== 'string' || part.text.trim() === '') {
            issues.push({ key: `turns[${i}].parts[${j}].text`, reason: 'must be non-empty' });
            return;
          }
          incoming.push(part);
          return;
        }
        if (!(AI_IMAGE_MEDIA_TYPES as readonly string[]).includes(part.mediaType)) {
          throw new AiRequestRejectedError('Image media type is not supported by the AI port', {
            code: 'ai.media_type_unsupported',
            provider,
            context: { operation: 'generate' },
          });
        }
        if (part.data.byteLength === 0) {
          issues.push({ key: `turns[${i}].parts[${j}].data`, reason: 'must be non-empty' });
          return;
        }
        usesImages = true;
        mediaBytes += part.data.byteLength;
        incoming.push(part);
      });
    }

    const previous = turns.at(-1);
    const target = previous?.role === turn.role ? previous : { role: turn.role, parts: [] };
    if (target !== previous) turns.push(target);
    for (const part of incoming) appendPart(target.parts, part);
  });

  if (issues.length > 0) throw new ValidationError(issues);

  if (usesImages && !capabilities.includes('vision')) {
    throw capabilityRejected('vision', 'generate', provider);
  }
  if (mediaBytes > MAX_REQUEST_MEDIA_BYTES) {
    throw mediaTooLarge('generate', mediaBytes, provider);
  }

  return {
    instructions: request.instructions,
    turns,
    maxOutputTokens,
    temperature,
  };
}

export function normalizeTranscription(
  request: TranscriptionRequest,
  capabilities: readonly AiCapability[],
  provider: string,
): NormalizedTranscription {
  const issues: ConfigIssue[] = [];
  const hint = request.languageHint;
  if (hint !== undefined && !LANGUAGE_TAG.test(hint)) {
    issues.push({ key: 'languageHint', reason: 'must be a BCP 47 language tag, e.g. "pt-BR"' });
  }
  if (request.audio.data.byteLength === 0) {
    issues.push({ key: 'audio.data', reason: 'must be non-empty' });
  }
  if (issues.length > 0) throw new ValidationError(issues);

  if (!capabilities.includes('audio')) {
    throw capabilityRejected('audio', 'transcribe', provider);
  }
  if (!(AI_AUDIO_MEDIA_TYPES as readonly string[]).includes(request.audio.mediaType)) {
    throw new AiRequestRejectedError('Audio media type is not supported by the AI port', {
      code: 'ai.media_type_unsupported',
      provider,
      context: { operation: 'transcribe' },
    });
  }
  if (request.audio.data.byteLength > MAX_REQUEST_MEDIA_BYTES) {
    throw mediaTooLarge('transcribe', request.audio.data.byteLength, provider);
  }
  return { audio: request.audio, languageHint: hint };
}

function appendPart(parts: CustomerPart[], part: CustomerPart): void {
  const last = parts.at(-1);
  if (part.type === 'text' && last?.type === 'text') {
    parts[parts.length - 1] = { type: 'text', text: `${last.text}${JOIN}${part.text}` };
    return;
  }
  parts.push(part);
}

/**
 * Refused before any request leaves the process: the model was declared not to
 * have the capability, so a request would spend quota to learn what is already
 * known. The reply path routes this to fallback like any other AI failure.
 */
function capabilityRejected(capability: AiCapability, operation: string, provider: string): AiRequestRejectedError {
  return new AiRequestRejectedError(`The configured model does not have the ${capability} capability`, {
    code: 'ai.capability_unsupported',
    provider,
    context: { capability, operation },
  });
}

function mediaTooLarge(operation: string, bytes: number, provider: string): AiRequestRejectedError {
  return new AiRequestRejectedError('Media in the request exceeds the AI port limit', {
    code: 'ai.media_too_large',
    provider,
    context: { operation, bytes, limit: MAX_REQUEST_MEDIA_BYTES },
  });
}
