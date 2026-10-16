import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepResult } from 'claude-code'

import { MAX_FILES, MAX_FILE_EDITS, advanceChain, applyHunks, capHunks, diffLines, editsOf, netOf, putEdit } from '../hooks/files'
import type { TraceFile } from '../types'
import type { Hunk } from '../hooks/files'

const PANE = {
  plugin: 'work-trace',
  component: 'Pane',
  requestId: 'work-trace',
  props: {
    title: '작업 추적',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 80 },
    view: {},
  },
} as const

const USAGE = {
  input_tokens: 10,
  output_tokens: 10,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  model: 'claude-opus-5-5',
}

/** What a tool call answers, by its tool_use_id: a result, an error, or a refusal. */
type Answer = { result: unknown } | { fail: string } | { deny: string }

/** The engine beneath the plugin, scripted: each model request picks nothing, each call answers as told. */
function engine(on: On, answers: Record<string, Answer>) {
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const result: TurnStepResult = { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: USAGE }
    return result
  })
  on('tool.call', ($, e) => {
    const a = answers[e.tool_use_id] ?? { result: { ok: true } }
    if ('deny' in a) return { deny: a.deny }
    if ('fail' in a) return { isError: true as const, result: a.fail, text: a.fail }
    return { result: a.result }
  })
  on('tool.check', () => ({ decision: 'allow' as const }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
}

async function step($: Engine, turnId: string, index: number, agentId?: string): Promise<void> {
  const stream = $.turn.step(
    agentId === undefined
      ? { turnId, index, model: 'claude-opus-5-5', messageCount: 1 }
      : { turnId, index, model: 'claude-opus-5-5', messageCount: 1, agentId },
  )
  for (;;) {
    const piece = await stream.next()
    if (piece.done === true) return
  }
}

const A = '/repo/src/a.ts'
const BEFORE = 'one\ntwo\nthree\nfour\n'
const AFTER_1 = 'one\nTWO\nthree\nfour\n'
const AFTER_2 = 'one\nTWO\nthree\nFOUR\n'

const editResult = (path: string, before: string | null, hunks: Hunk[], extra: Record<string, unknown> = {}) => ({
  filePath: path,
  oldString: '',
  newString: '',
  originalFile: before,
  structuredPatch: hunks,
  userModified: false,
  replaceAll: false,
  ...extra,
})

const edit1: Hunk[] = [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' one', '-two', '+TWO', ' three', ' four'] }]
const edit2: Hunk[] = [{ oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' one', ' TWO', ' three', '-four', '+FOUR'] }]

