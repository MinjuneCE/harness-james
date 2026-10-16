// 0.3.0: the flow's words, its grouping, the files looked at, the stuck
// signals, and the promise under them all: the model never waits on the trace.
import { expect, mock, test } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'

import type { TraceStep, TraceTool } from '../types'
import { BLOCK, actOf, bashAct, buildFlow, harnessLine, harnessOf, refsOf, splitCommand, timeLine, timeOf } from '../hooks/flow'
import type { FlowLine, Where } from '../hooks/flow'
import { newStep } from '../hooks/trace'
import { CWD, HOME, PANE, SURFACES, USAGE, engine, runStep, textOf, toolChunk } from './kit'
import type { Script } from './kit'

const W: Where = { cwd: CWD, home: HOME }

let seq = 0
function tool(name: string, input: Record<string, unknown>, extra: Partial<TraceTool> = {}): TraceTool {
  seq += 1
  return { id: `t${seq}`, name, summary: '', state: 'ok', queuedAt: 0, startedAt: 0, endedAt: 100, input, ...extra }
}
function step(index: number, tools: TraceTool[], extra: Partial<TraceStep> = {}): TraceStep {
  const s = newStep(`main:t:${index}`, 'main', 't', index, 'claude-opus-5-5', undefined, index * 1000)
  return { ...s, phase: 'done', endedAt: index * 1000 + 500, firstAt: index * 1000 + 100, stop: 'tool_use', tools, thinkMs: 0, writeMs: 0, ...extra }
}
const flowOf = (steps: TraceStep[], now = 100_000): FlowLine[] => buildFlow(steps, { now, w: W, isExpanded: false, isLive: false })
const show = (lines: readonly FlowLine[]): string[] =>
  lines.map(l => `${l.mark} ${l.label}${l.targets.length > 0 ? ` | ${l.targets.join(' · ')}` : ''}${l.hint !== undefined ? ` → ${l.hint}` : ''}`)
const label = (name: string, input: Record<string, unknown>, extra: Partial<TraceTool> = {}): string => {
  const a = actOf(tool(name, input, extra), W)
  return a.targets.length > 0 ? `${a.label} | ${a.targets.join(' · ')}` : a.label
}

test('each tool is named by rule: reads, finds, changes, delegation and the rest', () => {
  expect(label('Read', { file_path: `${CWD}/src/a.ts` })).toBe('읽음 | a.ts')
  expect(label('Read', { file_path: `${CWD}/src/a.ts`, offset: 10, limit: 40 })).toBe('부분 읽음 | a.ts')
  expect(label('Read', { file_path: `${HOME}/.claude/projects/-x/memory/MEMORY.md` })).toBe('메모리 확인 | MEMORY.md')
  expect(label('Read', { file_path: `${HOME}/.claude/skills/verify/SKILL.md` })).toBe('스킬 문서 읽음 | SKILL.md')
  expect(label('Read', { file_path: `${CWD}/CLAUDE.md` })).toBe('지침 읽음 | CLAUDE.md')
  expect(label('Grep', { pattern: 'isStaged', path: `${CWD}/hooks/files.ts` })).toBe('검색 "isStaged" | files.ts')
  expect(label('Grep', { pattern: 'a-very-long-search-pattern', path: `${CWD}/hooks` })).toBe('검색 "a-very-long-s…" | hooks')
  expect(label('Glob', { pattern: '**/*.tsx' })).toBe('파일 찾기 "**/*.tsx"')
  expect(label('Edit', { file_path: `${CWD}/a.ts` })).toBe('고침 | a.ts')
  expect(label('MultiEdit', { file_path: `${CWD}/a.ts` })).toBe('고침 | a.ts')
  expect(label('Write', { file_path: `${CWD}/n.ts` }, { resultType: 'create' })).toBe('새 파일 | n.ts')
  expect(label('Write', { file_path: `${CWD}/n.ts` }, { resultType: 'update' })).toBe('덮어씀 | n.ts')
  expect(label('NotebookEdit', { notebook_path: `${CWD}/n.ipynb` })).toBe('노트북 고침 | n.ipynb')
  expect(label('Agent', { subagent_type: 'Explore', description: '호출처 찾기' })).toBe('위임 Explore: 호출처 찾기')
  expect(label('Task', { subagent_type: 'Plan', description: '설계' })).toBe('위임 Plan: 설계')
  expect(label('Skill', { skill: 'verify', args: 'x' })).toBe('스킬 verify')
  expect(label('Workflow', { script: "export const meta = {\n  name: 'review-changes',\n}" })).toBe('워크플로 review-changes')
  expect(label('WebFetch', { url: 'https://docs.anthropic.com/en/x?y=1' })).toBe('웹 읽음 docs.anthropic.com')
  expect(label('WebSearch', { query: 'claude code hooks' })).toBe('웹 검색 "claude code hooks"')
  expect(label('AskUserQuestion', { questions: [{ question: '어느 쪽?' }] })).toBe('질문 "어느 쪽?"')
  expect(label('ToolSearch', { query: 'select:X' })).toBe('도구 찾기')
  expect(label('mcp__context7__query-docs', { q: 'x' })).toBe('context7 query-docs')
  expect(label('SomethingNew', {})).toBe('SomethingNew')
})

