import { expect, mock, test } from 'claude-code/testing'

import { finishTool, fmtDur, markChecked, markPrompted, originOf, startTool, summarize, tailCells } from '../hooks/trace'
import { CWD, PANE, SURFACES, USAGE, drain, engine, runStep, textOf, toolChunk } from './kit'
import type { Script } from './kit'

const thinkThenBash: Script = {
  chunks: [
    { kind: 'thinking', index: 0, text: '실패 원인을 보려면 먼저 ' },
    { kind: 'thinking', index: 0, text: 'npm test 를 돌려봐야겠다.' },
    { kind: 'text', index: 1, text: '테스트를 먼저 돌려볼게요.' },
    toolChunk(2, 'tu-1', 'Bash'),
    { kind: 'input', index: 2, json: '{"command":"npm test"}' },
  ],
  uses: [{ name: 'Bash', input: { command: 'npm test' } }],
  answer: '테스트를 먼저 돌려볼게요.',
}

const retryBash: Script = {
  chunks: [
    { kind: 'thinking', index: 0, text: '다시 한 번 돌려 보자.' },
    toolChunk(1, 'tu-2', 'Bash'),
    { kind: 'input', index: 1, json: '{"command":"npm test"}' },
  ],
  uses: [{ name: 'Bash', input: { command: 'npm test' } }],
  answer: '',
}

test('a failing call the model retries reads as a story: what it said, the failed test twice, and the retry flagged with its fix', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on, [thinkThenBash, retryBash], {
    fail: name => (name === 'Bash' ? 'Exit code 1\nFAIL auth.spec.ts\nExpected 200, got 401' : undefined),
  })

  await $.turn.start({ text: '로그인 테스트 고쳐줘', turnId: 't1' })
  await runStep($, 't1', 0)
  await clock.advance(2000)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-1' })
  await runStep($, 't1', 1)
  await clock.advance(3000)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-2' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await textOf(ui)
    expect(await ui.find({ type: 'Text', text: /^흐름$/ }), all).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /» 테스트를 먼저 돌려볼게요\./ }), 'what the model said, as a » line').toBeDefined()
    expect(await ui.findAll({ type: 'Text', text: /^  ✗ 테스트$/ }), 'each failed run, named by what it does').toHaveLength(2)
    expect(await ui.find({ type: 'Text', text: /⎿ Exit code 1 … Expected 200, got 401/ }), 'the reason, one line').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✗ 실패 후 재시도 2번\s+npm test\s+→ 스킬에 맞는 명령, 또는 훅 후보/ }), 'the retry, with the harness to fix it').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /“로그인 테스트 고쳐줘”/ }), 'the prompt').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /도구 2번 · 참고 파일 0 · 고친 파일 0/ }), 'the counts').toBeDefined()
    // Left to 자세히: the thinking, the model, short times, the command as given.
    expect(await ui.find({ type: 'Text', text: /npm test 를 돌려봐야겠다/ }), 'no thinking by default').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /opus-5-5/ }), 'no model by default').toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /\d\.\ds/ }), 'no short times by default').toBeUndefined()
    await ui.unmount()
  }
})

test('a call put to the person reads as waiting on them, then as a stuck place pointing at a permission rule', async ($, on) => {
  const clock = mock.clock(on, { now: 5_000_000 })
  const editStep: Script = {
    chunks: [{ kind: 'thinking', index: 0, text: '설정 파일을 고쳐야 한다.' }, toolChunk(1, 'tu-edit', 'Edit')],
    uses: [{ name: 'Edit', input: { file_path: `${CWD}/src/config.ts` } }],
    answer: '',
  }
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  engine(on, [editStep], {
    hold: name => (name === 'Edit' ? released : undefined),
    check: name => (name === 'Edit' ? { decision: 'ask', reason: '파일 편집은 승인이 필요해요' } : { decision: 'allow' }),
  })

  await $.turn.start({ text: '설정 바꿔줘', turnId: 't2' })
  await runStep($, 't2', 0)
  const call = $.tool.call({ tool: 'Edit', file_path: `${CWD}/src/config.ts`, old_string: 'a', new_string: 'b', tool_use_id: 'tu-edit' })
  await clock.settle()
  await $.tool.check({ tool: 'Edit', input: { file_path: `${CWD}/src/config.ts` }, tool_use_id: 'tu-edit' })
  await $.classic.PermissionRequest({ tool_name: 'Edit', tool_input: { file_path: `${CWD}/src/config.ts` } })
  await clock.advance(12_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /사람 승인 기다리는 중 · 1\d초/ }), await textOf(ui)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /고침 config\.ts/ }), 'which call waits').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\? 고침\s+config\.ts/ }), 'the waiting call in the flow').toBeDefined()
    await ui.unmount()
  }

  await $.classic.PostToolUse({ tool_name: 'Edit', tool_input: {}, tool_response: {}, tool_use_id: 'tu-edit', duration_ms: 400 })
  release()
  await call

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /! 사람 승인 1\d초\s+config\.ts\s+→ 권한 규칙 후보/ }), all).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /사람 승인 1 \(1\d초\)/ }), 'the harness line counts it').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /승인 대기 1\d초/ }), 'where the time went').toBeDefined()
  await ui.unmount()
})

