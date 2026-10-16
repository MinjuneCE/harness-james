// The trace as the module keeps it: plain objects in memory, written by the
// hooks with synchronous code alone, so no hook waits on the trace. What takes
// more than a few property writes (a prompt read for where it came from, a
// plan's markdown, a file's diff, an agent looked up) waits raw in a queue and
// is worked off the model's path: by the pane's timer or when the pane draws.
import type { TraceAgent, TraceFile, TracePlan, TraceSnapshot, TraceStep, TraceTool, TraceTurn } from '../types'
import { onFirstAnchor } from './clock'
import { applyFileEdits, resetChains } from './files-hooks'
import type { PendingEdit } from './files-hooks'
import { applyCall, isPlanLive, isPlanTool, noticeOf, settleWorkflow } from './plan'
import {
  MAIN,
  MAX_AGENTS,
  MAX_TOOLS,
  MAX_TURNS,
  NOTE_KEEP,
  SAID_KEEP,
  THINK_KEEP,
  capSteps,
  checkedTool,
  excerpt,
  finishedTool,
  keepTail,
  loopOf,
  newStep,
  oneLine,
  originOf,
  promptedOf,
} from './trace'
import type { ToolOutcome } from './trace'

/** A plan tool's call, kept as it answered until the plans are worked. */
type PendingPlan = { loop: string; tool: string; toolUseId: string; input: unknown; result: unknown; at: number }
/** A forked skill's Skill call, waiting for its agent to be looked up. */
type PendingFork = { toolUseId: string; agentId: string; isBackground: boolean; commandName?: string; at: number }

export const mem = {
  steps: [] as TraceStep[],
  agents: [] as TraceAgent[],
  turns: [] as TraceTurn[],
  plans: [] as TracePlan[],
  files: [] as TraceFile[],
  /** When the main loop's compaction began, while it runs. */
  compactSince: null as number | null,
  cwd: '',
  isMainActive: false,
  /** Subagent loops the trace follows: spawned, or found among the session's agents. */
  known: new Set<string>(),
  /** Loops looked up once and not found: the engine's own forks (compaction, memory). */
  strangers: new Set<string>(),
  running: new Set<string>(),
  /** Loops seen but not yet looked up, with the prompt their run began with. */
  unresolved: new Map<string, string>(),
  forks: [] as PendingFork[],
  plansQueue: [] as PendingPlan[],
  editsQueue: [] as PendingEdit[],
  /** The texts of main turns not yet read for their prompt, origin and notice. */
  texts: new Map<string, string>(),
  /** Calls by id, so a hook finds its call without a search. */
  toolIndex: new Map<string, TraceTool>(),
  /** Bumped by every write; the timer saves and redraws when it moved. */
  rev: 0,
}

export const isLive = (): boolean => mem.isMainActive || mem.compactSince !== null || mem.running.size > 0

const touch = (): void => {
  mem.rev += 1
}

// ---- the hooks' writes: synchronous, a few property writes each ----

/** A main turn begins; a subagent's run begins or wakes again. */
export function noteTurnStart(e: { turnId: string; text: string; agentId?: string }, at: number): void {
  const agentId = e.agentId
  if (agentId !== undefined) {
    if (mem.strangers.has(agentId)) return
    if (!mem.known.has(agentId)) {
      mem.unresolved.set(agentId, e.text.length > 400 ? e.text.slice(0, 400) : e.text)
      touch()
      return
    }
    mem.running.add(agentId)
    const a = mem.agents.find(x => x.id === agentId)
    if (a !== undefined) {
      // Woken again (a message, a resume): it runs anew.
      delete a.endedAt
      delete a.outcome
      if (a.prompt === undefined && e.text !== '') a.prompt = oneLine(e.text.slice(0, 400), 160)
    }
    touch()
    return
  }
  mem.isMainActive = true
  // Read for its prompt and origin later: a pasted prompt can be long.
  mem.texts.set(e.turnId, e.text.length > 8000 ? e.text.slice(0, 8000) : e.text)
  const turn: TraceTurn = { turnId: e.turnId, prompt: '', startedAt: at, notes: [] }
  mem.turns = [...mem.turns.filter(t => t.turnId !== e.turnId), turn].slice(-MAX_TURNS)
  touch()
}

