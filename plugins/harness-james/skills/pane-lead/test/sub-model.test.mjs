// Sub model (Opus; with --fable by the account's Fable weekly limit), the pane-sub start prompt, and the
// model-limit dialog (2026-11-16; Opus by default since 2026-11-17).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { usageAnswer, world } from './helpers.mjs'
import { DEFAULT_REASON, FABLE, OPUS, SWITCH_AT, accountKey, chooseModel, fableWindow } from '../lib/fable-limit.mjs'
import { SUB_SKILL_CMD, findSubSkill, layerFor, layerSwitch, startPrompt } from '../lib/sub.mjs'
import { skillCommand } from '../lib/common.mjs'
import { limitNotice, parseDialog, switchOption } from '../lib/dialog.mjs'
import { progressLine, screenTail, topSummary } from '../lib/summary.mjs'
import { contextUsage, windowFor } from '../lib/ctx.mjs'

const HOUR = 3600_000
const record = (utilization, resetsAt = new Date(Date.now() + 72 * HOUR).toISOString()) => ({ utilization, resetsAt, at: new Date().toISOString() })

// The limit dialog as Claude Code 2.1.325 builds it (strings from the binary; the real screen is unseen), drawn
// the way its other choice dialogs are: header, question, numbered labels with the description on the next line.
const LIMIT_DIALOG = [
  '────────────────────────────────────────────────────────',
  ' ☐ Credits',
  '',
  " You've reached your Fable limit for this week. Switch models?",
  '',
  ' ❯ 1. Switch to Opus 5.5',
  '      For this session',
  '   2. Not now',
  '      Fable 5.2 needs usage credits',
  '',
  ' Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n')
