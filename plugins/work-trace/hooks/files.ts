// The files the session changed: pure functions over the tool results, so the
// hook, the pane and the tests share one reading of them. Every diff here comes
// from what a tool of this session answered, never from the disk or git.
import type { TraceFile, TraceFileEdit } from '../types'

export const MAX_FILES = 30
/** Edits kept per file; the count goes on past it. */
export const MAX_FILE_EDITS = 12
/** Characters of diff kept for one edit, for one file's edits together, and for its net diff. */
export const EDIT_CHARS = 6000
export const FILE_CHARS = 18_000
export const NET_CHARS = 12_000
/** Past this a file's text is not followed for the net diff. */
export const TEXT_KEEP = 300_000
/** Past this many cells of comparison the net diff is not worked out. */
const DIFF_CELLS = 2_000_000
const CONTEXT = 3

/** A unified-diff hunk as the tools report it (`structuredPatch`): old and new starts 1-based. */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** One file change read from a tool's result, before it is put on the list. */
export type RawEdit = {
  path: string
  kind: TraceFileEdit['kind']
  hunks: Hunk[]
  isStaged: boolean
  isUserModified: boolean
  note?: string
  /** The file before the edit, as the tool read it: null when it did not exist, undefined when unknown. */
  before?: string | null
  /** The file after it, when the result says or the hunks rebuild it. */
  after?: string
  /** Why this edit cannot carry the net diff on, when it cannot. */
  unchained?: string
}

type Obj = Record<string, unknown>

const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (o: Obj, k: string): string | undefined => (typeof o[k] === 'string' ? (o[k] as string) : undefined)

function hunksOf(v: unknown): Hunk[] {
  if (!Array.isArray(v)) return []
  const out: Hunk[] = []
  for (const h of v) {
    if (!isObj(h) || !Array.isArray(h.lines)) continue
    const { oldStart, oldLines, newStart, newLines } = h
    if (typeof oldStart !== 'number' || typeof oldLines !== 'number' || typeof newStart !== 'number' || typeof newLines !== 'number') continue
    out.push({ oldStart, oldLines, newStart, newLines, lines: h.lines.filter((l): l is string => typeof l === 'string') })
  }

  return out
}

export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  return lines
}

/** Lines added and removed by the hunks. */
export function countHunks(hunks: readonly Hunk[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const h of hunks) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added += 1
      else if (l.startsWith('-')) removed += 1
    }
  }

  return { added, removed }
}

function hunkHeader(h: Hunk): string {
  // As a unified diff spells it: a side with no lines names the line before.
  const oldStart = h.oldLines === 0 ? Math.max(0, h.oldStart - 1) : h.oldStart
  const newStart = h.newLines === 0 ? Math.max(0, h.newStart - 1) : h.newStart

  return `@@ -${oldStart},${h.oldLines} +${newStart},${h.newLines} @@`
}

function clean(line: string): string {
  // A Code source admits tab and newline alone: other control characters go.
  // eslint-disable-next-line no-control-regex
  return line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
}

/** The hunks as unified-diff text, kept under `max` characters by whole hunks, and a cut hunk renumbered so it still parses. */
export function capHunks(hunks: readonly Hunk[], max: number): { patch: string; isCut: boolean } {
  const parts: string[] = []
  let used = 0
  for (const h of hunks) {
    const lines = h.lines.map(clean)
    const text = [hunkHeader(h), ...lines].join('\n')
    if (used + text.length + 1 <= max) {
      parts.push(text)
      used += text.length + 1
      continue
    }
    if (parts.length === 0) {
      // The first hunk alone is too big: keep its head, its counts redone.
      const kept: string[] = []
      let size = 40
      for (const l of lines) {
        if (size + l.length + 1 > max) break
        kept.push(l)
        size += l.length + 1
      }
      const oldLines = kept.filter(l => !l.startsWith('+')).length
      const newLines = kept.filter(l => !l.startsWith('-')).length
      if (kept.length > 0) parts.push([hunkHeader({ ...h, oldLines, newLines, lines: kept }), ...kept].join('\n'))
    }

    return { patch: parts.join('\n'), isCut: true }
  }

  return { patch: parts.join('\n'), isCut: false }
}

