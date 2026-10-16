import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { world } from './helpers.mjs'
import { SKILL_CMD, skillCommand } from '../lib/common.mjs'

const DIALOG = [
  ' Bash command                                         │ side panel',
  ' echo pltest-ask ok                                   │  echo pltest-ask ok',
  ' Ask rule Bash(echo pltest-ask*) overrides auto mode. │',
  '                                                      │',
  ' Do you want to proceed?                              │',
  ' ❯ 1. Yes                                             │',
  '   2. No                                              │',
  '                                                      │',
  ' Esc to cancel · Tab to amend                         │',
].join('\n')

// E2E 10/16 (B-2): the sub showed the dialog right after a long `send`; the prompt's tail and the tool line sat above the box.
const DIALOG_AFTER_SEND = [
  '  고치고, 1회차 기록은 상세에 남겨요. "메인에게"의 확인 요청은 이 답으로 닫아요.',
  '',
  '  Running approval relay test command (round 2)',
  '  ⎿  $ echo e2e-ask ok',
  '',
  '────────────────────────────────────────────────────────',
  ' Bash command',
  '',
  '   Run approval relay test command (round 2)',
  '   echo e2e-ask ok',
  '',
  ' Ask rule Bash(echo e2e-ask*) overrides auto mode for this command.',
  ' /permissions to let auto mode decide',
  '',
  ' Do you want to proceed?',
  ' ❯ 1. Yes',
  '   2. No',
  '',
  ' Esc to cancel · Tab to amend',
].join('\n')
const BOX = ['Bash command', 'Run approval relay test command (round 2)', 'echo e2e-ask ok', 'Ask rule Bash(echo e2e-ask*) overrides auto mode for this command.', '/permissions to let auto mode decide']

function withSubs(n) {
  const w = world()
  w.startMain()
  const b = w.brief()
  const out = []
  for (let i = 1; i <= n; i++) out.push(w.run(['spawn', `s${i}`, '--brief', b, '--kind', 'research']))
  return { w, out, b }
}

test('main --dry-run: opus + effort max + name + settings with role env and ctx hooks; writes nothing (B-3)', () => {
  const w = world()
  const r = w.run(['main', '--prefix', 't', '--dry-run'], { env: { PANE_LEAD_PREFIX: '', PANE_LEAD_ROOT: '' } })
  assert.equal(r.ok, true, JSON.stringify(r))
  const c = r.command
  assert.deepEqual(c.slice(0, 5), ['claude', '--model', 'claude-opus-5-5', '--effort', 'max'])
  assert.equal(c[c.indexOf('-n') + 1], 't-main-1')
  assert.equal(c.at(-1), `${SKILL_CMD} start t`)
  assert.equal(r.settings.env.PANE_LEAD_ROLE, 'main')
  assert.equal(r.settings.env.PANE_LEAD_PREFIX, 't')
  assert.ok(r.settings.hooks.UserPromptSubmit && r.settings.hooks.PostToolUse)
  assert.equal(r.settings.promptSuggestionEnabled, undefined, 'the main keeps the user default')
  assert.equal(r.main.sessionId, c[c.indexOf('--session-id') + 1])
  assert.ok(!existsSync(join(w.root, '.research', 'pane-lead')), 'no registry, no settings file')
  // With a lineage already there, dry-run shows the next generation and leaves the registry as it was.
  w.startMain()
  w.patch((s) => delete s.agents['w9:p1'])
  const before = readFileSync(join(w.root, '.research', 'pane-lead', 't', 'registry.json'), 'utf8')
  const r2 = w.run(['main', '--prefix', 't', '--dry-run'], { env: { PANE_LEAD_PREFIX: '', PANE_LEAD_ROOT: '' } })
  assert.equal(r2.main.name, 't-main-2')
  assert.equal(readFileSync(join(w.root, '.research', 'pane-lead', 't', 'registry.json'), 'utf8'), before)
  assert.ok(!existsSync(r2.main.settings))
})

test('main: PANE_LEAD_MODEL / PANE_LEAD_MAIN_EFFORT=none for experiments; refuses a pane that already hosts an agent', () => {
  const w = world()
  const r = w.run(['main', '--prefix', 't', '--dry-run'], { env: { PANE_LEAD_MODEL: 'claude-haiku-5-5', PANE_LEAD_MAIN_EFFORT: 'none', PANE_LEAD_PREFIX: '', PANE_LEAD_ROOT: '' } })
  assert.equal(r.command[2], 'claude-haiku-5-5')
  assert.ok(!r.command.includes('--effort'))
  const bad = w.run(['main', '--prefix', 't', '--dry-run'], { pane: 'w9:p9', env: { PANE_LEAD_PREFIX: '', PANE_LEAD_ROOT: '' } })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /already runs oc-other/)
})

