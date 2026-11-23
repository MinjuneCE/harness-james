// The Fable weekly limit of a Claude account, and the sub model that follows from it. Subs run Opus 5.5 unless
// the user asked for Fable (spawn --fable); a sub asked for on Fable runs Fable 5.2 until the account's Fable
// weekly limit is at 90%, then Opus 5.5.
//
// Where the figure comes from (measured 2026-11-16, Claude Code 2.1.325): the Fable window is the unified
// window `seven_day_overage_included`. A mod does not get it (`session.measure` / `$.session.usage()` list only
// five_hour, seven_day and spend_limit), and neither does a status line or a settings hook. A headless claude
// answers the `get_usage` control request with the /usage data, with no user message and so no model call:
//   rate_limits.model_scoped: [{ display_name: "Fable", utilization: <percent>, resets_at: "<ISO time>" }]
// (percent, 0-100). The last reading per account is kept in <state>/fable-limit/<account>.json and reused for
// PANE_LEAD_FABLE_TTL_MS (5 min), so a run of spawns asks the endpoint once.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readJson, stateDir, writeAtomic } from './common.mjs'
import { accountDir } from './account.mjs'

export const FABLE = 'claude-fable-5-2'
export const OPUS = 'claude-opus-5-5'
export const SUB_MODELS = { fable: FABLE, opus: OPUS }
/** Fable weekly % at which a sub asked for on Fable starts on Opus instead. */
export const SWITCH_AT = 90
/** modelReason of a sub spawned with no model asked for. */
export const DEFAULT_REASON = 'default (Fable only when asked: --fable)'

const num = (v, fallback) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : fallback)
const TTL = (env) => num(env.PANE_LEAD_FABLE_TTL_MS, 5 * 60_000)
const PROBE_TIMEOUT = (env) => num(env.PANE_LEAD_FABLE_PROBE_MS, 15_000)

/** default | dir-<config dir>: one record per Claude account profile (CLAUDE_CONFIG_DIR; none or ~/.claude = default). */
export function accountKey(configDir) {
  const d = accountDir(configDir)
  return d === null ? 'default' : `dir-${d.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(-48)}`
}

export const recordFile = (configDir, env = process.env) => join(stateDir(env), 'fable-limit', `${accountKey(configDir)}.json`)

// The server's reset time wobbles by under a second between readings (12:00:00.277Z, 11:59:59.746Z); the window
// resets on a whole minute, so the reading is rounded to it.
const iso = (v) => {
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(Math.round(t / 60000) * 60000).toISOString() : null
}

/** The Fable weekly window in a get_usage answer: { utilization (percent 0-100), resetsAt } or null when it lists none. */
export function fableWindow(usage) {
  const rl = usage?.rate_limits
  if (!rl || typeof rl !== 'object') return null
  const isFable = (name) => /fable/i.test(name ?? '')
  const m = (Array.isArray(rl.model_scoped) ? rl.model_scoped : []).find((x) => isFable(x?.display_name))
  if (m && Number.isFinite(m.utilization)) return { utilization: m.utilization, resetsAt: iso(m.resets_at) }
  // The server's own rows, when the allowlisted projection above is absent.
  const row = (Array.isArray(rl.limits) ? rl.limits : []).find((l) => l?.kind === 'weekly_scoped' && isFable(l.scope?.model?.display_name))
  if (row && Number.isFinite(row.percent)) return { utilization: row.percent, resetsAt: iso(row.resets_at) }
  return null
}

/**
 * Asks a headless claude on that account for the /usage data. No user message is sent, so no model runs
 * (measured: total_cost_usd 0, about 2 s). PANE_LEAD_CLAUDE swaps the binary (tests use a fake; a .mjs runs under node).
 */
