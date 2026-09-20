/**
 * Test-only exports.
 *
 * Behind a separate subpath so a service cannot reach the fake by accident. A
 * production import of `InMemoryWhatsAppCloud` would be a platform that reports
 * every number as connected and delivers nothing — and, unlike a failing Meta,
 * nothing would raise an error. Same reasoning as `@zeddev/ai`, `@zeddev/mail`,
 * `@zeddev/queue`, and `@zeddev/storage`.
 */

export {
  CLOUD_OPERATIONS,
  InMemoryWhatsAppCloud,
  isScriptedFailure,
  ScriptedCloudBackend,
  type CloudOperation,
  type InMemoryWhatsAppCloudOptions,
  type ObservedSend,
  type ScriptedAccount,
  type ScriptedFailure,
} from './memory.ts';
export { runWhatsAppCloudConformance, type CloudFixture, type CloudHarness } from './conformance.ts';
export { startGraphStub, type GraphStub, type WireRecord } from './stubs.ts';
