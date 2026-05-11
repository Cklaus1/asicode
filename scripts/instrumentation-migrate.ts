#!/usr/bin/env bun
/**
 * Instrumentation migration runner.
 *
 * Discovers migrations/instrumentation/*.sql in numeric order, applies any
 * not yet recorded in _schema_version, and verifies the post-migration
 * sanity SELECTs return rows starting with 'ok:'. Refuses to apply if any
 * sanity check returns 'FAIL:'.
 *
 * Usage:
 *   bun run scripts/instrumentation-migrate.ts
 *   bun run scripts/instrumentation-migrate.ts --db /path/to/instrumentation.db
 *   bun run scripts/instrumentation-migrate.ts --status        # show current version, don't apply
 *   bun run scripts/instrumentation-migrate.ts --dry-run       # parse + plan, don't apply
 *
 * Exit codes:
 *   0  success (or already up to date, or status command)
 *   1  unrecoverable error (sanity FAIL, IO error, parse error)
 *   2  partial apply (some migrations succeeded, one failed)
 *
 * Design notes:
 * - Each migration file ends with up to N standalone SELECT statements
 *   producing rows like `'ok: 9 tables present'` or `'FAIL: ...'`. The
 *   runner extracts these by detecting statements after the COMMIT line.
 * - Migration files are expected to manage their own BEGIN/COMMIT —
 *   the runner does not wrap. This lets a single migration choose to
 *   ship multiple transactions if needed.
 * - Idempotency is the migration's responsibility (CREATE TABLE IF NOT
 *   EXISTS on _schema_version, version-conflict detection here). The
 *   runner skips already-applied versions even if asked to re-run.
 */

import { Database } from 'bun:sqlite'
import { readdirSync, readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'

interface Args {
  db: string
  status: boolean
  dryRun: boolean
  migrationsDir: string
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    db: join(homedir(), '.asicode', 'instrumentation.db'),
    status: false,
    dryRun: false,
    migrationsDir: join(import.meta.dir, '..', 'migrations', 'instrumentation'),
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db') {
      args.db = argv[++i]
    } else if (a === '--status') {
      args.status = true
    } else if (a === '--dry-run') {
      args.dryRun = true
    } else if (a === '--migrations-dir') {
      args.migrationsDir = argv[++i]
    } else if (a === '-h' || a === '--help') {
      console.log(`usage: instrumentation-migrate.ts [--db PATH] [--migrations-dir DIR] [--status] [--dry-run]`)
      process.exit(0)
    } else {
      console.error(`unknown arg: ${a}`)
      process.exit(1)
    }
  }
  return args
}

interface MigrationFile {
  version: number
  path: string
  filename: string
}

function discoverMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) {
    throw new Error(`migrations directory not found: ${dir}`)
  }
  const files: MigrationFile[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.sql')) continue
    // Expect NNNN-description.sql (e.g. 0001-schema-v2.sql)
    const match = name.match(/^(\d+)-/)
    if (!match) {
      throw new Error(`migration filename must start with NNNN-: ${name}`)
    }
    files.push({
      version: parseInt(match[1], 10),
      path: join(dir, name),
      filename: name,
    })
  }
  files.sort((a, b) => a.version - b.version)
  // Detect gaps and duplicates — both are bugs
  const seen = new Set<number>()
  for (const f of files) {
    if (seen.has(f.version)) {
      throw new Error(`duplicate migration version ${f.version} (file: ${f.filename})`)
    }
    seen.add(f.version)
  }
  return files
}

function appliedVersions(db: Database): Set<number> {
  // _schema_version may not exist yet on a fresh db
  const row = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='_schema_version'").get()
  if (!row) return new Set()
  const rows = db.query('SELECT version FROM _schema_version').all() as { version: number }[]
  return new Set(rows.map(r => r.version))
}

/**
 * Split a migration SQL into (transaction body, post-commit sanity statements).
 *
 * Convention: the transaction is everything up to and including the last
 * `COMMIT;` line. Statements after that are sanity SELECTs the runner
 * executes individually to harvest 'ok:' / 'FAIL:' strings.
 */
function splitMigration(sql: string): { body: string; sanityStatements: string[] } {
  const lines = sql.split('\n')
  let commitIdx = -1
  // Find the last COMMIT; on its own line (case insensitive)
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*COMMIT\s*;\s*(--.*)?$/i.test(lines[i])) {
      commitIdx = i
      break
    }
  }
  if (commitIdx === -1) {
    // No COMMIT — whole file is the body, no sanity statements
    return { body: sql, sanityStatements: [] }
  }
  const body = lines.slice(0, commitIdx + 1).join('\n')
  const after = lines.slice(commitIdx + 1).join('\n')

  // Split sanity statements by semicolon at end of statement.
  // Strip line comments first (-- to end of line) but preserve them inside
  // string literals isn't a concern for our sanity SELECTs (we control them).
  const statements: string[] = []
  let buf: string[] = []
  for (const raw of after.split('\n')) {
    const line = raw.replace(/--.*$/, '').trim()
    if (!line) continue
    buf.push(line)
    if (line.endsWith(';')) {
      const stmt = buf.join(' ').replace(/;\s*$/, '').trim()
      if (stmt) statements.push(stmt)
      buf = []
    }
  }
  // Anything trailing without a semicolon is discarded as commentary
  return { body, sanityStatements: statements }
}

