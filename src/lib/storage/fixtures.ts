/**
 * Disposable buckets against a real S3-compatible server.
 *
 * There is no fake server in this package, for the reason `@zeddev/db`'s
 * `testing.ts` gives for having no fake PostgreSQL: the behavior under test *is*
 * the remote's. A hand-written fake S3 would have to implement SigV4 verification
 * in order to test SigV4 signing, and the test would then prove that this
 * package's understanding of the algorithm agrees with this package's
 * understanding of the algorithm. A wrong signature against a real server is a
 * 403; against a fake built from the same misunderstanding it is a 200.
 *
 * What *is* faked, in `s3.test.ts`, is the transport — but only for the responses
 * a real server will not produce on demand: a `SlowDown` burst, a body that fails
 * its checksum, a truncated listing. The division is deliberate. Anything a real
 * server will do is tested against a real server.
 *
 * Each fixture gets its own bucket so a failing test cannot leave state that
 * changes the next one's result, which is the same isolation `createTestDatabase`
 * gives the database suites.
 */

import { randomBytes } from 'node:crypto';
import { Secret } from '@zeddev/secrets';
import { S3ObjectStore, type S3ObjectStoreOptions } from './s3.ts';
import { parseListPage } from './s3wire.ts';

const PREFIX = 'ZEDDEV_TEST_STORAGE_';

function envValue(suffix: string): string | undefined {
  const raw = process.env[`${PREFIX}${suffix}`];
  return raw === undefined || raw.trim() === '' ? undefined : raw;
}

/** Whether an object storage endpoint is configured. Tests skip themselves when it is not. */
export function storageTestConfigured(): boolean {
  return envValue('HOST') !== undefined;
}

/**
 * The reason a test skipped, phrased so it tells the reader how to fix it.
 *
 * A skip message that says only "no object storage" trains people to ignore
 * skips. This one names the command and the variables.
 */
export const SKIP_REASON =
  'no test object storage configured — run `npm run storage:up` and it will write the ZEDDEV_TEST_STORAGE_* variables into .env.test (see AGENTS.md)';

export interface TestBucket {
  readonly bucket: string;
  readonly store: S3ObjectStore;
  drop(): Promise<void>;
}

/**
 * Create a bucket and a store pointed at it.
 *
 * `listPageSize` defaults to 2 rather than the protocol's 1000, so every listing
 * in the conformance suite crosses at least one continuation-token boundary. A
 * pagination loop that is only ever exercised below the page size is a loop that
 * is not exercised at all, and the thing it would break — `deleteTenant`
 * stopping short — is the one `client-offboarding-and-data-retention.md` calls
 * irreversible.
 */
export async function createTestBucket(
  label: string,
  overrides: Partial<S3ObjectStoreOptions> = {},
): Promise<TestBucket> {
  const host = envValue('HOST');
  if (host === undefined) throw new Error(SKIP_REASON);

  const suffix = randomBytes(4).toString('hex');
  const bucket = `t-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 20)}-${suffix}`;

  const port = envValue('PORT');
  const store = new S3ObjectStore({
    host,
    ...(port === undefined ? {} : { port: Number(port) }),
    tls: envValue('TLS') === 'true',
    bucket,
    region: envValue('REGION') ?? 'us-east-1',
    accessKeyId: envValue('ACCESS_KEY_ID') ?? '',
    secretAccessKey: new Secret(envValue('SECRET_ACCESS_KEY') ?? '', 'test storage key'),
    addressingStyle: 'path',
    listPageSize: 2,
    // A short curve: these tests should surface a real failure quickly rather
    // than spending the default allowance rediscovering that the container is
    // not running.
    maxAttempts: 3,
    requestTimeoutMs: 10_000,
    ...overrides,
  });

  await store.ensureBucket();

  return {
    bucket,
    store,
    async drop(): Promise<void> {
      // Buckets must be empty to be removed, and a leftover bucket per test
      // would accumulate across runs in a container that outlives them.
      //
      // The sweep is written here rather than exposed on `S3ObjectStore` on
      // purpose: "delete every key regardless of who owns it" is precisely the
      // operation `deleteTenant` refuses to be, and putting it on the production
      // class would make it reachable from a service.
      for (;;) {
        const response = await store.request({
          method: 'GET',
          query: [
            ['list-type', '2'],
            ['max-keys', '1000'],
          ],
          operation: 'drop_list',
        });
        const page = parseListPage(response.body.toString('utf8'));
        for (const listed of page.keys) {
          await store.request({
            method: 'DELETE',
            key: listed.key,
            operation: 'drop_object',
            tolerate: [404],
          });
        }
        if (page.nextContinuationToken === undefined) break;
      }
      await store.request({ method: 'DELETE', operation: 'drop_bucket', tolerate: [404, 409] });
      await store.close();
    },
  };
}
