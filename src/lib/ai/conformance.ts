/**
 * The single definition of what the AI port means.
 *
 * Runs unchanged against the in-memory fake and against each real adapter talking
 * to a stub of its upstream. `ai-provider-portability.md` is, at bottom, a claim
 * that the platform behaves the same whichever adapter is configured; this suite is
 * that claim made executable. An adapter that passes it can be swapped in by
 * configuration alone (AC1) and serves text, images, and voice exactly as the one
 * before it did (AC3), because "the same" is defined here, once — and a test of the
 * reply path written against the fake is evidence about the adapters for the same
 * reason.
 *
 * Read this file to learn the port's semantics. `types.ts` states the guarantees;
 * this is where they are checked.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { AiGenerationError, AiRequestRejectedError, ValidationError, ZedError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import type { ObservedGeneration, ObservedTranscription, ScriptedBackend } from './memory.ts';
import type { AiCapability, AiProvider } from './types.ts';

export interface AiFixture {
  readonly provider: AiProvider;
  /** The model's side of the conversation: script what it answers, read what it was shown. */
  readonly backend: ScriptedBackend;
  dispose(): Promise<void>;
}

export interface AiFixtureOptions {
  readonly capabilities: readonly AiCapability[];
  readonly maxAttempts: number;
  readonly timeoutMs: number;
}

export interface AiHarness {
  readonly label: string;
  /** Build a provider with no delay between attempts, so retry tests do not wait. */
  create(options: AiFixtureOptions): Promise<AiFixture>;
}

const ALL: readonly AiCapability[] = ['text', 'vision', 'audio'];

/** A marker that cannot occur in any fixture identifier; see AGENTS.md on leak-test needles. */
const NEEDLE = 'customer-secret-qzxv';

// Small, valid-looking payloads. The port carries bytes; it does not decode them,
// so what matters is that every byte arrives, including the ones that are not ASCII.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x80, 0xff, 0x0a, 0xff, 0xd9]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0xfe, 0xed]);
const OGG = Buffer.concat([Buffer.from('OggS'), Buffer.from([0x00, 0x02, 0xff, 0x80, 0x00, 0x0d, 0x0a])]);

