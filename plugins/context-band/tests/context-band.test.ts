import { expect, mock, test } from 'claude-code/testing'
import type { On, SessionUsage, TurnStepChunk, TurnStepResult } from 'claude-code'

import { fitPieces, fmtTokens, pieces } from '../hooks/band'

const BAND = {
  plugin: 'context-band',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 140,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const HOUR = 3_600_000

/** The session beneath the plugin: its usage figures, growing by `step` tokens per read. */
function session(on: On, step = 0) {
  let tokens = 84_100
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.usage', ($, e) => {
    const usage: SessionUsage = {
      startedAt: 0,
      context: { tokens, window: 200_000, percent: Math.round((tokens / 200_000) * 100) },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 34, resetsAt: new Date(2 * HOUR + 13 * 60_000).toISOString() },
        { kind: 'seven_day', percentUsed: 92 },
      ],
      cost: { usd: 1.24 },
    }
    if (e?.breakdown !== undefined) {
      usage.context.breakdown = {
        categories: [
          { name: '시스템 프롬프트', tokens: 3_100, color: 'promptBorder', isDeferred: false, kind: 'used' },
          { name: '메모리 파일', tokens: 6_200, color: 'permission', isDeferred: false, kind: 'used' },
          { name: '메시지', tokens: 54_300, color: 'claude', isDeferred: false, kind: 'used' },
          { name: '여유 공간', tokens: 116_000, color: 'inactive', isDeferred: false, kind: 'free' },
          { name: '압축 버퍼', tokens: 33_000, color: 'inactive', isDeferred: false, kind: 'buffer' },
        ],
        totalTokens: 84_100,
        maxTokens: 200_000,
        rawMaxTokens: 200_000,
        autocompactSource: 'model-default',
        percentage: 42,
        gridRows: [],
        model: 'claude-opus-5-5',
        memoryFiles: [
          { path: '/repo/CLAUDE.md', type: 'Project', tokens: 2_100 },
          { path: '/Users/me/.claude/projects/x/memory/MEMORY.md', type: 'AutoMem', tokens: 4_100 },
        ],
        mcpTools: [],
        agents: [],
        autoCompactThreshold: 160_000,
        isAutoCompactEnabled: true,
        apiUsage: null,
      }
    }
    tokens += step

    return { value: usage }
  })
}

test('the band shows the window, the way to compaction, memory, cost and limits', async ($, on) => {
  const clock = mock.clock(on, { now: 23 * 60_000 })
  session(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  // The start hook asks for the reading and hands on; it lands a moment later.
  await clock.settle()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    for (const text of [/42% 84\.1k\/200k/, /자동압축까지 75\.9k/, /메모리 2개 6\.2k/, /\$1\.24/, /5시간 34%/, /7일 92%/, /세션 23m/]) {
      expect(await ui.find({ type: 'Text', text }), String(text)).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /구성/ }), 'details start folded').toBeUndefined()

    await ui.press({ key: 'detail' })
    expect(await ui.find({ type: 'Text', text: /메시지 54\.3k · 여유 116k · 압축 버퍼 33\.0k/ }), 'parts').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /CLAUDE\.md\(Project\) 2\.1k · MEMORY\.md\(AutoMem\) 4\.1k/ }), 'memory').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /5시간 34% · 1h 50m 후 초기화/ }), 'reset').toBeDefined()
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }
})

test('the band keeps to its width, dropping the least telling pieces', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  session(on)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal', props: { ...BAND.props, bodyColumns: 64 } })
  expect(await ui.find({ type: 'Text', text: /42%/ }), 'the fill stays').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /세션/ }), 'the age goes first').toBeUndefined()
  await ui.unmount()
})

test('while a turn runs the band follows the window as it grows', async ($, on) => {
  const clock = mock.clock(on, { now: 0 })
  session(on, 10_000)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  await clock.advance(5000)
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /52% 104k\/200k · 자동압축까지 55\.9k/ }), 'read again on each of the two ticks').toBeDefined()
  await ui.unmount()
})

test('the pieces read the snapshot', () => {
  expect(fmtTokens(84_100)).toBe('84.1k')
  expect(fmtTokens(1_000_000)).toBe('1.0M')
  const snap = { at: 0, model: 'claude-opus-5-5', startedAt: 0, window: 200_000, parts: [], memory: [], limits: [] }
  expect(pieces(snap, 0).map(p => p.text)).toEqual(['컨텍스트 첫 응답 전', 'opus-5-5', '세션 0m'])
  expect(pieces({ ...snap, effort: 'max' }, 0).map(p => p.text)).toContain('opus-5-5/max')
  expect(fitPieces(pieces({ ...snap, tokens: 190_000, compactAt: 160_000 }, 0), 30).map(p => p.text)).toEqual([
    '95% 190k/200k',
    '곧 자동압축',
  ])
})

// ---- the model never waits on the band ----

test('no hook waits on the band: a request streams through raising nothing, and an answered turn hands on before its reading lands', async ($, on) => {
  const counts = new Map<string, number>()
  const flag = { inFlight: false }
  const count = (name: string): void => {
    if (flag.inFlight) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const never = new Promise<never>(() => {})
  const chunks: TurnStepChunk[] = Array.from({ length: 500 }, () => ({ kind: 'text', index: 0, text: '조각 ' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('turn.step', async function* ($, e) {
    for (const c of chunks) yield c
    const r: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null }
    return r
  })
  // The host never answers a reading: a hook that waited on one would hold its dispatch for its whole budget.
  on('session.usage', () => (count('session.usage'), never))
  on('session.model', () => (count('session.model'), never))
  on('clock.now', () => (count('clock.now'), never))
  // @ts-expect-error a timer held for good
  on('clock.every', () => never)
  for (const name of ['state.get', 'state.set'] as const) {
    // @ts-expect-error a counting pass-through
    on(name, ($, e, next) => (count(name), next(e)))
  }

  const t0 = performance.now()
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' })
  flag.inFlight = true
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', effort: 'max', messageCount: 1 })
  const got: TurnStepChunk[] = []
  for (;;) {
    const p = await stream.next()
    if (p.done === true) break
    got.push(p.value)
  }
  flag.inFlight = false
  expect(got, 'every chunk handed on as it came').toEqual(chunks)
  expect(Object.fromEntries(counts), 'nothing raised while the response streamed').toEqual({})
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(performance.now() - t0, 'well under one hook budget').toBeLessThan(3000)
})
