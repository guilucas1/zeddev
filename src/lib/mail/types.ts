/**
 * The mail port.
 *
 * This is deliberately the smallest surface that closes the loop
 * `client-signup-and-tenancy.md` leaves open. That spec requires the system
 * "verify that the signup email address is valid and controlled by the signer
 * before the account is treated as active", and `authentication-and-access.md`
 * requires a self-service password reset. `@zeddev/identity` implements both by
 * minting a single-use token — and then hands it back to its caller, because a
 * domain library has no business opening a socket. Until something delivers that
 * token to the mailbox it names, "controlled by the signer" is not a property the
 * platform has: whoever *submits* the address receives the link, which is the
 * definition of not verifying control.
 *
 * Three choices in this interface are narrower than they could be, each for a
 * reason worth keeping.
 *
 * **One recipient, not a list.** No spec needs a second. A list, on the other
 * hand, is where a verification link addressed to one account reaches another —
 * either through a loop bug or through a header-injection bug, which is the
 * classic way a mail-sending surface is turned into an open relay. A port that
 * cannot express "more than one recipient" cannot express that failure. This is
 * the same move `@zeddev/storage` makes by refusing to accept an object key: the
 * dangerous operation is absent rather than guarded.
 *
 * **Plain text, no HTML, no attachments.** Every message the platform sends is a
 * sentence and a link. HTML would add a second body to keep in sync, a second
 * escaping context for client-supplied text such as a business name, and a
 * multipart encoder. Attachments would add a path by which tenant content leaves
 * the platform through a channel no spec asked for.
 *
 * **No templating.** `send` takes a finished subject and body. Composing them
 * needs the deployment's public base URL, which is a property of the service that
 * serves the link rather than of the transport that carries it — so composition
 * belongs to the caller, on exactly the reasoning IMPLEMENTATION_PLAN.md §1
 * records for keeping HTTP out of `@zeddev/identity`.
 */

import type { Secret } from '@zeddev/secrets';

/**
 * A message to deliver.
 *
 * `to`, `subject`, `replyTo`, and `body` are all caller-supplied and may
 * ultimately derive from a client-entered business name or email address, so
 * every one of them is validated in `buildMessage` before a byte is written.
 */
export interface MailMessage {
  /** The single recipient. Validated as an SMTP envelope address, not as an account identifier — see `assertEnvelopeAddress`. */
  readonly to: string;
  /** Subject line. Encoded per RFC 2047 when it is not pure ASCII. */
  readonly subject: string;
  /** Plain-text body. May contain any Unicode; the encoder picks a transfer encoding that survives it. */
  readonly body: string;
  /** Optional Reply-To. Absent means replies go to the configured From address. */
  readonly replyTo?: string | undefined;
}

/**
 * What a successful send reports back.
 *
 * The message id is the one the platform minted and placed in the `Message-ID`
 * header, not one assigned by the remote. It is safe to log — it identifies a
 * delivery attempt without naming the recipient — which is what makes it useful
 * when a client says a link never arrived.
 */
export interface SentMail {
  readonly messageId: string;
}

/**
 * The port every mail-sending caller depends on.
 *
 * `verifyAccess` exists for the same reason `ObjectStore.verifyAccess` does:
 * `environment-portability.md` requires the system "fail with a clear,
 * diagnosable configuration error when required configuration for the target
 * environment is missing or invalid, rather than silently falling back to
 * incorrect behavior or partially starting". A mail server whose credentials are
 * wrong is otherwise discovered at the first signup, by a client who never
 * receives a link and has no way to report a failure they cannot see.
 */
export interface Mailer {
  /**
   * Deliver one message.
   *
   * Resolves only once the remote has accepted responsibility for the message.
   * Throws `TransientTransportError` for a failure worth retrying and
   * `TerminalTransportError` for one that is not; `ValidationError` for a message
   * this port refuses to encode.
   */
  send(message: MailMessage): Promise<SentMail>;

  /**
   * Prove at startup that the configured server is reachable and the configured
   * credentials are accepted, without sending anything.
   *
   * Throws `ConfigurationError` naming the offending key when the failure is a
   * misconfiguration, so the operator is told which value to fix rather than
   * being handed a protocol reply code.
   */
  verifyAccess(): Promise<void>;

  /** Release anything held open. Safe to call more than once. */
  close(): Promise<void>;
}

/**
 * How TLS is reached, stated rather than discovered.
 *
 * There is no "opportunistic" mode, and that is the one decision here worth
 * defending. Opportunistic STARTTLS — try it, carry on in cleartext if the server
 * does not offer it — is the common default, and it means a server that stops
 * advertising STARTTLS silently downgrades every message, credentials included,
 * to plaintext. Nothing observable changes. `starttls` therefore *requires*
 * STARTTLS and fails if it is not offered; a deployment that genuinely wants
 * cleartext says `disable` and means it.
 *
 * The three values are also the complete answer to why a laptop, a VPS, and a
 * managed cloud differ here, which is what `environment-portability.md` AC6 asks
 * of the configuration list. Choosing between them by inspecting the port number
 * — 465 means implicit, 587 means STARTTLS — is the convention everywhere else,
 * and it is environment detection wearing a disguise, which AC5 forbids.
 */
export const MAIL_TLS_MODES = ['disable', 'starttls', 'implicit'] as const;
export type MailTlsMode = (typeof MAIL_TLS_MODES)[number];

/**
 * Everything an SMTP adapter needs, already parsed.
 *
 * Separate from the environment schema so that a test can construct one directly
 * without going through `process.env`, and so the adapter never reads a raw
 * string.
 */
export interface SmtpSettings {
  readonly host: string;
  readonly port: number;
  readonly tls: MailTlsMode;
  readonly caCertificate?: string | undefined;
  readonly username: string;
  readonly password: Secret<string>;
  /**
   * Permit AUTH over a connection that is not encrypted.
   *
   * False by default because AUTH PLAIN over cleartext puts the password on the
   * wire in base64, which is not encryption. True is correct for exactly one
   * situation — a server reached over a trusted local network, such as a
   * container on the same host — and `credential-and-secret-handling.md` is
   * strict enough about credential disclosure that this should be a visible act
   * rather than a default.
   */
  readonly allowInsecureAuth: boolean;
  readonly fromAddress: string;
  readonly fromName: string;
  /** Name announced in EHLO. Many providers reject a client that does not present a resolvable name. */
  readonly ehloName: string;
  readonly connectTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly maxAttempts: number;
}