test('a Bash line splits at && ; || | outside quotes, takes cd as its folder, and names each part', () => {
  const b = (cmd: string, desc?: string): string => {
    const a = bashAct(cmd, desc, W)
    return a.targets.length > 0 ? `${a.label} | ${a.targets.join(' · ')}` : a.label
  }
  expect(splitCommand(`echo "a && b | c" && ls; git status || true`).map(s => s.text)).toEqual(['echo "a && b | c"', 'ls', 'git status', 'true'])
  expect(splitCommand('cat > out.txt <<EOF\nrm -rf /\nEOF\nls').map(s => s.text), 'a heredoc body is no command').toEqual(['cat > out.txt <<EOF', 'ls'])
  expect(b('cd ~/.claude/mods/work-trace && cat .claude-plugin/plugin.json && grep -n "staged" hooks/files.ts | head -5 && diff a.json ~/.claude/plugins/installed_plugins.json')).toBe(
    '읽음·검색·비교 | plugin.json · files.ts · a.json · installed_plugins.json',
  )
  expect(b('grep -rn "a && b" src | head -20')).toBe('검색 "a && b" | src')
  expect(b('rg -n -A 3 isStaged hooks/files.ts hooks/files-hooks.ts')).toBe('검색 "isStaged" | files.ts · files-hooks.ts')
  expect(b('ls -la ~/.claude/mods')).toBe('폴더 둘러봄 | ~/.claude/mods')
  expect(b('find . -name "*.ts" -maxdepth 2')).toBe('폴더 둘러봄 | .')
  expect(b('sed -n 1,80p hooks/view.tsx')).toBe('읽음 | view.tsx')
  expect(b('cat ~/.claude/projects/-x/memory/MEMORY.md')).toBe('메모리 확인 | MEMORY.md')
  expect(b('jq .version plugin.json')).toBe('읽음 | plugin.json')
  expect(b('git -C repo log --oneline -5')).toBe('git log')
  expect(b('git status && git diff --stat')).toBe('git status·git diff')
  expect(b('npm test')).toBe('테스트')
  expect(b('cd work-trace && claude plugin test .')).toBe('테스트')
  expect(b('claude plugin validate work-trace')).toBe('검증')
  expect(b('npx vitest run')).toBe('테스트')
  expect(b('pnpm run build')).toBe('빌드')
  expect(b('curl -s https://api.example.com/v1/x')).toBe('웹 요청 | api.example.com')
  expect(b('mkdir -p out && cp a.ts out/')).toBe('파일 작업 | out · a.ts')
  expect(b('cat > notes.md <<EOF\n# hi\nEOF')).toBe('파일 작업 | notes.md')
  expect(b('echo hi && true')).toBe('명령 실행')
  expect(b('python3 tools/x.py --flag', 'Run the report script')).toBe('Run the report script')
  expect(b('python3 tools/x.py --flag')).toBe('명령 실행 python3')
  expect(b('ls a b c d e f')).toBe('폴더 둘러봄 | a · b · c · d · e · f')
  const four = ['grep', 'diff', 'cat', 'ls'].map(c => `${c} x.ts`).join(' && ')
  expect(bashAct(four, undefined, W).label, 'three verbs at most').toBe('검색·비교·읽음')
})

