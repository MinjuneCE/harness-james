import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { TraceStep } from '../types'
import { MAX_AGENT_LOOPS, MAX_AGENT_STEPS, MAX_STEPS, capSteps, newStep } from '../hooks/trace'
import { agentCards } from '../hooks/agents'

const PANE = {
  plugin: 'work-trace',
  component: 'Pane',
  requestId: 'work-trace',
  props: {
    title: '작업 추적',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 200 },
    view: {},
  },
} as const

const INLINE = { ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 40 } } as const

const USAGE = {
  input_tokens: 12,
  output_tokens: 80,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 1_000,
  model: 'claude-opus-5-5',
}

type Script = { chunks: TurnStepChunk[]; uses: { name: string; input: unknown }[] }
type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string }

/**
 * The engine beneath the plugin, as tests/work-trace.test.ts scripts it, keyed by loop:
 * each loop (main or an agent id) walks its own scripts.
 */
function engine(
  on: On,
  scripts: Record<string, Script[]>,
  beneath: {
    fail?: (name: string) => string | undefined
    hold?: (name: string) => Promise<void> | undefined
    check?: (name: string) => Verdict
  } = {},
) {
  const at = new Map<string, number>()
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const loop = e.agentId ?? 'main'
    const list = scripts[loop] ?? []
    const i = at.get(loop) ?? 0
    at.set(loop, i + 1)
    const script = list[Math.min(i, list.length - 1)] ?? { chunks: [], uses: [] }
    for (const chunk of script.chunks) yield chunk
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: script.uses,
      stopReason: script.uses.length > 0 ? 'tool_use' : 'end_turn',
      usage: USAGE,
    }

    return result
  })
  on('tool.call', async ($, e) => {
    await beneath.hold?.(String(e.tool))
    const failed = beneath.fail?.(String(e.tool))
    return failed === undefined ? { result: { ok: true } } : { isError: true as const, result: failed, text: failed }
  })
  on('tool.check', ($, e) => beneath.check?.(e.tool) ?? { decision: 'allow' })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
}

const call = (id: string, name: string, input: unknown): Script => ({
  chunks: [{ kind: 'tool', index: 0, id, name }],
  uses: [{ name, input }],
})

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {}
  const wait = new Promise<void>(resolve => {
    open = resolve
  })

  return { wait, open }
}

async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<R> {
  for (;;) {
    const piece = await stream.next()
    if (piece.done === true) return piece.value
  }
}

async function step($: Engine, turnId: string, index: number, agentId?: string): Promise<void> {
  const base = { turnId, index, model: 'claude-opus-5-5', messageCount: 1 + index }
  await drain($.turn.step(agentId === undefined ? base : { ...base, agentId }))
}

function spawnInput(toolUseId: string, description: string, subagentType: string, extra: Record<string, unknown> = {}) {
  return {
    tool_use_id: toolUseId,
    prompt: description,
    description,
    subagentType,
    provider: { plugin: 'engine', tier: 'core' } as const,
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
    ...extra,
  }
}