/** A model request of a loop the trace follows, or may follow; undefined for a loop it leaves out. */
export function openStep(
  e: { turnId: string; index: number; model: string; effort?: unknown; agentId?: string },
  at: number,
): TraceStep | undefined {
  const loop = loopOf(e.agentId)
  if (mem.strangers.has(loop)) return undefined
  if (loop === MAIN) mem.isMainActive = true
  else if (!mem.known.has(loop) && !mem.unresolved.has(loop)) mem.unresolved.set(loop, '')
  const effort = e.effort === undefined ? undefined : String(e.effort)
  const step = newStep(`${loop}:${e.turnId}:${e.index}`, loop, e.turnId, e.index, e.model, effort, at)
  step.thinkMs = 0
  step.writeMs = 0
  const i = mem.steps.findIndex(s => s.id === step.id)
  if (i >= 0) mem.steps[i] = step
  else mem.steps = capSteps([...mem.steps, step])
  touch()

  return step
}

/** The phase a step is in now: the time of the one it leaves is added to its sum. */
function enterPhase(s: TraceStep, phase: TraceStep['phase'], at: number): void {
  const spent = Math.max(0, at - s.phaseAt)
  if (s.phase === 'think') s.thinkMs = (s.thinkMs ?? 0) + spent
  else if (s.phase === 'write' || s.phase === 'input') s.writeMs = (s.writeMs ?? 0) + spent
  s.phase = phase
  s.phaseAt = at
}

/** One piece of a step's stream: strings and counters on the step, nothing else. */
export function noteChunk(
  s: TraceStep,
  chunk: { kind: string; text?: string; json?: string; id?: string; name?: string },
  at: number,
): void {
  if (s.firstAt === undefined) s.firstAt = at
  switch (chunk.kind) {
    case 'thinking': {
      const text = chunk.text ?? ''
      s.thinking = keepTail(s.thinking + text, THINK_KEEP * 2)
      s.thinkingChars += text.length
      if (s.phase !== 'think') enterPhase(s, 'think', at)
      break
    }
    case 'text': {
      if (s.said.length < SAID_KEEP) s.said += chunk.text ?? ''
      if (s.phase !== 'write') enterPhase(s, 'write', at)
      break
    }
    case 'tool': {
      enterPhase(s, 'input', at)
      const id = chunk.id ?? ''
      const name = chunk.name ?? ''
      s.inputTool = name
      s.inputChars = 0
      if (!mem.toolIndex.has(id)) {
        const tool: TraceTool = { id, name, summary: '', state: 'queued', queuedAt: at }
        s.tools.push(tool)
        if (s.tools.length > MAX_TOOLS) s.tools.shift()
        mem.toolIndex.set(id, tool)
      }
      break
    }
    case 'input':
      s.inputChars = (s.inputChars ?? 0) + (chunk.json ?? '').length
      break
    default:
      return
  }
  touch()
}

/** The step's response came whole: how it stopped, its size, and what each picked call was about. */
export function closeStep(
  s: TraceStep,
  r: { stopReason: string | null; usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number } | null; toolUses: readonly { name: string; input: unknown }[] },
  at: number,
): void {
  enterPhase(s, r.stopReason === null ? 'failed' : 'done', at)
  s.endedAt = at
  if (r.stopReason !== null) s.stop = r.stopReason
  if (r.usage !== null) {
    const u = r.usage
    s.contextTokens = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens
    s.outputTokens = u.output_tokens
  }
  s.tools.forEach((t, i) => {
    const use = r.toolUses[i]
    if (t.input === undefined && use !== undefined && use.name === t.name && use.input !== null && typeof use.input === 'object') {
      t.input = use.input as Record<string, unknown>
    }
  })
  touch()
}

/** The request was cut off (an interrupt, an error): it reads as failed rather than running. */
export function cutStep(s: TraceStep, at: number): void {
  if (s.phase === 'done' || s.phase === 'failed') return
  enterPhase(s, 'failed', at)
  s.endedAt = at
  touch()
}

function latestStepOf(loop: string): TraceStep | undefined {
  for (let i = mem.steps.length - 1; i >= 0; i -= 1) {
    const s = mem.steps[i]
    if (s !== undefined && s.loop === loop) return s
  }

  return undefined
}

