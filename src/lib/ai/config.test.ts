/**
 * Provider selection from configuration.
 *
 * `ai-provider-portability.md` AC1 and AC5 describe a swap and a revert that are
 * pure configuration changes. These tests hold the calling code fixed and vary only
 * the environment, which is the claim.
 */

import assert from 'node:assert/strict';
import { ConfigurationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { loadAiSettings } from './config.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAiCompatibleProvider } from './openai.ts';
import { createAiProvider } from './registry.ts';
import { startAiStub } from './testing.ts';
import type { AiProvider } from './types.ts';

const GEMINI_ENV = {
  AI_PROVIDER: 'gemini',
  AI_BASE_URL: 'https://example.com/v1beta',
  AI_API_KEY: 'gemini-test-key-value',
  AI_MODEL: 'gemini-2.5-flash',
};

const OPENAI_ENV = {
  AI_PROVIDER: 'openai_compatible',
  AI_BASE_URL: 'https://example.org/v1',
  AI_API_KEY: 'openai-test-key-value',
  AI_MODEL: 'llama-3.3-70b-versatile',
  AI_TRANSCRIPTION_MODEL: 'whisper-large-v3',
  AI_CAPABILITIES: 'text,audio',
};

/** The reply path's code, held fixed across a swap: it names no provider. */
async function answer(provider: AiProvider): Promise<string> {
  const result = await provider.generate({
    instructions: 'You are Lia.',
    turns: [{ role: 'customer', parts: [{ type: 'text', text: 'Olá' }] }],
  });
  return result.text;
}

specTest(
  'ai-provider-portability.md',
  'AC1 a provider swap is a configuration change, with no source change or code redeployment',
  'the same calling code is answered by Gemini or an OpenAI-compatible server depending only on the environment',
  async () => {
    for (const [provider, env, adapter] of [
      ['gemini', GEMINI_ENV, GeminiProvider],
      ['openai_compatible', OPENAI_ENV, OpenAiCompatibleProvider],
    ] as const) {
      const stub = await startAiStub(provider);
      try {
        stub.backend.script({ kind: 'text', text: `answered by ${provider}` });
        const instance = createAiProvider(loadAiSettings({ ...env, AI_BASE_URL: stub.baseUrl }));
        assert.ok(instance instanceof adapter);
        assert.equal(await answer(instance), `answered by ${provider}`);
        assert.equal(stub.backend.requests.length, 1);
      } finally {
        await stub.close();
      }
    }
  },
);

specTest(
  'ai-provider-portability.md',
  'AC5 reverting to the previous provider restores it without loss of any client configuration',
  'switching back to the previous environment yields the previous provider exactly, because no tenant configuration is held per provider',
  () => {
    const before = createAiProvider(loadAiSettings(GEMINI_ENV)).descriptor;
    createAiProvider(loadAiSettings(OPENAI_ENV));
    const after = createAiProvider(loadAiSettings(GEMINI_ENV)).descriptor;
    assert.deepEqual(after, before);
    // Nothing a tenant configured is an input here: the settings carry no tenant,
    // and persona, rules, and knowledge reach the model only as `instructions`
    // rendered per call — so there is nothing a swap could lose.
    assert.deepEqual(Object.keys(loadAiSettings(GEMINI_ENV)).sort(), [
      'apiKey',
      'baseUrl',
      'capabilities',
      'maxAttempts',
      'model',
      'provider',
      'requestTimeoutMs',
      'transcriptionModel',
    ]);
  },
);

specTest(
  'ai-provider-portability.md',
  'AC8 the operator can determine which provider and model is active',
  'the descriptor names the provider, the models, and the capabilities, and never the credential or endpoint',
  () => {
    const descriptor = createAiProvider(loadAiSettings(OPENAI_ENV)).descriptor;
    assert.deepEqual(descriptor, {
      provider: 'openai_compatible',
      model: 'llama-3.3-70b-versatile',
      transcriptionModel: 'whisper-large-v3',
      capabilities: ['text', 'audio'],
    });
    const rendered = JSON.stringify(descriptor);
    assert.ok(!rendered.includes('openai-test-key-value'));
    assert.ok(!rendered.includes('example.org'));

    const gemini = createAiProvider(loadAiSettings(GEMINI_ENV)).descriptor;
    assert.equal(gemini.transcriptionModel, 'gemini-2.5-flash', 'an empty transcription model means the chat model');
    assert.deepEqual(gemini.capabilities, ['text', 'vision', 'audio'], 'the default provider covers all three');
  },
);

specTest(
  'environment-portability.md',
  'AC7 clear configuration error',
  'every missing AI key is reported at once',
  () => {
    assert.throws(
      () => loadAiSettings({}),
      (error: unknown) => error instanceof ConfigurationError && error.keys.join() === 'AI_BASE_URL,AI_MODEL',
    );
  },
);

unitTest('the API key arrives wrapped, so the settings cannot leak it into a log line', () => {
  const settings = loadAiSettings(GEMINI_ENV);
  assert.ok(!JSON.stringify(settings).includes('gemini-test-key-value'));
  assert.equal(settings.apiKey.expose(), 'gemini-test-key-value');
});

unitTest('capabilities are parsed leniently in spacing and returned in canonical order', () => {
  const settings = loadAiSettings({ ...GEMINI_ENV, AI_CAPABILITIES: 'audio , text' });
  assert.deepEqual(settings.capabilities, ['text', 'audio']);
});

unitTest('an unknown capability, or a list without text, is a configuration error naming AI_CAPABILITIES', () => {
  for (const value of ['text,smell', 'vision,audio']) {
    assert.throws(
      () => loadAiSettings({ ...GEMINI_ENV, AI_CAPABILITIES: value }),
      (error: unknown) => error instanceof ConfigurationError && error.keys.join() === 'AI_CAPABILITIES',
      value,
    );
  }
});

unitTest('an OpenAI-compatible server declared to transcribe must be told which model transcribes', () => {
  const withoutTranscriber = { ...OPENAI_ENV, AI_TRANSCRIPTION_MODEL: '' };
  assert.throws(
    () => loadAiSettings(withoutTranscriber),
    (error: unknown) => error instanceof ConfigurationError && error.keys.join() === 'AI_TRANSCRIPTION_MODEL',
  );
  // Declaring no audio makes the transcription model unnecessary.
  assert.doesNotThrow(() => loadAiSettings({ ...withoutTranscriber, AI_CAPABILITIES: 'text,vision' }));
});

unitTest('a base URL that is not http(s) is refused', () => {
  assert.throws(
    () => loadAiSettings({ ...GEMINI_ENV, AI_BASE_URL: 'ftp://example.com/v1' }),
    (error: unknown) => error instanceof ConfigurationError && error.keys.join() === 'AI_BASE_URL',
  );
});
