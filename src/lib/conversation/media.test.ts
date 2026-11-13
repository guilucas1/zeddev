/**
 * Understanding media, with no database: what is kept of a model's answer, and that
 * every provider the platform can be pointed at reaches the same verdict.
 *
 * The turn path around this is tested against a real PostgreSQL in `turns.test.ts`.
 */

import assert from 'node:assert/strict';
import { AI_PROVIDER_NAMES, createAiProvider, type AiCapability, type AiProvider } from '@zeddev/ai';
import { InMemoryAiProvider, startAiStub, type ScriptedBackend } from '@zeddev/ai/testing';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { cleanTranscript, MEDIA_LIMITS, readImageUnderstanding, understandMedia } from './media.ts';

const IMAGE = 'image-message-understanding.md';
const VOICE = 'voice-message-understanding.md';
const PHOTO = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 1, 2, 3);
const NOTE = Uint8Array.of(0x4f, 0x67, 0x67, 0x53, 4, 5, 6);

specTest(VOICE, 'AC9 the reply contains no transcription metadata', 'timestamps and non-speech tags do not survive, whichever form a model writes them in', () => {
  assert.equal(cleanTranscript('[00:01] Do you deliver [00:04] on Sunday?'), 'Do you deliver on Sunday?');
  assert.equal(cleanTranscript('00:00:01,000 --> 00:00:04,000\nDo you deliver?'), 'Do you deliver?');
  assert.equal(cleanTranscript('Hello [MUSIC] there (inaudible) friend <noise>'), 'Hello there friend');
  assert.equal(cleanTranscript('Oi (inaudível) tudo bem (risos)'), 'Oi tudo bem');
});

unitTest('what the customer actually said survives cleaning', () => {
  assert.equal(cleanTranscript('Can I come at 10:30 (or later)?'), 'Can I come at 10:30 (or later)?');
  assert.equal(cleanTranscript('Quanto custa? R$ 50'), 'Quanto custa? R$ 50');
});

specTest(VOICE, 'AC5 a silent voice note follows the fallback', 'a transcript of nothing but tags or punctuation is no speech at all', () => {
  for (const nothing of ['', '   ', '[BLANK_AUDIO]', '(silence)', '[Music] [Music]', '...', '<noise>']) {
    assert.equal(cleanTranscript(nothing), undefined, JSON.stringify(nothing));
  }
});

specTest(IMAGE, 'AC5 an uninterpretable image follows the fallback rather than a fabricated description', 'the unreadable answer is recognised however the model dresses it up', () => {
  for (const answer of ['UNREADABLE', 'unreadable.', ' "Unreadable" ', '**UNREADABLE**', '']) {
    assert.equal(readImageUnderstanding(answer), undefined, JSON.stringify(answer));
  }
  // The word appearing in a description is not the same as the verdict.
  assert.equal(readImageUnderstanding('A sign saying UNREADABLE on a door.'), 'A sign saying UNREADABLE on a door.');
});

unitTest('kept text is bounded, marked when cut, and holds nothing the database refuses', () => {
  const NUL = String.fromCharCode(0);
  assert.equal(readImageUnderstanding(`a${NUL} photo\nof a bike`), 'a photo\nof a bike');
  const long = cleanTranscript('a😀'.repeat(MEDIA_LIMITS.understandingMaxLength))!;
  const points = Array.from(long);
  assert.equal(points.length, MEDIA_LIMITS.understandingMaxLength);
  assert.equal(points.slice(-4).join(''), ' […]', 'a cut must say so');
  assert.ok(points.slice(0, -4).every((point) => point === 'a' || point === '😀'), 'a surrogate pair must never be split');
});

unitTest('a model that was declared without the capability is asked for nothing', async () => {
  // The port refuses before any request leaves, so the verdict is a technical one.
  const provider = new InMemoryAiProvider({ capabilities: ['text'] });
  const verdict = await understandMedia(provider, { kind: 'image', caption: undefined, mimeType: 'image/jpeg', data: PHOTO });
  assert.equal(verdict.failure, 'provider_failed');
  assert.equal(verdict.cause?.code, 'ai.capability_unsupported', 'the cause says which failure it was');
  assert.equal(provider.backend.requests.length, 0);
});