/** The engine took a call up. */
export function noteToolStart(e: { tool: unknown; tool_use_id: string; agentId?: string }, at: number): void {
  const loop = loopOf(e.agentId)
  if (mem.strangers.has(loop)) return
  const name = String(e.tool)
  const input = e as unknown as Record<string, unknown>
  const known = mem.toolIndex.get(e.tool_use_id)
  if (known !== undefined) {
    known.name = name
    known.input = input
    if (known.state === 'queued') known.state = 'run'
    if (known.startedAt === undefined) known.startedAt = at
    touch()
    return
  }
  const tool: TraceTool = { id: e.tool_use_id, name, summary: '', state: 'run', queuedAt: at, startedAt: at, input }
  mem.toolIndex.set(tool.id, tool)
  const step = latestStepOf(loop)
  if (step !== undefined) {
    step.tools.push(tool)
    if (step.tools.length > MAX_TOOLS) step.tools.shift()
  } else {
    if (loop !== MAIN && !mem.known.has(loop)) mem.unresolved.set(loop, mem.unresolved.get(loop) ?? '')
    const orphan = newStep(`${loop}:early:${at}`, loop, '', -1, '', undefined, at)
    orphan.phase = 'done'
    orphan.endedAt = at
    orphan.tools = [tool]
    mem.steps = capSteps([...mem.steps, orphan])
  }
  touch()
}

const READS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'AskUserQuestion', 'Agent', 'Task', 'Skill', 'Workflow', 'SendMessage', 'LS'])

type Answer = { deny?: string; isError?: true; result?: unknown; text?: string; context?: readonly string[] }

/** The call answered: its outcome, and what it left for later work (a file change, a plan, a forked skill). */
export function noteToolEnd(e: { tool: unknown; tool_use_id: string; agentId?: string }, ran: Answer, at: number): void {
  const loop = loopOf(e.agentId)
  if (mem.strangers.has(loop)) return
  const name = String(e.tool)
  const id = e.tool_use_id
  const tool = mem.toolIndex.get(id)
  const outcome: ToolOutcome =
    ran.deny !== undefined
      ? { kind: 'deny', text: ran.deny }
      : ran.isError === true
        ? { kind: 'fail', text: ran.text ?? (typeof ran.result === 'string' ? ran.result : undefined) }
        : { kind: 'ok' }
  if (tool !== undefined) Object.assign(tool, finishedTool(tool, outcome, at))
  const result = ran.result
  const r = result !== null && typeof result === 'object' ? (result as Record<string, unknown>) : undefined
  if (tool !== undefined) {
    if (typeof r?.type === 'string') tool.resultType = r.type
    if (ran.context !== undefined && ran.context.length > 0) tool.hookContext = ran.context.length
  }
  if (ran.deny === undefined && ran.isError !== true) {
    if (name === 'Skill' && r?.status === 'forked' && typeof r.agentId === 'string') {
      const fork: PendingFork = { toolUseId: id, agentId: r.agentId, isBackground: r.background === true, at }
      if (typeof r.commandName === 'string') fork.commandName = r.commandName
      if (tool !== undefined) tool.resultType = 'forked'
      mem.forks.push(fork)
    }
    if (isPlanTool(name)) mem.plansQueue.push({ loop, tool: name, toolUseId: id, input: e, result, at })
    // What it changed on disk, as the tool reports it: worked out of the hook's way.
    if (!READS.has(name)) mem.editsQueue.push({ toolUseId: id, tool: name, result, loop, at })
  }
  touch()
}

export function noteCheck(toolUseId: string, v: { decision: string; reason?: string; rule?: string; hook?: string }): void {
  const tool = mem.toolIndex.get(toolUseId)
  if (tool === undefined) return
  Object.assign(tool, checkedTool(tool, v))
  touch()
}

/** The dialog went up: the person is the one the call waits on now. */
export function notePrompted(agentId: string | undefined, toolName: string, at: number): void {
  const tool = promptedOf(mem.steps, loopOf(agentId), toolName)
  if (tool === undefined) return
  tool.state = 'wait'
  tool.isPrompted = true
  tool.promptedAt = at
  touch()
}

/** Auto mode's classifier refused the call. */
export function noteAutoDenied(toolUseId: string, reason: string): void {
  const tool = mem.toolIndex.get(toolUseId)
  if (tool === undefined) return
  tool.state = 'deny'
  tool.note = oneLine(reason, NOTE_KEEP)
  tool.verdict = '자동 모드가 거부'
  touch()
}

