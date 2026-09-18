/**
 * Composing the verification and reset messages, and delivering them without
 * making the response wait.
 *
 * This is the piece IMPLEMENTATION_PLAN.md §4f and §4g left open: `@zeddev/identity`
 * mints the tokens, `@zeddev/mail` carries bytes, and composing a link needs the
 * deployment's public base URL — a property of this service. Until something did
 * this, whoever *submitted* an address received the link, which is the definition
 * of not verifying that the signer controls it (`client-signup-and-tenancy.md`).
 *
 * ## Why delivery happens after the response
 *
 * `authentication-and-access.md` AC9 requires a recovery request for an
 * unregistered address be indistinguishable from one for a registered address.
 * The response body is identical by construction, but if the handler waited for
 * SMTP, a registered address would answer a mail-server round trip slower —
 * tens to hundreds of milliseconds, trivially measurable — and the careful body
 * would be undone by its timing. The same reasoning that makes `@zeddev/identity`
 * burn a decoy hash for unknown logins. So every message is handed to the outbox
 * and the response goes out immediately.
 *
 * ## Why in-process rather than through the durable queue
 *
 * The queue would survive a crash, but its payload table would then hold the raw
 * token, and the whole point of storing only a token's hash is that a database
 * read is not an account takeover. A message lost to a crash costs the client one
 * click on "send again" — `requestEmailVerification` and `requestPasswordReset`
 * already mint a fresh token each time — which is the cheaper failure by far.
 * Shutdown drains the outbox, so the only loss is to a crash.
 */

import type { Logger } from '@zeddev/logging';
import type { Mailer, MailMessage } from '@zeddev/mail';
import type { Secret } from '@zeddev/secrets';

/** The two kinds of mail this service sends. A closed list, so log records can classify without carrying content. */
export type MailKind = 'email_verification' | 'password_reset';

/**
 * The paths in the web dashboard that receive the links.
 *
 * The token travels in the URL *fragment*, never the query string. A browser does
 * not send the fragment to the server, so the token never appears in a web
 * server's access log, a reverse proxy's log, or a `Referer` header — any one of
 * which would put a single-use account-takeover credential into a system with a
 * different retention policy and a different set of readers. The dashboard reads
 * the fragment and posts the token to this API as a JSON body.
 */
export const LINK_PATHS: Readonly<Record<MailKind, string>> = {
  email_verification: 'verify-email',
  password_reset: 'reset-password',
};

export function buildLink(base: URL, kind: MailKind, token: Secret<string>): string {
  const url = new URL(LINK_PATHS[kind], base);
  url.hash = `token=${encodeURIComponent(token.expose())}`;
  return url.toString();
}

function formatExpiry(expiresAt: Date): string {
  // UTC, spelled out, because the recipient's timezone is unknown and a bare
  // time in the wrong zone is worse than an explicit one in a known zone.
  return `${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function verificationMessage(input: {
  readonly base: URL;
  readonly to: string;
  readonly token: Secret<string>;
  readonly expiresAt: Date;
}): MailMessage {
  return {
    to: input.to,
    subject: 'Confirm your email address',
    body: [
      'Confirm this email address to finish setting up your account:',
      '',
      buildLink(input.base, 'email_verification', input.token),
      '',
      `The link works once and expires at ${formatExpiry(input.expiresAt)}.`,
      'If you did not sign up, ignore this message and no account will be activated.',
    ].join('\n'),
  };
}

export function passwordResetMessage(input: {
  readonly base: URL;
  readonly to: string;
  readonly token: Secret<string>;
  readonly expiresAt: Date;
}): MailMessage {
  return {
    to: input.to,
    subject: 'Reset your password',
    body: [
      'Someone asked to reset the password for this email address. To choose a new one:',
      '',
      buildLink(input.base, 'password_reset', input.token),
      '',
      `The link works once and expires at ${formatExpiry(input.expiresAt)}.`,
      'Resetting signs out every existing session.',
      'If you did not ask for this, ignore this message — your password has not changed.',
    ].join('\n'),
  };
}

/**
 * Delivers messages in the background and can be drained on shutdown.
 *
 * A failure is logged and dropped rather than retried here: `SmtpMailer` already
 * retries transient failures up to `MAIL_MAX_ATTEMPTS`, and a second retry layer
 * above it would multiply the attempts without either layer knowing.
 */
export class MailOutbox {
  readonly #mailer: Mailer;
  readonly #logger: Logger;
  readonly #pending = new Set<Promise<void>>();

  constructor(mailer: Mailer, logger: Logger) {
    this.#mailer = mailer;
    this.#logger = logger.child({ component: 'outbox' });
  }

  get pending(): number {
    return this.#pending.size;
  }

  dispatch(kind: MailKind, message: MailMessage): void {
    const delivery = this.#mailer.send(message).then(
      (sent) => {
        this.#logger.info('api.mail.sent', { action: kind, messageId: sent.messageId });
      },
      (error: unknown) => {
        // The recipient is deliberately not logged: it is an email address, and
        // the log is an operator-visible surface. The request id on the
        // preceding request record is what ties this back to a report.
        this.#logger.error('api.mail.failed', error, { action: kind });
      },
    );
    const tracked = delivery.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  /**
   * Wait for every in-flight delivery, or until `timeoutMs` passes.
   *
   * Resolves to whether everything finished. Never rejects: each delivery already
   * handles its own failure, and a shutdown path that can throw is a shutdown path
   * that skips closing the database pool.
   */
  async drain(timeoutMs = Number.POSITIVE_INFINITY): Promise<boolean> {
    const all = Promise.all([...this.#pending]).then(() => true);
    if (!Number.isFinite(timeoutMs)) return all;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
      return await Promise.race([all, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
}