unitTest('a format the port does not carry is refused without a model call', async () => {
  const provider = new InMemoryAiProvider();
  assert.deepEqual(
    await understandMedia(provider, { kind: 'image', caption: undefined, mimeType: 'image/heic', data: PHOTO }),
    { failure: 'unsupported_format' },
  );
  assert.deepEqual(
    await understandMedia(provider, { kind: 'audio', caption: undefined, mimeType: 'audio/amr', data: NOTE }),
    { failure: 'unsupported_format' },
  );
  assert.equal(provider.backend.requests.length, 0);
});

// ---------------------------------------------------------------------------
// The same verdicts from every provider
// ---------------------------------------------------------------------------

const ALL: readonly AiCapability[] = ['text', 'vision', 'audio'];

interface Target {
  readonly label: string;
  start(): Promise<{ provider: AiProvider; backend: ScriptedBackend; close(): Promise<void> }>;
}

const TARGETS: readonly Target[] = [
  {
    label: 'in-memory',
    start: async () => {
      const provider = new InMemoryAiProvider({ capabilities: ALL, maxAttempts: 1 });
      return { provider, backend: provider.backend, close: async () => {} };
    },
  },
  ...AI_PROVIDER_NAMES.map((name): Target => ({
    label: name,
    start: async () => {
      const stub = await startAiStub(name);
      const provider = createAiProvider(
        {
          provider: name,
          baseUrl: stub.baseUrl,
          apiKey: new Secret('media-test-key', 'AI_API_KEY'),
          model: 'media-model',
          transcriptionModel: name === 'openai_compatible' ? 'media-whisper' : '',
          capabilities: ALL,
          requestTimeoutMs: 5_000,
          maxAttempts: 1,
        },
        { backoff: () => 0 },
      );
      return { provider, backend: stub.backend, close: () => stub.close() };
    },
  })),
];

for (const target of TARGETS) {
  specTest(IMAGE, 'AC8 swapping the image-understanding provider leaves observable behavior unchanged', `[${target.label}] a photo is seen, described, refused as unreadable, or failed, by the same rules`, async () => {
    const { provider, backend, close } = await target.start();
    try {
      const photo = { kind: 'image', caption: 'is it under warranty?', mimeType: 'image/jpeg', data: PHOTO } as const;

      backend.script({ kind: 'text', text: 'A cracked phone screen.' });
      const seen = await understandMedia(provider, photo);
      assert.equal(seen.text, 'A cracked phone screen.');
      const shown = backend.requests.at(-1)!;
      assert.ok(shown.operation === 'generate');
      const parts = shown.turns.at(-1)!.parts;
      assert.deepEqual(parts[0], { type: 'text', text: "The customer's caption: is it under warranty?" });
      const image = parts[1]!;
      assert.ok(image.type === 'image');
      assert.deepEqual(Buffer.from(image.data), Buffer.from(PHOTO));

      backend.script({ kind: 'text', text: 'UNREADABLE' });
      assert.equal((await understandMedia(provider, photo)).failure, 'unreadable');

      backend.script({ kind: 'failure', failure: 'rejected' });
      assert.equal((await understandMedia(provider, photo)).failure, 'provider_failed');
    } finally {
      await close();
    }
  });

  specTest(VOICE, 'AC2 a voice note in the configured language yields a relevant understanding', `[${target.label}] a voice note is transcribed and cleaned, or reported as no speech, by the same rules`, async () => {
    const { provider, backend, close } = await target.start();
    try {
      const note = { kind: 'audio', caption: undefined, mimeType: 'audio/ogg; codecs=opus', data: NOTE } as const;

      backend.script({ kind: 'text', text: '[00:00] Vocês abrem no domingo?' });
      assert.equal((await understandMedia(provider, note)).text, 'Vocês abrem no domingo?');
      const shown = backend.requests.at(-1)!;
      assert.ok(shown.operation === 'transcribe');
      assert.equal(shown.mediaType, 'audio/ogg');
      assert.deepEqual(Buffer.from(shown.data), Buffer.from(NOTE));

      backend.script({ kind: 'text', text: '[BLANK_AUDIO]' });
      assert.equal((await understandMedia(provider, note)).failure, 'no_speech');

      backend.script({ kind: 'failure', failure: 'unavailable' });
      assert.equal((await understandMedia(provider, note)).failure, 'provider_failed');
    } finally {
      await close();
    }
  });
}