test('calls sent together read as one line, like calls in a row as one counted line, and failures keep their own', () => {
  const steps = [
    step(0, [tool('Read', { file_path: `${CWD}/m/a.ts` }), tool('Read', { file_path: `${CWD}/m/b.ts` }), tool('Read', { file_path: `${CWD}/m/c.ts` })]),
    step(1, [tool('Read', { file_path: `${CWD}/m/t.ts`, offset: 1, limit: 9 })], { said: '패널 코드를 직접 확인할게요.\n둘째 줄' }),
    step(2, [tool('Read', { file_path: `${CWD}/m/r.ts`, offset: 1, limit: 9 })]),
    step(3, [tool('Grep', { pattern: 'staged', path: `${CWD}/m/f.ts` })]),
    step(4, [tool('Grep', { pattern: 'isStaged' })]),
    step(5, [tool('Bash', { command: 'npm test' }, { state: 'fail', note: 'Exit code 1' })]),
    step(6, [tool('Bash', { command: 'npm test' }, { state: 'ok' })]),
  ]
  expect(show(flowOf(steps))).toEqual([
    '✓ 3개 동시 읽음 | a.ts · b.ts · c.ts',
    '» 패널 코드를 직접 확인할게요.',
    '✓ 부분 읽음 ×2 | t.ts · r.ts',
    '✓ 검색 ×2 | "staged" · "isStaged"',
    '✗ 테스트',
    '✓ 테스트',
  ])
  expect(flowOf(steps)[4]?.reason).toBe('Exit code 1')

  // More than four targets on a line are the pane's to cut; the line keeps them all.
  const many = [step(0, Array.from({ length: 6 }, (_, i) => tool('Read', { file_path: `${CWD}/x/f${i}.ts` })))]
  expect(show(flowOf(many))).toEqual(['✓ 6개 동시 읽음 | f0.ts · f1.ts · f2.ts · f3.ts · f4.ts · f5.ts'])
})

