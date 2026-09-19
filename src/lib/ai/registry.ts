/**
 * The provider registry: the one place a provider name becomes an adapter.
 *
 * `ai-provider-portability.md` AC1 requires a swap need no source change, which is
 * only true if nothing outside this table branches on which provider is active. The
 * table is keyed by `AiProviderName`, so a name added to the vocabulary without an
 * adapter here — or an adapter added without a name — does not compile.
 */

import type { AdapterDependencies } from './adapter.ts';
import { GeminiProvider } from './gemini.ts';
import { OpenAiCompatibleProvider } from './openai.ts';
import type { AiCapability, AiProvider, AiProviderName, AiSettings } from './types.ts';

export interface ProviderEntry {
  /**
   * What the adapter's wire format can carry. The operator declares what the
   * configured *model* can do (`AI_CAPABILITIES`); that declaration must be a subset
   * of this, since no model can do what its adapter cannot express.
   */
  readonly expressible: readonly AiCapability[];
  create(settings: AiSettings, deps: AdapterDependencies): AiProvider;
}

export const AI_PROVIDERS: Readonly<Record<AiProviderName, ProviderEntry>> = {
  gemini: {
    expressible: ['text', 'vision', 'audio'],
    create: (settings, deps) => new GeminiProvider(settings, deps),
  },
  openai_compatible: {
    expressible: ['text', 'vision', 'audio'],
    create: (settings, deps) => new OpenAiCompatibleProvider(settings, deps),
  },
};

/**
 * Build the platform's active provider.
 *
 * Takes no tenant: the selection is platform-wide (AC6), so every tenant's bot is
 * answered by whatever this returns, and there is no parameter through which one
 * tenant could end up on a different model from the rest.
 */
export function createAiProvider(settings: AiSettings, deps: AdapterDependencies = {}): AiProvider {
  return AI_PROVIDERS[settings.provider].create(settings, deps);
}