test('the main pane gathers subagents: running ones pinned, nested under their parent, with calls, last error and stuck colour', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000_000 })
  const grep = gate()
  engine(
    on,
    {
      main: [call('tu-a1', 'Agent', { subagent_type: 'general-purpose', description: '로그인 조사' }), call('tu-ls', 'Glob', { pattern: '*' })],
      'ag-1': [
        call('tu-test', 'Bash', { command: 'npm test' }),
        call('tu-read', 'Read', { file_path: 'src/auth.ts' }),
        call('tu-a2', 'Agent', { subagent_type: 'Explore', description: '호출처 찾기' }),
      ],
      'ag-2': [call('tu-grep', 'Grep', { pattern: 'login' })],
    },
    {
      fail: name => (name === 'Bash' ? 'Exit code 1\nFAIL auth.spec.ts' : undefined),
      hold: name => (name === 'Grep' ? grep.wait : undefined),
    },
  )
  on('agent.spawn', ($, e) => ({ model: 'claude-opus-5-5', agentId: e.tool_use_id === 'tu-a1' ? 'ag-1' : 'ag-2' }))

  await $.turn.start({ text: '로그인 버그 찾아줘', turnId: 'm1' })
  await step($, 'm1', 0)
  await $.tool.call({ tool: 'Agent', subagent_type: 'general-purpose', description: '로그인 조사', prompt: 'p', tool_use_id: 'tu-a1' })
  await $.agent.spawn(spawnInput('tu-a1', '로그인 조사', 'general-purpose'))
  await $.turn.start({ text: '로그인 조사', turnId: 'r1', agentId: 'ag-1' })

  await step($, 'r1', 0, 'ag-1')
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-test', agentId: 'ag-1' })
  await step($, 'r1', 1, 'ag-1')
  // @ts-expect-error as above
  await $.tool.call({ tool: 'Read', file_path: 'src/auth.ts', tool_use_id: 'tu-read', agentId: 'ag-1' })
  await step($, 'r1', 2, 'ag-1')
  // @ts-expect-error as above
  await $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: '호출처 찾기', prompt: 'q', tool_use_id: 'tu-a2', agentId: 'ag-1' })
  await $.agent.spawn(spawnInput('tu-a2', '호출처 찾기', 'Explore', { parentAgentId: 'ag-1' }))
  await $.turn.start({ text: '호출처 찾기', turnId: 'r2', agentId: 'ag-2' })
  await step($, 'r2', 0, 'ag-2')
  // @ts-expect-error as above
  const grepCall = $.tool.call({ tool: 'Grep', pattern: 'login', tool_use_id: 'tu-grep', agentId: 'ag-2' })

  // The main loop goes on long enough to push the Agent call out of the pane's latest steps.
  for (let i = 1; i <= 20; i += 1) await step($, 'm1', i)
  await clock.advance(130_000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /서브에이전트 · 실행 중 2/ }), 'the section head').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /general-purpose · 로그인 조사 · 백그라운드/ }), 'the parent card, though its Agent call left the latest steps').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /└ ● Explore · 호출처 찾기/ }), 'the nested agent under its parent').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗ 테스트/ }), 'the failed call, in the flow\'s words').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /⎿ Exit code 1 … FAIL auth\.spec\.ts/ }), 'its reason').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 읽음\s+auth\.ts/ }), 'a recent call').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /검색 중 · 2분 \d+초 · 요청 1 · 도구 1/ }), 'the nested activity').toMatchObject({ props: { color: 'error' } })
  expect(await ui.find({ type: 'Text', text: /여기서 매우 오래 머물고 있어요/ }), 'the stuck hint').toBeDefined()

  await ui.press({ key: 'agent:ag-2' })
  expect(await ui.find({ key: 'agent:ag-2' }), 'the card closed').toMatchObject({ props: { label: '펼치기' } })
  expect(await ui.find({ type: 'Text', text: /└ ● Explore: 검색 중 · 2분 \d+초 · 도구 1/ }), 'the closed card is one line').toBeDefined()
  await ui.unmount()

  const inline = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await inline.find({ type: 'Text', text: /^⎿ ● general-purpose: / }), 'inline: one line per running agent').toBeDefined()
  expect(await inline.find({ type: 'Text', text: /⎿ Exit code 1/ }), 'inline: no card body').toBeUndefined()
  await inline.unmount()

  grep.open()
  await grepCall
})

test("an ended agent's report links to its hand-back turn, and a workflow agent says so", async ($, on) => {
  mock.clock(on, { now: 11_000_000 })
  engine(on, { main: [call('tu-wf', 'Workflow', { script: 'x' })], 'wf-1': [call('tu-r', 'Read', { file_path: 'a.ts' })] })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'wf-1' }))

  await $.turn.start({ text: '워크플로 돌려줘', turnId: 'm1' })
  await step($, 'm1', 0)
  await $.agent.spawn(spawnInput('tu-wf', 'review', 'general-purpose', { workflow: { runId: 'wf_abc', agentIndex: 2 } }))
  await $.turn.start({ text: 'review', turnId: 'w1', agentId: 'wf-1' })
  await step($, 'w1', 0, 'wf-1')
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId
  await $.tool.call({ tool: 'Read', file_path: 'a.ts', tool_use_id: 'tu-r', agentId: 'wf-1' })
  await $.turn.complete({ answer: 'ok', durationMs: 1000, isAborted: false, turnId: 'w1', reason: 'answer', agentId: 'wf-1' })
  await $.turn.complete({ answer: '', durationMs: 1000, isAborted: false, turnId: 'm1', reason: 'answer' })
  await $.turn.start({
    text: '<agent-message from="wf-1">\n[Subagent hand-back] The report follows:\n  리뷰 끝\n</agent-message>',
    turnId: 'm2',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /서브에이전트 · 실행 중 0 · 끝남 1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /general-purpose · review · Workflow #2/ }), 'the workflow tag').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◀ 결과 전달됨 \(지금 턴\) · 리뷰 끝/ }), 'the report linked to its turn').toBeDefined()
  await ui.unmount()

  const inline = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await inline.find({ type: 'Text', text: /^⎿ . general-purpose: / }), 'inline leaves ended agents out').toBeUndefined()
  await inline.unmount()
})

