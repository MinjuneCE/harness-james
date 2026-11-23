// 0.4.0: the facts the pane used to take from the classic hook events
// (PostToolUse, PermissionRequest, PermissionDenied, StopFailure) and from
// `session.compact`, taken where a plugin above cannot hand the
// event past this one: `tool.judge`, `tool.run`, the turn's own end, `/compact`
// as its command, and the window found shrunk at the next request. No test
// here raises PostToolUse, PermissionRequest or PermissionDenied.
import { expect, mock, test } from 'claude-code/testing'

import { CWD, PANE, TRANSCRIPT, USAGE, engine, gate, runStep, textOf, toolChunk } from './kit'
import type { Script } from './kit'

const answerOnly: Script = { chunks: [{ kind: 'text', index: 0, text: '끝' }], uses: [], answer: '끝' }
const usageOf = (contextTokens: number): typeof USAGE => ({ ...USAGE, cache_read_input_tokens: contextTokens })
const readStep = (id: string, contextTokens: number): Script => ({
  chunks: [toolChunk(0, id, 'Read')],
  uses: [{ name: 'Read', input: { file_path: `${CWD}/a.ts` } }],
  answer: '',
  usage: usageOf(contextTokens),
})
const COMPACT = { command: 'compact', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 200 } } as const

/** How many lines of the mounted pane match. */
async function count(ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }, what: RegExp): Promise<number> {
  return (await ui.findAll({ type: 'Text' })).filter(t => what.test(t.text)).length
}

test("auto mode's refusal reads as its own, with the classifier's reason, and no hook is blamed", async ($, on) => {
  const clock = mock.clock(on, { now: 70_000_000 })
  const asked = gate()
  engine(on, [{ chunks: [toolChunk(0, 'tu-d', 'Bash')], uses: [{ name: 'Bash', input: { command: 'rm -rf build' } }], answer: '' }], {
    person: () => asked.wait,
    refuse: () => true,
    judge: async () => ({ decision: 'deny', reason: '[Destructive] 되돌릴 수 없는 삭제' }),
    check: () => ({ decision: 'ask' }),
  })
  await $.turn.start({ text: '빌드 지워줘', turnId: 'd1' })
  await runStep($, 'd1', 0)
  const call = $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-d' })
  await clock.settle()
  expect(await $.tool.judge({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu-d' }), 'the verdict reaches the engine through the plugin').toMatchObject({ decision: 'deny' })
  asked.open()
  expect(await call).toMatchObject({ isError: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /! 파일 작업\s+build/ }), all).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\[Destructive\] 되돌릴 수 없는 삭제/ }), "the classifier's reason").toBeDefined()
  expect(await ui.find({ type: 'Text', text: /훅 개입 0/ }), 'no hook is blamed for it').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /거부 1/ }), 'counted as refused').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /사용자가 거절함|사람 승인 [1-9]/ }), 'nor the person').toBeUndefined()
  await ui.press({ key: 'detail' })
  expect(await ui.find({ type: 'Text', text: /자동 모드가 거부/ }), 'the verdict, under 자세히').toBeDefined()
  await ui.unmount()
})

test("a turn the API stopped says so from the turn's own end, with no stop-failure event heard", async ($, on) => {
  mock.clock(on, { now: 71_000_000 })
  engine(on, [answerOnly])
  await $.turn.start({ text: '요약해줘', turnId: 'e1' })
  await runStep($, 'e1', 0)
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: false, turnId: 'e1', reason: 'error' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /API 오류로 끝남/ }), all).toBeDefined()
  expect(await count(ui, /✗ API 오류로 멈춤/), 'the stop, in the flow, once').toBe(1)
  await ui.unmount()
})

test('where the stop failure told what the API said, the stop is noted once, with it', async ($, on) => {
  mock.clock(on, { now: 72_000_000 })
  engine(on, [answerOnly])
  await $.turn.start({ text: '요약해줘', turnId: 'e2' })
  await runStep($, 'e2', 0)
  await $.classic.StopFailure({ error: 'rate_limit', error_details: '429 한도 초과' })
  await $.turn.complete({ answer: '', durationMs: 900, isAborted: false, turnId: 'e2', reason: 'error' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /✗ API 오류로 멈춤: rate_limit — 429 한도 초과/ }), all).toBeDefined()
  expect(await count(ui, /✗ API 오류로 멈춤/), 'not said again by the turn end').toBe(1)
  await ui.unmount()
})

