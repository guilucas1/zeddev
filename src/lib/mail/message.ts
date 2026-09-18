/**
 * Turning a `MailMessage` into the exact bytes that go on the wire.
 *
 * This module is the security-critical half of the package, and the reason is
 * one specific attack. SMTP has no framing: headers are separated from each other
 * by CRLF, and from the body by a blank line. If a caller-supplied value reaches
 * a header without being checked, a value containing `\r\n` does not become a
 * mangled header — it becomes *additional headers*. `victim@example.com\r\nBcc:
 * attacker@evil.example` is one field on a signup form and two recipients on the
 * wire, one of whom now holds a live email-verification link for an account they
 * do not own. `credential-and-secret-handling.md` requires that a tenant's
 * credentials never be usable out of context; a header-injection bug hands them
 * over before any of the platform's other defences are consulted.
 *
 * So every caller-supplied string is validated here, before a byte is written,
 * and the validation is rejection rather than sanitisation. Stripping the CRLF
 * and carrying on would deliver a message the caller did not write to a recipient
 * the caller did not name, and report success. There is no legitimate input this
 * refuses.
 *
 * ## Why this does not reuse `assertEmail` from `@zeddev/identity`
 *
 * AGENTS.md is explicit that identity rules live in `@zeddev/identity` and
 * nowhere else, and this is not a second copy of one. They are different rules
 * answering different questions:
 *
 * - `assertEmail` asks "is this a plausible account identifier?" — it is a
 *   product decision about what a signup form accepts, and it is free to reject
 *   perfectly deliverable addresses because an obvious typo should fail at the
 *   form.
 * - `assertEnvelopeAddress` asks "can this be placed inside `RCPT TO:<…>` without
 *   changing the meaning of the command?" — it is a wire-safety rule, and it must
 *   hold for addresses that never came from a signup form at all, such as
 *   `MAIL_FROM_ADDRESS` or an operator alerting address.
 *
 * The layering also runs the right way round: `@zeddev/mail` is transport and
 * must not depend on a domain library, exactly as `@zeddev/storage` must not
 * depend on `@zeddev/db`. IMPLEMENTATION_PLAN.md §4e records the same reasoning
 * for `assertTenantId`.
 *
 * The rule here is deliberately a *subset* of identity's: every address
 * `assertEmail` accepts, this accepts too. That direction matters. Were it the
 * other way round, an account could be created with an address the mailer then
 * refuses, and the client would be stranded holding an unverifiable account with
 * no way to see why.
 */

import { randomBytes } from 'node:crypto';
import { ValidationError } from '@zeddev/errors';

/** Matches `accounts.email`'s own bound, so the two cannot disagree. */
export const MAX_ADDRESS_LENGTH = 320;
const MAX_LOCAL_LENGTH = 64;

/**
 * A cap chosen to remove an edge case rather than to enforce a product rule.
 *
 * RFC 5322 permits a header line of up to 998 octets and recommends 78. Honouring
 * both for an arbitrarily long subject means implementing whitespace-aware
 * folding, which is fiddly and is the sort of code that is wrong in exactly one
 * unusual input. Capping the subject well below the hard limit means the encoder
 * can emit a single line for ASCII and fixed-size encoded words otherwise, and
 * neither can ever exceed 998. No transactional message has a 512-character
 * subject.
 */
export const MAX_SUBJECT_LENGTH = 512;

/** Bounds the display name for the same reason, and it lands in the same header. */
export const MAX_DISPLAY_NAME_LENGTH = 200;

/**
 * Characters that may appear in an address.
 *
 * Printable ASCII only, minus the characters that carry structural meaning in a
 * header or an SMTP command: `<` and `>` delimit the address inside `RCPT TO`,
 * `,` and `;` separate addresses in a list, `"` and `\` open and escape a quoted
 * string, `(` and `)` open a comment, `[` and `]` open an address literal, and
 * whitespace ends the command. SMTPUTF8 is not implemented, so anything above
 * 0x7e is refused rather than mis-sent.
 */
const ADDRESS_FORBIDDEN = new Set(['<', '>', ',', ';', '"', '\\', '(', ')', '[', ']']);

const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;

