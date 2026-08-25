/**
 * What counts as a usable email address, and what counts as a strong enough
 * password.
 *
 * `client-signup-and-tenancy.md` requires both — "verify that the signup email
 * address is valid" and "enforce a minimum credential strength standard at
 * signup" — and deliberately leaves the rules open ("left to implementation
 * phase"). This module is where that decision is made, in one place, so that
 * signup, password change, and password reset cannot drift into enforcing three
 * different standards. A reset flow with weaker rules than signup is a complete
 * bypass of the signup rule, and that is exactly how it happens: the rules get
 * written twice.
 *
 * ## Why there are no composition rules
 *
 * No "must contain an uppercase letter and a digit and a symbol". That style of
 * rule is what NIST SP 800-63B stopped recommending, for a reason that matters
 * here: it does not measure strength, it measures compliance, and users satisfy
 * it with `Password1!` — which is in every cracking dictionary. The rules below
 * target the two things that actually predict a guessable password: it is short,
 * or it is one somebody has already guessed. Length is the dominant term, and a
 * blocklist covers the rest.
 *
 * The context-derived rules (an email local part, the business name) exist
 * because this is a *business* signup: the business name is public, printed on
 * the storefront, and is the single most likely password a small-business owner
 * picks. It is a dictionary of one, known to every attacker who can read the
 * client list.
 *
 * ## Why the maximum length exists
 *
 * `hashCredential` runs scrypt at ~32 MiB per call. An unbounded password field
 * is a request-shaped way to make a server allocate and hash arbitrarily large
 * input, and the login path is reachable unauthenticated. 256 characters is far
 * beyond any real passphrase and keeps the work per attempt fixed.
 */

import { ValidationError } from '@zeddev/errors';

/**
 * The upper bound the schema also enforces (`accounts.email`,
 * `length(email) BETWEEN 3 AND 320`). Duplicated as a constant here rather than
 * discovered as a database error, because a caller deserves a field-level
 * validation failure, and because a `CHECK` violation would surface through the
 * PostgreSQL error mapper as a generic rejection with the prose deliberately
 * stripped — accurate, but useless to the person filling in the form.
 */
export const MAX_EMAIL_LENGTH = 320;
const MAX_EMAIL_LOCAL_LENGTH = 64;

/** Bounds the per-attempt hashing cost. See the module note. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * A deliberately conservative address check.
 *
 * Not an RFC 5322 parser, and not trying to be: the full grammar admits
 * quoted local parts, comments, and address literals, none of which any real
 * signup form produces, and every one of which is a way to smuggle a surprising
 * string into a column that later gets rendered somewhere. What actually
 * establishes that the address is real is the verification token — this check
 * only rejects input that could not possibly be deliverable, so that an obvious
 * typo fails at the form rather than as silence where a verification mail should
 * have arrived.
 */
const EMAIL_PATTERN = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * The canonical stored form of an address.
 *
 * Lower-cased in full, including the local part. That is knowingly stricter than
 * the RFC, which makes the local part case-sensitive — but the platform has
 * already made this decision in the schema, where uniqueness is
 * `CREATE UNIQUE INDEX accounts_email_unique_idx ON accounts (lower(email))`.
 * Given that `Ana@x.com` and `ana@x.com` cannot both exist, storing whichever
 * casing was typed would mean the address a password-reset mail is sent to
 * depends on which of two equivalent forms the row happened to be created with.
 * One canonical form removes the question.
 */
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Reject an address that could not be deliverable. Returns the canonical form. */
export function assertEmail(raw: string, key = 'email'): string {
  const email = normalizeEmail(raw);
  const issues: { key: string; reason: string }[] = [];
  if (email.length === 0) {
    issues.push({ key, reason: 'is required' });
  } else if (email.length > MAX_EMAIL_LENGTH) {
    issues.push({ key, reason: `must be at most ${MAX_EMAIL_LENGTH} characters` });
  } else if (!EMAIL_PATTERN.test(email)) {
    issues.push({ key, reason: 'is not a valid email address' });
  } else if ((email.split('@')[0] ?? '').length > MAX_EMAIL_LOCAL_LENGTH) {
    issues.push({ key, reason: `the part before @ must be at most ${MAX_EMAIL_LOCAL_LENGTH} characters` });
  }
  if (issues.length > 0) throw new ValidationError(issues);
  return email;
}

/** The part before the `@`, used to reject a password derived from the address. */
export function emailLocalPart(email: string): string {
  return normalizeEmail(email).split('@')[0] ?? '';
}

/**
 * Business names, bounded to match `tenants.business_name`'s own CHECK.
 *
 * Trimmed before measuring, for the same reason the column trims: a name of
 * three spaces satisfies a naive length test and identifies nothing.
 */
export const MAX_BUSINESS_NAME_LENGTH = 200;

export function assertBusinessName(raw: string, key = 'businessName'): string {
  const name = raw.trim().replace(/\s+/g, ' ');
  if (name.length === 0) throw new ValidationError([{ key, reason: 'is required' }]);
  if (name.length > MAX_BUSINESS_NAME_LENGTH) {
    throw new ValidationError([
      { key, reason: `must be at most ${MAX_BUSINESS_NAME_LENGTH} characters` },
    ]);
  }
  return name;
}

