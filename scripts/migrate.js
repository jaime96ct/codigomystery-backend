import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import pg from 'pg';

const { Client } = pg;
const databaseUrl = process.env.DATABASE_URL || '';

if (!databaseUrl) {
  console.log('[migrate] DATABASE_URL not configured; skipping migrations');
  process.exit(0);
}

const migrationsDir = path.resolve('supabase/migrations');
const files = (await fs.readdir(migrationsDir))
  .filter((file) => file.endsWith('.sql'))
  .sort();

const client = new Client({
  connectionString: databaseUrl,
  ssl: { rejectUnauthorized: false },
});

try {
  await client.connect();

  for (const file of files) {
    const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
    console.log(`[migrate] Applying ${file}`);
    await client.query(sql);
  }

  console.log('[migrate] Migrations completed');
} catch (error) {
  console.error('[migrate] Migration failed:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
