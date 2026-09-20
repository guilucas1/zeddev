/**
 * Loading the sealing keys.
 *
 * The interesting cases are all failures, and they matter because
 * `credential-and-secret-handling.md` AC2 requires the system "fail to start with
 * a clear, diagnosable error when a required secret is absent, rather than
 * starting in a degraded or insecure state". A vault that quietly generated a key
 * when none was configured would start, work, and lose every stored credential on
 * the next restart.
 */

import assert from 'node:assert/strict';
import { ConfigurationError } from '@zeddev/errors';
import { generateSealingKey } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { loadSealer, VAULT_CONFIG_SCHEMA } from './config.ts';

function keysOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    assert.ok(error instanceof ConfigurationError, `expected a ConfigurationError, got ${String(error)}`);
    return error.keys;
  }
  throw new assert.AssertionError({ message: 'expected loading to fail' });
}

specTest(
  'credential-and-secret-handling.md',
  'AC2 a missing secret fails startup with a clear error naming it',
  'no sealing key means a startup failure naming the key, never a generated one',
  () => {
    assert.deepEqual(keysOf(() => loadSealer({})), ['VAULT_SEALING_KEYS']);
  },
);

unitTest('every problem with the key list is reported at once', () => {
  assert.deepEqual(
    keysOf(() =>
      loadSealer({
        VAULT_SEALING_KEYS: 'no-separator-here',
        VAULT_ACTIVE_SEALING_KEY: 'not-listed',
      }),
    ),
    ['VAULT_ACTIVE_SEALING_KEY', 'VAULT_SEALING_KEYS'],
  );
});

unitTest('a key of the wrong length is refused rather than padded', () => {
  assert.deepEqual(keysOf(() => loadSealer({ VAULT_SEALING_KEYS: 'k1:c2hvcnQ=' })), ['VAULT_SEALING_KEYS']);
});

unitTest('the same key id twice is refused, because one would silently shadow the other', () => {
  const first = generateSealingKey('k1');
  const second = generateSealingKey('k1');
  assert.deepEqual(keysOf(() => loadSealer({ VAULT_SEALING_KEYS: `${first},${second}` })), ['VAULT_SEALING_KEYS']);
});

unitTest('an empty active key id means the first listed key', () => {
  const sealer = loadSealer({
    VAULT_SEALING_KEYS: `${generateSealingKey('first')},${generateSealingKey('second')}`,
    VAULT_ACTIVE_SEALING_KEY: '',
  });
  assert.equal(sealer.activeKeyId, 'first');
});

specTest(
  'credential-and-secret-handling.md',
  'AC8 a credential is replaced without downtime for other tenants and without redeployment',
  'several keys may be held at once with a chosen one active, which is what makes rotation configuration',
  () => {
    const retired = generateSealingKey('retired');
    const current = generateSealingKey('current');
    const sealer = loadSealer({
      VAULT_SEALING_KEYS: ` ${retired} , ${current} `,
      VAULT_ACTIVE_SEALING_KEY: 'current',
    });
    assert.equal(sealer.activeKeyId, 'current');

    // What the retired key sealed is still readable, which is the whole point:
    // rotation is never a moment at which stored credentials stop working.
    const onlyRetired = loadSealer({ VAULT_SEALING_KEYS: retired });
    assert.equal(sealer.unseal(onlyRetired.seal('value'), 'test').expose(), 'value');
  },
);

unitTest('the sealing key list is marked secret, so it cannot be logged or shown in the reference', () => {
  assert.equal(VAULT_CONFIG_SCHEMA.VAULT_SEALING_KEYS.secret, true);
});
