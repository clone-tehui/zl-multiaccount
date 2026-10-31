import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDbClient } from './client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationsDir = path.join(__dirname, 'migrations');

export async function runMigrations({ db = createDbClient(), logger = console } = {}) {
  if (!db.enabled) {
    logger.log('[migrate] DATABASE_URL chưa cấu hình, bỏ qua migrations.');
    return { ok: false, skipped: true };
  }

  await db.query(`
    create table if not exists schema_migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = fs.readdirSync(migrationsDir).filter((item) => item.endsWith('.sql')).sort();
  const applied = await db.query('select filename from schema_migrations');
  const appliedSet = new Set((applied.rows || []).map((row) => row.filename));
  const executed = [];

  for (const file of files) {
    if (appliedSet.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await db.withTransaction(async (client) => {
      await client.query(sql);
      await client.query('insert into schema_migrations (filename) values ($1)', [file]);
    });
    executed.push(file);
    logger.log(`[migrate] applied ${file}`);
  }

  return { ok: true, applied: executed };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations().then((result) => {
    console.log(JSON.stringify(result));
    process.exit(0);
  }).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