test('a call the decider holds reads as judged or running, not as running alone', async ($, on) => {
  mock.clock(on, { now: 12_000_000 })
  const held = gate()
  engine(on, { main: [call('tu-b', 'Bash', { command: 'rm -rf build' })] }, {
    hold: name => (name === 'Bash' ? held.wait : undefined),
    check: () => ({ decision: 'ask' }),
  })
  await $.turn.start({ text: '빌드 지워줘', turnId: 'm1' })
  await step($, 'm1', 0)
  const bash = $.tool.call({ tool: 'Bash', command: 'rm -rf build', tool_use_id: 'tu-b' })
  await $.tool.check({ tool: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: 'tu-b' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /승인 판정 또는 파일 작업 중/ }), 'the header').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● 파일 작업\s+build/ }), 'the call, running, in the flow').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /확인 필요/ }), "the call's verdict waits for 자세히").toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /서브에이전트/ }), 'no section without agents').toBeUndefined()
  await ui.unmount()
  held.open()
  await bash
})

test('each loop keeps its own steps, so subagents never push the main loop out', () => {
  const at = (loop: string, i: number): TraceStep => newStep(`${loop}:t:${i}`, loop, 't', i, 'm', undefined, i)
  const main = Array.from({ length: 70 }, (_, i) => at('main', i))
  const busy = Array.from({ length: 40 }, (_, i) => at('ag-busy', 100 + i))
  const kept = capSteps([...main.slice(0, 50), ...busy, ...main.slice(50)])
  expect(kept.filter(s => s.loop === 'main').length).toBe(MAX_STEPS)
  expect(kept.filter(s => s.loop === 'ag-busy').length).toBe(MAX_AGENT_STEPS)
  expect(kept[kept.length - 1]?.id, 'order kept').toBe('main:t:69')

  const many = Array.from({ length: MAX_AGENT_LOOPS + 3 }, (_, i) => at(`ag-${i}`, i))
  const loops = new Set(capSteps([...many, at('main', 0)]).map(s => s.loop))
  expect(loops.has('main')).toBe(true)
  expect(loops.size, 'the oldest subagent loops go first').toBe(MAX_AGENT_LOOPS + 1)
  expect(loops.has('ag-0')).toBe(false)
})

test('agent cards nest by the loop that ran the starting call when the spawn named no parent', () => {
  const parentStep = newStep('p:t:0', 'p', 't', 0, 'm', undefined, 0)
  parentStep.tools = [{ id: 'tu-child', name: 'Agent', summary: '', state: 'ok', queuedAt: 0 }]
  const cards = agentCards(
    [
      { id: 'p', toolUseId: 'tu-p', type: 'orchestrator', description: '', isBackground: false, startedAt: 0 },
      { id: 'c', toolUseId: 'tu-child', type: 'judge', description: '', isBackground: false, startedAt: 1 },
      { id: 'old', toolUseId: '', type: 'x', description: '', isBackground: false, startedAt: 0, endedAt: 5, outcome: 'done' },
    ],
    [parentStep],
    [],
    10,
    { ended: 3, tools: 3, where: { cwd: '/repo', home: '' } },
  )
  expect(cards.map(c => [c.agent.id, c.depth])).toEqual([
    ['p', 0],
    ['c', 1],
    ['old', 0],
  ])
})