test('spawn: sub settings deny push/PR, env role sub, no --effort, start prompt names brief and result', () => {
  const { w, out, b } = withSubs(1)
  const r = out[0]
  assert.equal(r.ok, true, JSON.stringify(r))
  const a = w.state.agents[r.sub.pane]
  assert.ok(!a.args.includes('--effort'))
  assert.equal(a.args[a.args.indexOf('--model') + 1], 'claude-opus-5-5')
  assert.equal(a.session, r.sub.sessionId)
  const s = JSON.parse(readFileSync(a.args[a.args.indexOf('--settings') + 1], 'utf8'))
  assert.equal(s.env.PANE_LEAD_ROLE, 'sub')
  assert.ok(s.permissions.deny.includes('Bash(git push *)'))
  assert.ok(s.permissions.deny.includes('Bash(gh pr merge *)'))
  assert.equal(s.promptSuggestionEnabled, false)
  assert.equal(s.env.GIT_CONFIG_KEY_0, 'url.pane-lead-sub-push-is-main-only://.pushInsteadOf')
  const guard = s.hooks.PreToolUse[0].hooks[0].command.match(/'([^']+)'/)[1]
  assert.ok(guard.endsWith('/hooks/sub-guard.mjs') && existsSync(guard), guard)
  assert.match(a.prompts[0], new RegExp(b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(a.prompts[0], /\.research\/out\/s1\.md/)
  const reg = w.registry().subs.s1
  assert.equal(reg.status, 'running')
  assert.equal(reg.kind, 'research')
  assert.equal(reg.pane, r.sub.pane)
  assert.deepEqual(w.state.panes[r.sub.pane].env, [], 'role env goes through settings only, never pane --env')
})

test('spawn: placement right of main (main keeps >= 45%), then down the column, then a second column; cap at 5', () => {
  const { w, out } = withSubs(6)
  assert.deepEqual(out.slice(0, 5).map((r) => r.ok), [true, true, true, true, true])
  assert.equal(out[0].placement.pane, 'w9:p1')
  assert.equal(out[0].placement.direction, 'right')
  assert.equal(out[1].placement.direction, 'down')
  assert.equal(out[2].placement.direction, 'down')
  assert.equal(out[3].placement.direction, 'right')
  assert.equal(out[5].ok, false)
  assert.equal(out[5].error, 'cap')
  assert.deepEqual(out[5].data.open, ['s1', 's2', 's3', 's4', 's5'])
  const rects = w.layout()
  assert.ok(rects['w9:p1'].width >= 0.45 * 335, JSON.stringify(rects['w9:p1']))
  assert.ok(Object.values(rects).every((r) => r.width >= 40 && r.height >= 10), JSON.stringify(rects))
})

test('spawn: closed sub frees a slot; dead panes (closed outside pane-lead) are not counted', () => {
  const { w } = withSubs(5)
  assert.equal(w.run(['close', 's2', '--force']).ok, true)
  const b = w.brief('b2')
  assert.equal(w.run(['spawn', 's6', '--brief', b]).ok, true)
  w.patch((s) => {
    delete s.panes[w.registry().subs.s3.pane]
  })
  assert.equal(w.run(['spawn', 's7', '--brief', b]).ok, true)
  assert.equal(w.registry().subs.s3.status, 'gone')
})

test('spawn: rejects bad names, missing brief, a name already live elsewhere', () => {
  const w = world()
  w.startMain()
  assert.equal(w.run(['spawn', 'Bad', '--brief', w.brief()]).code, 2)
  assert.match(w.run(['spawn', 'x', '--brief', '/nope.md']).error, /brief not found/)
  assert.match(w.run(['spawn', 'oc-other', '--brief', w.brief()]).error, /already live/)
})

test('wait: done → result-file summary (<= 15 lines); stale result file → screen tail', () => {
  const { w, out } = withSubs(1)
  const result = out[0].sub.result
  writeFileSync(result, '# pl-x 결과\n\n- made a\n- tests 3/3\n- unverified: z\n\n## 상세\nlong text\n')
  let r = w.run(['wait', 's1'])
  assert.equal(r.status, 'done')
  assert.equal(r.summary, '# pl-x 결과\n- made a\n- tests 3/3\n- unverified: z')
  const old = new Date(Date.now() - 3600_000)
  utimesSync(result, old, old)
  w.patch((s) => (s.agents[out[0].sub.pane].screen = 'line a\n⏺ finished\n✻ Worked for 3s\n────\n❯\n────\n  ⏵⏵ auto mode on'))
  r = w.run(['wait', 's1'])
  assert.equal(r.result, null)
  assert.equal(r.tail, 'line a\n⏺ finished\n✻ Worked for 3s')
})

test('wait: blocked → only the dialog (side panel cut); approve picks "Yes" (1), deny picks "No" (2)', () => {
  const { w, out } = withSubs(1)
  const pane = out[0].sub.pane
  w.patch((s) => (s.script.s1 = [{ status: 'blocked', screen: DIALOG }]))
  const r = w.run(['wait', 's1'])
  assert.equal(r.status, 'blocked')
  assert.equal(r.dialog.question, 'Do you want to proceed?')
  assert.deepEqual(r.dialog.options, ['1. Yes', '2. No'])
  assert.ok(r.dialog.context.includes('echo pltest-ask ok'))
  assert.ok(!JSON.stringify(r).includes('side panel'))
  const a = w.run(['approve', 's1'])
  assert.equal(a.ok, true, JSON.stringify(a))
  assert.equal(a.answered, 'Yes')
  assert.deepEqual(w.state.agents[pane].keys, ['1'])
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: DIALOG }))
  const d = w.run(['deny', 's1'])
  assert.equal(d.answered, 'No')
  assert.deepEqual(w.state.agents[pane].keys, ['1', '2'])
})

