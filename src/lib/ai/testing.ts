/**
 * Test-only exports.
 *
 * Kept behind a separate subpath so a service cannot reach the fake by accident. A
 * production import of `InMemoryAiProvider` would be a platform where every
 * customer is answered "Scripted reply." — and, unlike a failing provider, nothing
 * would report an error. Same reasoning as `@zeddev/mail`, `@zeddev/queue`, and
 * `@zeddev/storage`.
 */

export {
  DEFAULT_SCRIPTED_REPLY,
  InMemoryAiProvider,
  SCRIPTED_FAILURES,
  ScriptedBackend,
  type InMemoryAiProviderOptions,
  type ObservedGeneration,
  type ObservedPart,
  type ObservedRequest,
  type ObservedTranscription,
  type ScriptedFailure,
  type ScriptedOutcome,
} from './memory.ts';
export { runAiConformance, type AiFixture, type AiFixtureOptions, type AiHarness } from './conformance.ts';
export { startAiStub, type AiStub, type WireRecord } from './stubs.ts';
