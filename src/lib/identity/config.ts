/**
 * The numbers `authentication-and-access.md` deliberately left open.
 *
 * That spec is unusual in how explicitly it defers: "exact session inactivity
 * timeout and absolute session lifetime values are left open; a bound of each
 * kind must be defined at implementation time", and the same for the lockout
 * threshold, the lockout duration, and the recovery-link expiry. This module is
 * where those get defined — as configuration rather than constants, because
 * `environment-portability.md` requires that every behavioral difference between
 * two deployments be explainable from the documented configuration list, and
 * "our VPS holds sessions for a day and our laptop for a week" is exactly such a
 * difference.
 *
 * Every default below is chosen for a reason worth writing down, because a
 * default nobody can justify is a default nobody dares change.
 */

import { loadConfig, type Config, type RawEnv } from '@zeddev/config';
import { ConfigurationError } from '@zeddev/errors';

export const IDENTITY_CONFIG_SCHEMA = {
  IDENTITY_SESSION_INACTIVITY_TIMEOUT: {
    type: 'duration',
    // Long enough to span a working day without a re-login, short enough that a
    // session left open on a shared machine dies overnight. The client surface
    // is a configuration dashboard visited occasionally, not a tool held open
    // for weeks, so there is little cost to the shorter side.
    default: 12 * 60 * 60 * 1000,
    min: 60_000,
    description:
      'How long a client or operator session survives without use. Measured from the last request the session made, and refreshed on each one. Required by authentication-and-access.md AC5, which mandates an inactivity bound but leaves the value to implementation.',
    example: '12h',
  },
  IDENTITY_SESSION_ABSOLUTE_LIFETIME: {
    type: 'duration',
    // A week. This is the bound that limits how long a *stolen* token stays
    // useful when the thief keeps it active, which is why it exists separately
    // from the inactivity bound: continuous activity defeats an inactivity
    // timeout entirely.
    default: 7 * 24 * 60 * 60 * 1000,
    min: 300_000,
    description:
      'Maximum total life of a session regardless of activity. Caps how long a stolen token remains usable, which an inactivity timeout alone cannot do because activity refreshes it. Required by authentication-and-access.md AC6.',
    example: '7d',
  },
  IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS: {
    type: 'integer',
    // Ten rather than three or five. The threshold trades credential-guessing
    // resistance against a denial-of-service handed to anyone who knows a
    // client's email address, and the real defence against guessing is scrypt
    // plus a 12-character minimum, not this counter. Ten stops an automated
    // sweep while leaving room for a person who genuinely cannot remember which
    // of their passwords they used.
    default: 10,
    min: 3,
    max: 1000,
    description:
      'Consecutive failed authentication attempts against one account before further attempts are locked out rather than evaluated. Required by authentication-and-access.md AC12. Counted on the account row so the count survives a restart — an in-memory counter would let routine redeploys reset an attacker’s budget.',
    example: '10',
  },
  IDENTITY_LOGIN_LOCKOUT_DURATION: {
    type: 'duration',
    // Fifteen minutes reduces an attacker to roughly 40 guesses an hour while
    // costing a locked-out owner one coffee break. Long enough to matter,
    // short enough that it never needs an operator to clear it — and the spec
    // requires recovery be possible "without operator involvement".
    default: 15 * 60 * 1000,
    min: 1000,
    description:
      'How long authentication is refused for an account that reached the failed-attempt threshold. Expires on its own so that lockout never requires operator intervention to clear, which client-signup-and-tenancy.md requires of every recovery path.',
    example: '15m',
  },
  IDENTITY_EMAIL_VERIFICATION_TTL: {
    type: 'duration',
    // A day. Verification mail is read when the signer gets to it, and a link
    // that expires in an hour turns a lunch break into a failed signup.
    default: 24 * 60 * 60 * 1000,
    min: 300_000,
    description:
      'How long an email-verification link remains redeemable. Required by authentication-and-access.md AC11, which mandates a defined expiry for any recovery link or code but prescribes no value.',
    example: '24h',
  },
  IDENTITY_PASSWORD_RESET_TTL: {
    type: 'duration',
    // An hour, an order of magnitude shorter than verification, because the two
    // links are not equally dangerous: a reset link is a full account takeover
    // in one click, and it is requestable by anyone who knows an email address.
    default: 60 * 60 * 1000,
    min: 300_000,
    description:
      'How long a password-reset link remains redeemable. Deliberately much shorter than the verification link: a reset link grants account takeover in one click and can be requested by anyone who knows the address.',
    example: '1h',
  },
  IDENTITY_MIN_PASSWORD_LENGTH: {
    type: 'integer',
    // Twelve. NIST SP 800-63B sets a floor of 8 and recommends allowing much
    // more; 12 is the common hardened choice and is the single most effective
    // control available here, since length dominates every other property of a
    // password.
    default: 12,
    min: 8,
    max: 128,
    description:
      'Minimum accepted length for a client or operator password. The credential-strength standard client-signup-and-tenancy.md requires but leaves undefined. There are no composition rules by design — see credentials.ts for why length plus a blocklist beats "one uppercase and one digit".',
    example: '12',
  },
} as const;

