/**
 * `@zeddev/mail` — delivering the links that make an email address mean
 * something.
 *
 * What it owns: the SMTP conversation, the RFC 5322 bytes, and the refusal of
 * any input that could turn one message into two.
 *
 * What it does not own: what the messages say. `send` takes a finished subject
 * and body, because composing a verification link needs the deployment's public
 * base URL — a property of the service that serves the link, not of the
 * transport that carries it. That is the same line IMPLEMENTATION_PLAN.md §1
 * draws to keep HTTP out of `@zeddev/identity`, and it is why this package
 * depends on neither.
 *
 * Import `InMemoryMailer` from `@zeddev/mail/testing`, never from here. A
 * production import of the fake would be a platform where every verification
 * link is delivered to an array — and, unlike a dropped message, it would report
 * success.
 */

export { MAIL_CONFIG_SCHEMA, loadMailConfig, loadSmtpSettings, type MailConfig } from './config.ts';
export {
  assertEnvelopeAddress,
  buildMessage,
  dataTerminator,
  dotStuff,
  encodeHeaderText,
  formatAddressHeader,
  formatDate,
  mintMessageId,
  MAX_ADDRESS_LENGTH,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_SUBJECT_LENGTH,
  type BuildMessageInput,
  type BuiltMessage,
} from './message.ts';
export { SmtpMailer, type SmtpMailerOptions } from './smtp.ts';
export { createConnector, type SmtpConnection, type SmtpConnectOptions, type SmtpConnector } from './socket.ts';
export {
  MAIL_TLS_MODES,
  type Mailer,
  type MailMessage,
  type MailTlsMode,
  type SentMail,
  type SmtpSettings,
} from './types.ts';