test('the files looked at group by folder, count repeats, keep web apart, and the header count matches', async ($, on) => {
  const steps = [
    step(0, [tool('Read', { file_path: `${HOME}/.claude/mods/work-trace/hooks/view.tsx` }), tool('Read', { file_path: `${HOME}/.claude/mods/work-trace/hooks/trace.ts` })]),
    step(1, [tool('Read', { file_path: `${HOME}/.claude/mods/work-trace/hooks/trace.ts`, offset: 1 })]),
    step(2, [tool('Bash', { command: `cat ${HOME}/.claude/plugins/installed_plugins.json` })]),
    step(3, [tool('Read', { file_path: `${HOME}/.claude/projects/-x/memory/project_claude_mods.md` })]),
    step(4, [tool('Bash', { command: 'ls ~/.claude/mods' }), tool('WebFetch', { url: 'https://docs.anthropic.com/en/hooks' })]),
    step(5, [tool('Edit', { file_path: `${CWD}/changed.ts` })]),
  ]
  const refs = refsOf(steps, W)
  expect(refs.count).toBe(4)
  expect(refs.rows).toEqual([
    { label: 'work-trace/hooks', items: ['view.tsx', 'trace.ts ×2'] },
    { label: '그 밖', items: ['installed_plugins.json', 'project_claude_mods.md'] },
  ])
  expect(refs.web).toEqual(['docs.anthropic.com/en/hooks'])

  mock.clock(on, { now: 20_000_000 })
  const script = (id: string, name: string): Script => ({ chunks: [toolChunk(0, id, name)], uses: [], answer: '' })
  engine(on, [script('r1', 'Read'), script('r2', 'Read'), script('b1', 'Bash'), script('w1', 'WebFetch')])
  await $.turn.start({ text: '살펴봐', turnId: 'r' })
  await runStep($, 'r', 0)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/hooks/a.ts`, tool_use_id: 'r1' })
  await runStep($, 'r', 1)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/hooks/b.ts`, tool_use_id: 'r2' })
  await runStep($, 'r', 2)
  await $.tool.call({ tool: 'Bash', command: 'cat hooks/a.ts README.md && ls docs', tool_use_id: 'b1' })
  await runStep($, 'r', 3)
  await $.tool.call({ tool: 'WebFetch', url: 'https://example.com/a', prompt: 'x', tool_use_id: 'w1' })
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const all = await textOf(ui)
    expect(await ui.find({ type: 'Text', text: /참고 파일 3 · / }), all).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^참고한 파일 3$/ }), 'the section says the same count').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /  hooks\s+a\.ts ×2 · b\.ts/ }), 'by folder, repeats counted').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /그 밖\s+README\.md/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /웹\s+example\.com\/a/ }), 'web apart').toBeDefined()
    expect(await ui.find({ type: 'Text', text: /docs$/ }), 'a folder looked over stays in the flow alone').toBeDefined()
    await ui.unmount()
  }
})

