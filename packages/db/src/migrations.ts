import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from 'pg';

interface AppliedMigrationRow {
  checksum: string;
}

export async function runMigrations(pool: Pool, directory: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('aeostudio-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await readdir(directory))
      .filter((file) => /^\d+_[a-z0-9_]+\.sql$/i.test(file))
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      const checksum = createHash('sha256').update(sql, 'utf8').digest('hex');
      const applied = await client.query<AppliedMigrationRow>(
        'SELECT checksum FROM schema_migrations WHERE id = $1',
        [file],
      );
      const row = applied.rows[0];
      if (row !== undefined) {
        if (row.checksum !== checksum) {
          throw new Error(`MIGRATION_CHECKSUM_MISMATCH:${file}`);
        }
        continue;
      }

      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (id, checksum) VALUES ($1, $2)', [
        file,
        checksum,
      ]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
