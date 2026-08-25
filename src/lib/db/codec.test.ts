/**
 * Codec tests.
 *
 * These run without a database because they test a pure function, but every
 * expectation in them was checked against a real server's text output rather than
 * written from memory — the encoder and decoder agreeing with each other proves
 * nothing, which is why `index.test.ts` round-trips the same types through
 * PostgreSQL.
 */

import assert from 'node:assert/strict';
import { specTest, unitTest } from '@zeddev/testing';
import { Secret } from '@zeddev/secrets';
import { ValidationError } from '@zeddev/errors';
import { decodeValue, encodeParam, normalizeTimestampText, OID, parseArrayText, rowCountFromTag } from './codec.ts';

unitTest('booleans decode from PostgreSQL t/f rather than true/false', () => {
  assert.equal(decodeValue(OID.bool, 't'), true);
  assert.equal(decodeValue(OID.bool, 'f'), false);
});

unitTest('int8 stays a number while it is exactly representable', () => {
  assert.equal(decodeValue(OID.int8, '42'), 42);
  assert.equal(decodeValue(OID.int8, String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
});

unitTest('int8 beyond the safe range becomes a bigint rather than silently rounding', () => {
  const beyond = '9007199254740993'; // MAX_SAFE_INTEGER + 2
  const decoded = decodeValue(OID.int8, beyond);
  assert.equal(typeof decoded, 'bigint');
  assert.equal((decoded as bigint).toString(), beyond);
});

specTest(
  'cost-efficient-operation.md',
  'per-tenant cost and usage figures are reported accurately',
  'numeric decodes to a string so a monetary value never passes through a float',
  () => {
    // 0.1 + 0.2 !== 0.3 in IEEE-754. If numeric decoded to a number, a usage or
    // cost total assembled from many such values would drift, and the drift
    // would only show up as a billing dispute.
    const decoded = decodeValue(OID.numeric, '12345678901234567890.12345');
    assert.equal(typeof decoded, 'string');
    assert.equal(decoded, '12345678901234567890.12345');
  },
);

unitTest('timestamptz decodes to the correct instant despite the two-digit offset', () => {
  const decoded = decodeValue(OID.timestamptz, '2026-08-25 14:30:00.123+00');
  assert.ok(decoded instanceof Date);
  assert.equal((decoded as Date).toISOString(), '2026-08-25T14:30:00.123Z');
});

unitTest('a non-UTC two-digit offset is expanded before parsing', () => {
  assert.equal(normalizeTimestampText('2026-08-25 14:30:00+02', false), '2026-08-25T14:30:00+02:00');
  const decoded = decodeValue(OID.timestamptz, '2026-08-25 14:30:00+02') as Date;
  assert.equal(decoded.toISOString(), '2026-08-25T12:30:00.000Z');
});

unitTest('a date-only value is left as text rather than acquiring a time zone', () => {
  assert.equal(decodeValue(OID.date, '2026-08-25'), '2026-08-25');
});

unitTest('bytea decodes from hex output', () => {
  const decoded = decodeValue(OID.bytea, '\\x48656c6c6f');
  assert.ok(Buffer.isBuffer(decoded));
  assert.equal((decoded as Buffer).toString('utf8'), 'Hello');
});

unitTest('an unquoted NULL element is null but a quoted one is the four-character string', () => {
  assert.deepEqual(parseArrayText('{NULL,"NULL"}'), [null, 'NULL']);
});

unitTest('array elements containing commas and quotes survive parsing', () => {
  assert.deepEqual(parseArrayText('{"a,b","say \\"hi\\"",plain}'), ['a,b', 'say "hi"', 'plain']);
});

unitTest('nested arrays decode elementwise', () => {
  assert.deepEqual(decodeValue(1007, '{{1,2},{3,4}}'), [
    [1, 2],
    [3, 4],
  ]);
});

unitTest('an empty array decodes to an empty array, not to a one-element array', () => {
  assert.deepEqual(parseArrayText('{}'), []);
});

specTest(
  'credential-and-secret-handling.md',
  'AC5 no secret value reaches a log, diagnostic, or record',
  'a Secret passed as a query parameter is refused rather than silently stored',
  () => {
    // The point is not that storing a credential is forbidden — sealed
    // credentials are stored deliberately. It is that reaching a database write
    // must require an explicit `expose()`, so the answer to "which components can
    // see this secret" stays greppable.
    assert.throws(
      () => encodeParam(new Secret('a-real-token', 'test')),
      (error: unknown) => error instanceof ValidationError,
    );
  },
);

unitTest('undefined encodes as SQL NULL so an absent optional field is not a crash', () => {
  assert.equal(encodeParam(undefined), null);
  assert.equal(encodeParam(null), null);
});

unitTest('NaN and Infinity are refused rather than encoded as text PostgreSQL will reject later', () => {
  assert.throws(() => encodeParam(Number.NaN), (error: unknown) => error instanceof ValidationError);
  assert.throws(() => encodeParam(Number.POSITIVE_INFINITY), (error: unknown) => error instanceof ValidationError);
});

unitTest('a Date parameter encodes as an unambiguous ISO instant', () => {
  const encoded = encodeParam(new Date('2026-08-25T14:30:00.000Z'));
  assert.equal(encoded?.toString('utf8'), '2026-08-25T14:30:00.000Z');
});

unitTest('row counts are read from the tag, including the two-field INSERT form', () => {
  assert.equal(rowCountFromTag('INSERT 0 3'), 3);
  assert.equal(rowCountFromTag('UPDATE 2'), 2);
  assert.equal(rowCountFromTag('SELECT 7'), 7);
  assert.equal(rowCountFromTag('CREATE TABLE'), 0);
});
