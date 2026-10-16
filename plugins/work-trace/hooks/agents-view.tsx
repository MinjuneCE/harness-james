// The main pane's subagents section: running agents on top, the latest ended
// ones below, nested ones under their parent, each with what it does now,
// its latest calls, its last error and where it got stuck.
import type { RenderElement } from 'claude-code'

import type { TraceAgent, TraceStep, TraceTurn } from '../types'
import { agentCards, sourceLabel } from './agents'
import type { AgentCard } from './agents'
import { fmtKo } from './flow'
import type { Where } from './flow'
import { TONE_COLOR, TONE_MARK, flowLineView, labelWidth, weigh } from './view'
import type { Els } from './view'

export type AgentSectionData = {
  agents: readonly TraceAgent[]
  steps: readonly TraceStep[]
  turns: readonly TraceTurn[]
  now: number
  isExpanded: boolean
  isDocked: boolean
  /** Cards the person opened or closed by hand. */
  fold: Readonly<Record<string, boolean>>
  where: Where
}

export type AgentSectionActions = {
  toggleAgent: (id: string, isOpen: boolean) => void
}

/** Running agents drawn before the rest are summed up in a line. */
const RUNNING_ROOM = 8
/** Running agents an inline pane gives a line each. */
const INLINE_ROOM = 2

/** A running card opens by default, and the one whose report the current turn reads; the rest close, unless the person said otherwise. */
export function isOpen(c: AgentCard, fold: Readonly<Record<string, boolean>>): boolean {
  return fold[c.agent.id] ?? (c.isRunning || c.handback?.isCurrent === true)
}

function lookOf(c: AgentCard): { color: ReturnType<typeof weigh>['color']; hint?: string } {
  return c.isRunning ? weigh(c.activity, c.elapsedMs) : { color: TONE_COLOR[c.activity.tone] }
}

/** The card's counts on one line: requests, calls, errors, refusals and its whole run. */
function counts(c: AgentCard, now: number): string {
  const parts = [`요청 ${c.requests}`, `도구 ${c.tools}`]
  if (c.errors > 0) parts.push(`오류 ${c.errors}`)
  if (c.denied > 0) parts.push(`거부 ${c.denied}`)
  const total = fmtKo((c.agent.endedAt ?? now) - c.agent.startedAt)
  if (total !== '') parts.push(`전체 ${total}`)

  return parts.join(' · ')
}

function nowLine(c: AgentCard): string {
  const since = c.elapsedMs === undefined ? '' : fmtKo(c.elapsedMs)
  return since === '' ? c.activity.label : `${c.activity.label} · ${since}`
}

export function renderAgentSection(els: Els, d: AgentSectionData, act: AgentSectionActions): RenderElement | null {
  const { Box, Text, Button } = els
  if (d.agents.length === 0) return null

  if (!d.isDocked) {
    // Inline, above the prompt: one line per running agent, nothing for the ended.
    const running = agentCards(d.agents, d.steps, d.turns, d.now, { ended: 0, tools: 0, where: d.where }).filter(c => c.isRunning)
    if (running.length === 0) return null

    return (
      <Box flexDirection="column">
        {running.slice(0, INLINE_ROOM).map(c => (
          <Text color={lookOf(c).color} wrap="truncate-end">
            {'⎿ '}
            {TONE_MARK[c.activity.tone]} {c.agent.type}: {nowLine(c)} · 도구 {c.tools}
            {c.errors > 0 ? ` · 오류 ${c.errors}` : ''}
          </Text>
        ))}
        {running.length > INLINE_ROOM ? <Text dimColor>{`⎿ …실행 중 ${running.length - INLINE_ROOM}개 더`}</Text> : null}
      </Box>
    )
  }

  const limits = d.isExpanded ? { ended: 6, tools: 8, where: d.where } : { ended: 3, tools: 3, where: d.where }
  const cards = agentCards(d.agents, d.steps, d.turns, d.now, limits)
  if (cards.length === 0) return null
  const runningCount = cards.filter(c => c.isRunning).length
  const endedCount = d.agents.length - d.agents.filter(a => a.endedAt === undefined).length
  let runningShown = 0
  const hidden: AgentCard[] = []

  const cardView = (c: AgentCard): RenderElement => {
    const open = isOpen(c, d.fold)
    const look = lookOf(c)
    const pad = '  '.repeat(c.depth)
    const branch = c.depth > 0 ? '└ ' : ''
    const source = sourceLabel(c.agent)
    const title = [c.agent.type, c.agent.description, source].filter(p => p !== '').join(' · ')
    const toggle = (
      <Button key={`agent:${c.agent.id}`} label={open ? '접기' : '펼치기'} onPress={() => act.toggleAgent(c.agent.id, !open)} />
    )

    if (!open) {
      return (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text color={look.color} wrap="truncate-end">
              {pad}
              {branch}
              {TONE_MARK[c.activity.tone]} {c.agent.type}: {nowLine(c)} · 도구 {c.tools}
              {c.errors > 0 ? ` · 오류 ${c.errors}` : ''}
              {c.signals.length > 0 ? ` · 막힘 ${c.signals.length}` : ''}
              {c.agent.description === '' ? '' : ` · ${c.agent.description}`}
            </Text>
          </Box>
          {toggle}
        </Box>
      )
    }

    const inner = `${pad}${c.depth > 0 ? '  ' : ''}  `
    const signalRoom = d.isExpanded ? 5 : 2
    const lines = c.recent
    const w = labelWidth(lines, 14)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1}>
            <Text bold color={look.color} wrap="truncate-end">
              {pad}
              {branch}
              {TONE_MARK[c.activity.tone]} {title}
            </Text>
          </Box>
          {toggle}
        </Box>
        <Text color={look.color} wrap="truncate-end">
          {inner}
          {nowLine(c)} · {counts(c, d.now)}
        </Text>
        {look.hint !== undefined ? (
          <Text color={look.color} wrap="truncate-end">
            {inner}
            {look.hint}
          </Text>
        ) : null}
        {lines.map(l => flowLineView(els, l, w, false, inner))}
        {c.signals.slice(-signalRoom).map(l => flowLineView(els, l, w, false, inner))}
        {c.handback !== undefined ? (
          <Text color="suggestion" wrap="truncate-end">
            {inner}◀ 결과 전달됨{c.handback.isCurrent ? ' (지금 턴)' : ''}
            {c.handback.text === '' ? '' : ` · ${c.handback.text}`}
          </Text>
        ) : null}
      </Box>
    )
  }

  const rows: RenderElement[] = []
  let isHiding = false
  for (const c of cards) {
    // Past the room, running roots and their trees fold into one line; nested ones go with their root.
    if (c.depth === 0) {
      if (c.isRunning) runningShown += 1
      isHiding = c.isRunning && runningShown > RUNNING_ROOM
    }
    if (isHiding) {
      if (c.isRunning) hidden.push(c)
      continue
    }
    rows.push(cardView(c))
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="permission" wrap="truncate-end">
        서브에이전트 · 실행 중 {runningCount}
        {endedCount > 0 ? ` · 끝남 ${endedCount}` : ''}
      </Text>
      {rows}
      {hidden.length > 0 ? <Text dimColor>{`  …실행 중 ${hidden.length}개 더`}</Text> : null}
    </Box>
  )
}
