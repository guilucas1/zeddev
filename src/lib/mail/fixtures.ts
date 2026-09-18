/**
 * A disposable mailbox on a real SMTP server, and the reader that inspects it.
 *
 * There is no fake SMTP server in this package, for the reason `@zeddev/db`'s
 * `testing.ts` and `@zeddev/storage`'s `fixtures.ts` both give: the behaviour
 * under test is the remote's. A hand-written fake SMTP server would have to
 * parse the message using the same reading of RFC 5321/5322 that `smtp.ts` writes
 * it with, and the test would then prove only that this package agrees with
 * itself. A subject this repo encodes wrongly is garbled in a real mailbox and
 * pristine in a fake built from the same misunderstanding.
 *
 * ## Why the reader re-decodes rather than trusting the server's parse
 *
 * `decodeMail` is a small, independent RFC 5322 reader used by the conformance
 * suite against both adapters. Its independence is the point: the in-memory fake
 * has no server to decode for it, so without this the suite could only assert on
 * bytes for one adapter and on parsed fields for the other — which is exactly the
 * divergence a shared suite exists to prevent.
 *
 * Mailpit's *own* parse is used too, but only in `smtp.test.ts`, where it plays
 * the external-oracle role the published SigV4 example plays in `@zeddev/storage`:
 * it is an implementation that did not come from this repo agreeing that the
 * bytes mean what this repo intended. Two decoders agreeing is evidence; one
 * decoder agreeing with itself is not.
 *
 * ## Why there is no global clear
 *
 * `node:test` runs test files in parallel processes against one shared container.
 * A fixture that emptied the mailbox would delete another file's messages between
 * its send and its assertion — an intermittent failure that looks like a lost
 * message, which is the single most misleading thing a mail test can report. Each
 * fixture instead owns a unique recipient domain and only ever looks at its own.
 */

import { randomBytes } from 'node:crypto';
import { Secret } from '@zeddev/secrets';
import type { SmtpSettings } from './types.ts';

const PREFIX = 'ZEDDEV_TEST_MAIL_';

function envValue(suffix: string): string | undefined {
  const raw = process.env[`${PREFIX}${suffix}`];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** Whether an SMTP server is configured. Tests skip themselves when it is not. */
export function mailTestConfigured(): boolean {
  return envValue('HOST') !== undefined;
}

/** Phrased so it tells the reader how to fix it, rather than training them to ignore skips. */
export const SKIP_REASON =
  'no test SMTP server configured — run `npm run mail:up` and it will write the ZEDDEV_TEST_MAIL_* variables into .env.test (see AGENTS.md)';

// -------------------------------------------------------------------------
// A small, independent RFC 5322 reader
// -------------------------------------------------------------------------

export interface DecodedMail {
  /** Header names lower-cased, values unfolded and RFC 2047 decoded. */
  readonly headers: ReadonlyMap<string, string>;
  readonly subject: string;
  readonly to: string;
  readonly from: string;
  readonly fromName: string;
  readonly replyTo: string | undefined;
  readonly messageId: string;
  readonly contentTransferEncoding: string;
  readonly body: string;
  readonly raw: Buffer;
}

const ENCODED_WORD = /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g;

/**
 * Decode RFC 2047 encoded words.
 *
 * Adjacent encoded words separated only by whitespace are joined without it —
 * that rule is what makes a subject split across several words reassemble into
 * the original string rather than one with spaces injected at each 45-byte
 * boundary. A decoder that skips it produces plausible-looking output and would
 * let a genuinely broken split pass.
 */
function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  ENCODED_WORD.lastIndex = 0;
  return joined.replace(ENCODED_WORD, (_match, charset: string, encoding: string, payload: string) => {
    const bytes =
      encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (__, hex: string) =>
            String.fromCharCode(Number.parseInt(hex, 16)),
          ), 'binary');
    return bytes.toString(charset.toLowerCase() === 'utf-8' ? 'utf8' : 'binary');
  });
}