test('the files the session changed list with their counts, who changed them, and each edit as a diff', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000_000 })
  engine(on, {
    'e-1': { result: editResult(A, BEFORE, edit1) },
    'e-2': { result: editResult(A, AFTER_1, edit2) },
    'w-1': {
      result: { type: 'create', filePath: '/repo/src/new.ts', content: 'export const x = 1\n', structuredPatch: [], originalFile: null },
    },
    'e-fail': { fail: 'String to replace not found in file.' },
    'e-deny': { deny: 'Permission denied by rule' },
    'e-staged': { result: editResult('/repo/src/held.ts', 'a\n', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }], { staged: true }) },
    'ag-edit': {
      result: editResult('/repo/docs/guide.md', '# 제목\n', [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' # 제목', '+본문'] }]),
    },
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'ag-1' }))

  await $.turn.start({ text: '파일 고쳐줘', turnId: 'f1' })
  await step($, 'f1', 0)
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'two', new_string: 'TWO', tool_use_id: 'e-1' })
  await clock.advance(1000)
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'export const x = 1\n', tool_use_id: 'w-1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/missing.ts', old_string: 'x', new_string: 'y', tool_use_id: 'e-fail' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/secret.ts', old_string: 'x', new_string: 'y', tool_use_id: 'e-deny' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/held.ts', old_string: 'a', new_string: 'b', tool_use_id: 'e-staged' })
  await $.agent.spawn({
    tool_use_id: 'tu-agent',
    prompt: '문서 손봐줘',
    description: '문서 정리',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    background: true,
    fork: false,
  })
  await step($, 'ag-run', 0, 'ag-1')
  // @ts-expect-error the engine raises a subagent's call with its loop's agentId, which a plugin's own call never names
  await $.tool.call({ tool: 'Edit', file_path: '/repo/docs/guide.md', old_string: 'a', new_string: 'b', tool_use_id: 'ag-edit', agentId: 'ag-1' })
  await clock.advance(2000)
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'four', new_string: 'FOUR', tool_use_id: 'e-2' })
  await clock.advance(5000)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /변경 파일 4개 · \+4 −2 · 검토 대기 1/ }), 'the part names the files and lines').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /편집 2 · 메인 · [45]\.\ds 전/ }), "a.ts's edits, who, when").toBeDefined()
  expect(await ui.find({ type: 'Text', text: /편집 1 · 메인 · .* · 새 파일/ }), 'the created file').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /편집 1 · Explore/ }), "the subagent's edit, in the main pane").toBeDefined()
  expect(await ui.find({ type: 'Text', text: /검토 대기 1 · 메인/ }), 'the staged edit').toBeDefined()
  expect(await ui.find({ key: 'wtf:open:/repo/src/missing.ts' }), 'a failed edit stays out').toBeUndefined()
  expect(await ui.find({ key: 'wtf:open:/repo/src/secret.ts' }), 'a refused edit stays out').toBeUndefined()
  expect(await ui.find({ type: 'Code' }), 'no diff before a row is opened').toBeUndefined()

  await ui.press({ key: `wtf:open:${A}` })
  const codes = await ui.findAll({ type: 'Code' })
  expect(codes, 'one diff per edit').toHaveLength(2)
  expect(codes[0]).toMatchObject({ props: { format: 'diff', source: '@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n four' } })
  expect(codes[1]?.text).toContain('+FOUR')
  expect(await ui.find({ type: 'Text', text: /#1 Edit · 메인 · .* · \+1 −1/ }), 'the first edit').toBeDefined()
  expect(await ui.find({ key: `wtf:open:${A}` })).toMatchObject({ props: { label: '접기' } })

  // The two edits chain without the disk: one net diff.
  await ui.press({ key: `wtf:net:${A}` })
  const net = await ui.findAll({ type: 'Code' })
  expect(net).toHaveLength(1)
  expect(net[0]?.text).toBe('@@ -1,4 +1,4 @@\n one\n-two\n+TWO\n three\n-four\n+FOUR')
  expect(await ui.find({ type: 'Text', text: /합친 diff · 편집 2개 · \+2 −2/ })).toBeDefined()

  // The staged edit's diff says it has not landed.
  await ui.press({ key: 'wtf:open:/repo/src/held.ts' })
  expect(await ui.find({ type: 'Text', text: /검토 대기 \(아직 반영 안 됨\)/ })).toBeDefined()
  await ui.unmount()

  // The subagent's own view keeps to its own edits.
  const inView = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, view: { agentId: 'ag-1' } } })
  expect(await inView.find({ type: 'Text', text: /변경 파일 1개 · \+1/ })).toBeDefined()
  expect(await inView.find({ type: 'Text', text: /src\/a\.ts/ })).toBeUndefined()
  await inView.unmount()

  // Narrow, above the prompt: the one line.
  const inline = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, placement: 'inline', bodyColumns: 40 } })
  expect(await inline.find({ type: 'Text', text: /✎ 변경 파일 4개 · \+4 −2 · 검토 대기 1/ })).toBeDefined()
  expect(await inline.find({ key: `wtf:open:${A}` }), 'no rows inline').toBeUndefined()
  await inline.unmount()

  // 지우기 clears the files too.
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await desk.press({ key: 'clear' })
  expect(await desk.find({ type: 'Text', text: /변경 파일/ })).toBeUndefined()
  await desk.unmount()
})

test('a file changed outside the session between edits shows each edit but no net diff', async ($, on) => {
  mock.clock(on, { now: 11_000_000 })
  engine(on, {
    'e-1': { result: editResult(A, BEFORE, edit1) },
    // Someone else changed line 3 before the second edit read the file.
    'e-2': {
      result: editResult(A, 'one\nTWO\nTHREE\nfour\n', [
        { oldStart: 1, oldLines: 4, newStart: 1, newLines: 4, lines: [' one', ' TWO', ' THREE', '-four', '+FOUR'] },
      ]),
    },
    'b-1': {
      result: {
        stdout: '',
        stderr: '',
        interrupted: false,
        bashEditDiff: { files: [{ filePath: '/repo/old.txt', hunks: [{ oldStart: 1, oldLines: 2, newStart: 0, newLines: 0, lines: ['-x', '-y'] }], deleted: true }], moreFiles: 0 },
      },
    },
  })
  await $.turn.start({ text: '정리', turnId: 'f2' })
  await step($, 'f2', 0)
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'two', new_string: 'TWO', tool_use_id: 'e-1' })
  await $.tool.call({ tool: 'Edit', file_path: A, old_string: 'four', new_string: 'FOUR', tool_use_id: 'e-2' })
  await $.tool.call({ tool: 'Bash', command: 'rm /repo/old.txt', tool_use_id: 'b-1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /변경 파일 2개 · \+2 −4/ }), 'summed when the net is unknown').toBeDefined()
  expect(await ui.find({ type: 'Text', text: /old\.txt/ }), "the deleted file's path").toBeDefined()
  expect(await ui.find({ type: 'Text', text: /편집 1 · 메인 · .* · 삭제됨/ }), 'the deleted file').toBeDefined()
  await ui.press({ key: `wtf:open:${A}` })
  expect(await ui.findAll({ type: 'Code' })).toHaveLength(2)
  expect(await ui.find({ key: `wtf:net:${A}` }), 'no net toggle').toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /합친 diff 없음: 편집 사이에 세션 밖에서 파일이 바뀌었어요/ })).toBeDefined()
  await ui.unmount()
})

