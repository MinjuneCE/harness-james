#!/usr/bin/env node
// PreToolUse(Bash) hook for sub panes: push, PR create and PR merge belong to the main pane.
// Reads the hook JSON on stdin; denies with a reason the sub can relay to main. Anything unparsable passes.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const GIT_OPTS = String.raw`(?:\s+(?:-C\s+\S+|-c\s+\S+|--[\w-]+(?:=\S+)?|-[a-zA-Z]))*`
// A REST call that writes: gh api turns into POST once a field or body is given.
const GH_WRITE = String.raw`(?:\s-X\s*(?:POST|PUT|PATCH)\b|\s--method[=\s]+(?:POST|PUT|PATCH)\b|\s-[fF]\s|\s--(?:raw-)?field\b|\s--input\b)`
const CURL_WRITE = String.raw`(?:\s-X\s*(?:POST|PUT|PATCH)\b|\s--request[=\s]+(?:POST|PUT|PATCH)\b|\s-d\b|\s--data(?:-\w+)?\b)`
// The PR list endpoint itself (create), not /pulls/<n>/… sub-resources.
const PULLS = String.raw`\/pulls(?:[\s'"?]|$)`
// [regex, label, scope]: 'whole' tests the full command, 'segment' each simple command (split on ; && || | and newlines).
const RULES = [
  [new RegExp(String.raw`(?:^|[^\w-])git${GIT_OPTS}\s+push\b`), 'git push', 'whole'],
  [/(?:^|[^\w-])gh\b(?:\s+(?:-R|--repo)\s+\S+)*\s+pr\s+(?:create|merge)\b/, 'gh pr create/merge', 'whole'],
  [/(?:^|[^\w-])gh\s+api\b[^\n]*\/pulls\/\d+\/merge\b/, 'gh api …/merge', 'whole'],
  [new RegExp(String.raw`(?:^|[^\w-])gh\s+api\b(?=[^\n]*${PULLS})(?=[^\n]*${GH_WRITE})`, 'i'), 'gh api …/pulls (PR create)', 'segment'],
  [/(?:^|[^\w-])gh\s+api\b[\s\S]*\b(?:createPullRequest|mergePullRequest|enablePullRequestAutoMerge)\b/, 'gh api graphql PR mutation', 'whole'],
  [new RegExp(String.raw`(?:^|[^\w-])curl\b(?=[^\n]*api\.github\.com\/repos\/\S*?(?:\/pulls\/\d+\/merge\b|${PULLS}))(?=[^\n]*${CURL_WRITE})`, 'i'), 'curl GitHub API PR create/merge', 'segment'],
]

export function verdict(command) {
  if (typeof command !== 'string') return null
  const whole = command.replace(/\\\r?\n/g, ' ')
  const segments = whole.split(/&&|\|\||[;|\n]/)
  for (const [re, what, scope] of RULES) if (scope === 'segment' ? segments.some((s) => re.test(s)) : re.test(whole)) return what
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
