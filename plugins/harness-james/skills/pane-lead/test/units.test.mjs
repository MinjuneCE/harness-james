import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { planSplit } from '../lib/layout.mjs'
import { onceOption, noOption, parseDialog, stripSidePanel } from '../lib/dialog.mjs'
import { topSummary } from '../lib/summary.mjs'
import { verdict } from '../hooks/sub-guard.mjs'
import { defaultPrefix, ensureExcluded } from '../lib/registry.mjs'
import { git } from './helpers.mjs'

const L = (panes, width = 335, height = 78) => ({ area: { x: 0, y: 0, width, height }, panes: Object.entries(panes).map(([pane_id, [x, y, w, h]]) => ({ pane_id, rect: { x, y, width: w, height: h } })) })

test('layout: full-width main → right split keeping 55%', () => {
  assert.deepEqual(planSplit(L({ m: [0, 0, 335, 78] }), 'm', []), { pane: 'm', direction: 'right', ratio: 0.55 })
})

test('layout: half-width main (shared tab) cannot split right → sub column below main', () => {
  const p = planSplit(L({ m: [0, 0, 168, 78], other: [168, 0, 167, 78] }), 'm', [])
  assert.equal(p.direction, 'down')
  assert.equal(p.pane, 'm')
})

test('layout: 60% main splits right with a ratio that keeps 45% of the tab', () => {
  const p = planSplit(L({ m: [0, 0, 201, 78], o: [201, 0, 134, 78] }), 'm', [])
  assert.equal(p.direction, 'right')
  assert.ok(201 * p.ratio >= 0.45 * 335 - 0.5)
})

test('layout: tiny tab → error with next', () => {
  const p = planSplit(L({ m: [0, 0, 60, 15] }, 60, 15), 'm', [])
  assert.ok(p.error && p.next)
})

test('layout: unknown main pane → error', () => {
  assert.ok(planSplit(L({ m: [0, 0, 335, 78] }), 'zz', []).error)
})

// Measured screen 2026-10-15 (haiku test pane, work-trace side panel with Korean text).
const REAL = [
  ' Echo test string                                                                          │                                                                       ✕',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│● Bash 사용자 승인 요청됨 · 0.0s',
  ' echo pltest-ask ok                                                                        │  echo pltest-ask ok',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌│  “Run exactly this bash command and nothing else: echo pltest-ask ok”',
  ' Ask rule Bash(echo pltest-ask*) overrides auto mode for this command.                     │1.9s · 요청 1 · 도구 1                               [ 자세히 ][ 지우기 ]',
  ' /permissions to let auto mode decide                                                      │',
  '                                                                                           │막힘 신호',
  ' Do you want to proceed?                                                                   │! 사용자 승인 대기 1회 · 합계 0.0s',
  ' ❯ 1. Yes                                                                                  │',
  '   2. No                                                                                   │#1 · +0.0s · 입력 작성 중 1.9s · haiku-5-5/medium',
  '                                                                                           │? Bash echo pltest-ask ok                                   승인대기 0.0s',
  ' Esc to cancel · Tab to amend                                                              │    ⎿ 사용자 승인 기다리는 중 · 0.0s',
].join('\n')

test('dialog: measured screen → question, options, context; side panel removed', () => {
  const d = parseDialog(REAL)
  assert.equal(d.question, 'Do you want to proceed?')
  assert.deepEqual(d.options.map((o) => [o.n, o.label, o.selected]), [[1, 'Yes', true], [2, 'No', false]])
  assert.ok(d.context.includes('echo pltest-ask ok'))
  assert.ok(d.context.every((l) => !/사용자|승인/.test(l)), d.context.join('\n'))
  assert.equal(onceOption(d), 1)
  assert.equal(noOption(d), 2)
  assert.equal(d.kind, 'permission')
})

test('dialog: auto-mode classifier escalation (measured) is flagged', () => {
  const screen = [
    ' │ Auto mode classifier requires confirmation for this command.',
    ' │ 3 consecutive actions were blocked. Please review the transcript before continuing.',
    ' │',
    ' │ Latest blocked action: [Auto-Mode Bypass]',
    ' ⚠ Claude Code will automatically deny this request in 1:55, to avoid blocking progress on',
    ' an unattended session',
    '',
    ' Do you want to proceed?',
    ' ❯ 1. Yes',
    '   2. No',
  ].join('\n')
  assert.equal(parseDialog(screen).kind, 'classifier')
})

