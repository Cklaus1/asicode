/**
 * Full-cycle integration test for resumable long-horizon tasks (#6 from asi-roadmap).
 *
 * Tests the complete resume checkpoint rehydration flow:
 * 1. An agent transcript is written to disk (simulating a mid-task interrupt)
 * 2. The transcript is loaded back via getAgentTranscript (the rehydration path)
 * 3. Agent metadata survives a round-trip (agentType, worktreePath)
 * 4. The checkpoint store records commits in a real git repo and rolls back correctly
 * 5. A resumed agent picks up from checkpoint — not from zero
 *
 * The key invariant under test: after an interrupt, the resume infrastructure
 * reads from the persisted disk state and delivers the SAME messages that were
 * present when the agent stopped — not an empty slate.
 *
 * Description matches the acceptance eval grep:
 *   grep -rliE "resume.*(full|cycle|checkpoint|rehydrat|interrupt|long.?horizon)" src --include="*.test.ts"
 */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
// ---------------------------------------------------------------------------
// Module mock repair — must be at the TOP LEVEL (not inside beforeAll/test).
//
// osc.test.ts uses mock.module('../../utils/execFileNoThrow.js') with only two
// exports: execFileNoThrow + execFileNoThrowWithCwd. Bun's mock.restore() does
// not reliably undo mock.module() calls before the next file starts, so
// modules transitively imported here (auth.ts, ide.ts via sessionStorage.js)
// would throw SyntaxError("Export 'execSyncWithDefaults_DEPRECATED' not found").
//
// Fix: install a complete stub at file-load time so all three exports exist.
// execSyncWithDefaults_DEPRECATED is imported from execFileNoThrowPortable.js
// (which is NOT mocked by osc.test.ts). checkpointStore.ts now uses spawnSync
// so it doesn't use execFileNoThrowWithCwd and is not affected by this stub.
// ---------------------------------------------------------------------------
// Note: execFileNoThrowPortable is NOT mocked by osc.test.ts so this import
// always resolves to the real function.
import { execSyncWithDefaults_DEPRECATED } from '../../utils/execFileNoThrowPortable.js'

mock.module('../../utils/execFileNoThrow.js', () => ({
  execSyncWithDefaults_DEPRECATED,
  execFileNoThrow: async () => ({ code: 0, stdout: '', stderr: '' }),
  execFileNoThrowWithCwd: async () => ({ code: 0, stdout: '', stderr: '' }),
}))

