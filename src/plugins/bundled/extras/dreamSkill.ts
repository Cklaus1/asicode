/**
 * `/dream` as a bundled-plugin skill (ADR-0001 step 1 — REQ-92).
 *
 * `/dream` was a `PromptCommand` in src/commands/dream/ imported directly into
 * commands.ts. Its `getPromptForCommand` shape matches `BundledSkillDefinition`
 * exactly, so it migrates into the `asicode-extras` built-in plugin with no new
 * infrastructure — this is the inversion the ADR's step 1 proves: the command
 * is now *contributed* by a plugin the kernel discovers, not hardcoded.
 *
 * The body is unchanged from the original src/commands/dream/dream.ts; only the
 * packaging moved. The `isAutoMemoryEnabled()` gate carries through the skill's
 * `isEnabled`, so `/dream` still only appears when auto-memory is on.
 */
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import type { BundledSkillDefinition } from '../../../skills/bundledSkills.js'
import { isAutoMemoryEnabled, getAutoMemPath } from '../../../memdir/paths.js'
import { getProjectDir } from '../../../utils/sessionStorage.js'
import { getOriginalCwd, getSessionId } from '../../../bootstrap/state.js'
import { buildConsolidationPrompt } from '../../../services/autoDream/consolidationPrompt.js'
import {
  readLastConsolidatedAt,
  listSessionsTouchedSince,
  recordConsolidation,
} from '../../../services/autoDream/consolidationLock.js'

export const dreamSkill: BundledSkillDefinition = {
  name: 'dream',
  description:
    'Run memory consolidation — synthesize recent sessions into durable memories',
  isEnabled: () => isAutoMemoryEnabled(),
  async getPromptForCommand(): Promise<ContentBlockParam[]> {
    const memoryRoot = getAutoMemPath()
    const transcriptDir = getProjectDir(getOriginalCwd())

    let lastAt: number
    try {
      lastAt = await readLastConsolidatedAt()
    } catch {
      lastAt = 0
    }

    let sessionIds: string[]
    try {
      sessionIds = await listSessionsTouchedSince(lastAt)
    } catch {
      sessionIds = []
    }

    const currentSession = getSessionId()
    sessionIds = sessionIds.filter(id => id !== currentSession)

    if (sessionIds.length === 0) {
      sessionIds = [currentSession]
    }

    const hoursSince =
      lastAt > 0
        ? `${((Date.now() - lastAt) / 3_600_000).toFixed(1)}h ago`
        : 'never'

    const extra = `
**Manually triggered by user via /dream.**

Sessions since last consolidation (${sessionIds.length}, last run: ${hoursSince}):
${sessionIds.map(id => `- ${id}`).join('\n')}`

    const prompt = buildConsolidationPrompt(memoryRoot, transcriptDir, extra)

    // Record consolidation timestamp programmatically so auto-dream knows when
    // the last manual run happened.
    await recordConsolidation()

    return [{ type: 'text', text: prompt }]
  },
}
