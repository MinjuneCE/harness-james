// The pane's plan section: each list or plan the session set out, how far it
// got, and the item under way. Hidden while no call has set one out.
import type { Color, RenderElement } from 'claude-code'

import type { TraceAgent, TracePlan, TracePlanItem, TracePlanSource } from '../types'
import { isPlanLive, progressOf } from './plan'
import { MAIN } from './trace'
import type { Els } from './view'

export type PlanData = {
  plans: readonly TracePlan[]
  agents: readonly TraceAgent[]
  /** `main` shows every loop's plans, a subagent's view its own. */
  loop: string
  isDocked: boolean
  isExpanded: boolean
}

const SOURCE_LABEL: Record<TracePlanSource, string> = { todo: '할 일', task: '태스크', plan: '계획', workflow: '워크플로' }

const ITEM_LOOK: Record<TracePlanItem['status'], { mark: string; color: Color }> = {
  done: { mark: '✓', color: 'success' },
  active: { mark: '●', color: 'claude' },
  pending: { mark: '·', color: 'inactive' },
}

const BAR = 10

/** The plans in view: the loop's own, or on main every loop's, main's first; lists under way before finished ones. */
export function plansInView(plans: readonly TracePlan[], loop: string): TracePlan[] {
  const own = loop === MAIN ? plans.slice() : plans.filter(p => p.loop === loop)
  const rank = (p: TracePlan): number => (p.loop === MAIN ? 0 : 2) + (isPlanLive(p) ? 0 : 1)

  return own.sort((a, b) => rank(a) - rank(b) || b.updatedAt - a.updatedAt)
}

/** The items to show in `room` rows: from just before the first unfinished one, so the work under way stays in sight. */
export function itemWindow(items: readonly TracePlanItem[], room: number): { shown: TracePlanItem[]; before: number; after: number } {
  if (items.length <= room) return { shown: items.slice(), before: 0, after: 0 }
  const first = items.findIndex(i => i.status !== 'done')
  const start = Math.max(0, Math.min((first < 0 ? items.length : first) - 1, items.length - room))

  return { shown: items.slice(start, start + room), before: start, after: items.length - start - room }
}

function ownerOf(p: TracePlan, agents: readonly TraceAgent[]): string {
  if (p.loop === MAIN) return ''
  const a = agents.find(x => x.id === p.loop)
  return a === undefined ? ' · 서브에이전트' : ` · ${a.type}`
}

/** What the plan's own head says about how far it got. */
function standing(p: TracePlan, agents: readonly TraceAgent[]): { text: string; color: Color; bar?: number } {
  if (p.source === 'workflow') {
    const run = agents.filter(a => a.toolUseId !== '' && a.toolUseId === p.toolUseId)
    const ended = run.filter(a => a.endedAt !== undefined).length
    const counts = run.length === 0 ? '' : ` · 에이전트 ${ended}/${run.length} 완료`
    if (p.state === 'done') return { text: `완료${counts}`, color: 'success', bar: 1 }
    if (p.state === 'fail') return { text: `실패${counts}`, color: 'error' }
    if (p.state === 'stop') return { text: `중단${counts}`, color: 'inactive' }
    return { text: `실행 중${counts}`, color: 'claude', ...(run.length === 0 ? {} : { bar: ended / run.length }) }
  }
  if (!p.hasStatus) {
    return { text: p.items.length === 0 ? '승인됨' : `승인됨 · ${p.items.length}단계 · 진행 상태는 기록되지 않음`, color: 'subtle' }
  }
  const { done, total, pct } = progressOf(p)
  const color: Color = done === total ? 'success' : p.items.some(i => i.status === 'active') ? 'claude' : 'warning'

  return { text: `${done}/${total} 완료 · ${pct}%`, color, bar: total === 0 ? 0 : done / total }
}

export function renderPlans(els: Els, d: PlanData): RenderElement | null {
  const { Box, Text } = els
  const inView = plansInView(d.plans, d.loop)
  if (inView.length === 0) return null

  const planRoom = d.isDocked ? (d.isExpanded ? inView.length : 3) : 1
  const itemRoom = d.isDocked ? (d.isExpanded ? 30 : 6) : 0

  const itemView = (i: TracePlanItem, p: TracePlan): RenderElement => {
    const look = p.hasStatus ? ITEM_LOOK[i.status] : { mark: '·', color: 'subtle' as Color }
    const isActive = p.hasStatus && i.status === 'active'
    const text = isActive && i.activeText !== undefined ? i.activeText : i.text

    return (
      <Text wrap="truncate-end">
        {'  '}
        <Text color={look.color}>{look.mark} </Text>
        {isActive ? (
          <Text bold color="claude">
            {text}
          </Text>
        ) : i.status === 'done' && p.hasStatus ? (
          <Text dimColor>{text}</Text>
        ) : (
          text
        )}
      </Text>
    )
  }

  const planView = (p: TracePlan): RenderElement => {
    const s = standing(p, d.agents)
    const title = p.source === 'plan' || p.source === 'workflow' ? (p.title === '' ? '' : ` · ${p.title}`) : ''
    const filled = s.bar === undefined ? 0 : Math.round(s.bar * BAR)
    const win = itemWindow(p.items, itemRoom)
    // Inline there is room for one line under the head: the item under way, if any.
    const current = itemRoom === 0 && p.hasStatus ? p.items.find(i => i.status === 'active') : undefined

    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">
          <Text bold>
            {SOURCE_LABEL[p.source]}
            {ownerOf(p, d.agents)}
          </Text>
          {title}
          {' '}
          {s.bar === undefined ? null : (
            <Text>
              <Text color="success">{'━'.repeat(filled)}</Text>
              <Text color="inactive">{'─'.repeat(BAR - filled)}</Text>{' '}
            </Text>
          )}
          <Text color={s.color}>{s.text}</Text>
        </Text>
        {win.before > 0 && itemRoom > 0 ? <Text dimColor>{`  …앞의 ${win.before}개`}</Text> : null}
        {itemRoom > 0 ? win.shown.map(i => itemView(i, p)) : null}
        {win.after > 0 && itemRoom > 0 ? <Text dimColor>{`  …그 밖에 ${win.after}개`}</Text> : null}
        {current === undefined ? null : itemView(current, p)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color="claude">
        계획
      </Text>
      {inView.slice(0, planRoom).map(planView)}
      {inView.length > planRoom ? <Text dimColor>{`  …다른 목록 ${inView.length - planRoom}개 ('자세히'에서 보기)`}</Text> : null}
    </Box>
  )
}
