import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { world } from './helpers.mjs'
import { SKILL_CMD } from '../lib/common.mjs'

// Right after a split herdr can answer agent start with agent_pane_busy "agent target pane … is not an available
// shell" while the shell is still starting (measured 2026-10-23).
const settingsDir = (w) => join(w.root, '.research', 'pane-lead', 't', 'settings')
const settingsFiles = (w) => (existsSync(settingsDir(w)) ? readdirSync(settingsDir(w)) : [])
const starts = (w) => w.state.log.filter((l) => l.startsWith('agent start'))
const short = { PANE_LEAD_SHELL_WAIT_MS: '1500' }

function lineage() {
  const w = world()
  w.startMain()
  w.patch((s) => (s.agents['w9:p1'].status = 'idle'))
  const doc = join(w.root, '.research', 'pane-lead', 't', 'handover', 'main-1.md')
  mkdirSync(join(doc, '..'), { recursive: true })
  writeFileSync(doc, '# handover\n')
  return { w, doc }
}

test('startup children in the foreground: start waits for a bare shell (pane process-info) before agent start', () => {
  const { w, doc } = lineage()
  w.patch((s) => (s.fgBusy = 3))
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  const log = w.state.log
  const iStart = log.findIndex((l) => l.startsWith('agent start'))
  assert.equal(log.slice(0, iStart).filter((l) => l.startsWith(`pane process-info --pane ${h.next_main.pane}`)).length, 4)
  assert.equal(starts(w).length, 1)
})

test('handover: agent_pane_busy a few times, then the retry starts the new main', () => {
  const { w, doc } = lineage()
  w.patch((s) => (s.paneBusy = 3))
  const r = w.run(['handover', '--doc', doc])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(starts(w).length, 4)
  assert.equal(w.state.agents[r.next_main.pane].prompts[0], `${SKILL_CMD} takeover ${doc}`)
  assert.equal(w.registry().pending.pane, r.next_main.pane)
})

test('handover: still busy after the wait → shell-busy; new pane closed, settings removed, pending cleared, old main kept', () => {
  const { w, doc } = lineage()
  w.patch((s) => (s.paneBusy = 999))
  const panes = Object.keys(w.state.panes).length
  const r = w.run(['handover', '--doc', doc], { env: short })
  assert.equal(r.error, 'shell-busy', JSON.stringify(r))
  assert.match(r.next, /pane-lead handover again/)
  assert.ok(starts(w).length >= 2, 'retried')
  assert.ok(!w.state.panes[r.data.pane], 'pane closed')
  assert.equal(Object.keys(w.state.panes).length, panes)
  assert.deepEqual(settingsFiles(w), [])
  const reg = w.registry()
  assert.equal(reg.pending, null)
  assert.equal(reg.main.name, 't-main-1')
  // Once the shell is fine the same command goes through.
  w.patch((s) => (s.paneBusy = 0))
  const again = w.run(['handover', '--doc', doc])
  assert.equal(again.ok, true, JSON.stringify(again))
})

test('spawn: agent_pane_busy retried to success; still busy → pane closed, sub failed, settings removed, same name spawns again', () => {
  const w = world()
  w.startMain()
  const b = w.brief()
  w.patch((s) => (s.paneBusy = 2))
  const ok = w.run(['spawn', 's1', '--brief', b])
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(starts(w).length, 3)
  w.patch((s) => (s.paneBusy = 999))
  const panes = Object.keys(w.state.panes).length
  const bad = w.run(['spawn', 's2', '--brief', b], { env: short })
  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.match(bad.error, /not an available shell/)
  assert.match(bad.next, /was closed; run the same pane-lead spawn again/)
  assert.equal(bad.data.closed, true)
  assert.ok(!w.state.panes[bad.data.pane])
  assert.equal(Object.keys(w.state.panes).length, panes)
  assert.equal(w.registry().subs.s2.status, 'failed')
  assert.ok(!settingsFiles(w).includes('s2.json'))
  w.patch((s) => (s.paneBusy = 0))
  const again = w.run(['spawn', 's2', '--brief', b])
  assert.equal(again.ok, true, JSON.stringify(again))
  assert.equal(w.registry().subs.s2.status, 'running')
})