test('each stuck signal shows on its line past its threshold, with the harness piece to fix it', () => {
  expect(BLOCK).toEqual({ rereadFrom: 3, searchRun: 4, retryFails: 2, humanWaitMs: 10_000, thinkMs: 120_000, toolMs: 60_000, judgeMs: 5_000, firstChunkMs: 20_000 })
  const read = (): TraceTool => tool('Read', { file_path: `${CWD}/trace.ts`, offset: 1 })
  const reread = show(flowOf([step(0, [read()]), step(1, [read()]), step(2, [read()])]))
  expect(reread).toEqual(['✓ 부분 읽음 ×3 | trace.ts', '! 같은 파일 3번째 | trace.ts → 요약 문서·메모리 후보'])
  expect(show(flowOf([step(0, [read()]), step(1, [read()])])), 'twice is no signal').toEqual(['✓ 부분 읽음 ×2 | trace.ts'])

  const grep = (p: string): TraceTool => tool('Grep', { pattern: p })
  expect(show(flowOf([0, 1, 2, 3].map(i => step(i, [grep(['staged', 'isStaged', 'stage', 'Staged'][i] ?? '')]))))).toEqual([
    '✓ 검색 ×4 | "staged" · "isStaged" · "stage" · "Staged"',
    '! 검색 4번 연달아 | "staged" · "isStaged" · … → 위치 안내(CLAUDE.md·스킬) 후보',
  ])
  expect(show(flowOf([0, 1, 2].map(i => step(i, [grep(`p${i}`)])))).filter(l => l.startsWith('!')), 'three in a row is no signal').toEqual([])

  const fail = (): TraceTool => tool('Bash', { command: 'npm test -- auth' }, { state: 'fail', note: 'Exit code 1' })
  expect(show(flowOf([step(0, [fail()]), step(1, [fail()])])).filter(l => !l.startsWith('✗ 테스트'))).toEqual([
    '✗ 실패 후 재시도 2번 | npm test -- auth → 스킬에 맞는 명령, 또는 훅 후보',
  ])
  expect(show(flowOf([step(0, [fail()])])).length, 'one failure is no retry').toBe(1)

  const asked = (wait: number, isPrompted: boolean): TraceTool =>
    tool('Bash', { command: 'git push' }, { isAsked: true, isPrompted, startedAt: 0, endedAt: wait + 300, execMs: 300, promptedAt: 0 })
  expect(show(flowOf([step(0, [asked(80_000, true)])]))).toContain('! 사람 승인 1분 20초 | git push → 권한 규칙 후보')
  expect(show(flowOf([step(0, [asked(9_900, true)])])).some(l => l.includes('사람 승인')), 'under ten seconds').toBe(false)
  // A dialog a hook or an ask rule asked for on purpose is no place for an allow rule.
  const byHook = (): TraceTool => ({ ...asked(80_000, true), check: { decision: 'ask', hook: 'PreToolUse', reason: 'push 금지' } })
  const byRule = (): TraceTool => ({ ...asked(80_000, true), check: { decision: 'ask', rule: 'Bash(git push:*)' } })
  const byMode = (): TraceTool => ({ ...asked(80_000, true), check: { decision: 'ask', reason: '자동 모드 분류기' } })
  expect(show(flowOf([step(0, [byHook()])]))).toContain('! 사람 승인 1분 20초 | git push → 의도된 확인 (훅·규칙)')
  expect(show(flowOf([step(0, [byRule()])]))).toContain('! 사람 승인 1분 20초 | git push → 의도된 확인 (훅·규칙)')
  expect(show(flowOf([step(0, [byMode()])])), 'a classifier or rule-less ask still points at a rule').toContain('! 사람 승인 1분 20초 | git push → 권한 규칙 후보')
  expect(show(flowOf([step(0, [asked(6_000, false)])]))).toContain('! 자동 판정 6초 | git push → 권한 규칙 후보')
  expect(show(flowOf([step(0, [asked(4_000, false)])])).some(l => l.includes('자동 판정')), 'under five seconds').toBe(false)

  const slow = tool('Bash', { command: 'npm run build' }, { startedAt: 0, endedAt: 70_000, execMs: 70_000 })
  expect(show(flowOf([step(0, [slow])]))).toContain('! 오래 걸림 1분 10초 | 빌드 → 명령·스크립트 개선 후보')

  const thought = step(0, [tool('Grep', { pattern: 'x' })], { thinkMs: 125_000 })
  expect(show(flowOf([thought]))[0]).toBe('! 2분 5초 고민 후 선택 | Grep → 판단 근거 문서·스킬 후보')
  expect(show(flowOf([step(0, [tool('Grep', { pattern: 'x' })], { thinkMs: 119_000 })])).some(l => l.includes('고민')), 'under two minutes').toBe(false)

  const late = step(0, [], { startedAt: 0, firstAt: 25_000, stop: 'end_turn', said: '답' })
  expect(show(flowOf([late]))[0]).toBe('! 응답 대기 25초')
  expect(show(flowOf([step(0, [], { stop: 'max_tokens' })]))).toContain('! 출력 한도에 걸려 잘림')
  expect(show(flowOf([step(0, [], { stop: 'model_context_window_exceeded' })]))).toContain('✗ 컨텍스트 창을 넘김')
  expect(show(flowOf([step(0, [tool('Edit', { file_path: `${CWD}/s.ts` }, { state: 'deny', note: '자동 모드가 거부' })])]))).toEqual(['! 고침 | s.ts'])
  const compacted = buildFlow([step(0, [])], { now: 100_000, w: W, isExpanded: false, isLive: false, compactions: [{ startedAt: 0, endedAt: 75_000, trigger: 'auto' }] })
  expect(show(compacted)).toContain('! 컨텍스트 압축 1분 15초 (자동)')
})