test('자세히 shows the commands, verdicts, steps and thinking; 지우기 clears the trace', async ($, on) => {
  mock.clock(on, { now: 9_000_000 })
  engine(on, [thinkThenBash])
  await $.turn.start({ text: '보여줘', turnId: 't3' })
  await runStep($, 't3', 0)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu-1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-1' })
  await $.turn.complete({ answer: '끝', durationMs: 1000, isAborted: false, turnId: 't3', reason: 'answer' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /완료 · 입력 대기 중/ }), await textOf(ui)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /✓ 테스트/ })).toBeDefined()
    expect(await ui.find({ key: 'detail' }), "{ key: 'detail' }").toMatchObject({ props: { label: '자세히' } })
    await ui.press({ key: 'detail' })
    expect(await ui.find({ key: 'detail' }), "{ key: 'detail' }").toMatchObject({ props: { label: '간단히' } })
    const all = await textOf(ui)
    expect(await ui.find({ type: 'Text', text: /npm test · \d\.\ds · 허용 · 규칙 Bash\(npm test:\*\)/ }), all).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /#1 · opus-5-5\/max · ctx 41\.0k · out 80/ }), 'the step, its model and tokens').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /생각 끝부분: …실패 원인을 보려면 먼저 npm test 를 돌려봐야겠다\./ }), 'the thinking').toBeDefined()
    await ui.press({ key: 'detail' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'clear' })
  expect(await ui.find({ type: 'Text', text: /✓ 테스트/ }), 'the flow is gone').toBeUndefined()
  await ui.unmount()
})

test('the pure helpers read calls, widths, times and refusals', () => {
  expect(summarize('Bash', { command: 'npm   test\n --watch' })).toBe('npm test --watch')
  expect(summarize('Read', { file_path: '/repo/src/a.ts' }, '/repo')).toBe('src/a.ts')
  expect(summarize('mcp__x__y', { tool: 'mcp__x__y', tool_use_id: 'id', query: 'q' })).toBe('q')
  expect(tailCells('가나다라마', 6)).toBe('…다라마')
  expect(fmtDur(65_000)).toBe('1m 05s')
  expect(fmtDur(2_500)).toBe('2.5s')

  const started = startTool([], 'main', 'x', 'Edit', 'a.ts', 0)
  const asked = markPrompted(markChecked(started, 'x', { decision: 'ask' }), 'main', 'Edit', 10)
  const refused = finishTool(asked, 'x', { kind: 'fail', text: "The user doesn't want to proceed with this tool use." }, 20)
  expect(refused[0]?.tools[0]).toMatchObject({ state: 'deny', note: '사용자가 거절함' })
})

