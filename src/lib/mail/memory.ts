/**
 * An in-memory `Mailer`, for tests above the port.
 *
 * The one thing that would make this fake worthless is if it accepted messages
 * the real adapter would reject, or encoded them differently. A test that proves
 * a verification mail is sent is evidence about production only if the fake
 * applies the same validation — otherwise the first message containing an
 * accented business name, or a header-injection attempt, behaves one way in every
 * test and another way on the wire. IMPLEMENTATION_PLAN.md §4d records the same
 * hazard for the queue: "a fake queue is the easiest place in this system to
 * prove nothing."
 *
 * So this does not store the `MailMessage` it was handed. It runs `buildMessage`,
 * exactly as `SmtpMailer` does, and stores the bytes that would have gone on the
 * wire. Validation, header encoding, and the transfer-encoding choice are
 * therefore the same code in both, and the shared conformance suite reads the
 * stored bytes back through the same decoder it uses on what Mailpit received.
 */

import { TerminalTransportError } from '@zeddev/errors';
import { buildMessage, mintMessageId } from './message.ts';
import type { Mailer, MailMessage, SentMail } from './types.ts';

export interface DeliveredMail {
  readonly messageId: string;
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  /** The complete RFC 5322 message, exactly as `SmtpMailer` would have transmitted it. */
  readonly raw: Buffer;
}

export interface InMemoryMailerOptions {
  /** Stands in for `MAIL_FROM_ADDRESS`. Validated like the real one. */
  readonly fromAddress?: string | undefined;
  readonly fromName?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export class InMemoryMailer implements Mailer {
  readonly #fromAddress: string;
  readonly #fromName: string;
  readonly #now: () => Date;
  readonly #delivered: DeliveredMail[] = [];
  readonly #failures: Error[] = [];
  #accessFailure: Error | undefined;
  #closed = false;

  constructor(options: InMemoryMailerOptions = {}) {
    this.#fromAddress = options.fromAddress ?? 'no-reply@zeddev.test';
    this.#fromName = options.fromName ?? '';
    this.#now = options.now ?? ((): Date => new Date());
  }

  /** Everything accepted so far, oldest first. */
  get delivered(): readonly DeliveredMail[] {
    return this.#delivered;
  }

  /**
   * Make the next `send` fail.
   *
   * Queued rather than sticky so a test can drive "fails twice, then succeeds",
   * which is the shape that actually exercises a caller's retry handling. A
   * sticky flag can only express "always fails", and a caller that gives up
   * correctly on the first failure passes that test either way.
   */
  failNext(error: Error): void {
    this.#failures.push(error);
  }

  /** Make `verifyAccess` fail until cleared, for testing a service's startup path. */
  setAccessFailure(error: Error | undefined): void {
    this.#accessFailure = error;
  }

  clear(): void {
    this.#delivered.length = 0;
  }

  async send(message: MailMessage): Promise<SentMail> {
    if (this.#closed) {
      throw new TerminalTransportError('Mailer is closed', { code: 'mail.closed' });
    }

    // Built before the injected failure is consulted, so that a message this port
    // would refuse is refused here too — a queued transport failure must not be
    // able to mask a validation failure and let an unsendable message look merely
    // unlucky.
    const built = buildMessage({
      from: this.#fromAddress,
      fromName: this.#fromName,
      to: message.to,
      subject: message.subject,
      body: message.body,
      replyTo: message.replyTo,
      messageId: mintMessageId(this.#fromAddress),
      date: this.#now(),
    });

    const failure = this.#failures.shift();
    if (failure !== undefined) throw failure;

    this.#delivered.push({
      messageId: built.messageId,
      envelopeFrom: built.envelopeFrom,
      envelopeTo: built.envelopeTo,
      raw: built.raw,
    });
    return { messageId: built.messageId };
  }

  async verifyAccess(): Promise<void> {
    if (this.#accessFailure !== undefined) throw this.#accessFailure;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }
}
