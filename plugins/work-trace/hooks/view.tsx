// The pane's drawing: what runs now on top, then the turn as a story read top
// to bottom (oldest first, the latest line in view), the files it looked at,
// where its time went and the harness it touched. Everything is worked out
// here, from the trace as the hooks left it.
import type { BoxProps, ButtonProps, Color, ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { TraceAgent, TraceFile, TracePlan, TraceStep, TraceTurn } from '../types'
import { renderPlans } from './plan-view'
import { MAIN, latestTurn, turnLabel } from './trace'
import {
  buildFlow,
  changedIn,
  fmtKo,
  foldFlow,
  harnessLine,
  harnessOf,
  nowOf,
  padCells,
  refsOf,
  textCells,
  timeLine,
  timeOf,
  turnSteps,
  wrapItems,
} from './flow'
import type { FlowLine, Now, Where } from './flow'

export type Els = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Button: ElementConstructor<ButtonProps>
}

export type PaneData = {
  steps: readonly TraceStep[]
  agents: readonly TraceAgent[]
  turns: readonly TraceTurn[]
  plans: readonly TracePlan[]
  files: readonly TraceFile[]
  compactSince: number | null
  now: number
  isExpanded: boolean
  /** The subagent whose transcript is on screen beside the pane, if any. */
  viewAgentId: string | undefined
  isDocked: boolean
  columns: number
  /** Rows the pane's body shows at once. */
  rows: number
  where: Where
  /** Whether the loop in view still runs. */
  isLive: boolean
  /** The subagents section, drawn by agents-view above the flow. */
  agentSection?: RenderElement | null
  /** The changed-files part, drawn under the files looked at. */
  filesPart?: RenderElement | null
}

export type PaneActions = {
  toggleExpanded: () => void
  clear: () => void
}

export type Tone = Now['tone']

export const TONE_COLOR: Record<Tone, Color> = {
  busy: 'claude',
  think: 'claude',
  wait: 'warning',
  idle: 'inactive',
  ok: 'success',
  bad: 'error',
}

export const TONE_MARK: Record<Tone, string> = { busy: '●', think: '●', wait: '●', idle: '·', ok: '✓', bad: '✗' }

const LINE_COLOR: Record<FlowLine['tone'], Color> = {
  ok: 'success',
  bad: 'error',
  warn: 'warning',
  live: 'claude',
  wait: 'warning',
  idle: 'inactive',
  say: 'suggestion',
}

/** The activity's color once its time is weighed: slow turns yellow, stuck turns red. */
export function weigh(a: Now, elapsedMs: number | undefined): { color: Color; hint?: string } {
  if (elapsedMs !== undefined && a.stuckAfter !== undefined && elapsedMs >= a.stuckAfter * 1000) {
    return { color: 'error', hint: '여기서 매우 오래 머물고 있어요' }
  }
  if (elapsedMs !== undefined && a.slowAfter !== undefined && elapsedMs >= a.slowAfter * 1000) {
    return { color: 'warning', hint: '평소보다 오래 걸리는 중' }
  }

  return { color: TONE_COLOR[a.tone] }
}

/** The label column's width: the longest label, within reason. */
export function labelWidth(lines: readonly FlowLine[], max = 18): number {
  let w = 0
  for (const l of lines) if (l.tone !== 'say' && l.isStep !== true) w = Math.max(w, textCells(l.label))

  return Math.min(max, w)
}

/** One flow line: its mark, its label in a column, what it was about, the harness piece a signal points at. */
export function flowLineView(els: Els, l: FlowLine, labelCells: number, isExpanded: boolean, indent = '  '): RenderElement {
  const { Box, Text } = els
  const color = LINE_COLOR[l.tone]
  if (l.isStep === true) {
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="truncate-end">
          {indent}
          {l.label}
        </Text>
        {l.details.map(d => (
          <Text dimColor italic wrap="truncate-end">
            {indent}
            {'  '}
            {d}
          </Text>
        ))}
      </Box>
    )
  }
  if (l.tone === 'say') {
    return (
      <Text wrap="truncate-end">
        {indent}
        <Text color={color}>» </Text>
        <Text dimColor>{l.label}</Text>
      </Text>
    )
  }
  const targets = l.targets.join(' · ')
  const label = targets === '' && l.hint === undefined ? l.label : padCells(l.label, labelCells)

  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">
        {indent}
        <Text color={color}>{l.mark} </Text>
        {l.isSignal === true ? <Text color={color}>{label}</Text> : label}
        {targets === '' ? '' : `  ${targets}`}
        {l.note === undefined ? '' : <Text dimColor>{`  · ${l.note}`}</Text>}
        {l.hint === undefined ? '' : <Text color="suggestion">{`  → ${l.hint}`}</Text>}
      </Text>
      {l.reason !== undefined ? (
        <Text color={l.tone === 'bad' ? 'error' : 'warning'} wrap={isExpanded ? 'wrap' : 'truncate-end'}>
          {indent}
          {'  ⎿ '}
          {l.reason}
        </Text>
      ) : null}
      {isExpanded
        ? l.details.map(d => (
            <Text dimColor wrap="truncate-end">
              {indent}
              {'  '}
              {d}
            </Text>
          ))
        : null}
    </Box>
  )
}