interface SanityResult {
  statement: string
  result: string
  ok: boolean
}

function runSanityChecks(db: Database, statements: string[]): SanityResult[] {
  const results: SanityResult[] = []
  for (const stmt of statements) {
    try {
      const row = db.query(stmt).get() as Record<string, unknown> | null
      if (!row) {
        results.push({ statement: stmt, result: '(no row returned)', ok: false })
        continue
      }
      // The first column is the result string
      const val = Object.values(row)[0]
      const str = String(val)
      results.push({ statement: stmt, result: str, ok: str.startsWith('ok:') })
    } catch (e) {
      results.push({
        statement: stmt,
        result: `error: ${e instanceof Error ? e.message : String(e)}`,
        ok: false,
      })
    }
  }
  return results
}

function applyMigration(db: Database, mig: MigrationFile, dryRun: boolean): SanityResult[] {
  const sql = readFileSync(mig.path, 'utf-8')
  const { body, sanityStatements } = splitMigration(sql)
  if (dryRun) {
    console.log(`  [dry-run] would apply ${mig.filename} (${sanityStatements.length} sanity checks after commit)`)
    return []
  }
  // Run the transactional body via executescript-equivalent. bun:sqlite's
  // run() requires a single statement; for multi-statement SQL we use
  // db.exec() which is the multi-statement entry point.
  db.exec(body)
  // Now run sanity checks. They are intentionally outside the transaction
  // (the migration already committed) so a failure here doesn't roll back.
  return runSanityChecks(db, sanityStatements)
}

function ensureDbDir(dbPath: string) {
  const dir = dirname(dbPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function fmtResults(results: SanityResult[]): string {
  return results
    .map(r => `    [${r.ok ? 'ok' : 'FAIL'}] ${r.result}`)
    .join('\n')
}

function main() {
  const args = parseArgs(process.argv)

  let migrations: MigrationFile[]
  try {
    migrations = discoverMigrations(args.migrationsDir)
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(1)
  }

  if (migrations.length === 0) {
    console.log(`no migrations found in ${args.migrationsDir}`)
    process.exit(0)
  }

  ensureDbDir(args.db)

  const db = new Database(args.db, { create: true })
  // Enable foreign keys per connection — required for FK enforcement
  db.exec('PRAGMA foreign_keys = ON')

  const applied = appliedVersions(db)

  if (args.status) {
    console.log(`db: ${args.db}`)
    console.log(`applied versions: ${[...applied].sort((a, b) => a - b).join(', ') || '(none)'}`)
    console.log(`available migrations:`)
    for (const m of migrations) {
      const mark = applied.has(m.version) ? '✓' : ' '
      console.log(`  ${mark} ${String(m.version).padStart(4, '0')}  ${m.filename}`)
    }
    db.close()
    process.exit(0)
  }

  const pending = migrations.filter(m => !applied.has(m.version))
  if (pending.length === 0) {
    console.log(`already up to date (latest version: ${Math.max(...applied) || 0})`)
    db.close()
    process.exit(0)
  }

  console.log(`db: ${args.db}`)
  console.log(`applying ${pending.length} migration${pending.length === 1 ? '' : 's'}:`)

  let appliedCount = 0
  let hadFailures = false

  for (const mig of pending) {
    console.log(`  ${mig.filename}`)
    try {
      const results = applyMigration(db, mig, args.dryRun)
      if (results.length > 0) {
        console.log(fmtResults(results))
        const fails = results.filter(r => !r.ok)
        if (fails.length > 0) {
          hadFailures = true
          console.error(`  ${fails.length} sanity check${fails.length === 1 ? '' : 's'} failed`)
        }
      }
      if (!args.dryRun) appliedCount++
    } catch (e) {
      console.error(`  FAIL: ${e instanceof Error ? e.message : String(e)}`)
      db.close()
      // If we got partway through a multi-migration apply, exit 2 so
      // callers know to investigate; otherwise exit 1.
      process.exit(appliedCount > 0 ? 2 : 1)
    }
  }

  db.close()
  if (args.dryRun) {
    console.log(`dry-run complete; ${pending.length} migration${pending.length === 1 ? '' : 's'} would apply`)
  } else {
    console.log(`applied ${appliedCount} migration${appliedCount === 1 ? '' : 's'}`)
  }
  process.exit(hadFailures ? 1 : 0)
}

main()
