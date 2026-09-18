/**
 * A hand-written SMTP client.
 *
 * Hand-written for the third time in this repo, on the reasoning
 * IMPLEMENTATION_PLAN.md §1 already records twice: every dependency is a
 * supply-chain and maintenance cost carried against a near-zero-fixed-cost
 * premise, and the needed subset of SMTP is small and closed. The protocol has
 * been stable since RFC 821 in 1982; the extensions this uses — EHLO, STARTTLS,
 * AUTH — since the 1990s. The usual objection, that a hand-written protocol
 * implementation is where subtle bugs live, is answered the same way it was for
 * the PostgreSQL client and the SigV4 signer: there is no fake server in this
 * package, so every path that a real server can exercise is tested against one,
 * and the read-back through Mailpit's API is an external oracle for the bytes.
 *
 * One adapter, never two, for the same reason `@zeddev/storage` has one
 * S3-compatible adapter: a Mailpit container on a laptop, a Postfix relay on a
 * VPS, and a managed provider in the cloud all speak SMTP, so all three are this
 * code reached through different `MAIL_*` values. A provider-specific HTTP API
 * would be one adapter per provider and would make `environment-portability.md`'s
 * "moved between tiers through configuration alone" false the first time the
 * operator changed providers.
 *
 * ## One connection per message
 *
 * No pooling and no pipelining. SMTP permits both, and at this platform's volume
 * — a verification link at signup, a reset link on request — neither buys
 * anything, while a pooled connection that a provider silently drops after an
 * idle minute is a class of intermittent failure that only appears in
 * production. If bulk operator alerting later makes this the wrong trade, it is a
 * change behind this interface.
 */

import { isRetryable, ConfigurationError, TerminalTransportError, TransientTransportError } from '@zeddev/errors';
import { Logger } from '@zeddev/logging';
import { exponentialBackoff, SystemClock, type Clock } from '@zeddev/time';
import { buildMessage, dataTerminator, dotStuff, mintMessageId, type BuiltMessage } from './message.ts';
import { createConnector, type SmtpConnection, type SmtpConnector } from './socket.ts';
import type { Mailer, MailMessage, SentMail, SmtpSettings } from './types.ts';

/**
 * The phase a session failed in, which is the whole of what makes a startup
 * failure diagnosable.
 *
 * IMPLEMENTATION_PLAN.md §4e records the equivalent lesson from object storage:
 * the first `verifyAccess` there collapsed every misconfiguration into one
 * undiagnosable 403, which defeats the purpose of a preflight. "The mail server
 * rejected something" tells an operator nothing; "MAIL_PASSWORD was not accepted"
 * tells them exactly which of fourteen values to look at.
 */
type Phase = 'connect' | 'greeting' | 'ehlo' | 'starttls' | 'auth' | 'transaction';

const PHASE_CONFIG_KEYS: Readonly<Record<Phase, readonly string[]>> = {
  connect: ['MAIL_HOST', 'MAIL_PORT', 'MAIL_TLS'],
  greeting: ['MAIL_HOST', 'MAIL_PORT', 'MAIL_TLS'],
  ehlo: ['MAIL_EHLO_NAME'],
  starttls: ['MAIL_TLS', 'MAIL_CA_CERTIFICATE'],
  auth: ['MAIL_USERNAME', 'MAIL_PASSWORD'],
  transaction: ['MAIL_FROM_ADDRESS'],
};

interface SmtpReply {
  readonly code: number;
  readonly lines: readonly string[];
}

/**
 * How much of a reply to buffer before giving up.
 *
 * A server that answers EHLO with an unbounded stream and never terminates the
 * reply would otherwise grow this buffer until the process dies. That is a
 * remote's failure becoming the platform's, which `component-independence.md`
 * asks the system not to do.
 */
const MAX_REPLY_BYTES = 64 * 1024;

export interface SmtpMailerOptions {
  readonly connector?: SmtpConnector | undefined;
  readonly logger?: Logger | undefined;
  readonly clock?: Clock | undefined;
  /** Source of the `Date` header and the retry timing. Separate from `clock` only so tests can pin one without the other. */
  readonly now?: (() => Date) | undefined;
}

/**
 * Marks the point after which a failure has an unknown outcome.
 *
 * Once the terminating dot has been written, the server may have accepted the
 * message and lost the connection before its 250 reached us. Retrying then sends
 * a second copy of a message that may already be in the recipient's mailbox. This
 * is the one place in the package where the at-least-once instinct the rest of
 * the platform follows is deliberately reversed: the caller can always request
 * another link, so an unknown outcome is surfaced rather than duplicated.
 */
interface AttemptState {
  committed: boolean;
  phase: Phase;
}

