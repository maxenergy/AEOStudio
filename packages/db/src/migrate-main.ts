import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { runMigrations } from './migrations.js';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error('DATABASE_URL_REQUIRED_FOR_MIGRATION');
  }
  const rawPoolMax = process.env.MIGRATION_DATABASE_POOL_MAX;
  if (rawPoolMax === undefined || !/^[1-9][0-9]*$/u.test(rawPoolMax)) {
    throw new Error('MIGRATION_DATABASE_POOL_MAX_INVALID');
  }
  const poolMax = Number(rawPoolMax);
  if (!Number.isSafeInteger(poolMax) || poolMax > 64) {
    throw new Error('MIGRATION_DATABASE_POOL_MAX_INVALID');
  }

  const pool = new Pool({ connectionString: databaseUrl, max: poolMax });
  try {
    const migrationsDirectory = fileURLToPath(new URL('../migrations', import.meta.url));
    await runMigrations(pool, migrationsDirectory);
  } finally {
    await pool.end();
  }
}

try {
  await main();
} catch {
  process.stderr.write('DATABASE_MIGRATION_FAILED\n');
  process.exitCode = 1;
}
