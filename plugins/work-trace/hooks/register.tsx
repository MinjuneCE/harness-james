// work-trace: a pane beside the transcript that tells the turn as a story:
// what the model does now, which tools it used on which files, where its time
// went, the harness it touched, and where it got stuck, with the harness piece
// (a skill, a hook, a rule, a document) that could fix each place.
//
// The model never waits on the trace. A hook writes what it saw into the
// module's memory with synchronous code and hands the event on; the only thing
// a hook awaits is `next(e)`, the engine's own work. The pane is redrawn and
// the trace saved for a reload by a timer of the module's own, off the model's
// path, and everything the pane shows is worked out while it draws.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnStepResult } from 'claude-code'

import type { TraceStep } from '../types'
import { anchor, stamp } from './clock'
import { renderAgentSection } from './agents-view'
import { filesOfLoop } from './files'
import { clearFileToggles, readFileToggles, toggleNetFile, toggleOpenFile } from './files-hooks'
import { renderFiles } from './files-view'
import { homeOf } from './flow'
import {
  clearAll,
  clearDone,
  closeStep,
  cutStep,
  drain,
  hydrate,
  isLive,
  mem,
  needsLookup,
  noteAutoDenied,
  noteCheck,
  noteChunk,
  noteCompactEnd,
  noteCompactStart,
  notePrompted,
  noteRunTime,
  noteSpawn,
  noteToolEnd,
  noteToolStart,
  noteTurnEnd,
  noteTurnNote,
  noteTurnStart,
  openStep,
  resolveLoops,
  snapshot,
} from './store'
import { MAIN, oneLine } from './trace'
import { renderPane } from './view'

const PANE = 'work-trace'
const TITLE = '작업 추적'

const saved = atom({ plugin: 'work-trace', key: 'snapshot' } as const, null, { shape: 'v2' })
const isExpanded = atom({ plugin: 'work-trace', key: 'isExpanded' } as const, false)
const agentFold = atom({ plugin: 'work-trace', key: 'agentFold' } as const, {})

/** How soon a change is drawn, how often running clocks move, and how often the trace is saved for a reload. */
export const REDRAW_MS = 300
export const LIVE_MS = 1000
export const SAVE_MS = 3000

const timer = { isArmed: false, armedAt: 0, drawnRev: -1, savedRev: 0, savedAt: 0 }

/** A write the trace can lose without harm: it never fails the hook it rides. */
function quiet(write: () => void): void {
  try {
    write()
  } catch {
    // the trace misses one beat; the session goes on
  }
}

/**
 * Asks for the timer's next beat and returns at once: the hook that asks never
 * waits on it. A beat left unanswered (its dispatch refused) is asked again.
 */
function kick($: EngineInterface, ms = REDRAW_MS): void {
  const at = stamp()
  if (timer.isArmed && at - timer.armedAt < LIVE_MS * 5) return
  timer.isArmed = true
  timer.armedAt = at
  try {
    $.clock.after(ms, () => void beat($))
  } catch {
    timer.isArmed = false
  }
}

/** The timer's beat: the host's time read, the queues worked, the pane redrawn, the trace saved now and then. */
async function beat($: EngineInterface): Promise<void> {
  timer.isArmed = false
  try {
    anchor(await $.clock.now())
    drain()
    if (needsLookup()) resolveLoops(await $.agent.list(), stamp())
    const live = isLive()
    if (mem.rev !== timer.drawnRev || live) {
      timer.drawnRev = mem.rev
      $.ui.invalidate('ui.render')
    }
    const at = stamp()
    if (mem.rev !== timer.savedRev && (!live || at - timer.savedAt >= SAVE_MS)) {
      timer.savedRev = mem.rev
      timer.savedAt = at
      const snap = snapshot()
      await update($, saved, () => snap)
    }
  } catch {
    // a missed beat; the next one catches up
  }
  if (isLive()) kick($, LIVE_MS)
  else if (mem.rev !== timer.savedRev) kick($, SAVE_MS)
}

