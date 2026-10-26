import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { world } from './helpers.mjs'
import { loginScreen } from '../lib/dialog.mjs'

// Screens measured 2026-10-23 (2.1.309) with an empty CLAUDE_CONFIG_DIR; herdr reported both as idle/ready.
const THEME = [" Let's get started.", ' Choose the text style that looks best with your terminal', ' To change this later, run /theme', '     Auto (match terminal)', ' ❯ ✔ Dark mode'].join('\n')
const LOGIN = [' Welcome to Claude Code v2.1.309', ' Select login method:', ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing'].join('\n')
const READY = ['╭───────────────────────────╮', '│ ✻ Welcome back!           │', '╰───────────────────────────╯', '', '> '].join('\n')

/** Lineage t with an idle main in w9:p1, a fresh doc and a second profile dir. */
function setup() {
  const w = world()
  w.startMain()
  w.patch((s) => (s.agents['w9:p1'].status = 'idle'))
  const doc = join(w.root, '.research', 'pane-lead', 't', 'handover', 'main-1.md')
  mkdirSync(join(doc, '..'), { recursive: true })
  writeFileSync(doc, '# handover\n')
  const profile = join(w.root, 'profile-b')
  mkdirSync(profile)
  return { w, doc, profile }
}
const settingsFiles = (w) => {
  const d = join(w.root, '.research', 'pane-lead', 't', 'settings')
  return existsSync(d) ? readdirSync(d) : []
}

test('loginScreen: theme picker, login method, OAuth paste prompt; a ready screen is not one', () => {
  assert.match(loginScreen(THEME), /Choose the text style/)
  assert.match(loginScreen(LOGIN), /Select login method/)
  assert.match(loginScreen(' Paste code here if prompted >'), /Paste code/)
  assert.equal(loginScreen(READY), null)
  assert.equal(loginScreen(undefined), null)
})

test('default profile dir: handover --config-dir ~/.claude, a symlink to it, and an inherited ~/.claude put no env on the pane', () => {
  for (const variant of ['tilde', 'symlink', 'inherited', 'inherited-spawn']) {
    const w = world()
    w.startMain()
    const home = join(w.root, '.claude') // helpers set HOME to the world root
    mkdirSync(home)
    symlinkSync(home, join(w.root, 'link'))
    writeFileSync(join(w.root, 'h.md'), 'x')
    let r
    if (variant === 'tilde') r = w.run(['handover', '--doc', join(w.root, 'h.md'), '--config-dir', '~/.claude'], { env: { CLAUDE_CONFIG_DIR: '/x/profile-b' } })
    if (variant === 'symlink') r = w.run(['handover', '--doc', join(w.root, 'h.md'), '--config-dir', join(w.root, 'link')])
    if (variant === 'inherited') r = w.run(['handover', '--doc', join(w.root, 'h.md')], { env: { CLAUDE_CONFIG_DIR: home } })
    if (variant === 'inherited-spawn') {
      r = w.run(['spawn', 's1', '--brief', w.brief()], { env: { CLAUDE_CONFIG_DIR: home + '/' } })
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.deepEqual(w.state.panes[r.sub.pane].env, [], variant)
      continue
    }
    assert.equal(r.ok, true, `${variant}: ${JSON.stringify(r)}`)
    assert.deepEqual(w.state.panes[r.next_main.pane].env, [], variant)
    assert.equal(r.next_main.config_dir, undefined, variant)
  }
})

test('login screen: handover stops before the prompt, closes the new pane, clears pending; the old main keeps going', () => {
  const { w, doc, profile } = setup()
  w.patch((s) => (s.startScreen = THEME))
  const before = Object.keys(w.state.panes).length
  const r = w.run(['handover', '--doc', doc, '--config-dir', profile])
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(r.error, 'login-required')
  assert.equal(r.data.config_dir, profile)
  assert.match(r.data.screen, /Choose the text style/)
  assert.match(r.next, /CLAUDE_CONFIG_DIR=.*profile-b claude/)
  assert.match(r.next, /pane-lead handover again/)
  assert.ok(!w.state.panes[r.data.pane], 'new pane closed')
  assert.equal(Object.keys(w.state.panes).length, before)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent prompt')), 'no takeover prompt sent')
  assert.deepEqual(settingsFiles(w), [])
  const reg = w.registry()
  assert.equal(reg.pending, null)
  assert.equal(reg.main.name, 't-main-1')
  // After the login is fixed the same handover goes through.
  w.patch((s) => (s.startScreen = READY))
  const ok = w.run(['handover', '--doc', doc, '--config-dir', profile])
  assert.equal(ok.ok, true, JSON.stringify(ok))
  assert.equal(ok.next_main.name, 't-main-2')
})

test('login screen: --tab closes the new tab; agent_not_ready with a login screen is login-required too', () => {
  const { w, doc, profile } = setup()
  const tabsBefore = Object.keys(w.state.tabs).length
  w.patch((s) => (s.startScreen = LOGIN))
  const r = w.run(['handover', '--doc', doc, '--config-dir', profile, '--tab', 'x'])
  assert.equal(r.error, 'login-required', JSON.stringify(r))
  assert.equal(Object.keys(w.state.tabs).length, tabsBefore, 'the new tab went with its only pane')
  assert.equal(w.registry().pending, null)
  w.patch((s) => Object.assign(s, { startStatus: 'blocked', startScreen: ' Paste code here if prompted >' }))
  const r2 = w.run(['handover', '--doc', doc])
  assert.equal(r2.error, 'login-required', JSON.stringify(r2))
  assert.equal(r2.data.config_dir, null)
  assert.match(r2.next, /no CLAUDE_CONFIG_DIR/)
  assert.ok(!w.state.panes[r2.data.pane])
  assert.equal(w.registry().pending, null)
  // A blocked start without a login screen (e.g. the trust dialog) keeps the old "did not start" path.
  w.patch((s) => (s.startScreen = ' Do you trust the files in this folder?\n ❯ 1. Yes, proceed\n   2. No, exit'))
  const r3 = w.run(['handover', '--doc', doc])
  assert.match(r3.error, /did not start/)
  assert.match(r3.next, /pane-lead handover again/)
})

test('login screen drawn late: the second read (1 s after start) still catches it; settings file removed', () => {
  const { w, doc, profile } = setup()
  w.patch((s) => (s.startScreens = ['➜  root ', THEME]))
  const r = w.run(['handover', '--doc', doc, '--config-dir', profile])
  assert.equal(r.error, 'login-required', JSON.stringify(r))
  assert.match(r.data.screen, /Choose the text style/)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent prompt')))
  assert.deepEqual(settingsFiles(w), [])
})

test('pending race: a pending written between the checks and the record wins; the new pane and settings are dropped', () => {
  const { w, doc, profile } = setup()
  const regFile = join(w.root, '.research', 'pane-lead', 't', 'registry.json')
  w.patch((s) => (s.race = { registry: regFile, pending: { generation: 2, name: 't-main-2', pane: 'w9:p77', startedAt: new Date().toISOString() } }))
  const r = w.run(['handover', '--doc', doc, '--config-dir', profile])
  assert.equal(r.error, 'pending', JSON.stringify(r))
  assert.equal(r.data.pane, 'w9:p77')
  assert.equal(w.registry().pending.pane, 'w9:p77', 'the other writer keeps its pending')
  assert.ok(w.state.log.some((l) => l.startsWith('pane split w9:p1')))
  assert.ok(w.state.log.some((l) => /^pane close w9:p1\d\d$/.test(l)), 'new pane closed')
  assert.ok(!w.state.log.some((l) => l.startsWith('agent start')))
  assert.deepEqual(settingsFiles(w), [], 'settings removed')
})

test('pending race: the main changed meanwhile (another takeover finished) → refused, nothing left behind', () => {
  const { w, doc, profile } = setup()
  const regFile = join(w.root, '.research', 'pane-lead', 't', 'registry.json')
  const main = { ...w.registry().main, generation: 2, name: 't-main-2', pane: 'w9:p79' }
  w.patch((s) => (s.race = { registry: regFile, main, pending: null }))
  const r = w.run(['handover', '--doc', doc, '--config-dir', profile])
  assert.equal(r.error, 'pending', JSON.stringify(r))
  assert.equal(r.data.main, 't-main-2')
  assert.equal(w.registry().pending, null)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent start')))
  assert.deepEqual(settingsFiles(w), [])
})