/**
 * Passwords common enough that an attacker's first few hundred guesses include
 * them, plus the ones this product invites specifically.
 *
 * Short on purpose. A serious deployment should check a breach corpus, and the
 * §"Follow-ups" note in IMPLEMENTATION_PLAN.md records that; a list of a few
 * hundred entries carried in source is not that. What it does buy, at zero
 * dependency cost, is coverage of the passwords that appear at the very top of
 * every leaked-credential frequency table — which is where the mass actually is,
 * because password choice is extraordinarily concentrated.
 *
 * Compared after normalisation (lower-cased, with leading/trailing digits and
 * punctuation removed), so `Password123!` is caught by the entry `password`.
 * Without that step a blocklist catches only the exact spelling and users route
 * around it by appending `1`.
 */
const COMMON_PASSWORD_STEMS: ReadonlySet<string> = new Set([
  'password', 'passwd', 'pass', 'secret', 'letmein', 'welcome', 'admin', 'administrator',
  'root', 'login', 'user', 'guest', 'test', 'demo', 'default', 'changeme', 'temp',
  'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbn', 'zxcvbnm', 'qazwsx', 'qwertz',
  'iloveyou', 'princess', 'sunshine', 'monkey', 'dragon', 'football', 'baseball', 'shadow',
  'master', 'superman', 'batman', 'trustno', 'freedom', 'whatever', 'starwars', 'pokemon',
  'michael', 'jennifer', 'jordan', 'harley', 'ranger', 'hunter', 'buster', 'soccer',
  'abc', 'abcd', 'abcdef', 'abcdefg', 'abcdefgh', 'aaa', 'asdf', 'asd',
  'whatsapp', 'chatbot', 'business', 'company', 'mybusiness', 'mycompany', 'thebot',
  'zeddev', 'platform', 'operator', 'tenant', 'client', 'account',
]);

/**
 * Strip the decoration users add to satisfy composition rules, leaving the stem
 * the blocklist is written against.
 */
function passwordStem(password: string): string {
  return password
    .toLowerCase()
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z]+$/, '');
}

/** Whether every character is the same one. `aaaaaaaaaaaa` passes a length test. */
function isSingleRepeatedCharacter(password: string): boolean {
  return password.length > 0 && [...password].every((char) => char === password[0]);
}

/**
 * Whether the whole password is one run up or down the character table —
 * `123456789012`, `abcdefghijkl`, `9876543210`. Length alone would accept all
 * three, and all three are in the first thousand guesses.
 */
function isSequentialRun(password: string): boolean {
  if (password.length < 4) return false;
  const codes = [...password.toLowerCase()].map((char) => char.charCodeAt(0));
  const step = (codes[1] ?? 0) - (codes[0] ?? 0);
  if (step !== 1 && step !== -1) return false;
  return codes.every((code, index) => index === 0 || code - (codes[index - 1] ?? 0) === step);
}

export interface PasswordContext {
  /** Minimum accepted length. Configured, so a deployment can raise it. */
  readonly minLength: number;
  /** The address the account is being created for, if known. */
  readonly email?: string | undefined;
  /** The business name, if known. See the module note on why this matters. */
  readonly businessName?: string | undefined;
}

/**
 * Every reason this password is unacceptable, in a stable order.
 *
 * Returns them all rather than the first, on the same reasoning
 * `ConfigurationError` collects every bad key: reporting one problem per attempt
 * turns choosing a password into a guessing loop.
 *
 * Reasons never quote the password. A validation message is rendered back to a
 * caller, logged, and occasionally screenshotted into a support thread, and a
 * password that has been through any of those is a password that must be
 * changed.
 */
export function passwordProblems(password: string, context: PasswordContext): readonly string[] {
  const problems: string[] = [];
  if (password.length < context.minLength) {
    problems.push(`must be at least ${context.minLength} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    problems.push(`must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  // The remaining checks are meaningless on input that already failed the length
  // bounds, and piling four reasons onto an empty field helps nobody.
  if (problems.length > 0) return problems;

  const lower = password.toLowerCase();
  if (COMMON_PASSWORD_STEMS.has(passwordStem(password)) || COMMON_PASSWORD_STEMS.has(lower)) {
    problems.push('is among the most commonly used passwords');
  }
  if (isSingleRepeatedCharacter(password)) {
    problems.push('must not be a single character repeated');
  }
  if (isSequentialRun(password)) {
    problems.push('must not be a run of consecutive characters');
  }

  const local = context.email === undefined ? '' : emailLocalPart(context.email);
  if (local.length >= 3 && lower.includes(local)) {
    problems.push('must not contain the email address it belongs to');
  }

  const business = (context.businessName ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (business.length >= 4 && lower.replace(/\s+/g, '').includes(business)) {
    problems.push('must not contain the business name');
  }

  return problems;
}

/**
 * Reject a password that fails the standard.
 *
 * `key` defaults to `password` so the caller can attribute the failure to
 * `newPassword` during a change or reset without the message becoming ambiguous
 * about which field the user should fix.
 */
export function assertPasswordStrength(
  password: string,
  context: PasswordContext,
  key = 'password',
): void {
  const problems = passwordProblems(password, context);
  if (problems.length > 0) {
    throw new ValidationError(problems.map((reason) => ({ key, reason })));
  }
}