// Credits on: the second choice keeps the model.
const CREDITS_DIALOG = [
  ' Fable 5.2 now runs on usage credits. Switch models?',
  '',
  '   1. Switch to Opus 5.5',
  '      For this session',
  ' ❯ 2. Continue with usage credits',
  '      Stay on Fable 5.2 for this session',
].join('\n')
const PERMISSION_ABOUT_CREDITS = [' Bash command', '   grep -rn "usage credits" docs/', '', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No'].join('\n')
const STOPPED = ['⏺ Claude stopped here because Fable 5.2 now requires usage credits.', '  Send a message to be asked again, or switch models with /model', '────', '❯', '────', '  ⏵⏵ auto mode on'].join('\n')

function started(env) {
  const w = world()
  w.startMain()
  return { w, b: w.brief(), spawn: (name, ...more) => w.run(['spawn', name, '--brief', w.brief(), ...more], { env }) }
}
const modelOf = (w, r) => {
  const a = w.state.agents[r.sub.pane]
  return a.args[a.args.indexOf('--model') + 1]
}

test('fableWindow: the Fable row of a get_usage answer, percent 0-100; none listed → null', () => {
  const reset = '2026-11-21T12:00:00.345492+00:00'
  assert.deepEqual(fableWindow(usageAnswer(29, { resetsAt: reset })), { utilization: 29, resetsAt: '2026-11-21T12:00:00.000Z' })
  // The server's time wobbles under a second around the minute (E2E: .277Z, .701Z, 11:59:59.746Z): one value.
  for (const t of ['2026-11-21T12:00:00.277Z', '2026-11-21T12:00:00.701Z', '2026-11-21T11:59:59.746Z'])
    assert.equal(fableWindow(usageAnswer(29, { resetsAt: t })).resetsAt, '2026-11-21T12:00:00.000Z')
  // Only the server's own rows (no model_scoped projection).
  const rows = usageAnswer(91, { resetsAt: reset })
  delete rows.rate_limits.model_scoped
  assert.equal(fableWindow(rows).utilization, 91)
  // Another model's scoped window is not the Fable one.
  const other = usageAnswer(null)
  other.rate_limits.model_scoped = [{ display_name: 'Opus', utilization: 99, resets_at: reset }]
  other.rate_limits.limits.push({ kind: 'weekly_scoped', percent: 99, resets_at: reset, scope: { model: { display_name: 'Opus' } } })
  assert.equal(fableWindow(other), null)
  assert.equal(fableWindow(usageAnswer(null)), null)
  assert.equal(fableWindow({ rate_limits_available: false, rate_limits: null }), null)
  assert.equal(fableWindow(undefined), null)
})

test('chooseModel: Opus unless Fable was asked for; then Fable under 90%, with no record, or past the reset, Opus from 90%; --model and env win', () => {
  const env = {}
  assert.equal(SWITCH_AT, 90)
  // No Fable asked for: Opus whatever the reading.
  assert.deepEqual(chooseModel({ env }), { model: OPUS, reason: DEFAULT_REASON })
  assert.deepEqual(chooseModel({ record: record(3), env }), { model: OPUS, reason: DEFAULT_REASON })
  assert.deepEqual(chooseModel({ record: record(3), fable: false, env }), { model: OPUS, reason: DEFAULT_REASON })
  const fable = true
  assert.deepEqual(chooseModel({ record: record(29), fable, env }), { model: FABLE, reason: 'Fable weekly 29% < 90%' })
  assert.equal(chooseModel({ record: record(89.9), fable, env }).model, FABLE)
  assert.deepEqual(chooseModel({ record: record(90), fable, env }), { model: OPUS, reason: 'Fable weekly 90% >= 90%' })
  assert.equal(chooseModel({ record: record(100), fable, env }).model, OPUS)
  assert.deepEqual(chooseModel({ record: null, fable, env }), { model: FABLE, reason: 'no Fable limit record' })
  assert.equal(chooseModel({ record: record(null), fable, env }).model, FABLE, 'an account without a Fable window')
  const past = record(97, new Date(Date.now() - HOUR).toISOString())
  assert.equal(chooseModel({ record: past, fable, env }).model, FABLE, 'the 97% belongs to the window that already reset')
  assert.match(chooseModel({ record: past, fable, env }).reason, /reset/)
  assert.deepEqual(chooseModel({ record: record(97), override: 'fable', env }), { model: FABLE, reason: '--model fable' })
  assert.deepEqual(chooseModel({ record: record(3), override: 'opus', fable, env }), { model: OPUS, reason: '--model opus' })
  assert.equal(chooseModel({ record: record(97), env: { PANE_LEAD_MODEL: 'claude-haiku-5-5' } }).model, 'claude-haiku-5-5')
  assert.equal(chooseModel({ record: record(3), fable, env: { PANE_LEAD_MODEL: 'claude-haiku-5-5' } }).model, 'claude-haiku-5-5')
  assert.equal(chooseModel({ record: record(97), env: { PANE_LEAD_MODEL: 'x', PANE_LEAD_SUB_MODEL: 'claude-haiku-5-5' } }).reason, 'PANE_LEAD_SUB_MODEL')
})

test('accountKey: default for no profile or ~/.claude, dir-… for any other profile dir', () => {
  assert.equal(accountKey(undefined), 'default')
  assert.equal(accountKey(null), 'default')
  assert.equal(accountKey(join(process.env.HOME, '.claude')), 'default')
  assert.equal(accountKey('/Users/me/.claude-other'), 'dir-Users-me-claude-other')
  assert.equal(accountKey('/Users/me/.claude-x'), 'dir-Users-me-claude-x')
})

test('model layer: fable for a Fable model while the switch is on; the off file turns it off for Fable too', () => {
  const env = { PANE_LEAD_STATE_DIR: mkdtempSync(join(tmpdir(), 'pl-layer-')) }
  assert.equal(layerFor(FABLE, env), 'fable')
  assert.equal(layerFor(OPUS, env), 'none')
  assert.equal(layerSwitch('status', env), 'on')
  assert.equal(layerSwitch('off', env), 'off')
  assert.equal(layerFor(FABLE, env), 'none')
  assert.equal(layerSwitch('on', env), 'on')
  assert.equal(layerFor(FABLE, env), 'fable')
})

test('startPrompt: /<plugin>:pane-sub <kind> <layer> <brief> <result>; a path with a space is quoted', () => {
  assert.equal(SUB_SKILL_CMD, '/harness-james:pane-sub', 'inside the plugin the command carries its name')
  assert.equal(startPrompt({ kind: 'normal', layer: 'fable', brief: '/r/.research/tasks/a.md', result: '/r/.research/out/a.md' }), '/harness-james:pane-sub normal fable /r/.research/tasks/a.md /r/.research/out/a.md')
  assert.equal(startPrompt({ kind: 'run', layer: 'none', brief: '/my docs/a.md', result: '/r/a.md' }), '/harness-james:pane-sub run none "/my docs/a.md" /r/a.md')
  assert.equal(startPrompt({ kind: 'run', layer: 'none', brief: '/a.md', result: '/b.md' }, '/pane-sub'), '/pane-sub run none /a.md /b.md')
  const loose = mkdtempSync(join(tmpdir(), 'pl-userskill-'))
  assert.equal(skillCommand(join(loose, 'skills', 'pane-lead'), 'pane-sub'), '/pane-sub', 'as a user skill the command is the bare name')
})

test('dialog: the weekly-limit dialog is kind model-limit; a permission dialog that mentions credits is not', () => {
  const d = parseDialog(LIMIT_DIALOG)
  assert.equal(d.kind, 'model-limit')
  assert.equal(d.question, "You've reached your Fable limit for this week. Switch models?")
  assert.deepEqual(d.options.map((o) => o.label), ['Switch to Opus 5.5 For this session', 'Not now'])
  assert.equal(switchOption(d), 1)
  const c = parseDialog(CREDITS_DIALOG)
  assert.equal(c.kind, 'model-limit')
  assert.equal(switchOption(c), 1)
  // Question not captured (another layout): the two choice labels still tell.
  assert.equal(parseDialog('❯ 1. Switch to Opus 5.5\n  2. Not now').kind, 'model-limit')
  assert.equal(parseDialog(PERMISSION_ABOUT_CREDITS).kind, 'permission')
  assert.equal(switchOption(parseDialog(PERMISSION_ABOUT_CREDITS)), undefined)
  // Several targets: the Opus one.
  assert.equal(switchOption(parseDialog(' Switch models?\n ❯ 1. Switch to Sonnet 5.5\n   2. Switch to Opus 5.5\n   3. Not now')), 2)
  // An unknown shape (no numbered options) is not read at all: the dialog:null path.
  assert.equal(parseDialog(" You've reached your Fable limit for this week. Switch models?\n  ❯ Switch to Opus 5.5\n    Not now"), null)
})

test('limitNotice: a stop line about usage credits or /model; plain work output is not one', () => {
  assert.match(limitNotice('⏺ Claude stopped here because Fable 5.2 now requires usage credits.\n  switch models with /model'), /requires usage credits/)
  assert.match(limitNotice('Fable limit reached · continuing on Opus 5.5'), /limit reached/)
  assert.equal(limitNotice('⏺ wrote the result file\n✻ Worked for 3m'), null)
})

test('progressLine: the 진행: line right under the title, until the summary replaces it', () => {
  const working = topSummary('# ps-x 결과\n\n진행: 11:40 · 2/4 단계 구현 중 · 남은 것 테스트\n\n---\n\n## 상세\n')
  assert.equal(progressLine(working), '진행: 11:40 · 2/4 단계 구현 중 · 남은 것 테스트')
  assert.equal(progressLine(topSummary('# ps-x 결과\n\n- 다 했어요\n- 진행: 이 줄은 요약 안의 한 줄\n\n---\n')), null)
  assert.equal(progressLine(null), null)
})

test('ctx: claude-fable-5-2 has the 1M window; after a model switch the last response decides', () => {
  assert.equal(windowFor('claude-fable-5-2', {}), 1_000_000)
  const p = join(mkdtempSync(join(tmpdir(), 'pl-fable-')), 's.jsonl')
  const asst = (model, read) => JSON.stringify({ type: 'assistant', message: { model, usage: { input_tokens: 0, cache_read_input_tokens: read, output_tokens: 1 } } })
  writeFileSync(p, asst('claude-fable-5-2', 300_000) + '\n')
  let u = contextUsage(p)
  assert.deepEqual([u.model, u.window, u.percent, u.windowKnown], ['claude-fable-5-2', 1_000_000, 30, true])
  writeFileSync(p, asst('claude-fable-5-2', 300_000) + '\n' + asst('claude-opus-5-5', 320_000) + '\n')
  u = contextUsage(p)
  assert.deepEqual([u.model, u.percent], ['claude-opus-5-5', 32])
})

test('spawn: with no model asked for the sub runs Opus, no model layer, and the Fable limit is not read', () => {
  const { w, b, spawn } = started()
  w.usage(usageAnswer(3))
  const r = w.run(['spawn', 's1', '--brief', b])
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(modelOf(w, r), 'claude-opus-5-5')
  assert.ok(!w.state.agents[r.sub.pane].args.includes('--effort'))
  assert.deepEqual([r.sub.model, r.sub.model_reason, r.sub.layer], ['claude-opus-5-5', DEFAULT_REASON, 'none'])
  assert.equal(w.state.agents[r.sub.pane].prompts[0], `/harness-james:pane-sub normal none ${b} ${r.sub.result}`)
  const reg = w.registry().subs.s1
  assert.deepEqual([reg.model, reg.modelReason, reg.layer, reg.fable], ['claude-opus-5-5', DEFAULT_REASON, 'none', undefined])
  assert.equal(r.fable_probe, undefined)
  assert.equal(w.usageCalls().length, 0, 'only a --fable spawn reads the limit')
  assert.equal(w.fableRecord(), null)
  // The user asks for Fable on the next one: the same lineage, the limit decides from here.
  const f = spawn('s2', '--fable')
  assert.deepEqual([f.sub.model, f.sub.model_reason, f.sub.layer], ['claude-fable-5-2', 'Fable weekly 3% < 90%', 'fable'])
  assert.equal(w.usageCalls().length, 1)
})

test('spawn --fable: under 90% the sub runs Fable with the fable layer; the reading is recorded and cached', () => {
  const { w, b, spawn } = started()
  w.usage(usageAnswer(29))
  const r = spawn('s1', '--fable')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(modelOf(w, r), 'claude-fable-5-2')
  assert.ok(!w.state.agents[r.sub.pane].args.includes('--effort'), 'effort comes from the user settings, never from spawn')
  assert.deepEqual([r.sub.model, r.sub.model_reason, r.sub.layer], ['claude-fable-5-2', 'Fable weekly 29% < 90%', 'fable'])
  assert.equal(w.state.agents[r.sub.pane].prompts[0], `/harness-james:pane-sub normal fable ${b} ${r.sub.result}`)
  const reg = w.registry().subs.s1
  assert.deepEqual([reg.model, reg.modelReason, reg.layer, reg.run], ['claude-fable-5-2', 'Fable weekly 29% < 90%', 'fable', false])
  assert.equal(reg.fable.utilization, 29)
  assert.equal(w.fableRecord().utilization, 29)
  assert.equal(w.fableRecord().source, 'get_usage')
  // A second spawn inside the TTL does not ask again.
  assert.equal(spawn('s2', '--fable').sub.model, 'claude-fable-5-2')
  const calls = w.usageCalls()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].configDir, null, 'the default profile: no CLAUDE_CONFIG_DIR on the probe')
  assert.equal(calls[0].role, null, 'the probe is not a pane-lead session')
  assert.ok(calls[0].args.includes('--no-session-persistence') && calls[0].args.includes('stream-json'))
})

