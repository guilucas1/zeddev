/**
 * Tests for the credential-strength standard and address validation.
 *
 * These are the cheapest tests in the package and they guard the most-copied
 * rule in the system. `client-signup-and-tenancy.md` requires a minimum
 * credential standard at signup, and `authentication-and-access.md` requires the
 * same credentials be settable through a reset flow — so the standard is enforced
 * at three entry points (signup, change, reset). If it lived in three places the
 * weakest one would define the platform's actual policy, and nothing would fail
 * to reveal that. What these tests really pin down is that there is one rule.
 *
 * The negative cases are chosen to be the ones a length check alone would let
 * through: `aaaaaaaaaaaa` and `abcdefghijkl` are both twelve characters and both
 * appear near the top of any guessing list.
 */

import assert from 'node:assert/strict';
import { ValidationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import {
  assertBusinessName,
  assertEmail,
  assertPasswordStrength,
  emailLocalPart,
  MAX_PASSWORD_LENGTH,
  normalizeEmail,
  passwordProblems,
} from './credentials.ts';

const MIN = { minLength: 12 } as const;

specTest(
  'client-signup-and-tenancy.md',
  'AC4 a credential below the minimum strength standard is rejected',
  'a password shorter than the configured minimum is refused',
  () => {
    assert.deepEqual(passwordProblems('short', MIN), ['must be at least 12 characters']);
    assert.throws(() => assertPasswordStrength('short', MIN), ValidationError);
  },
);

specTest(
  'client-signup-and-tenancy.md',
  'AC4 a credential below the minimum strength standard is rejected',
  'a long but trivially guessable password is refused despite passing the length check',
  () => {
    // Each of these is at or beyond the minimum length. A rule that only counted
    // characters would accept all four.
    for (const weak of ['aaaaaaaaaaaa', 'abcdefghijkl', 'password1234', 'qwertyuiop12']) {
      assert.notEqual(
        passwordProblems(weak, MIN).length,
        0,
        `expected a length-passing but weak password to be refused: ${weak.length} chars`,
      );
    }
  },
);

specTest(
  'client-signup-and-tenancy.md',
  'AC4 a credential below the minimum strength standard is rejected',
  'a password containing the business name or the email local part is refused',
  () => {
    assert.deepEqual(
      passwordProblems('alphabakery-2026', { ...MIN, businessName: 'Alpha Bakery' }),
      ['must not contain the business name'],
    );
    assert.deepEqual(
      passwordProblems('owner-of-the-shop', { ...MIN, email: 'owner@alpha.example.com' }),
      ['must not contain the email address it belongs to'],
    );
  },
);

unitTest('a strong passphrase is accepted, with no composition rules imposed', () => {
  // All lower case, no digits, no symbols. A composition rule would refuse it;
  // it is far stronger than anything a composition rule produces.
  assert.deepEqual(passwordProblems('correct horse battery staple', MIN), []);
  assert.doesNotThrow(() => assertPasswordStrength('correct horse battery staple', MIN));
});

unitTest('an over-long password is refused, bounding per-attempt hashing cost', () => {
  // The login path is reachable unauthenticated and pays a full scrypt per
  // attempt. An unbounded field turns that into an amplification primitive.
  const problems = passwordProblems('x'.repeat(MAX_PASSWORD_LENGTH + 1), MIN);
  assert.deepEqual(problems, [`must be at most ${MAX_PASSWORD_LENGTH} characters`]);
});

unitTest('every reason is reported at once rather than one per attempt', () => {
  const problems = passwordProblems('bakery-bakery', {
    minLength: 12,
    email: 'bakery@alpha.example.com',
    businessName: 'Bakery',
  });
  assert.equal(problems.length, 2, problems.join('; '));
});

unitTest('a validation reason never quotes the password it rejected', () => {
  const secretish = 'hunter2-hunter2';
  for (const reason of passwordProblems(secretish, { ...MIN, businessName: 'hunter2' })) {
    assert.equal(reason.includes(secretish), false);
    assert.equal(reason.includes('hunter2'), false);
  }
});

specTest(
  'client-signup-and-tenancy.md',
  'AC1 signup requires valid, unique information',
  'an undeliverable email address is refused before any account is created',
  () => {
    for (const bad of ['', 'nobody', 'nobody@', '@example.com', 'a b@example.com', 'x@y']) {
      assert.throws(() => assertEmail(bad), ValidationError, `expected rejection of ${JSON.stringify(bad)}`);
    }
    assert.equal(assertEmail('Owner@Example.COM'), 'owner@example.com');
  },
);

unitTest('an address is stored in exactly one canonical form', () => {
  // The schema enforces uniqueness on `lower(email)`, so two casings can never
  // both exist. Normalising on the way in removes any question about which of
  // them a recovery mail would be addressed to.
  assert.equal(normalizeEmail('  Owner@Example.com  '), 'owner@example.com');
  assert.equal(emailLocalPart('Owner@Example.com'), 'owner');
});

unitTest('a business name is trimmed, collapsed, and bounded', () => {
  assert.equal(assertBusinessName('  Alpha   Bakery  '), 'Alpha Bakery');
  assert.throws(() => assertBusinessName('   '), ValidationError);
  assert.throws(() => assertBusinessName('x'.repeat(201)), ValidationError);
});
