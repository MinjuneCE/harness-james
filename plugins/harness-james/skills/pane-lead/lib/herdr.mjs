// Every herdr call goes through here. PANE_LEAD_HERDR swaps the binary (tests use a fake; a .mjs path runs under node).
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fail, sleep } from './common.mjs'

const pexec = promisify(execFile)

function bin() {
  const b = process.env.PANE_LEAD_HERDR || 'herdr'
  return b.endsWith('.mjs') ? [process.execPath, [b]] : [b, []]
}

/** Runs herdr and returns parsed `.result` (or raw text for non-JSON output). Throws HerdrError on failure. */
export async function herdr(args, { timeout = 0 } = {}) {
  const [cmd, pre] = bin()
  try {
    const { stdout } = await pexec(cmd, [...pre, ...args], { timeout, maxBuffer: 32 << 20 })
    const t = stdout.trim()
    if (!t.startsWith('{')) return t
    const j = JSON.parse(t)
    return j.result ?? j
  } catch (e) {
    const raw = String(e.stderr || e.stdout || e.message).trim()
    let code = 'herdr_error'
    let message = raw
    try {
      const j = JSON.parse(raw)
      code = j.error?.code ?? code
      message = j.error?.message ?? raw
    } catch {}
    const err = fail(`herdr ${args.slice(0, 2).join(' ')}: ${message}`, 'herdr agent list / herdr pane layout --current to inspect')
    err.herdrCode = code
    throw err
  }
}

export const agentList = async () => (await herdr(['agent', 'list'])).agents ?? []
export const agentGet = async (t) => (await herdr(['agent', 'get', t])).agent
export const agentRead = async (t, { source = 'visible', lines } = {}) => {
  const r = await herdr(['agent', 'read', t, '--source', source, ...(lines ? ['--lines', String(lines)] : [])])
  return typeof r === 'string' ? r : (r.read?.text ?? r.text ?? '')
}
export const sendKeys = (t, ...keys) => herdr(['agent', 'send-keys', t, ...keys])
export const agentRename = (t, name) => herdr(['agent', 'rename', t, name])
export const agentFocus = (t) => herdr(['agent', 'focus', t])
export const agentStart = (name, pane, args, timeout = 60000) =>
  herdr(['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', String(timeout), '--', ...args], { timeout: timeout + 10000 })
// --until requires --wait; with neither, prompt returns right after the text and Enter are written.
export const agentPrompt = (t, text, { wait = false, until = [], timeout } = {}) =>
  herdr(['agent', 'prompt', t, text, ...(wait || until.length ? ['--wait'] : []), ...until.flatMap((s) => ['--until', s]), ...(timeout ? ['--timeout', String(timeout)] : [])], { timeout: timeout ? timeout + 10000 : 0 })
export const agentWait = async (t, until = [], timeout) =>
  (await herdr(['agent', 'wait', t, ...until.flatMap((s) => ['--until', s]), ...(timeout ? ['--timeout', String(timeout)] : [])])).agent

export const paneLayout = async (pane) => (await herdr(['pane', 'layout', '--pane', pane])).layout
export const paneList = async () => (await herdr(['pane', 'list'])).panes ?? []
export const paneSplit = async (pane, direction, { ratio, cwd, env = {}, focus = false } = {}) =>
  (
    await herdr([
      'pane', 'split', pane, '--direction', direction,
      ...(ratio ? ['--ratio', String(ratio)] : []),
      ...(cwd ? ['--cwd', cwd] : []),
      ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      focus ? '--focus' : '--no-focus',
    ])
  ).pane
/** New tab; returns { tab, root_pane }. */
export const tabCreate = ({ label, cwd, env = {}, workspace, focus = false } = {}) =>
  herdr([
    'tab', 'create',
    ...(workspace ? ['--workspace', workspace] : []),
    ...(label ? ['--label', label] : []),
    ...(cwd ? ['--cwd', cwd] : []),
    ...Object.entries(env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    focus ? '--focus' : '--no-focus',
  ])
export const paneClose = (pane) => herdr(['pane', 'close', pane])
export const paneProcess = async (pane) => (await herdr(['pane', 'process-info', '--pane', pane])).process_info

/** The pane's foreground is the bare shell (startup children such as git gone); null when herdr cannot tell. */
export async function shellIdle(pane) {
  try {
    const p = await paneProcess(pane)
    const fg = p?.foreground_processes
    if (!Array.isArray(fg) || !p.shell_pid) return null
    return fg.length === 1 && fg[0].pid === p.shell_pid
  } catch {
    return null
  }
}
/** herdr's answer when the pane's shell is not up yet (or busy): agent_pane_busy, "… is not an available shell". */
export const isPaneBusy = (e) => e?.herdrCode === 'agent_pane_busy' || /not an available shell/.test(e?.message ?? '')
const SHELL_WAIT = () => Number(process.env.PANE_LEAD_SHELL_WAIT_MS) || 8000

/**
 * agent start on a pane we just made. Right after a split the shell is still starting (measured
 * 10/23: git and zsh children in the foreground for ~10-30 ms), and herdr refuses with agent_pane_busy.
 * Waits for a bare-shell foreground, retries agent_pane_busy every 0.5 s, about 8 s in all; then throws the last error.
 */
export async function agentStartWhenShell(name, pane, args) {
  const deadline = Date.now() + SHELL_WAIT()
  for (;;) {
    while ((await shellIdle(pane)) === false && Date.now() < deadline) await sleep(100)
    try {
      return await agentStart(name, pane, args)
    } catch (e) {
      if (!isPaneBusy(e) || Date.now() >= deadline) throw e
      await sleep(500)
    }
  }
}
export const paneRename = (pane, label) => herdr(['pane', 'rename', pane, label])

/** Live agent hosted in `pane` (or undefined). */
export async function agentInPane(pane, list) {
  return (list ?? (await agentList())).find((a) => a.pane_id === pane)
}
