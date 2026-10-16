// The trace's data: pure functions over the values kept in $.state, so the
// hooks and the pane share one reading of them and the tests can call them.
import type { TraceAgent, TraceStep, TraceTool, TraceToolState, TraceTurn, TraceTurnOrigin } from '../types'

export const MAIN = 'main'
export const MAX_STEPS = 60
/** Each subagent loop keeps its own latest steps, so a busy subagent never pushes the main loop's out. */
export const MAX_AGENT_STEPS = 12
/** Subagent loops whose steps are kept, the most recently active first. */
export const MAX_AGENT_LOOPS = 12
export const MAX_AGENTS = 30
export const MAX_TURNS = 12
export const MAX_TOOLS = 40
export const THINK_KEEP = 1600
export const SAID_KEEP = 600
export const NOTE_KEEP = 220

const LIVE_TOOL: ReadonlySet<TraceToolState> = new Set(['run', 'ask', 'wait'])
const RESERVED = new Set(['tool', 'tool_use_id', 'agentId', 'requestMeta'])
const REJECTED = /doesn['’]t want to proceed|was rejected|denied by|permission (?:was )?denied/i

export const loopOf = (agentId: string | undefined): string => agentId ?? MAIN

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

export function keepTail(text: string, max: number): string {
  return text.length > max ? text.slice(text.length - max) : text
}

export function keepHead(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** Terminal cells a character takes: two for Hangul, CJK, fullwidth and emoji. */
export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff)

  return isWide ? 2 : 1
}

/** The end of `text` that fits in `cells`, led by an ellipsis when cut. */
export function tailCells(text: string, cells: number): string {
  const chars = Array.from(text)
  let used = 0
  let i = chars.length
  while (i > 0) {
    const w = cellWidth(chars[i - 1] ?? '')
    if (used + w > cells) break
    used += w
    i -= 1
  }

  return i === 0 ? text : `…${chars.slice(i).join('')}`
}

/** The start of `text` that fits in `cells`, ended by an ellipsis when cut. */
export function headCells(text: string, cells: number): string {
  const chars = Array.from(text)
  let used = 0
  let i = 0
  while (i < chars.length) {
    const w = cellWidth(chars[i] ?? '')
    if (used + w > cells) break
    used += w
    i += 1
  }

  return i === chars.length ? text : `${chars.slice(0, i).join('')}…`
}

export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
}

export function fmtDur(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)}s`
  const s = Math.floor(safe / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`

  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** A tool call's key argument on one line. */
export function summarize(tool: string, input: unknown, cwd = ''): string {
  const o: Record<string, unknown> =
    input !== null && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const str = (k: string): string | undefined => {
    const v = o[k]
    return typeof v === 'string' && v !== '' ? v : undefined
  }
  const rel = (p: string | undefined): string | undefined =>
    p !== undefined && cwd !== '' && p.startsWith(`${cwd}/`) ? p.slice(cwd.length + 1) : p
  const join = (...parts: (string | undefined)[]): string =>
    parts.filter((p): p is string => p !== undefined).join(' · ')

  let text: string | undefined
  switch (tool) {
    case 'Bash':
      text = str('command')
      break
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      text = rel(str('file_path'))
      break
    case 'NotebookEdit':
      text = rel(str('notebook_path'))
      break
    case 'Glob':
      text = join(str('pattern'), rel(str('path')))
      break
    case 'Grep':
      text = join(str('pattern'), rel(str('path')) ?? str('glob'))
      break
    case 'WebFetch':
      text = str('url')
      break
    case 'WebSearch':
    case 'ToolSearch':
      text = str('query')
      break
    case 'Agent':
    case 'Task':
      text = join(str('subagent_type'), str('description'))
      break
    case 'Skill':
      text = join(str('skill'), str('args'))
      break
    case 'AskUserQuestion': {
      const first: unknown = Array.isArray(o.questions) ? o.questions[0] : undefined
      const q =
        first !== null && typeof first === 'object' ? (first as { question?: unknown }).question : undefined
      text = typeof q === 'string' ? q : undefined
      break
    }
    default:
      for (const [k, v] of Object.entries(o)) {
        if (!RESERVED.has(k) && typeof v === 'string' && v !== '') {
          text = v
          break
        }
      }
  }

  return oneLine(text ?? '', 200)
}