/** The text the hunks make of `text`, or undefined when they do not fit it. */
export function applyHunks(text: string, hunks: readonly Hunk[]): string | undefined {
  const lines = text.split('\n')
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    const start = Math.max(0, h.oldStart - 1)
    if (start < pos || start > lines.length) return undefined
    out.push(...lines.slice(pos, start))
    pos = start
    for (const l of h.lines) {
      const mark = l[0]
      const body = l.slice(1)
      if (mark === ' ' || mark === '-') {
        if (lines[pos] !== body) return undefined
        pos += 1
        if (mark === ' ') out.push(body)
      } else if (mark === '+') {
        out.push(body)
      } else {
        // `\ No newline at end of file`: the line ends are not followed that far.
        return undefined
      }
    }
  }
  out.push(...lines.slice(pos))

  return out.join('\n')
}

/** The line diff of two texts as hunks with context, or undefined when they are too big to compare. */
export function diffLines(a: string, b: string): Hunk[] | undefined {
  const x = splitLines(a)
  const y = splitLines(b)
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head += 1
  let tail = 0
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail += 1
  const xm = x.slice(head, x.length - tail)
  const ym = y.slice(head, y.length - tail)
  const n = xm.length
  const m = ym.length
  if ((n + 1) * (m + 1) > DIFF_CELLS) return undefined

  // The longest common subsequence, from the end, so the walk below goes forward.
  const w = m + 1
  const lcs = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * w + j] = xm[i] === ym[j] ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1 : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0)
    }
  }
  const ops: string[] = x.slice(0, head).map(l => ` ${l}`)
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && xm[i] === ym[j]) {
      ops.push(` ${xm[i] ?? ''}`)
      i += 1
      j += 1
    } else if (i < n && (j >= m || (lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0))) {
      // Removals before additions, as a unified diff reads.
      ops.push(`-${xm[i] ?? ''}`)
      i += 1
    } else {
      ops.push(`+${ym[j] ?? ''}`)
      j += 1
    }
  }
  ops.push(...x.slice(x.length - tail).map(l => ` ${l}`))

  return hunksFromOps(ops)
}

/** Groups a whole-file line script into hunks, `CONTEXT` lines either side, near changes merged. */
function hunksFromOps(ops: readonly string[]): Hunk[] {
  const changed: number[] = []
  ops.forEach((op, k) => {
    if (!op.startsWith(' ')) changed.push(k)
  })
  const hunks: Hunk[] = []
  let k = 0
  while (k < changed.length) {
    const first = changed[k] ?? 0
    let last = first
    while (k + 1 < changed.length && (changed[k + 1] ?? 0) - last <= CONTEXT * 2 + 1) {
      k += 1
      last = changed[k] ?? last
    }
    k += 1
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(ops.length, last + CONTEXT + 1)
    let oldBefore = 0
    let newBefore = 0
    for (let p = 0; p < from; p += 1) {
      const op = ops[p] ?? ' '
      if (!op.startsWith('+')) oldBefore += 1
      if (!op.startsWith('-')) newBefore += 1
    }
    const lines = ops.slice(from, to)
    hunks.push({
      oldStart: oldBefore + 1,
      oldLines: lines.filter(l => !l.startsWith('+')).length,
      newStart: newBefore + 1,
      newLines: lines.filter(l => !l.startsWith('-')).length,
      lines: lines.slice(),
    })
  }

  return hunks
}

