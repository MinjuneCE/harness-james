// Shared paths, errors, argv parsing and atomic file helpers for the pane-lead CLI.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const CLI = 'pane-lead'
export const BIN = join(HOME, 'bin', 'pane-lead.mjs')
// Slash command for this skill: a plugin skill is /<plugin>:pane-lead (the short /pane-lead also resolves
// when no other skill shares the name); a skill under ~/.claude/skills stays /pane-lead.
export function skillCommand(home = HOME) {
  try {
    const { name } = JSON.parse(readFileSync(join(home, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'))
    if (name) return `/${name}:${CLI}`
  } catch {}
  return `/${CLI}`
}
export const SKILL_CMD = skillCommand()

export const MAX_SUBS = () => Number(process.env.PANE_LEAD_MAX_SUBS) || 5
export const MODEL = () => process.env.PANE_LEAD_MODEL || 'claude-opus-5-5'
// Main effort: 'max' unless overridden; 'none' omits --effort (experiments with models that lack it).
export const MAIN_EFFORT = () => process.env.PANE_LEAD_MAIN_EFFORT || 'max'
export const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/

export class PlError extends Error {
  constructor(message, { next = null, code = 1, data = undefined } = {}) {
    super(message)
    this.next = next
    this.code = code
    this.data = data
  }
}
export const fail = (message, next, data) => new PlError(message, { next, code: 1, data })
export const usage = (message, next) => new PlError(message, { next, code: 2 })

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const now = () => new Date().toISOString()

/** --k v / --k=v / booleans; positional args kept in order. */
export function parse(argv, booleans = new Set()) {
  const pos = []
  const f = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h') f.help = true
    else if (a.startsWith('--')) {
      let [k, v] = a.slice(2).split(/=(.*)/s, 2)
      if (booleans.has(k)) f[k] = v === undefined ? true : v !== 'false'
      else {
        if (v === undefined) {
          v = argv[++i]
          if (v === undefined || v.startsWith('--')) throw usage(`--${k} needs a value`, `${CLI} --help`)
        }
        f[k] = v
      }
    } else pos.push(a)
  }
  return { pos, f }
}

export const absFrom = (base, p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : resolve(base, p))

export function readJson(p, fallback = undefined) {
  if (!existsSync(p)) return fallback
  return JSON.parse(readFileSync(p, 'utf8'))
}

/** Temp file in the same directory + rename, so readers never see a half-written file. */
export function writeAtomic(p, text) {
  mkdirSync(dirname(p), { recursive: true })
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, p)
  return p
}

/** mkdir-based lock around a read-modify-write; stale locks (>30 s) are broken. */
export async function withLock(p, fn) {
  const lock = `${p}.lock`
  mkdirSync(dirname(p), { recursive: true })
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30000) rmSync(lock, { recursive: true, force: true })
      } catch {}
      if (i > 400) throw fail(`registry lock busy: ${lock}`, 'retry; remove the .lock directory if no pane-lead command is running')
      await sleep(25)
    }
  }
  try {
    return await fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

