#!/usr/bin/env node
// PreToolUse(Bash) hook for sub panes: push, PR create and PR merge belong to the main pane.
// Reads the hook JSON on stdin; denies with a reason the sub can relay to main. Anything unparsable passes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GIT_OPTS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]))*`
const RULES = [
  [new RegExp(String.raw`(?:^|[^\w-])git${GIT_OPTS}\s+push\b`), 'git push'],
  [/(?:^|[^\w-])gh\b(?:\s+(?:-R|--repo)\s+\S+)*\s+pr\s+(?:create|merge)\b/, 'gh pr create/merge'],
  [/(?:^|[^\w-])gh\s+api\b[^\n]*\/pulls\/\d+\/merge\b/, 'gh api …/merge'],
]

export function verdict(command) {
  if (typeof command !== 'string') return null
  for (const [re, what] of RULES) if (re.test(command)) return what
  return null
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let what = null
  try {
    what = verdict(JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command)
  } catch {}
  if (what) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: `pane-lead: ${what} is main-only. Commit locally and write the request under "메인에게" in your result file.`,
        },
      }) + '\n',
    )
  }
  process.exit(0)
}
