// The plan section's record: the todo lists, task lists, approved plans and
// workflow phases this session's own calls set out, and how far each got.
// Everything here comes from the calls' inputs and results and the session's
// own notices, never from files on disk. The hooks queue the calls raw
// (store.ts); these pure functions work them off the model's path.
import type { TracePlan, TracePlanItem, TracePlanItemStatus } from '../types'
import { oneLine } from './trace'

export const MAX_PLANS = 12
export const MAX_ITEMS = 60
const ITEM_KEEP = 120

const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' ? (v as Rec) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

function statusOf(v: unknown): TracePlanItemStatus {
  return v === 'completed' ? 'done' : v === 'in_progress' ? 'active' : 'pending'
}

/** The plan with this id replaced or added, the newest kept. */
export function putPlan(list: readonly TracePlan[], plan: TracePlan): TracePlan[] {
  return [...list.filter(p => p.id !== plan.id), plan].slice(-MAX_PLANS)
}

export function isPlanLive(p: TracePlan): boolean {
  if (p.state !== undefined) return p.state === 'run' || (p.source === 'plan' && p.state !== 'fail')
  return p.items.some(i => i.status !== 'done')
}

/** Done items over all items, and whether the plan says how far it got at all. */
export function progressOf(p: TracePlan): { done: number; total: number; pct: number } {
  const total = p.items.length
  const done = p.items.filter(i => i.status === 'done').length
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) }
}

// --- TodoWrite: each loop keeps its own list, and every call sends it whole.

export function applyTodos(list: readonly TracePlan[], loop: string, todos: unknown, now: number): TracePlan[] {
  if (!Array.isArray(todos)) return list.slice()
  const items: TracePlanItem[] = todos.slice(0, MAX_ITEMS).map((t, i) => {
    const r = rec(t)
    const item: TracePlanItem = { key: String(i), text: oneLine(str(r.content) ?? '', ITEM_KEEP), status: statusOf(r.status) }
    const active = str(r.activeForm)
    if (active !== undefined && active !== '') item.activeText = oneLine(active, ITEM_KEEP)
    return item
  })
  const id = `todo:${loop}`
  if (items.length === 0) return list.filter(p => p.id !== id)

  return putPlan(list, { id, source: 'todo', loop, title: '할 일', items, hasStatus: true, updatedAt: now })
}

// --- Task tools: one list for the session; each task stays with the loop that made it.

function taskPlan(list: readonly TracePlan[], loop: string, now: number): TracePlan {
  return list.find(p => p.id === `task:${loop}`) ?? { id: `task:${loop}`, source: 'task', loop, title: '태스크', items: [], hasStatus: true, updatedAt: now }
}

export function applyTaskCreate(list: readonly TracePlan[], loop: string, input: unknown, result: unknown, now: number): TracePlan[] {
  const task = rec(rec(result).task)
  const id = str(task.id)
  if (id === undefined) return list.slice()
  const i = rec(input)
  const item: TracePlanItem = { key: id, text: oneLine(str(task.subject) ?? str(i.subject) ?? '', ITEM_KEEP), status: 'pending' }
  const active = str(i.activeForm)
  if (active !== undefined && active !== '') item.activeText = oneLine(active, ITEM_KEEP)
  const plan = taskPlan(list, loop, now)

  return putPlan(list, { ...plan, items: [...plan.items.filter(t => t.key !== id), item].slice(-MAX_ITEMS), updatedAt: now })
}

/** Changes one task wherever it is filed; a deleted task leaves its list. */
function patchTask(list: readonly TracePlan[], id: string, change: (t: TracePlanItem) => TracePlanItem | undefined, now: number): TracePlan[] {
  return list
    .map(p => {
      if (p.source !== 'task' || !p.items.some(t => t.key === id)) return p
      const items = p.items.flatMap(t => {
        if (t.key !== id) return [t]
        const next = change(t)
        return next === undefined ? [] : [next]
      })
      return { ...p, items, updatedAt: now }
    })
    .filter(p => p.source !== 'task' || p.items.length > 0)
}

