// The subagents section's data: which agents the main pane shows, in what
// order and nesting, and what each one is doing, read from the same trace.
import type { TraceAgent, TraceStep, TraceTurn } from '../types'
import { MAIN, latestTurn } from './trace'
import { buildFlow, nowOf } from './flow'
import type { FlowLine, Now, Where } from './flow'

type LoopEnd = { isEnded: boolean; outcome?: string }

/** How deep nested agents indent before they line up with their parent's depth. */
export const MAX_DEPTH = 3

export type AgentCard = {
  agent: TraceAgent
  depth: number
  isRunning: boolean
  activity: Now
  /** How long it has been in its current activity. */
  elapsedMs?: number
  requests: number
  tools: number
  errors: number
  denied: number
  /** Its latest flow lines, oldest first, in the main flow's words. */
  recent: FlowLine[]
  /** Where it got stuck: its flow's signal lines. */
  signals: FlowLine[]
  /** The main turn its report came back in. */
  handback?: { text: string; isCurrent: boolean }
}

export type CardLimits = { ended: number; tools: number; where: Where; isExpanded?: boolean }

function endOf(a: TraceAgent): LoopEnd {
  return a.outcome === undefined
    ? { isEnded: a.endedAt !== undefined }
    : { isEnded: a.endedAt !== undefined, outcome: a.outcome }
}

/** The agent that started it: as its spawn said, else the loop its starting call ran in. */
export function parentOf(a: TraceAgent, steps: readonly TraceStep[]): string | undefined {
  if (a.parentId !== undefined) return a.parentId
  if (a.toolUseId === '') return undefined
  const owner = steps.find(s => s.loop !== MAIN && s.loop !== a.id && s.tools.some(t => t.id === a.toolUseId))

  return owner?.loop
}

/** Where the agent came from, in a word: a workflow's agent, a forked skill, a background run. */
export function sourceLabel(a: TraceAgent): string {
  if (a.source === 'workflow') return a.workflowIndex === undefined ? 'Workflow' : `Workflow #${a.workflowIndex}`
  if (a.source === 'skill') return '스킬'

  return a.isBackground ? '백그라운드' : ''
}

function card(
  a: TraceAgent,
  depth: number,
  steps: readonly TraceStep[],
  turns: readonly TraceTurn[],
  now: number,
  limits: CardLimits,
): AgentCard {
  const own = steps.filter(s => s.loop === a.id)
  const isRunning = a.endedAt === undefined
  const activity = nowOf(own, endOf(a), null, limits.where)
  const tools = own.flatMap(s => s.tools)
  const flow = limits.tools > 0 ? buildFlow(own, { now, w: limits.where, isExpanded: false, isLive: isRunning }) : []
  const actions = flow.filter(l => l.isSignal !== true)
  const out: AgentCard = {
    agent: a,
    depth,
    isRunning,
    activity,
    requests: own.filter(s => s.index >= 0).length,
    tools: tools.length,
    errors: tools.filter(t => t.state === 'fail').length,
    denied: tools.filter(t => t.state === 'deny').length,
    recent: actions.slice(-limits.tools),
    signals: flow.filter(l => l.isSignal === true),
  }
  if (activity.since !== undefined) out.elapsedMs = Math.max(0, now - activity.since)
  const current = latestTurn(turns)
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i]
    const origin = turn?.origin
    if (turn === undefined || origin?.kind !== 'agent' || origin.agentId !== a.id || !origin.isHandback) continue
    out.handback = { text: origin.text, isCurrent: turn === current }
    break
  }

  return out
}

/**
 * The agents the main pane shows, flattened in drawing order: every running
 * one, the latest ended ones, and the one whose report the current turn reads;
 * each under the agent that started it when that one is shown too.
 */
export function agentCards(
  agents: readonly TraceAgent[],
  steps: readonly TraceStep[],
  turns: readonly TraceTurn[],
  now: number,
  limits: CardLimits,
): AgentCard[] {
  const running = agents.filter(a => a.endedAt === undefined)
  const ended = agents
    .filter(a => a.endedAt !== undefined)
    .sort((x, y) => (y.endedAt ?? 0) - (x.endedAt ?? 0))
  const shown = new Set<string>([...running, ...ended.slice(0, limits.ended)].map(a => a.id))
  const origin = latestTurn(turns)?.origin
  if (origin?.kind === 'agent' && agents.some(a => a.id === origin.agentId)) shown.add(origin.agentId)

  const pick = agents.filter(a => shown.has(a.id))
  const parent = new Map(pick.map(a => [a.id, parentOf(a, steps)]))
  const order = (x: TraceAgent, y: TraceAgent): number => {
    const xr = x.endedAt === undefined
    const yr = y.endedAt === undefined
    if (xr !== yr) return xr ? -1 : 1
    return xr ? x.startedAt - y.startedAt : (y.endedAt ?? 0) - (x.endedAt ?? 0)
  }
  const childrenOf = (id: string | undefined): TraceAgent[] =>
    pick
      .filter(a => {
        const p = parent.get(a.id)
        const isRoot = p === undefined || !shown.has(p) || p === a.id
        return id === undefined ? isRoot : !isRoot && p === id
      })
      .sort(order)

  const out: AgentCard[] = []
  const seen = new Set<string>()
  const walk = (list: TraceAgent[], depth: number): void => {
    for (const a of list) {
      if (seen.has(a.id)) continue
      seen.add(a.id)
      out.push(card(a, Math.min(depth, MAX_DEPTH), steps, turns, now, limits))
      walk(childrenOf(a.id), depth + 1)
    }
  }
  walk(childrenOf(undefined), 0)
  // A parent loop that names itself through another (a cycle) leaves its agents unwalked: show them flat.
  for (const a of pick.slice().sort(order)) {
    if (!seen.has(a.id)) out.push(card(a, 0, steps, turns, now, limits))
  }

  return out
}