/** The tool's own run time, the permission wait left out. */
export function noteRunTime(toolUseId: string, ms: number | undefined, failure?: { error?: string; isInterrupt?: boolean }): void {
  const tool = mem.toolIndex.get(toolUseId)
  if (tool === undefined) return
  if (ms !== undefined) tool.execMs = ms
  if (failure !== undefined) {
    const note = excerpt(failure.error)
    if (note !== undefined) tool.note = note
    if (failure.isInterrupt === true) tool.state = 'stop'
  }
  touch()
}

export function noteTurnNote(note: string): void {
  const last = mem.turns[mem.turns.length - 1]
  if (last === undefined) return
  last.notes = [...last.notes, note].slice(-8)
  touch()
}

export function noteCompactStart(trigger: string, at: number): void {
  mem.compactSince = at
  const last = mem.turns[mem.turns.length - 1]
  if (last !== undefined) last.compactions = [...(last.compactions ?? []), { startedAt: at, trigger }].slice(-4)
  touch()
}

export function noteCompactEnd(at: number): void {
  mem.compactSince = null
  const open = mem.turns[mem.turns.length - 1]?.compactions?.find(c => c.endedAt === undefined)
  if (open !== undefined) open.endedAt = at
  touch()
}

export function noteSpawn(
  e: { tool_use_id: string; subagentType: string; description: string; background: boolean; prompt: string; parentAgentId?: string; workflow?: { agentIndex: number } },
  agentId: string,
  model: string | undefined,
  at: number,
): void {
  mem.running.add(agentId)
  mem.known.add(agentId)
  mem.unresolved.delete(agentId)
  mem.strangers.delete(agentId)
  const agent: TraceAgent = {
    id: agentId,
    toolUseId: e.tool_use_id,
    type: e.subagentType,
    description: oneLine(e.description, 80),
    isBackground: e.background,
    startedAt: at,
  }
  if (model !== undefined) agent.model = model
  if (e.parentAgentId !== undefined) agent.parentId = e.parentAgentId
  agent.source = e.workflow === undefined ? 'agent' : 'workflow'
  if (e.workflow !== undefined) agent.workflowIndex = e.workflow.agentIndex
  if (e.prompt !== '') agent.prompt = oneLine(e.prompt.slice(0, 400), 160)
  mem.agents = [...mem.agents.filter(a => a.id !== agentId), agent].slice(-MAX_AGENTS)
  touch()
}

/** A loop's turn ended: what it left open closes. */
export function noteTurnEnd(e: { turnId: string; agentId?: string; reason: string; isAborted: boolean }, at: number): void {
  const agentId = e.agentId
  if (agentId === undefined) {
    mem.isMainActive = false
    const turn = mem.turns.find(t => t.turnId === e.turnId)
    if (turn !== undefined) {
      turn.endedAt = at
      turn.outcome = e.reason
    }
  } else {
    mem.running.delete(agentId)
    const a = mem.agents.find(x => x.id === agentId)
    if (a !== undefined) {
      a.endedAt = at
      a.outcome = e.reason === 'answer' ? 'done' : e.reason
    }
  }
  const loop = loopOf(agentId)
  for (const s of mem.steps) {
    if (s.loop !== loop) continue
    if (s.phase !== 'done' && s.phase !== 'failed') {
      enterPhase(s, e.isAborted ? 'failed' : 'done', at)
      s.endedAt = s.endedAt ?? at
    }
    for (const t of s.tools) {
      if (t.state === 'queued' || t.state === 'run' || t.state === 'ask' || t.state === 'wait') {
        t.state = 'stop'
        t.endedAt = t.endedAt ?? at
      }
    }
  }
  touch()
}

// ---- off the model's path: the queued work, worked when the timer runs or the pane draws ----

