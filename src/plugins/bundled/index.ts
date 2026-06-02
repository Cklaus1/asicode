/**
 * Built-in Plugin Initialization
 *
 * Initializes built-in plugins that ship with the CLI and appear in the
 * /plugin UI for users to enable/disable.
 *
 * Not all bundled features should be built-in plugins — use this for
 * features that users should be able to explicitly enable/disable. For
 * features with complex setup or automatic-enabling logic (e.g.
 * claude-in-chrome), use src/skills/bundled/ instead.
 *
 * To add a new built-in plugin:
 * 1. Import registerBuiltinPlugin from '../builtinPlugins.js'
 * 2. Call registerBuiltinPlugin() with the plugin definition here
 */

import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { dreamSkill } from './extras/dreamSkill.js'

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export function initBuiltinPlugins(): void {
  // asicode-extras: the command-shaped bolt-ons (ADR-0001 step 2 set). dream is
  // the first migrant (step 1, REQ-92) — a prompt skill. advisor/stickers/
  // knowledge (code commands) join via the `commands` capability in REQ-93/94.
  registerBuiltinPlugin({
    name: 'asicode-extras',
    description:
      'Extra slash commands: /dream (memory consolidation), /advisor, /stickers, /knowledge',
    skills: [dreamSkill],
    defaultEnabled: true,
  })
}
