// Hook definitions for the main pane's launch settings (merged with user/project hooks by Claude Code).
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOME = join(dirname(fileURLToPath(import.meta.url)), '..')

function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`
}

/** settings.hooks for ctx-note; homeDir defaults to this skill's root. */
export function ctxNoteHooks(homeDir = HOME) {
  const hook = { type: 'command', command: `node ${q(join(homeDir, 'hooks', 'ctx-note.mjs'))}`, timeout: 5 }

  return {
    UserPromptSubmit: [{ hooks: [{ ...hook }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ ...hook }] }],
  }
}
