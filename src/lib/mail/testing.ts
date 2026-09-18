/**
 * Test-only exports.
 *
 * Kept behind a separate subpath rather than on the main one so a service cannot
 * reach the fake by accident. A production import of `InMemoryMailer` would be a
 * platform whose verification and password-reset links are delivered to an
 * in-process array: every signup appears to succeed, no client can ever verify,
 * and nothing anywhere reports an error. Same reasoning as `@zeddev/queue` and
 * `@zeddev/storage`.
 */

export { InMemoryMailer, type DeliveredMail, type InMemoryMailerOptions } from './memory.ts';
export {
  runMailConformance,
  type MailFixture,
  type MailHarness,
} from './conformance.ts';
export {
  createTestMailbox,
  decodeMail,
  mailTestConfigured,
  SKIP_REASON,
  type DecodedMail,
  type ServerParsedMail,
  type TestMailbox,
} from './fixtures.ts';