export class SmtpMailer implements Mailer {
  readonly #settings: SmtpSettings;
  readonly #connector: SmtpConnector;
  readonly #logger: Logger;
  readonly #clock: Clock;
  readonly #now: () => Date;
  readonly #backoff: (attempt: number) => number;
  #closed = false;

  constructor(settings: SmtpSettings, options: SmtpMailerOptions = {}) {
    this.#settings = settings;
    this.#connector = options.connector ?? createConnector();
    this.#logger = (options.logger ?? new Logger()).child({ component: 'mail' });
    this.#clock = options.clock ?? new SystemClock();
    this.#now = options.now ?? ((): Date => this.#clock.now());
    // The same curve `@zeddev/storage` retries on, from `@zeddev/time`. A mail
    // provider on a free tier answers a burst with a 4xx for the same reason an
    // object store answers with SlowDown, and full jitter is what stops several
    // instances from retrying in lockstep.
    this.#backoff = exponentialBackoff({ baseMs: 250, maxMs: 10_000 });

    // Validated here rather than only in the schema because a caller may build
    // settings directly, and every one of these lands inside an SMTP command
    // where a CRLF would start a second one.
    assertCommandSafe(settings.ehloName, 'MAIL_EHLO_NAME');
    assertCommandSafe(settings.username, 'MAIL_USERNAME');
  }

  async send(message: MailMessage): Promise<SentMail> {
    if (this.#closed) {
      throw new TerminalTransportError('Mailer is closed', { code: 'mail.closed' });
    }

    // Built once, outside the retry loop, so the `Message-ID` is identical on
    // every attempt. If a retry ever does duplicate a message, a receiving mail
    // system can collapse the copies — which it cannot do if each attempt mints a
    // new id.
    const built = buildMessage({
      from: this.#settings.fromAddress,
      fromName: this.#settings.fromName,
      to: message.to,
      subject: message.subject,
      body: message.body,
      replyTo: message.replyTo,
      messageId: mintMessageId(this.#settings.fromAddress),
      date: this.#now(),
    });

    const maxAttempts = this.#settings.maxAttempts;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const state: AttemptState = { committed: false, phase: 'connect' };
      const startedAt = this.#clock.monotonicMs();
      try {
        await this.#deliver(built, state);
        this.#logger.info('mail.sent', {
          messageId: built.messageId,
          attempt,
          durationMs: Math.round(this.#clock.monotonicMs() - startedAt),
          outcome: 'allowed',
        });
        return { messageId: built.messageId };
      } catch (error) {
        lastError = error;
        const terminal = state.committed || !isRetryable(error) || attempt === maxAttempts;
        this.#logger.warn('mail.send_failed', {
          messageId: built.messageId,
          attempt,
          reason: state.phase,
          retryable: !terminal,
        });
        if (terminal) break;
        await this.#clock.sleep(this.#backoff(attempt));
      }
    }

    throw lastError;
  }

  async verifyAccess(): Promise<void> {
    const state: AttemptState = { committed: false, phase: 'connect' };
    let session: Session | undefined;
    try {
      session = await this.#open(state);
      await session.quit();
    } catch (error) {
      throw asConfigurationError(error, state.phase);
    } finally {
      session?.close();
    }
    this.#logger.info('mail.access_verified', { outcome: 'allowed' });
  }

  async close(): Promise<void> {
    // Nothing is held open between sends, so there is no socket to release. The
    // flag is not ceremony: it makes a send after shutdown fail immediately
    // rather than open a fresh connection during a drain, which is the same
    // contract `Pool.end()` offers.
    this.#closed = true;
  }

  async #deliver(built: BuiltMessage, state: AttemptState): Promise<void> {
    const session = await this.#open(state);
    try {
      state.phase = 'transaction';
      await session.command(`MAIL FROM:<${built.envelopeFrom}>`, [250]);
      await session.command(`RCPT TO:<${built.envelopeTo}>`, [250, 251]);
      await session.command('DATA', [354]);
      await session.writeRaw(dotStuff(built.raw));
      // Everything before this line can be retried freely; nothing after it can.
      state.committed = true;
      await session.writeRaw(dataTerminator(built.raw));
      await session.expect([250]);
      await session.quit();
    } finally {
      session.close();
    }
  }

  async #open(state: AttemptState): Promise<Session> {
    const settings = this.#settings;
    state.phase = 'connect';
    const connection = await this.#connector({
      host: settings.host,
      port: settings.port,
      tls: settings.tls === 'implicit',
      caCertificate: settings.caCertificate,
      connectTimeoutMs: settings.connectTimeoutMs,
    });

    const session = new Session(connection, settings.commandTimeoutMs);
    try {
      state.phase = 'greeting';
      await session.expect([220]);

      state.phase = 'ehlo';
      let capabilities = await session.ehlo(settings.ehloName);

      if (settings.tls === 'starttls') {
        state.phase = 'starttls';
        if (!capabilities.has('STARTTLS')) {
          // Refused rather than downgraded. See `MAIL_TLS_MODES` for why there is
          // no opportunistic mode: a silent fallback to cleartext is a change
          // nothing observes until the credentials are already on the wire.
          throw new TerminalTransportError('Mail server does not offer STARTTLS', {
            code: 'mail.starttls_unavailable',
          });
        }
        await session.command('STARTTLS', [220]);
        await connection.startTls({ host: settings.host, caCertificate: settings.caCertificate });
        // Re-issued because the capability list before the handshake is not
        // trustworthy and, in practice, is not even the same: many servers
        // advertise AUTH only once the connection is encrypted.
        state.phase = 'ehlo';
        capabilities = await session.ehlo(settings.ehloName);
      }

      if (settings.username.length > 0) {
        state.phase = 'auth';
        await this.#authenticate(session, connection, capabilities);
      }

      return session;
    } catch (error) {
      session.close();
      throw error;
    }
  }

  async #authenticate(
    session: Session,
    connection: SmtpConnection,
    capabilities: ReadonlyMap<string, readonly string[]>,
  ): Promise<void> {
    const settings = this.#settings;

    if (!connection.secure && !settings.allowInsecureAuth) {
      throw new ConfigurationError([
        {
          key: 'MAIL_TLS',
          reason:
            'is "disable" while MAIL_USERNAME is set, which would put MAIL_PASSWORD on the wire in the clear — ' +
            'use "starttls" or "implicit", or set MAIL_ALLOW_INSECURE_AUTH=true if the server is reached over a trusted local network',
        },
      ]);
    }

    const mechanisms = new Set((capabilities.get('AUTH') ?? []).map((value) => value.toUpperCase()));
    const password = settings.password.expose();

    if (mechanisms.has('PLAIN')) {
      const credential = Buffer.from(`\0${settings.username}\0${password}`, 'utf8').toString('base64');
      await session.command(`AUTH PLAIN ${credential}`, [235], { redact: true });
      return;
    }
    if (mechanisms.has('LOGIN')) {
      await session.command('AUTH LOGIN', [334]);
      await session.command(Buffer.from(settings.username, 'utf8').toString('base64'), [334], { redact: true });
      await session.command(Buffer.from(password, 'utf8').toString('base64'), [235], { redact: true });
      return;
    }

    throw new ConfigurationError([
      {
        key: 'MAIL_USERNAME',
        reason: `is set, but the mail server offers no supported authentication mechanism (it offers: ${
          [...mechanisms].sort().join(', ') || 'none'
        })`,
      },
    ]);
  }
}