test('where the time went and the harness touched, in one line each', () => {
  const s0 = step(0, [tool('Bash', { command: 'npm test' }, { startedAt: 30_000, endedAt: 38_000, execMs: 8_000 })], {
    startedAt: 0,
    firstAt: 30_000,
    endedAt: 30_000,
    thinkMs: 140_000,
  })
  expect(timeLine(timeOf([s0], 200_000))).toBe('생각 2분 20초 ━━━━━━━━── · 응답 대기 30초 · 도구 8초')

  const hooked = tool('Bash', { command: 'git push' }, { check: { decision: 'deny', hook: 'PreToolUse' }, state: 'deny' })
  const contexted = tool('Edit', { file_path: `${CWD}/a.ts` }, { hookContext: 1 })
  const prompted = tool('Bash', { command: 'rm x' }, { isPrompted: true, isAsked: true, promptedAt: 0, startedAt: 0, endedAt: 12_000, execMs: 10 })
  const memory = tool('Read', { file_path: `${HOME}/.claude/projects/-x/memory/a.md` })
  const skill = tool('Skill', { skill: 'verify' })
  const h = harnessOf([step(0, [hooked, contexted, prompted, memory, skill])], [], 0, 100_000, W)
  expect(harnessLine(h)).toBe('스킬 1 (verify) · 훅 개입 2 · 자동 허용 3 · 사람 승인 1 (11초) · 거부 1 · 메모리 1')
  expect(h.hookDetails).toEqual(['PreToolUse → deny · git push', 'PostToolUse 내용 추가 1 · 고침'])
  const plain = harnessOf([step(0, [tool('Read', { file_path: `${CWD}/a.ts` }), tool('Grep', { pattern: 'x' })])], [], 0, 0, W)
  expect(harnessLine(plain)).toBe('스킬 0 · 훅 개입 0 · 도구 2번 모두 자동 허용')
})

test('/clear empties the trace: the module memory goes with the state the host clears', async ($, on) => {
  mock.clock(on, { now: 30_000_000 })
  engine(on, [{ chunks: [toolChunk(0, 'r', 'Read')], uses: [], answer: '' }])
  on('classic.SessionStart', () => ({}))
  await $.turn.start({ text: '읽어줘', turnId: 'c1' })
  await runStep($, 'c1', 0)
  await $.tool.call({ tool: 'Read', file_path: `${CWD}/a.ts`, tool_use_id: 'r' })
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /읽음\s+a\.ts/ }), await textOf(ui)).toBeDefined()
  await ui.unmount()

  await $.classic.SessionStart({ source: 'clear' })
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /읽음\s+a\.ts|“읽어줘”/ }), await textOf(ui)).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /아직 기록이 없어요/ })).toBeDefined()
  await ui.unmount()
})

test('an auto-judged call reads neutral while judge and run are one span, and splits by its run time once it ends', () => {
  const judged = (extra: Partial<TraceTool>): TraceTool =>
    tool('Bash', { command: `head -5 ${CWD}/wt-v3.md && sleep 12` }, { isAsked: true, check: { decision: 'ask' }, startedAt: 0, ...extra })
  const at12 = (steps: TraceStep[]): { flow: string[]; notes: string[]; time: string } => {
    const flow = flowOf(steps, 12_000)
    return { flow: show(flow), notes: flow.map(l => l.note ?? ''), time: timeLine(timeOf(steps, 12_000)) }
  }

  // Still running: the API has not said whether the decider or the command holds it.
  const running = at12([step(0, [judged({ state: 'ask', endedAt: undefined })])])
  expect(running.flow).toEqual(['● 읽음 | wt-v3.md'])
  expect(running.notes).toEqual(['판정·실행 중 12초'])
  expect(running.time).toBe('판정·실행 중 12초 ━━━━━━━━━━')

  // Ended with its run time: the rest was the decider's, flagged only past five seconds.
  const quick = at12([step(0, [judged({ state: 'ok', endedAt: 12_000, execMs: 11_800 })])])
  expect(quick.flow, 'a fraction of a second judging is no signal').toEqual(['✓ 읽음 | wt-v3.md'])
  expect(quick.notes).toEqual([''])
  expect(quick.time).toBe('도구 11초 ━━━━━━━━━━')
  const slow = at12([step(0, [judged({ state: 'ok', endedAt: 12_000, execMs: 6_000 })])])
  expect(slow.flow).toEqual(['✓ 읽음 | wt-v3.md', '! 자동 판정 6초 | wt-v3.md → 권한 규칙 후보'])
  expect(slow.time).toBe('도구 6초 ━━━━━───── · 자동 판정 6초')

  // Ended with no run time: the span stays neutral, unflagged.
  const unknown = at12([step(0, [judged({ state: 'ok', endedAt: 12_000 })])])
  expect(unknown.flow).toEqual(['✓ 읽음 | wt-v3.md'])
  expect(unknown.notes).toEqual(['판정·실행 12초'])
  expect(unknown.time).toBe('판정·실행 12초 ━━━━━━━━━━')
})