test('wait: dialog.context keeps only the dialog box, not the screen lines above it (B-2)', () => {
  const { w, out } = withSubs(1)
  w.patch((s) => (s.script.s1 = [{ status: 'blocked', screen: DIALOG_AFTER_SEND }]))
  assert.deepEqual(w.run(['wait', 's1']).dialog.context, BOX)
  // Without the top border (not captured), the tool line still ends the box.
  const noBorder = DIALOG_AFTER_SEND.split('\n').filter((l) => !l.startsWith('───')).join('\n')
  w.patch((s) => Object.assign(s.agents[out[0].sub.pane], { status: 'blocked', screen: noBorder }))
  const a = w.run(['approve', 's1'])
  assert.equal(a.answered, 'Yes')
  assert.deepEqual(a.context, BOX)
})

test('approve: refuses when not blocked, when no plain "Yes" exists; --always picks "don\'t ask again"', () => {
  const { w, out } = withSubs(1)
  const pane = out[0].sub.pane
  w.patch((s) => (s.agents[pane].status = 'idle'))
  assert.match(w.run(['approve', 's1']).error, /not blocked: the dialog is no longer open/)
  const three = 'Do you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again for: git status *\n  3. No'
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: three }))
  assert.equal(w.run(['approve', 's1', '--always']).answered, "Yes, and don't ask again for: git status *")
  assert.deepEqual(w.state.agents[pane].keys, ['2'])
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: 'Which one?\n❯ 1. Red\n  2. Blue' }))
  assert.match(w.run(['approve', 's1']).error, /no "Yes" option/)
})

test('approve after the dialog already closed: no keys sent, error names the next step', () => {
  const { w, out } = withSubs(1)
  const pane = out[0].sub.pane
  // Answered in the sub pane: herdr already reports working.
  w.patch((s) => Object.assign(s.agents[pane], { status: 'working', screen: '⏺ Bash(echo ok)\n  ⎿  ok' }))
  let r = w.run(['approve', 's1'])
  assert.equal(r.ok, false)
  assert.match(r.error, /no longer open/)
  assert.match(r.next, /pane-lead wait s1/)
  // herdr still says blocked for a moment, but the screen has no dialog.
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked' }))
  r = w.run(['approve', 's1'])
  assert.match(r.error, /no numbered dialog/)
  assert.match(r.next, /pane-lead wait s1/)
  assert.equal(w.run(['deny', 's1']).ok, false)
  assert.equal(w.state.agents[pane].keys, undefined)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent send-keys')), w.state.log.join('\n'))
})