/**
 * One SMTP conversation.
 *
 * Holds the reply parser's buffer, which is why it is a class rather than a set
 * of functions: a reply can arrive split across TCP segments, and the leftover
 * from one read belongs to the next.
 */
class Session {
  readonly #connection: SmtpConnection;
  readonly #timeoutMs: number;
  #buffer = '';
  #closed = false;

  constructor(connection: SmtpConnection, timeoutMs: number) {
    this.#connection = connection;
    this.#timeoutMs = timeoutMs;
  }

  async writeRaw(data: Buffer): Promise<void> {
    await this.#connection.write(data);
  }

  /**
   * Send one command and require one of the expected reply codes.
   *
   * `redact` exists because the command text is quoted in the error raised when
   * the reply is unexpected, and an `AUTH PLAIN` command *is* the credential in
   * base64. `credential-and-secret-handling.md` AC5 forbids a secret reaching any
   * error message or diagnostic, and a failed authentication is precisely when
   * that error gets raised, logged, and pasted into a support channel.
   */
  async command(
    text: string,
    expected: readonly number[],
    options: { readonly redact?: boolean } = {},
  ): Promise<SmtpReply> {
    await this.#connection.write(Buffer.from(`${text}\r\n`, 'utf8'));
    return await this.expect(expected, options.redact === true ? '<redacted>' : text);
  }

  async expect(expected: readonly number[], commandLabel = '<data>'): Promise<SmtpReply> {
    const reply = await this.#readReply();
    if (expected.includes(reply.code)) return reply;
    throw replyFailure(reply, commandLabel);
  }

  /** EHLO, returning the capability table keyed by name with its parameters. */
  async ehlo(name: string): Promise<ReadonlyMap<string, readonly string[]>> {
    const reply = await this.command(`EHLO ${name}`, [250]);
    const capabilities = new Map<string, readonly string[]>();
    // The first line is the greeting text, not a capability.
    for (const line of reply.lines.slice(1)) {
      const tokens = line.trim().split(/\s+/);
      const name0 = tokens[0];
      if (name0 === undefined || name0.length === 0) continue;
      capabilities.set(name0.toUpperCase(), tokens.slice(1));
    }
    return capabilities;
  }