export function probeUsage({ configDir, env = process.env } = {}) {
  const bin = env.PANE_LEAD_CLAUDE || 'claude'
  const [cmd, pre] = bin.endsWith('.mjs') ? [process.execPath, [bin]] : [bin, []]
  const args = ['-p', '--model', 'claude-haiku-5-5', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}']
  const childEnv = { ...env }
  // The probe is no pane-lead session: without the role, mods and hooks keyed on it stay quiet.
  for (const k of ['PANE_LEAD_ROLE', 'PANE_LEAD_PREFIX', 'PANE_LEAD_ROOT']) delete childEnv[k]
  const dir = accountDir(configDir)
  if (dir) childEnv.CLAUDE_CONFIG_DIR = dir
  else delete childEnv.CLAUDE_CONFIG_DIR
  const cwd = join(stateDir(env), 'fable-limit')
  mkdirSync(cwd, { recursive: true })
  const id = `fable-${process.pid}-${Date.now()}`
  return new Promise((resolve, reject) => {
    let p
    try {
      p = spawn(cmd, [...pre, ...args], { env: childEnv, cwd, stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (e) {
      return reject(e)
    }
    let buf = ''
    let err = ''
    let done = false
    const finish = (fn, v) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        p.stdin.end()
      } catch {}
      fn(v)
    }
    const timer = setTimeout(() => {
      p.kill('SIGTERM')
      finish(reject, new Error(`get_usage: no answer in ${PROBE_TIMEOUT(env)} ms`))
    }, PROBE_TIMEOUT(env))
    p.on('error', (e) => finish(reject, e))
    p.stdin.on('error', () => {})
    p.stderr.on('data', (d) => (err += d))
    p.stdout.on('data', (d) => {
      buf += d
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        let o
        try {
          o = JSON.parse(line)
        } catch {
          continue
        }
        if (o?.type !== 'control_response' || o.response?.request_id !== id) continue
        if (o.response.subtype === 'success') finish(resolve, o.response.response)
        else finish(reject, new Error(`get_usage: ${o.response.error ?? o.response.subtype}`))
      }
    })
    p.on('close', (code) => finish(reject, new Error(`get_usage: claude exited ${code} without an answer${err ? `: ${err.trim().split('\n').at(-1).slice(0, 200)}` : ''}`)))
    p.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n')
  })
}

export const readRecord = (configDir, env = process.env) => {
  try {
    return readJson(recordFile(configDir, env)) ?? null
  } catch {
    return null
  }
}

/**
 * The account's Fable reading: { account, record | null, source, error? }.
 * record: { utilization (percent, null when the account lists no Fable window), resetsAt, at, source }.
 * source: cache (younger than the TTL) | probe (just read) | stale (probe off or failed; the last record stands) | none.
 * A failed probe never throws: spawn then goes by the last record, or by none.
 */
export async function fableLimit({ configDir, env = process.env, now = Date.now(), probe = true } = {}) {
  const account = accountKey(configDir)
  const old = readRecord(configDir, env)
  const age = old ? now - Date.parse(old.at) : Infinity
  if (old && age >= 0 && age < TTL(env)) return { account, record: old, source: 'cache' }
  const rest = { account, record: old, source: old ? 'stale' : 'none' }
  if (!probe || env.PANE_LEAD_FABLE_PROBE === 'off') return rest
  try {
    const w = fableWindow(await probeUsage({ configDir, env }))
    const record = { utilization: w?.utilization ?? null, resetsAt: w?.resetsAt ?? null, at: new Date(now).toISOString(), source: 'get_usage' }
    writeAtomic(recordFile(configDir, env), JSON.stringify(record) + '\n')
    return { account, record, source: 'probe' }
  } catch (e) {
    return { ...rest, error: String(e?.message ?? e) }
  }
}

/**
 * The model for a new sub: { model, reason }.
 * Opus unless `fable` (the user asked for a Fable sub: spawn --fable). With `fable`: Fable while the record is
 * under 90%, missing, or past its reset; Opus from 90%. `override` (fable | opus) wins whatever the limit;
 * PANE_LEAD_SUB_MODEL / PANE_LEAD_MODEL (a full model id, experiments) come next.
 */
export function chooseModel({ record, now = Date.now(), override, fable = false, env = process.env } = {}) {
  if (override) return { model: SUB_MODELS[override], reason: `--model ${override}` }
  if (env.PANE_LEAD_SUB_MODEL) return { model: env.PANE_LEAD_SUB_MODEL, reason: 'PANE_LEAD_SUB_MODEL' }
  if (env.PANE_LEAD_MODEL) return { model: env.PANE_LEAD_MODEL, reason: 'PANE_LEAD_MODEL' }
  if (!fable) return { model: OPUS, reason: DEFAULT_REASON }
  const u = record?.utilization
  if (!Number.isFinite(u)) return { model: FABLE, reason: 'no Fable limit record' }
  const reset = Date.parse(record.resetsAt)
  if (Number.isFinite(reset) && now >= reset) return { model: FABLE, reason: `Fable weekly window reset at ${record.resetsAt}` }
  if (u >= SWITCH_AT) return { model: OPUS, reason: `Fable weekly ${u}% >= ${SWITCH_AT}%` }
  return { model: FABLE, reason: `Fable weekly ${u}% < ${SWITCH_AT}%` }
}

export const isFable = (model) => /^claude-fable-/.test(model ?? '')