test('in auto mode a long command under judgement shows no 자동 판정 while it runs, and its run time once it ends', async ($, on) => {
  const clock = mock.clock(on, { now: 60_000_000 })
  let release: () => void = () => {}
  const released = new Promise<void>(resolve => {
    release = resolve
  })
  const cmd = `head -5 ${CWD}/wt-v3.md && grep -n x ${CWD}/wt-v3.md && sleep 12`
  engine(on, [{ chunks: [toolChunk(0, 'tu-s', 'Bash')], uses: [], answer: '' }], {
    hold: name => (name === 'Bash' ? released : undefined),
    check: () => ({ decision: 'ask' }),
  })
  await $.turn.start({ text: '읽어 봐', turnId: 'a1' })
  await runStep($, 'a1', 0)
  const call = $.tool.call({ tool: 'Bash', command: cmd, tool_use_id: 'tu-s' })
  await clock.settle()
  await $.tool.check({ tool: 'Bash', input: { command: cmd }, tool_use_id: 'tu-s' })
  await clock.advance(12_000)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  let all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /자동 판정/ }), all).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /권한 규칙 후보/ }), 'nothing flagged').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /승인 판정 또는 읽는 중/ }), 'the header stays neutral').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /● 읽음·검색\s+wt-v3\.md\s+· 판정·실행 중 1\d초/ }), 'the line says the time, neutrally').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /판정·실행 중 1\d초 ━/ }), 'and so does where the time went').toBeDefined()
  await ui.unmount()

  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu-s', duration_ms: 11_900 })
  release()
  await call
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  all = await textOf(ui)
  expect(await ui.find({ type: 'Text', text: /자동 판정/ }), all).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /판정·실행/ }), 'split once the run time came').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /도구 11초/ }), 'the run, as the tool timed it').toBeDefined()
  await ui.unmount()
})

// ---- the model never waits on the trace ----

/** The engine beneath with its own clock and state ops, counting each one the plugin raises while a dispatch is in flight. */
function beneath(on: On, n: number, opts: { isHung?: boolean } = {}) {
  const counts = new Map<string, number>()
  const flag = { inFlight: false }
  const count = (name: string): void => {
    if (flag.inFlight) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const never = new Promise<never>(() => {})
  const chunks: TurnStepChunk[] = Array.from({ length: n }, (_, i) =>
    i === n - 2 ? toolChunk(1, 'tu-x', 'Bash') : i === n - 1 ? { kind: 'input', index: 1, json: '{"command":"npm test"}' } : { kind: 'thinking', index: 0, text: '조각 ' },
  )
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    for (const c of chunks) yield c
    const r: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [{ name: 'Bash', input: { command: 'npm test' } }], stopReason: 'tool_use', usage: USAGE }
    return r
  })
  on('tool.call', () => ({ result: { ok: true } }))
  on('tool.check', () => ({ decision: 'allow' as const, rule: 'Bash(npm test:*)' }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-x' }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  // The host's time and the plugin's state, beneath: counted, and with `isHung` never answered.
  on('clock.now', () => (count('clock.now'), opts.isHung === true ? never : { value: 40_000_000 }))
  // @ts-expect-error a timer held for good: nothing here moves time
  on('clock.after', () => (count('clock.after'), never))
  for (const name of ['state.get', 'state.set', 'agent.list', 'session.cwd'] as const) {
    // @ts-expect-error a counting pass-through on each op the plugin may raise
    on(name, ($, e, next) => (count(name), opts.isHung === true ? never : next(e)))
  }

  return { counts, flag, chunks }
}

async function within<T>(ms: number, work: Promise<T>): Promise<T | 'timeout'> {
  return Promise.race([work, new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), ms))])
}