/**
 * Reject an address that cannot be placed on the wire unchanged.
 *
 * Returns the trimmed address. Does not lower-case it: canonicalisation is
 * identity's decision and this module must not quietly make a different one. What
 * it does guarantee is that the returned string contains no character that can
 * terminate a header, end an SMTP command, or introduce a second recipient.
 */
export function assertEnvelopeAddress(raw: string, key: string): string {
  const address = raw.trim();
  const issues: { key: string; reason: string }[] = [];

  if (address.length === 0) {
    issues.push({ key, reason: 'is required' });
  } else if (address.length > MAX_ADDRESS_LENGTH) {
    issues.push({ key, reason: `must be at most ${MAX_ADDRESS_LENGTH} characters` });
  } else {
    for (const character of address) {
      const code = character.codePointAt(0) ?? 0;
      if (code < 0x21 || code > 0x7e) {
        // Named without quoting the character itself. A reason string is a
        // diagnostic, and echoing a control character into one is how the
        // injection attempt reaches the log that was supposed to report it.
        issues.push({ key, reason: 'must contain only printable ASCII characters' });
        break;
      }
      if (ADDRESS_FORBIDDEN.has(character)) {
        issues.push({ key, reason: 'must not contain address punctuation such as <, >, comma, or quotes' });
        break;
      }
    }

    if (issues.length === 0) {
      const parts = address.split('@');
      const local = parts.length === 2 ? (parts[0] ?? '') : '';
      const domain = parts.length === 2 ? (parts[1] ?? '') : '';
      if (parts.length !== 2 || local.length === 0 || domain.length === 0) {
        issues.push({ key, reason: 'must be a single address of the form local@domain' });
      } else if (local.length > MAX_LOCAL_LENGTH) {
        issues.push({ key, reason: `the part before @ must be at most ${MAX_LOCAL_LENGTH} characters` });
      } else {
        const labels = domain.split('.');
        const wellFormed =
          labels.length >= 2 && labels.every((label) => DOMAIN_LABEL.test(label));
        if (!wellFormed) {
          issues.push({ key, reason: 'must have a domain with at least two labels, such as example.com' });
        }
      }
    }
  }

  if (issues.length > 0) throw new ValidationError(issues);
  return address;
}

