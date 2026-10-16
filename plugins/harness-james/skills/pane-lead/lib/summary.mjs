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

/** Last n meaningful lines of a screen, with the input box and status bar trimmed. */
export function screenTail(screen, n = 8) {
  const lines = stripSidePanel(String(screen).split('\n'))
  let end = lines.length
  // Drop the prompt box (── ❯ ──) and the mode line below it.
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) if (/^\s*❯/.test(lines[i])) { end = i - 1; break }
  return lines
    .slice(0, Math.max(0, end))
    .filter((l) => l.trim() && !/^[\s─╌━═-]+$/.test(l))
    .slice(-n)
    .map((l) => l.trim())
    .join('\n')
}
