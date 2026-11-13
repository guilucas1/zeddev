/**
 * Verifying an AI provider before it serves a conversation — `ai-provider-portability.md`
 * AC4.
 *
 * The suite puts a fixed, made-up business through the same functions a live
 * conversation goes through: `generateReply` for text (prompt assembly, knowledge
 * selection, the output protocol, and its interpretation) and `understandMedia`
 * for a photo and a voice note. Nothing here builds a prompt or reads an answer
 * of its own, so a provider that passes has passed the path it will serve on, and
 * a swap that would break that path — most often a model that does not follow the
 * tagged output protocol, which live traffic would see only as a rise in
 * `unusable_output` fallbacks — is caught before anyone is answered.
 *
 * Why made-up and not a real tenant: verification is the operator's, and the
 * operator has no access to any tenant's configuration (`tenant-data-isolation.md`).
 * A business invented here is also the same every time, so two providers verified
 * a week apart are compared on the same questions.
 *
 * What it can and cannot judge. The text checks have answers a working model
 * reliably gives (a fact it was told, a request for a person, a topic it was told
 * to decline), and the photo is a solid colour. The voice note is silence: the
 * platform holds no recording of speech, so `audio` proves the transcription model
 * and its credential answer, not that it transcribes well. The clip is WAV rather
 * than a WhatsApp voice note's Ogg Opus, which cannot be produced without an
 * encoder; both are in the port's accepted set, so the path is the same. Every check shows
 * what came back, because whether a reply *reads* well is the operator's call.
 *
 * Checks run one after another, never in parallel: a free-tier quota is per
 * minute, and five simultaneous requests are the likeliest way to fail a provider
 * for a rate limit instead of for anything about it.
 */

import { deflateSync, crc32 } from 'node:zlib';
import type { AiCapability, AiProvider, AiProviderDescriptor } from '@zeddev/ai';
import { generateReply, type ReplyConfiguration, type ReplyDecision } from '@zeddev/bot';
import { ValidationError, type ConfigIssue } from '@zeddev/errors';
import { SystemClock, type Clock } from '@zeddev/time';
import { understandMedia } from './media.ts';

/** Which provider the operator asks to verify. */
export const VERIFICATION_TARGETS = ['active', 'candidate'] as const;
export type VerificationTarget = (typeof VERIFICATION_TARGETS)[number];

/** The request fields a verification accepts. Anything else is refused by name. */
export const VERIFICATION_FIELDS = ['target'] as const;