export type IdentityConfig = Config<typeof IDENTITY_CONFIG_SCHEMA>;

/**
 * The policy the service actually reads.
 *
 * A plain object rather than the raw config, so that tests can construct one
 * directly with short windows — session-expiry behaviour is verified against a
 * real PostgreSQL using the database's own clock (see `service.ts` for why), and
 * a test that had to wait twelve hours would simply not exist.
 */
export interface IdentityPolicy {
  readonly sessionInactivityMs: number;
  readonly sessionAbsoluteLifetimeMs: number;
  readonly maxFailedAttempts: number;
  readonly lockoutMs: number;
  readonly emailVerificationTtlMs: number;
  readonly passwordResetTtlMs: number;
  readonly minPasswordLength: number;
}

/**
 * Build the policy from the environment, rejecting combinations that are each
 * individually valid and jointly incoherent.
 *
 * `loadConfig` validates keys one at a time and cannot see across them, but an
 * absolute lifetime shorter than the inactivity timeout makes the inactivity
 * timeout dead code — every session would hit the absolute bound first, and the
 * deployment would silently have one expiry rule where the spec requires two.
 * That is precisely the kind of difference `environment-portability.md` says the
 * configuration list must be able to explain, so it fails at startup rather than
 * becoming a behaviour nobody can account for.
 */
export function loadIdentityPolicy(env: RawEnv = process.env): IdentityPolicy {
  const config = loadConfig(IDENTITY_CONFIG_SCHEMA, env);
  if (config.IDENTITY_SESSION_ABSOLUTE_LIFETIME < config.IDENTITY_SESSION_INACTIVITY_TIMEOUT) {
    throw new ConfigurationError([
      {
        key: 'IDENTITY_SESSION_ABSOLUTE_LIFETIME',
        reason:
          'must be at least IDENTITY_SESSION_INACTIVITY_TIMEOUT, otherwise the inactivity bound can never be reached and only one of the two required expiry rules is in force',
      },
    ]);
  }
  return {
    sessionInactivityMs: config.IDENTITY_SESSION_INACTIVITY_TIMEOUT,
    sessionAbsoluteLifetimeMs: config.IDENTITY_SESSION_ABSOLUTE_LIFETIME,
    maxFailedAttempts: config.IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS,
    lockoutMs: config.IDENTITY_LOGIN_LOCKOUT_DURATION,
    emailVerificationTtlMs: config.IDENTITY_EMAIL_VERIFICATION_TTL,
    passwordResetTtlMs: config.IDENTITY_PASSWORD_RESET_TTL,
    minPasswordLength: config.IDENTITY_MIN_PASSWORD_LENGTH,
  };
}