/** The file changes a tool's answer reports: none for a tool that changes no file, or answered without. */
export function editsOf(tool: string, result: unknown): RawEdit[] {
  if (!isObj(result)) return []
  if (tool === 'NotebookEdit') {
    const path = str(result, 'notebook_path')
    if (path === undefined || str(result, 'error') !== undefined) return []
    const mode = str(result, 'edit_mode') ?? 'replace'
    const before = mode === 'insert' ? '' : (str(result, 'old_source') ?? '')
    const after = mode === 'delete' ? '' : (str(result, 'new_source') ?? '')
    const cell = str(result, 'cell_id')
    const edit: RawEdit = {
      path,
      kind: 'update',
      hunks: diffLines(before, after) ?? [],
      isStaged: false,
      isUserModified: false,
      unchained: '노트북은 셀 단위 diff만 보여요',
    }
    const what = mode === 'insert' ? '셀 추가' : mode === 'delete' ? '셀 삭제' : '셀 수정'
    edit.note = cell === undefined ? what : `${what} · ${cell}`

    return [edit]
  }
  if (tool === 'Bash') {
    // Internal and optional: read when the engine gives it, never needed.
    const diff = result.bashEditDiff
    if (!isObj(diff) || diff.unavailable === true || diff.skipped === true || !Array.isArray(diff.files)) return []
    const out: RawEdit[] = []
    for (const f of diff.files) {
      if (!isObj(f)) continue
      const path = str(f, 'filePath')
      if (path === undefined) continue
      out.push({
        path,
        kind: f.deleted === true ? 'delete' : f.created === true ? 'create' : 'update',
        hunks: hunksOf(f.hunks),
        isStaged: false,
        isUserModified: false,
        unchained: 'Bash 명령으로도 바뀐 파일이에요',
      })
    }

    return out
  }

  // Edit, Write, and any tool answering in their shape (a MultiEdit, where a build has one).
  const path = str(result, 'filePath')
  if (path === undefined || !Array.isArray(result.structuredPatch)) return []
  const original = result.originalFile
  const before = typeof original === 'string' ? original : original === null ? null : undefined
  const isWrite = tool === 'Write' || result.type === 'create' || result.type === 'update'
  const content = str(result, 'content')
  const edit: RawEdit = {
    path,
    kind: (isWrite ? result.type === 'create' : before === null) ? 'create' : 'update',
    hunks: hunksOf(result.structuredPatch),
    isStaged: result.staged === true,
    isUserModified: result.userModified === true,
  }
  if (isWrite && content !== undefined) {
    edit.after = content
    if (edit.hunks.length === 0 && edit.kind === 'create') edit.hunks = diffLines('', content) ?? []
    if (edit.hunks.length === 0 && edit.kind === 'update') {
      edit.note = before === null ? 'diff 없음 (이전 내용이 커서 비교하지 못함)' : '내용 변화 없음'
    }
  } else if (!isWrite) {
    const after = applyHunks(before ?? '', edit.hunks)
    if (after !== undefined) edit.after = after
  }
  // A Write that replaced content too large to keep names no `before`.
  edit.before = isWrite && edit.kind === 'update' && before === null ? undefined : before

  return [edit]
}

/** The texts the net diff runs between, or why there is none. Held in the module, never in the state. */
export type Chain = { base: string; current: string } | { reason: string }

const sameText = (a: string, b: string): boolean => a === b || a.replace(/\n$/, '') === b.replace(/\n$/, '')

/**
 * Carries a file's chain over one edit: the text before the session first
 * changed it, and the text now. A step the tools do not vouch for breaks it.
 */
export function advanceChain(prev: Chain | undefined, edit: RawEdit, isKnown: boolean): Chain | undefined {
  if (edit.isStaged) return prev
  if (prev !== undefined && 'reason' in prev) return prev
  if (edit.unchained !== undefined) return { reason: edit.unchained }
  if (edit.after === undefined || edit.before === undefined) return { reason: '이전 내용을 몰라 합치지 못해요' }
  if (edit.after.length > TEXT_KEEP || (edit.before ?? '').length > TEXT_KEEP) return { reason: '파일이 커서 합치지 못해요' }
  const before = edit.before ?? ''
  if (prev === undefined) {
    // Known on the list with no chain: the module reloaded since the earlier edits.
    return isKnown ? { reason: '추적이 다시 시작돼 앞 편집을 잇지 못해요' } : { base: before, current: edit.after }
  }
  if (!sameText(prev.current, before)) return { reason: '편집 사이에 세션 밖에서 파일이 바뀌었어요' }

  return { base: prev.base, current: edit.after }
}

/** The net diff a chain makes, or why there is none. */
export function netOf(chain: Chain | undefined): TraceFile['net'] {
  if (chain === undefined) return { reason: '아직 반영된 편집이 없어요' }
  if ('reason' in chain) return { reason: chain.reason }
  const hunks = diffLines(chain.base, chain.current)
  if (hunks === undefined) return { reason: '바뀐 곳이 많아 합치지 못해요' }
  const { added, removed } = countHunks(hunks)
  const { patch, isCut } = capHunks(hunks, NET_CHARS)
  const net: TraceFile['net'] = { patch, added, removed }
  if (isCut) net.isCut = true

  return net
}