/** Works the queues: prompts and notices, plan calls, file changes. True when something changed. */
export function drain(): boolean {
  let changed = false
  for (const [turnId, text] of mem.texts) {
    const turn = mem.turns.find(t => t.turnId === turnId)
    if (turn !== undefined) {
      turn.prompt = oneLine(text, 160)
      const origin = originOf(text)
      if (origin !== undefined) turn.origin = origin
    }
    const notice = noticeOf(text)
    if (notice !== undefined) mem.plans = settleWorkflow(mem.plans, notice, turn?.startedAt ?? 0)
    changed = true
  }
  mem.texts.clear()
  if (mem.plansQueue.length > 0) {
    for (const c of mem.plansQueue) mem.plans = applyCall(mem.plans, c.loop, c.tool, c.toolUseId, c.input, c.result, c.at)
    mem.plansQueue = []
    changed = true
  }
  if (mem.editsQueue.length > 0) {
    const byOf = (loop: string): string => (loop === MAIN ? '메인' : (mem.agents.find(a => a.id === loop)?.type ?? '서브에이전트'))
    mem.files = applyFileEdits(mem.files, mem.editsQueue, byOf, mem.cwd)
    mem.editsQueue = []
    changed = true
  }
  trim()
  if (changed) touch()

  return changed
}

/** Inputs already cut to what the pane names calls by. */
const picked = new WeakSet<object>()

/**
 * Keeps memory bounded, off the model's path: a settled call keeps only the
 * input fields the pane names it by (a Write's whole content goes), and the
 * index lets go of calls whose step has left the list.
 */
function trim(): void {
  let held = 0
  for (const s of mem.steps) {
    for (const t of s.tools) {
      held += 1
      if (t.input === undefined || picked.has(t.input)) continue
      if (t.state === 'queued' || t.state === 'run' || t.state === 'ask' || t.state === 'wait') continue
      t.input = pickInput(t.input)
      picked.add(t.input)
    }
  }
  if (mem.toolIndex.size > held * 2 + 64) reindex()
}

/** What the session says of the loops seen: each found one followed, each one not found left out for good. */
export function resolveLoops(listed: readonly { id: string; type: string; description: string; parentId?: string }[], at: number): void {
  const byId = new Map(listed.map(a => [a.id, a]))
  for (const [id, prompt] of mem.unresolved) {
    const info = byId.get(id)
    if (info === undefined) {
      mem.strangers.add(id)
      mem.steps = mem.steps.filter(s => s.loop !== id)
      continue
    }
    mem.known.add(id)
    if (!mem.agents.some(a => a.id === id)) {
      const first = mem.steps.find(s => s.loop === id)
      const agent: TraceAgent = { id, toolUseId: '', type: info.type, description: oneLine(info.description, 80), isBackground: false, startedAt: first?.startedAt ?? at }
      if (info.parentId !== undefined) agent.parentId = info.parentId
      if (prompt !== '') agent.prompt = oneLine(prompt, 160)
      mem.agents = [...mem.agents, agent].slice(-MAX_AGENTS)
    }
    const a = mem.agents.find(x => x.id === id)
    if (a !== undefined && a.endedAt === undefined) mem.running.add(id)
  }
  mem.unresolved.clear()
  for (const f of mem.forks) {
    const info = byId.get(f.agentId)
    mem.known.add(f.agentId)
    mem.strangers.delete(f.agentId)
    const linked = (a: TraceAgent): TraceAgent => {
      const next: TraceAgent = { ...a, toolUseId: f.toolUseId, isBackground: f.isBackground, source: 'skill' }
      if (next.parentId === undefined && info?.parentId !== undefined) next.parentId = info.parentId
      // A skill forked in the foreground has finished by the time its call answers.
      if (!f.isBackground && next.endedAt === undefined) {
        next.endedAt = f.at
        next.outcome = next.outcome ?? 'done'
      }
      return next
    }
    if (mem.agents.some(a => a.id === f.agentId)) {
      mem.agents = mem.agents.map(a => (a.id === f.agentId ? linked(a) : a))
    } else {
      const type = info?.type ?? (f.commandName !== undefined ? `/${f.commandName}` : 'skill')
      const agent = linked({ id: f.agentId, toolUseId: f.toolUseId, type, description: oneLine(info?.description ?? '', 80), isBackground: f.isBackground, startedAt: f.at })
      mem.agents = [...mem.agents, agent].slice(-MAX_AGENTS)
    }
    if (f.isBackground && mem.agents.find(a => a.id === f.agentId)?.endedAt === undefined) mem.running.add(f.agentId)
    else mem.running.delete(f.agentId)
  }
  mem.forks = []
  touch()
}

export const needsLookup = (): boolean => mem.unresolved.size > 0 || mem.forks.length > 0

// ---- clearing ----

