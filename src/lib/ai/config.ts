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
import type { Secret } from '@zeddev/secrets';
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
 * The candidate slot: a second provider the operator can exercise before it
 * answers anyone — `ai-provider-portability.md` AC4.
 *
 * A separate schema, loaded only by the API, rather than a mode of the active one:
 * the conversation worker never reads these keys, so a candidate structurally
 * cannot reach a live conversation however it is configured. Promotion and revert
 * are the same move — exchange the value of each `AI_*` key with its
 * `AI_CANDIDATE_*` counterpart and restart — so after a promotion the previous
 * provider sits in the candidate slot, still verifiable, one exchange away from
 * being restored (AC5).
 *
 * Timeouts and attempts are not repeated here: the candidate is exercised under the
 * same `AI_REQUEST_TIMEOUT` and `AI_MAX_ATTEMPTS` it would serve under, or a
 * verification could pass on a budget live traffic does not get.
 */
export const AI_CANDIDATE_CONFIG_SCHEMA = {
  AI_CANDIDATE_PROVIDER: {
    type: 'enum',
    values: ['none', ...AI_PROVIDER_NAMES],
    description:
      'A provider the operator can verify from the operator dashboard before it answers any conversation: "none", or an AI_PROVIDER value. Never used for a live reply. To promote it, exchange each AI_CANDIDATE_* value with its AI_* counterpart and restart the API and the conversation worker; the previous provider is then the candidate, and exchanging them back reverts.',
    default: 'none',
  },
  AI_CANDIDATE_BASE_URL: {
    type: 'url',
    protocols: ['http', 'https'],
    description: 'The candidate\'s API root, as AI_BASE_URL. Required when AI_CANDIDATE_PROVIDER is not "none".',
    default: '',
    example: 'https://example.com/v1',
  },
  AI_CANDIDATE_API_KEY: {
    type: 'string',
    description: 'The candidate\'s credential, as AI_API_KEY.',
    default: '',
    secret: true,
  },
  AI_CANDIDATE_MODEL: {
    type: 'string',
    pattern: /^\S{1,200}$/,
    description: 'The candidate\'s reply model, as AI_MODEL. Required when AI_CANDIDATE_PROVIDER is not "none".',
    default: '',
    example: 'gemini-2.5-flash',
  },
  AI_CANDIDATE_TRANSCRIPTION_MODEL: {
    type: 'string',
    description: 'The candidate\'s transcription model, as AI_TRANSCRIPTION_MODEL.',
    default: '',
  },
  AI_CANDIDATE_CAPABILITIES: {
    type: 'string',
    pattern: /^[a-z]+(?:\s*,\s*[a-z]+)*$/,
    description:
      'What the candidate model can do, as AI_CAPABILITIES. A capability the active provider lists and the candidate does not is reported by verification as a gap the swap would open.',
    default: 'text,vision,audio',
  },
} as const satisfies ConfigSchema;

export type AiCandidateConfig = Config<typeof AI_CANDIDATE_CONFIG_SCHEMA>;

/** One provider slot's raw values, and the keys an issue about them must name. */
interface SlotValues {
  readonly provider: AiProviderName;
  readonly baseUrl: string;
  readonly apiKey: Secret<string>;
  readonly model: string;
  readonly transcriptionModel: string;
  readonly capabilities: string;
  readonly keys: { readonly capabilities: string; readonly transcriptionModel: string };
}

/**
 * The checks no single key can make, written once for both slots: the capability
 * list is a vocabulary, the model must be able to hold a conversation at all, the
 * adapter must be able to express what is declared, and an OpenAI-compatible
 * server must be told which model transcribes. A candidate held to looser rules
 * than the active provider could pass verification and then refuse to start once
 * promoted.
 */
function settingsFrom(
  slot: SlotValues,
  shared: { readonly requestTimeoutMs: number; readonly maxAttempts: number },
  issues: ConfigIssue[],
): AiSettings {
  const { provider, keys } = slot;
  const declared = slot.capabilities.split(',').map((c) => c.trim());
  const unknown = declared.filter((c) => !(AI_CAPABILITIES as readonly string[]).includes(c));
  if (unknown.length > 0) {
    issues.push({ key: keys.capabilities, reason: `unknown capability ${unknown.join(', ')}; must be drawn from ${AI_CAPABILITIES.join(', ')}` });
  } else if (!declared.includes('text')) {
    issues.push({ key: keys.capabilities, reason: 'must include "text": every conversation needs a model that can reply in text' });
  } else {
    const inexpressible = declared.filter((c) => !AI_PROVIDERS[provider].expressible.includes(c as AiCapability));
    if (inexpressible.length > 0) {
      issues.push({ key: keys.capabilities, reason: `the ${provider} adapter cannot express ${inexpressible.join(', ')}` });
    }
  }
  const capabilities = AI_CAPABILITIES.filter((c) => declared.includes(c));

  if (provider === 'openai_compatible' && capabilities.includes('audio') && slot.transcriptionModel === '') {
    issues.push({
      key: keys.transcriptionModel,
      reason: `required when the provider is openai_compatible and ${keys.capabilities} includes audio`,
    });
  }

  return {
    provider,
    baseUrl: slot.baseUrl,
    apiKey: slot.apiKey,
    model: slot.model,
    transcriptionModel: slot.transcriptionModel,
    capabilities,
    requestTimeoutMs: shared.requestTimeoutMs,
    maxAttempts: shared.maxAttempts,
  };
}