export type EditMeta = { toolUseId: string; tool: string; at: number; loop: string; by: string; cwd: string }

export function shownPath(path: string, cwd: string): string {
  return cwd !== '' && path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

/** Drops the oldest edits' diffs past the file's share of characters; the newest always stays. */
function trimEdits(edits: readonly TraceFileEdit[]): TraceFileEdit[] {
  let kept = edits.slice(-MAX_FILE_EDITS)
  let size = kept.reduce((sum, e) => sum + e.patch.length, 0)
  while (kept.length > 1 && size > FILE_CHARS) {
    size -= kept[0]?.patch.length ?? 0
    kept = kept.slice(1)
  }

  return kept
}

/** Puts one edit on the list: the file moves to the end (the newest), and the oldest file drops past the limit. */
export function putEdit(list: readonly TraceFile[], raw: RawEdit, meta: EditMeta, net: TraceFile['net']): TraceFile[] {
  const { added, removed } = countHunks(raw.hunks)
  const { patch, isCut } = capHunks(raw.hunks, EDIT_CHARS)
  const edit: TraceFileEdit = {
    toolUseId: meta.toolUseId,
    tool: meta.tool,
    at: meta.at,
    loop: meta.loop,
    by: meta.by,
    kind: raw.kind,
    added,
    removed,
    patch,
  }
  if (isCut) edit.isCut = true
  if (raw.isStaged) edit.isStaged = true
  if (raw.isUserModified) edit.isUserModified = true
  if (raw.note !== undefined) edit.note = raw.note

  const found = list.find(f => f.path === raw.path)
  const file: TraceFile = found === undefined
    ? {
        path: raw.path,
        shown: shownPath(raw.path, meta.cwd),
        firstAt: meta.at,
        lastAt: meta.at,
        editCount: 0,
        stagedCount: 0,
        added: 0,
        removed: 0,
        isCreated: false,
        isDeleted: false,
        by: [],
        edits: [],
        net,
      }
    : { ...found, net }
  file.lastAt = meta.at
  file.edits = trimEdits([...file.edits, edit])
  if (!file.by.includes(meta.by)) file.by = [...file.by, meta.by]
  if (raw.isStaged) {
    file.stagedCount += 1
  } else {
    if (file.editCount === 0 && raw.kind === 'create') file.isCreated = true
    file.isDeleted = raw.kind === 'delete'
    file.editCount += 1
    file.added += added
    file.removed += removed
  }

  return [...list.filter(f => f.path !== raw.path), file].slice(-MAX_FILES)
}

// ---- reads: what the pane draws ----

/** The file's change as the row counts it: the net when known, else the edits summed. */
export function fileCounts(f: TraceFile): { added: number; removed: number; isNet: boolean } {
  return 'patch' in f.net ? { added: f.net.added, removed: f.net.removed, isNet: true } : { added: f.added, removed: f.removed, isNet: false }
}

/** The files as one subagent left them: its own edits alone, counted again from what is kept. */
export function filesOfLoop(list: readonly TraceFile[], loop: string): TraceFile[] {
  const out: TraceFile[] = []
  for (const f of list) {
    const edits = f.edits.filter(e => e.loop === loop)
    if (edits.length === 0) continue
    const applied = edits.filter(e => e.isStaged !== true)
    const last = edits[edits.length - 1]
    out.push({
      ...f,
      lastAt: last?.at ?? f.lastAt,
      editCount: applied.length,
      stagedCount: edits.length - applied.length,
      added: applied.reduce((s, e) => s + e.added, 0),
      removed: applied.reduce((s, e) => s + e.removed, 0),
      isCreated: applied[0]?.kind === 'create',
      isDeleted: applied[applied.length - 1]?.kind === 'delete',
      by: [last?.by ?? ''],
      edits,
      net: { reason: '에이전트 화면에서는 편집별로만 보여요' },
    })
  }

  return out
}