test('approve: classifier escalation needs --over-classifier', () => {
  const { w, out } = withSubs(1)
  const pane = out[0].sub.pane
  const scr = ' │ Auto mode classifier requires confirmation for this command.\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No'
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: scr }))
  assert.match(w.run(['approve', 's1']).error, /classifier escalation/)
  assert.equal(w.state.agents[pane].keys, undefined)
  assert.equal(w.run(['approve', 's1', '--over-classifier']).answered, 'Yes')
})

test('protection: foreign agents and panes are never touched', () => {
  const { w } = withSubs(1)
  for (const cmd of [['approve', 'oc-other'], ['deny', 'oc-other'], ['close', 'oc-other'], ['wait', 'oc-other'], ['send', 'oc-other', 'hi']]) {
    const r = w.run(cmd)
    assert.equal(r.ok, false, cmd.join(' '))
    assert.match(r.error, /not an open sub/)
  }
  // A registry sub whose pane now hosts someone else is refused too.
  const pane = w.registry().subs.s1.pane
  w.patch((s) => (s.agents[pane].name = 'intruder'))
  assert.match(w.run(['close', 's1']).error, /hosts intruder/)
  assert.match(w.run(['approve', 's1']).error, /not running/)
  const log = w.state.log.join('\n')
  assert.ok(!/close w9:p9|send-keys oc-other|send-keys w9:p9|prompt oc-other/.test(log), log)
  assert.ok(w.state.panes['w9:p9'])
})

test('close: refuses a working sub without --force; marks closed', () => {
  const { w, out } = withSubs(1)
  w.patch((s) => (s.agents[out[0].sub.pane].status = 'working'))
  assert.match(w.run(['close', 's1']).error, /working/)
  assert.equal(w.run(['close', 's1', '--force']).ok, true)
  assert.equal(w.registry().subs.s1.status, 'closed')
  assert.ok(!w.state.panes[out[0].sub.pane])
})

test('handover → takeover-done: order, pane checks, focus, generation, new main fills the old area', () => {
  const w = world()
  w.startMain()
  const doc = join(w.root, 'handover.md')
  writeFileSync(doc, '# handover\n')
  assert.match(w.run(['handover', '--doc', doc], { pane: 'w9:p9' }).error, /only the current main/)
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.equal(h.next_main.name, 't-main-2')
  const a = w.state.agents[h.next_main.pane]
  assert.ok(a.args.includes('--effort') && a.args[a.args.indexOf('--effort') + 1] === 'max')
  assert.equal(a.prompts[0], `${SKILL_CMD} takeover ${doc}`)
  assert.equal(JSON.parse(readFileSync(a.args[a.args.indexOf('--settings') + 1], 'utf8')).env.PANE_LEAD_ROLE, 'main')
  assert.equal(w.registry().pending.name, 't-main-2')
  assert.match(w.run(['handover', '--doc', doc]).error, /already in progress/)
  // takeover-done must come from the new pane.
  assert.match(w.run(['takeover-done']).error, /must run in the new main pane/)
  // The user is looking at the old main (main tab), so the focus follows the new main.
  w.patch((s) => Object.assign(s, { focused: 'w9:p1', tabFocus: { 'w9:t1': 'w9:p1' } }))
  const before = w.state.log.length
  const t = w.run(['takeover-done'], { pane: h.next_main.pane })
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.equal(t.closed, 'w9:p1')
  assert.equal(t.filled, true)
  assert.equal(t.focused, true)
  assert.equal(t.focus, 'moved')
  assert.equal(t.tab_focus, h.next_main.pane)
  const log = w.state.log.slice(before)
  const iWait = log.findIndex((l) => l.startsWith('agent wait w9:p1'))
  const iClose = log.findIndex((l) => l === 'pane close w9:p1')
  const iFocus = log.findIndex((l) => l === 'agent focus t-main-2')
  assert.ok(iWait >= 0 && iWait < iClose && iClose < iFocus, log.join('\n'))
  assert.equal(w.state.focused, h.next_main.pane)
  const reg = w.registry()
  assert.equal(reg.main.generation, 2)
  assert.equal(reg.main.pane, h.next_main.pane)
  assert.equal(reg.pending, null)
  assert.equal(reg.mains.at(-1).end, 'handover')
})