test('the pure helpers diff, apply, cap and chain', () => {
  const hunks = diffLines(BEFORE, AFTER_2) ?? []
  expect(hunks).toHaveLength(1)
  expect(applyHunks(BEFORE, hunks)).toBe(AFTER_2)
  expect(applyHunks(BEFORE, edit1)).toBe(AFTER_1)
  expect(applyHunks(AFTER_2, edit1), 'hunks that do not fit').toBeUndefined()

  // Far-apart changes make two hunks.
  const long = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n')
  const changed = long.replace('l2', 'L2').replace('l25', 'L25')
  expect(diffLines(long, changed)).toHaveLength(2)
  expect(applyHunks(long, diffLines(long, changed) ?? [])).toBe(changed)

  // A cut hunk is renumbered so it still parses.
  const big: Hunk[] = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 100, lines: Array.from({ length: 100 }, (_, i) => `+line ${i}`) }]
  const cut = capHunks(big, 200)
  expect(cut.isCut).toBe(true)
  expect(cut.patch.length).toBeLessThanOrEqual(200)
  const header = /^@@ -0,0 \+1,(\d+) @@/.exec(cut.patch)
  expect(Number(header?.[1])).toBe(cut.patch.split('\n').length - 1)

  // A create, then an edit: the chain runs from empty.
  const [created] = editsOf('Write', { type: 'create', filePath: '/n.ts', content: 'a\n', structuredPatch: [], originalFile: null })
  expect(created).toMatchObject({ kind: 'create', after: 'a\n', before: null })
  const chain = advanceChain(undefined, created!, false)
  expect(chain).toEqual({ base: '', current: 'a\n' })
  expect(netOf(chain)).toMatchObject({ added: 1, removed: 0 })
  expect(advanceChain(undefined, created!, true), 'a reload since the earlier edits').toHaveProperty('reason')

  // A notebook cell edit shows the cell's diff.
  const [cell] = editsOf('NotebookEdit', {
    new_source: 'print(2)',
    old_source: 'print(1)',
    cell_id: 'c1',
    cell_type: 'code',
    language: 'python',
    edit_mode: 'replace',
    notebook_path: '/n.ipynb',
    original_file: '{}',
    updated_file: '{}',
  })
  expect(cell).toMatchObject({ path: '/n.ipynb', note: '셀 수정 · c1' })
  expect(cell?.hunks[0]?.lines).toEqual(['-print(1)', '+print(2)'])

  expect(editsOf('Read', { file: { filePath: '/x' } }), 'a tool that changes nothing').toEqual([])
})

test('the list keeps to its limits: files, edits per file, and characters', () => {
  const meta = { toolUseId: 't', tool: 'Edit', at: 0, loop: 'main', by: '메인', cwd: '/repo' }
  const one: Hunk[] = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }]
  let list: TraceFile[] = []
  for (let i = 0; i < MAX_FILES + 5; i += 1) {
    list = putEdit(list, { path: `/repo/f${i}.ts`, kind: 'update', hunks: one, isStaged: false, isUserModified: false }, { ...meta, at: i }, { reason: '' })
  }
  expect(list).toHaveLength(MAX_FILES)
  expect(list[0]?.shown, 'the oldest files drop').toBe('f5.ts')

  let file: TraceFile[] = []
  const wide: Hunk[] = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 400, lines: Array.from({ length: 400 }, (_, i) => `+${'x'.repeat(40)} ${i}`) }]
  for (let i = 0; i < MAX_FILE_EDITS + 3; i += 1) {
    file = putEdit(file, { path: '/repo/big.ts', kind: 'update', hunks: wide, isStaged: false, isUserModified: false }, { ...meta, at: i }, { reason: '' })
  }
  const big = file[0]
  expect(big?.editCount).toBe(MAX_FILE_EDITS + 3)
  expect(big?.added, 'the count goes on past the kept edits').toBe(400 * (MAX_FILE_EDITS + 3))
  expect(big?.edits.length).toBeLessThan(MAX_FILE_EDITS)
  expect(big?.edits.every(e => e.isCut === true && e.patch.length <= 6000)).toBe(true)
})