test('a subagent shows as a card above the flow in the same words, and the pane follows it when its transcript is in view', async ($, on) => {
  const clock = mock.clock(on, { now: 2_000_000 })
  const spawnStep: Script = {
    chunks: [{ kind: 'thinking', index: 0, text: '코드베이스가 넓으니 탐색은 서브에이전트에 맡기자.' }, toolChunk(1, 'tu-agent', 'Agent')],
    uses: [{ name: 'Agent', input: { subagent_type: 'Explore', description: '로그인 코드 찾기' } }],
    answer: '',
  }
  const exploreStep: Script = {
    chunks: [{ kind: 'thinking', index: 0, text: 'auth 로 grep 하면 빠르겠다.' }, toolChunk(1, 'tu-grep', 'Bash')],
    uses: [{ name: 'Bash', input: { command: 'grep -rn login src' } }],
    answer: '',
  }
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  engine(on, [spawnStep, exploreStep], { hold: name => (name === 'Bash' ? released : undefined) })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-1' }))

  await $.turn.start({ text: '로그인 흐름 설명해줘', turnId: 't4' })
  await runStep($, 't4', 0)
  const agentCall = $.tool.call({ tool: 'Agent', subagent_type: 'Explore', description: '로그인 코드 찾기', prompt: 'find', tool_use_id: 'tu-agent' })
  await $.agent.spawn({
    tool_use_id: 'tu-agent',
    prompt: 'find',
    description: '로그인 코드 찾기',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: false,
    fork: false,
  })

  // The subagent's own request streams through the plugin untouched.
  const { chunks, response } = await drain(
    $.turn.step({ turnId: 'ag-run', index: 0, model: 'claude-haiku-5-5', messageCount: 1, agentId: 'ag-1' }),
  )
  expect(chunks).toEqual(exploreStep.chunks)
  expect(response).toEqual({
    turnId: 'ag-run',
    index: 0,
    answer: '',
    toolUses: [{ name: 'Bash', input: { command: 'grep -rn login src' } }],
    stopReason: 'tool_use',
    usage: USAGE,
  })

  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  const grep = $.tool.call({ tool: 'Bash', command: 'grep -rn login src', tool_use_id: 'tu-grep', agentId: 'ag-1' })
  await clock.advance(4000)

  const main = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(main)
  expect(await main.find({ type: 'Text', text: /● Explore · 로그인 코드 찾기/ }), all).toBeDefined()
  expect(await main.find({ type: 'Text', text: /검색 중 · [34]초 · 요청 1 · 도구 1/ }), 'what the agent does now').toBeDefined()
  expect(await main.find({ type: 'Text', text: /● 검색 "login"\s+src/ }), "the agent's call, in the flow's words").toBeDefined()
  expect(await main.find({ type: 'Text', text: /● 위임 Explore: 로그인 코드 찾기/ }), all).toBeDefined()
  await main.unmount()

  const inView = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, view: { agentId: 'ag-1' } } })
  expect(await inView.find({ type: 'Text', text: /서브에이전트 · Explore · 로그인 코드 찾기/ }), 'agent header').toBeDefined()
  expect(await inView.find({ type: 'Text', text: /● 검색 "login"/ }), "the agent's own flow").toBeDefined()
  expect(await inView.find({ type: 'Text', text: /위임 Explore/ }), 'main flow stays out').toBeUndefined()
  await inView.unmount()

  release()
  await grep
  await $.turn.complete({ answer: '찾았어요', durationMs: 4000, isAborted: false, turnId: 'ag-run', reason: 'answer', agentId: 'ag-1' })
  await agentCall

  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /Explore: 완료/ }), 'agent done').toBeDefined()
  await after.unmount()
})

test('inline above the prompt the pane keeps to the header, the latest lines and the counts', async ($, on) => {
  mock.clock(on, { now: 3_000_000 })
  const read = (id: string, path: string): Script => ({ chunks: [toolChunk(0, id, 'Read')], uses: [{ name: 'Read', input: { file_path: path } }], answer: '' })
  const grep: Script = { chunks: [toolChunk(0, 'g', 'Grep')], uses: [{ name: 'Grep', input: { pattern: 'x' } }], answer: '' }
  const edit: Script = { chunks: [toolChunk(0, 'e', 'Edit')], uses: [{ name: 'Edit', input: { file_path: `${CWD}/b.ts` } }], answer: '' }
  engine(on, [read('r', `${CWD}/a.ts`), grep, edit])
  await $.turn.start({ text: '짧게', turnId: 't5' })
  await runStep($, 't5', 0)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, tool_use_id: 'r' })
  await runStep($, 't5', 1)
  await $.tool.call({ tool: 'Grep', pattern: 'x', tool_use_id: 'g' })
  await runStep($, 't5', 2)
  await $.tool.call({ tool: 'Edit', file_path: `${CWD}/b.ts`, old_string: 'a', new_string: 'b', tool_use_id: 'e' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 40 } })
  const all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /✓ 고침\s+b\.ts/ }), all).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ 검색 "x"/ }), all).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /읽음\s+a\.ts/ }), 'older lines left out').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /도구 3번 · 참고 파일 1/ }), 'the counts').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^하네스$/ }), 'no sections inline').toBeUndefined()
  await ui.unmount()
})