/**
 * Parse the environment into the settings the active provider's adapter takes.
 * Every problem is reported together, as `ConfigurationError` does for single keys.
 */
export function loadAiSettings(env: RawEnv = process.env): AiSettings {
  const config = loadAiConfig(env);
  const issues: ConfigIssue[] = [];
  const settings = settingsFrom(
    {
      provider: config.AI_PROVIDER as AiProviderName,
      baseUrl: config.AI_BASE_URL,
      apiKey: config.AI_API_KEY,
      model: config.AI_MODEL,
      transcriptionModel: config.AI_TRANSCRIPTION_MODEL,
      capabilities: config.AI_CAPABILITIES,
      keys: { capabilities: 'AI_CAPABILITIES', transcriptionModel: 'AI_TRANSCRIPTION_MODEL' },
    },
    { requestTimeoutMs: config.AI_REQUEST_TIMEOUT, maxAttempts: config.AI_MAX_ATTEMPTS },
    issues,
  );
  if (issues.length > 0) throw new ConfigurationError(issues);
  return settings;
}

const SHARED_ATTEMPT_SCHEMA = {
  AI_REQUEST_TIMEOUT: AI_CONFIG_SCHEMA.AI_REQUEST_TIMEOUT,
  AI_MAX_ATTEMPTS: AI_CONFIG_SCHEMA.AI_MAX_ATTEMPTS,
} as const satisfies ConfigSchema;

/**
 * Parse the candidate slot, or `undefined` when none is configured.
 *
 * A candidate key set while `AI_CANDIDATE_PROVIDER` is "none" is refused rather
 * than ignored: an operator who filled in a model and forgot the provider would
 * otherwise be told there is nothing to verify.
 */
export function loadAiCandidateSettings(env: RawEnv = process.env): AiSettings | undefined {
  const candidate = loadConfig(AI_CANDIDATE_CONFIG_SCHEMA, env);
  const shared = loadConfig(SHARED_ATTEMPT_SCHEMA, env);
  const issues: ConfigIssue[] = [];

  if (candidate.AI_CANDIDATE_PROVIDER === 'none') {
    for (const key of Object.keys(AI_CANDIDATE_CONFIG_SCHEMA).sort()) {
      const raw = env[key];
      if (key !== 'AI_CANDIDATE_PROVIDER' && raw !== undefined && raw.trim() !== '') {
        issues.push({ key, reason: 'is set, but AI_CANDIDATE_PROVIDER is "none", so it would be ignored' });
      }
    }
    if (issues.length > 0) throw new ConfigurationError(issues);
    return undefined;
  }

  for (const key of ['AI_CANDIDATE_BASE_URL', 'AI_CANDIDATE_MODEL'] as const) {
    if (candidate[key] === '') {
      issues.push({ key, reason: `required when AI_CANDIDATE_PROVIDER is ${candidate.AI_CANDIDATE_PROVIDER}` });
    }
  }
  const settings = settingsFrom(
    {
      provider: candidate.AI_CANDIDATE_PROVIDER as AiProviderName,
      baseUrl: candidate.AI_CANDIDATE_BASE_URL,
      apiKey: candidate.AI_CANDIDATE_API_KEY,
      model: candidate.AI_CANDIDATE_MODEL,
      transcriptionModel: candidate.AI_CANDIDATE_TRANSCRIPTION_MODEL,
      capabilities: candidate.AI_CANDIDATE_CAPABILITIES,
      keys: { capabilities: 'AI_CANDIDATE_CAPABILITIES', transcriptionModel: 'AI_CANDIDATE_TRANSCRIPTION_MODEL' },
    },
    { requestTimeoutMs: shared.AI_REQUEST_TIMEOUT, maxAttempts: shared.AI_MAX_ATTEMPTS },
    issues,
  );
  if (issues.length > 0) throw new ConfigurationError(issues);
  return settings;
}