export function runAiConformance(harness: AiHarness): void {
  describe(`AI conformance: ${harness.label}`, () => {
    async function withFixture(
      options: Partial<AiFixtureOptions>,
      body: (fixture: AiFixture) => Promise<void>,
    ): Promise<void> {
      const fixture = await harness.create({ capabilities: ALL, maxAttempts: 3, timeoutMs: 2_000, ...options });
      try {
        await body(fixture);
      } finally {
        await fixture.dispose();
      }
    }
    const name = (what: string): string => `[${harness.label}] ${what}`;
    const customer = (text: string) => ({ role: 'customer' as const, parts: [{ type: 'text' as const, text }] });
    const lastGeneration = (backend: ScriptedBackend): ObservedGeneration => {
      const last = backend.requests.at(-1);
      assert.equal(last?.operation, 'generate');
      return last as ObservedGeneration;
    };

    // -----------------------------------------------------------------------
    // What the model is shown
    // -----------------------------------------------------------------------

    specTest(
      'ai-provider-portability.md',
      "AC2 a swap preserves the client's persona, tone, knowledge, and rules without client action",
      name('the model is shown the instructions and every turn exactly as given, in order, with nothing added'),
      async () => {
        await withFixture({}, async ({ provider, backend }) => {
          // Everything a tenant configures reaches the model through `instructions`,
          // so "configuration fidelity across a swap" is: every adapter delivers
          // these bytes and no others. Multi-line, quoted, and non-ASCII on purpose.
          const instructions = 'Você é "Lia", assistente da Padaria Sol.\nNever discuss pricing.\n\n— Tom: caloroso 🌞';
          await provider.generate({
            instructions,
            turns: [customer('Oi, vocês abrem domingo?'), { role: 'bot', text: 'Abrimos sim, das 8h às 12h.' }, customer('E feriado?')],
            maxOutputTokens: 300,
            temperature: 0.4,
          });

          const seen = lastGeneration(backend);
          assert.equal(seen.instructions, instructions);
          assert.deepEqual(seen.turns, [
            { role: 'customer', parts: [{ type: 'text', text: 'Oi, vocês abrem domingo?' }] },
            { role: 'bot', parts: [{ type: 'text', text: 'Abrimos sim, das 8h às 12h.' }] },
            { role: 'customer', parts: [{ type: 'text', text: 'E feriado?' }] },
          ]);
          assert.equal(seen.maxOutputTokens, 300);
          assert.equal(seen.temperature, 0.4);
          assert.equal(seen.model, provider.descriptor.model);
        });
      },
    );

    unitTest(name('consecutive turns from one side reach the model as one turn, so roles strictly alternate'), async () => {
      await withFixture({}, async ({ provider, backend }) => {
        await provider.generate({
          instructions: 'Be brief.',
          turns: [
            { role: 'bot', text: 'Hello!' },
            { role: 'bot', text: 'How can I help?' },
            customer('I need a cake'),
            customer('for Saturday'),
          ],
        });
        assert.deepEqual(lastGeneration(backend).turns, [
          { role: 'bot', parts: [{ type: 'text', text: 'Hello!\n\nHow can I help?' }] },
          { role: 'customer', parts: [{ type: 'text', text: 'I need a cake\n\nfor Saturday' }] },
        ]);
      });
    });

    specTest(
      'ai-provider-portability.md',
      'AC3 images continue to be handled after a swap',
      name('every image in a turn reaches the model byte for byte, in order, beside its caption'),
      async () => {
        await withFixture({}, async ({ provider, backend }) => {
          await provider.generate({
            instructions: 'Describe what you see.',
            turns: [
              {
                role: 'customer',
                parts: [
                  { type: 'image', mediaType: 'image/jpeg', data: JPEG },
                  { type: 'image', mediaType: 'image/png', data: PNG },
                  { type: 'text', text: 'is this still under warranty?' },
                ],
              },
            ],
          });
          assert.deepEqual(lastGeneration(backend).turns, [
            {
              role: 'customer',
              parts: [
                { type: 'image', mediaType: 'image/jpeg', data: JPEG },
                { type: 'image', mediaType: 'image/png', data: PNG },
                { type: 'text', text: 'is this still under warranty?' },
              ],
            },
          ]);
        });
      },
    );

    specTest(
      'ai-provider-portability.md',
      'AC3 voice notes continue to be handled after a swap',
      name('a voice note reaches the transcriber byte for byte with the language hint, and its transcript comes back'),
      async () => {
        await withFixture({}, async ({ provider, backend }) => {
          backend.script({ kind: 'text', text: '  Vocês entregam no domingo?\n' });
          const result = await provider.transcribe({ audio: { mediaType: 'audio/ogg', data: OGG }, languageHint: 'pt-BR' });

          assert.equal(result.text, 'Vocês entregam no domingo?', 'surrounding whitespace is not speech');
          const seen = backend.requests.at(-1) as ObservedTranscription;
          assert.equal(seen.operation, 'transcribe');
          assert.equal(seen.mediaType, 'audio/ogg');
          assert.deepEqual(seen.data, OGG);
          assert.equal(seen.model, provider.descriptor.transcriptionModel);
          // Upstreams take the hint at different precision; the language itself must survive.
          assert.equal(seen.languageHint?.split('-')[0], 'pt');
        });
      },
    );

    specTest(
      'voice-message-understanding.md',
      'Given a customer sends a voice note that is silent or contains no speech (e.g., accidental recording), when the bot processes it, then the bot follows the fallback behavior',
      name('a voice note with no speech transcribes to empty text rather than failing, so the reply path can tell the two apart'),
      async () => {
        await withFixture({}, async ({ provider, backend }) => {
          backend.script({ kind: 'text', text: '' });
          const result = await provider.transcribe({ audio: { mediaType: 'audio/ogg', data: OGG } });
          assert.equal(result.text, '');
        });
      },
    );

    // -----------------------------------------------------------------------
    // What comes back
    // -----------------------------------------------------------------------

    specTest(
      'ai-provider-portability.md',
      'AC3 text continues to be handled after a swap',
      name('a reply comes back as text with the token usage the provider reported'),
      async () => {
        await withFixture({}, async ({ provider, backend }) => {
          backend.script({ kind: 'text', text: 'Sim, abrimos às 8h.', usage: { inputTokens: 120, outputTokens: 9 } });
          const result = await provider.generate({ instructions: 'Be brief.', turns: [customer('Abrem cedo?')] });
          assert.deepEqual(result, { text: 'Sim, abrimos às 8h.', truncated: false, usage: { inputTokens: 120, outputTokens: 9 } });
        });
      },
    );

    unitTest(name('a reply cut off at the output bound is returned and marked truncated, not thrown'), async () => {
      await withFixture({}, async ({ provider, backend }) => {
        backend.script({ kind: 'text', text: 'Our opening hours are', truncated: true });
        const result = await provider.generate({ instructions: 'x', turns: [customer('hours?')], maxOutputTokens: 5 });
        assert.equal(result.truncated, true);
        assert.equal(result.text, 'Our opening hours are');
      });
    });

    // -----------------------------------------------------------------------
    // Failure: what is retried, what is not, and what the reply path sees
    // -----------------------------------------------------------------------

    unitTest(name('rate limits and outages are retried inside the call and a later success is returned'), async () => {
      await withFixture({ maxAttempts: 3 }, async ({ provider, backend }) => {
        backend.script(
          { kind: 'failure', failure: 'rate_limited' },
          { kind: 'failure', failure: 'unavailable' },
          { kind: 'text', text: 'Recovered.' },
        );
        const result = await provider.generate({ instructions: 'x', turns: [customer('hi')] });
        assert.equal(result.text, 'Recovered.');
        assert.equal(backend.requests.length, 3);
      });
    });

    specTest(
      'fallback-response-behavior.md',
      'Given the AI generation step fails outright (system error), when fallback is triggered, then the end-customer still receives a fallback response',
      name('a rate limit that outlasts every attempt surfaces as a retryable ai_generation error after exactly maxAttempts requests'),
      async () => {
        await withFixture({ maxAttempts: 2 }, async ({ provider, backend }) => {
          backend.script({ kind: 'failure', failure: 'rate_limited' }, { kind: 'failure', failure: 'rate_limited' });
          const error = await rejection(provider.generate({ instructions: 'x', turns: [customer('hi')] }));
          assert.ok(error instanceof AiGenerationError);
          assert.equal(error.kind, 'ai_generation', 'fallback routes on this kind');
          assert.equal(error.code, 'ai.rate_limited');
          assert.equal(error.retryable, true);
          assert.equal(error.context['attempts'], 2);
          assert.equal(backend.requests.length, 2);
        });
      },
    );

    unitTest(name('a Retry-After longer than the call can wait fails at once instead of holding the customer'), async () => {
      await withFixture({ maxAttempts: 3 }, async ({ provider, backend }) => {
        backend.script({ kind: 'failure', failure: 'rate_limited', retryAfterMs: 60_000 });
        const error = await rejection(provider.generate({ instructions: 'x', turns: [customer('hi')] }));
        assert.equal(error.code, 'ai.rate_limited');
        assert.equal(error.context['retryAfterMs'], 60_000);
        assert.equal(backend.requests.length, 1);
      });
    });

    for (const [failure, code] of [
      ['unauthorized', 'ai.unauthorized'],
      ['not_found', 'ai.not_found'],
      ['rejected', 'ai.request_rejected'],
      ['filtered', 'ai.content_filtered'],
    ] as const) {
      unitTest(name(`"${failure}" is surfaced as ${code}, not retried, and still routes to fallback`), async () => {
        await withFixture({ maxAttempts: 3 }, async ({ provider, backend }) => {
          backend.script({ kind: 'failure', failure });
          const error = await rejection(provider.generate({ instructions: 'x', turns: [customer('hi')] }));
          assert.ok(error instanceof AiRequestRejectedError, `${failure} is not worth a second attempt`);
          assert.equal(error.kind, 'ai_generation');
          assert.equal(error.code, code);
          assert.equal(error.retryable, false);
          assert.equal(backend.requests.length, 1);
        });
      });
    }

    unitTest(name('an empty reply is a failure, never an empty message to the customer'), async () => {
      await withFixture({ maxAttempts: 1 }, async ({ provider, backend }) => {
        backend.script({ kind: 'text', text: '   ' });
        const error = await rejection(provider.generate({ instructions: 'x', turns: [customer('hi')] }));
        assert.equal(error.code, 'ai.empty_response');
        assert.equal(error.kind, 'ai_generation');
      });
    });

    specTest(
      'voice-message-understanding.md',
      'Given a voice note fails to download or the transcription step errors out or times out, when this occurs, then the bot follows the fallback behavior',
      name('a provider that never answers times out on every attempt and surfaces as ai.timeout'),
      async () => {
        await withFixture({ maxAttempts: 2, timeoutMs: 150 }, async ({ provider, backend }) => {
          backend.script({ kind: 'failure', failure: 'stall' }, { kind: 'failure', failure: 'stall' });
          const error = await rejection(provider.transcribe({ audio: { mediaType: 'audio/ogg', data: OGG } }));
          assert.equal(error.code, 'ai.timeout');
          assert.equal(error.kind, 'ai_generation');
          assert.equal(backend.requests.length, 2);
        });
      },
    );

    unitTest(name('a dropped connection is retried and then surfaces as ai.unreachable'), async () => {
      await withFixture({ maxAttempts: 2 }, async ({ provider, backend }) => {
        backend.script({ kind: 'failure', failure: 'unreachable' }, { kind: 'failure', failure: 'unreachable' });
        const error = await rejection(provider.generate({ instructions: 'x', turns: [customer('hi')] }));
        assert.equal(error.code, 'ai.unreachable');
        assert.equal(backend.requests.length, 2);
      });
    });

    unitTest(name("the caller's abort ends the call promptly with the caller's reason, and nothing is retried"), async () => {
      await withFixture({ maxAttempts: 3, timeoutMs: 10_000 }, async ({ provider, backend }) => {
        backend.script({ kind: 'failure', failure: 'stall' });
        const controller = new AbortController();
        const reason = new Error('worker shutting down');
        const pending = provider.generate({ instructions: 'x', turns: [customer('hi')] }, { signal: controller.signal });
        setTimeout(() => controller.abort(reason), 50);
        await assert.rejects(pending, (error) => error === reason);
        assert.equal(backend.requests.length, 1);
      });
    });

    specTest(
      'operator-health-monitoring.md',
      'The system must ensure that any error diagnostics, logs, or drill-down detail shown to the operator are limited to operational/technical information',
      name('no failure carries conversation content, even when the upstream quotes the request back'),
      async () => {
        await withFixture({ maxAttempts: 1 }, async ({ provider, backend }) => {
          for (const failure of ['rate_limited', 'rejected', 'unauthorized', 'filtered'] as const) {
            backend.script({ kind: 'failure', failure });
            const error = await rejection(
              provider.generate({ instructions: `Rules ${NEEDLE}`, turns: [customer(`my card is ${NEEDLE}`)] }),
            );
            assert.ok(!error.message.includes(NEEDLE), `${failure}: message`);
            assert.ok(!JSON.stringify(error.toDiagnostic()).includes(NEEDLE), `${failure}: diagnostic`);
          }
        });
      },
    );

    // -----------------------------------------------------------------------
    // Refused before anything is sent
    // -----------------------------------------------------------------------

    specTest(
      'ai-provider-portability.md',
      'The system must continue to support all client-facing conversation capabilities in use at the time of the swap, subject only to the technical capabilities of the newly selected provider/model',
      name('a capability the model was not declared to have is refused before any request is sent'),
      async () => {
        await withFixture({ capabilities: ['text'] }, async ({ provider, backend }) => {
          assert.equal(provider.supports('vision'), false);
          assert.equal(provider.supports('audio'), false);

          const image = await rejection(
            provider.generate({
              instructions: 'x',
              turns: [{ role: 'customer', parts: [{ type: 'image', mediaType: 'image/jpeg', data: JPEG }] }],
            }),
          );
          assert.equal(image.code, 'ai.capability_unsupported');
          assert.equal(image.context['capability'], 'vision');
          assert.equal(image.kind, 'ai_generation', 'the reply path falls back rather than going silent');

          const voice = await rejection(provider.transcribe({ audio: { mediaType: 'audio/ogg', data: OGG } }));
          assert.equal(voice.code, 'ai.capability_unsupported');
          assert.equal(voice.context['capability'], 'audio');

          assert.equal(backend.requests.length, 0, 'no quota spent learning what was already declared');
        });
      },
    );

    unitTest(name('a malformed request is a ValidationError and never reaches the model'), async () => {
      await withFixture({}, async ({ provider, backend }) => {
        await assert.rejects(
          provider.generate({ instructions: 'x', turns: [customer('hi'), { role: 'bot', text: 'hello' }] }),
          ValidationError,
        );
        await assert.rejects(provider.generate({ instructions: ' ', turns: [customer('hi')] }), ValidationError);
        await assert.rejects(provider.generate({ instructions: 'x', turns: [] }), ValidationError);
        await assert.rejects(
          provider.transcribe({ audio: { mediaType: 'audio/ogg', data: OGG }, languageHint: 'Portuguese' }),
          ValidationError,
        );
        assert.equal(backend.requests.length, 0);
      });
    });
  });
}

async function rejection(promise: Promise<unknown>): Promise<ZedError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ZedError, `expected a ZedError, got ${String(error)}`);
    return error;
  }
  assert.fail('expected the call to fail');
}