test('spawn --fable: from 90% the sub runs Opus with no model layer and no --effort', () => {
  const { w, b, spawn } = started()
  w.usage(usageAnswer(90))
  const r = spawn('s1', '--fable')
  assert.equal(modelOf(w, r), 'claude-opus-5-5')
  assert.ok(!w.state.agents[r.sub.pane].args.includes('--effort'))
  assert.deepEqual([r.sub.model_reason, r.sub.layer], ['Fable weekly 90% >= 90%', 'none'])
  assert.equal(w.state.agents[r.sub.pane].prompts[0], `/harness-james:pane-sub normal none ${b} ${r.sub.result}`)
  assert.equal(w.registry().subs.s1.model, 'claude-opus-5-5')
})

test('spawn --model fable|opus overrides the limit and asks nothing, also next to --fable; anything else is a usage error', () => {
  const { w, spawn } = started()
  w.usage(usageAnswer(97))
  const f = spawn('s1', '--model', 'fable')
  assert.deepEqual([modelOf(w, f), f.sub.model_reason, f.sub.layer], ['claude-fable-5-2', '--model fable', 'fable'])
  const o = spawn('s2', '--model', 'opus')
  assert.deepEqual([modelOf(w, o), o.sub.model_reason, o.sub.layer], ['claude-opus-5-5', '--model opus', 'none'])
  const both = spawn('s4', '--fable', '--model', 'opus')
  assert.deepEqual([modelOf(w, both), both.sub.model_reason, both.sub.layer], ['claude-opus-5-5', '--model opus', 'none'])
  assert.equal(w.usageCalls().length, 0)
  const bad = spawn('s3', '--model', 'haiku')
  assert.equal(bad.code, 2)
  assert.match(bad.error, /fable or opus/)
  assert.equal(w.registry().subs.s3, undefined)
})

