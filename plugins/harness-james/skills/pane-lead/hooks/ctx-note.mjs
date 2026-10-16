#!/usr/bin/env node
// Main-pane-only hook: tells the model "컨텍스트 N%" once the window is at 50% or more.
//   UserPromptSubmit → every prompt; PostToolUse → only when a new 5%p step is crossed.
// Toggle: node ctx-note.mjs off|on|status  (file <state>/ctx-note.off)
// Any failure: silent exit 0.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { contextUsage, findTranscript } from '../lib/ctx.mjs'

export const THRESHOLD = 50
export const STEP = 5

export function stateDir(env = process.env) {
  return env.PANE_LEAD_STATE_DIR || join(homedir(), '.local', 'state', 'pane-lead')
}

export function offFile(env = process.env) {
  return join(stateDir(env), 'ctx-note.off')
}

function stepFile(sessionId, env) {
  return join(env.PANE_LEAD_STATE_DIR || join(tmpdir(), 'pane-lead'), 'ctx-note', `${String(sessionId).replace(/[^\w-]/g, '_')}.step`)
}

export function toggle(cmd, env = process.env) {
  const f = offFile(env)
  if (cmd === 'off') {
    mkdirSync(stateDir(env), { recursive: true })
    writeFileSync(f, `${new Date().toISOString()}\n`)
  } else if (cmd === 'on') {
    rmSync(f, { force: true })
  }

  return existsSync(f) ? 'off' : 'on'
}

/** Pure decision: the hook's stdout JSON (string) or '' for nothing. */
export function decide({ input, usage, lastStep, env = process.env }) {
  if (env.PANE_LEAD_ROLE !== 'main') return { out: '' }
  if (!usage || !(usage.percent >= THRESHOLD)) return { out: '' }
  const event = input.hook_event_name
  const step = Math.floor(usage.percent / STEP) * STEP
  if (event === 'PostToolUse') {
    if (lastStep !== undefined && step <= lastStep) return { out: '' }
  } else if (event !== 'UserPromptSubmit') {
    return { out: '' }
  }
  const out = JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `컨텍스트 ${usage.percent}%` } })

  return { out, step }
}

export function run(raw, env = process.env) {
  if (env.PANE_LEAD_ROLE !== 'main') return ''
  if (existsSync(offFile(env))) return ''
  const input = JSON.parse(raw)
  const path = input.transcript_path || findTranscript(input.session_id, { cwd: input.cwd })
  if (!path) return ''
  const usage = contextUsage(path, { env, self: true })
  const sf = stepFile(input.session_id ?? 'unknown', env)
  let lastStep
  try {
    lastStep = Number(readFileSync(sf, 'utf8').trim())
    if (!Number.isFinite(lastStep)) lastStep = undefined
  } catch {}
  const { out, step } = decide({ input, usage, lastStep, env })
  // Record the step on any announcement; drop it when back under the threshold (after compaction).
  try {
    if (step !== undefined && step !== lastStep) {
      mkdirSync(join(sf, '..'), { recursive: true })
      writeFileSync(sf, String(step))
    } else if (usage && usage.percent < THRESHOLD && lastStep !== undefined) {
      rmSync(sf, { force: true })
    }
  } catch {}

  return out
}

async function main() {
  const cmd = process.argv[2]
  if (cmd === 'on' || cmd === 'off' || cmd === 'status') {
    process.stdout.write(`ctx-note: ${toggle(cmd)}\n`)
    return
  }
  // Leave before touching stdin when this is not the main pane.
  if (process.env.PANE_LEAD_ROLE !== 'main') return
  let raw = ''
  for await (const chunk of process.stdin) raw += chunk
  const out = run(raw)
  if (out) process.stdout.write(`${out}\n`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  )
}
