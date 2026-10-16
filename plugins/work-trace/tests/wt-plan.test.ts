import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { applyCall, noticeOf, parsePhases, parsePlan } from '../hooks/plan'
import { itemWindow } from '../hooks/plan-view'

const SURFACES = ['terminal', 'desktop'] as const

const PANE = {
  plugin: 'work-trace',
  component: 'Pane',
  requestId: 'work-trace',
  props: {
    title: '작업 추적',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

const INLINE = { ...PANE, props: { ...PANE.props, placement: 'inline', bodyColumns: 40 } } as const

/** The engine beneath the plugin: each tool answers what `answer` gives for it. */
function engine(on: On, answer: (name: string, input: Record<string, unknown>) => unknown = () => ({ ok: true })) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('tool.call', ($, e) => ({ result: answer(String(e.tool), e as unknown as Record<string, unknown>) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.list', () => ({ value: [] }))
}

const todos = (statuses: string[]) =>
  [
    { content: '원인 조사', activeForm: '원인을 조사하는 중' },
    { content: '수정 구현', activeForm: '수정을 구현하는 중' },
    { content: '테스트 추가', activeForm: '테스트를 추가하는 중' },
  ].map((t, i) => ({ ...t, status: statuses[i] ?? 'pending' }))

/** TodoWrite's result: the list before and after. */
function todoAnswer(name: string, input: Record<string, unknown>): unknown {
  return name === 'TodoWrite' ? { oldTodos: [], newTodos: input.todos } : { ok: true }
}

test('with no list or plan set out the plan section stays hidden', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.turn.start({ text: '그냥 질문', turnId: 'p0' })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu-ls' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^계획$/ }), 'no plan section').toBeUndefined()
    await ui.unmount()
  }
})

test("TodoWrite's list shows each item's state, the one under way and the progress", async ($, on) => {
  mock.clock(on, { now: 1_100_000 })
  engine(on, todoAnswer)
  await $.turn.start({ text: '버그 고쳐줘', turnId: 'p1' })
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['in_progress']), tool_use_id: 'tu-todo-1' })
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'in_progress']), tool_use_id: 'tu-todo-2' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^계획$/ }), 'the section').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1\/3 완료 · 33%/ }), 'progress').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^수정을 구현하는 중$/ }), 'the item under way, as it says it').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^원인 조사$/ }), 'the done item').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /테스트 추가/ }), 'the pending item').toBeDefined()
    await ui.unmount()
  }

  // A narrow inline pane keeps to the head and the item under way.
  const inline = await $.ui.mount({ ...INLINE, surface: 'terminal' })
  expect(await inline.find({ type: 'Text', text: /1\/3 완료 · 33%/ })).toBeDefined()
  expect(await inline.find({ type: 'Text', text: /^수정을 구현하는 중$/ })).toBeDefined()
  expect(await inline.find({ type: 'Text', text: /테스트 추가/ }), 'pending items left out inline').toBeUndefined()
  await inline.unmount()
})

test("a subagent's todos stay its own: under its type on main, alone in its own view", async ($, on) => {
  mock.clock(on, { now: 1_200_000 })
  engine(on, todoAnswer)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-1' }))
  await $.turn.start({ text: '조사 맡겨', turnId: 'p2' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: '메인 할 일', activeForm: '메인 작업 중', status: 'in_progress' }], tool_use_id: 'tu-main' })
  await $.agent.spawn({
    tool_use_id: 'tu-agent',
    prompt: 'find',
    description: '코드 찾기',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'completed', 'in_progress']), tool_use_id: 'tu-sub', agentId: 'ag-1' })

  const main = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await main.find({ type: 'Text', text: /^할 일 · Explore$/ }), "the agent's list under its type").toBeDefined()
  expect(await main.find({ type: 'Text', text: /2\/3 완료 · 67%/ }), "the agent's progress").toBeDefined()
  expect(await main.find({ type: 'Text', text: /0\/1 완료 · 0%/ }), "main's own list").toBeDefined()
  await main.unmount()

  const inView = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, view: { agentId: 'ag-1' } } })
  expect(await inView.find({ type: 'Text', text: /2\/3 완료 · 67%/ })).toBeDefined()
  expect(await inView.find({ type: 'Text', text: /메인 작업 중/ }), "main's list stays out of the agent's view").toBeUndefined()
  await inView.unmount()
})

