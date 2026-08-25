/**
 * Bearer tokens: session tokens, email-verification links, password-reset links.
 *
 * Four decisions here are load-bearing.
 *
 * ## 1. The token is never stored, only its digest
 *
 * `credential-and-secret-handling.md` AC4 requires that reading the stored data
 * alone be insufficient to use a credential, and a session token is a credential
 * — possession of it *is* authentication. Storing the token itself would make one
 * `SELECT` on `client_sessions` equivalent to holding every live session on the
 * platform, and a database backup equivalent to holding them forever. So the
 * column is `token_hash` and the plaintext exists only in the response that
 * issued it.
 *
 * ## 2. The digest is SHA-256, not scrypt
 *
 * This looks like it contradicts `@zeddev/secrets`, which hashes account
 * passwords with scrypt at deliberately punishing cost. It does not, because the
 * two are defending against different attacks. scrypt exists to make an *offline
 * dictionary attack* expensive, and a dictionary attack needs a dictionary — it
 * works because humans pick from a small space. These tokens are 256 bits of
 * CSPRNG output, so there is no dictionary; an attacker holding the digest table
 * has nothing to try. Paying 32 MiB and ~100 ms of scrypt on *every request* to
 * defend against an attack that cannot be mounted would be a self-inflicted
 * denial of service on the hot path.
 *
 * Lookup is by indexed equality on the digest rather than a constant-time
 * comparison in application code. Deliberate: a timing signal from a B-tree probe
 * leaks something about digests near the probed one, and to exploit it an
 * attacker must already be able to choose the digest — which requires knowing the
 * token. There is nothing to recover.
 *
 * ## 3. Every token carries a typed prefix
 *
 * `authentication-and-access.md` AC21 and AC22 require that a client session
 * token presented at an operator surface be rejected, and vice versa. That is
 * already true structurally, because the two kinds live in different tables and a
 * lookup in one cannot return a row from the other. The prefix makes it true
 * *earlier and legibly*: the rejection happens before a query is issued, it is
 * attributable to a specific reason in the access record, and a token pasted into
 * a bug report is identifiable by kind without being usable.
 *
 * The `1` in each prefix is a format version. If the token encoding ever changes,
 * old and new tokens are distinguishable rather than silently misparsed.
 *
 * ## 4. base64url, not hex or base64
 *
 * A verification token travels in a URL, and standard base64's `+` and `/`
 * survive one round of encoding and not two. Hex would work but doubles the
 * length of every link for no benefit.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Secret } from '@zeddev/secrets';

/**
 * 32 bytes = 256 bits. Well past any brute-force horizon, and — more relevantly —
 * past any *online* guessing horizon even without rate limiting, which matters
 * because a reset link cannot be rate-limited per-account without becoming a way
 * to lock an account out of recovery.
 */
const TOKEN_BYTES = 32;

/** The kinds of bearer token the platform issues. */
export const TOKEN_KINDS = ['client_session', 'operator_session', 'email_verification', 'password_reset'] as const;
export type TokenKind = (typeof TOKEN_KINDS)[number];

/**
 * The wire prefix for each kind.
 *
 * `z` for the platform, then the kind, then the format version. Short because
 * these appear in URLs and `Authorization` headers.
 */
export const TOKEN_PREFIXES: Readonly<Record<TokenKind, string>> = {
  client_session: 'zcs1_',
  operator_session: 'zos1_',
  email_verification: 'zev1_',
  password_reset: 'zpr1_',
};

export interface MintedToken {
  /** Handed to the caller once. Wrapped so it cannot reach a log by accident. */
  readonly token: Secret<string>;
  /** What goes in the database. */
  readonly hash: string;
}

/** Issue a fresh token of one kind. */
export function mintToken(kind: TokenKind): MintedToken {
  const token = `${TOKEN_PREFIXES[kind]}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token: new Secret(token, `${kind}_token`), hash: hashToken(token) };
}

/** The stored form of a token. See the module note on why this is SHA-256. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Whether a presented token even claims to be of the expected kind.
 *
 * Constant-time over the prefix, which is not strictly necessary — the prefixes
 * are public constants — but costs nothing and keeps the habit intact in a file
 * where the habit matters.
 */
export function hasTokenKind(token: string, kind: TokenKind): boolean {
  const prefix = TOKEN_PREFIXES[kind];
  if (token.length <= prefix.length) return false;
  const presented = Buffer.from(token.slice(0, prefix.length), 'utf8');
  const expected = Buffer.from(prefix, 'utf8');
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * The kind a token claims to be, or `undefined`.
 *
 * Only for diagnostics and access records — never for routing a token to a
 * verifier, because the prefix is attacker-controlled. Verification always asks
 * "is this the kind I expected here?" (`hasTokenKind`), never "what kind is
 * this, and let me handle it accordingly".
 */
export function claimedTokenKind(token: string): TokenKind | undefined {
  return TOKEN_KINDS.find((kind) => hasTokenKind(token, kind));
}