const isLiveStep = (s: TraceStep): boolean =>
  (s.phase !== 'done' && s.phase !== 'failed') ||
  s.tools.some(t => t.state === 'queued' || t.state === 'run' || t.state === 'ask' || t.state === 'wait')

/** 지우기 and `/trace clear`: what is over leaves, what still runs stays. */
export function clearDone(): void {
  drain()
  mem.steps = mem.steps.filter(isLiveStep)
  mem.agents = mem.agents.filter(a => a.endedAt === undefined)
  mem.turns = mem.turns.slice(-1).map(t => ({ ...t, notes: [] }))
  mem.plans = mem.plans.filter(isPlanLive)
  mem.files = []
  resetChains()
  reindex()
  touch()
}

/** `/clear`: the host empties the state, and the module's memory goes with it. */
export function clearAll(): void {
  mem.steps = []
  mem.agents = []
  mem.turns = []
  mem.plans = []
  mem.files = []
  mem.compactSince = null
  mem.isMainActive = false
  mem.known.clear()
  mem.strangers.clear()
  mem.running.clear()
  mem.unresolved.clear()
  mem.forks = []
  mem.plansQueue = []
  mem.editsQueue = []
  mem.texts.clear()
  mem.toolIndex.clear()
  resetChains()
  touch()
}

function reindex(): void {
  mem.toolIndex.clear()
  for (const s of mem.steps) for (const t of s.tools) mem.toolIndex.set(t.id, t)
}

// ---- the saved copy ----

const INPUT_KEYS = [
  'command', 'description', 'file_path', 'notebook_path', 'offset', 'limit', 'pattern', 'path', 'glob', 'url', 'query',
  'subagent_type', 'skill', 'args', 'name', 'questions', 'server_name', 'old_string',
]

/** The fields of a call's input the pane names it by, each cut short: the rest stays out of the saved copy. */
export function pickInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const k of INPUT_KEYS) {
    const v = input[k]
    if (v === undefined) continue
    if (typeof v === 'string') out[k] = k === 'old_string' ? '' : v.length > 600 ? v.slice(0, 600) : v
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (k === 'questions' && Array.isArray(v)) {
      const q = (v[0] as { question?: unknown } | undefined)?.question
      out[k] = typeof q === 'string' ? [{ question: q.slice(0, 200) }] : []
    }
  }
  const tool = input.tool
  if (typeof tool === 'string') out.tool = tool
  const script = input.script
  if (typeof script === 'string') {
    const name = /name\s*:\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(script)?.[2]
    if (name !== undefined) out.name = name
  }

  return out
}

export function snapshot(): TraceSnapshot {
  drain()
  return {
    steps: mem.steps.map(s => ({ ...s, tools: s.tools.map(t => (t.input === undefined ? { ...t } : { ...t, input: pickInput(t.input) })) })),
    agents: mem.agents,
    turns: mem.turns,
    plans: mem.plans,
    files: mem.files,
  }
}

/** A reload's start: the saved copy comes back, unless this load has already traced something. */
export function hydrate(snap: TraceSnapshot | null): boolean {
  if (snap === null || mem.steps.length > 0 || mem.turns.length > 0) return false
  mem.steps = snap.steps
  mem.agents = snap.agents
  mem.turns = snap.turns
  mem.plans = snap.plans
  mem.files = snap.files
  for (const a of mem.agents) mem.known.add(a.id)
  reindex()
  touch()

  return true
}

// ---- the stamps taken before the host's time was first read ----

const TIME_KEYS = new Set(['startedAt', 'endedAt', 'phaseAt', 'firstAt', 'queuedAt', 'promptedAt', 'updatedAt', 'at', 'lastAt'])

function shift(o: unknown, delta: number): void {
  if (Array.isArray(o)) {
    for (const x of o) shift(x, delta)
    return
  }
  if (o === null || typeof o !== 'object') return
  const r = o as Record<string, unknown>
  for (const k of Object.keys(r)) {
    if (k === 'input' || k === 'result') continue
    const v = r[k]
    if (TIME_KEYS.has(k) && typeof v === 'number') r[k] = v + delta
    else if (v !== null && typeof v === 'object') shift(v, delta)
  }
}

onFirstAnchor(delta => {
  shift([mem.steps, mem.agents, mem.turns, mem.plans, mem.files, mem.forks, mem.plansQueue, mem.editsQueue], delta)
  if (mem.compactSince !== null) mem.compactSince += delta
})