test('an interrupted request closes the request beneath and reads as cut off', async ($, on) => {
  mock.clock(on, { now: 4_000_000 })
  let isClosed = false
  const endless: Script = { chunks: [{ kind: 'thinking', index: 0, text: '오래 생각하는 중' }], uses: [], answer: '', isEndless: true }
  engine(on, [endless], {
    onClosedEarly: () => {
      isClosed = true
    },
  })
  await $.turn.start({ text: '오래 걸리는 작업', turnId: 't6' })
  const stream = $.turn.step({ turnId: 't6', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  await stream.next()
  await stream.next()
  await stream.return(undefined as never)
  expect(isClosed, 'the request beneath was closed').toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /✗ 모델 요청이 끝나지 못함/ }), await textOf(ui)).toBeDefined()
  await ui.unmount()
})

test("the engine's own forks pass through untraced", async ($, on) => {
  mock.clock(on, { now: 6_000_000 })
  engine(on, [thinkThenBash])
  await $.turn.start({ text: '압축 중 내부 요청', turnId: 't7' })
  const { chunks, response } = await drain(
    $.turn.step({ turnId: 'fork', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'compact-fork' }),
  )
  expect(chunks).toEqual(thinkThenBash.chunks)
  expect(response).toMatchObject({ turnId: 'fork', toolUses: thinkThenBash.uses })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /테스트를 먼저|테스트|명령 실행/ }), 'the fork left no line').toBeUndefined()
  await ui.unmount()
})

const HANDBACK =
  '<agent-message from="ag-bg">\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user. The report follows:\n  done\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same session.'

test("a subagent's own turn stays with the agent, and its hand-back reads as its result", async ($, on) => {
  const clock = mock.clock(on, { now: 7_000_000 })
  const spawnStep: Script = {
    chunks: [toolChunk(0, 'tu-agent', 'Agent')],
    uses: [{ name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Sleep 60 then reply done' } }],
    answer: '',
  }
  const sleepStep: Script = { chunks: [toolChunk(0, 'tu-sleep', 'Bash')], uses: [{ name: 'Bash', input: { command: 'sleep 60' } }], answer: '' }
  const reply: Script = { chunks: [{ kind: 'text', index: 0, text: '띄웠어요' }], uses: [], answer: '띄웠어요' }
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  engine(on, [spawnStep, sleepStep, reply], { hold: name => (name === 'Bash' ? released : undefined) })
  on('agent.spawn', () => ({ model: 'claude-opus-5-5', agentId: 'ag-bg' }))

  await $.turn.start({ text: '테스트D', turnId: 'm1' })
  await runStep($, 'm1', 0)
  const agentCall = $.tool.call({
    tool: 'Agent',
    subagent_type: 'general-purpose',
    description: 'Sleep 60 then reply done',
    prompt: 'Bash 로 sleep 60',
    tool_use_id: 'tu-agent',
  })
  await $.agent.spawn({
    tool_use_id: 'tu-agent',
    prompt: 'Bash 로 sleep 60',
    description: 'Sleep 60 then reply done',
    subagentType: 'general-purpose',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await agentCall
  // The engine raises the subagent's own turn start, and every hook hears it.
  await $.turn.start({ text: 'Bash 로 sleep 60', turnId: 'ag-run', agentId: 'ag-bg' })
  await drain($.turn.step({ turnId: 'ag-run', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'ag-bg' }))
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  const sleep = $.tool.call({ tool: 'Bash', command: 'sleep 60', tool_use_id: 'tu-sleep', agentId: 'ag-bg' })
  await runStep($, 'm1', 1)
  await $.turn.complete({ answer: '띄웠어요', durationMs: 3000, isAborted: false, turnId: 'm1', reason: 'answer' })
  await clock.advance(30_000)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await textOf(ui)
    expect(await ui.find({ type: 'Text', text: /“테스트D”/ }), all).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /완료 · 입력 대기 중/ }), 'the main turn reads as done').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /도구 1번/ }), "the counts are the main turn's").toBeDefined()
    expect(await ui.find({ type: 'Text', text: /» 띄웠어요/ }), 'the answer, as the last said line').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /general-purpose · Sleep 60 then reply done · 백그라운드/ }), 'the running card').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /명령 실행 중 · (29|30)초/ }), 'what it does, for how long').toBeDefined()
    await ui.unmount()
  }

  release()
  await sleep
  await $.turn.complete({ answer: 'done', durationMs: 31_000, isAborted: false, turnId: 'ag-run', reason: 'answer', agentId: 'ag-bg' })
  await $.turn.start({ text: HANDBACK, turnId: 'm2' })
  await runStep($, 'm2', 0)
  await $.turn.complete({ answer: '띄웠어요', durationMs: 1000, isAborted: false, turnId: 'm2', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◀ general-purpose 결과 · done/ }), await textOf(ui)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /agent-message/ }), 'the raw frame stays out').toBeUndefined()
  await ui.unmount()
})

