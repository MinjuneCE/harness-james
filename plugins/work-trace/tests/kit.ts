// What the tests share: the engine beneath the plugin, scripted (the model,
// the tools, the dialogs), and the reads of a step's stream.
import { expect } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnStepChunk, TurnStepResult } from 'claude-code'

export const SURFACES = ['terminal', 'desktop'] as const

export const PANE = {
  plugin: 'work-trace',
  component: 'Pane',
  requestId: 'work-trace',
  props: {
    title: '작업 추적',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 60 },
    view: {},
  },
} as const

export const USAGE = {
  input_tokens: 12,
  output_tokens: 80,
  cache_read_input_tokens: 40_000,
  cache_creation_input_tokens: 1_000,
  model: 'claude-opus-5-5',
}

/** The session's folder and home in the tests, so paths read the same everywhere. */
export const HOME = '/Users/me'
export const CWD = `${HOME}/repo`

/** One scripted model response: its pieces, then its result. */
export type Script = { chunks: TurnStepChunk[]; uses: { name: string; input: unknown }[]; answer: string; isEndless?: true }

export type Verdict = { decision: 'allow' | 'ask' | 'deny'; reason?: string; rule?: string; hook?: string }
export type Beneath = {
  /** A tool's error text, or undefined for a call that answers. */
  fail?: (name: string, id: string) => string | undefined
  /** Holds a tool's answer until the promise settles. */
  hold?: (name: string) => Promise<void> | undefined
  check?: (name: string) => Verdict
  /** A tool's own result for a call that answers; `{ ok: true }` when absent. */
  answer?: (name: string, id: string) => unknown
  /** Told when the reader closed a response before it finished. */
  onClosedEarly?: () => void
  /** The session's folder; `CWD` when absent. */
  cwd?: string
}

/** What the engine does beneath the plugin, scripted: the model, the tools, the dialogs. */
export function engine(on: On, scripts: Script[], beneath: Beneath = {}) {
  let step = 0
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e) {
    const script = scripts[Math.min(step, scripts.length - 1)]
    step += 1
    if (script === undefined) return
    let isFinished = false
    try {
      for (const chunk of script.chunks) yield chunk
      while (script.isEndless === true) yield { kind: 'thinking', index: 0, text: '…' }
      isFinished = true
    } finally {
      if (!isFinished) beneath.onClosedEarly?.()
    }
    const result: TurnStepResult = {
      turnId: e.turnId,
      index: e.index,
      answer: script.answer,
      toolUses: script.uses,
      stopReason: script.uses.length > 0 ? 'tool_use' : 'end_turn',
      usage: USAGE,
    }

    return result
  })
  on('tool.call', async ($, e) => {
    await beneath.hold?.(String(e.tool))
    const failed = beneath.fail?.(String(e.tool), e.tool_use_id)
    return failed === undefined
      ? { result: beneath.answer?.(String(e.tool), e.tool_use_id) ?? { ok: true } }
      : { isError: true as const, result: failed, text: failed }
  })
  on('tool.check', ($, e) => beneath.check?.(e.tool) ?? { decision: 'allow', rule: 'Bash(npm test:*)' })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.cwd', () => ({ value: beneath.cwd ?? CWD }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionRequest', () => ({}))
  on('classic.PermissionDenied', () => ({}))
}

/** Reads a step's stream to its end, as the query loop does: the response is the iterator's last value. */
export async function drain<C, R>(stream: AsyncGenerator<C, R>): Promise<{ chunks: C[]; response: R }> {
  const chunks: C[] = []
  for (;;) {
    const piece = await stream.next()
    if (piece.done === true) return { chunks, response: piece.value }
    chunks.push(piece.value)
  }
}

export async function runStep($: Engine, turnId: string, index: number, agentId?: string): Promise<void> {
  const input =
    agentId === undefined
      ? { turnId, index, model: 'claude-opus-5-5', effort: 'max' as const, messageCount: 3 + index }
      : { turnId, index, model: 'claude-opus-5-5', effort: 'max' as const, messageCount: 3 + index, agentId }
  const { response } = await drain($.turn.step(input))
  expect(response, 'the response reaches the loop through the plugin').toMatchObject({ turnId, index })
}

/** Every line of text a mounted drawing holds, for a failure's message. */
export async function textOf(ui: { findAll: (q: { type: 'Text' }) => Promise<{ text: string }[]> }): Promise<string> {
  return (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => t.trim() !== '').join('\n')
}

/** A tool call the way the model streams it: the call's start and its input. */
export const toolChunk = (index: number, id: string, name: string): TurnStepChunk => ({ kind: 'tool', index, id, name })