  async quit(): Promise<void> {
    if (this.#closed) return;
    try {
      await this.command('QUIT', [221]);
    } catch {
      // A server that drops the connection instead of answering QUIT has already
      // accepted the message; turning that into a failure would report a
      // delivered message as undelivered and invite the caller to send it again.
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#connection.close();
  }

  async #readReply(): Promise<SmtpReply> {
    for (;;) {
      const parsed = this.#takeReply();
      if (parsed !== undefined) return parsed;
      if (this.#buffer.length > MAX_REPLY_BYTES) {
        throw new TerminalTransportError('Mail server sent an oversized reply', {
          code: 'mail.reply_too_large',
          context: { bytes: this.#buffer.length },
        });
      }
      const chunk = await this.#connection.read(this.#timeoutMs);
      if (chunk === undefined) {
        throw new TransientTransportError('Mail server closed the connection', {
          code: 'mail.connection_ended',
        });
      }
      this.#buffer += chunk.toString('binary');
    }
  }

  /**
   * Pull one complete reply out of the buffer, or `undefined` if more is needed.
   *
   * A reply is one or more lines sharing a status code. `250-SIZE` continues;
   * `250 SIZE` ends. RFC 5321 requires every line of one reply to carry the same
   * code, and a server that breaks that is either confused or two replies got
   * interleaved — neither is something to guess at, so it is refused.
   */
  #takeReply(): SmtpReply | undefined {
    const lines: string[] = [];
    let code: number | undefined;
    let offset = 0;

    for (;;) {
      const end = this.#buffer.indexOf('\r\n', offset);
      if (end === -1) return undefined;
      const line = this.#buffer.slice(offset, end);
      offset = end + 2;

      const lineCode = Number.parseInt(line.slice(0, 3), 10);
      if (!Number.isInteger(lineCode) || line.length < 3 || !/^\d{3}/.test(line)) {
        throw new TerminalTransportError('Mail server sent a malformed reply', {
          code: 'mail.reply_malformed',
        });
      }
      if (code === undefined) {
        code = lineCode;
      } else if (code !== lineCode) {
        throw new TerminalTransportError('Mail server sent a reply with inconsistent status codes', {
          code: 'mail.reply_inconsistent',
          context: { statusCode: code },
        });
      }

      lines.push(line.slice(4));
      const continues = line.length > 3 && line[3] === '-';
      if (!continues) {
        this.#buffer = this.#buffer.slice(offset);
        return { code, lines };
      }
    }
  }
}

/**
 * Map a reply code onto the error taxonomy.
 *
 * 4xx is "try again later" by definition and 5xx is "do not"; that is the
 * protocol's own distinction and it lines up exactly with the retryable boundary
 * `@zeddev/errors` draws. Getting this backwards is expensive in both directions:
 * retrying a 550 burns the whole attempt allowance rediscovering that a mailbox
 * does not exist, and not retrying a 451 turns a provider's routine throttle into
 * a client who never receives their verification link.
 *
 * The server's own reply text is deliberately not carried into the error.
 * IMPLEMENTATION_PLAN.md §4c records why for PostgreSQL — its error detail quotes
 * row data — and SMTP is worse: a rejection routinely echoes the recipient
 * address, which would put a client's email address into an operator-visible
 * diagnostic and violate `operator-health-monitoring.md` AC9.
 */
function replyFailure(reply: SmtpReply, command: string): Error {
  const context = { statusCode: reply.code, action: command.split(' ')[0] ?? command };
  if (reply.code >= 400 && reply.code < 500) {
    return new TransientTransportError('Mail server reported a temporary failure', {
      code: 'mail.temporary_failure',
      context,
    });
  }
  return new TerminalTransportError('Mail server rejected the request', {
    code: 'mail.rejected',
    context,
  });
}

/**
 * Re-key a session failure as a configuration problem, for `verifyAccess` only.
 *
 * Only at startup. The same failure during a send is a transport failure and must
 * stay one, because the retry policy reads the taxonomy — calling a 451 a
 * configuration error mid-flight would make it permanent.
 */
function asConfigurationError(error: unknown, phase: Phase): Error {
  if (error instanceof ConfigurationError) return error;
  const keys = PHASE_CONFIG_KEYS[phase];
  const reason =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? `could not be verified at startup (${error.code} while ${phase})`
      : `could not be verified at startup (failed while ${phase})`;
  return new ConfigurationError(
    keys.map((key) => ({ key, reason })),
    { cause: error },
  );
}

/** Refuse any value that would let a second SMTP command be smuggled into the first. */
function assertCommandSafe(value: string, key: string): void {
  if (/[\r\n\0]/.test(value)) {
    throw new ConfigurationError([{ key, reason: 'must not contain a line break or a null byte' }]);
  }
}
