/** Where one tool call stands: picked by the model, running, held for approval, or settled. */
export type TraceToolState = 'queued' | 'run' | 'ask' | 'wait' | 'ok' | 'fail' | 'deny' | 'stop'

/** One tool call the model chose in a step. */
export type TraceTool = {
  /** The call's tool_use_id. */
  id: string
  name: string
  /** The call's key argument on one line (the command, the path, the pattern). */
  summary: string
  state: TraceToolState
  /** When the model's response named the call. */
  queuedAt: number
  /** When the engine took the call up (`tool.call`). */
  startedAt?: number
  endedAt?: number
  /** `tool.check` answered `ask`: the mode's decider (auto-mode classifier or the dialog) settled it. */
  isAsked?: boolean
  /** The permission dialog was put to the person (`PermissionRequest`). */
  isPrompted?: boolean
  promptedAt?: number
  /** The tool's own run time, the permission wait left out (`PostToolUse` `duration_ms`). */
  execMs?: number
  /** How the call was let through or refused: the rule, hook or reason behind the verdict. */
  verdict?: string
  /** `tool.check`'s verdict as it came: the decision and who reached it (a rule, a classic hook). */
  check?: TraceCheck
  /** An error or refusal, cut to one line. */
  note?: string
  /**
   * The call's input as the engine raised it. In the module's memory, the event itself;
   * in the saved snapshot, only the fields the pane names calls by.
   */
  input?: Record<string, unknown>
  /** A word from the tool's result the pane needs: a Write's `create` or `update`, a forked skill's `forked`. */
  resultType?: string
  /** Reminders a PostToolUse hook added to the result (`context`). */
  hookContext?: number
}

/** `tool.check`'s verdict, raw. */
export type TraceCheck = {
  decision: string
  rule?: string
  /** The classic hook event that decided (`PreToolUse`). */
  hook?: string
  reason?: string
}

/** What a model request is doing right now. */
export type TracePhase = 'request' | 'think' | 'write' | 'input' | 'done' | 'failed'

/** One model request of a loop (`turn.step`): what it thought, said and picked. */
export type TraceStep = {
  /** `<loop>:<turnId>:<index>`. */
  id: string
  /** `main`, or the subagent's id. */
  loop: string
  turnId: string
  index: number
  model: string
  effort?: string
  startedAt: number
  /** The first streamed piece of the response. */
  firstAt?: number
  endedAt?: number
  phase: TracePhase
  phaseAt: number
  /** The tool whose input the model is writing, while `phase` is `input`. */
  inputTool?: string
  inputChars?: number
  /** The end of the model's thinking (where it settles what to do). */
  thinking: string
  thinkingChars: number
  /** The start of the visible text of the response. */
  said: string
  /** Time spent thinking, and writing (text or a tool's input), summed over the phases that ended. */
  thinkMs?: number
  writeMs?: number
  stop?: string
  /** Tokens the request was answered over (the context's size then). */
  contextTokens?: number
  outputTokens?: number
  tools: TraceTool[]
}

/** A subagent the Agent tool started, or a forked skill the session runs as an agent. */
export type TraceAgent = {
  id: string
  /** The call that started it (Agent, Workflow or Skill); '' until that call is known. */
  toolUseId: string
  type: string
  description: string
  /** The task its first run began with, on one line. */
  prompt?: string
  model?: string
  isBackground: boolean
  startedAt: number
  endedAt?: number
  outcome?: string
  /** The agent whose loop started it (`agent.spawn`'s `parentAgentId`, the list's `parentId`); absent for main. */
  parentId?: string
  /** What started it: the Agent tool, a workflow script's `agent()`, or a forked skill. */
  source?: 'agent' | 'workflow' | 'skill'
  /** A workflow agent's place among its run's `agent()` calls, from 1. */
  workflowIndex?: number
}

/** Who started a main turn when the person did not: an agent's message, or a task notification. */
export type TraceTurnOrigin =
  | {
      kind: 'agent'
      /** The agent the message came from. */
      agentId: string
      /** A subagent's final report handed back, rather than a message mid-run. */
      isHandback: boolean
      /** The report or message itself, on one line. */
      text: string
    }
  | { kind: 'notice'; text: string }