/** The telling lines of an error text: its first and its last. */
export function excerpt(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const lines = text
    .replace(/<\/?[a-z_]+>/g, '')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  const first = lines[0]
  if (first === undefined) return undefined
  const last = lines[lines.length - 1] ?? first

  return oneLine(first === last ? first : `${first} … ${last}`, NOTE_KEEP)
}

export function verdictText(v: { decision: string; reason?: string; rule?: string; hook?: string }): string {
  const head = v.decision === 'allow' ? '허용' : v.decision === 'deny' ? '거부' : '확인 필요'
  const why =
    v.rule !== undefined
      ? `규칙 ${v.rule}`
      : v.hook !== undefined
        ? `훅 ${v.hook}`
        : v.reason !== undefined
          ? oneLine(v.reason, 120)
          : ''

  return why === '' ? head : `${head} · ${why}`
}

// ---- writes: each takes the list as stored and answers a new one ----

export function newStep(
  id: string,
  loop: string,
  turnId: string,
  index: number,
  model: string,
  effort: string | undefined,
  now: number,
): TraceStep {
  const step: TraceStep = {
    id,
    loop,
    turnId,
    index,
    model,
    startedAt: now,
    phase: 'request',
    phaseAt: now,
    thinking: '',
    thinkingChars: 0,
    said: '',
    tools: [],
  }
  if (effort !== undefined) step.effort = effort

  return step
}

/** Keeps each loop's latest steps under its own cap: the main loop's, each subagent's, and the subagent loops kept. */
export function capSteps(list: readonly TraceStep[]): TraceStep[] {
  const counts = new Map<string, number>()
  const keep: TraceStep[] = []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i]
    if (step === undefined) continue
    const n = counts.get(step.loop) ?? 0
    const isMain = step.loop === MAIN
    if (n === 0 && !isMain && counts.size - (counts.has(MAIN) ? 1 : 0) >= MAX_AGENT_LOOPS) continue
    if (n >= (isMain ? MAX_STEPS : MAX_AGENT_STEPS)) continue
    counts.set(step.loop, n + 1)
    keep.push(step)
  }

  return keep.reverse()
}

export function putStep(list: readonly TraceStep[], step: TraceStep): TraceStep[] {
  const i = list.findIndex(s => s.id === step.id)
  if (i < 0) return capSteps([...list, step])
  const copy = list.slice()
  copy[i] = step

  return copy
}

export function patchStep(
  list: readonly TraceStep[],
  id: string,
  change: (step: TraceStep) => TraceStep,
): TraceStep[] {
  const i = list.findIndex(s => s.id === id)
  const found = list[i]
  if (found === undefined) return list.slice()
  const copy = list.slice()
  copy[i] = change(found)

  return copy
}

export function patchTool(
  list: readonly TraceStep[],
  toolId: string,
  change: (tool: TraceTool) => TraceTool,
): TraceStep[] {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i]
    if (step === undefined) continue
    const j = step.tools.findIndex(t => t.id === toolId)
    const tool = step.tools[j]
    if (tool === undefined) continue
    const tools = step.tools.slice()
    tools[j] = change(tool)
    const copy = list.slice()
    copy[i] = { ...step, tools }

    return copy
  }

  return list.slice()
}

export function hasTool(list: readonly TraceStep[], toolId: string): boolean {
  return list.some(step => step.tools.some(t => t.id === toolId))
}

/** Adds a call to the loop's latest step, or to a step of its own when the loop has none. */
export function addTool(list: readonly TraceStep[], loop: string, tool: TraceTool, now: number): TraceStep[] {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i]
    if (step === undefined || step.loop !== loop) continue
    const copy = list.slice()
    copy[i] = { ...step, tools: [...step.tools, tool].slice(-MAX_TOOLS) }

    return copy
  }
  const orphan = newStep(`${loop}:early:${now}`, loop, '', -1, '', undefined, now)
  orphan.phase = 'done'
  orphan.endedAt = now
  orphan.tools = [tool]

  return capSteps([...list, orphan])
}

