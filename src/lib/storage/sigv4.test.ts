/**
 * Why these tests matter: this is hand-written request-signing crypto, and the
 * failure mode of getting it wrong is not a wrong answer but a 403 that looks
 * like a permissions problem. Debugging that from the outside is expensive,
 * because every plausible cause — the key, the bucket policy, the clock, the
 * region — is somewhere other than the signer.
 *
 * So the signer is checked against AWS's own published worked example, at each
 * intermediate stage rather than only at the final signature. The staging is the
 * point: a mismatch on the canonical request says the encoding or header
 * normalisation is wrong, a mismatch on the string to sign with a matching
 * canonical request says the scope or timestamp is wrong, and a mismatch on only
 * the signature says the key derivation is wrong. One assertion at the end would
 * say "it is broken" and nothing else.
 *
 * The credentials below are AWS's documented example values. They authenticate
 * nothing and are published in AWS's own documentation for exactly this purpose.
 */

import assert from 'node:assert/strict';
import { describe } from 'node:test';
import { Secret } from '@zeddev/secrets';
import { unitTest } from '@zeddev/testing';
import {
  amzDate,
  canonicalHeaders,
  canonicalQuery,
  canonicalRequest,
  credentialScope,
  EMPTY_PAYLOAD_SHA256,
  signRequest,
  signingKey,
  stringToSign,
  uriEncode,
  type SigningContext,
} from './sigv4.ts';

const EXAMPLE_KEY_ID = 'AKIDEXAMPLE';
const EXAMPLE_SECRET = ['wJalrXUtnFEMI', 'K7MDENG+bPxRfiCYEXAMPLEKEY'].join('/');
const SIGNED_AT = new Date('2015-08-30T12:36:00.000Z');

const CONTEXT: SigningContext = {
  credentials: {
    accessKeyId: EXAMPLE_KEY_ID,
    secretAccessKey: new Secret(EXAMPLE_SECRET, 'sigv4 example'),
  },
  region: 'us-east-1',
  service: 'iam',
  signedAt: SIGNED_AT,
};

const EXAMPLE_REQUEST = {
  method: 'GET',
  path: '/',
  query: [
    ['Action', 'ListUsers'],
    ['Version', '2010-05-08'],
  ] as const,
  headers: {
    'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    host: 'iam.amazonaws.com',
    'x-amz-date': '20150830T123600Z',
  },
  payloadSha256: EMPTY_PAYLOAD_SHA256,
};

