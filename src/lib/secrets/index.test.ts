/**
 * Why these tests matter: `credential-and-secret-handling.md` draws a hard line
 * between credentials that must be irreversible and credentials that must remain
 * usable. Both directions of that mistake are catastrophic and neither is visible
 * at runtime — a reversibly-encrypted password looks exactly like a hashed one
 * from the outside, right up until the key leaks. So the properties are asserted
 * directly rather than inferred from the code reading correctly.
 */

import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { specTest, unitTest } from '@zeddev/testing';
import { ConfigurationError, ValidationError } from '@zeddev/errors';
import {
  SECRET_CLASSES,
  Secret,
  SecretSealer,
  generateSealingKey,
  hashCredential,
  isSecret,
  parseSealingKey,
  secretRef,
  verifyCredential,
} from './index.ts';

const PASSWORD = 'correct horse battery staple';
// Deliberately weak scrypt parameters: these tests exercise the *format and
// verification logic*, not the work factor, and production cost parameters would
// make the suite slow enough that people stop running it.
const FAST = { N: 1024, r: 8, p: 1 } as const;

function sealer(): SecretSealer {
  return new SecretSealer([parseSealingKey(generateSealingKey('k1'), 'TEST_KEY')]);
}

specTest(
  'credential-and-secret-handling.md',
  'AC3 account credentials stored one-way',
  'the stored form does not contain the credential and cannot be reversed to it',
  async () => {
    const stored = await hashCredential(PASSWORD, FAST);

    assert.ok(!stored.includes(PASSWORD), 'the plaintext must not appear in the stored form');
    assert.ok(stored.startsWith('scrypt$'), 'the stored form is self-describing');
    // Salted: the same password stored twice yields different values, so a
    // stolen table cannot be attacked by grouping identical hashes.
    const again = await hashCredential(PASSWORD, FAST);
    assert.notEqual(stored, again);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC3 possession of the stored form does not permit authentication',
  'the stored hash cannot itself be presented as the credential',
  async () => {
    const stored = await hashCredential(PASSWORD, FAST);

    assert.equal(await verifyCredential(PASSWORD, stored), true);
    assert.equal(await verifyCredential(stored, stored), false, 'replaying the hash must fail');
    assert.equal(await verifyCredential('wrong password', stored), false);
  },
);

specTest(
  'authentication-and-access.md',
  'AC3 no account enumeration',
  'a malformed stored hash returns false instead of throwing a distinguishable error',
  async () => {
    // A throw here would let a caller tell "corrupt record" apart from "wrong
    // password", which is exactly the distinction the spec requires be hidden.
    for (const malformed of ['', 'garbage', 'scrypt$only$three', 'bcrypt$1$2$3$4$5', 'scrypt$x$8$1$c2E=$aGFzaA==']) {
      assert.equal(await verifyCredential(PASSWORD, malformed), false, `for ${JSON.stringify(malformed)}`);
    }
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC4 usable credentials protected at rest',
  'a sealed WhatsApp token is not readable from the stored data alone',
  () => {
    const token = 'EAAG-real-whatsapp-access-token';
    const sealed = sealer().seal(token);

    assert.ok(!sealed.includes(token), 'the plaintext must not appear in the sealed value');
    assert.ok(!Buffer.from(sealed, 'utf8').toString('utf8').includes('EAAG'));
    // Distinct nonce per seal, so identical tokens across two tenants do not
    // produce identical ciphertext and reveal that they are the same value.
    assert.notEqual(sealed, sealer().seal(token));
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC4 usable credentials remain usable by the system',
  'a sealed credential round-trips back to its original value',
  () => {
    const s = sealer();
    const token = 'EAAG-real-whatsapp-access-token';
    assert.equal(s.unseal(s.seal(token), 'WHATSAPP_TOKEN').expose(), token);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC4 reading stored data alone is insufficient',
  'a tampered sealed value fails authentication rather than decrypting to attacker-chosen bytes',
  () => {
    const s = sealer();
    const sealed = s.seal('EAAG-token');
    const parts = sealed.split('$');

    // Flip a byte of ciphertext. Without an authenticated cipher this would
    // decrypt to garbage that then gets sent upstream as a credential.
    const ciphertext = Buffer.from(parts[4]!, 'base64');
    ciphertext.writeUInt8(ciphertext.readUInt8(0) ^ 0xff, 0);
    parts[4] = ciphertext.toString('base64');

    assert.throws(() => s.unsealToBuffer(parts.join('$')), ValidationError);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC5 no secret value in any log, error, metric or notification',
  'a Secret redacts itself through every serialization path',
  () => {
    const secret = new Secret('super-secret-token', 'AI_API_KEY');

    assert.equal(String(secret), '[redacted]');
    assert.equal(`${secret}`, '[redacted]');
    assert.equal(JSON.stringify(secret), '"[redacted]"');
    assert.equal(JSON.stringify({ key: secret }), '{"key":"[redacted]"}');
    assert.ok(!inspect(secret).includes('super-secret-token'), 'util.inspect must not reveal it');
    assert.ok(!inspect({ nested: secret }, { depth: 5 }).includes('super-secret-token'));
    // Reading it requires the explicit, greppable call.
    assert.equal(secret.expose(), 'super-secret-token');
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC5 secrets identified by a non-sensitive reference',
  'secretRef is stable, non-reversible, and reveals nothing about the value',
  () => {
    const value = 'EAAG-real-whatsapp-access-token';
    const ref = secretRef(value);

    assert.equal(ref, secretRef(value), 'stable, so two records can be compared');
    assert.notEqual(ref, secretRef(`${value}x`));
    assert.ok(!ref.includes('EAAG'));
    assert.ok(ref.startsWith('sha256:'));
    assert.equal(new Secret(value, 'label').ref, ref);
  },
);

specTest(
  'credential-and-secret-handling.md',
  'AC13 operator cannot retrieve a tenant credential value',
  'a sealed value names its key id without exposing anything decryptable',
  () => {
    const s = sealer();
    const sealed = s.seal('EAAG-token');
    assert.equal(SecretSealer.keyIdOf(sealed), 'k1');
    assert.equal(SecretSealer.keyIdOf('not-a-sealed-value'), undefined);
  },
);

unitTest('cost parameters are read from the stored hash, so they can be raised without a migration', async () => {
  // This is what keeps "one code path" true as the work factor increases:
  // credentials stored under the old cost still verify alongside new ones.
  const oldCost = await hashCredential(PASSWORD, { N: 512, r: 8, p: 1 });
  const newCost = await hashCredential(PASSWORD, { N: 2048, r: 8, p: 1 });

  assert.ok(oldCost.startsWith('scrypt$512$'));
  assert.ok(newCost.startsWith('scrypt$2048$'));
  assert.equal(await verifyCredential(PASSWORD, oldCost), true);
  assert.equal(await verifyCredential(PASSWORD, newCost), true);
});

unitTest('an empty credential is rejected rather than hashed', async () => {
  await assert.rejects(() => hashCredential(''), ValidationError);
});

unitTest('key rotation: a value sealed under an old key still unseals after a new key becomes active', async () => {
  const k1 = parseSealingKey(generateSealingKey('k1'), 'K');
  const k2 = parseSealingKey(generateSealingKey('k2'), 'K');

  const before = new SecretSealer([k1], 'k1');
  const sealedUnderK1 = before.seal('EAAG-token');

  // Both keys held, k2 now active. This is what makes rotation not a flag day.
  const after = new SecretSealer([k1, k2], 'k2');
  assert.equal(after.activeKeyId, 'k2');
  assert.equal(after.unseal(sealedUnderK1, 'T').expose(), 'EAAG-token');
  assert.equal(SecretSealer.keyIdOf(after.seal('EAAG-token')), 'k2');
});

unitTest('unsealing a value whose key is no longer held is a clear configuration error', () => {
  const k1 = parseSealingKey(generateSealingKey('k1'), 'K');
  const k2 = parseSealingKey(generateSealingKey('k2'), 'K');
  const sealed = new SecretSealer([k1], 'k1').seal('token');

  // Diagnosable rather than a decryption failure: the operator dropped a key
  // that is still in use, and the message needs to say so.
  assert.throws(() => new SecretSealer([k2], 'k2').unsealToBuffer(sealed), ConfigurationError);
});

unitTest('sealing key configuration is validated with an actionable message', () => {
  assert.throws(() => parseSealingKey('no-separator', 'SEALING_KEY'), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(error.keys, ['SEALING_KEY']);
    return true;
  });

  // A 16-byte key would silently give AES-128 instead of AES-256.
  const short = `k1:${Buffer.alloc(16).toString('base64')}`;
  assert.throws(() => parseSealingKey(short, 'SEALING_KEY'), (error: unknown) => {
    assert.ok(error instanceof ConfigurationError);
    assert.ok(error.message.includes('32 bytes'));
    return true;
  });
});

unitTest('a sealer requires at least one key and an active key it actually holds', () => {
  assert.throws(() => new SecretSealer([]), ConfigurationError);
  const k1 = parseSealingKey(generateSealingKey('k1'), 'K');
  assert.throws(() => new SecretSealer([k1], 'missing'), ConfigurationError);
});

unitTest('isSecret detects wrapped values so generic serializers can refuse them', () => {
  assert.equal(isSecret(new Secret('v', 'l')), true);
  assert.equal(isSecret('v'), false);
  assert.equal(isSecret(null), false);
});

unitTest('the recognised secret classes match the spec enumeration', () => {
  // Enumerated so an access record can name what was touched without holding it.
  assert.deepEqual([...SECRET_CLASSES].sort(), [
    'ai_provider_credential',
    'client_account_credential',
    'infrastructure_credential',
    'operator_account_credential',
    'tenant_whatsapp_credential',
    'webhook_signing_secret',
  ]);
});
