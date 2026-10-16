// Lineage registry: <root>/.research/pane-lead/<prefix>/registry.json, written atomically under a lock.
import { execFileSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { NAME_RE, fail, now, readJson, usage, withLock, writeAtomic } from './common.mjs'

export const lineageDir = (root, prefix) => join(root, '.research', 'pane-lead', prefix)
export const registryPath = (root, prefix) => join(lineageDir(root, prefix), 'registry.json')

/** Prefix from --prefix or PANE_LEAD_PREFIX. */
export function prefixOf(f = {}) {
  const p = f.prefix ?? process.env.PANE_LEAD_PREFIX
  if (!p) throw usage('no lineage prefix', 'pass --prefix <p> or run inside a pane-lead main (PANE_LEAD_PREFIX)')
  if (!/^[a-z][a-z0-9]{0,11}$/.test(p)) throw usage(`bad prefix ${p}`, 'prefix: lowercase letters/digits, up to 12, starting with a letter')
  return p
}

/** acme-web-store → aws; single words → first 8 letters. */
export function defaultPrefix(dir) {
  const words = basename(dir).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const p = (words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'pl').slice(0, 8)).replace(/^[^a-z]+/, '')
  return /^[a-z][a-z0-9]{0,11}$/.test(p) ? p.slice(0, 12) : 'pl'
}

/** Lineage root: PANE_LEAD_ROOT, else the nearest ancestor of cwd holding this lineage, else cwd. */
export function rootOf(prefix, cwd = process.cwd()) {
  if (process.env.PANE_LEAD_ROOT) return resolve(process.env.PANE_LEAD_ROOT)
  for (let d = resolve(cwd); ; d = dirname(d)) {
    if (existsSync(registryPath(d, prefix))) return d
    if (dirname(d) === d) return resolve(cwd)
  }
}

export function emptyRegistry(prefix, root) {
  return { version: 1, prefix, root, createdAt: now(), main: null, mains: [], pending: null, subs: {} }
}

export function load(root, prefix) {
  return readJson(registryPath(root, prefix))
}

export function mustLoad(root, prefix) {
  const r = load(root, prefix)
  if (!r) throw fail(`no lineage ${prefix} under ${root}`, `pane-lead main --prefix ${prefix} starts one`)
  return r
}

/** Read-modify-write; fn may mutate and/or return a value. */
export async function update(root, prefix, fn) {
  const p = registryPath(root, prefix)
  return withLock(p, async () => {
    const reg = readJson(p) ?? emptyRegistry(prefix, root)
    const out = await fn(reg)
    reg.updatedAt = now()
    writeAtomic(p, JSON.stringify(reg, null, 2) + '\n')
    return out
  })
}

export function checkName(name) {
  if (!name || !NAME_RE.test(name)) throw usage(`bad name ${name ?? '(none)'}`, 'names match [a-z][a-z0-9_-]{0,31} (herdr agent name rule)')
  return name
}

/** Subs that have not been closed by us. */
export const openSubs = (reg) => Object.values(reg.subs).filter((s) => s.status !== 'closed')

/** If root is a git work tree where .research/ is not ignored, add it to .git/info/exclude (local, uncommitted). */
export function ensureExcluded(root) {
  const git = (...a) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    if (git('rev-parse', '--is-inside-work-tree') !== 'true') return null
  } catch {
    return null
  }
  try {
    git('check-ignore', '-q', '.research/pane-lead/x')
    return 'already-ignored'
  } catch {}
  const top = git('rev-parse', '--show-toplevel')
  const exclude = resolve(root, git('rev-parse', '--git-path', 'info/exclude'))
  const rel = resolve(root).slice(top.length).replace(/^\//, '')
  const line = `/${rel ? rel + '/' : ''}.research/`
  const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : ''
  if (!cur.split('\n').includes(line)) appendFileSync(exclude, (cur && !cur.endsWith('\n') ? '\n' : '') + line + '\n')
  return exclude
}
