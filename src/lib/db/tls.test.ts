/**
 * The database client's TLS modes, against a real server that speaks TLS.
 *
 * A managed cloud database is reached with `DATABASE_SSL_MODE=verify-full`, often
 * under a provider's private authority (`DATABASE_CA_CERTIFICATE`). Until the test
 * server spoke TLS, that path was code no test had ever run: the laptop and VPS
 * tiers use `disable` on a container network, so the one tier whose transport
 * differs was the one with no evidence (`environment-portability.md` AC3).
 *
 * `scripts/db.sh` gives the server a certificate naming `localhost`, signed by an
 * authority it generates. Connecting by `127.0.0.1` is therefore a name the
 * certificate does not carry, which is what tells verify-full from verify-ca.
 */

import assert from 'node:assert/strict';
import { after, before, describe } from 'node:test';
import { ConfigurationError } from '@zeddev/errors';
import { specTest, unitTest } from '@zeddev/testing';
import { Connection, tlsFailureIssue, type ConnectionOptions } from './connection.ts';
import { createPool, loadDatabaseConfig } from './index.ts';
import { createTestDatabase, SKIP_REASON, testDatabaseConfigured, testDatabaseTls, type TestDatabase } from './testing.ts';

describe('database transport security', { skip: testDatabaseConfigured() ? false : SKIP_REASON }, () => {
  let db: TestDatabase;
  let tls: ReturnType<typeof testDatabaseTls>;

  before(async () => {
    tls = testDatabaseTls();
    db = await createTestDatabase('tls');
  });

  after(async () => {
    await db?.drop();
  });

  /** Whether the session the options open is encrypted, by the server's own account. */
  async function encrypted(options: Partial<ConnectionOptions>): Promise<boolean> {
    const connection = new Connection({ ...db.options, ...options });
    await connection.connect();
    try {
      const result = await connection.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
      return result.rows[0]!.ssl;
    } finally {
      await connection.close();
    }
  }

  async function refusal(options: Partial<ConnectionOptions>): Promise<{ key: string; reason: string }> {
    let caught: unknown;
    try {
      await encrypted(options);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof ConfigurationError, `expected a configuration error, got ${String(caught)}`);
    assert.equal(caught.issues.length, 1);
    return caught.issues[0]!;
  }

  specTest(
    'environment-portability.md',
    'AC3 the system becomes fully functional on a managed cloud provider from configuration alone',
    'verify-full under a private authority connects encrypted, through the same configuration keys a deployment sets',
    async () => {
      const config = loadDatabaseConfig({
        DATABASE_HOST: tls.host,
        DATABASE_PORT: String(db.options.port),
        DATABASE_NAME: db.options.database,
        DATABASE_USER: db.options.user,
        DATABASE_PASSWORD: db.options.password?.expose() ?? '',
        DATABASE_SSL_MODE: 'verify-full',
        DATABASE_CA_CERTIFICATE: tls.caCertificate,
      });
      const pool = createPool(config, { applicationName: 'zeddev-tls-test' });
      try {
        const ssl = await pool.withConnection(async (connection) =>
          (await connection.query<{ ssl: boolean }>('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0]!.ssl,
        );
        assert.equal(ssl, true);
      } finally {
        await pool.end();
      }
    },
  );

  unitTest('require and prefer encrypt when the server offers TLS, and disable does not', async () => {
    assert.equal(await encrypted({ sslMode: 'require' }), true);
    assert.equal(await encrypted({ sslMode: 'prefer' }), true);
    assert.equal(await encrypted({ sslMode: 'disable' }), false);
  });

  unitTest('verify-ca checks the authority but not the name, so it accepts an address the certificate does not carry', async () => {
    assert.notEqual(db.options.host, tls.host, 'the fixture must connect by a name the certificate lacks');
    assert.equal(await encrypted({ sslMode: 'verify-ca', caCertificate: tls.caCertificate }), true);
  });

  specTest(
    'environment-portability.md',
    'AC7 startup fails with a clear error identifying the invalid configuration',
    'a certificate naming another host is refused under verify-full, and the error names DATABASE_HOST',
    async () => {
      const issue = await refusal({ sslMode: 'verify-full', caCertificate: tls.caCertificate });
      assert.equal(issue.key, 'DATABASE_HOST');
      assert.match(issue.reason, /does not name "127\.0\.0\.1"/);
      assert.match(issue.reason, /verify-ca/);
    },
  );

  specTest(
    'environment-portability.md',
    'AC7 startup fails with a clear error identifying the invalid configuration',
    'a server signed by an authority nobody configured is refused, and the error names DATABASE_CA_CERTIFICATE',
    async () => {
      for (const sslMode of ['verify-ca', 'verify-full'] as const) {
        const issue = await refusal({ host: tls.host, sslMode });
        assert.equal(issue.key, 'DATABASE_CA_CERTIFICATE', sslMode);
        assert.match(issue.reason, /not signed by a trusted authority/);
      }
    },
  );
});

unitTest('a handshake failure Node gives no known code for still names its identifier, never a certificate', () => {
  assert.deepEqual(tlsFailureIssue(Object.assign(new Error('boom'), { code: 'ERR_SSL_WRONG_VERSION_NUMBER' }), 'require', 'db'), {
    key: 'DATABASE_SSL_MODE',
    reason: 'TLS handshake failed (ERR_SSL_WRONG_VERSION_NUMBER)',
  });
  assert.equal(tlsFailureIssue(new TypeError('no code'), 'require', 'db').reason, 'TLS handshake failed (TypeError)');
});