test('a forked skill shows under its Skill call once the session lists it, and its own view follows it', async ($, on) => {
  const clock = mock.clock(on, { now: 8_000_000 })
  const skillStep: Script = { chunks: [toolChunk(0, 'tu-skill', 'Skill')], uses: [{ name: 'Skill', input: { skill: 'verify', args: 'sandbox' } }], answer: '' }
  const forkStep: Script = {
    chunks: [{ kind: 'thinking', index: 0, text: '변경 파일부터 모으자.' }, toolChunk(1, 'tu-diff', 'Bash')],
    uses: [{ name: 'Bash', input: { command: 'git diff --stat' } }],
    answer: '',
  }
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  engine(on, [skillStep, forkStep], {
    hold: name => (name === 'Bash' ? released : undefined),
    answer: name =>
      name === 'Skill' ? { success: true, commandName: 'verify', status: 'forked', agentId: 'sk-1', result: 'launched', background: true } : undefined,
  })
  on('agent.list', () => ({ value: [{ id: 'sk-1', type: 'acme-verify-orchestrator', description: 'verify', status: 'running' as const }] }))

  await $.turn.start({ text: '/verify sandbox', turnId: 'm3' })
  await runStep($, 'm3', 0)
  await $.tool.call({ tool: 'Skill', skill: 'verify', args: 'sandbox', tool_use_id: 'tu-skill' })
  // A forked skill raises no agent.spawn: its loop is known by its turn start and the session's agent list.
  await $.turn.start({ text: 'verify 스킬 본문', turnId: 'fork-run', agentId: 'sk-1' })
  await drain($.turn.step({ turnId: 'fork-run', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'sk-1' }))
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  const diff = $.tool.call({ tool: 'Bash', command: 'git diff --stat', tool_use_id: 'tu-diff', agentId: 'sk-1' })
  await clock.advance(5000)

  const main = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const all = await textOf(main)
  expect(await main.find({ type: 'Text', text: /acme-verify-orchestrator · verify · 스킬/ }), all).toBeDefined()
  expect(await main.find({ type: 'Text', text: /git diff 실행 중 · [45]초/ }), 'what the fork does').toBeDefined()
  expect(await main.find({ type: 'Text', text: /● 스킬 verify/ }), 'the Skill call in the main flow, live while its fork runs').toBeDefined()
  expect(await main.find({ type: 'Text', text: /스킬 1 \(verify\)/ }), 'the harness line').toBeDefined()
  expect(await main.find({ type: 'Text', text: /“\/verify sandbox”/ }), "the person's prompt keeps the header").toBeDefined()
  await main.unmount()

  const inView = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, view: { agentId: 'sk-1' } } })
  expect(await inView.find({ type: 'Text', text: /● git diff/ }), "the fork's own flow").toBeDefined()
  await inView.unmount()

  release()
  await diff
})

test("an engine fork's turn start is neither traced nor taken for the person's turn", async ($, on) => {
  mock.clock(on, { now: 6_500_000 })
  engine(on, [thinkThenBash])
  on('agent.list', () => ({ value: [] }))
  await $.turn.start({ text: '압축 전에 하던 일', turnId: 't8' })
  await $.turn.start({ text: '', turnId: 'fork', agentId: 'compact-fork' })
  await drain($.turn.step({ turnId: 'fork', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'compact-fork' }))

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /“압축 전에 하던 일”/ }), "the person's turn keeps the header").toBeDefined()
  expect(await ui.find({ type: 'Text', text: /테스트|명령 실행/ }), 'the fork left no line').toBeUndefined()
  await ui.unmount()
})

test('a hand-back, a peer message and a task notice read as where the turn came from', () => {
  expect(originOf(HANDBACK)).toEqual({ kind: 'agent', agentId: 'ag-bg', isHandback: true, text: 'done' })
  expect(originOf('Another Claude session sent a message:\n<agent-message from="tm-1">\n안녕\n</agent-message>')).toEqual({
    kind: 'agent',
    agentId: 'tm-1',
    isHandback: false,
    text: '안녕',
  })
  expect(
    originOf('<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent "Sleep" finished</summary>\n</task-notification>'),
  ).toEqual({ kind: 'notice', text: 'Agent "Sleep" finished' })
  expect(originOf('그냥 프롬프트 <agent-message from="x">')).toBeUndefined()
})
