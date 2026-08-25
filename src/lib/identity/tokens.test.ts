/**
 * Tests for bearer-token minting and the typed prefix.
 *
 * The property worth protecting here is not "the token is random" — that is
 * `randomBytes`' job — but that the plaintext never becomes storable by accident
 * and that a token of one kind is refused where another kind is expected. The
 * second is `authentication-and-access.md` AC21/AC22, and it is enforced twice:
 * structurally (client and operator sessions live in different tables) and here,
 * before a query is even issued. This file covers the early half, and
 * `service.test.ts` covers the structural half against a real database.
 */

import assert from 'node:assert/strict';
import { specTest, unitTest } from '@zeddev/testing';
import {
  claimedTokenKind,
  hashToken,
  hasTokenKind,
  mintToken,
  TOKEN_KINDS,
  TOKEN_PREFIXES,
} from './tokens.ts';

unitTest('a minted token is wrapped so it cannot reach a log by accident', () => {
  const { token } = mintToken('client_session');
  // Every escape route a value normally takes into a log line.
  assert.equal(`${token}`, '[redacted]');
  assert.equal(JSON.stringify({ token }), '{"token":"[redacted]"}');
  assert.equal(String(token), '[redacted]');
  assert.match(token.expose(), /^zcs1_[A-Za-z0-9_-]{43}$/);
});

specTest(
  'credential-and-secret-handling.md',
  'AC4 stored data alone is insufficient to use a credential',
  'the stored form of a session token is a digest, not the token',
  () => {
    const { token, hash } = mintToken('client_session');
    // A session token *is* authentication, so a database read must not be
    // equivalent to holding every live session.
    assert.equal(hash.includes(token.expose()), false);
    assert.match(hash, /^[0-9a-f]{64}$/);
    assert.equal(hashToken(token.expose()), hash, 'the digest must be reproducible from the token');
  },
);

unitTest('every kind mints a distinguishable, non-colliding token', () => {
  const prefixes = new Set(Object.values(TOKEN_PREFIXES));
  assert.equal(prefixes.size, TOKEN_KINDS.length, 'two kinds share a prefix');

  for (const kind of TOKEN_KINDS) {
    const { token } = mintToken(kind);
    assert.equal(hasTokenKind(token.expose(), kind), true);
    assert.equal(claimedTokenKind(token.expose()), kind);
    for (const other of TOKEN_KINDS) {
      if (other === kind) continue;
      assert.equal(
        hasTokenKind(token.expose(), other),
        false,
        `a ${kind} token was accepted as a ${other} token`,
      );
    }
  }
});

specTest(
  'authentication-and-access.md',
  'AC21/AC22 each principal type’s token is rejected at the other’s surfaces',
  'a client session token does not claim to be an operator session token',
  () => {
    const client = mintToken('client_session').token.expose();
    const operator = mintToken('operator_session').token.expose();
    assert.equal(hasTokenKind(client, 'operator_session'), false);
    assert.equal(hasTokenKind(operator, 'client_session'), false);
  },
);

unitTest('a token consisting only of a prefix is not accepted as that kind', () => {
  // Otherwise the prefix check would pass on a value carrying no entropy at all,
  // and the only thing standing between a caller and a lookup would be the
  // digest miss.
  for (const kind of TOKEN_KINDS) {
    assert.equal(hasTokenKind(TOKEN_PREFIXES[kind], kind), false);
    assert.equal(hasTokenKind('', kind), false);
  }
});

unitTest('two mints of the same kind never produce the same token', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 256; i += 1) seen.add(mintToken('password_reset').hash);
  assert.equal(seen.size, 256);
});