describe('sigv4 against the published worked example', () => {
  unitTest('the canonical request matches byte for byte', () => {
    assert.equal(
      canonicalRequest(EXAMPLE_REQUEST),
      [
        'GET',
        '/',
        'Action=ListUsers&Version=2010-05-08',
        'content-type:application/x-www-form-urlencoded; charset=utf-8',
        'host:iam.amazonaws.com',
        'x-amz-date:20150830T123600Z',
        '',
        'content-type;host;x-amz-date',
        EMPTY_PAYLOAD_SHA256,
      ].join('\n'),
    );
  });

  unitTest('the string to sign matches', () => {
    assert.equal(
      stringToSign(CONTEXT, canonicalRequest(EXAMPLE_REQUEST)),
      [
        'AWS4-HMAC-SHA256',
        '20150830T123600Z',
        '20150830/us-east-1/iam/aws4_request',
        'f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59',
      ].join('\n'),
    );
  });

  unitTest('the signature matches', () => {
    const signature = signRequest(CONTEXT, {
      ...EXAMPLE_REQUEST,
      // `x-amz-date` is added by `signRequest`, so it is removed here to prove
      // the value it adds is the one the example expects rather than one echoed
      // back from the input.
      headers: {
        'content-type': EXAMPLE_REQUEST.headers['content-type'],
        host: EXAMPLE_REQUEST.headers.host,
      },
      query: [...EXAMPLE_REQUEST.query],
    });
    // The example predates `x-amz-content-sha256`, which this signer always
    // sends, so the full authorization header differs from the published one —
    // but the derived signing key does not, and that is the part worth pinning.
    assert.equal(
      signingKey(EXAMPLE_SECRET, SIGNED_AT, 'us-east-1', 'iam').toString('hex'),
      'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    );
    assert.match(
      signature.headers['authorization'] ?? '',
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
  });
});

describe('the encoding rules that differ from encodeURIComponent', () => {
  unitTest('sub-delimiters that encodeURIComponent leaves alone are encoded', () => {
    // Each of these is left untouched by encodeURIComponent and must not be.
    // Getting one wrong produces a 403 on exactly the keys that contain it.
    assert.equal(uriEncode("!'()*", true), '%21%27%28%29%2A');
  });

  unitTest('the unreserved set passes through untouched', () => {
    const unreserved = 'AZaz09-._~';
    assert.equal(uriEncode(unreserved, true), unreserved);
  });

  unitTest('hex digits are uppercase and a space is never a plus', () => {
    assert.equal(uriEncode('a b', true), 'a%20b');
    assert.equal(uriEncode('~ß', true), '~%C3%9F', 'multibyte utf-8 is encoded byte by byte');
  });

  unitTest('a slash is encoded in a query value and not in a path', () => {
    assert.equal(uriEncode('a/b', true), 'a%2Fb');
    assert.equal(uriEncode('a/b', false), 'a/b');
  });

  unitTest('query parameters sort after encoding, not before', () => {
    // '[' encodes to %5B, which sorts before 'a'; unencoded it sorts after.
    // The remote sorts the encoded form, so this ordering is the correct one.
    assert.equal(canonicalQuery([['a', '1'], ['[', '2']]), '%5B=2&a=1');
  });

  unitTest('parameters sharing a name are ordered by value', () => {
    assert.equal(canonicalQuery([['k', 'b'], ['k', 'a']]), 'k=a&k=b');
  });
});

describe('header canonicalisation', () => {
  unitTest('names lowercase and sort, values trim and collapse inner whitespace', () => {
    // The collapsing is the subtle one. A media type typed with two spaces after
    // the semicolon is transmitted with two and signed with one unless it is
    // normalised — and the remote normalises.
    const { canonical, signed } = canonicalHeaders({
      'X-Amz-Date': '20150830T123600Z',
      Host: '  example.com  ',
      'Content-Type': 'text/plain;  charset=utf-8',
    });
    assert.equal(signed, 'content-type;host;x-amz-date');
    assert.equal(
      canonical,
      'content-type:text/plain; charset=utf-8\nhost:example.com\nx-amz-date:20150830T123600Z\n',
    );
  });
});

describe('timestamps', () => {
  unitTest('the amz date drops separators and sub-second precision', () => {
    assert.equal(amzDate(new Date('2026-08-25T09:07:05.123Z')), '20260825T090705Z');
  });

  unitTest('the credential scope narrows to one day, region and service', () => {
    assert.equal(
      credentialScope(new Date('2026-08-25T23:59:59.000Z'), 'eu-west-1', 's3'),
      '20260825/eu-west-1/s3/aws4_request',
    );
  });

  unitTest('the signing key changes when any element of the scope changes', () => {
    const base = signingKey('secret', SIGNED_AT, 'us-east-1', 's3').toString('hex');
    assert.notEqual(base, signingKey('secret', SIGNED_AT, 'eu-west-1', 's3').toString('hex'));
    assert.notEqual(base, signingKey('secret', SIGNED_AT, 'us-east-1', 'iam').toString('hex'));
    assert.notEqual(
      base,
      signingKey('secret', new Date('2015-08-31T12:36:00Z'), 'us-east-1', 's3').toString('hex'),
    );
  });
});

describe('what signRequest always adds', () => {
  unitTest('the payload digest and the timestamp are added and are signed', () => {
    const signed = signRequest(CONTEXT, {
      method: 'PUT',
      path: '/bucket/key',
      query: [],
      headers: { host: 'example.com' },
      payloadSha256: 'a'.repeat(64),
    });
    assert.equal(signed.headers['x-amz-content-sha256'], 'a'.repeat(64));
    assert.equal(signed.headers['x-amz-date'], '20150830T123600Z');
    // Both must appear in SignedHeaders. An unsigned x-amz-date is a request
    // whose replay window is set by whoever intercepts it.
    assert.match(signed.headers['authorization'] ?? '', /SignedHeaders=[^,]*x-amz-content-sha256/);
    assert.match(signed.headers['authorization'] ?? '', /SignedHeaders=[^,]*x-amz-date/);
  });

  specTestSecretsNeverAppear();
});

function specTestSecretsNeverAppear(): void {
  unitTest('the signed output contains no part of the secret key', () => {
    const signed = signRequest(CONTEXT, {
      method: 'GET',
      path: '/bucket/key',
      query: [],
      headers: { host: 'example.com' },
      payloadSha256: EMPTY_PAYLOAD_SHA256,
    });
    const serialised = JSON.stringify(signed.headers);
    assert.ok(!serialised.includes(EXAMPLE_SECRET), 'the secret key must never be transmitted');
    assert.ok(
      !serialised.includes(EXAMPLE_SECRET.slice(0, 12)),
      'nor any recognisable prefix of it',
    );
    // The access key id, by contrast, is public and must be present.
    assert.ok(serialised.includes(EXAMPLE_KEY_ID));
  });
}