/** Reject any header text that could terminate the header it lands in. */
function assertHeaderText(raw: string, key: string, maxLength: number): string {
  const issues: { key: string; reason: string }[] = [];
  if (raw.length > maxLength) {
    issues.push({ key, reason: `must be at most ${maxLength} characters` });
  } else if (/[\r\n]/.test(raw)) {
    issues.push({ key, reason: 'must not contain a line break' });
  } else {
    for (const character of raw) {
      const code = character.codePointAt(0) ?? 0;
      // Tab is permitted: it is legal folding whitespace and appears in real
      // subjects. Every other C0 control, and DEL, is refused.
      if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
        issues.push({ key, reason: 'must not contain control characters' });
        break;
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return raw;
}

/**
 * RFC 5322 date, always in UTC.
 *
 * UTC rather than the host's local offset because the offset is a property of
 * where the process happens to run, and `environment-portability.md` AC8 requires
 * that a deployment's observable behaviour not differ between a laptop and a
 * managed cloud except as configuration explains. A timestamp that reads `+0100`
 * in one deployment and `-0700` in another, from the same code and the same
 * configuration, is that difference.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

export function formatDate(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const day = DAYS[date.getUTCDay()] ?? 'Mon';
  const month = MONTHS[date.getUTCMonth()] ?? 'Jan';
  return (
    `${day}, ${pad(date.getUTCDate())} ${month} ${date.getUTCFullYear()} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * A globally unique `Message-ID`, built from randomness rather than from a
 * counter or a timestamp.
 *
 * The right-hand side is the sending domain, which is what makes it unique
 * across deployments. The left is 128 random bits, which is what makes it unique
 * within one — and, more usefully, unguessable, so that the id can be logged and
 * quoted in a support conversation without revealing how many messages the
 * platform has sent or letting anyone correlate two tenants' deliveries.
 */
export function mintMessageId(fromAddress: string): string {
  const domain = fromAddress.split('@')[1] ?? 'localhost';
  return `${randomBytes(16).toString('hex')}@${domain}`;
}

const ENCODED_WORD_PREFIX = '=?UTF-8?B?';
const ENCODED_WORD_SUFFIX = '?=';
/**
 * RFC 2047 caps an encoded word at 75 characters including the delimiters. The
 * prefix and suffix cost 12, leaving 63 for base64, which decodes 47 bytes —
 * rounded down to 45 so each chunk is a whole number of base64 quanta.
 */
const ENCODED_WORD_PAYLOAD_BYTES = 45;

function isPlainAscii(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Encode a header value, folding across encoded words when it is not ASCII.
 *
 * An ASCII value is emitted unchanged: readable in a raw message, which matters
 * when someone is debugging why a link did not arrive. Anything else becomes one
 * or more RFC 2047 encoded words joined by folding whitespace. The split is by
 * *code point*, never by byte, because an encoded word must contain a whole
 * number of characters — splitting a multi-byte sequence across two words yields
 * a subject that decodes to replacement characters in some clients and to nothing
 * in others.
 */
export function encodeHeaderText(value: string): string {
  if (isPlainAscii(value)) return value;

  const words: string[] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  const flush = (): void => {
    if (chunk.length === 0) return;
    const encoded = Buffer.from(chunk.join(''), 'utf8').toString('base64');
    words.push(`${ENCODED_WORD_PREFIX}${encoded}${ENCODED_WORD_SUFFIX}`);
    chunk = [];
    chunkBytes = 0;
  };

  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (chunkBytes + size > ENCODED_WORD_PAYLOAD_BYTES) flush();
    chunk.push(character);
    chunkBytes += size;
  }
  flush();

  return words.join('\r\n ');
}

/**
 * Render an address with an optional display name.
 *
 * An ASCII display name becomes a quoted string, which is why `"` and `\` are
 * escaped: an unescaped quote closes the string early and everything after it is
 * reparsed as address syntax. A non-ASCII display name becomes an encoded word,
 * which must *not* be quoted — a quoted encoded word is not decoded by any
 * conforming client and arrives as the literal `=?UTF-8?B?…?=`.
 */
export function formatAddressHeader(address: string, displayName: string): string {
  const name = displayName.trim();
  if (name.length === 0) return `<${address}>`;
  if (isPlainAscii(name)) {
    const escaped = name.replace(/([\\"])/g, '\\$1');
    return `"${escaped}" <${address}>`;
  }
  return `${encodeHeaderText(name)} <${address}>`;
}

/** Normalise any mix of line endings to the CRLF the protocol requires. */
function toCrlf(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}

/**
 * Whether the body survives being sent as-is.
 *
 * Three things disqualify it, and each would corrupt the message in a different
 * way: a non-ASCII character would be transmitted as raw UTF-8 bytes under a
 * declaration of 7bit and arrive as mojibake; a stray control character would be
 * passed through to the remote's parser; and a line longer than the protocol's
 * 998-octet limit would be folded or rejected by an intermediate relay.
 */
function sevenBitSafe(body: string): boolean {
  for (const character of body) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 0x7e) return false;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return false;
  }
  return body.split(/\r\n|\r|\n/).every((line) => Buffer.byteLength(line, 'utf8') <= 900);
}

function base64Body(body: string): string {
  const encoded = Buffer.from(body, 'utf8').toString('base64');
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += 76) {
    lines.push(encoded.slice(index, index + 76));
  }
  return lines.join('\r\n');
}

export interface BuildMessageInput {
  readonly from: string;
  readonly fromName: string;
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly replyTo?: string | undefined;
  /** Without angle brackets. Minted by `mintMessageId`; taken as input so tests are deterministic. */
  readonly messageId: string;
  readonly date: Date;
}

export interface BuiltMessage {
  readonly envelopeFrom: string;
  readonly envelopeTo: string;
  readonly messageId: string;
  /**
   * The complete message, CRLF-delimited, ending with the last byte of the body
   * and *not* with a line break. Not dot-stuffed — that happens at DATA time,
   * along with the framing CRLF that `dataTerminator` supplies.
   */
  readonly raw: Buffer;
}

/**
 * Build the message, validating every caller-supplied field first.
 *
 * Validation is deliberately *all* up front rather than interleaved with
 * rendering: a half-written message is not a state this code should be able to
 * reach, and a `ValidationError` thrown after the recipient has been accepted by
 * the remote would leave an open transaction on a socket the caller believes
 * failed cleanly.
 */
export function buildMessage(input: BuildMessageInput): BuiltMessage {
  const from = assertEnvelopeAddress(input.from, 'from');
  const to = assertEnvelopeAddress(input.to, 'to');
  const replyTo =
    input.replyTo === undefined || input.replyTo.trim().length === 0
      ? undefined
      : assertEnvelopeAddress(input.replyTo, 'replyTo');
  const fromName = assertHeaderText(input.fromName, 'fromName', MAX_DISPLAY_NAME_LENGTH);
  const subject = assertHeaderText(input.subject, 'subject', MAX_SUBJECT_LENGTH);
  const messageId = assertEnvelopeAddress(input.messageId, 'messageId');

  // Trailing line breaks are stripped, and the built message therefore never
  // ends with one. This is not tidiness — it is the only way the two transfer
  // encodings can agree.
  //
  // SMTP frames the body with `<CRLF>.<CRLF>`, and the leading CRLF of that
  // terminator *is* the line break ending the body's last line. So a 7bit body of
  // `"a\n"` and one of `"a"` are the same bytes on the wire and arrive
  // identically: the protocol cannot represent a trailing newline. A base64 body
  // has no such limitation, because its content is opaque to the framing — which
  // means that without this normalisation, `send` would preserve a trailing
  // newline or discard it depending on whether the body happened to contain a
  // non-ASCII character. A caller must not be able to observe a choice this
  // module makes internally.
  const body0 = input.body.replace(/(?:\r\n|\r|\n)+$/, '');

  const sevenBit = sevenBitSafe(body0);
  const headers = [
    `Date: ${formatDate(input.date)}`,
    `From: ${formatAddressHeader(from, fromName)}`,
    `To: <${to}>`,
    ...(replyTo === undefined ? [] : [`Reply-To: <${replyTo}>`]),
    `Subject: ${encodeHeaderText(subject)}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    `Content-Transfer-Encoding: ${sevenBit ? '7bit' : 'base64'}`,
    // RFC 3834. Every message this platform sends is machine-generated, and
    // saying so is what stops a recipient's out-of-office autoresponder from
    // replying to it — which, for an address that is not monitored, is a bounce
    // loop between two robots.
    'Auto-Submitted: auto-generated',
  ];

  const body = sevenBit ? toCrlf(body0) : base64Body(body0);
  const raw = Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8');

  return { envelopeFrom: from, envelopeTo: to, messageId, raw };
}

/**
 * Escape a message for transmission inside DATA.
 *
 * The DATA sub-protocol ends at a line containing a single `.`, so a message line
 * that legitimately begins with `.` must be sent with an extra one, which the
 * remote strips. Skipping this does not corrupt the body — it *truncates the
 * message and reinterprets the remainder as SMTP commands*, which is the same
 * shape of failure as header injection and is why this is applied to the whole
 * payload rather than to the body alone.
 *
 * It is reachable in practice, not theoretically: the 7bit path passes the
 * client's text through untouched, and a body whose line begins with a period is
 * ordinary prose.
 */
export function dotStuff(raw: Buffer): Buffer {
  const text = raw.toString('binary');
  const stuffed = text.replace(/^\./gm, '..');
  return Buffer.from(stuffed, 'binary');
}

/**
 * The bytes that end a DATA transaction for this message.
 *
 * RFC 5321 frames the body with `<CRLF>.<CRLF>`, and the leading CRLF is the one
 * that already ends the body's final line rather than an extra one. Writing a
 * message that ends in CRLF and then a full `\r\n.\r\n` appends a blank line to
 * every message the platform sends — a defect invisible against any fake server
 * built from the same misreading, and which a real server reproduces on the very
 * first message. It was found exactly that way.
 */
export function dataTerminator(raw: Buffer): Buffer {
  const endsWithCrlf = raw.length >= 2 && raw[raw.length - 2] === 0x0d && raw[raw.length - 1] === 0x0a;
  return Buffer.from(endsWithCrlf ? '.\r\n' : '\r\n.\r\n', 'binary');
}
