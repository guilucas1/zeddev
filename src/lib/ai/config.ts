/**
 * The AI environment schema.
 *
 * This list is the whole mechanism by which `ai-provider-portability.md` AC1 and
 * AC5 hold: changing provider, and changing back, is changing these values and
 * restarting. There is no code path per deployment and no default endpoint — the
 * base URL is always stated, because an embedded vendor URL is a deployment pinned
 * to one upstream that cannot be pointed at a sandbox, a gateway, or a local model
 * server without a code change.
 */

import { loadConfig, type Config, type ConfigSchema, type RawEnv } from '@zeddev/config';
import { ConfigurationError, type ConfigIssue } from '@zeddev/errors';
import { AI_PROVIDERS } from './registry.ts';
import { AI_CAPABILITIES, AI_PROVIDER_NAMES, type AiCapability, type AiProviderName, type AiSettings } from './types.ts';

export const AI_CONFIG_SCHEMA = {
  AI_PROVIDER: {
    type: 'enum',
    values: AI_PROVIDER_NAMES,
    description:
      'Which adapter speaks to the model: "gemini" for the Gemini generateContent API, "openai_compatible" for any server exposing /chat/completions (OpenAI, Groq, OpenRouter, or a local Ollama or llama.cpp server). Applies to every tenant at once. Changing it back reverts the swap; no tenant configuration is stored per provider, so nothing needs re-entering.',
    default: 'gemini',
  },
  AI_BASE_URL: {
    type: 'url',
    protocols: ['http', 'https'],
    description:
      'API root the adapter appends its paths to — the Gemini "v1beta" root, or the "/v1" root of an OpenAI-compatible server. Always stated, never defaulted, so the deployment names its upstream in configuration rather than in code.',
    example: 'https://example.com/v1',
  },
  AI_API_KEY: {
    type: 'string',
    description:
      'Credential for the provider. Empty sends none, which is correct for a local model server and for nothing reachable over the internet.',
    default: '',
    secret: true,
  },
  AI_MODEL: {
    type: 'string',
    pattern: /^\S{1,200}$/,
    description: 'Model that generates replies, exactly as the provider names it.',
    example: 'gemini-2.5-flash',
  },
  AI_TRANSCRIPTION_MODEL: {
    type: 'string',
    description:
      'Model that transcribes voice notes, when it is not AI_MODEL. Required for "openai_compatible" when AI_CAPABILITIES includes audio, because those servers transcribe with a dedicated speech model (e.g. whisper-large-v3) rather than the chat model. Empty means AI_MODEL.',
    default: '',
  },
  AI_CAPABILITIES: {
    type: 'string',
    pattern: /^[a-z]+(?:\s*,\s*[a-z]+)*$/,
    description:
      'Comma-separated list of what the configured model can do: text, vision (understand images), audio (transcribe voice notes). "text" is required. A message needing a capability not listed here is answered with the client\'s fallback message instead of being sent to a model that cannot handle it.',
    default: 'text,vision,audio',
  },
  AI_REQUEST_TIMEOUT: {
    type: 'duration',
    description:
      'How long one request to the provider may take, including reading the response. A request that exceeds it counts as a transient failure and is retried within AI_MAX_ATTEMPTS.',
    default: 60_000,
    min: 1_000,
    max: 600_000,
  },
  AI_MAX_ATTEMPTS: {
    type: 'integer',
    description:
      'Attempts per reply before the failure is surfaced and fallback applies. Only transient failures (rate limits, timeouts, 5xx) are retried; a rejected credential, a missing model, or a withheld reply is not, because a second attempt would only spend quota.',
    default: 3,
    min: 1,
    max: 10,
  },
} as const satisfies ConfigSchema;

export type AiConfig = Config<typeof AI_CONFIG_SCHEMA>;

export function loadAiConfig(env: RawEnv = process.env): AiConfig {
  return loadConfig(AI_CONFIG_SCHEMA, env);
}

/**
 * Parse the environment into the settings an adapter takes, including the checks
 * no single key can make: the capability list is a vocabulary, the model must be
 * able to hold a conversation at all, the adapter must be able to express what is
 * declared, and an OpenAI-compatible server must be told which model transcribes.
 * All of them are reported together, as `ConfigurationError` does for every key.
 */
export function loadAiSettings(env: RawEnv = process.env): AiSettings {
  const config = loadAiConfig(env);
  const provider = config.AI_PROVIDER as AiProviderName;
  const issues: ConfigIssue[] = [];

  const declared = config.AI_CAPABILITIES.split(',').map((c) => c.trim());
  const unknown = declared.filter((c) => !(AI_CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    issues.push({ key: 'AI_CAPABILITIES', reason: `unknown capability ${unknown.join(', ')}; must be drawn from ${AI_CAPABILITIES.join(', ')}` });
  } else if (!declared.includes('text')) {
    issues.push({ key: 'AI_CAPABILITIES', reason: 'must include "text": every conversation needs a model that can reply in text' });
  } else {
    const inexpressible = declared.filter((c) => !AI_PROVIDERS[provider].expressible.includes(c as AiCapability));
    if (inexpressible.length > 0) {
      issues.push({ key: 'AI_CAPABILITIES', reason: `the ${provider} adapter cannot express ${inexpressible.join(', ')}` });
    }
  }
  const capabilities = AI_CAPABILITIES.filter((c) => declared.includes(c));

  if (provider === 'openai_compatible' && capabilities.includes('audio') && config.AI_TRANSCRIPTION_MODEL === '') {
    issues.push({
      key: 'AI_TRANSCRIPTION_MODEL',
      reason: 'required when AI_PROVIDER is openai_compatible and AI_CAPABILITIES includes audio',
    });
  }
  if (issues.length > 0) throw new ConfigurationError(issues);

  return {
    provider,
    baseUrl: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY,
    model: config.AI_MODEL,
    transcriptionModel: config.AI_TRANSCRIPTION_MODEL,
    capabilities,
    requestTimeoutMs: config.AI_REQUEST_TIMEOUT,
    maxAttempts: config.AI_MAX_ATTEMPTS,
  };
}
