// Launch settings files (passed with --settings <file>) for the main and sub Claude sessions.
import { join } from 'node:path'
import { HOME, readJson, writeAtomic } from './common.mjs'
import { lineageDir } from './registry.mjs'

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`

// Sub sessions never push, open or merge PRs. Three layers, because Bash rules match command text only:
// 1. permission deny rules (visible in /permissions; measured: the hook answers first, so its message is what the sub sees),
// 2. a PreToolUse hook that also catches `git -C x push`, `sh -c "..."`, `env ... git push`,
// 3. git config via env: pushInsteadOf "" rewrites every push URL to an unknown helper, so any git push fails
//    (aliases, scripts, gh's own push). Fetch is untouched.
// Deny rules stay plain prefixes: `*` spans spaces, so `Bash(git * push *)` would also deny `git commit -m "fix push"`.
export const SUB_DENY = ['Bash(git push *)', 'Bash(gh pr create *)', 'Bash(gh pr merge *)']
export const PUSH_BLOCK_ENV = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'url.pane-lead-sub-push-is-main-only://.pushInsteadOf',
  GIT_CONFIG_VALUE_0: '',
}

async function ctxHooks() {
  try {
    const { ctxNoteHooks } = await import('./ctx-hooks.mjs')
    return ctxNoteHooks(HOME)
  } catch {
    const hook = { type: 'command', command: `node ${q(join(HOME, 'hooks', 'ctx-note.mjs'))}`, timeout: 5 }
    return { UserPromptSubmit: [{ hooks: [hook] }], PostToolUse: [{ matcher: '*', hooks: [hook] }] }
  }
}

export async function mainSettings({ prefix, root }) {
  return {
    env: { PANE_LEAD_ROLE: 'main', PANE_LEAD_PREFIX: prefix, PANE_LEAD_ROOT: root },
    hooks: await ctxHooks(),
  }
}

export function subSettings({ prefix, root }, extra) {
  const s = {
    env: { PANE_LEAD_ROLE: 'sub', PANE_LEAD_PREFIX: prefix, PANE_LEAD_ROOT: root, ...PUSH_BLOCK_ENV },
    permissions: { deny: [...SUB_DENY] },
    // No predicted next prompt in the sub's input box: nobody types there, and the dim text reads like a
    // human's. The CLI flag --prompt-suggestions false is ignored in interactive 2.1.30x; this key works.
    promptSuggestionEnabled: false,
    hooks: {
      // onFailure 'block' (Claude Code 2.1.295+): a guard that cannot start, exits with a code other than 0/2 or times out
      // blocks the Bash call; without it such a failure lets the call through.
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${q(join(HOME, 'hooks', 'sub-guard.mjs'))}`, timeout: 5, onFailure: 'block' }] }],
    },
  }
  return extra ? merge(s, extra) : s
}

/** Deep merge; arrays concatenate (for test-only extras such as permissions.ask). */
export function merge(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b]
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const o = { ...a }
    for (const [k, v] of Object.entries(b)) o[k] = k in a ? merge(a[k], v) : v
    return o
  }
  return b
}

export const settingsPath = (root, prefix, name) => join(lineageDir(root, prefix), 'settings', `${name}.json`)

export function writeSettings(root, prefix, name, obj) {
  return writeAtomic(settingsPath(root, prefix, name), JSON.stringify(obj, null, 2) + '\n')
}

export const readExtra = (p) => (p ? readJson(p) : undefined)
