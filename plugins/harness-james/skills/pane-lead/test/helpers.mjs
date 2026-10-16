// Test harness: temp lineage root + fake herdr state; runs the CLI as a child process.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(HOME, 'bin', 'pane-lead.mjs')
const FAKE = join(HOME, 'test', 'fake-herdr.mjs')

export function world({ width = 335, height = 78, foreign = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pl-cli-'))
  const stateFile = join(root, 'fake-state.json')
  const state = {
    tabs: { 'w9:t1': { area: { width, height }, root: { pane: 'w9:p1' } } },
    panes: { 'w9:p1': {} },
    agents: {},
    script: {},
  }
  if (foreign) {
    state.tabs['w9:t2'] = { area: { width, height }, root: { pane: 'w9:p9' } }
    state.panes['w9:p9'] = {}
    state.agents['w9:p9'] = { name: 'oc-other', status: 'blocked', session: 'foreign', screen: 'Do you want to proceed?\n❯ 1. Yes\n  2. No' }
  }
  writeFileSync(stateFile, JSON.stringify(state))
  mkdirSync(join(root, '.research', 'out'), { recursive: true })
  const w = {
    root,
    stateFile,
    get state() {
      return JSON.parse(readFileSync(stateFile, 'utf8'))
    },
    patch(fn) {
      const s = w.state
      fn(s)
      writeFileSync(stateFile, JSON.stringify(s))
    },
    run(args, { pane = 'w9:p1', env = {} } = {}) {
      const r = spawnSync(process.execPath, [BIN, ...args], {
        cwd: root,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          HERDR_ENV: '1',
          HERDR_PANE_ID: pane,
          PANE_LEAD_HERDR: FAKE,
          PANE_LEAD_FAKE_STATE: stateFile,
          PANE_LEAD_PREFIX: 't',
          PANE_LEAD_ROOT: root,
          ...env,
        },
      })
      let json
      try {
        json = JSON.parse(r.stdout)
      } catch {
        json = { raw: r.stdout, stderr: r.stderr }
      }
      return { code: r.status, ...json }
    },
    /** pane_id → rect for the main tab, straight from the fake herdr. */
    layout() {
      const r = spawnSync(process.execPath, [FAKE, 'pane', 'layout', '--pane', 'w9:p1'], { encoding: 'utf8', env: { ...process.env, PANE_LEAD_FAKE_STATE: stateFile } })
      return Object.fromEntries(JSON.parse(r.stdout).result.layout.panes.map((p) => [p.pane_id, p.rect]))
    },
    registry() {
      return JSON.parse(readFileSync(join(root, '.research', 'pane-lead', 't', 'registry.json'), 'utf8'))
    },
    /** Seed the lineage like a real `main` launch would (main gen 1 in w9:p1); dry-run writes nothing, so seed directly. */
    startMain() {
      const main = { generation: 1, name: 't-main-1', pane: 'w9:p1', sessionId: randomUUID(), startedAt: new Date().toISOString(), settings: null }
      const dir = join(root, '.research', 'pane-lead', 't')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'registry.json'), JSON.stringify({ version: 1, prefix: 't', root, createdAt: main.startedAt, main, mains: [], pending: null, subs: {} }, null, 2))
      w.patch((s) => (s.agents['w9:p1'] = { name: main.name, status: 'working', session: main.sessionId }))
      return { main }
    },
    brief(name = 'b') {
      const p = join(root, '.research', 'tasks', `${name}.md`)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, '# brief\n')
      return p
    },
  }
  return w
}

export function git(dir, ...a) {
  return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' })
}
