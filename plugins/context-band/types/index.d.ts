/** One row of the window as /context breaks it down. */
export type BandPart = { name: string; tokens: number; kind: string }

/** A memory file in the context (CLAUDE.md, MEMORY.md, ...). */
export type BandMemory = { name: string; type: string; tokens: number }

/** A rate-limit window and how much of it is used. */
export type BandLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** What the band draws: the status line's figures plus the last breakdown. */
export type BandSnapshot = {
  /** When these figures were read. */
  at: number
  model: string
  /** The reasoning effort of the main loop's last model request; absent before the first. */
  effort?: string
  /** When the session began. */
  startedAt: number
  /** Tokens the last response was answered over; absent before the first. */
  tokens?: number
  window: number
  percent?: number
  /** The token count at which auto-compaction runs; absent when it is off. */
  compactAt?: number
  /** The breakdown's own estimate, for a session with no response yet. */
  estimate?: number
  parts: BandPart[]
  memory: BandMemory[]
  costUsd?: number
  limits: BandLimit[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-band': {
      snapshot: Shaped<BandSnapshot | null>
      isExpanded: boolean
    }
  }
}
