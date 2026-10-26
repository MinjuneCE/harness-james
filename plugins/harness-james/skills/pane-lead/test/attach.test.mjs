// handover + workspace attach.json: the configured command's output lands at the end of the doc before the next main starts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { world } from './helpers.mjs'
import { SKILL_CMD } from '../lib/common.mjs'
import { BEGIN, END } from '../lib/attach.mjs'

const DOC = '# handover\n\n본문\n'
const KEYS = ['ok', 'next_main', 'doc', 'next'].sort()

/** A lineage at gen 1, a doc, an optional attach.json and a fake command script `cmd.mjs` (body = its JS). */
function setup({ config, script } = {}) {
  const w = world()
  w.startMain()
  const doc = join(w.root, 'h.md')
  writeFileSync(doc, DOC)
  if (script) writeFileSync(join(w.root, 'cmd.mjs'), script)
  if (config !== undefined) {
    mkdirSync(join(w.root, '.research', 'pane-lead'), { recursive: true })
    writeFileSync(join(w.root, '.research', 'pane-lead', 'attach.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  return { w, doc }
}
const entry = (extra = {}) => ({ handover: { t: { cmd: [process.execPath, 'cmd.mjs', '--to', 'impl', '--prefix', '{prefix}', '--doc', '{doc}'], label: 'gaps', title: '장부의 열린 일과 어긋남', ...extra } } })
const count = (s, sub) => s.split(sub).length - 1
// The fake command prints its argv, cwd and how many agents the fake herdr had when it ran.
const ECHO = `import { readFileSync } from 'node:fs'
const n = Object.keys(JSON.parse(readFileSync(process.env.PANE_LEAD_FAKE_STATE, 'utf8')).agents).length
console.log('### 열린 일 (impl)')
console.log('- args: ' + process.argv.slice(2).join(' '))
console.log('- cwd: ' + process.cwd())
console.log('- agents: ' + n)
`

test('attach: no attach.json → doc untouched, output has the same fields as before', () => {
  const { w, doc } = setup()
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.equal(readFileSync(doc, 'utf8'), DOC)
  assert.deepEqual(Object.keys(h).filter((k) => k !== 'code').sort(), KEYS)
  assert.equal(w.state.agents[h.next_main.pane].prompts[0], `${SKILL_CMD} takeover ${doc}`)
})

test('attach: attach.json without an entry for this prefix → same as no config', () => {
  const { w, doc } = setup({ config: { handover: { other: { cmd: ['false'] } } } })
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.equal(readFileSync(doc, 'utf8'), DOC)
  assert.equal(h.attach, undefined)
})

test('attach: success → section at the end, placeholders filled, run in root before the next main starts', () => {
  const { w, doc } = setup({ config: entry(), script: ECHO })
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.deepEqual(h.attach, { ok: true, lines: 4, label: 'gaps', section: 'added' })
  const text = readFileSync(doc, 'utf8')
  assert.ok(text.startsWith(DOC), text)
  assert.match(text, /\n## 기계 계산: 장부의 열린 일과 어긋남 \(\d{4}-\d\d-\d\d \d\d:\d\d, gaps\)\n\n### 열린 일 \(impl\)\n/)
  assert.ok(text.includes(`- args: --to impl --prefix t --doc ${doc}\n`), text)
  assert.ok(text.includes(`- cwd: ${w.root}`) || text.includes(`- cwd: /private${w.root}`), text)
  // Two agents (old main + the foreign pane): the next main did not exist yet.
  assert.ok(text.includes('- agents: 2\n'), text)
  assert.ok(text.trimEnd().endsWith(END))
  assert.equal(w.state.agents[h.next_main.pane].prompts[0], `${SKILL_CMD} takeover ${doc}`)
})

test('attach: failing command → one-line note, handover goes on', () => {
  const { w, doc } = setup({ config: entry(), script: `console.error('collab: no board'); process.exit(3)` })
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.equal(h.attach.ok, false)
  assert.match(h.attach.reason, /종료 코드 3: collab: no board/)
  assert.match(readFileSync(doc, 'utf8'), /\n기계 계산 실패: 종료 코드 3: collab: no board\n/)
  assert.equal(w.registry().pending.name, 't-main-2')
})

test('attach: timeout → note, handover goes on without waiting for the command', () => {
  const { w, doc } = setup({ config: entry({ timeout: 300 }), script: `setTimeout(() => console.log('late'), 30000)` })
  const t0 = Date.now()
  const h = w.run(['handover', '--doc', doc])
  assert.ok(Date.now() - t0 < 10000, `took ${Date.now() - t0} ms`)
  assert.equal(h.ok, true, JSON.stringify(h))
  assert.deepEqual([h.attach.ok, h.attach.reason], [false, '시간 초과 300ms'])
  assert.match(readFileSync(doc, 'utf8'), /기계 계산 실패: 시간 초과 300ms/)
})

test('attach: empty output, missing program, broken config → note each time, handover goes on', () => {
  for (const [config, script, reason] of [
    [entry(), `process.stdout.write('  \\n')`, /빈 출력/],
    [{ handover: { t: { cmd: ['/nonexistent/prog'] } } }, null, /ENOENT/],
    ['{ not json', null, /설정 읽기 실패/],
    [{ handover: { t: { cmd: 'node x.mjs' } } }, null, /설정 읽기 실패: handover.t.cmd/],
  ]) {
    const { w, doc } = setup({ config, script })
    const h = w.run(['handover', '--doc', doc])
    assert.equal(h.ok, true, JSON.stringify(h))
    assert.equal(h.attach.ok, false)
    assert.match(h.attach.reason, reason)
    assert.equal(count(readFileSync(doc, 'utf8'), '기계 계산 실패'), 1)
  }
})

test('attach: a second handover replaces the section (one section, text written after it kept)', () => {
  const { w, doc } = setup({ config: entry(), script: ECHO })
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.attach.section, 'added')
  // The next main never came up: drop it so handover may run again; the main adds a line after the section meanwhile.
  w.patch((s) => delete s.agents[h.next_main.pane])
  writeFileSync(doc, readFileSync(doc, 'utf8') + '\n덧붙인 줄\n')
  const h2 = w.run(['handover', '--doc', doc])
  assert.equal(h2.ok, true, JSON.stringify(h2))
  assert.equal(h2.attach.section, 'replaced')
  const text = readFileSync(doc, 'utf8')
  assert.equal(count(text, BEGIN), 1)
  assert.equal(count(text, END), 1)
  assert.equal(count(text, '## 기계 계산'), 1)
  assert.ok(text.indexOf('덧붙인 줄') < text.indexOf(BEGIN), text)
  assert.ok(text.startsWith(DOC))
})

test('attach: long output is cut at 60 lines with a note; lines reports the full count', () => {
  const { w, doc } = setup({ config: entry(), script: `for (let i = 0; i < 75; i++) console.log('- ' + i)` })
  const h = w.run(['handover', '--doc', doc])
  assert.equal(h.attach.lines, 75)
  const text = readFileSync(doc, 'utf8')
  assert.ok(text.includes('- 59\n… (15줄 생략)\n'), text)
  assert.ok(!text.includes('- 60\n'))
})