function parseAddress(value: string): { address: string; displayName: string } {
  const angled = /<([^>]*)>/.exec(value);
  if (angled === null) return { address: value.trim(), displayName: '' };
  const displayName = value.slice(0, angled.index).trim().replace(/^"(.*)"$/s, '$1').replace(/\\(["\\])/g, '$1');
  return { address: (angled[1] ?? '').trim(), displayName };
}

export function decodeMail(raw: Buffer): DecodedMail {
  const text = raw.toString('binary');
  const separator = text.indexOf('\r\n\r\n');
  if (separator === -1) throw new Error('message has no header/body separator');
  const headerBlock = text.slice(0, separator);
  const bodyBlock = text.slice(separator + 4);

  // Unfold before splitting: a continuation line starts with whitespace and
  // belongs to the header above it.
  const unfolded = headerBlock.replace(/\r\n[ \t]+/g, '');
  const headers = new Map<string, string>();
  for (const line of unfolded.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  const encoding = (headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const body =
    encoding === 'base64'
      ? Buffer.from(bodyBlock.replace(/\r\n/g, ''), 'base64').toString('utf8')
      : // Exactly one trailing newline is dropped, and only here.
        //
        // `buildMessage` guarantees the body it produces never ends with a line
        // break, so a trailing newline on a *received* 7bit message is the
        // terminator of its final line — framing, not content. A real mail store
        // keeps it; the in-memory fake has no framing to keep. Normalising it away
        // is what lets the shared conformance suite assert body equality against
        // both, which is the whole point of having one suite.
        //
        // One, never more. The framing bug this package shipped and then fixed
        // produced a *blank line* — two newlines' worth — so a one-newline strip
        // still fails against it, which is what keeps this from being a trim that
        // hides the defect it was written beside.
        Buffer.from(bodyBlock, 'binary').toString('utf8').replace(/\r\n/g, '\n').replace(/\n$/, '');

  const from = parseAddress(decodeEncodedWords(headers.get('from') ?? ''));
  const replyToHeader = headers.get('reply-to');

  return {
    headers,
    subject: decodeEncodedWords(headers.get('subject') ?? ''),
    to: parseAddress(headers.get('to') ?? '').address,
    from: from.address,
    fromName: from.displayName,
    replyTo: replyToHeader === undefined ? undefined : parseAddress(replyToHeader).address,
    messageId: (headers.get('message-id') ?? '').replace(/^<|>$/g, ''),
    contentTransferEncoding: encoding,
    body,
    raw,
  };
}

// -------------------------------------------------------------------------
// The Mailpit harness
// -------------------------------------------------------------------------

export interface TestMailbox {
  readonly settings: SmtpSettings;
  /** A recipient in this fixture's private domain, so it sees only its own mail. */
  recipient(localPart: string): string;
  /** Raw messages delivered to this fixture's domain, oldest first. */
  rawMessages(): Promise<Buffer[]>;
  /** What the server itself made of each message — the external oracle. */
  serverParsed(): Promise<readonly ServerParsedMail[]>;
}

export interface ServerParsedMail {
  readonly subject: string;
  readonly text: string;
  readonly to: readonly string[];
  readonly from: string;
  readonly messageId: string;
}

interface MailpitSummary {
  readonly ID: string;
  readonly MessageID: string;
  readonly Subject: string;
  readonly From: { readonly Address: string; readonly Name: string } | null;
  readonly To: readonly { readonly Address: string }[] | null;
  readonly Created: string;
}

async function api<T>(path: string): Promise<T> {
  const port = envValue('API_PORT') ?? '58025';
  const response = await fetch(`http://${envValue('HOST') ?? '127.0.0.1'}:${port}${path}`);
  if (!response.ok) throw new Error(`mailpit ${path} responded ${response.status}`);
  return (await response.json()) as T;
}

async function summaries(domain: string): Promise<MailpitSummary[]> {
  const page = await api<{ messages: MailpitSummary[] | null }>('/api/v1/messages?limit=500');
  const suffix = `@${domain}`;
  return (page.messages ?? [])
    .filter((message) => (message.To ?? []).some((to) => to.Address.toLowerCase().endsWith(suffix)))
    .sort((left, right) => left.Created.localeCompare(right.Created));
}

/**
 * Settings pointed at the test server, with a private recipient domain.
 *
 * `maxAttempts` is 2 rather than the default 4 so a genuinely unreachable
 * container surfaces quickly instead of spending the production allowance
 * rediscovering it — the same choice `createTestBucket` makes.
 */
export function createTestMailbox(overrides: Partial<SmtpSettings> = {}): TestMailbox {
  const host = envValue('HOST');
  if (host === undefined) throw new Error(SKIP_REASON);

  const domain = `t-${randomBytes(4).toString('hex')}.mailbox.test`;

  const settings: SmtpSettings = {
    host,
    port: Number(envValue('PORT') ?? '51025'),
    // The test server has no certificate, so the suite speaks cleartext and
    // authenticates over it on purpose — see `scripts/mail.sh`. That the client
    // *refuses* to do this by default is covered against the connector seam,
    // where it can be checked without standing up a certificate authority.
    tls: 'disable',
    username: envValue('USERNAME') ?? '',
    password: new Secret(envValue('PASSWORD') ?? '', 'test mail password'),
    allowInsecureAuth: true,
    fromAddress: 'no-reply@zeddev.test',
    fromName: '',
    ehloName: 'zeddev-test',
    connectTimeoutMs: 10_000,
    commandTimeoutMs: 10_000,
    maxAttempts: 2,
    ...overrides,
  };

  return {
    settings,
    recipient: (localPart: string): string => `${localPart}@${domain}`,
    async rawMessages(): Promise<Buffer[]> {
      const list = await summaries(domain);
      const port = envValue('API_PORT') ?? '58025';
      const messages: Buffer[] = [];
      for (const summary of list) {
        const response = await fetch(`http://${host}:${port}/api/v1/message/${summary.ID}/raw`);
        if (!response.ok) throw new Error(`mailpit raw fetch responded ${response.status}`);
        messages.push(Buffer.from(await response.arrayBuffer()));
      }
      return messages;
    },
    async serverParsed(): Promise<readonly ServerParsedMail[]> {
      const list = await summaries(domain);
      const parsed: ServerParsedMail[] = [];
      for (const summary of list) {
        const full = await api<{
          Subject: string;
          Text: string;
          MessageID: string;
          From: { Address: string } | null;
          To: readonly { Address: string }[] | null;
        }>(`/api/v1/message/${summary.ID}`);
        parsed.push({
          subject: full.Subject,
          text: full.Text,
          to: (full.To ?? []).map((to) => to.Address),
          from: full.From?.Address ?? '',
          messageId: full.MessageID,
        });
      }
      return parsed;
    },
  };
}