export function applyTaskUpdate(list: readonly TracePlan[], loop: string, input: unknown, result: unknown, now: number): TracePlan[] {
  const i = rec(input)
  const r = rec(result)
  const id = str(i.taskId) ?? str(r.taskId)
  if (id === undefined || r.success === false) return list.slice()
  const to = str(rec(r.statusChange).to) ?? str(i.status)
  if (to === 'deleted') return patchTask(list, id, () => undefined, now)
  const known = list.some(p => p.source === 'task' && p.items.some(t => t.key === id))
  const base = known ? list : applyTaskCreate(list, loop, { subject: str(i.subject) ?? `#${id}` }, { task: { id } }, now)

  return patchTask(
    base,
    id,
    t => {
      const next: TracePlanItem = { ...t }
      if (to !== undefined) next.status = statusOf(to)
      const subject = str(i.subject)
      if (subject !== undefined) next.text = oneLine(subject, ITEM_KEEP)
      const active = str(i.activeForm)
      if (active !== undefined && active !== '') next.activeText = oneLine(active, ITEM_KEEP)
      return next
    },
    now,
  )
}

/** A whole listing: each task as it stands now, tasks no longer listed gone, new ones filed under the caller. */
export function applyTaskList(list: readonly TracePlan[], loop: string, result: unknown, now: number): TracePlan[] {
  const tasks = rec(result).tasks
  if (!Array.isArray(tasks)) return list.slice()
  const listed = new Map(tasks.map(t => [str(rec(t).id) ?? '', rec(t)]))
  let next = list
    .map(p => {
      if (p.source !== 'task') return p
      const items = p.items.flatMap(t => {
        const row = listed.get(t.key)
        if (row === undefined) return []
        return [{ ...t, text: oneLine(str(row.subject) ?? t.text, ITEM_KEEP), status: statusOf(row.status) }]
      })
      return { ...p, items, updatedAt: now }
    })
    .filter(p => p.source !== 'task' || p.items.length > 0)
  for (const [id, t] of listed) {
    if (id === '' || next.some(p => p.source === 'task' && p.items.some(i => i.key === id))) continue
    next = applyTaskCreate(next, loop, { subject: t.subject }, { task: { id } }, now)
    next = patchTask(next, id, i => ({ ...i, status: statusOf(t.status) }), now)
  }

  return next
}

export function applyTaskGet(list: readonly TracePlan[], result: unknown, now: number): TracePlan[] {
  const task = rec(rec(result).task)
  const id = str(task.id)
  if (id === undefined) return list.slice()

  return patchTask(list, id, t => ({ ...t, status: statusOf(task.status), text: oneLine(str(task.subject) ?? t.text, ITEM_KEEP) }), now)
}

// --- ExitPlanMode: the plan put to the person, its list items (or headings) as steps.

const LIST_ITEM = /^( {0,3})(?:[-*+]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.+)$/
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

export function parsePlan(markdown: string): { title: string; items: TracePlanItem[]; hasStatus: boolean } {
  const lines = markdown.split(/\r?\n/)
  let title = ''
  const items: TracePlanItem[] = []
  const headings: string[] = []
  let hasBox = false
  let inFence = false
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const h = HEADING.exec(line)
    if (h !== null) {
      const text = (h[2] ?? '').replace(/[*_`]/g, '').trim()
      if (title === '' && h[1] === '#') title = text
      else if ((h[1] ?? '').length <= 3) headings.push(text)
      continue
    }
    const m = LIST_ITEM.exec(line)
    if (m === null) continue
    const box = m[2]
    if (box !== undefined) hasBox = true
    items.push({
      key: String(items.length),
      text: oneLine((m[3] ?? '').replace(/\*\*|__|`/g, ''), ITEM_KEEP),
      status: box === 'x' || box === 'X' ? 'done' : 'pending',
    })
  }
  // A plan written as sections rather than a list: its sections are its steps.
  const steps = items.length > 0 ? items : headings.map((text, i) => ({ key: String(i), text: oneLine(text, ITEM_KEEP), status: 'pending' as const }))
  if (title === '') title = headings[0] ?? oneLine(lines.find(l => l.trim() !== '') ?? '', 60)

  return { title: oneLine(title, 80), items: steps.slice(0, MAX_ITEMS), hasStatus: hasBox }
}

export function applyPlan(list: readonly TracePlan[], loop: string, result: unknown, now: number): TracePlan[] {
  const plan = str(rec(result).plan)
  if (plan === undefined || plan.trim() === '') return list.slice()
  const parsed = parsePlan(plan)

  return putPlan(list, {
    id: `plan:${loop}`,
    source: 'plan',
    loop,
    title: parsed.title,
    items: parsed.items,
    hasStatus: parsed.hasStatus,
    state: 'run',
    updatedAt: now,
  })
}

// --- Workflow: the phases its script declares, and the run's end from its notice.

