import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';

/**
 * Applies prisma/migrations/0001_init/migration.sql exactly once, tracked via
 * a dedicated _schema_migrations table — so a brand-new Railway Postgres
 * database initializes itself on first boot, but every subsequent restart
 * (redeploy, crash-restart, scale event) is a safe no-op that never re-runs
 * DDL or touches existing data.
 *
 * This does NOT run prisma/seed.ts — seeding demo users/passwords is a
 * separate, explicit, developer-invoked step (`npm run seed`), never
 * automatic, so a production database is never accidentally populated with
 * development credentials.
 */
export async function ensureMigrated(): Promise<void> {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS _schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);

    const { rows } = await pool.query(`SELECT name FROM _schema_migrations WHERE name = '0001_init'`);
    if (rows.length > 0) {
      console.log('[migrate] Schema already initialized (0001_init) — skipping.');
      return;
    }

    // Also treat "products table already exists" as already-migrated, in
    // case the database was set up manually before this tracker existed —
    // never re-run DDL against a database that already has real tables/data.
    const existing = await pool.query(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'products'`
    );
    if (existing.rows.length > 0) {
      console.log('[migrate] Tables already present but untracked — recording 0001_init as applied without re-running DDL.');
      await pool.query(`INSERT INTO _schema_migrations (name) VALUES ('0001_init') ON CONFLICT DO NOTHING`);
      return;
    }

    console.log('[migrate] Fresh database detected — applying 0001_init...');
    const sqlPath = path.join(__dirname, '../../prisma/migrations/0001_init/migration.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    await pool.query(sql);
    await pool.query(`INSERT INTO _schema_migrations (name) VALUES ('0001_init')`);
    console.log('[migrate] 0001_init applied successfully.');
  } catch (err) {
    console.error('[migrate] Database migration failed:', err instanceof Error ? err.message : err);
    console.error('[migrate] → Verify DATABASE_URL points to a reachable, empty (or already-migrated) PostgreSQL database.');
    throw err;
  } finally {
    await pool.end();
  }
}
