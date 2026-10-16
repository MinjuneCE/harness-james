// The changed-files part of the trace: the person's open rows kept in the
// state, and the file changes the hooks queued, worked into the list off the
// model's path (store.ts drains the queue when the timer runs or the pane draws).
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { TraceFile } from '../types'
import { advanceChain, editsOf, netOf, putEdit } from './files'
import type { Chain, EditMeta } from './files'

export const openFiles = atom({ plugin: 'work-trace', key: 'openFiles' } as const, [])
export const netFiles = atom({ plugin: 'work-trace', key: 'netFiles' } as const, [])

/** A settled call's answer, kept raw until the list is worked. */
export type PendingEdit = { toolUseId: string; tool: string; result: unknown; loop: string; at: number }

// The texts the net diffs run between: too big for the state, and lost on a
// reload, which the chain then says rather than draw a diff missing edits.
const chains = new Map<string, Chain>()

/** Puts the file changes the queued calls report on the list. */
export function applyFileEdits(list: readonly TraceFile[], queue: readonly PendingEdit[], byOf: (loop: string) => string, cwd: string): TraceFile[] {
  let out = list.slice()
  for (const call of queue) {
    const raws = editsOf(call.tool, call.result)
    if (raws.length === 0) continue
    // Files with an applied edit on the list: a chain is expected for them.
    const known = new Set(out.filter(f => f.editCount > 0).map(f => f.path))
    const meta: EditMeta = { toolUseId: call.toolUseId, tool: call.tool, at: call.at, loop: call.loop, by: byOf(call.loop), cwd }
    for (const raw of raws) {
      // Not on the list but chained: the list was cleared (/clear, 지우기), so the file starts over.
      const prev = known.has(raw.path) ? chains.get(raw.path) : undefined
      const chain = advanceChain(prev, raw, known.has(raw.path))
      if (chain === undefined) chains.delete(raw.path)
      else chains.set(raw.path, chain)
      if (!raw.isStaged) known.add(raw.path)
      out = putEdit(out, raw, meta, netOf(chain))
    }
  }

  return out
}

export function resetChains(): void {
  chains.clear()
}

function toggled(list: readonly string[], path: string): string[] {
  return list.includes(path) ? list.filter(p => p !== path) : [...list, path]
}

/** The rows the person opened; read while drawing, so a press redraws them. */
export async function readFileToggles($: EngineInterface): Promise<{ openFiles: string[]; netFiles: string[] }> {
  const [opened, netted] = await Promise.all([read($, openFiles), read($, netFiles)])

  return { openFiles: opened, netFiles: netted }
}

export async function toggleOpenFile($: EngineInterface, path: string): Promise<void> {
  await update($, openFiles, list => toggled(list, path))
}

export async function toggleNetFile($: EngineInterface, path: string): Promise<void> {
  await update($, netFiles, list => toggled(list, path))
}

export async function clearFileToggles($: EngineInterface): Promise<void> {
  await update($, openFiles, () => [])
  await update($, netFiles, () => [])
}