export function startTool(
  list: readonly TraceStep[],
  loop: string,
  id: string,
  name: string,
  summary: string,
  now: number,
): TraceStep[] {
  if (hasTool(list, id)) {
    return patchTool(list, id, t => ({
      ...t,
      name,
      summary: summary !== '' ? summary : t.summary,
      state: t.state === 'queued' ? 'run' : t.state,
      startedAt: t.startedAt ?? now,
    }))
  }

  return addTool(list, loop, { id, name, summary, state: 'run', queuedAt: now, startedAt: now }, now)
}

/** The call once `tool.check` answered: the verdict kept raw, and an ask or a refusal on its state. */
export function checkedTool(t: TraceTool, v: { decision: string; reason?: string; rule?: string; hook?: string }): TraceTool {
  const next: TraceTool = { ...t, verdict: verdictText(v) }
  const check: TraceTool['check'] = { decision: v.decision }
  if (v.rule !== undefined) check.rule = v.rule
  if (v.hook !== undefined) check.hook = v.hook
  if (v.reason !== undefined) check.reason = oneLine(v.reason, NOTE_KEEP)
  next.check = check
  if (v.decision === 'ask') {
    next.isAsked = true
    if (t.state === 'run' || t.state === 'queued') next.state = 'ask'
  }
  if (v.decision === 'deny') {
    next.state = 'deny'
    if (v.reason !== undefined) next.note = oneLine(v.reason, NOTE_KEEP)
  }

  return next
}

export function markChecked(
  list: readonly TraceStep[],
  id: string,
  v: { decision: string; reason?: string; rule?: string; hook?: string },
): TraceStep[] {
  return patchTool(list, id, t => checkedTool(t, v))
}

/** The loop's latest live call of that tool not yet put to the person: the one a dialog went up for. */
export function promptedOf(list: readonly TraceStep[], loop: string, toolName: string): TraceTool | undefined {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const step = list[i]
    if (step === undefined || step.loop !== loop) continue
    for (let j = step.tools.length - 1; j >= 0; j -= 1) {
      const tool = step.tools[j]
      if (tool === undefined || tool.name !== toolName || tool.isPrompted === true) continue
      if (tool.state !== 'run' && tool.state !== 'ask' && tool.state !== 'queued') continue

      return tool
    }
  }

  return undefined
}

/** The dialog went up for the loop's latest live call of that tool. */
export function markPrompted(list: readonly TraceStep[], loop: string, toolName: string, now: number): TraceStep[] {
  const tool = promptedOf(list, loop, toolName)

  return tool === undefined ? list.slice() : patchTool(list, tool.id, t => ({ ...t, state: 'wait', isPrompted: true, promptedAt: now }))
}

export type ToolOutcome = { kind: 'ok' | 'fail' | 'deny'; text?: string }

/** The call once it answered: done, failed, refused or cut off, and why. */
export function finishedTool(t: TraceTool, outcome: ToolOutcome, now: number): TraceTool {
  const next: TraceTool = { ...t, endedAt: now }
  const text = outcome.text ?? ''
  if (outcome.kind === 'ok') {
    next.state = 'ok'
  } else if (outcome.kind === 'deny') {
    next.state = 'deny'
    next.note = oneLine(text, NOTE_KEEP)
  } else if (t.state === 'deny' || t.state === 'stop') {
    // PermissionDenied or an interrupt said it first
  } else if (/interrupt/i.test(text)) {
    next.state = 'stop'
    next.note = '중단됨'
  } else if ((t.isPrompted === true || t.isAsked === true) && t.execMs === undefined && REJECTED.test(text)) {
    next.state = 'deny'
    next.note = t.isPrompted === true ? '사용자가 거절함' : (excerpt(text) ?? '거부됨')
  } else {
    next.state = 'fail'
    const ex = excerpt(text)
    if (ex !== undefined) next.note = ex
  }

  return next
}