test('takeover-done --no-focus: no focus call; subs survive the handover', () => {
  const { w } = withSubs(2)
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, 'x')
  const h = w.run(['handover', '--doc', doc])
  w.patch((s) => (s.agents['w9:p1'].status = 'idle'))
  const t = w.run(['takeover-done', '--no-focus'], { pane: h.next_main.pane })
  assert.equal(t.focused, false)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent focus')))
  assert.equal(w.state.focused, undefined)
  const st = w.run(['status', '--no-ctx'], { pane: h.next_main.pane })
  assert.equal(st.main.name, 't-main-2')
  assert.deepEqual(st.subs.map((s) => s.name), ['s1', 's2'])
  // The next spawn places relative to the new main pane.
  assert.equal(w.run(['spawn', 's3', '--brief', w.brief()], { pane: h.next_main.pane }).ok, true)
})

test('takeover-done: user on another tab → global focus untouched; tab-local focus reported (focus plan A, 10/16)', () => {
  const { w, out } = withSubs(1)
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, 'x')
  const h = w.run(['handover', '--doc', doc])
  w.patch((s) => (s.agents['w9:p1'].status = 'idle'))
  // The user watches the foreign tab w9:t2; inside the main tab herdr hands the closed pane's focus to the sub.
  const sub = out[0].sub.pane
  w.patch((s) => Object.assign(s, { focused: 'w9:p9', tabFocus: { 'w9:t1': 'w9:p1' }, closeFocus: sub }))
  const t = w.run(['takeover-done'], { pane: h.next_main.pane })
  assert.equal(t.ok, true, JSON.stringify(t))
  assert.equal(t.focused, false)
  assert.equal(t.focus, 'left alone: the user is on tab w9:t2')
  assert.equal(t.tab_focus, sub)
  assert.match(t.tab_focus_note, /focuses/)
  assert.ok(!w.state.log.some((l) => l.startsWith('agent focus') || l.startsWith('pane focus') || l.startsWith('tab focus')), w.state.log.join('\n'))
  assert.equal(w.state.focused, 'w9:p9')
})

test('takeover-done: no focused pane reported by herdr → focus left alone', () => {
  const w = world()
  w.startMain()
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, 'x')
  const h = w.run(['handover', '--doc', doc])
  const t = w.run(['takeover-done'], { pane: h.next_main.pane })
  assert.equal(t.focused, false)
  assert.equal(t.focus, 'left alone: herdr reports no focused tab')
  assert.ok(!w.state.log.some((l) => l.startsWith('agent focus')))
})

test('takeover-done refuses to close a pane whose agent is not the registered old main', () => {
  const w = world()
  w.startMain()
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, 'x')
  const h = w.run(['handover', '--doc', doc])
  w.patch((s) => (s.agents['w9:p1'].name = 'someone-else'))
  assert.match(w.run(['takeover-done'], { pane: h.next_main.pane }).error, /hosts someone-else/)
  assert.ok(w.state.panes['w9:p1'])
})

test('status: rows for main and subs with state and paths', () => {
  const { w } = withSubs(2)
  const s = w.run(['status', '--no-ctx'])
  assert.equal(s.main.name, 't-main-1')
  assert.equal(s.cap, '2/5')
  assert.equal(s.subs[0].state, 'working')
  assert.ok(s.subs[0].brief.endsWith('b.md'))
})

test('ctx <name>: reads the transcript through lib/ctx.mjs', () => {
  const { w, out } = withSubs(1)
  const sid = out[0].sub.sessionId
  const dir = join(w.root, '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 99000, output_tokens: 10 }
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage } }) + '\n')
  const r = w.run(['ctx', 's1'])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.percent, 10)
  assert.equal(w.run(['wait', 's1']).ctx, 10)
  // A simulated window in the main's env does not change the sub's figure (C-3).
  const env = { PANE_LEAD_CTX_WINDOW: '200000' }
  assert.equal(w.run(['ctx', 's1'], { env }).percent, 10)
  assert.equal(w.run(['wait', 's1'], { env }).ctx, 10)
  assert.equal(w.run(['status'], { env }).subs[0].ctx, 10)
})