/** One turn of the main conversation. */
export type TraceTurn = {
  turnId: string
  prompt: string
  /** Absent when the person's prompt started the turn. */
  origin?: TraceTurnOrigin
  startedAt: number
  endedAt?: number
  outcome?: string
  /** What happened to the turn as a whole: an API failure, a compaction. */
  notes: string[]
  /** The compactions that held the turn. */
  compactions?: { startedAt: number; endedAt?: number; trigger: string }[]
}

/** What the pane keeps across a reload: the module's memory as it last saved it. */
export type TraceSnapshot = {
  steps: TraceStep[]
  agents: TraceAgent[]
  turns: TraceTurn[]
  plans: TracePlan[]
  files: TraceFile[]
}

/** One edit the session made to a file: an Edit, a Write, a notebook cell, or what a Bash command changed. */
export type TraceFileEdit = {
  toolUseId: string
  /** The tool that made it: Edit, Write, NotebookEdit, Bash. */
  tool: string
  at: number
  /** `main`, or the subagent's id. */
  loop: string
  /** Who made it, as the pane names them: 메인, or the agent's type. */
  by: string
  kind: 'create' | 'update' | 'delete'
  added: number
  removed: number
  /** Unified-diff hunks of this edit alone; '' when the tool gave none. */
  patch: string
  /** The hunks were cut to the trace's size limit. */
  isCut?: boolean
  /** Held for review: the file is unchanged. */
  isStaged?: boolean
  /** The person changed the proposed edit in the dialog. */
  isUserModified?: boolean
  /** A word on the edit: the notebook cell, why the patch is missing. */
  note?: string
}

/** One file the session changed, and the edits that changed it, oldest first. */
export type TraceFile = {
  path: string
  /** The path as the pane shows it: under the session's cwd, relative. */
  shown: string
  firstAt: number
  lastAt: number
  /** Every applied edit, the ones dropped past the limit included. */
  editCount: number
  stagedCount: number
  /** Lines added and removed, summed over the applied edits (the row shows `net`'s when known). */
  added: number
  removed: number
  isCreated: boolean
  isDeleted: boolean
  /** Who changed it, in the order they first did. */
  by: string[]
  /** The newest edits, oldest first. */
  edits: TraceFileEdit[]
  /** The whole session's change as one diff, when the edits chain without the disk; else why not. */
  net: { patch: string; added: number; removed: number; isCut?: boolean } | { reason: string }
}

/** Where one item of a plan stands. */
export type TracePlanItemStatus = 'pending' | 'active' | 'done'

/** One item of a plan: a todo, a task, a step of an approved plan, a workflow phase. */
export type TracePlanItem = {
  /** The todo's place, the task's id, the step's place, the phase's title. */
  key: string
  text: string
  /** What a todo or task says while it is under way (`activeForm`), when it says. */
  activeText?: string
  status: TracePlanItemStatus
}

/** Where a plan came from. */
export type TracePlanSource = 'todo' | 'task' | 'plan' | 'workflow'

/** A plan or task list the session's own calls set out, as its latest call left it. */
export type TracePlan = {
  /** `<source>:<loop>`, or `workflow:<tool_use_id>` for one workflow run. */
  id: string
  source: TracePlanSource
  /** `main`, or the subagent whose calls made it. */
  loop: string
  title: string
  items: TracePlanItem[]
  /** False when nothing says how far each item got (an approved plan, a running workflow's phases). */
  hasStatus: boolean
  /** A workflow run's or a plan's own standing, when the plan has one as a whole. */
  state?: 'run' | 'done' | 'fail' | 'stop'
  /** The call that made it: a workflow run's agents carry it. */
  toolUseId?: string
  /** A workflow run's background task, which its completion notice names. */
  taskId?: string
  updatedAt: number
}

declare module 'claude-code' {
  interface PluginState {
    'work-trace': {
      // The trace lives in the module's memory; this copy, saved off the model's path a few
      // times a minute while it changes, carries it over a reload. Under a shape tag: a reload
      // whose code names another tag starts empty.
      snapshot: Shaped<TraceSnapshot | null>
      /** The files whose diff is open, and those of them showing the net diff. */
      openFiles: string[]
      netFiles: string[]
      isExpanded: boolean
      /** Subagent cards the person opened (true) or closed (false) by hand; absent ones follow the default. */
      agentFold: Record<string, boolean>
    }
  }
}
