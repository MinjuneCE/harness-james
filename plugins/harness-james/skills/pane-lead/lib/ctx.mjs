// Context-window usage of a Claude Code session, read from its transcript tail.
//
// percent follows the context-band (status line) basis, measured 2026-10-15 on
// four live sessions: the input side of the last response
// (input + cache_creation + cache_read), over the window, rounded.
// `pending` holds what is not yet in that figure (the last output plus the
// entries appended after it, chars/4); `projected*` add it, for "what the next
// request will carry".
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_WINDOW = 200_000

const WINDOWS = [
  // Measured on the band: claude-opus-5-5 → 1.0M (10/15), claude-haiku-5-5 → 1.0M (pl-cli, 10/15).
  [/^claude-opus-5-5/, 1_000_000],
  [/^claude-haiku-5-5/, 1_000_000],
  // Explicit 1M variants.
  [/\[1m\]$/, 1_000_000],
]

/** Window size for a model; PANE_LEAD_CTX_WINDOW overrides. Unknown models get DEFAULT_WINDOW. */
export function windowFor(model, env = process.env) {
  return windowInfo(model, env).window
}

export function windowInfo(model, env = process.env) {
  const forced = Number(env.PANE_LEAD_CTX_WINDOW)
  if (Number.isFinite(forced) && forced > 0) return { window: forced, known: true, source: 'env' }
  for (const [re, n] of WINDOWS) if (typeof model === 'string' && re.test(model)) return { window: n, known: true, source: 'table' }

  return { window: DEFAULT_WINDOW, known: false, source: 'default' }
}

/** ~/.claude/projects/<cwd with / and . as ->/<id>.jsonl; checks the cwd guess first, then every project dir. */
export function findTranscript(sessionId, opts = {}) {
  if (typeof sessionId !== 'string' || !/^[\w-]+$/.test(sessionId)) return undefined
  const root = opts.projectsDir ?? join(opts.home ?? homedir(), '.claude', 'projects')
  const file = `${sessionId}.jsonl`
  if (opts.cwd) {
    const guess = join(root, opts.cwd.replace(/[^A-Za-z0-9]/g, '-'), file)
    if (existsSync(guess)) return guess
  }
  let dirs
  try {
    dirs = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const p = join(root, d.name, file)
    if (existsSync(p)) return p
  }

  return undefined
}

const SKIP_TYPES = new Set(['system', 'last-prompt', 'ai-title', 'mode', 'permission-mode', 'atis-latch', 'file-history-snapshot', 'summary', 'custom-title'])

/** Chars that will reach the model from an entry appended after the last response. */
function entryChars(o) {
  if (SKIP_TYPES.has(o.type)) return 0
  if (o.type === 'user' || o.type === 'attachment') {
    const c = o.message?.content ?? o.attachment ?? o.content
    if (c === undefined) return 0
    return typeof c === 'string' ? c.length : JSON.stringify(c).length
  }

  return 0
}

function isCompaction(o) {
  return o.subtype === 'compact_boundary' || o.isCompactSummary === true
}

/** Parses tail text (first partial line dropped unless `whole`). */
export function scanTail(text, whole = false) {
  const lines = text.split('\n')
  if (!whole) lines.shift()
  let last
  let after = 0
  let compacted = false
  for (const line of lines) {
    if (!line) continue
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.type === 'assistant' && o.message?.usage && !o.isSidechain && o.message.model !== '<synthetic>') {
      last = o
      after = 0
      compacted = false
      continue
    }
    if (isCompaction(o)) {
      compacted = true
      after = 0
    }
    after += entryChars(o)
  }
  if (!last) return undefined
  const u = last.message.usage
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)

  return { model: last.message.model, input, output: u.output_tokens ?? 0, afterChars: after, compacted }
}

function readTail(path, bytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const n = Math.min(size, bytes)
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, size - n)

    return { text: buf.toString('utf8'), whole: n === size }
  } finally {
    closeSync(fd)
  }
}

/**
 * { used, window, percent, model, windowKnown, pending, projected, projectedPercent, compacted }
 * or undefined when there is no response yet / unreadable.
 * opts.self: the transcript is the calling session's own (hook, `ctx --self`). Only then does
 * PANE_LEAD_CTX_WINDOW apply; a main measuring its subs always uses the real window.
 */
export function contextUsage(transcriptPath, opts = {}) {
  const env = opts.self ? (opts.env ?? process.env) : {}
  let scan
  try {
    for (let bytes = opts.tailBytes ?? 256 * 1024; ; bytes *= 4) {
      const { text, whole } = readTail(transcriptPath, bytes)
      scan = scanTail(text, whole)
      if (scan || whole) break
    }
  } catch {
    return undefined
  }
  if (!scan) return undefined
  const { window, known } = windowInfo(scan.model, env)
  const trailing = Math.ceil(scan.afterChars / 4)
  // After a compaction the last usage is stale: only what follows the boundary counts.
  const used = scan.compacted ? trailing : scan.input
  const pending = scan.compacted ? 0 : scan.output + trailing
  const projected = used + pending

  return {
    used,
    window,
    percent: Math.round((used / window) * 100),
    model: scan.model,
    windowKnown: known,
    pending,
    projected,
    projectedPercent: Math.round((projected / window) * 100),
    compacted: scan.compacted,
  }
}