export function finishTool(list: readonly TraceStep[], id: string, outcome: ToolOutcome, now: number): TraceStep[] {
  return patchTool(list, id, t => finishedTool(t, outcome, now))
}

/** Ends what a loop left open when its turn ended. */
export function closeLoop(list: readonly TraceStep[], loop: string, now: number, isAborted: boolean): TraceStep[] {
  return list.map(step => {
    if (step.loop !== loop) return step
    const isOpen = step.phase !== 'done' && step.phase !== 'failed'
    const hasLive = step.tools.some(t => t.state === 'queued' || LIVE_TOOL.has(t.state))
    if (!isOpen && !hasLive) return step
    const next: TraceStep = { ...step }
    if (isOpen) {
      next.phase = isAborted ? 'failed' : 'done'
      next.phaseAt = now
      next.endedAt = step.endedAt ?? now
    }
    if (hasLive) {
      next.tools = step.tools.map(t =>
        t.state === 'queued' || LIVE_TOOL.has(t.state) ? { ...t, state: 'stop', endedAt: t.endedAt ?? now } : t,
      )
    }

    return next
  })
}

// ---- reads: what the pane draws ----

/** How long a call waited on its approval: settled, from its run time; still waiting, from the clock. */
export function waitMs(t: TraceTool, now: number): number {
  if (t.execMs !== undefined && t.startedAt !== undefined && t.endedAt !== undefined) {
    return Math.max(0, t.endedAt - t.startedAt - t.execMs)
  }
  if (t.state === 'wait') return Math.max(0, now - (t.promptedAt ?? t.startedAt ?? now))
  if (t.state === 'ask') return Math.max(0, now - (t.startedAt ?? now))

  return 0
}

export function runMs(t: TraceTool, now: number): number {
  if (t.execMs !== undefined) return t.execMs

  return Math.max(0, (t.endedAt ?? now) - (t.startedAt ?? t.queuedAt))
}

/** The turn a step list belongs to: the main loop's latest, else none. */
export function latestTurn(turns: readonly TraceTurn[]): TraceTurn | undefined {
  return turns[turns.length - 1]
}

const AGENT_MESSAGE = /^\s*(?:Another Claude session sent a message:\s*)?<agent-message from="([^"]+)">/
const REPORT_FOLLOWS = 'The report follows:'

/** A main turn the engine started for a message, not for the person: an agent's report, or a task notification. */
export function originOf(text: string): TraceTurnOrigin | undefined {
  const agent = AGENT_MESSAGE.exec(text)
  const agentId = agent?.[1]
  if (agent !== null && agentId !== undefined) {
    const follows = text.indexOf(REPORT_FOLLOWS)
    const from = follows >= 0 ? follows + REPORT_FOLLOWS.length : agent[0].length
    const end = text.indexOf('</agent-message>', from)
    const body = text.slice(from, end >= 0 ? end : undefined)

    return { kind: 'agent', agentId, isHandback: text.includes('[Subagent hand-back]'), text: oneLine(body, 160) }
  }
  if (/^\s*<task-notification>/.test(text)) {
    const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]

    return { kind: 'notice', text: oneLine(summary ?? '', 160) }
  }

  return undefined
}

/** How a main turn reads in the pane: the person's prompt in quotes, or where the message came from. */
export function turnLabel(turn: TraceTurn, agents: readonly TraceAgent[], max: number): string {
  const origin = turn.origin
  if (origin === undefined) return `“${turn.prompt === '' ? '(이어서 진행)' : oneLine(turn.prompt, max)}”`
  if (origin.kind === 'notice') return origin.text === '' ? '◀ 알림' : `◀ 알림 · ${oneLine(origin.text, max)}`
  const from = agents.find(a => a.id === origin.agentId)?.type ?? '서브에이전트'
  const head = `◀ ${from} ${origin.isHandback ? '결과' : '메시지'}`

  return origin.text === '' ? head : `${head} · ${oneLine(origin.text, max)}`
}