test('dialog: three-option prompt; "Yes" means only the plain option', () => {
  const d = parseDialog("Bash command\n  git status\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don't ask again for: git status *\n  3. No")
  assert.equal(onceOption(d), 1)
  assert.equal(noOption(d), 3)
  assert.equal(parseDialog('no options here\n❯ '), null)
  assert.equal(onceOption(parseDialog('Q?\n❯ 1. Yes, and switch to auto mode\n  2. No')), undefined)
})

test('dialog: side panel with wide (Korean) chars is cut at the shared display column', () => {
  assert.deepEqual(stripSidePanel(['가나 │x', 'abcd │y', 'ab   │']), ['가나', 'abcd', 'ab'])
  assert.deepEqual(stripSidePanel(['│ box │', 'plain', 'more', 'text']), ['│ box │', 'plain', 'more', 'text'])
})

test('summary: title + lines up to the next heading/---, max 15 body lines', () => {
  assert.equal(topSummary('# T\n\na\nb\n\n## more\nc'), '# T\na\nb')
  assert.equal(topSummary('# T\na\n---\nb'), '# T\na')
  const many = '# T\n' + Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
  assert.equal(topSummary(many).split('\n').length, 16)
})

test('summary: a sub-heading right under the title (## 요약) opens the summary (B-1)', () => {
  const e2e = '# e2e-hello 결과\n\n## 요약\n\n- 날짜: 2026-10-16\n- 테스트: 통과\n\n## 상세\nlong\n'
  assert.equal(topSummary(e2e), '# e2e-hello 결과\n- 날짜: 2026-10-16\n- 테스트: 통과')
  assert.equal(topSummary('# T\n## Summary\na\n---\n## 1\nb'), '# T\na')
  // No title, summary heading first.
  assert.equal(topSummary('## 요약\na\nb\n## 상세\nc'), 'a\nb')
  // An empty summary section stays empty instead of borrowing the next section.
  assert.equal(topSummary('# T\n## 요약\n## 상세\nc'), '# T')
  // The current `- **…:**` list format keeps working.
  assert.equal(topSummary('# R\n\n- **결과:** ok\n- **확인 못 함:** z\n\n---\n\n## 1\nx'), '# R\n- **결과:** ok\n- **확인 못 함:** z')
})

test('sub-guard: push / PR create / merge variants are caught, look-alikes are not', () => {
  for (const c of ['git push', 'git push origin feat/x', 'cd a && git push', 'git -C /x push', 'git -c a=b push -f', 'git --no-pager push', 'env FOO=1 git push', "sh -c 'git push origin x'", 'timeout 5 git push', 'gh pr create -t x', 'gh -R o/r pr merge 3', 'x; gh pr merge 1 --squash', 'gh api -X PUT repos/o/r/pulls/12/merge'])
    assert.ok(verdict(c), c)
  for (const c of ['git status', 'git log --grep=push', 'git commit -m "push later"', 'gh pr view 3', 'gh pr list', 'npm run push-docs', 'echo git-push'])
    assert.equal(verdict(c), null, c)
})

test('sub-guard hook: prints a deny decision on stdin JSON, nothing otherwise', async () => {
  const { spawnSync } = await import('node:child_process')
  const hook = new URL('../hooks/sub-guard.mjs', import.meta.url).pathname
  const run = (cmd) => spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }), encoding: 'utf8' })
  const r = run('git -C . push')
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny')
  assert.equal(run('git status').stdout, '')
  assert.equal(spawnSync(process.execPath, [hook], { input: 'garbage', encoding: 'utf8' }).stdout, '')
})

test('ensureExcluded: adds /.research/ to .git/info/exclude once; no-op outside git', () => {
  const d = mkdtempSync(join(tmpdir(), 'pl-ex-'))
  assert.equal(ensureExcluded(d), null)
  git(d, 'init', '-q')
  const p = ensureExcluded(d)
  assert.match(readFileSync(p, 'utf8'), /^\/\.research\/$/m)
  assert.equal(ensureExcluded(d), 'already-ignored')
  const d2 = mkdtempSync(join(tmpdir(), 'pl-ex2-'))
  git(d2, 'init', '-q')
  writeFileSync(join(d2, '.gitignore'), '.research/\n')
  assert.equal(ensureExcluded(d2), 'already-ignored')
})

test('defaultPrefix: initials for multi-word dirs, first 8 letters otherwise', () => {
  assert.equal(defaultPrefix('/x/acme-web-store'), 'aws')
  assert.equal(defaultPrefix('/x/Workspace'), 'workspac')
  assert.equal(defaultPrefix('/x/123'), 'pl')
})
