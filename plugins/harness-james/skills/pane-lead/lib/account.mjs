// Claude account profiles: which CLAUDE_CONFIG_DIR a pane gets.
// The default profile is no CLAUDE_CONFIG_DIR at all: its state lives in ~/.claude.json.
// CLAUDE_CONFIG_DIR=~/.claude reads ~/.claude/.claude.json instead and lands on a login screen.
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

export const isDefaultDir = (dir) => real(dir) === real(join(homedir(), '.claude'))

/** The CLAUDE_CONFIG_DIR value to put on a pane: null for none (the default profile, also when given ~/.claude). */
export const accountDir = (dir) => (!dir || isDefaultDir(dir) ? null : dir)