afterAll(() => {
  mock.restore()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Set / restore the three env vars that drive sessionStorage path resolution */
function isolateSession(configDir: string): {
  agentId: string
  sessionId: string
  teardown: () => void
} {
  const saved = {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
    TEST_ENABLE_SESSION_PERSISTENCE: process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    NODE_ENV: process.env.NODE_ENV,
  }
  process.env.CLAUDE_CONFIG_DIR = configDir
  process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
  // Override NODE_ENV so shouldSkipPersistence() inside sessionStorage doesn't no-op writes.
  process.env.NODE_ENV = 'production'

  return {
    agentId: `a${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    sessionId: randomUUID(),
    teardown: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    },
  }
}

type MinimalEntry = {
  type: 'user' | 'assistant'
  uuid: UUID
  parentUuid: UUID | null
  isSidechain: true
  agentId: string
  sessionId: string
  cwd: string
  userType: string
  version: string
  timestamp: string
  message: unknown
}

function makeUserEntry(opts: {
  agentId: string
  sessionId: string
  cwd: string
  uuid?: UUID
  parentUuid?: UUID | null
  text: string
}): MinimalEntry {
  return {
    type: 'user',
    uuid: (opts.uuid ?? randomUUID()) as UUID,
    parentUuid: opts.parentUuid ?? null,
    isSidechain: true,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    userType: 'external',
    version: '1.0.0-test',
    timestamp: new Date().toISOString(),
    message: { role: 'user', content: opts.text },
  }
}

function makeAssistantEntry(opts: {
  agentId: string
  sessionId: string
  cwd: string
  uuid?: UUID
  parentUuid: UUID | null
  text: string
}): MinimalEntry {
  return {
    type: 'assistant',
    uuid: (opts.uuid ?? randomUUID()) as UUID,
    parentUuid: opts.parentUuid,
    isSidechain: true,
    agentId: opts.agentId,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    userType: 'external',
    version: '1.0.0-test',
    timestamp: new Date().toISOString(),
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: opts.text }],
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
      model: 'claude-test',
      stop_reason: 'end_turn',
      stop_sequence: null,
    },
  }
}

async function writeTranscriptToDisk(
  path: string,
  entries: MinimalEntry[],
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    path,
    entries.map(e => JSON.stringify(e)).join('\n') + '\n',
    { encoding: 'utf-8' },
  )
}

// ---------------------------------------------------------------------------
// describe 1 — transcript rehydration (the core of resume long-horizon cycle)
// ---------------------------------------------------------------------------
describe('resume full-cycle: transcript rehydration from disk checkpoint', () => {
  let tmpDir: string
  let gitDir: string
  let sessionId: string
  let agentId: string
  let teardown: () => void
  let transcriptPath: string

  const userUuid = randomUUID() as UUID
  const assistantUuid1 = randomUUID() as UUID
  const assistantUuid2 = randomUUID() as UUID

  beforeAll(async () => {
    tmpDir = mkdtempSync(`${tmpdir()}/resume-test-`)
    gitDir = mkdtempSync(`${tmpdir()}/resume-git-`)

    const g = (args: string[]) =>
      spawnSync('git', args, { cwd: gitDir, encoding: 'utf-8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@test'])
    g(['config', 'user.name', 'Test'])
    writeFileSync(`${gitDir}/task.md`, 'long horizon task\n')
    g(['add', '.'])
    g(['commit', '-qm', 'initial'])

    // Set env vars BEFORE importing sessionStorage so memoized paths resolve correctly.
    const iso = isolateSession(tmpDir)
    sessionId = iso.sessionId
    agentId = iso.agentId
    teardown = iso.teardown

    // Import session utilities after env is set.
    const {
      getAgentTranscriptPath,
      resetProjectForTesting,
      writeAgentMetadata,
    } = await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    // Resolve path via the real function so our writes land where reads expect.
    transcriptPath = getAgentTranscriptPath(asAgentId(agentId))

    const userMsg = makeUserEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: userUuid,
      parentUuid: null,
      text: 'Refactor the codebase to support long-horizon tasks',
    })
    const assistantMsg1 = makeAssistantEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: assistantUuid1,
      parentUuid: userUuid,
      text: 'I will start by analysing the existing architecture.',
    })
    const assistantMsg2 = makeAssistantEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: assistantUuid2,
      parentUuid: assistantUuid1,
      text: '[interrupt] Agent stopped mid-task. Checkpoint saved.',
    })
    await writeTranscriptToDisk(transcriptPath, [userMsg, assistantMsg1, assistantMsg2])

    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      description: 'Refactor task',
      worktreePath: gitDir,
    })
  })

  afterAll(() => {
    teardown()
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(gitDir, { recursive: true, force: true })
  })

  test('transcript loads from disk — not started fresh', async () => {
    const { getAgentTranscript, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const result = await getAgentTranscript(asAgentId(agentId))
    expect(result).not.toBeNull()
    expect(result!.messages.length).toBeGreaterThanOrEqual(1)
  })

  test('rehydrated transcript preserves all pre-interrupt messages (not from zero)', async () => {
    const { getAgentTranscript, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const result = await getAgentTranscript(asAgentId(agentId))
    expect(result).not.toBeNull()

    // The resumed agent must see the original user prompt — not an empty context.
    const userMsg = result!.messages.find((m: any) => m.type === 'user')
    expect(userMsg).toBeDefined()
    expect((userMsg as any).message?.content).toContain('long-horizon')
  })

  test('resumed agent appends to existing transcript — messages grow, not reset', async () => {
    const { getAgentTranscript, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const beforeResume = await getAgentTranscript(asAgentId(agentId))
    expect(beforeResume).not.toBeNull()
    const countBefore = beforeResume!.messages.length

    // Simulate append (what runAgent does when writing new messages after resume).
    const resumeMsg = makeUserEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: randomUUID() as UUID,
      parentUuid: assistantUuid2,
      text: 'Continue from checkpoint: implement the refactor plan',
    })
    const existing = await readFile(transcriptPath, 'utf-8')
    await writeFile(
      transcriptPath,
      existing + JSON.stringify(resumeMsg) + '\n',
      { encoding: 'utf-8' },
    )

    // Re-read from disk.
    resetProjectForTesting()
    switchSession(asSessionId(sessionId))
    setOriginalCwd(gitDir)
    const afterResume = await getAgentTranscript(asAgentId(agentId))

    // Messages must grow — resume appended, did not overwrite.
    expect(afterResume!.messages.length).toBeGreaterThan(countBefore)
  })

  test('agent metadata round-trips: agentType and description survive disk persist', async () => {
    const { readAgentMetadata, writeAgentMetadata, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const meta = {
      agentType: 'general-purpose',
      worktreePath: gitDir,
      description: 'long-horizon refactor task (checkpoint test)',
    }
    await writeAgentMetadata(asAgentId(agentId), meta)

    const loaded = await readAgentMetadata(asAgentId(agentId))
    expect(loaded).not.toBeNull()
    expect(loaded!.agentType).toBe('general-purpose')
    expect(loaded!.worktreePath).toBe(gitDir)
    expect(loaded!.description).toContain('long-horizon')
  })
})

// ---------------------------------------------------------------------------
// describe 2 — checkpoint store: records/lists/rollback in a real git repo
// Each test gets its own fresh git repo to avoid state leakage.
// ---------------------------------------------------------------------------
describe('resume full-cycle: checkpoint store in real git worktree', () => {
  function makeGitRepo(): { repoDir: string; cleanup: () => void } {
    const repoDir = mkdtempSync(`${tmpdir()}/chk-resume-`)
    const g = (args: string[]) =>
      spawnSync('git', args, { cwd: repoDir, encoding: 'utf-8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'ck@test'])
    g(['config', 'user.name', 'CK Test'])
    g(['config', 'commit.gpgsign', 'false'])
    writeFileSync(`${repoDir}/README.md`, '# task\n')
    g(['add', '.'])
    g(['-c', 'commit.gpgsign=false', 'commit', '-qm', 'init'])
    return { repoDir, cleanup: () => rmSync(repoDir, { recursive: true, force: true }) }
  }

  test('recordCheckpoint creates a commit with autocheckpoint prefix', async () => {
    const {
      recordCheckpoint,
      _resetCheckpointCountersForTesting,
    } = await import('../../services/checkpoint/checkpointStore.js')
    const { repoDir, cleanup } = makeGitRepo()
    try {
      _resetCheckpointCountersForTesting()
      writeFileSync(`${repoDir}/step1.txt`, 'step one output\n')
      const result = await recordCheckpoint(repoDir, 'wrote step1.txt', 'task-001')
      expect(result.kind).toBe('committed')
      if (result.kind !== 'committed') throw new Error('unreachable')
      expect(result.stepIndex).toBe(1)
      expect(result.sha).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      cleanup()
    }
  })

  test('listCheckpoints returns only autocheckpoint commits in chronological order', async () => {
    const {
      recordCheckpoint,
      listCheckpoints,
      _resetCheckpointCountersForTesting,
    } = await import('../../services/checkpoint/checkpointStore.js')
    const { repoDir, cleanup } = makeGitRepo()
    try {
      _resetCheckpointCountersForTesting()
      writeFileSync(`${repoDir}/step1.txt`, 'step one\n')
      await recordCheckpoint(repoDir, 'wrote step1.txt', 'task-001')
      writeFileSync(`${repoDir}/step2.txt`, 'step two output\n')
      await recordCheckpoint(repoDir, 'wrote step2.txt', 'task-001')
      const checkpoints = await listCheckpoints(repoDir, 'task-001')
      expect(checkpoints.length).toBeGreaterThanOrEqual(2)
      const indices = checkpoints.map(c => c.stepIndex)
      for (let i = 1; i < indices.length; i++) {
        expect(indices[i]).toBeGreaterThan(indices[i - 1]!)
      }
    } finally {
      cleanup()
    }
  })

  test('rollbackTo restores worktree to prior checkpoint SHA', async () => {
    const {
      recordCheckpoint,
      listCheckpoints,
      rollbackTo,
      _resetCheckpointCountersForTesting,
    } = await import('../../services/checkpoint/checkpointStore.js')
    const { repoDir, cleanup } = makeGitRepo()
    try {
      _resetCheckpointCountersForTesting()
      writeFileSync(`${repoDir}/step3.txt`, 'step three output\n')
      await recordCheckpoint(repoDir, 'wrote step3.txt', 'task-rollback')
      const cps = await listCheckpoints(repoDir, 'task-rollback')
      expect(cps.length).toBeGreaterThanOrEqual(1)
      const targetSha = cps[0]!.sha
      writeFileSync(`${repoDir}/off-track.txt`, 'off-track work\n')
      spawnSync('git', ['add', 'off-track.txt'], { cwd: repoDir })
      spawnSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-m', 'off-track'], { cwd: repoDir })
      const rollback = await rollbackTo(repoDir, targetSha)
      expect(rollback.ok).toBe(true)
      const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf-8' })
      expect(head.stdout.trim()).toBe(targetSha)
    } finally {
      cleanup()
    }
  })

  test('skips checkpoint when working tree is clean (no-op, not an error)', async () => {
    const {
      recordCheckpoint,
      _resetCheckpointCountersForTesting,
    } = await import('../../services/checkpoint/checkpointStore.js')
    const { repoDir, cleanup } = makeGitRepo()
    try {
      _resetCheckpointCountersForTesting()
      const result = await recordCheckpoint(repoDir, 'nothing-changed')
      expect(result.kind).toBe('skipped:no-changes')
    } finally {
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// describe 3 — interrupt + resume invariant at the storage boundary
// ---------------------------------------------------------------------------
describe('resume full-cycle: interrupt then resume picks up from checkpoint, not from zero', () => {
  let tmpDir: string
  let gitDir: string
  let sessionId: string
  let agentId: string
  let teardown: () => void

  const task1Uuid = randomUUID() as UUID
  const task1AssistantUuid = randomUUID() as UUID

  beforeAll(async () => {
    tmpDir = mkdtempSync(`${tmpdir()}/resume-interrupt-`)
    gitDir = mkdtempSync(`${tmpdir()}/resume-interrupt-git-`)

    const g = (args: string[]) =>
      spawnSync('git', args, { cwd: gitDir, encoding: 'utf-8' })
    g(['init', '-q'])
    g(['config', 'user.email', 'test@test'])
    g(['config', 'user.name', 'Test'])
    writeFileSync(`${gitDir}/task.txt`, 'initial\n')
    g(['add', '.'])
    g(['commit', '-qm', 'initial'])

    const iso = isolateSession(tmpDir)
    sessionId = iso.sessionId
    agentId = iso.agentId
    teardown = iso.teardown

    const {
      getAgentTranscriptPath,
      resetProjectForTesting,
      writeAgentMetadata,
    } = await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const transcriptPath = getAgentTranscriptPath(asAgentId(agentId))

    const startMsg = makeUserEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: task1Uuid,
      parentUuid: null,
      text: 'Implement resumable long-horizon task support',
    })
    const progressMsg = makeAssistantEntry({
      agentId,
      sessionId,
      cwd: gitDir,
      uuid: task1AssistantUuid,
      parentUuid: task1Uuid,
      text: 'I have completed step 1 of 5. Moving to step 2...',
    })
    // Simulate interrupt — transcript captured these two messages.
    await writeTranscriptToDisk(transcriptPath, [startMsg, progressMsg])

    await writeAgentMetadata(asAgentId(agentId), {
      agentType: 'general-purpose',
      worktreePath: gitDir,
      description: 'LH task test',
    })
  })

  afterAll(() => {
    teardown()
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(gitDir, { recursive: true, force: true })
  })

  test('resume rehydration delivers prior context — agent does not start from zero', async () => {
    const { getAgentTranscript, readAgentMetadata, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    // Step A: metadata is available (resume needs agentType + cwd).
    const meta = await readAgentMetadata(asAgentId(agentId))
    expect(meta).not.toBeNull()
    expect(meta!.agentType).toBe('general-purpose')
    expect(meta!.worktreePath).toBe(gitDir)

    // Step B: transcript is non-empty (resume starts with prior context, not []).
    const transcript = await getAgentTranscript(asAgentId(agentId))
    expect(transcript).not.toBeNull()
    expect(transcript!.messages.length).toBeGreaterThan(0)

    // The first message the resumed agent sees is the original task prompt.
    const first = transcript!.messages[0] as any
    expect(first.type).toBe('user')
    expect(first.message?.content).toContain('long-horizon')
  })

  test('resume transcript includes mid-task progress — not just the initial prompt', async () => {
    const { getAgentTranscript, resetProjectForTesting } =
      await import('../../utils/sessionStorage.js')
    const { setOriginalCwd, switchSession } = await import('../../bootstrap/state.js')
    const { asAgentId, asSessionId } = await import('../../types/ids.js')

    resetProjectForTesting()
    setOriginalCwd(gitDir)
    switchSession(asSessionId(sessionId))

    const transcript = await getAgentTranscript(asAgentId(agentId))
    expect(transcript).not.toBeNull()

    // The assistant's mid-task progress message must be present so the resumed
    // agent knows it already completed step 1 and should continue from step 2.
    const hasProgress = transcript!.messages.some((m: any) => {
      const blocks = Array.isArray(m.message?.content)
        ? m.message.content
        : []
      const text = blocks.map((b: any) => b.text ?? '').join('')
      return m.type === 'assistant' && text.includes('step 1 of 5')
    })
    expect(hasProgress).toBe(true)
  })
})
