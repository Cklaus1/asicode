/**
 * Filesystem store for outcome records.
 *
 * Layout: <outcomesRoot>/<fingerprint>/<taskId>.json
 * where <outcomesRoot> defaults to `<claudeConfigHomeDir>/outcomes` so the
 * data lives alongside other per-user state (sessions, teams, plugins, etc).
 * Tests can override via setOutcomesRootForTest().
 *
 * Writes are atomic (write to .tmp, fs.rename) so a crash mid-write can't
 * leave a half-flushed JSON blob behind.
 */

import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  OutcomeRecordSchema,
  type OutcomeRecord,
} from './outcomeRecord.js'

let outcomesRootOverride: string | undefined

/** Test-only: override the on-disk root. Pass undefined to reset. */
export function setOutcomesRootForTest(root: string | undefined): void {
  outcomesRootOverride = root
}

export function getOutcomesRoot(): string {
  return outcomesRootOverride ?? join(getClaudeConfigHomeDir(), 'outcomes')
}

function recordPath(fingerprint: string, taskId: string): string {
  return join(getOutcomesRoot(), fingerprint, `${taskId}.json`)
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/**
 * Atomic write — write to a sibling .tmp file, then rename. Avoids torn
 * reads if a concurrent retrieval lands mid-write.
 */
export async function writeOutcomeRecord(record: OutcomeRecord): Promise<void> {
  const parsed = OutcomeRecordSchema.parse(record)
  const dir = join(getOutcomesRoot(), parsed.fingerprint)
  await ensureDir(dir)
  const target = join(dir, `${parsed.taskId}.json`)
  const tmp = join(dir, `.${parsed.taskId}.${randomUUID().slice(0, 8)}.tmp`)
  const json = JSON.stringify(parsed, null, 2)
  await fs.writeFile(tmp, json, 'utf8')
  try {
    await fs.rename(tmp, target)
  } catch (err) {
    // Best-effort cleanup of the temp file if the rename failed
    try {
      await fs.unlink(tmp)
    } catch {
      /* ignore */
    }
    throw err
  }
}

export async function readOutcomeRecord(
  fingerprint: string,
  taskId: string,
): Promise<OutcomeRecord | undefined> {
  try {
    const raw = await fs.readFile(recordPath(fingerprint, taskId), 'utf8')
    const parsed = OutcomeRecordSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** List all records for a single fingerprint. Skips malformed files. */
export async function listOutcomesForFingerprint(
  fingerprint: string,
): Promise<OutcomeRecord[]> {
  const dir = join(getOutcomesRoot(), fingerprint)
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: OutcomeRecord[] = []
  for (const name of entries) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue
    try {
      const raw = await fs.readFile(join(dir, name), 'utf8')
      const parsed = OutcomeRecordSchema.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    } catch {
      /* skip unreadable / malformed files */
    }
  }
  return out
}

/**
 * List ALL records across every fingerprint. Used as a fallback when the
 * direct fingerprint lookup returns too few results. Reads are bounded —
 * we sort by mtime descending and stop after `maxRecords` to keep this
 * O(recent) rather than O(history).
 */
export async function listAllOutcomes(
  maxRecords = 200,
): Promise<OutcomeRecord[]> {
  const root = getOutcomesRoot()
  let fingerprints: string[]
  try {
    fingerprints = await fs.readdir(root)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }

  type Candidate = { path: string; mtimeMs: number }
  const candidates: Candidate[] = []
  for (const fp of fingerprints) {
    const dir = join(root, fp)
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue
      const path = join(dir, name)
      try {
        const stat = await fs.stat(path)
        candidates.push({ path, mtimeMs: stat.mtimeMs })
      } catch {
        /* skip */
      }
    }
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)
  const out: OutcomeRecord[] = []
  for (const c of candidates.slice(0, maxRecords)) {
    try {
      const raw = await fs.readFile(c.path, 'utf8')
      const parsed = OutcomeRecordSchema.safeParse(JSON.parse(raw))
      if (parsed.success) out.push(parsed.data)
    } catch {
      /* skip */
    }
  }
  return out
}
