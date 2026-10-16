// The band's reading of a snapshot: pure functions the hooks and tests share.
import type { BandSnapshot } from '../types'

export type Tone = 'success' | 'warning' | 'error' | 'inactive' | 'text' | 'suggestion' | 'permission'

/** One piece of the line, its text and color; the line keeps pieces in order until the room runs out. */
export type Piece = { key: string; text: string; color?: Tone; isDim?: boolean }

/** Terminal cells a character takes: two for Hangul, CJK and fullwidth forms. */
export function cellWidth(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  const isWide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6)

  return isWide ? 2 : 1
}

export function cells(text: string): number {
  let n = 0
  for (const ch of text) n += cellWidth(ch)

  return n
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`

  return String(Math.max(0, Math.round(n)))
}

export function fmtSpan(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${String(m % 60).padStart(2, '0')}m`

  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function shortModel(model: string): string {
  return model
    .replace(/^claude-/, '')
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{8}$/, '')
}

const LIMIT_LABEL: Record<string, string> = { five_hour: '5시간', seven_day: '7일', spend_limit: '지출 한도' }

export function limitLabel(kind: string): string {
  return LIMIT_LABEL[kind] ?? kind
}

/** How full the window is, as the line reads it: of the compaction point when there is one. */
export function fill(s: BandSnapshot): { used: number; of: number; percent: number } | undefined {
  const used = s.tokens ?? s.estimate
  if (used === undefined || s.window <= 0) return undefined
  const percent = s.percent ?? Math.round((used / s.window) * 100)

  return { used, of: s.window, percent }
}

export function toneOfFill(s: BandSnapshot): Tone {
  const f = fill(s)
  if (f === undefined) return 'inactive'
  // Read against where auto-compaction starts, when it is on: that is the wall the turn will hit.
  const ratio = s.compactAt !== undefined && s.compactAt > 0 ? f.used / s.compactAt : f.percent / 100
  if (ratio >= 0.85) return 'error'
  if (ratio >= 0.6) return 'warning'

  return 'success'
}

export function bar(percent: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))

  return { filled: '█'.repeat(n), empty: '░'.repeat(width - n) }
}

export function toneOfLimit(percentUsed: number): Tone {
  if (percentUsed >= 90) return 'error'
  if (percentUsed >= 70) return 'warning'

  return 'inactive'
}

/** The line's pieces after the bar, most telling first. */
export function pieces(s: BandSnapshot, now: number): Piece[] {
  const out: Piece[] = []
  const f = fill(s)
  if (f === undefined) {
    out.push({ key: 'ctx', text: '컨텍스트 첫 응답 전', isDim: true })
  } else {
    const estimate = s.tokens === undefined ? '≈' : ''
    out.push({ key: 'ctx', text: `${f.percent}% ${estimate}${fmtTokens(f.used)}/${fmtTokens(f.of)}`, color: toneOfFill(s) })
    if (s.compactAt !== undefined) {
      const left = s.compactAt - f.used
      out.push(
        left > 0
          ? { key: 'compact', text: `자동압축까지 ${fmtTokens(left)}`, color: toneOfFill(s) === 'error' ? 'error' : undefined, isDim: toneOfFill(s) !== 'error' }
          : { key: 'compact', text: '곧 자동압축', color: 'error' },
      )
    }
  }
  if (s.memory.length > 0) {
    const total = s.memory.reduce((sum, m) => sum + m.tokens, 0)
    out.push({ key: 'memory', text: `메모리 ${s.memory.length}개 ${fmtTokens(total)}`, color: 'suggestion' })
  }
  if (s.costUsd !== undefined) out.push({ key: 'cost', text: `$${s.costUsd.toFixed(2)}`, isDim: true })
  for (const limit of s.limits) {
    out.push({
      key: `limit-${limit.kind}`,
      text: `${limitLabel(limit.kind)} ${limit.percentUsed}%`,
      color: toneOfLimit(limit.percentUsed),
      isDim: toneOfLimit(limit.percentUsed) === 'inactive',
    })
  }
  out.push({ key: 'model', text: s.effort === undefined ? shortModel(s.model) : `${shortModel(s.model)}/${s.effort}`, isDim: true })
  out.push({ key: 'age', text: `세션 ${fmtSpan(now - s.startedAt)}`, isDim: true })

  return out
}

/** Keeps pieces in order while they fit in `room` cells with their separators. */
export function fitPieces(list: readonly Piece[], room: number, sep = ' · '): Piece[] {
  const kept: Piece[] = []
  let used = 0
  for (const piece of list) {
    const w = cells(piece.text) + (kept.length > 0 ? cells(sep) : 0)
    if (used + w > room) break
    kept.push(piece)
    used += w
  }

  return kept
}

/** The second line: what fills the window, by kind of content, and the memory files by name. */
export function detailLines(s: BandSnapshot, now: number): { parts: string; memory: string; limits: string } {
  const used = s.parts.filter(p => p.kind === 'used' && p.tokens > 0)
  const free = s.parts.find(p => p.kind === 'free')
  const buffer = s.parts.find(p => p.kind === 'buffer')
  const parts = [
    ...used.map(p => `${p.name} ${fmtTokens(p.tokens)}`),
    ...(free === undefined ? [] : [`여유 ${fmtTokens(free.tokens)}`]),
    ...(buffer === undefined ? [] : [`압축 버퍼 ${fmtTokens(buffer.tokens)}`]),
  ].join(' · ')
  const memory = s.memory.map(m => `${m.name}(${m.type}) ${fmtTokens(m.tokens)}`).join(' · ')
  const limits = s.limits
    .map(l => {
      const at = l.resetsAt === undefined ? Number.NaN : Date.parse(l.resetsAt)
      const resets = Number.isFinite(at) && at > now ? ` · ${fmtSpan(at - now)} 후 초기화` : ''
      return `${limitLabel(l.kind)} ${l.percentUsed}%${resets}`
    })
    .join('  |  ')

  return { parts, memory, limits }
}