/** After a reload: the trace saved before it comes back, unless this load has traced something already. */
async function restore($: EngineInterface): Promise<void> {
  try {
    const snap = await read($, saved)
    if (hydrate(snap)) {
      timer.savedRev = mem.rev
      $.ui.invalidate('ui.render')
    }
  } catch {
    // nothing to bring back
  }
}

async function clearTrace($: EngineInterface): Promise<void> {
  clearDone()
  await update($, agentFold, () => ({}))
  await clearFileToggles($)
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  on('session.start', ($, e, next) => {
    $.command
      .register({
        name: 'trace',
        description: '작업 추적 패널 열기/닫기 (흐름 · 참고한 파일 · 시간 · 하네스 · 막힌 곳). /trace clear 로 기록 지우기',
        argumentHint: '[clear]',
        immediate: true,
      })
      .catch(() => {})
    $.session
      .cwd()
      .then(cwd => {
        mem.cwd = cwd
      })
      .catch(() => {})
    void restore($)
    $.ui.open({ id: PANE, title: TITLE }).catch(() => {})
    kick($)

    return next(e)
  })

  // /clear: the host empties the state, and the module's memory goes with it.
  on('classic.SessionStart', ($, e, next) => {
    if (e.source === 'clear') quiet(clearAll)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.end', ($, e, next) => {
    if (e.reason === 'clear') quiet(clearAll)
    return next(e)
  })

  on('command.run', { command: 'trace' }, async ($, e) => {
    if (e.args.trim() === 'clear') {
      await clearTrace($)
      $.ui.toast('작업 추적 기록을 지웠어요.')

      return {}
    }
    const pane = (await $.ui.panes()).find(p => p.id === PANE)
    if (pane !== undefined && pane.isPlaced && pane.isShown) {
      await $.ui.close({ id: PANE })

      return {}
    }
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    if (!opened.isPlaced) $.ui.toast(`작업 추적: ${opened.reason}`)

    return {}
  })

  on('turn.start', ($, e, next) => {
    quiet(() => noteTurnStart(e, stamp()))
    kick($)

    return next(e)
  })

  // Each model request: its stream goes by untouched and at once; each piece
  // only moves a few strings and counters on the step.
  on('turn.step', async function* ($, e, next) {
    let step: TraceStep | undefined
    quiet(() => {
      step = openStep(e, stamp())
    })
    kick($)
    const s = step
    if (s === undefined) return yield* next(e)

    // Read by hand rather than with for-await: the response itself arrives as
    // the iterator's last value, and this hook hands it on as its own.
    const stream = next(e)
    let isDrained = false
    try {
      for (;;) {
        const piece = await stream.next()
        if (piece.done === true) {
          isDrained = true
          const response: TurnStepResult = piece.value ?? (await stream.result)
          quiet(() => closeStep(s, response, stamp()))
          kick($)

          return response
        }
        const chunk = piece.value
        quiet(() => noteChunk(s, chunk, stamp()))
        yield chunk
      }
    } finally {
      if (!isDrained) {
        // Closed early (an interrupt): close the request beneath too, as for-await would.
        try {
          await stream.return(undefined as never)
        } catch {
          // already closed
        }
      }
      // Cut off (an interrupt, an error): it reads as failed rather than running.
      quiet(() => cutStep(s, stamp()))
    }
  })

  on('tool.call', async ($, e, next) => {
    quiet(() => noteToolStart(e, stamp()))
    kick($)
    const ran = await next(e)
    quiet(() => noteToolEnd(e, ran, stamp()))
    kick($)

    return ran
  }).catch(($, e, next) => next(e))

  // The permission verdict for a real call: allowed by which rule or hook, or put to a decider.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const toolId = e.tool_use_id
    if (toolId !== undefined) quiet(() => noteCheck(toolId, verdict))

    return verdict
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.deny === undefined ? spawned.agentId : undefined
    if (agentId !== undefined) quiet(() => noteSpawn(e, agentId, spawned.model, stamp()))
    kick($)

    return spawned
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    quiet(() => noteTurnEnd(e, stamp()))
    kick($)

    return answered
  })

  // The dialog went up: the person is the one the call waits on now.
  on('classic.PermissionRequest', ($, e, next) => {
    quiet(() => notePrompted(e.agent_id, e.tool_name, stamp()))
    kick($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Auto mode's classifier refused the call.
  on('classic.PermissionDenied', ($, e, next) => {
    quiet(() => noteAutoDenied(e.tool_use_id, e.reason))
    kick($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // The tool's own run time, the permission wait left out.
  on('classic.PostToolUse', ($, e, next) => {
    quiet(() => noteRunTime(e.tool_use_id, e.duration_ms))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', ($, e, next) => {
    quiet(() => {
      const failure: { error?: string; isInterrupt?: boolean } = { error: e.error }
      if (e.is_interrupt === true) failure.isInterrupt = true
      noteRunTime(e.tool_use_id, e.duration_ms, failure)
    })

    return next(e)
  }).catch(($, e, next) => next(e))

  on('classic.StopFailure', ($, e, next) => {
    quiet(() => {
      const details = e.error_details === undefined ? '' : ` — ${e.error_details}`
      noteTurnNote(`API 오류로 멈춤: ${oneLine(`${e.error}${details}`, 160)}`)
    })
    kick($)

    return next(e)
  }).catch(($, e, next) => next(e))

  // Compaction can hold a turn for a minute or more: timed in the open.
  on('session.compact', async ($, e, next) => {
    const isMainLoop = e.agentId === undefined && e.trigger !== 'precompute'
    if (isMainLoop) quiet(() => noteCompactStart(e.trigger, stamp()))
    kick($)
    try {
      return await next(e)
    } finally {
      if (isMainLoop) quiet(() => noteCompactEnd(stamp()))
      kick($)
    }
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const [expanded, fold, toggles, wall] = await Promise.all([read($, isExpanded), read($, agentFold), readFileToggles($), $.clock.now()])
    anchor(wall)
    drain()
    if (needsLookup()) {
      try {
        resolveLoops(await $.agent.list(), stamp())
      } catch {
        // looked up on the next beat
      }
    }
    if (mem.cwd === '') {
      try {
        mem.cwd = await $.session.cwd()
      } catch {
        // paths stay as given
      }
    }
    const now = stamp()
    const where = { cwd: mem.cwd, home: homeOf(mem.cwd) }
    const isDocked = e.props.placement === 'dock'
    const viewAgentId = e.props.view.agentId
    const traced = mem.steps.filter(s => s.loop === MAIN || mem.known.has(s.loop))
    // The main view gathers the subagents; an agent's own view is its trace alone.
    const agentSection =
      viewAgentId === undefined
        ? renderAgentSection(
            { Box, Text, Button },
            { agents: mem.agents, steps: traced, turns: mem.turns, now, isExpanded: expanded, isDocked, fold, where },
            { toggleAgent: (id, open) => void update($, agentFold, map => ({ ...map, [id]: open })) },
          )
        : null
    const filesPart = renderFiles(
      { Box, Text, Button, Code },
      {
        files: viewAgentId === undefined ? mem.files : filesOfLoop(mem.files, viewAgentId),
        openFiles: toggles.openFiles,
        netFiles: toggles.netFiles,
        now,
        isDocked,
        isExpanded: expanded,
        columns: e.props.bodyColumns,
      },
      {
        toggleOpen: path => void toggleOpenFile($, path),
        toggleNet: path => void toggleNetFile($, path),
      },
    )

    return renderPane(
      { Box, Text, Button },
      {
        steps: traced,
        agents: mem.agents,
        turns: mem.turns,
        plans: mem.plans,
        files: mem.files,
        compactSince: mem.compactSince,
        now,
        isExpanded: expanded,
        viewAgentId,
        isDocked,
        columns: e.props.bodyColumns,
        rows: e.props.scroll.bodyRows,
        where,
        isLive: viewAgentId === undefined ? mem.isMainActive || mem.compactSince !== null : mem.running.has(viewAgentId),
        agentSection,
        filesPart,
      },
      {
        toggleExpanded: () => void update($, isExpanded, value => !value),
        clear: () => void clearTrace($),
      },
    )
  })
}