test('no hook waits on the trace: the model path raises no clock or state op while it runs', async ($, on) => {
  const { counts, flag, chunks } = beneath(on, 500)
  const waited = (): Record<string, number> => Object.fromEntries([...counts].filter(([k]) => k !== 'clock.after'))

  flag.inFlight = true
  await $.turn.start({ text: '무간섭', turnId: 'n1' })
  const stream = $.turn.step({ turnId: 'n1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  const got: TurnStepChunk[] = []
  for (;;) {
    const p = await stream.next()
    if (p.done === true) break
    got.push(p.value)
  }
  expect(got, 'every chunk handed on as it came, in order').toEqual(chunks)
  await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu-x' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm test' } })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-x' })
  await $.classic.PostToolUse({ tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'tu-x', duration_ms: 5 })
  await $.agent.spawn({
    tool_use_id: 'tu-a',
    prompt: 'p',
    description: 'd',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'n1', reason: 'answer' })
  flag.inFlight = false

  expect(waited(), 'clock.now, state.get/set, agent.list, session.cwd: none on the model path').toEqual({})
  // The only op on the path is the timer's own ask, made and never awaited: at most one per beat.
  expect(counts.get('clock.after') ?? 0).toBeLessThanOrEqual(2)
})

test('no hook waits on the trace: with the host never answering the clock or the state, the model path still runs through', async ($, on) => {
  beneath(on, 500, { isHung: true })
  const t0 = performance.now()
  const run = async (): Promise<string> => {
    await $.turn.start({ text: '멈춘 호스트', turnId: 'h1' })
    const stream = $.turn.step({ turnId: 'h1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
    let k = 0
    for (;;) {
      const p = await stream.next()
      if (p.done === true) break
      k += 1
    }
    await $.tool.check({ tool: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu-x' })
    await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'tu-x' })
    await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 'h1', reason: 'answer' })

    return `chunks ${k}`
  }
  // A hook that awaited the clock or the state would hold each dispatch for its whole budget (ten seconds).
  expect(await within(3000, run())).toBe('chunks 500')
  expect(performance.now() - t0, 'well under one hook budget').toBeLessThan(3000)
})

test('the trace reaches the pane and the saved copy off the model path, the saved copy cut to what the pane names calls by', async ($, on) => {
  const clock = mock.clock(on, { now: 50_000_000 })
  let written: unknown
  on('state.set', ($, e, next) => {
    if ((e as { key?: string }).key === 'snapshot') written = (e as { value?: unknown }).value
    return next(e)
  })
  engine(on, [{ chunks: [toolChunk(0, 'w', 'Write')], uses: [], answer: '' }], {
    answer: () => ({ type: 'create', filePath: `${CWD}/big.ts`, content: 'x'.repeat(50_000), structuredPatch: [], originalFile: null }),
  })
  await $.turn.start({ text: '큰 파일 써줘', turnId: 's1' })
  await runStep($, 's1', 0)
  await $.tool.call({ tool: 'Write', file_path: `${CWD}/big.ts`, content: 'x'.repeat(50_000), tool_use_id: 'w' })
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: false, turnId: 's1', reason: 'answer' })
  await clock.advance(5000)
  const snap = (written as { value?: { steps: TraceStep[] } } | undefined)?.value
  const saved = snap?.steps.flatMap(s => s.tools).find(t => t.id === 'w')
  expect(saved?.input, 'the call as the pane names it').toMatchObject({ file_path: `${CWD}/big.ts` })
  expect(JSON.stringify(saved?.input ?? {}).includes('xxxx'), "the written content stays out").toBe(false)
  expect(saved?.resultType).toBe('create')
})