test('the Task tools build one list: created, moved on, deleted, and squared with a listing', async ($, on) => {
  mock.clock(on, { now: 1_300_000 })
  let next = 0
  engine(on, (name, input) => {
    if (name === 'TaskCreate') return { task: { id: String(++next), subject: input.subject } }
    if (name === 'TaskUpdate') return { success: true, taskId: input.taskId, updatedFields: ['status'], statusChange: { from: 'pending', to: input.status } }
    if (name === 'TaskList') return { tasks: [{ id: '1', subject: '스키마 설계', status: 'completed', blockedBy: [] }, { id: '3', subject: '문서화', status: 'pending', blockedBy: [] }] }
    return { ok: true }
  })
  await $.turn.start({ text: '기능 만들어줘', turnId: 'p3' })
  await $.tool.call({ tool: 'TaskCreate', subject: '스키마 설계', description: 'd', activeForm: '스키마를 설계하는 중', tool_use_id: 'tc-1' })
  await $.tool.call({ tool: 'TaskCreate', subject: '버릴 일', description: 'd', tool_use_id: 'tc-2' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress', tool_use_id: 'tu-1' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'deleted', tool_use_id: 'tu-2' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^태스크$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^스키마를 설계하는 중$/ }), 'the task under way').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^버릴 일$|· 버릴 일$/ }), 'a deleted task leaves').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /0\/1 완료 · 0%/ })).toBeDefined()
  await ui.unmount()

  // A listing is the list as it stands: task 3 was made where the trace did not see it.
  await $.tool.call({ tool: 'TaskList', tool_use_id: 'tl-1' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /1\/2 완료 · 50%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /문서화/ })).toBeDefined()
  await ui.unmount()
})

const PLAN = `# 로그인 리팩터링 계획

## 배경
세션 만료 처리가 흩어져 있다.

## 단계
1. **세션 모듈** 분리
2. 만료 처리를 미들웨어로 이동
3. 테스트 보강

\`\`\`ts
- 코드 블록 안 목록은 단계가 아님
\`\`\`
`

test("the plan put to the person shows as its steps, with no progress it can't know", async ($, on) => {
  mock.clock(on, { now: 1_400_000 })
  engine(on, name => (name === 'ExitPlanMode' ? { plan: PLAN, isAgent: false, filePath: '/home/u/.claude/plans/x.md' } : { ok: true }))
  await $.turn.start({ text: '계획 세워줘', turnId: 'p4' })
  await $.tool.call({ tool: 'ExitPlanMode', tool_use_id: 'tu-plan' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /로그인 리팩터링 계획/ }), 'the title').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /승인됨 · 3단계 · 진행 상태는 기록되지 않음/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  · 세션 모듈 분리$/ }), 'a step, its markup gone').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /코드 블록 안/ }), 'fenced lines are no steps').toBeUndefined()
    await ui.unmount()
  }
})

