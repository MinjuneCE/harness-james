// Test harness: temp lineage root + fake herdr state; runs the CLI as a child process.
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BIN = join(HOME, 'bin', 'pane-lead.mjs')
const FAKE = join(HOME, 'test', 'fake-herdr.mjs')
const FAKE_CLAUDE = join(HOME, 'test', 'fake-claude.mjs')

/** A get_usage answer as measured on 2026-11-16 (2.1.325), cut down to the rate limits: percent 0-100. */
export const usageAnswer = (fable, { resetsAt = new Date(Date.now() + 3 * 86400_000).toISOString(), weekly = 12 } = {}) => ({
  session: { total_cost_usd: 0 },
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 13, resets_at: resetsAt },
    seven_day: { utilization: weekly, resets_at: resetsAt },
    ...(fable === null ? { model_scoped: [] } : { model_scoped: [{ display_name: 'Fable', utilization: fable, resets_at: resetsAt }] }),
    limits: [
      { kind: 'session', group: 'session', percent: 13, resets_at: resetsAt, scope: null },
      { kind: 'weekly_all', group: 'weekly', percent: weekly, resets_at: resetsAt, scope: null },
      ...(fable === null ? [] : [{ kind: 'weekly_scoped', group: 'weekly', percent: fable, resets_at: resetsAt, scope: { model: { id: null, display_name: 'Fable' }, surface: null } }]),
    ],
  },
  behaviors: null,
})

export function world({ width = 335, height = 78, foreign = true, skill = true } = {}) {
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
  // The sub's rules live in the pane-sub skill; spawn checks the sub can load it. Tests name a stand-in outright
  // (<root>/.claude stays free for the account tests); `skill: false` leaves it out.
  const skillDir = join(root, 'fake-skills', 'pane-sub')
  if (skill) {
    mkdirSync(skillDir, { recursive: true })
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: pane-sub\n---\n')
  }
  // The account's Fable weekly limit as the fake claude answers it: 10% unless a test says otherwise.
  const usageFile = join(root, 'fake-usage.json')
  writeFileSync(usageFile, JSON.stringify(usageAnswer(10)))
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
          PANE_LEAD_CLAUDE: FAKE_CLAUDE,
          PANE_LEAD_SUB_SKILL_DIR: skillDir,
          PANE_LEAD_FAKE_USAGE: usageFile,
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
    /** Sets what the next get_usage probe answers (an object, or null for "no login") and drops the cached reading. */
    usage(answer) {
      if (answer === null) rmSync(usageFile, { force: true })
      else writeFileSync(usageFile, JSON.stringify(answer))
      rmSync(join(root, '.local', 'state', 'pane-lead', 'fable-limit'), { recursive: true, force: true })
    },
    /** Every probe so far: [{ args, configDir, role, cwd }]. */
    usageCalls() {
      const f = `${usageFile}.calls`
      return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
    },
    /** The cached Fable reading of an account (default | dir-<config dir>), or null. */
    fableRecord(account = 'default') {
      const f = join(root, '.local', 'state', 'pane-lead', 'fable-limit', `${account}.json`)
      return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null
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
