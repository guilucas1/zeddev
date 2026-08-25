/**
 * Migration runner.
 *
 * Four properties, each answering a specific way schema migration goes wrong on a
 * platform that has to run identically on a laptop, a VPS, and a managed cloud.
 *
 *  1. **Atomic per migration.** PostgreSQL has transactional DDL, so a migration
 *     and the row recording it commit together. A migration cannot be
 *     half-applied, and there is no state where the ledger disagrees with the
 *     schema. This is what makes it safe to just re-run the runner after any
 *     failure, on any tier, without first inspecting what happened.
 *  2. **Checksummed.** The ledger stores a hash of each applied file. Editing an
 *     already-applied migration is then an error rather than a silent divergence
 *     between two deployments that both believe they are up to date. Under
 *     `environment-portability.md` AC4, the same source must produce the same
 *     system on every tier; two databases at "migration 7" whose migration 7
 *     differed would break that in a way nothing else would reveal.
 *  3. **Advisory-locked.** `component-independence.md` requires each component be
 *     independently deployable, which in practice means several instances of a
 *     service can start at the same moment during a rolling deploy. Without a
 *     lock they race, and the loser fails on a table that already exists. A
 *     session-level advisory lock makes the second starter wait and then find
 *     nothing to do.
 *  4. **Forward only.** There is no `down`. A rollback script is written when the
 *     schema is understood and executed when it is not, and it is routinely
 *     wrong; worse, "roll back the migration" on a table holding tenant data
 *     means deleting columns that hold that data. Recovering from a bad
 *     migration is a new forward migration.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConfigurationError, DefectError } from '@zeddev/errors';
import type { Logger } from '@zeddev/logging';
import type { Connection } from './connection.ts';
import type { Pool } from './pool.ts';

/**
 * Arbitrary but fixed key identifying this platform's schema lock.
 *
 * Advisory locks share one namespace per database, so the value only has to be
 * stable and unlikely to collide with anything else using the same database.
 */
const MIGRATION_LOCK_KEY = 8_531_207;

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

function checksum(sql: string): string {
  // Line endings are normalised before hashing. A checkout on Windows with
  // `core.autocrlf` on rewrites every file's line endings, and a checksum that
  // changed because of that would report every migration as tampered with on
  // exactly one developer's machine — a difference between environments that has
  // nothing to do with configuration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/**
 * Load migrations from a directory.
 *
 * Filenames must be `NNNN_snake_case_name.sql`. The numeric prefix is the version
 * and it must be unique and gapless from 1. Gaplessness is checked because a gap
 * almost always means two branches each added a migration, one of them was merged
 * without renumbering, and the deployments that already applied the other are now
 * permanently divergent.
 */
export async function loadMigrations(directory: string): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (cause) {
    throw new ConfigurationError(
      [{ key: 'migrationsDirectory', reason: `could not read "${directory}"` }],
      { cause },
    );
  }

  const migrations: Migration[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.sql')) continue;
    const match = FILENAME_PATTERN.exec(entry);
    if (match === null) {
      throw new ConfigurationError([
        {
          key: entry,
          reason: 'migration filenames must match NNNN_snake_case_name.sql',
        },
      ]);
    }
    const sql = await readFile(join(directory, entry), 'utf8');
    migrations.push({
      version: Number(match[1]),
      name: match[2]!,
      sql,
      checksum: checksum(sql),
    });
  }

  migrations.sort((a, b) => a.version - b.version);
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new ConfigurationError([
        {
          key: `${String(migration.version).padStart(4, '0')}_${migration.name}.sql`,
          reason: `migration versions must be gapless from 1; expected version ${index + 1}`,
        },
      ]);
    }
  });

  return migrations;
}

/**
 * The ledger table.
 *
 * Created outside the per-migration transaction and idempotently, because it has
 * to exist before the runner can ask what has been applied. It is not itself a
 * migration for the same reason.
 */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     integer      PRIMARY KEY,
  name        text         NOT NULL,
  checksum    text         NOT NULL,
  applied_at  timestamptz  NOT NULL DEFAULT now()
);
`;

export async function appliedMigrations(connection: Connection): Promise<AppliedMigration[]> {
  await connection.simpleQuery(LEDGER_DDL);
  const result = await connection.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
}

export interface MigrateResult {
  readonly applied: readonly Migration[];
  readonly alreadyApplied: number;
}

/**
 * Apply every pending migration.
 *
 * Runs on a single connection held for the whole operation, because the advisory
 * lock is session-scoped: taking it on one pooled connection and running the
 * migrations on another would leave the migrations unprotected.
 */
export async function migrate(
  pool: Pool,
  migrations: readonly Migration[],
  options: { readonly logger?: Logger | undefined } = {},
): Promise<MigrateResult> {
  const logger = options.logger;
  return pool.withConnection(async (connection) => {
    await connection.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const already = await appliedMigrations(connection);
      const byVersion = new Map(already.map((entry) => [entry.version, entry]));

      for (const migration of migrations) {
        const applied = byVersion.get(migration.version);
        if (applied === undefined) continue;
        if (applied.checksum !== migration.checksum) {
          throw new DefectError(
            `Migration ${migration.version} has changed since it was applied`,
            {
              code: 'db.migration_checksum_mismatch',
              context: { version: migration.version, name: migration.name },
            },
          );
        }
      }

      const pending = migrations.filter((migration) => !byVersion.has(migration.version));

      for (const migration of pending) {
        // BEGIN/COMMIT are issued explicitly rather than via `pool.transaction`
        // so that the DDL and its ledger row share one transaction on the same
        // connection that holds the advisory lock.
        await connection.query('BEGIN');
        try {
          await connection.simpleQuery(migration.sql);
          await connection.query(
            'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
            [migration.version, migration.name, migration.checksum],
          );
          await connection.query('COMMIT');
        } catch (error) {
          try {
            await connection.query('ROLLBACK');
          } catch {
            // Preserve the migration's own failure.
          }
          throw error;
        }
        logger?.info('db.migration_applied', { version: migration.version, count: pending.length });
      }

      return { applied: pending, alreadyApplied: already.length };
    } finally {
      // Released even when a migration failed. Holding a session-level advisory
      // lock past a crash would block every subsequent deploy until the backend
      // was killed by hand — the "undocumented, tribal-knowledge step"
      // `environment-portability.md` rules out.
      await connection.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    }
  });
}

/**
 * Report pending migrations without applying any.
 *
 * A service that is not the migration owner should refuse to start against a
 * schema older than the one it was written for, rather than failing later on a
 * missing column. `component-independence.md` allows components to be deployed
 * separately, which means a version skew between a service and the schema is a
 * normal occurrence, not an exceptional one.
 */
export async function pendingMigrations(
  pool: Pool,
  migrations: readonly Migration[],
): Promise<Migration[]> {
  return pool.withConnection(async (connection) => {
    const already = await appliedMigrations(connection);
    const versions = new Set(already.map((entry) => entry.version));
    return migrations.filter((migration) => !versions.has(migration.version));
  });
}
