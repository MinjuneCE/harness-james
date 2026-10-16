// context-band: one line above the prompt with what the status line knows
// about the session (how full the context window is, how far auto-compaction
// is, which memory files ride along, cost, rate limits), and on demand the
// window broken down as /context breaks it down.
//
// The model never waits on the band: no hook awaits a reading. A hook starts
// one and hands the event on; the reading lands in the state when it comes,
// and the band redraws from there.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import type { BandSnapshot } from '../types'
import { bar, cells, detailLines, fitPieces, pieces, toneOfFill } from './band'

const snapshot = atom({ plugin: 'context-band', key: 'snapshot' } as const, null, { shape: 'v1' })
const isExpanded = atom({ plugin: 'context-band', key: 'isExpanded' } as const, false)

const BAR = 12
const LABEL = '컨텍스트 '

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Reads the status line's figures; with `withBreakdown`, the window by category too (estimated locally, no requests). */
async function refresh($: EngineInterface, withBreakdown: boolean): Promise<void> {
  const [usage, model, now] = await Promise.all([
    withBreakdown ? $.session.usage({ breakdown: 'summary' }) : $.session.usage(),
    $.session.model(),
    $.clock.now(),
  ])
  const b = usage.context.breakdown
  await update($, snapshot, prev => {
    const next: BandSnapshot = {
      at: now,
      model,
      startedAt: usage.startedAt,
      window: usage.context.window,
      parts: b === undefined ? (prev?.parts ?? []) : b.categories.map(c => ({ name: c.name, tokens: c.tokens, kind: c.kind })),
      memory:
        b === undefined
          ? (prev?.memory ?? [])
          : b.memoryFiles.map(m => ({ name: basename(m.path), type: m.type, tokens: m.tokens })),
      limits: usage.rateLimits.map(l =>
        l.resetsAt === undefined
          ? { kind: l.kind, percentUsed: l.percentUsed }
          : { kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt },
      ),
    }
    if (usage.context.tokens !== undefined) next.tokens = usage.context.tokens
    if (usage.context.percent !== undefined) next.percent = usage.context.percent
    const compactAt =
      b === undefined ? prev?.compactAt : b.isAutoCompactEnabled ? b.autoCompactThreshold : undefined
    if (compactAt !== undefined) next.compactAt = compactAt
    const estimate = b === undefined ? prev?.estimate : b.totalTokens
    if (estimate !== undefined) next.estimate = estimate
    if (usage.cost !== undefined) next.costUsd = usage.cost.usd
    const keptEffort = effort ?? prev?.effort
    if (keptEffort !== undefined) next.effort = keptEffort

    return next
  })
}

async function quietly(work: () => Promise<unknown>): Promise<void> {
  try {
    await work()
  } catch {
    // a missed refresh; the next one catches up
  }
}

/** When the figures were last read; the module's own, so a reload reads them again soon. */
let lastAt = 0
/** The main loop's effort as its latest request named it: noted in the hook, drawn and saved off its path. */
let effort: string | undefined
/** A reading under way: a hook that asks for another while one runs folds into it. */
let reading: Promise<void> | undefined

async function measure($: EngineInterface, withBreakdown: boolean): Promise<void> {
  await quietly(async () => {
    await refresh($, withBreakdown)
    lastAt = await $.clock.now()
  })
}

/** Starts a reading and returns at once: the hook that asks never waits on it. */
function remeasure($: EngineInterface, withBreakdown: boolean): void {
  if (reading !== undefined && !withBreakdown) return
  const run = (reading ?? Promise.resolve()).then(() => measure($, withBreakdown))
  reading = run
  void run.finally(() => {
    if (reading === run) reading = undefined
  })
}

export const register: Register = on => {
  let isWorking = false
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    remeasure($, true)
    ticker?.cancel()
    // Every few seconds while a turn runs (the window grows with each response),
    // once a minute otherwise (the session's age, the limits).
    ticker = $.clock.every(5000, () => {
      void quietly(async () => {
        const now = await $.clock.now()
        if (isWorking || now - lastAt >= 60_000) await measure($, false)
      })
    })

    return started
  })

  on('turn.start', ($, e, next) => {
    isWorking = true

    return next(e)
  })

  // The status line knows no effort; each main-loop model request carries it.
  // Noted here and handed on at once; a change only asks the band to redraw.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined && e.effort !== undefined && String(e.effort) !== effort) {
      effort = String(e.effort)
      try {
        $.ui.invalidate('ui.render')
      } catch {
        // drawn with the next reading
      }
    }

    return yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const answered = await next(e)
    if (e.agentId === undefined) {
      isWorking = false
      remeasure($, true)
    }

    return answered
  })

  on('session.compact', async ($, e, next) => {
    const compacted = await next(e)
    if (e.agentId === undefined && e.trigger !== 'precompute') remeasure($, true)

    return compacted
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const saved = await read($, snapshot)
    if (e.props.hasSurvey || saved === null) return next(e)
    const snap: BandSnapshot = effort === undefined || saved.effort === effort ? saved : { ...saved, effort }
    const [expanded, now] = await Promise.all([read($, isExpanded), $.clock.now()])
    const { Box, Text, Button } = $.ui.resolve(e)

    const tone = toneOfFill(snap)
    const percent = snap.percent ?? (snap.tokens === undefined ? 0 : Math.round((snap.tokens / snap.window) * 100))
    const { filled, empty } = bar(percent, BAR)
    const toggle = expanded ? '접기' : '자세히'
    const room = e.props.bodyColumns - cells(LABEL) - BAR - 1 - (cells(toggle) + 5)
    const shown = fitPieces(pieces(snap, now), Math.max(0, room))
    const detail = detailLines(snap, now)

    const line: RenderElement[] = []
    shown.forEach((piece, i) => {
      if (i > 0) line.push(<Text dimColor> · </Text>)
      line.push(
        piece.color === undefined ? (
          <Text dimColor={piece.isDim === true}>{piece.text}</Text>
        ) : (
          <Text color={piece.color} dimColor={piece.isDim === true}>
            {piece.text}
          </Text>
        ),
      )
    })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>{LABEL}</Text>
          <Text color={tone}>{filled}</Text>
          <Text dimColor>{empty}</Text>
          <Text> </Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">{line}</Text>
          </Box>
          <Button key="detail" label={toggle} onPress={() => void update($, isExpanded, value => !value)} />
        </Box>
        {expanded && detail.parts !== '' ? (
          <Text dimColor wrap="truncate-end">
            {'  구성  '}
            {detail.parts}
          </Text>
        ) : null}
        {expanded && detail.memory !== '' ? (
          <Text color="suggestion" wrap="truncate-end">
            {'  메모리  '}
            {detail.memory}
          </Text>
        ) : null}
        {expanded && detail.limits !== '' ? (
          <Text dimColor wrap="truncate-end">
            {'  한도  '}
            {detail.limits}
          </Text>
        ) : null}
      </Box>
    )
  })
}