test('/compact is timed as its command where no compaction event is heard', async ($, on) => {
  const clock = mock.clock(on, { now: 80_000_000 })
  const compacting = gate()
  engine(on, [answerOnly], { command: name => (name === 'compact' ? compacting.wait : undefined) })
  await $.turn.start({ text: '정리해줘', turnId: 'c1' })
  await runStep($, 'c1', 0)
  await $.turn.complete({ answer: '끝', durationMs: 500, isAborted: false, turnId: 'c1', reason: 'answer' })

  const cmd = $.command.run(COMPACT)
  await clock.settle()
  await clock.advance(6_000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 중 · 5초/ }), await textOf(ui)).toBeDefined()
  await ui.unmount()

  compacting.open()
  await cmd
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 중/ }), all).toBeUndefined()
  expect(await count(ui, /! 컨텍스트 압축 5초 \(수동\)/), all).toBe(1)
  expect(await ui.find({ type: 'Text', text: /추정/ }), 'timed, not inferred').toBeUndefined()
  await ui.unmount()
})

test('a /compact the compaction event also tells of is one compaction, and one that came straight back is none', async ($, on) => {
  const clock = mock.clock(on, { now: 81_000_000 })
  const compacting = gate()
  let isHeld = true
  engine(on, [answerOnly], { command: name => (name === 'compact' && isHeld ? compacting.wait : undefined) })
  await $.turn.start({ text: '정리해줘', turnId: 'c2' })
  await runStep($, 'c2', 0)
  await $.turn.complete({ answer: '끝', durationMs: 500, isAborted: false, turnId: 'c2', reason: 'answer' })

  // The command, and inside it the event (as a session with no plugin above hears both).
  const cmd = $.command.run(COMPACT)
  await clock.settle()
  const inner = $.session.compact({ trigger: 'manual', messages: TRANSCRIPT })
  await clock.advance(4_000)
  await inner
  compacting.open()
  await cmd
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await textOf(ui)
  expect(await count(ui, /! 컨텍스트 압축.*\(수동\)/), all).toBe(1)
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 중/ }), 'closed').toBeUndefined()
  await ui.unmount()

  // Nothing to compact: the command comes straight back and no compaction is claimed.
  isHeld = false
  await $.command.run(COMPACT)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  all = await textOf(ui)
  expect(await count(ui, /! 컨텍스트 압축.*\(수동\)/), all).toBe(1)
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 중/ }), 'none left open').toBeUndefined()
  await ui.unmount()
})

test('a compaction no event told of is read from the window shrinking between two requests, as a reading', async ($, on) => {
  const clock = mock.clock(on, { now: 82_000_000 })
  engine(on, [readStep('tu-1', 400_000), readStep('tu-2', 420_000), { ...answerOnly, usage: usageOf(30_000) }])
  await $.turn.start({ text: '계속해', turnId: 'i1' })
  await runStep($, 'i1', 0)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, tool_use_id: 'tu-1' })
  await runStep($, 'i1', 1)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, tool_use_id: 'tu-2' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축/ }), 'a window that grows was not compacted').toBeUndefined()
  await ui.unmount()

  // Forty seconds with no request, and the next one is answered over a fraction of the window.
  await clock.advance(40_000)
  await runStep($, 'i1', 2)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await count(ui, /! 컨텍스트 압축 (39|40)초 \(자동·추정\)/), all).toBe(1)
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 (39|40)초/ }), 'where the time went').toBeDefined()
  await ui.unmount()
})

test('a compaction the event told of is not read again from the window', async ($, on) => {
  const clock = mock.clock(on, { now: 83_000_000 })
  const summarizing = gate()
  engine(on, [readStep('tu-1', 400_000), { ...answerOnly, usage: usageOf(30_000) }], { compact: () => summarizing.wait })
  await $.turn.start({ text: '계속해', turnId: 'i2' })
  await runStep($, 'i2', 0)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, tool_use_id: 'tu-1' })
  const compacted = $.session.compact({ trigger: 'auto', messages: TRANSCRIPT })
  await clock.settle()
  await clock.advance(21_000)
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /컨텍스트 압축 중 · 20초/ }), await textOf(ui)).toBeDefined()
  await ui.unmount()
  summarizing.open()
  await compacted
  await runStep($, 'i2', 1)

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await count(ui, /! 컨텍스트 압축 20초 \(자동\)/), all).toBe(1)
  expect(await ui.find({ type: 'Text', text: /추정/ }), 'timed by its event, so nothing is inferred').toBeUndefined()
  await ui.unmount()
})