/** `meta.phases` titles from a workflow script, which keeps `meta` a pure literal. */
export function parsePhases(script: string): string[] {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? script
  const phases = /phases\s*:\s*\[([\s\S]*?)\]/.exec(meta)?.[1]
  if (phases === undefined) return []
  const titles: string[] = []
  const title = /title\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/g
  for (let m = title.exec(phases); m !== null; m = title.exec(phases)) titles.push((m[2] ?? '').replace(/\\(.)/g, '$1'))

  return titles
}

function metaName(script: string): string | undefined {
  const meta = /export\s+const\s+meta\s*=\s*\{([\s\S]*?)\n\}/.exec(script)?.[1] ?? script
  return /name\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(meta)?.[2]
}

export function applyWorkflow(list: readonly TracePlan[], loop: string, toolUseId: string, input: unknown, result: unknown, now: number): TracePlan[] {
  const i = rec(input)
  const r = rec(result)
  const status = str(r.status)
  if (status !== 'async_launched' && status !== 'remote_launched') return list.slice()
  const script = str(i.script) ?? ''
  const title = str(r.workflowName) ?? metaName(script) ?? str(i.name) ?? '워크플로'
  const plan: TracePlan = {
    id: `workflow:${toolUseId}`,
    source: 'workflow',
    loop,
    title: oneLine(title, 80),
    items: parsePhases(script)
      .slice(0, MAX_ITEMS)
      .map(text => ({ key: text, text: oneLine(text, ITEM_KEEP), status: 'pending' as const })),
    hasStatus: false,
    state: 'run',
    toolUseId,
    updatedAt: now,
  }
  const taskId = str(r.taskId)
  if (taskId !== undefined) plan.taskId = taskId

  return putPlan(list, plan)
}

export type Notice = { taskId?: string; toolUseId?: string; status?: string }

/** The ids and status a `<task-notification>` turn names. */
export function noticeOf(text: string): Notice | undefined {
  if (!/^\s*<task-notification>/.test(text)) return undefined
  const tag = (name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(text)?.[1]?.trim()
  const notice: Notice = {}
  const taskId = tag('task-id')
  const toolUseId = tag('tool-use-id')
  const status = tag('status')
  if (taskId !== undefined) notice.taskId = taskId
  if (toolUseId !== undefined) notice.toolUseId = toolUseId
  if (status !== undefined) notice.status = status

  return notice
}

export function settleWorkflow(list: readonly TracePlan[], notice: Notice, now: number): TracePlan[] {
  const state = notice.status === 'completed' ? 'done' : notice.status === 'failed' ? 'fail' : notice.status === 'killed' ? 'stop' : undefined
  if (state === undefined) return list.slice()

  return list.map(p => {
    if (p.source !== 'workflow' || p.state !== 'run') return p
    const isIt = (notice.toolUseId !== undefined && notice.toolUseId === p.toolUseId) || (notice.taskId !== undefined && notice.taskId === p.taskId)
    if (!isIt) return p
    // A finished run went through every phase it declared; a failed one says no more than that.
    return state === 'done'
      ? { ...p, state, hasStatus: true, items: p.items.map(i => ({ ...i, status: 'done' as const })), updatedAt: now }
      : { ...p, state, updatedAt: now }
  })
}

/** One call's mark on the plans: the list it wrote or read, the plan it put, the run it started. */
export function applyCall(
  list: readonly TracePlan[],
  loop: string,
  tool: string,
  toolUseId: string,
  input: unknown,
  result: unknown,
  now: number,
): TracePlan[] {
  switch (tool) {
    case 'TodoWrite':
      return applyTodos(list, loop, rec(result).newTodos ?? rec(input).todos, now)
    case 'TaskCreate':
      return applyTaskCreate(list, loop, input, result, now)
    case 'TaskUpdate':
      return applyTaskUpdate(list, loop, input, result, now)
    case 'TaskList':
      return applyTaskList(list, loop, result, now)
    case 'TaskGet':
      return applyTaskGet(list, result, now)
    case 'ExitPlanMode':
      return applyPlan(list, loop, result, now)
    case 'Workflow':
      return applyWorkflow(list, loop, toolUseId, input, result, now)
    default:
      return list.slice()
  }
}

export const isPlanTool = (tool: string): boolean =>
  tool === 'TodoWrite' || tool === 'ExitPlanMode' || tool === 'Workflow' || TASK_TOOLS.has(tool)