export function parseVerificationInput(body: Readonly<Record<string, unknown>>): VerificationTarget {
  const issues: ConfigIssue[] = [];
  const known = new Set<string>(VERIFICATION_FIELDS);
  for (const key of Object.keys(body)) {
    if (!known.has(key)) issues.push({ key, reason: 'is not a recognised field' });
  }
  const target = body.target;
  if (typeof target !== 'string' || !(VERIFICATION_TARGETS as readonly string[]).includes(target)) {
    issues.push({ key: 'target', reason: `must be one of: ${VERIFICATION_TARGETS.join(', ')}` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return target as VerificationTarget;
}

export const VERIFICATION_CHECKS = ['reply', 'handoff', 'decline', 'vision', 'audio'] as const;
export type VerificationCheck = (typeof VERIFICATION_CHECKS)[number];

export const VERIFICATION_OUTCOMES = ['passed', 'failed', 'skipped'] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationCheckResult {
  readonly check: VerificationCheck;
  /** The capability the check exercises; a provider that does not declare it is skipped, not failed. */
  readonly capability: AiCapability;
  readonly outcome: VerificationOutcome;
  /** What a working provider does, in words, for the operator reading the result. */
  readonly expected: string;
  /**
   * What came back: the reply text, the action the model took, or what it said a
   * photo or clip held. Only ever about the made-up business, never a tenant's.
   * `null` when nothing came back.
   */
  readonly observed: string | null;
  /** The provider's error code when the call itself failed (`ai.unauthorized`, `ai.rate_limited`, …). */
  readonly errorCode: string | null;
  readonly durationMs: number;
}

export interface ProviderVerification {
  readonly provider: AiProviderDescriptor;
  /** No check failed. A skipped check does not fail a provider; `capabilityGaps` says what it means. */
  readonly passed: boolean;
  /**
   * Capabilities the active provider has and this one does not. A swap would turn
   * every such message into the client's fallback text — a gap the spec makes the
   * operator's to accept, so it is shown, not refused.
   */
  readonly capabilityGaps: readonly AiCapability[];
  readonly checks: readonly VerificationCheckResult[];
  readonly verifiedAt: Date;
}

const EPOCH = new Date('2026-01-01T00:00:00Z');

/**
 * The made-up business: a bakery with one fact to quote, one topic to decline, and
 * a person to hand over to. Rendered by `replyInstructions` like any tenant's.
 */
export const VERIFICATION_CONFIGURATION: ReplyConfiguration = {
  persona: { botName: 'Ada', formality: null, styleTraits: [], freeformInstructions: null, updatedAt: EPOCH },
  disclosureMode: 'disclose',
  behavior: {
    rules: [
      {
        id: '00000000-0000-4000-8000-0000000000a1',
        kind: 'avoid_topic',
        subject: 'politics and elections',
        condition: null,
        action: 'fallback',
        enabled: true,
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    ],
    freeformInstructions: null,
  },
  handoff: { enabled: true, triggers: ['human_request'], customConditions: [] },
  knowledge: {
    entries: [
      {
        id: '00000000-0000-4000-8000-0000000000b1',
        content: 'Sunrise Bakery opening hours: Monday to Saturday from 8:00 to 18:00. Closed on Sundays.',
        createdAt: EPOCH,
        updatedAt: EPOCH,
      },
    ],
  },
};

/** The customer messages the text checks send, each as the opening message of a new conversation. */
export const VERIFICATION_MESSAGES = {
  reply: 'Hi! What time do you open on Saturday?',
  handoff: "I don't want to talk to a bot. Please put me through to a real person.",
  decline: 'Which party should I vote for in the next election?',
  vision: 'What colour is this?',
} as const;

/**
 * Ask one text question, as the opening message of a new conversation, and judge
 * the decision the reply path made of the answer.
 */
async function textCheck(
  provider: AiProvider,
  check: 'reply' | 'handoff' | 'decline',
  judge: (decision: ReplyDecision) => boolean,
): Promise<Omit<VerificationCheckResult, 'durationMs'>> {
  const outcome = await generateReply(
    provider,
    VERIFICATION_CONFIGURATION,
    [{ role: 'customer', parts: [{ type: 'text', text: VERIFICATION_MESSAGES[check] }] }],
    { conversationStart: true },
  );
  return {
    check,
    capability: 'text',
    outcome: judge(outcome.decision) ? 'passed' : 'failed',
    expected: EXPECTED[check],
    observed: outcome.failure === undefined ? describeDecision(outcome.decision) : null,
    errorCode: outcome.failure?.code ?? null,
  };
}

function describeDecision(decision: ReplyDecision): string {
  switch (decision.path) {
    case 'reply':
      return decision.text;
    case 'handoff': {
      const { reason } = decision;
      const named = reason.kind === 'trigger' ? reason.trigger : reason.kind === 'custom_condition' ? reason.condition : `rule ${reason.ruleId}`;
      return `Handed over to a person (${named}).`;
    }
    case 'fallback':
      return `Fell back to the business's own message (${decision.trigger}, ${decision.cause}).`;
  }
}

async function mediaCheck(provider: AiProvider, check: 'vision' | 'audio'): Promise<Omit<VerificationCheckResult, 'durationMs'>> {
  if (check === 'vision') {
    const verdict = await understandMedia(provider, {
      kind: 'image',
      caption: VERIFICATION_MESSAGES.vision,
      mimeType: 'image/png',
      data: SOLID_RED_PNG,
    });
    return {
      check,
      capability: 'vision',
      outcome: verdict.text !== undefined && /\bred\b/i.test(verdict.text) ? 'passed' : 'failed',
      expected: EXPECTED.vision,
      observed: verdict.text ?? (verdict.failure === 'unreadable' ? 'Said the photo could not be made out.' : null),
      errorCode: verdict.cause?.code ?? null,
    };
  }
  const verdict = await understandMedia(provider, { kind: 'audio', caption: undefined, mimeType: 'audio/wav', data: SILENT_WAV });
  // Silence has no right transcript; an answer of any kind — words or none —
  // proves the model took the clip, and only a failed call fails the check.
  return {
    check,
    capability: 'audio',
    outcome: verdict.failure === 'provider_failed' ? 'failed' : 'passed',
    expected: EXPECTED.audio,
    observed: verdict.text ?? (verdict.failure === 'no_speech' ? 'Heard no speech.' : null),
    errorCode: verdict.cause?.code ?? null,
  };
}

const CHECK_CAPABILITY: Readonly<Record<VerificationCheck, AiCapability>> = {
  reply: 'text',
  handoff: 'text',
  decline: 'text',
  vision: 'vision',
  audio: 'audio',
};

const EXPECTED: Readonly<Record<VerificationCheck, string>> = {
  reply: 'Replies, quoting the opening time it was told (8:00).',
  handoff: 'Hands the conversation to a person, because the customer asked for one.',
  decline: "Declines with the business's fallback message, because a rule says to avoid politics.",
  vision: 'Says the photo, a plain square, is red.',
  audio: 'Accepts a one-second voice clip of silence and answers, with or without words.',
};

async function runCheck(provider: AiProvider, check: VerificationCheck): Promise<Omit<VerificationCheckResult, 'durationMs'>> {
  switch (check) {
    case 'reply':
      return textCheck(provider, check, (d) => d.path === 'reply' && /\b0?8\b/.test(d.text));
    case 'handoff':
      return textCheck(
        provider,
        check,
        (d) => d.path === 'handoff' && d.reason.kind === 'trigger' && d.reason.trigger === 'human_request',
      );
    case 'decline':
      return textCheck(
        provider,
        check,
        (d) => d.path === 'fallback' && d.trigger === 'out_of_scope' && d.cause === 'declined',
      );
    case 'vision':
    case 'audio':
      return mediaCheck(provider, check);
  }
}

/**
 * Run every check against `provider`.
 *
 * `active` is the descriptor of the provider currently answering, against which
 * capability gaps are reported; verifying the active provider itself reports none.
 * A check whose capability the provider does not declare is skipped without a
 * request, since the port would refuse it before sending anything.
 */
export async function verifyAiProvider(
  provider: AiProvider,
  options: { readonly active: AiProviderDescriptor; readonly clock?: Clock | undefined },
): Promise<ProviderVerification> {
  const clock = options.clock ?? new SystemClock();
  const checks: VerificationCheckResult[] = [];
  for (const check of VERIFICATION_CHECKS) {
    const capability = CHECK_CAPABILITY[check];
    if (!provider.supports(capability)) {
      checks.push({ check, capability, outcome: 'skipped', expected: EXPECTED[check], observed: null, errorCode: null, durationMs: 0 });
      continue;
    }
    const started = clock.monotonicMs();
    const result = await runCheck(provider, check);
    checks.push({ ...result, durationMs: Math.round(clock.monotonicMs() - started) });
  }
  return {
    provider: provider.descriptor,
    passed: checks.every((check) => check.outcome !== 'failed'),
    capabilityGaps: options.active.capabilities.filter((capability) => !provider.supports(capability)),
    checks,
    verifiedAt: clock.now(),
  };
}

// ---------------------------------------------------------------------------
// The media the suite sends. Built at load rather than stored, so the repository
// holds no binary fixture and what is sent is readable here.
// ---------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A 64×64 solid red PNG: 8-bit RGB, every scanline unfiltered. */
function solidPng(size: number, rgb: readonly [number, number, number]): Uint8Array {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  const row = Buffer.alloc(1 + size * 3);
  for (let x = 0; x < size; x += 1) row.set(rgb, 1 + x * 3);
  const pixels = Buffer.concat(Array.from({ length: size }, () => row));
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixels)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

/** One second of 16 kHz mono 16-bit PCM silence, in a WAV container. */
function silentWav(seconds: number, sampleRate: number): Uint8Array {
  const dataBytes = seconds * sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return new Uint8Array(Buffer.concat([header, Buffer.alloc(dataBytes)]));
}

export const SOLID_RED_PNG: Uint8Array = solidPng(64, [220, 20, 20]);
export const SILENT_WAV: Uint8Array = silentWav(1, 16_000);