test('spawn --fable: no reading (probe fails), an account without a Fable window, a window past its reset → Fable', () => {
  const { w, spawn } = started()
  w.usage(null)
  const r = spawn('s1', '--fable')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual([modelOf(w, r), r.sub.model_reason], ['claude-fable-5-2', 'no Fable limit record'])
  assert.match(r.fable_probe, /get_usage/)
  assert.equal(w.fableRecord(), null)
  w.usage(usageAnswer(null))
  assert.equal(spawn('s2', '--fable').sub.model_reason, 'no Fable limit record')
  assert.equal(w.fableRecord().utilization, null)
  // A cached 97% whose window already reset, and a probe that fails now: the old figure no longer counts.
  w.usage(null)
  const dir = join(w.root, '.local', 'state', 'pane-lead', 'fable-limit')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'default.json'), JSON.stringify({ utilization: 97, resetsAt: new Date(Date.now() - HOUR).toISOString(), at: new Date(Date.now() - 30 * HOUR).toISOString() }))
  const p = spawn('s3', '--fable')
  assert.equal(modelOf(w, p), 'claude-fable-5-2')
  assert.match(p.sub.model_reason, /reset/)
  // The same stale record before its reset still stands when the probe fails.
  writeFileSync(join(dir, 'default.json'), JSON.stringify({ utilization: 97, resetsAt: new Date(Date.now() + HOUR).toISOString(), at: new Date(Date.now() - 30 * HOUR).toISOString() }))
  assert.equal(modelOf(w, spawn('s4', '--fable')), 'claude-opus-5-5')
})

