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

import type { Command } from '../../commands.js'
import { registerBuiltinPlugin } from '../builtinPlugins.js'
import { dreamSkill } from './extras/dreamSkill.js'
import advisor from '../../commands/advisor.js'
import stickers from '../../commands/stickers/index.js'
import knowledge from '../../commands/knowledge/index.js'

/**
 * Initialize built-in plugins. Called during CLI startup.
 */
export function initBuiltinPlugins(): void {
  // asicode-extras: the command-shaped bolt-ons (ADR-0001 step 2 set), now
  // CONTRIBUTED by a plugin the kernel discovers instead of hardcoded in
  // commands.ts. /dream is a prompt skill (REQ-92); advisor/stickers/knowledge
  // are code commands carried via the `commands` capability (REQ-93/94). Their
  // implementation modules stay under src/commands/ (the underlying util
  // systems live in core); only the registration moved out of commands.ts.
  registerBuiltinPlugin({
    name: 'asicode-extras',
    description:
      'Extra slash commands: /dream (memory consolidation), /advisor, /stickers, /knowledge',
    skills: [dreamSkill],
    commands: [advisor, stickers, knowledge] as Command[],
    defaultEnabled: true,
  })
}
