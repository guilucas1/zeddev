/**
 * Wire details specific to each adapter — the things the conformance suite
 * deliberately cannot see, because they are not part of the port's meaning but
 * are part of each upstream's contract.
 */

import assert from 'node:assert/strict';
import { unitTest } from '@zeddev/testing';
import { Secret } from '@zeddev/secrets';
import { createAiProvider } from './registry.ts';
import { startAiStub, type AiStub } from './testing.ts';
import type { AiProviderName, AiSettings } from './types.ts';

function settings(provider: AiProviderName, stub: AiStub, key: string): AiSettings {
  return {
    provider,
    baseUrl: `${stub.baseUrl}/`,
    apiKey: new Secret(key, 'AI_API_KEY'),
    model: 'wire-model',
    transcriptionModel: provider === 'openai_compatible' ? 'wire-whisper' : '',
    capabilities: ['text', 'vision', 'audio'],
    requestTimeoutMs: 2_000,
    maxAttempts: 1,
  };
}

const hello = { instructions: 'x', turns: [{ role: 'customer' as const, parts: [{ type: 'text' as const, text: 'hello' }] }] };

async function withStub(provider: AiProviderName, body: (stub: AiStub) => Promise<void>): Promise<void> {
  const stub = await startAiStub(provider);
  try {
    await body(stub);
  } finally {
    await stub.close();
  }
}

unitTest('gemini: the key travels in x-goog-api-key and never in the URL, where logs would record it', async () => {
  await withStub('gemini', async (stub) => {
    await createAiProvider(settings('gemini', stub, 'wire-gemini-key')).generate(hello);
    const [request] = stub.wire;
    assert.equal(request?.path, '/v1beta/models/wire-model:generateContent', 'a trailing slash on the base URL is tolerated');
    assert.equal(request?.search, '');
    assert.equal(request?.headers['x-goog-api-key'], 'wire-gemini-key');
    assert.equal(request?.headers['authorization'], undefined);
  });
});

unitTest('openai_compatible: the key is a bearer token, and with no key no Authorization header is sent at all', async () => {
  await withStub('openai_compatible', async (stub) => {
    await createAiProvider(settings('openai_compatible', stub, 'wire-openai-key')).generate(hello);
    await createAiProvider(settings('openai_compatible', stub, '')).generate(hello);
    assert.equal(stub.wire[0]?.path, '/v1/chat/completions');
    assert.equal(stub.wire[0]?.headers['authorization'], 'Bearer wire-openai-key');
    assert.equal(stub.wire[1]?.headers['authorization'], undefined, 'a local model server takes no credential');
  });
});

unitTest('openai_compatible: a text-only turn is sent as a plain string, which text-only models require', async () => {
  await withStub('openai_compatible', async (stub) => {
    let sent: unknown;
    const capture: typeof fetch = async (input, init) => {
      sent = JSON.parse(String(init?.body));
      return fetch(input, init);
    };
    await createAiProvider(settings('openai_compatible', stub, 'k'), { fetch: capture }).generate(hello);
    assert.deepEqual((sent as { messages: unknown[] }).messages, [
      { role: 'system', content: 'x' },
      { role: 'user', content: 'hello' },
    ]);
  });
});

unitTest('openai_compatible: a voice note is uploaded with a file name whose extension names its container', async () => {
  await withStub('openai_compatible', async (stub) => {
    let form: FormData | undefined;
    const capture: typeof fetch = async (input, init) => {
      form = init?.body as FormData;
      return fetch(input, init);
    };
    const provider = createAiProvider(settings('openai_compatible', stub, 'k'), { fetch: capture });
    await provider.transcribe({ audio: { mediaType: 'audio/ogg', data: Buffer.from('OggS-voice') }, languageHint: 'pt-BR' });
    assert.equal(stub.wire[0]?.path, '/v1/audio/transcriptions');
    assert.equal((form?.get('file') as File).name, 'voice.ogg');
    assert.equal(form?.get('model'), 'wire-whisper');
    assert.equal(form?.get('language'), 'pt', 'Whisper takes ISO 639-1, not a full tag');
  });
});