test('status: the main row matches ctx --self when the caller is that main; others see the real window', () => {
  const w = world()
  const sid = w.startMain().main.sessionId
  const dir = join(w.root, '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  const usage = { input_tokens: 1000, cache_creation_input_tokens: 0, cache_read_input_tokens: 99000, output_tokens: 10 }
  writeFileSync(join(dir, `${sid}.jsonl`), JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage } }) + '\n')
  const env = { PANE_LEAD_CTX_WINDOW: '200000' }
  const self = w.run(['ctx', '--self'], { env })
  assert.equal(self.ok, true, JSON.stringify(self))
  assert.equal(self.percent, 50)
  assert.equal(w.run(['status'], { env }).main.ctx, self.percent)
  // Without the simulated window both use the real 1M window.
  assert.equal(w.run(['status']).main.ctx, w.run(['ctx', '--self']).percent)
  // Another pane (not the main) reading status measures the main with the real window.
  assert.equal(w.run(['status'], { env, pane: 'w9:p9' }).main.ctx, 10)
})

test('handover: a simulated PANE_LEAD_CTX_WINDOW is carried into the next main settings; absent in real use', () => {
  const w = world()
  w.startMain()
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, 'x')
  const envOf = (h) => {
    const a = w.state.agents[h.next_main.pane]
    return JSON.parse(readFileSync(a.args[a.args.indexOf('--settings') + 1], 'utf8')).env
  }
  const h = w.run(['handover', '--doc', doc], { env: { PANE_LEAD_CTX_WINDOW: '127500' } })
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.equal(envOf(h).PANE_LEAD_CTX_WINDOW, '127500')
  const w2 = world()
  w2.startMain()
  writeFileSync(join(w2.root, 'h.md'), 'x')
  const h2 = w2.run(['handover', '--doc', join(w2.root, 'h.md')])
  const a2 = w2.state.agents[h2.next_main.pane]
  assert.equal(JSON.parse(readFileSync(a2.args[a2.args.indexOf('--settings') + 1], 'utf8')).env.PANE_LEAD_CTX_WINDOW, undefined)
})

test('skillCommand: /<plugin>:pane-lead inside a plugin, /pane-lead otherwise', () => {
  const d = mkdtempSync(join(tmpdir(), 'pl-sc-'))
  const home = join(d, 'skills', 'pane-lead')
  mkdirSync(home, { recursive: true })
  assert.equal(skillCommand(home), '/pane-lead')
  mkdirSync(join(d, '.claude-plugin'))
  writeFileSync(join(d, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'demo-kit' }))
  assert.equal(skillCommand(home), '/demo-kit:pane-lead')
})

test('pane-lead-shim: runs the CLI of the installed plugin version from installed_plugins.json', async () => {
  const { spawnSync } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const shim = fileURLToPath(new URL('../bin/pane-lead-shim.mjs', import.meta.url))
  const d = mkdtempSync(join(tmpdir(), 'pl-shim-'))
  const at = (v) => join(d, 'cache', 'mk', 'harness-james', v)
  for (const v of ['0.1.0', '0.2.0']) {
    mkdirSync(join(at(v), 'skills', 'pane-lead', 'bin'), { recursive: true })
    writeFileSync(join(at(v), 'skills', 'pane-lead', 'bin', 'pane-lead.mjs'), `console.log(JSON.stringify({ v: '${v}', args: process.argv.slice(2) }))`)
  }
  const run = (record, ...args) => {
    mkdirSync(join(d, 'plugins'), { recursive: true })
    writeFileSync(join(d, 'plugins', 'installed_plugins.json'), JSON.stringify(record))
    return spawnSync(process.execPath, [shim, ...args], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: d } })
  }
  const r = run({ version: 2, plugins: {
    'harness-james@mk': [
      { scope: 'project', installPath: at('0.1.0'), lastUpdated: '2026-01-02T00:00:00Z' },
      { scope: 'user', installPath: at('0.2.0'), lastUpdated: '2026-01-01T00:00:00Z' },
    ],
    'other@mk': [{ scope: 'user', installPath: '/nope', lastUpdated: '2026-02-01T00:00:00Z' }],
  } }, 'status', '--no-ctx')
  assert.equal(r.status, 0)
  assert.deepEqual(JSON.parse(r.stdout), { v: '0.2.0', args: ['status', '--no-ctx'] })
  const miss = run({ version: 2, plugins: {} }, 'status')
  assert.equal(miss.status, 1)
  assert.equal(JSON.parse(miss.stdout).ok, false)
  const inst = spawnSync(process.execPath, [shim, '--install', join(d, 'bin')], { encoding: 'utf8' })
  assert.equal(JSON.parse(inst.stdout).ok, true)
  assert.ok(existsSync(join(d, 'bin', 'pane-lead')))
})