test('spawn --fable: a probe that never answers is cut off and the spawn goes on', () => {
  const { w } = started()
  w.usage({ hang: true })
  const r = w.run(['spawn', 's1', '--brief', w.brief(), '--fable'], { env: { PANE_LEAD_FABLE_PROBE_MS: '300' } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(r.fable_probe, /no answer in 300 ms/)
  assert.equal(r.sub.model, 'claude-fable-5-2')
})

test('spawn --fable: an old reading is asked again after the TTL', () => {
  const { w } = started()
  w.usage(usageAnswer(50))
  const env = { PANE_LEAD_FABLE_TTL_MS: '0' }
  w.run(['spawn', 's1', '--brief', w.brief(), '--fable'], { env })
  writeFileSync(join(w.root, 'fake-usage.json'), JSON.stringify(usageAnswer(93)))
  const r = w.run(['spawn', 's2', '--brief', w.brief(), '--fable'], { env })
  assert.equal(r.sub.model, 'claude-opus-5-5')
  assert.equal(w.usageCalls().length, 2)
})

test('spawn --fable on another profile: the probe runs on that profile and the reading is kept per account', () => {
  const env = { CLAUDE_CONFIG_DIR: '/x/.claude-other' }
  const { w, spawn } = started(env)
  w.usage(usageAnswer(95))
  const r = spawn('s1', '--fable')
  assert.equal(r.sub.model, 'claude-opus-5-5')
  assert.equal(w.usageCalls()[0].configDir, '/x/.claude-other')
  assert.equal(w.fableRecord('dir-x-claude-other').utilization, 95)
  assert.equal(w.fableRecord('default'), null)
  // The default profile's own reading decides for a main on the default profile.
  writeFileSync(join(w.root, 'fake-usage.json'), JSON.stringify(usageAnswer(20)))
  assert.equal(w.run(['spawn', 's2', '--brief', w.brief(), '--fable']).sub.model, 'claude-fable-5-2')
  assert.equal(w.fableRecord('default').utilization, 20)
})

test('spawn --run: a run-kind sub (works with the user in its pane); status shows it', () => {
  const { w, b, spawn } = started()
  const r = spawn('s1', '--run', '--kind', 'manual', '--fable')
  assert.equal(r.sub.run, true)
  assert.equal(w.state.agents[r.sub.pane].prompts[0], `/harness-james:pane-sub run fable ${b} ${r.sub.result}`)
  assert.equal(w.registry().subs.s1.run, true)
  const plain = w.run(['spawn', 's2', '--brief', b, '--run'])
  assert.equal(w.state.agents[plain.sub.pane].prompts[0], `/harness-james:pane-sub run none ${b} ${plain.sub.result}`, 'a run sub with no model asked for is an Opus sub')
  assert.equal(spawn('s3', '--fable').sub.run, undefined)
  const s = w.run(['status', '--no-ctx'])
  assert.deepEqual(s.subs.map((x) => [x.name, x.run, x.kind]), [['s1', true, 'manual'], ['s2', true, undefined], ['s3', undefined, undefined]])
})

test('model-layer off: Fable subs get layer none; on brings it back; running subs are not touched', () => {
  const { w, b, spawn } = started()
  assert.equal(w.run(['model-layer']).model_layer, 'on')
  const before = spawn('s1', '--fable')
  const off = w.run(['model-layer', 'off'])
  assert.equal(off.model_layer, 'off')
  assert.ok(existsSync(off.file))
  const r = spawn('s2', '--fable')
  assert.deepEqual([r.sub.model, r.sub.layer], ['claude-fable-5-2', 'none'])
  assert.equal(w.state.agents[r.sub.pane].prompts[0], `/harness-james:pane-sub normal none ${b} ${r.sub.result}`)
  assert.equal(w.run(['status', '--no-ctx']).next_sub.with_fable.layer, 'none')
  assert.equal(w.registry().subs.s1.layer, 'fable')
  assert.equal(w.state.agents[before.sub.pane].prompts.length, 1)
  assert.equal(w.run(['model-layer', 'on']).model_layer, 'on')
  assert.equal(spawn('s3', '--fable').sub.layer, 'fable')
  assert.equal(w.run(['model-layer', 'maybe']).code, 2)
})

test('spawn: without the pane-sub skill it stops before any pane (no-pane-sub); --prompt needs no skill', () => {
  const w = world({ skill: false })
  w.startMain()
  const r = w.run(['spawn', 's1', '--brief', w.brief(), '--fable'])
  assert.equal(r.ok, false)
  assert.equal(r.error, 'no-pane-sub')
  assert.match(r.next, /skills\/pane-sub/)
  assert.equal(w.registry().subs.s1, undefined)
  assert.ok(!(w.state.log ?? []).some((l) => l.startsWith('pane split')), 'no pane was made')
  const p = w.run(['spawn', 's1', '--brief', w.brief(), '--prompt', 'do this'])
  assert.equal(p.ok, true, JSON.stringify(p))
  assert.equal(w.state.agents[p.sub.pane].prompts[0], 'do this')
})

test('findSubSkill: in the plugin only the sibling skills/pane-sub counts; as a user skill the account, ~/.claude or a project above the cwd', () => {
  const t = mkdtempSync(join(tmpdir(), 'pl-findsub-'))
  const skill = (dir) => {
    mkdirSync(join(dir, 'pane-sub'), { recursive: true })
    writeFileSync(join(dir, 'pane-sub', 'SKILL.md'), '---\nname: pane-sub\n---\n')
  }
  // Plugin layout: <plugin>/.claude-plugin/plugin.json, <plugin>/skills/{pane-lead,pane-sub}.
  const plugin = join(t, 'plugin')
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true })
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'hp' }))
  const home = join(plugin, 'skills', 'pane-lead')
  mkdirSync(home, { recursive: true })
  const account = join(t, 'profile')
  skill(join(account, 'skills'))
  assert.equal(findSubSkill({ configDir: account, cwd: t, env: {}, home }), null, 'a user copy does not answer /hp:pane-sub')
  skill(join(plugin, 'skills'))
  assert.equal(findSubSkill({ configDir: account, cwd: t, env: {}, home }), join(plugin, 'skills', 'pane-sub'))
  assert.equal(findSubSkill({ env: { PANE_LEAD_SUB_SKILL_DIR: join(t, 'none') }, home }), null, 'the env names it alone')
  assert.equal(skillCommand(home, 'pane-sub'), '/hp:pane-sub')
  // User-skill layout (no plugin.json): the account profile's skills, or a project skill above the cwd.
  const loose = join(t, 'loose', 'skills', 'pane-lead')
  mkdirSync(loose, { recursive: true })
  assert.equal(findSubSkill({ configDir: account, cwd: t, env: {}, home: loose }), join(account, 'skills', 'pane-sub'))
  const other = join(t, 'empty-profile')
  mkdirSync(join(t, 'repo', '.claude', 'skills'), { recursive: true })
  mkdirSync(join(t, 'repo', 'pkg'), { recursive: true })
  assert.equal(findSubSkill({ configDir: other, cwd: join(t, 'repo', 'pkg'), env: {}, home: loose }), null)
  skill(join(t, 'repo', '.claude', 'skills'))
  assert.equal(findSubSkill({ configDir: other, cwd: join(t, 'repo', 'pkg'), env: {}, home: loose }), join(t, 'repo', '.claude', 'skills', 'pane-sub'))
})

