// The pane's "변경 파일" part: one row per file the session changed, newest
// first, and under a pressed row its diff, edit by edit or as one net diff.
import type { BoxProps, ButtonProps, CodeProps, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { TraceFile, TraceFileEdit } from '../types'
import { fileCounts } from './files'
import { fmtDur, headCells, tailCells } from './trace'

export type FileEls = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
  Code: ElementConstructor<CodeProps>
}

export type FilesData = {
  files: readonly TraceFile[]
  openFiles: readonly string[]
  netFiles: readonly string[]
  now: number
  isDocked: boolean
  isExpanded: boolean
  columns: number
}

export type FilesActions = {
  toggleOpen: (path: string) => void
  toggleNet: (path: string) => void
}

/** Characters of diff one drawing holds, under the engine's 100,000 with room for the rest of the pane. */
export const DRAW_CHARS = 60_000

const KIND_MARK: Record<TraceFileEdit['kind'], string> = { create: '새 파일', update: '', delete: '삭제' }

function fileMark(f: TraceFile): { mark: string; color: string; label?: string } {
  if (f.isDeleted) return { mark: 'D', color: 'error', label: '삭제됨' }
  if (f.editCount === 0) return { mark: '…', color: 'warning', label: '검토 대기' }
  if (f.isCreated) return { mark: 'A', color: 'success', label: '새 파일' }

  return { mark: 'M', color: 'suggestion' }
}

const plusMinus = (added: number, removed: number): string =>
  [added > 0 || removed === 0 ? `+${added}` : '', removed > 0 ? `−${removed}` : ''].filter(p => p !== '').join(' ')

/** The one line of the part: how many files, how many lines. */
export function filesSummary(files: readonly TraceFile[]): string {
  let added = 0
  let removed = 0
  for (const f of files) {
    const c = fileCounts(f)
    added += c.added
    removed += c.removed
  }
  const staged = files.reduce((s, f) => s + f.stagedCount, 0)

  return `변경 파일 ${files.length}개 · ${plusMinus(added, removed)}${staged > 0 ? ` · 검토 대기 ${staged}` : ''}`
}

export function renderFiles(els: FileEls, d: FilesData, act: FilesActions): RenderElement | null {
  const { Box, Text, Button, Code } = els
  if (d.files.length === 0) return null
  const newest = d.files.slice().reverse()

  // Above the prompt in a narrow pane: the count alone.
  if (!d.isDocked) {
    return (
      <Text color="suggestion" wrap="truncate-end">
        ✎ {filesSummary(d.files)}
      </Text>
    )
  }

  const room = d.isExpanded ? 20 : 5
  // An open file keeps its row even past the room.
  const shown = newest.filter((f, i) => i < room || d.openFiles.includes(f.path))
  let budget = DRAW_CHARS
  const pathCells = Math.max(10, d.columns - 22)

  const editView = (f: TraceFile, e: TraceFileEdit, n: number): RenderElement => {
    const head = [
      `#${n} ${e.tool}`,
      e.by,
      `${fmtDur(d.now - e.at)} 전`,
      plusMinus(e.added, e.removed),
      KIND_MARK[e.kind],
      e.isUserModified === true ? '사용자가 고침' : '',
      e.note ?? '',
    ]
      .filter(p => p !== '')
      .join(' · ')
    const fits = e.patch !== '' && e.patch.length <= budget
    if (fits) budget -= e.patch.length

    return (
      <Box flexDirection="column">
        <Text color={e.isStaged === true ? 'warning' : 'subtle'} wrap="truncate-end">
          {'    '}
          {head}
          {e.isStaged === true ? ' · 검토 대기 (아직 반영 안 됨)' : ''}
        </Text>
        {fits ? <Code source={e.patch} format="diff" path={f.path} wrap="truncate-end" /> : null}
        {e.patch === '' ? null : !fits ? <Text dimColor>{'    …화면 한도로 이 diff는 생략'}</Text> : null}
        {e.isCut === true ? <Text dimColor>{'    …diff가 길어 앞부분만 기록'}</Text> : null}
      </Box>
    )
  }

  const openView = (f: TraceFile): RenderElement => {
    const hasNet = 'patch' in f.net && f.editCount >= 2
    const isNet = hasNet && d.netFiles.includes(f.path)
    const recorded = f.editCount + f.stagedCount
    const dropped = recorded - f.edits.length
    const rows: RenderElement[] = []
    if (isNet && 'patch' in f.net) {
      const fits = f.net.patch.length <= budget
      if (fits) budget -= f.net.patch.length
      rows.push(
        <Text color="subtle">
          {'    '}합친 diff · 편집 {f.editCount}개 · {plusMinus(f.net.added, f.net.removed)}
          {f.net.patch === '' ? ' · 처음과 같아졌어요' : ''}
        </Text>,
      )
      if (f.net.patch !== '') {
        rows.push(fits ? <Code source={f.net.patch} format="diff" path={f.path} wrap="truncate-end" /> : <Text dimColor>{'    …화면 한도로 생략'}</Text>)
      }
      if (f.net.isCut === true) rows.push(<Text dimColor>{'    …diff가 길어 앞부분만 기록'}</Text>)
    } else {
      if (dropped > 0) rows.push(<Text dimColor>{`    앞의 편집 ${dropped}개는 기록 한도로 생략`}</Text>)
      f.edits.forEach((e, i) => rows.push(editView(f, e, dropped + i + 1)))
      if (!hasNet && f.editCount >= 2 && 'reason' in f.net && f.net.reason !== '') {
        rows.push(<Text dimColor wrap="truncate-end">{`    합친 diff 없음: ${f.net.reason}`}</Text>)
      }
    }

    return (
      <Box flexDirection="column">
        {hasNet ? (
          <Box flexDirection="row">
            <Box flexGrow={1} />
            <Button key={`wtf:net:${f.path}`} label={isNet ? '편집별' : '합친 diff'} dimColor onPress={() => act.toggleNet(f.path)} />
          </Box>
        ) : null}
        {rows}
      </Box>
    )
  }

  const fileView = (f: TraceFile): RenderElement => {
    const look = fileMark(f)
    const c = fileCounts(f)
    const isOpen = d.openFiles.includes(f.path)
    const meta = [
      f.editCount > 0 ? `편집 ${f.editCount}` : '',
      f.stagedCount > 0 ? `검토 대기 ${f.stagedCount}` : '',
      headCells(f.by.join(', '), 30),
      `${fmtDur(d.now - f.lastAt)} 전`,
      look.label ?? '',
    ]
      .filter(p => p !== '')
      .join(' · ')

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              <Text color={look.color}>{look.mark} </Text>
              {tailCells(f.shown, pathCells)}
              {f.editCount > 0 ? (
                <Text>
                  {' '}
                  <Text color="success">+{c.added}</Text> <Text color="error">−{c.removed}</Text>
                </Text>
              ) : null}
            </Text>
          </Box>
          <Button key={`wtf:open:${f.path}`} label={isOpen ? '접기' : 'diff'} dimColor onPress={() => act.toggleOpen(f.path)} />
        </Box>
        <Text dimColor wrap="truncate-end">
          {'    '}
          {meta}
        </Text>
        {isOpen ? openView(f) : null}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="suggestion" wrap="truncate-end">
        {filesSummary(d.files)}
      </Text>
      {shown.map(fileView)}
      {newest.length > shown.length ? <Text dimColor>{`  …그 밖에 ${newest.length - shown.length}개${d.isExpanded ? '' : ' (자세히에서 더 보기)'}`}</Text> : null}
    </Box>
  )
}
