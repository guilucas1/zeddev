/**
 * Runs the one conformance suite against the fake and against each real adapter
 * talking to a stub of its upstream. See `conformance.ts` for why one suite, and
 * `stubs.ts` for why stubs rather than a live model.
 */

import { Secret } from '@zeddev/secrets';
import { createAiProvider } from './registry.ts';
import { InMemoryAiProvider, runAiConformance, startAiStub } from './testing.ts';
import { AI_PROVIDER_NAMES } from './types.ts';

runAiConformance({
  label: 'in-memory',
  create: async (options) => {
    const provider = new InMemoryAiProvider({
      capabilities: options.capabilities,
      maxAttempts: options.maxAttempts,
      timeoutMs: options.timeoutMs,
    });
    return { provider, backend: provider.backend, dispose: async () => {} };
  },
});

for (const name of AI_PROVIDER_NAMES) {
  runAiConformance({
    label: name,
    create: async (options) => {
      const stub = await startAiStub(name);
      const provider = createAiProvider(
        {
          provider: name,
          baseUrl: stub.baseUrl,
          apiKey: new Secret('conformance-key', 'AI_API_KEY'),
          model: 'conformance-model',
          transcriptionModel: name === 'openai_compatible' ? 'conformance-whisper' : '',
          capabilities: options.capabilities,
          requestTimeoutMs: options.timeoutMs,
          maxAttempts: options.maxAttempts,
        },
        { backoff: () => 0 },
      );
      return { provider, backend: stub.backend, dispose: () => stub.close() };
    },
  });
}