test('spawn: in the plugin the start prompt finds the real sibling pane-sub skill (no stand-in)', () => {
  const { w } = started()
  const r = w.run(['spawn', 's9', '--brief', w.brief()], { env: { PANE_LEAD_SUB_SKILL_DIR: '' } })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(w.state.agents[r.sub.pane].prompts[0], /^\/harness-james:pane-sub normal none /)
})

test('status: the account Fable %, the next sub model (plain and with --fable), and each sub model (the last response wins over spawn)', () => {
  const { w, spawn } = started()
  const reset = new Date(Math.round((Date.now() + 50 * HOUR) / 60000) * 60000).toISOString()
  w.usage(usageAnswer(29, { resetsAt: reset }))
  const r = spawn('s1', '--fable')
  let s = w.run(['status'])
  assert.equal(s.ok, true, JSON.stringify(s))
  assert.deepEqual([s.fable.account, s.fable.percent, s.fable.resets_at, s.fable.source], ['default', 29, reset, 'cache'])
  assert.deepEqual(s.next_sub, { model: 'claude-opus-5-5', reason: DEFAULT_REASON, layer: 'none', with_fable: { model: 'claude-fable-5-2', reason: 'Fable weekly 29% < 90%', layer: 'fable' } })
  assert.deepEqual([s.subs[0].model, s.subs[0].layer], ['claude-fable-5-2', 'fable'])
  // The sub answered on Opus (switched in its pane): status follows the transcript.
  const dir = join(w.root, '.claude', 'projects', 'x')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${r.sub.sessionId}.jsonl`), JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 1 } } }) + '\n')
  assert.equal(w.run(['status']).subs[0].model, 'claude-opus-5-5')
  assert.equal(w.run(['status', '--no-ctx']).subs[0].model, 'claude-fable-5-2', 'without transcripts: what spawn chose')
  // At 92% a --fable sub would be Opus too; a failed probe keeps the last reading and says so.
  w.usage(usageAnswer(92, { resetsAt: reset }))
  s = w.run(['status', '--no-ctx'])
  assert.deepEqual([s.fable.percent, s.fable.source, s.next_sub.model, s.next_sub.with_fable.model, s.next_sub.with_fable.layer], [92, 'probe', 'claude-opus-5-5', 'claude-opus-5-5', 'none'])
  assert.equal(s.next_sub.with_fable.reason, 'Fable weekly 92% >= 90%')
  writeFileSync(join(w.root, 'fake-usage.json'), JSON.stringify({ error: 'usage endpoint unavailable' }))
  s = w.run(['status', '--no-ctx'], { env: { PANE_LEAD_FABLE_TTL_MS: '0' } })
  assert.deepEqual([s.fable.percent, s.fable.source, s.next_sub.with_fable.model], [92, 'stale', 'claude-opus-5-5'])
  assert.match(s.fable.error, /usage endpoint unavailable/)
})

test('status: the Fable reading is the main account\'s, also when another account\'s session asks', () => {
  const w = world()
  w.startMain()
  const reg = w.registry()
  reg.main.configDir = '/x/.claude-other'
  writeFileSync(join(w.root, '.research', 'pane-lead', 't', 'registry.json'), JSON.stringify(reg))
  w.usage(usageAnswer(40))
  const s = w.run(['status', '--no-ctx'])
  assert.equal(s.fable.account, 'dir-x-claude-other')
  assert.equal(w.usageCalls()[0].configDir, '/x/.claude-other')
})

test('status: a working sub shows its 진행: line', () => {
  const { w, spawn } = started()
  const r = spawn('s1', '--fable')
  writeFileSync(r.sub.result, '# s1 결과\n\n진행: 14:02 · 설계 끝, 구현 2/5\n\n---\n')
  assert.equal(w.run(['status', '--no-ctx']).subs[0].progress, '진행: 14:02 · 설계 끝, 구현 2/5')
  writeFileSync(r.sub.result, '# s1 결과\n\n- 끝났어요\n\n---\n')
  assert.equal(w.run(['status', '--no-ctx']).subs[0].progress, undefined)
})

test('wait: the limit dialog comes back as kind model-limit; approve and deny leave it alone; switch picks "Switch to"', () => {
  const { w, spawn } = started()
  const r = spawn('s1', '--fable')
  const pane = r.sub.pane
  w.patch((s) => (s.script.s1 = [{ status: 'blocked', screen: LIMIT_DIALOG }]))
  const wt = w.run(['wait', 's1'])
  assert.equal(wt.status, 'blocked')
  assert.equal(wt.dialog.kind, 'model-limit')
  assert.deepEqual(wt.dialog.options, ['1. Switch to Opus 5.5 For this session', '2. Not now'])
  assert.match(wt.next, /pane-lead switch s1/)
  for (const cmd of ['approve', 'deny']) {
    const a = w.run([cmd, 's1'])
    assert.equal(a.ok, false)
    assert.match(a.error, /weekly limit dialog/)
    assert.match(a.next, /pane-lead switch s1/)
  }
  assert.equal(w.state.agents[pane].keys, undefined)
  const sw = w.run(['switch', 's1', '--message', '지금 단계까지만 마치고 진행 상황을 적어 주세요'])
  assert.equal(sw.ok, true, JSON.stringify(sw))
  assert.deepEqual([sw.switched, sw.by, sw.answered, sw.message], ['claude-opus-5-5', 'dialog', 'Switch to Opus 5.5 For this session', 'sent'])
  assert.deepEqual(w.state.agents[pane].keys, ['1'])
  assert.equal(w.state.agents[pane].prompts.at(-1), '지금 단계까지만 마치고 진행 상황을 적어 주세요')
  const reg = w.registry().subs.s1
  assert.deepEqual([reg.model, reg.modelBefore], ['claude-opus-5-5', 'claude-fable-5-2'])
  assert.match(reg.modelReason, /switched in place \(dialog\)/)
  assert.ok(reg.switchedAt)
  assert.equal(w.run(['status', '--no-ctx']).subs[0].model, 'claude-opus-5-5')
})

test('switch: credits on → still "Switch to", never "Continue with usage credits"', () => {
  const { w, spawn } = started()
  const pane = spawn('s1', '--fable').sub.pane
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: CREDITS_DIALOG }))
  assert.equal(w.run(['switch', 's1']).answered, 'Switch to Opus 5.5 For this session')
  assert.deepEqual(w.state.agents[pane].keys, ['1'])
})

test('switch: no limit dialog on screen → nothing sent, the error names the fresh Opus sub', () => {
  const { w, spawn } = started()
  const pane = spawn('s1', '--fable').sub.pane
  w.patch((s) => Object.assign(s.agents[pane], { status: 'blocked', screen: PERMISSION_ABOUT_CREDITS }))
  const r = w.run(['switch', 's1'])
  assert.equal(r.ok, false)
  assert.match(r.error, /no model-limit dialog/)
  assert.match(r.next, /close s1 --force; pane-lead spawn <new> --brief <brief> --model opus/)
  assert.doesNotMatch(r.next, /by-command|\/model/)
  assert.equal(w.state.agents[pane].keys, undefined)
  assert.equal(w.registry().subs.s1.model, 'claude-fable-5-2')
  assert.match(w.run(['switch', 'oc-other']).error, /not an open sub/)
})

// E2E 2026-11-16: `/model <id>` saves the model as the user's default for new sessions and stops at a "Switch
// model?" confirmation, so no command types it. A sub whose dialog is gone is closed and replaced (SKILL.md (나)).
test('switch: an idle sub stopped at the limit with the dialog gone is refused; /model is never typed', () => {
  const { w, spawn } = started()
  const pane = spawn('s1', '--fable').sub.pane
  w.patch((s) => Object.assign(s.agents[pane], { status: 'idle', screen: STOPPED }))
  const before = (w.state.agents[pane].prompts ?? []).length
  const r = w.run(['switch', 's1', '--message', '이어서 하세요'])
  assert.equal(r.ok, false)
  assert.match(r.error, /no model-limit dialog/)
  assert.match(r.next, /--model opus/)
  const after = w.state.agents[pane]
  assert.equal((after.prompts ?? []).length, before)
  assert.ok(!(after.prompts ?? []).some((p) => p.startsWith('/model')))
  assert.equal(after.keys, undefined)
  assert.equal(w.registry().subs.s1.model, 'claude-fable-5-2')
  // The removed flag is a usage error (exit 2), with or without a value after it.
  assert.match(w.run(['switch', 's1', '--by-command']).error, /--by-command/)
  assert.match(w.run(['switch', 's1', '--by-command', 'x']).error, /unknown option --by-command/)
  assert.ok(!(w.state.agents[pane].prompts ?? []).some((p) => p.startsWith('/model')))
})

test('wait: a limit screen that is not a numbered dialog stays on the dialog:null path', () => {
  const { w, spawn } = started()
  spawn('s1', '--fable')
  w.patch((s) => (s.script.s1 = [{ status: 'blocked', screen: " You've reached your Fable limit for this week. Switch models?\n  ❯ Switch to Opus 5.5\n    Not now" }]))
  const r = w.run(['wait', 's1'])
  assert.equal(r.status, 'blocked')
  assert.equal(r.dialog, null)
  assert.match(r.next, /herdr agent read s1/)
})

test('wait: a sub that stopped with its 진행: line still on top comes back unfinished, with the screen tail and the limit hint', () => {
  const { w, spawn } = started()
  const r = spawn('s1', '--fable')
  writeFileSync(r.sub.result, '# s1 결과\n\n진행: 14:02 · 구현 2/5\n\n---\n')
  w.patch((s) => (s.agents[r.sub.pane].screen = STOPPED))
  const wt = w.run(['wait', 's1'])
  assert.equal(wt.status, 'done')
  assert.equal(wt.in_progress, true)
  assert.match(wt.summary, /진행: 14:02/)
  assert.match(wt.tail, /requires usage credits/)
  assert.match(wt.limit, /requires usage credits/)
  assert.match(wt.next, /close s1 --force; pane-lead spawn <new> --brief <brief> --model opus/)
  assert.doesNotMatch(wt.next, /by-command/)
  // A finished result file: the summary only, as before.
  writeFileSync(r.sub.result, '# s1 결과\n\n- 끝\n\n---\n')
  const done = w.run(['wait', 's1'])
  assert.deepEqual([done.summary, done.in_progress, done.tail, done.limit], ['# s1 결과\n- 끝', undefined, undefined, undefined])
})

// E2E 2026-11-16 (s1, a turn cut by an API error): the tail was the hook notice, the duration and the band.
const CUT_SCREEN = [
  '⏺ Bash(node --test)',
  '  ⎿  API Error: Connection lost mid-response. The response above may be incomplete.',
  '',
  '⏺ work-trace: its classic.StopFailure hook was skipped. "x" runs first and',
  '  sent the event on past it.',
  '',
  '✻ Baked for 3m 41s · done 오후 1:23',
  '컨텍스트 █░░░░░░░░░░░ 9% 86.4k/1.0M · 자동압축까지 881k · 메모리 1개 5.3k · $1.56       [ 자세히 ] [-]',
  '',
  '─────────────────────────────────────────────────────────────── s1 ─',
  '❯ ',
  '───────────────────────────────────────────────────────────────────────────',
  '  ⏵⏵ auto mode on (shift+tab to cycle)',
].join('\n')

test('screenTail: the context band line and hook-skipped notices are left out, so the stop reason shows', () => {
  assert.equal(screenTail(CUT_SCREEN), ['⏺ Bash(node --test)', '⎿  API Error: Connection lost mid-response. The response above may be incomplete.', '✻ Baked for 3m 41s · done 오후 1:23'].join('\n'))
  // Another mod's notice of the same shape goes too; text that only mentions the words stays.
  const other = ['⏺ context-band: its session.compact hook was skipped. "x" runs first and', '  sent the event on past it.', '', '⏺ work-trace 훅과 컨텍스트 band 줄을 고쳤어요.', '  둘째 줄이에요.'].join('\n')
  assert.equal(screenTail(other), '⏺ work-trace 훅과 컨텍스트 band 줄을 고쳤어요.\n둘째 줄이에요.')
  // Eight lines of noise no longer push the reason out.
  const noisy = ['⎿  API Error: 529', '', ...Array.from({ length: 5 }, () => ['⏺ work-trace: its classic.PostToolUse hook was skipped. "x" runs first and', '  sent the event on past it.', '']).flat()].join('\n')
  assert.equal(screenTail(noisy), '⎿  API Error: 529')
})

test('wait: an unfinished result comes back with a tail that holds the stop reason, not the band or notices', () => {
  const { w, spawn } = started()
  const r = spawn('s1', '--fable')
  writeFileSync(r.sub.result, '# s1 결과\n\n진행: 입력 읽기 끝. 독립 판정용 실행 중.\n\n---\n')
  w.patch((s) => (s.agents[r.sub.pane].screen = CUT_SCREEN))
  const wt = w.run(['wait', 's1'])
  assert.equal(wt.in_progress, true)
  assert.match(wt.tail, /API Error: Connection lost/)
  assert.doesNotMatch(wt.tail, /컨텍스트 █|work-trace|sent the event on past it/)
  assert.equal(wt.limit, undefined)
})

test('PANE_LEAD_MODEL (experiments) still puts subs on that model, with no probe', () => {
  const { w } = started()
  const r = w.run(['spawn', 's1', '--brief', w.brief(), '--fable'], { env: { PANE_LEAD_MODEL: 'claude-haiku-5-5' } })
  assert.deepEqual([modelOf(w, r), r.sub.model_reason, r.sub.layer], ['claude-haiku-5-5', 'PANE_LEAD_MODEL', 'none'])
  assert.equal(w.usageCalls().length, 0)
})

test('the pane-sub skill staged next to pane-lead carries the layers spawn names', () => {
  const dir = join(import.meta.dirname, '..', '..', 'pane-sub')
  const skill = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  assert.match(skill, /^name: pane-sub$/m)
  assert.match(skill, /^disable-model-invocation: true$/m)
  assert.match(skill, /^arguments: \[kind, layer, brief, result\]$/m)
  for (const v of ['$kind', '$layer', '$brief', '$result', 'normal', 'run', 'layers/fable.md']) assert.ok(skill.includes(v), v)
  // The model layer: the four rules as the user approved them (2026-11-16), in their own file.
  const layer = readFileSync(join(dir, 'layers', 'fable.md'), 'utf8')
  for (const rule of [
    '결과를 내기 전에 직접 실행해 확인하고, 무엇을 돌려 무엇을 봤는지 함께 적는다.',
    '맡은 일은 완료 조건을 채울 때까지 중간에 멈추지 않는다.',
    '이 코드의 주인으로서 작업한다. 있는 코드를 찾아 재사용하고 중복을 만들지 않는다.',
    '긴 작업은 진행 상황을 공유한다. 턴을 끝내지 말고, 결과 파일 맨 위의 진행 줄을 고쳐 쓰는 것으로 공유한다.',
  ])
    assert.ok(layer.includes(rule), rule)
  // The rules live in the layer file only, so a sub without the layer never reads them.
  assert.ok(!skill.includes('이 코드의 주인으로서'))
})
