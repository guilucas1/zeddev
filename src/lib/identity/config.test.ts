/**
 * Tests for the identity policy's configuration.
 *
 * Two things are worth pinning here. First, that the platform starts with no
 * identity variables set at all — `authentication-and-access.md` requires bounds
 * to *exist*, and a deployment that has to name seven values before it can boot
 * is a deployment nobody stands up correctly. Second, the cross-key check: an
 * absolute session lifetime below the inactivity timeout is valid on each key
 * alone and jointly disables one of the two expiry rules the spec requires, which
 * is exactly the class of behavioural difference `environment-portability.md`
 * says the configuration list must be able to explain.
 */

import assert from 'node:assert/strict';
import { ConfigurationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { IDENTITY_CONFIG_SCHEMA, loadIdentityPolicy } from './config.ts';

unitTest('every identity bound has a defensible default, so a bare environment boots', () => {
  const policy = loadIdentityPolicy({});
  assert.equal(policy.sessionInactivityMs, 12 * 60 * 60 * 1000);
  assert.equal(policy.sessionAbsoluteLifetimeMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(policy.maxFailedAttempts, 10);
  assert.equal(policy.minPasswordLength, 12);
  // The reset link is deliberately much shorter-lived than the verification
  // link: it grants takeover in one click and anyone can request one.
  assert.ok(policy.passwordResetTtlMs < policy.emailVerificationTtlMs);
});

unitTest('each bound is overridable, and durations require a unit', () => {
  const policy = loadIdentityPolicy({
    IDENTITY_SESSION_INACTIVITY_TIMEOUT: '30m',
    IDENTITY_SESSION_ABSOLUTE_LIFETIME: '2d',
    IDENTITY_LOGIN_MAX_FAILED_ATTEMPTS: '5',
    IDENTITY_MIN_PASSWORD_LENGTH: '16',
  });
  assert.equal(policy.sessionInactivityMs, 30 * 60 * 1000);
  assert.equal(policy.sessionAbsoluteLifetimeMs, 2 * 24 * 60 * 60 * 1000);
  assert.equal(policy.maxFailedAttempts, 5);
  assert.equal(policy.minPasswordLength, 16);

  // `1800` is ambiguous between seconds and milliseconds, and getting it wrong
  // silently changes session length by a factor of a thousand.
  assert.throws(
    () => loadIdentityPolicy({ IDENTITY_SESSION_INACTIVITY_TIMEOUT: '1800' }),
    ConfigurationError,
  );
});

specTest(
  'environment-portability.md',
  'AC7 startup fails with a clear error identifying the invalid configuration',
  'an absolute session lifetime below the inactivity timeout is refused at startup',
  () => {
    // Individually valid on both keys. Jointly, no session could ever reach the
    // inactivity bound, so only one of the two required expiry rules is in force
    // and no reading of the configuration list would reveal it.
    try {
      loadIdentityPolicy({
        IDENTITY_SESSION_INACTIVITY_TIMEOUT: '2d',
        IDENTITY_SESSION_ABSOLUTE_LIFETIME: '1h',
      });
      assert.fail('expected the combination to be refused');
    } catch (error) {
      assert.ok(error instanceof ConfigurationError);
      assert.deepEqual(error.keys, ['IDENTITY_SESSION_ABSOLUTE_LIFETIME']);
    }
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC1 no secret is embedded in source or configuration examples',
  'no identity configuration key is a secret, and no example is credential-shaped',
  () => {
    // The identity policy is entirely bounds and counts. If a key here ever
    // needed to be a secret — a signing key, say — it would have to be marked
    // so that `Secret` wrapping applies, and this test is where that decision
    // becomes visible in a diff.
    for (const [key, spec] of Object.entries(IDENTITY_CONFIG_SCHEMA)) {
      assert.equal('secret' in spec, false, `${key} claims to be a secret`);
      assert.notEqual(spec.description, '', `${key} has no description to document`);
    }
  },
);
