/**
 * Rules every configuration area in `@zeddev/bot` applies the same way.
 *
 * Kept in one place because each of them is a rule a second copy would drift
 * from: how a length limit is counted (it must agree with the database's CHECK
 * constraints), what counts as a control character in client-authored text, and
 * what an unbound connection means. Not exported from the package — these are
 * how `@zeddev/bot` validates, not part of what it offers.
 */

import type { Connection } from '@zeddev/db';
import { DefectError, type ConfigIssue } from '@zeddev/errors';

/**
 * Characters in Unicode code points — what PostgreSQL's `length()` counts for
 * UTF-8 text. JavaScript's `length` counts UTF-16 units, so a limit checked with
 * it would refuse a 30-emoji name the database accepts, or the reverse, turning a
 * boundary input into a 500.
 */
export function characters(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/** Any control character. One-line fields refuse these outright. */
export const CONTROL = /\p{Cc}/u;

/** Control characters other than line break and tab, which multi-line text may use. */
export const CONTROL_EXCEPT_LINE_BREAK_AND_TAB = /[^\P{Cc}\n\t]/u;

/**
 * Validate a multi-line block of client-authored text, recording any problem in
 * `issues`.
 *
 * Line endings are normalised to `\n`, the text to NFC, and surrounding
 * whitespace trimmed; a blank result is `null`, because there must be one
 * representation of "not set" — the tables' CHECK constraints refuse an empty
 * string for the same reason. `undefined` and `null` are also `null`: a caller
 * that needs the field to be present checks that first.
 *
 * The reasons name the limit, never the submitted value: `ValidationError`'s
 * issues reach the HTTP response and the logs, and this text is client content.
 */
export function parseMultilineText(raw: unknown, key: string, maxLength: number, issues: ConfigIssue[]): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') {
    issues.push({ key, reason: 'must be a string' });
    return null;
  }
  const text = raw.replace(/\r\n?/g, '\n').normalize('NFC').trim();
  if (CONTROL_EXCEPT_LINE_BREAK_AND_TAB.test(text)) {
    issues.push({ key, reason: 'must not contain control characters' });
    return null;
  }
  if (characters(text) > maxLength) {
    issues.push({ key, reason: `must be at most ${maxLength} characters` });
    return null;
  }
  return text === '' ? null : text;
}

/**
 * Refuse a connection with no tenant bound.
 *
 * Row-level security already fails closed on one — every query sees an empty
 * table — but for a read that failure is indistinguishable from "this tenant has
 * configured nothing", which would, for example, report a configured bot as not
 * ready. A missing binding is a programming error, and it should look like one.
 * Checked in-process, so it costs no round trip.
 */
export function requireTenant(connection: Connection, operation: string): void {
  if (connection.boundTenantId === undefined) {
    throw new DefectError(`${operation} requires a tenant-bound connection`, { code: 'bot.tenant_unbound' });
  }
}
