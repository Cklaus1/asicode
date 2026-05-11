/**
 * Test-only helpers. NOT imported by production code.
 *
 * applyAllMigrations(dbPath) replaces every test's local applyMigration
 * helper that knew about only 0001. With migration 0002 (and any future
 * ones) the right approach is "apply everything in order" — which is
 * what the production migration runner script does. This helper is the
 * test-side equivalent.
 *
 * Refactor of iter 42: pulled out as a shared module after iter 42's
 * 0002 migration broke every test that hard-coded the 0001 path.
 */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', '..', 'migrations', 'instrumentation')

/**
 * Apply every migration in migrations/instrumentation/, in numeric order,
 * to a fresh db. Idempotent — running twice produces the same schema
 * state, since each migration creates its own _schema_version row that
 * later runs check before re-applying.
 */
export function applyAllMigrations(dbPath: string): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()
  if (files.length === 0) {
    throw new Error(`no migrations found in ${MIGRATIONS_DIR}`)
  }
  const db = new Database(dbPath, { create: true })
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf-8')
    db.exec(sql)
  }
  db.close()
}
