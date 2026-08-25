/**
 * The S3 adapter against a real S3-compatible server, plus the failure paths a
 * real server will not produce on demand.
 *
 * The split is deliberate and worth stating, because it is the difference
 * between this suite proving something and proving nothing. Anything a real
 * server *will* do — sign-and-accept, paginate, 404, reject a bad credential —
 * is tested against the real server, since a fake would have to reimplement
 * SigV4 verification to test SigV4 signing and would then only confirm this
 * package agrees with itself. Anything a real server will *not* do on request —
 * throttle, corrupt a body at rest, truncate a listing — is driven through the
 * injected transport, because the alternative is not testing it.
 *
 * See IMPLEMENTATION_PLAN.md §4c for what it cost to learn that a suite which
 * skips itself can be green while proving nothing; `scripts/require-services.ts`
 * is why `npm run check` will not let that happen here.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import {
  ConfigurationError,
  DefectError,
  NotFoundError,
  TransientTransportError,
} from '@zeddev/errors';
import { Logger, MemorySink } from '@zeddev/logging';
import { Secret } from '@zeddev/secrets';
import { specTest, unitTest } from '@zeddev/testing';
import { S3ObjectStore } from './s3.ts';
import { mapS3Failure, parseListPage } from './s3wire.ts';
import type { Transport, TransportRequest, TransportResponse } from './http.ts';
import {
  createTestBucket,
  runStorageConformance,
  SKIP_REASON,
  storageTestConfigured,
  type StorageHarness,
  type TestBucket,
} from './testing.ts';

const TENANTS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
];

const PDF = 'application/pdf';

// ---------------------------------------------------------------------------
// Against a real server
// ---------------------------------------------------------------------------

describe('s3 object store', { skip: storageTestConfigured() ? false : SKIP_REASON }, () => {
  const harness: StorageHarness = {
    label: 's3',
    async create(options = {}) {
      const bucket = await createTestBucket(
        'conformance',
        options.maxObjectBytes === undefined ? {} : { maxObjectBytes: options.maxObjectBytes },
      );
      return {
        store: bucket.store,
        tenants: TENANTS,
        async dispose() {
          await bucket.drop();
        },
      };
    },
  };

  runStorageConformance(harness);

  describe('endpoint behavior', () => {
    let fixture: TestBucket;

    before(async () => {
      if (!storageTestConfigured()) return;
      fixture = await createTestBucket('endpoint');
    });

    after(async () => {
      if (!storageTestConfigured()) return;
      await fixture.drop();
    });

    specTest(
      'credential-and-secret-handling.md',
      'given a tenant’s stored credential is obtained out of context, then it cannot be used to act on another tenant’s behalf',
      'a rejected credential fails on the first attempt with a diagnosable configuration error',
      async () => {
        if (!storageTestConfigured()) return;
        // The point is as much about *not retrying* as about the classification.
        // A signature that will never verify fails identically on every attempt,
        // so spending the allowance rediscovering that only delays a
        // configuration error reaching a human. Attempts are counted through the
        // transport so the assertion is about behaviour, not intent.
        let attempts = 0;
        const counting: Transport = async (request) => {
          attempts += 1;
          return realTransport(request);
        };
        const wrong = new S3ObjectStore({
          ...describeFixture(fixture),
          secretAccessKey: new Secret('definitely-not-the-configured-key', 'wrong key'),
          transport: counting,
          maxAttempts: 4,
        });

        await assert.rejects(() => wrong.verifyAccess(), ConfigurationError);
        assert.equal(attempts, 1, 'a credential failure must not consume the retry allowance');
        await wrong.close();
      },
    );

    specTest(
      'environment-portability.md',
      'given a required configuration value is missing or invalid, when the system attempts to start, then it reports a clear error rather than partially starting',
      'a bucket that does not exist is a startup failure naming STORAGE_BUCKET',
      async () => {
        if (!storageTestConfigured()) return;
        const missing = new S3ObjectStore({
          ...describeFixture(fixture),
          bucket: `t-absent-${'0'.repeat(8)}`,
        });
        try {
          await missing.verifyAccess();
          assert.fail('expected a ConfigurationError');
        } catch (error) {
          assert.ok(error instanceof ConfigurationError);
          assert.deepEqual([...error.keys], ['STORAGE_BUCKET']);
        }
        await missing.close();
      },
    );

    unitTest('a deployment key prefix keeps two deployments apart in one bucket', async () => {
      if (!storageTestConfigured()) return;
      // `cost-efficient-operation.md` forbids infrastructure that exists merely
      // to be available; a second bucket per deployment is exactly that when one
      // will do. This is what makes sharing one safe.
      const alpha = new S3ObjectStore({ ...describeFixture(fixture), keyPrefix: 'alpha/' });
      const beta = new S3ObjectStore({ ...describeFixture(fixture), keyPrefix: 'beta/' });
      try {
        const stored = await alpha.forTenant(TENANTS[0]!).put('knowledge_document', Buffer.from('a'), {
          contentType: PDF,
        });
        assert.equal((await beta.forTenant(TENANTS[0]!).list('knowledge_document')).length, 0);
        await assert.rejects(() => beta.forTenant(TENANTS[0]!).get(stored.ref), NotFoundError);

        // And one deployment's tenant sweep leaves the other's data alone.
        assert.equal(await beta.deleteTenant(TENANTS[0]!), 0);
        assert.equal((await alpha.forTenant(TENANTS[0]!).list('knowledge_document')).length, 1);
        assert.equal(await alpha.deleteTenant(TENANTS[0]!), 1);
      } finally {
        await alpha.close();
        await beta.close();
      }
    });

    unitTest('listing follows continuation tokens past the page size', async () => {
      if (!storageTestConfigured()) return;
      // The fixture pins the page size to 2, so 5 objects is three pages. A loop
      // that stopped at the first page would return 2 and look plausible.
      const tenant = fixture.store.forTenant(TENANTS[1]!);
      for (let index = 0; index < 5; index += 1) {
        await tenant.put('knowledge_document', Buffer.from(`page-${index}`), { contentType: PDF });
      }
      const listed = await tenant.list('knowledge_document');
      assert.equal(listed.length, 5);
      await fixture.store.deleteTenant(TENANTS[1]!);
    });

    specTest(
      'operator-health-monitoring.md',
      'the operator sees status and aggregate numbers only, and cannot open any client’s message content',
      'nothing the adapter logs contains document content or the storage credential',
      async () => {
        if (!storageTestConfigured()) return;
        // The needle must be one that cannot occur inside a fixture identifier —
        // IMPLEMENTATION_PLAN.md §4d records a redaction test that reported a
        // leak because a short numeric marker matched a UUID. This one is a
        // phrase.
        const marker = 'zeddev-canary-refund-policy-phrase';
        const sink = new MemorySink();
        const logged = new S3ObjectStore({
          ...describeFixture(fixture),
          logger: new Logger({ sink, level: 'debug' }),
        });
        try {
          const tenant = logged.forTenant(TENANTS[2]!);
          await tenant.put('knowledge_document', Buffer.from(marker), { contentType: PDF });
          await logged.deleteTenant(TENANTS[2]!);

          const serialised = sink.serialized();
          assert.ok(!serialised.includes(marker), 'document content must not reach a log');
          assert.ok(
            !serialised.includes(storageSecret()),
            'the storage credential must not reach a log',
          );
          // And the log still says enough to be operationally useful.
          assert.match(serialised, /storage\.tenant\.purged/);
        } finally {
          await logged.close();
        }
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Failure paths a real server will not produce on demand
// ---------------------------------------------------------------------------

function stubStore(transport: Transport, overrides: Record<string, unknown> = {}): S3ObjectStore {
  return new S3ObjectStore({
    host: 'storage.example.com',
    tls: true,
    bucket: 'zeddev',
    region: 'us-east-1',
    accessKeyId: 'stub-key-id',
    secretAccessKey: new Secret('stub-secret-value', 'stub'),
    transport,
    backoff: () => 0,
    ...overrides,
  });
}

function xml(body: string): Buffer {
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>${body}`, 'utf8');
}

function response(status: number, body: Buffer, headers: Record<string, string> = {}): TransportResponse {
  return { status, body, headers };
}

describe('transient failure handling', () => {
  specTest(
    'message-delivery-reliability.md',
    'given the system attempts to retrieve media, then it retries up to the defined retry allowance before treating the retrieval as failed',
    'a throttled request is retried and then succeeds',
    async () => {
      let attempts = 0;
      const store = stubStore(async () => {
        attempts += 1;
        if (attempts < 3) {
          return response(503, xml('<Error><Code>SlowDown</Code><Message>Reduce</Message></Error>'));
        }
        return response(200, Buffer.from('ok'), {
          'x-amz-meta-content-sha256':
            '2689367b205c16ce32ed4200942b8b8b1e262dfc70d9bc9fbc77c49699a4f1df',
        });
      }, { maxAttempts: 4 });

      const tenant = store.forTenant(TENANTS[0]!);
      const read = await tenant.get({
        tenantId: TENANTS[0]!,
        kind: 'inbound_media',
        id: 'a'.repeat(32),
      });
      assert.equal(read.body.toString(), 'ok');
      assert.equal(attempts, 3);
      await store.close();
    },
  );

  specTest(
    'message-delivery-reliability.md',
    'given a media retrieval fails after its retry allowance is exhausted, then the message is handled per the fallback behavior rather than left unprocessed',
    'the allowance is finite and the failure surfaces as retryable',
    async () => {
      let attempts = 0;
      const store = stubStore(async () => {
        attempts += 1;
        return response(503, xml('<Error><Code>SlowDown</Code></Error>'));
      }, { maxAttempts: 3 });

      await assert.rejects(
        () =>
          store
            .forTenant(TENANTS[0]!)
            .get({ tenantId: TENANTS[0]!, kind: 'inbound_media', id: 'a'.repeat(32) }),
        TransientTransportError,
      );
      assert.equal(attempts, 3, 'the allowance must be spent exactly once, not endlessly');
      await store.close();
    },
  );

  unitTest('a server-advised Retry-After is honoured over the computed backoff', async () => {
    const waits: number[] = [];
    let attempts = 0;
    const store = stubStore(async () => {
      attempts += 1;
      if (attempts === 1) {
        return response(503, xml('<Error><Code>SlowDown</Code></Error>'), { 'retry-after': '2' });
      }
      return response(200, Buffer.alloc(0), {});
    }, {
      maxAttempts: 2,
      clock: {
        now: () => new Date('2026-08-25T00:00:00Z'),
        monotonicMs: () => 0,
        async sleep(ms: number) {
          waits.push(ms);
        },
        setTimer: () => () => undefined,
      },
    });

    await store.forTenant(TENANTS[0]!).delete({
      tenantId: TENANTS[0]!,
      kind: 'inbound_media',
      id: 'a'.repeat(32),
    });
    assert.deepEqual(waits, [2000], 'a remote that says how long to wait knows better than we do');
    await store.close();
  });

  unitTest('a defect in the request we built is not retried', async () => {
    // A 400 means this client produced something the remote could not parse.
    // Retrying rediscovers that three more times and delays the report.
    let attempts = 0;
    const store = stubStore(async () => {
      attempts += 1;
      return response(400, xml('<Error><Code>MalformedXML</Code></Error>'));
    }, { maxAttempts: 4 });

    await assert.rejects(() => store.verifyAccess(), DefectError);
    assert.equal(attempts, 1);
    await store.close();
  });

  specTest(
    'business-knowledge-configuration.md',
    'when the client uploads a file that cannot be processed, then the system reports the failure rather than silently discarding it',
    'a body that does not match its recorded digest is reported rather than returned',
    async () => {
      // Corruption at rest, which a real server will not produce on request.
      const store = stubStore(async () =>
        response(200, Buffer.from('tampered'), {
          'x-amz-meta-content-sha256': 'f'.repeat(64),
        }),
      );
      await assert.rejects(
        () =>
          store
            .forTenant(TENANTS[0]!)
            .get({ tenantId: TENANTS[0]!, kind: 'knowledge_document', id: 'a'.repeat(32) }),
        (error: unknown) => error instanceof Error && /integrity check/i.test(error.message),
      );
      await store.close();
    },
  );
});

describe('response parsing', () => {
  unitTest('a listing page yields its keys and its continuation token', () => {
    const page = parseListPage(
      `<ListBucketResult><IsTruncated>true</IsTruncated>` +
        `<Contents><Key>a/b/c</Key><Size>12</Size><LastModified>2026-08-25T10:00:00.000Z</LastModified></Contents>` +
        `<Contents><Key>a/b/d</Key><Size>34</Size><LastModified>2026-08-25T11:00:00.000Z</LastModified></Contents>` +
        `<NextContinuationToken>tok/en+1=</NextContinuationToken></ListBucketResult>`,
    );
    assert.deepEqual(
      page.keys.map((entry) => entry.key),
      ['a/b/c', 'a/b/d'],
    );
    assert.equal(page.keys[0]!.sizeBytes, 12);
    assert.equal(page.nextContinuationToken, 'tok/en+1=');
  });

  unitTest('a complete page reports no continuation token', () => {
    const page = parseListPage(
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>k</Key><Size>1</Size></Contents></ListBucketResult>',
    );
    assert.equal(page.nextContinuationToken, undefined);
  });

  unitTest('a truncated page with no token is an error, not a short listing', () => {
    // Silently ending the loop here is a `deleteTenant` that reports success
    // while leaving objects behind.
    assert.throws(() =>
      parseListPage('<ListBucketResult><IsTruncated>true</IsTruncated></ListBucketResult>'),
    );
  });

  unitTest('entities in a key are decoded', () => {
    const page = parseListPage(
      '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>a&amp;b</Key><Size>0</Size></Contents></ListBucketResult>',
    );
    assert.equal(page.keys[0]!.key, 'a&b');
  });

  unitTest('an empty listing yields no keys rather than throwing', () => {
    assert.deepEqual(parseListPage('<ListBucketResult></ListBucketResult>').keys, []);
  });
});

describe('failure classification', () => {
  specTest(
    'operator-health-monitoring.md',
    'the operator sees status and aggregate numbers only, and cannot open any client’s message content',
    'the remote’s prose is dropped at this boundary, not further downstream',
    () => {
      // S3 quotes the key in its <Message>, and a key contains a tenant id.
      // Dropping it here rather than at the log call site is the §4c lesson:
      // downstream is where someone eventually logs it.
      const error = mapS3Failure(
        response(
          403,
          xml(
            '<Error><Code>AccessDenied</Code>' +
              '<Message>Access denied for key 11111111-1111-4111-8111-111111111111/knowledge_document/deadbeef</Message>' +
              '<Resource>/zeddev/11111111-1111-4111-8111-111111111111/knowledge_document/deadbeef</Resource></Error>',
          ),
        ),
        { operation: 'get', objectId: 'deadbeef' },
      );
      const serialised = JSON.stringify(error.toDiagnostic()) + error.message;
      assert.ok(!serialised.includes('11111111-1111-4111-8111-111111111111'));
      assert.ok(!serialised.includes('Access denied for key'));
    },
  );

  unitTest('retryability follows the class of failure, never the attempt count', () => {
    const cases: readonly [number, string, boolean][] = [
      [500, '', true],
      [502, '', true],
      [503, 'SlowDown', true],
      [429, '', true],
      [403, 'SignatureDoesNotMatch', false],
      [403, 'AccessDenied', false],
      [403, 'RequestTimeTooSkewed', false],
      [404, 'NoSuchKey', false],
      [400, 'MalformedXML', false],
      [409, 'BucketAlreadyOwnedByYou', false],
    ];
    for (const [status, code, retryable] of cases) {
      const body = code === '' ? Buffer.alloc(0) : xml(`<Error><Code>${code}</Code></Error>`);
      const error = mapS3Failure(response(status, body), { operation: 'get' });
      assert.equal(error.retryable, retryable, `${status} ${code} should be retryable=${retryable}`);
    }
  });

  unitTest('a rejected credential names both configuration keys that could be at fault', () => {
    const error = mapS3Failure(
      response(403, xml('<Error><Code>InvalidAccessKeyId</Code></Error>')),
      { operation: 'get' },
    );
    assert.ok(error instanceof ConfigurationError);
    assert.deepEqual(
      [...error.keys].sort(),
      ['STORAGE_ACCESS_KEY_ID', 'STORAGE_SECRET_ACCESS_KEY'],
    );
  });

  unitTest('a clock skew rejection is named as such rather than read as a bad key', () => {
    const error = mapS3Failure(
      response(403, xml('<Error><Code>RequestTimeTooSkewed</Code></Error>')),
      { operation: 'put' },
    );
    assert.equal(error.code, 'storage.request_time_too_skewed');
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function envValue(suffix: string): string {
  return process.env[`ZEDDEV_TEST_STORAGE_${suffix}`] ?? '';
}

function storageSecret(): string {
  return envValue('SECRET_ACCESS_KEY');
}

/** The fixture's connection settings, for building a second store against it. */
function describeFixture(fixture: TestBucket): {
  host: string;
  port?: number;
  tls: boolean;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: Secret<string>;
  listPageSize: number;
  maxAttempts: number;
} {
  const port = envValue('PORT');
  return {
    host: envValue('HOST'),
    ...(port === '' ? {} : { port: Number(port) }),
    tls: envValue('TLS') === 'true',
    bucket: fixture.bucket,
    region: envValue('REGION') || 'us-east-1',
    accessKeyId: envValue('ACCESS_KEY_ID'),
    secretAccessKey: new Secret(storageSecret(), 'test storage key'),
    listPageSize: 2,
    maxAttempts: 3,
  };
}

/** The real transport, used where a test needs to count attempts without faking them. */
const realTransport: Transport = async (request: TransportRequest) => {
  const { createTransport } = await import('./http.ts');
  const transport = createTransport({ maxSockets: 2 });
  try {
    return await transport(request);
  } finally {
    transport.close();
  }
};