test("a workflow shows its declared phases, its agents' count, and the end its notice brings", async ($, on) => {
  mock.clock(on, { now: 1_500_000 })
  const script = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files',
  phases: [{ title: 'Review' }, { title: "Verify" }],
}
const x = phase('Review')
`
  engine(on, name => (name === 'Workflow' ? { status: 'async_launched', taskId: 'wf-task-1', workflowName: 'review-changes', runId: 'wf_abc' } : { ok: true }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: `wa-${++spawned}` }))
  await $.turn.start({ text: '워크플로 돌려줘', turnId: 'p5' })
  await $.tool.call({ tool: 'Workflow', script, tool_use_id: 'tu-wf' })
  for (const description of ['review:bugs', 'review:perf']) {
    await $.agent.spawn({
      tool_use_id: 'tu-wf',
      prompt: 'review',
      description,
      subagentType: 'general-purpose',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
      workflow: { runId: 'wf_abc', agentIndex: spawned + 1 },
    })
  }
  await $.turn.complete({ answer: 'done', durationMs: 10, isAborted: false, turnId: 'w1', reason: 'answer', agentId: 'wa-1' })

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^워크플로 · review-changes / }), 'the run under its name').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /실행 중 · 에이전트 1\/2 완료/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Verify/ }), 'a declared phase').toBeDefined()
  await ui.unmount()

  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'p5', reason: 'answer' })
  await $.turn.start({
    text: '<task-notification>\n<task-id>wf-task-1</task-id>\n<tool-use-id>tu-wf</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>',
    turnId: 'p6',
  })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^완료 · 에이전트 1\/2 완료$/ }), 'the run reads as finished').toBeDefined()
  await ui.unmount()
})

test('/trace clear lets finished lists go and keeps the one under way', async ($, on) => {
  mock.clock(on, { now: 1_600_000 })
  engine(on, todoAnswer)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-9' }))
  await $.turn.start({ text: '정리', turnId: 'p7' })
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'in_progress']), tool_use_id: 'tu-a' })
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  await $.tool.call({ tool: 'TodoWrite', todos: todos(['completed', 'completed', 'completed']), tool_use_id: 'tu-b', agentId: 'ag-9' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /3\/3 완료 · 100%/ })).toBeDefined()
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /3\/3 완료 · 100%/ }), 'the finished list left').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1\/3 완료 · 33%/ }), 'the list under way stays').toBeDefined()
  await ui.unmount()
})

test('the plan helpers read markdown plans, workflow phases, notices and item windows', () => {
  expect(parsePlan(PLAN)).toMatchObject({
    title: '로그인 리팩터링 계획',
    hasStatus: false,
    items: [{ text: '세션 모듈 분리' }, { text: '만료 처리를 미들웨어로 이동' }, { text: '테스트 보강' }],
  })
  const boxes = parsePlan('- [x] 하나\n- [ ] 둘')
  expect(boxes.hasStatus).toBe(true)
  expect(boxes.items.map(i => i.status)).toEqual(['done', 'pending'])
  // A plan with no list: its sections are its steps.
  expect(parsePlan('# 제목\n## 첫째\n본문\n## 둘째').items.map(i => i.text)).toEqual(['첫째', '둘째'])

  expect(parsePhases("export const meta = {\n  name: 'x',\n  phases: [{ title: 'A' }, { title: 'B', detail: 'b' }],\n}")).toEqual(['A', 'B'])
  expect(parsePhases("export const meta = {\n  name: 'x',\n}")).toEqual([])

  expect(noticeOf('<task-notification>\n<task-id>t</task-id>\n<status>killed</status>\n</task-notification>')).toEqual({ taskId: 't', status: 'killed' })
  expect(noticeOf('평범한 프롬프트')).toBeUndefined()

  const items = Array.from({ length: 10 }, (_, i) => ({ key: String(i), text: String(i), status: i < 6 ? ('done' as const) : ('pending' as const) }))
  expect(itemWindow(items, 3)).toMatchObject({ before: 5, after: 2, shown: [{ key: '5' }, { key: '6' }, { key: '7' }] })

  // A failed or refused call leaves no mark; an unknown task id is filed when an update names it.
  expect(applyCall([], 'main', 'Workflow', 'tu', { script: '' }, { status: 'error' }, 0)).toEqual([])
  expect(applyCall([], 'main', 'TaskUpdate', 'tu', { taskId: '7', status: 'in_progress' }, { success: true }, 0)[0]?.items).toEqual([
    { key: '7', text: '#7', status: 'active' },
  ])
})