function section(els: Els, title: string, body: RenderElement[]): RenderElement {
  const { Box, Text } = els
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{title}</Text>
      {body}
    </Box>
  )
}

export function renderPane(els: Els, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const loop = d.viewAgentId ?? MAIN
  const isMain = loop === MAIN
  const agent = isMain ? undefined : d.agents.find(a => a.id === loop)
  const turn = isMain ? latestTurn(d.turns) : undefined
  const end = isMain
    ? turn === undefined
      ? undefined
      : turn.outcome === undefined
        ? { isEnded: turn.endedAt !== undefined }
        : { isEnded: turn.endedAt !== undefined, outcome: turn.outcome }
    : agent === undefined
      ? undefined
      : agent.outcome === undefined
        ? { isEnded: agent.endedAt !== undefined }
        : { isEnded: agent.endedAt !== undefined, outcome: agent.outcome }
  const steps = turnSteps(d.steps, loop, turn)
  const now = nowOf(steps, end, isMain ? d.compactSince : null, d.where)
  const elapsed = now.since === undefined ? undefined : Math.max(0, d.now - now.since)
  const look = weigh(now, elapsed)
  const started = isMain ? turn?.startedAt : agent?.startedAt
  const ended = isMain ? turn?.endedAt : agent?.endedAt
  const flow = buildFlow(steps, {
    now: d.now,
    w: d.where,
    isExpanded: d.isExpanded,
    notes: isMain ? (turn?.notes ?? []) : [],
    compactions: isMain ? (turn?.compactions ?? []) : [],
    isLive: d.isLive && end?.isEnded !== true,
    runningCalls: new Set(d.agents.filter(a => a.endedAt === undefined && a.toolUseId !== '').map(a => a.toolUseId)),
  })
  const refs = refsOf(steps, d.where)
  const toolCount = steps.reduce((n, s) => n + s.tools.filter(t => t.state !== 'queued').length, 0)
  const changed = changedIn(steps, d.files)
  const took = started === undefined ? '' : fmtKo((ended ?? d.now) - started)
  const stats = [took, `도구 ${toolCount}번`, `참고 파일 ${refs.count}`, `고친 파일 ${changed}`].filter(p => p !== '').join(' · ')
  const since = elapsed === undefined ? '' : fmtKo(elapsed)

  const header = (
    <Box flexDirection="column">
      {isMain ? null : (
        <Text bold color="permission" wrap="truncate-end">
          서브에이전트 · {agent?.type ?? '알 수 없음'}
          {agent !== undefined && agent.description !== '' ? ` · ${agent.description}` : ''}
        </Text>
      )}
      <Text bold color={look.color} wrap="truncate-end">
        {TONE_MARK[now.tone]} {now.label}
        {since === '' ? '' : ` · ${since}`}
      </Text>
      {now.detail !== undefined && now.detail !== '' ? (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {now.detail}
        </Text>
      ) : null}
      {look.hint !== undefined ? (
        <Text color={look.color}>
          {'  '}
          {look.hint}
        </Text>
      ) : null}
      {isMain && turn !== undefined ? (
        <Text dimColor wrap="truncate-end">
          {'  '}
          {turnLabel(turn, d.agents, 160)}
        </Text>
      ) : null}
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1}>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {stats}
          </Text>
        </Box>
        {d.isDocked ? <Button key="detail" label={d.isExpanded ? '간단히' : '자세히'} onPress={act.toggleExpanded} /> : null}
        {d.isDocked ? <Button key="clear" label="지우기" onPress={act.clear} /> : null}
      </Box>
    </Box>
  )

  const isEmpty = steps.length === 0 && (!isMain || turn === undefined)
  if (isEmpty) {
    return (
      <Box flexDirection="column">
        {header}
        <Box marginTop={1}>
          <Text dimColor>
            {isMain
              ? '아직 기록이 없어요. 프롬프트를 보내면 어떤 도구로 무엇을 했는지, 어떤 파일을 봤는지, 어디서 막혔는지 여기에 흐름으로 나옵니다.'
              : '이 에이전트의 기록이 없어요 (패널이 켜지기 전에 시작된 에이전트일 수 있어요).'}
          </Text>
        </Box>
        {d.agentSection ?? null}
      </Box>
    )
  }

  // Above the prompt in a narrow pane: the header, the latest line or two, and the counts.
  if (!d.isDocked) {
    const shown = flow.filter(l => l.isStep !== true).slice(-2)
    const w = labelWidth(shown, 12)
    return (
      <Box flexDirection="column">
        {header}
        {shown.map(l => flowLineView(els, l, w, false))}
        {renderPlans(els, { plans: d.plans, agents: d.agents, loop, isDocked: false, isExpanded: false })}
        {d.agentSection ?? null}
        {d.filesPart ?? null}
      </Box>
    )
  }

  // The flow gets the rows the other parts leave, so its latest line stays in view.
  const flowRoom = d.isExpanded ? Math.max(30, d.rows) : Math.max(8, Math.min(18, d.rows - 22))
  const { folded, shown } = foldFlow(flow, flowRoom)
  const labelCells = labelWidth(shown)
  const flowBody: RenderElement[] = []
  if (folded > 0) flowBody.push(<Text dimColor>{`  …앞의 ${folded}개`}</Text>)
  for (const l of shown) flowBody.push(flowLineView(els, l, labelCells, d.isExpanded))

  const refLabel = Math.min(18, Math.max(0, ...refs.rows.map(r => textCells(r.label))))
  const itemCells = Math.max(16, d.columns - refLabel - 6)
  const refBody: RenderElement[] = []
  for (const r of refs.rows) {
    wrapItems(r.items, itemCells).forEach((text, i) => {
      refBody.push(
        <Text wrap="truncate-end">
          {'  '}
          <Text dimColor>{padCells(i === 0 ? r.label : '', refLabel)}</Text>
          {refLabel > 0 ? '  ' : ''}
          {text}
        </Text>,
      )
    })
  }
  if (refs.web.length > 0) {
    wrapItems(refs.web, itemCells).forEach((text, i) => {
      refBody.push(
        <Text wrap="truncate-end">
          {'  '}
          <Text dimColor>{padCells(i === 0 ? '웹' : '', Math.max(refLabel, 2))}</Text>
          {'  '}
          {text}
        </Text>,
      )
    })
  }

  const time = timeLine(timeOf(steps, d.now, isMain ? (turn?.compactions ?? []) : []))
  const harness = harnessOf(steps, isMain ? d.agents : [], started ?? 0, d.now, d.where)

  return (
    <Box flexDirection="column">
      {header}
      {renderPlans(els, { plans: d.plans, agents: d.agents, loop, isDocked: d.isDocked, isExpanded: d.isExpanded })}
      {d.agentSection ?? null}
      {section(els, '흐름', flowBody)}
      {refs.count > 0 || refs.web.length > 0 ? section(els, `참고한 파일 ${refs.count}`, refBody) : null}
      {d.filesPart ?? null}
      {time === '' ? null : section(els, '시간이 간 곳', [<Text wrap="truncate-end">{`  ${time}`}</Text>])}
      {section(els, '하네스', [
        <Text wrap="truncate-end">{`  ${harnessLine(harness)}`}</Text>,
        ...(d.isExpanded ? harness.hookDetails.map(h => <Text dimColor wrap="truncate-end">{`    ${h}`}</Text>) : []),
      ])}
      {isMain && d.agents.length > 0 && d.isExpanded ? (
        <Box marginTop={1}>
          <Text dimColor>작업 목록에서 서브에이전트 화면을 열면 이 패널도 그 에이전트의 추적으로 바뀝니다.</Text>
        </Box>
      ) : null}
    </Box>
  )
}
