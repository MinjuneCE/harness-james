// Short outputs for the main pane: the top summary of a result file, or the last lines of a screen.
import { existsSync, readFileSync, statSync } from 'node:fs'
import { stripSidePanel } from './dialog.mjs'

/**
 * The top summary of a result file: the `# title` line, then up to `max` non-empty lines until the first `---`
 * or the next heading. One sub-heading right under the title (e.g. `## 요약`) opens the summary and is skipped.
 */
export function topSummary(text, max = 15, maxChars = 1500) {
  let title
  let opened = false
  const body = []
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\s+$/, '')
    if (!l.trim()) continue
    const heading = /^#{1,6}\s/.test(l)
    if (title === undefined && !opened && !body.length && /^#\s/.test(l)) {
      title = l
      continue
    }
    if (heading) {
      if (body.length || opened) break
      opened = true
      continue
    }
    if (/^-{3,}$/.test(l.trim())) {
      if (body.length) break
      continue
    }
    body.push(l)
    if (body.length >= max) break
  }
  const joined = [...(title ? [title] : []), ...body].join('\n')
  return joined.length > maxChars ? joined.slice(0, maxChars) + '…' : joined
}

/** Summary only when the result file was written after `since` (ISO); stale files are ignored. */
export function resultSummary(path, since) {
  if (!path || !existsSync(path)) return null
  if (since && statSync(path).mtimeMs < Date.parse(since)) return null
  return topSummary(readFileSync(path, 'utf8'))
}

/** A sub's progress line: the first line under the title, while it still starts with `진행:` (pane-sub result format). */
export function progressLine(summary) {
  const first = String(summary ?? '').split('\n').find((l) => l.trim() && !/^#\s/.test(l))
  return first && /^\s*진행\s*:/.test(first) ? first.trim() : null
}

// Lines that say nothing about why a sub stopped (E2E 2026-11-16: they filled the tail of a turn cut by an API error):
// the context-band mod's band line, and a mod's "hook was skipped" notice (work-trace) with its wrapped lines.
const BAND = /^\s*컨텍스트\s+[█░]/
const NOTICE = /^\s*⏺\s+(?:work-trace:|[\w-]+: its \S+ hook was skipped)/

function dropNoise(lines) {
  const out = []
  let inNotice = false
  for (const l of lines) {
    if (NOTICE.test(l)) inNotice = true
    // The notice wraps onto indented lines; a blank line or a line at column 0 ends it.
    else if (inNotice && !/^\s+\S/.test(l)) inNotice = false
    if (!inNotice && !BAND.test(l)) out.push(l)
  }
  return out
}

/** Last n meaningful lines of a screen, with the input box, status bar, context band and hook notices trimmed. */
export function screenTail(screen, n = 8) {
  const lines = stripSidePanel(String(screen).split('\n'))
  let end = lines.length
  // Drop the prompt box (── ❯ ──) and the mode line below it.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) if (/^\s*❯/.test(lines[i])) { end = i - 1; break }
  return dropNoise(lines.slice(0, Math.max(0, end)))
    .filter((l) => l.trim() && !/^[\s─╌━═-]+$/.test(l))
    .slice(-n)
    .map((l) => l.trim())
    .join('\n')
}
