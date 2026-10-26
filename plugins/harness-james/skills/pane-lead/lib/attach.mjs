// Handover attach: a workspace-configured command whose Markdown output goes at the end of the handover doc.
// Config <root>/.research/pane-lead/attach.json (workspace-owned; pane-lead knows no workspace):
//   { "handover": { "<prefix>": { "cmd": ["node", "x.mjs", "--doc", "{doc}"], "label": "x", "title": "…", "timeout": 10000 } } }
// No config or no entry for the prefix → nothing happens. Never throws: a failure becomes a one-line note in the doc.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeAtomic } from './common.mjs'

export const attachPath = (root) => join(root, '.research', 'pane-lead', 'attach.json')
export const BEGIN = '<!-- pane-lead:attach begin (handover replaces this section) -->'
export const END = '<!-- pane-lead:attach end -->'
const DEFAULT_TIMEOUT = 10000
const MAX_LINES = 60

const stamp = (d = new Date()) => {
  const z = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}:${z(d.getMinutes())}`
}

/** The prefix's entry, null when not configured; throws on an unreadable or malformed config. */
export function attachEntry(root, prefix) {
  const p = attachPath(root)
  if (!existsSync(p)) return null
  const e = JSON.parse(readFileSync(p, 'utf8'))?.handover?.[prefix]
  if (e == null) return null
  if (!Array.isArray(e.cmd) || !e.cmd.length || !e.cmd.every((a) => typeof a === 'string')) throw new Error(`handover.${prefix}.cmd must be a non-empty string array`)
  return e
}

/** Run argv in root with a hard timeout (kills the process group); resolves, never rejects. */
function run(argv, root, timeout) {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (r) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(r)
    }
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      return finish({ error: e.message })
    }
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
      finish({ error: `시간 초과 ${timeout}ms` })
    }, timeout)
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (err += b))
    child.on('error', (e) => finish({ error: e.message }))
    child.on('close', (code, signal) => finish(code === 0 ? { out } : { error: `종료 코드 ${code ?? signal}${err.trim() ? `: ${err.trim().split('\n')[0]}` : ''}` }))
  })
}

/** Text with our section (markers inclusive) removed; a begin without an end drops to the end of the file. */
function strip(text) {
  const i = text.indexOf(BEGIN)
  if (i < 0) return { text, had: false }
  const j = text.indexOf(END, i)
  const rest = j < 0 ? '' : text.slice(j + END.length).replace(/^\n/, '')
  return { text: text.slice(0, i).replace(/\n+$/, '\n') + rest, had: true }
}

/**
 * Attach the prefix's command output to the doc. Returns undefined when not configured (doc untouched),
 * else { ok, lines | reason, label, section: 'added' | 'replaced' }.
 */
export async function attachToDoc({ root, prefix, doc }) {
  let entry
  let label = 'attach.json'
  let result
  try {
    entry = attachEntry(root, prefix)
    if (!entry) return undefined
    label = entry.label ?? entry.cmd.join(' ')
    const fill = (a) => a.replaceAll('{prefix}', prefix).replaceAll('{doc}', doc).replaceAll('{root}', root)
    const r = await run(entry.cmd.map(fill), root, Number(entry.timeout) || DEFAULT_TIMEOUT)
    if (r.error) result = { ok: false, reason: r.error }
    else if (!r.out.trim()) result = { ok: false, reason: '빈 출력' }
    else result = { ok: true, body: r.out.replace(/\s+$/, '').split('\n') }
  } catch (e) {
    result = { ok: false, reason: `설정 읽기 실패: ${e.message}` }
  }
  let body = result.ok ? result.body : [`기계 계산 실패: ${result.reason}`]
  const lines = body.length
  if (body.length > MAX_LINES) body = [...body.slice(0, MAX_LINES), `… (${body.length - MAX_LINES}줄 생략)`]
  const title = entry?.title ?? '붙임 명령 출력'
  const section = [BEGIN, `## 기계 계산: ${title} (${stamp()}, ${label})`, '', ...body, END, ''].join('\n')
  try {
    const { text, had } = strip(readFileSync(doc, 'utf8'))
    writeAtomic(doc, `${text.replace(/\n*$/, '\n')}\n${section}`)
    return result.ok ? { ok: true, lines, label, section: had ? 'replaced' : 'added' } : { ok: false, reason: result.reason, label, section: had ? 'replaced' : 'added' }
  } catch (e) {
    return { ok: false, reason: `문서 쓰기 실패: ${e.message}`, label }
  }
}
