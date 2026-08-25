/**
 * Test-facing surface of `@zeddev/queue`: the in-memory adapter and the shared
 * conformance suite.
 *
 * Kept behind a separate export rather than on the main one so that a service
 * cannot reach the fake by accident. A production import of `InMemoryQueue`
 * would be a queue that loses every job on restart — the exact failure
 * `message-delivery-reliability.md` AC6 forbids — and the failure would look like
 * nothing at all until a deploy.
 */

export { InMemoryQueue, type InMemoryQueueOptions } from './memory.ts';
export {
  runQueueConformance,
  type HarnessQueueOptions,
  type QueueFixture,
  type QueueHarness,
} from './conformance.ts';
