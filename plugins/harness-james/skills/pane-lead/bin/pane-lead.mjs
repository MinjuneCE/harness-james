#!/usr/bin/env node
// pane-lead: main/sub Claude panes on herdr. `pane-lead --help` for commands.
// Output: one JSON line on stdout. Exit 0 ok / 1 failed / 2 usage.
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { BIN, CLI, SKILL_CMD, MAIN_EFFORT, MAX_SUBS, MODEL, PlError, absFrom, fail, now, parse, sleep, usage } from '../lib/common.mjs'
import { TOP, CMDS } from '../lib/help.mjs'
import * as H from '../lib/herdr.mjs'
import { checkName, defaultPrefix, emptyRegistry, ensureExcluded, load, mustLoad, openSubs, prefixOf, rootOf, update } from '../lib/registry.mjs'
import { accountDir } from '../lib/account.mjs'
import { mainSettings, readExtra, settingsPath, subSettings, writeSettings } from '../lib/settings.mjs'
import { planSplit } from '../lib/layout.mjs'
import { loginScreen, noOption, onceOption, parseDialog } from '../lib/dialog.mjs'
import { resultSummary, screenTail } from '../lib/summary.mjs'
import { attachToDoc } from '../lib/attach.mjs'

const BOOLEAN = new Set(['pretty', 'help', 'self', 'always', 'esc', 'force', 'no-focus', 'no-ctx', 'dry-run', 'over-classifier'])
const KNOWN = {
  main: ['prefix', 'prompt'],
  spawn: ['prefix', 'brief', 'kind', 'result', 'cwd', 'prompt', 'extra-settings'],
  wait: ['prefix', 'timeout'],
  approve: ['prefix'],
  deny: ['prefix', 'message'],
  send: ['prefix'],
  ctx: ['prefix'],
  status: ['prefix'],
  close: ['prefix'],
  handover: ['prefix', 'doc', 'prompt', 'config-dir', 'tab'],
  'takeover-done': ['prefix', 'timeout'],
  '_name-main': ['prefix', 'pane', 'name'],
}

const myPane = () => process.env.HERDR_PANE_ID
function needHerdr() {
  if (process.env.HERDR_ENV !== '1' || !myPane()) throw fail('not inside a herdr pane', 'run pane-lead from a herdr-managed pane (HERDR_ENV=1)')
}

function claudeArgs({ name, sessionId, settings, effort, prompt }) {
  return ['--model', MODEL(), ...(effort && effort !== 'none' ? ['--effort', effort] : []), '-n', name, '--session-id', sessionId, '--settings', settings, ...(prompt ? [prompt] : [])]
}

// The Claude account follows the lineage: panes we start get the caller's CLAUDE_CONFIG_DIR (or a handover's
// --config-dir). It has to be on the pane: claude reads it before any settings file. ~/.claude counts as the
// default profile and is left off (lib/account.mjs).
const profileEnv = (dir = process.env.CLAUDE_CONFIG_DIR) => {
  const d = accountDir(dir)
  return d ? { CLAUDE_CONFIG_DIR: d } : {}
}

const startPrompt = (brief, result) =>
  `먼저 ${brief}를 읽고 작업하세요. 끝나면 ${result}에 결과를 남기세요(맨 위 15줄 이하 요약). 사용자에게 직접 묻지 말고, 결정이 필요한 건 결과 파일 '메인에게' 칸에 적어 주세요.`

/** The live herdr agent for a registry entry: same pane AND (when named) same name. Never anything else. */
async function liveOf(entry, list) {
  if (!entry?.pane) return undefined
  const a = await H.agentInPane(entry.pane, list)
  if (!a) return undefined
  if (a.name && a.name !== entry.name) return undefined
  return a
}
async function paneAlive(pane) {
  return (await H.paneList()).some((p) => p.pane_id === pane)
}

function lineage(f) {
  const prefix = prefixOf(f)
  const root = rootOf(prefix)
  return { prefix, root, reg: mustLoad(root, prefix) }
}

function ownSub(reg, name) {
  checkName(name)
  const s = reg.subs[name]
  if (!s || s.status === 'closed') throw fail(`${name} is not an open sub of lineage ${reg.prefix}`, `${CLI} status`)
  return s
}

async function ctxOf(sessionId, cwd, { self = false } = {}) {
  if (!sessionId) return undefined
  try {
    const { findTranscript, contextUsage } = await import('../lib/ctx.mjs')
    const t = findTranscript(sessionId, { cwd })
    const u = t && contextUsage(t, { self })
    return u ? { percent: u.percent, used: u.used, window: u.window } : undefined
  } catch {
    return undefined
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2)
  if (!cmd || cmd === '--help' || cmd === '-h') return { help: TOP }
  if (!KNOWN[cmd]) throw usage(`unknown command ${cmd}`, `${CLI} --help`)
  const { pos, f } = parse(rest, BOOLEAN)
  if (f.help) return { help: CMDS[cmd] ?? TOP }
  for (const k of Object.keys(f)) if (!BOOLEAN.has(k) && !KNOWN[cmd].includes(k)) throw usage(`unknown option --${k} for ${cmd}`, `${CLI} ${cmd} --help`)

  switch (cmd) {
    case 'main':
      return cmdMain(f)
    case '_name-main':
      return nameMain(f)
    case 'spawn':
      return cmdSpawn(pos, f)
    case 'wait':
      return cmdWait(pos, f)
    case 'approve':
    case 'deny':
      return cmdAnswer(cmd, pos, f)
    case 'send':
      return cmdSend(pos, f)
    case 'ctx':
      return cmdCtx(pos, f)
    case 'status':
      return cmdStatus(f)
    case 'close':
      return cmdClose(pos, f)
    case 'handover':
      return cmdHandover(f)
    case 'takeover-done':
      return cmdTakeover(f)
  }
}

async function cmdMain(f) {
  needHerdr()
  const prefix = f.prefix || process.env.PANE_LEAD_PREFIX ? prefixOf(f) : defaultPrefix(process.cwd())
  const root = process.env.PANE_LEAD_ROOT ? rootOf(prefix) : process.cwd()
  const pane = myPane()
  const list = await H.agentList()
  const here = list.find((a) => a.pane_id === pane)
  if (here) throw fail(`pane ${pane} already runs ${here.name ?? here.agent}`, 'run `pane-lead main` from an empty shell pane')
  // --dry-run computes the same values from the current registry and writes nothing (registry, settings, git exclude).
  const plan = async (reg) => {
    if (reg.main && (await liveOf(reg.main, list))) throw fail(`lineage ${prefix} already has a live main ${reg.main.name} (${reg.main.pane})`, `use another --prefix, or close that main first`)
    const generation = (reg.main?.generation ?? reg.mains.at(-1)?.generation ?? 0) + 1
    return { generation, name: `${prefix}-main-${generation}`, pane, sessionId: randomUUID(), startedAt: now(), settings: null }
  }
  const settingsObj = await mainSettings({ prefix, root })
  if (f['dry-run']) {
    const m = await plan(load(root, prefix) ?? emptyRegistry(prefix, root))
    m.settings = settingsPath(root, prefix, m.name)
    const args = claudeArgs({ name: m.name, sessionId: m.sessionId, settings: m.settings, effort: MAIN_EFFORT(), prompt: f.prompt ?? `${SKILL_CMD} start ${prefix}` })
    return { dryRun: true, main: m, command: ['claude', ...args], settings: settingsObj }
  }
  const exclude = ensureExcluded(root)
  const m = await update(root, prefix, async (reg) => {
    const next = await plan(reg)
    if (reg.main) reg.mains.push({ ...reg.main, endedAt: now(), end: 'gone' })
    reg.root = root
    reg.main = next
    reg.pending = null
    return reg.main
  })
  m.settings = writeSettings(root, prefix, m.name, settingsObj)
  await update(root, prefix, (reg) => void (reg.main.settings = m.settings))
  const args = claudeArgs({ name: m.name, sessionId: m.sessionId, settings: m.settings, effort: MAIN_EFFORT(), prompt: f.prompt ?? `${SKILL_CMD} start ${prefix}` })
  // herdr names agents only through `agent start`; this pane's claude is started by us, so rename it once detected.
  spawn(process.execPath, [BIN, '_name-main', '--prefix', prefix, '--pane', pane, '--name', m.name], { detached: true, stdio: 'ignore', env: { ...process.env, PANE_LEAD_ROOT: root } }).unref()
  // claude reads ^C itself (raw tty); a stray SIGINT/SIGTERM to the group must not kill this parent first.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {})
  const env = { ...process.env }
  if (!accountDir(env.CLAUDE_CONFIG_DIR)) delete env.CLAUDE_CONFIG_DIR
  const r = spawnSync(process.env.PANE_LEAD_CLAUDE || 'claude', args, { stdio: 'inherit', cwd: root, env })
  process.exit(r.status ?? 1)
}

async function nameMain(f) {
  for (let i = 0; i < 120; i++) {
    const a = await H.agentInPane(f.pane).catch(() => undefined)
    if (a) {
      if (a.name !== f.name) await H.agentRename(f.pane, f.name)
      return { renamed: f.name }
    }
    await sleep(1000)
  }
  throw fail('main agent never appeared', `herdr agent rename ${f.pane} ${f.name}`)
}

async function cmdSpawn(pos, f) {
  needHerdr()
  const { prefix, root, reg } = lineage(f)
  const name = checkName(pos[0])
  if (!f.brief) throw usage('spawn needs --brief <path>', `${CLI} spawn --help`)
  const brief = absFrom(root, f.brief)
  if (!existsSync(brief)) throw fail(`brief not found: ${brief}`, 'write the brief first')
  const result = absFrom(root, f.result ?? join('.research', 'out', `${name}.md`))
  const cwd = absFrom(root, f.cwd ?? '.')
  const extra = readExtra(f['extra-settings'] && absFrom(root, f['extra-settings']))
  if (!reg.main) throw fail(`lineage ${prefix} has no main`, `${CLI} main --prefix ${prefix}`)
  const list = await H.agentList()
  if (list.some((a) => a.name === name)) throw fail(`agent name ${name} is already live`, 'pick another name')
  const panes = new Set((await H.paneList()).map((p) => p.pane_id))

  // Reserve the slot under the lock so two spawns cannot pass the cap together.
  const sessionId = randomUUID()
  const slot = await update(root, prefix, (r) => {
    for (const s of openSubs(r)) if (s.pane && !panes.has(s.pane)) Object.assign(s, { status: 'gone', closedAt: now() })
    const open = openSubs(r).filter((s) => s.status !== 'gone')
    if (r.subs[name] && !['closed', 'gone'].includes(r.subs[name].status)) throw fail(`sub ${name} already exists (${r.subs[name].status})`, `${CLI} send ${name} … to reuse it, or pick another name`)
    if (open.length >= MAX_SUBS())
      throw new PlError('cap', { next: `wait for a sub to finish and close it (${CLI} close <name>); open: ${open.map((s) => s.name).join(', ')}`, data: { open: open.map((s) => s.name), max: MAX_SUBS() } })
    r.subs[name] = { name, pane: null, sessionId, kind: f.kind ?? null, brief, result, cwd, status: 'starting', startedAt: now(), settings: null }
    return { open: open.map((s) => s.pane).filter(Boolean) }
  })
  const drop = (status, extraFields = {}) => update(root, prefix, (r) => void Object.assign(r.subs[name], { status, ...extraFields }))

  try {
    const layout = await H.paneLayout(reg.main.pane)
    const plan = planSplit(layout, reg.main.pane, slot.open)
    if (plan.error) throw fail(plan.error, plan.next, { layout: layout.panes.map((p) => [p.pane_id, p.rect]) })
    const settings = writeSettings(root, prefix, name, subSettings({ prefix, root }, extra))
    // Role/prefix go only through the settings env: a pane-level --env would leak into any claude started there later.
    // Only the account profile goes on the pane (profileEnv).
    const pane = await H.paneSplit(plan.pane, plan.direction, { ratio: plan.ratio, cwd, env: profileEnv() })
    await update(root, prefix, (r) => void Object.assign(r.subs[name], { pane: pane.pane_id, settings }))
    await H.paneRename(pane.pane_id, name).catch(() => {})
    try {
      await H.agentStartWhenShell(name, pane.pane_id, claudeArgs({ name, sessionId, settings }))
    } catch (e) {
      if (H.isPaneBusy(e)) {
        // The pane never got a usable shell: close it so no labelled empty pane is left behind.
        await H.paneClose(pane.pane_id).catch(() => {})
        rmSync(settings, { force: true })
        await drop('failed', { closedAt: now() })
        throw fail(`${name} did not start: ${e.message} (retried for ${(Number(process.env.PANE_LEAD_SHELL_WAIT_MS) || 8000) / 1000} s)`, `pane ${pane.pane_id} was closed; run the same ${CLI} spawn again`, { pane: pane.pane_id, closed: true })
      }
      if (e.herdrCode === 'agent_not_ready') {
        await drop('blocked-start')
        throw fail(`${name} is blocked during startup (trust or setup dialog)`, `herdr agent read ${name} --source visible; answer it, then ${CLI} send ${name} "<start prompt>"`, { pane: pane.pane_id })
      }
      throw e
    }
    const text = f.prompt ?? startPrompt(brief, result)
    let started = 'working'
    try {
      const a = (await H.agentPrompt(name, text, { until: ['working', 'blocked'], timeout: 20000 })).agent
      started = a?.agent_status ?? 'working'
    } catch (e) {
      started = `unconfirmed (${e.herdrCode ?? 'error'})`
    }
    await drop('running')
    return { sub: { name, pane: pane.pane_id, sessionId, result, started }, placement: plan, next: `${CLI} wait ${name}  (run in background)` }
  } catch (e) {
    const cur = mustLoad(root, prefix).subs[name]
    if (cur?.status === 'starting') await drop('failed', { closedAt: now() })
    throw e
  }
}

/** herdr may still report blocked for a moment after a dialog is answered; confirm with the screen. */
async function settled(name, timeout) {
  const deadline = timeout ? Date.now() + timeout : Infinity
  for (;;) {
    const left = deadline === Infinity ? undefined : Math.max(1, deadline - Date.now())
    let a
    try {
      a = await H.agentWait(name, [], left)
    } catch (e) {
      if (e.herdrCode === 'timeout') throw fail(`timeout waiting for ${name}`, `${CLI} wait ${name} again, or herdr agent read ${name}`, { status: (await H.agentGet(name).catch(() => null))?.agent_status })
      throw e
    }
    if (a.agent_status !== 'blocked') return { agent: a }
    const dialog = parseDialog(await H.agentRead(name, { source: 'visible' }))
    if (dialog) return { agent: a, dialog }
    await sleep(1500)
    if ((await H.agentGet(name)).agent_status === 'blocked') return { agent: a, dialog: null }
  }
}

async function cmdWait(pos, f) {
  needHerdr()
  const { reg } = lineage(f)
  const s = ownSub(reg, pos[0])
  const live = await liveOf(s)
  if (!live) {
    const summary = resultSummary(s.result, s.startedAt)
    if (summary) return { name: s.name, status: 'gone', summary, result: s.result }
    throw fail(`${s.name} is not running (pane ${s.pane})`, `${CLI} status`)
  }
  const { agent, dialog } = await settled(s.name, f.timeout ? Number(f.timeout) : undefined)
  if (agent.agent_status === 'blocked')
    return {
      name: s.name,
      status: 'blocked',
      dialog: dialog ? { kind: dialog.kind, question: dialog.question, context: dialog.context, options: dialog.options.map((o) => `${o.n}. ${o.label}`) } : null,
      next: dialog ? `ask the user; then ${CLI} approve ${s.name} | ${CLI} deny ${s.name}` : `herdr agent read ${s.name} --source visible (not a numbered dialog)`,
    }
  const summary = resultSummary(s.result, s.startedAt)
  const ctx = await ctxOf(s.sessionId, s.cwd)
  if (summary) return { name: s.name, status: agent.agent_status, ctx: ctx?.percent, result: s.result, summary }
  return { name: s.name, status: agent.agent_status, ctx: ctx?.percent, result: null, tail: screenTail(await H.agentRead(s.name, { source: 'visible' })) }
}

async function cmdAnswer(cmd, pos, f) {
  needHerdr()
  const { reg } = lineage(f)
  const s = ownSub(reg, pos[0])
  const a = await liveOf(s)
  if (!a) throw fail(`${s.name} is not running`, `${CLI} status`)
  // The dialog may be gone by now (answered in the sub pane, auto-denied, turn cancelled): send nothing.
  const closed = `the dialog is no longer open (answered in the sub pane, auto-denied or cancelled); nothing was sent`
  const recheck = `${CLI} wait ${s.name} to see where the sub is now; tell the user the approval was not needed`
  if (a.agent_status !== 'blocked') throw fail(`${s.name} is ${a.agent_status}, not blocked: ${closed}`, recheck, { status: a.agent_status })
  const dialog = parseDialog(await H.agentRead(s.name, { source: 'visible' }))
  if (!dialog && !(cmd === 'deny' && f.esc)) throw fail(`${s.name} shows no numbered dialog: ${closed}`, `${recheck} (if it stays blocked: herdr agent read ${s.name} --source visible)`, { status: a.agent_status })
  let key
  let chose
  if (cmd === 'deny' && f.esc) [key, chose] = ['esc', 'Esc (cancel turn)']
  else {
    if (cmd === 'approve' && dialog?.kind === 'classifier' && !f['over-classifier'])
      throw fail(`${s.name}'s dialog is an auto-mode classifier escalation; Yes would override the classifier`, `show the context to the user; only on their explicit OK: ${CLI} approve ${s.name} --over-classifier (else ${CLI} deny ${s.name})`, { dialog })
    const n = cmd === 'approve' ? (f.always ? dialog?.options.find((o) => /don.t ask again/i.test(o.label))?.n : onceOption(dialog)) : noOption(dialog)
    if (!n) throw fail(`no ${cmd === 'approve' ? (f.always ? '"don\'t ask again"' : '"Yes"') : '"No"'} option on ${s.name}'s screen`, `herdr agent read ${s.name} --source visible`, { dialog })
    key = String(n)
    chose = dialog.options.find((o) => o.n === n).label
  }
  await H.sendKeys(s.name, key)
  // Leave-blocked check: herdr can lag; the dialog disappearing from the screen also counts.
  let status = 'blocked'
  for (let i = 0; i < 20; i++) {
    await sleep(500)
    status = (await H.agentGet(s.name)).agent_status
    if (status !== 'blocked') break
    const d = parseDialog(await H.agentRead(s.name, { source: 'visible' }))
    if (!d || d.question !== dialog?.question || d.context.join('\n') !== dialog?.context.join('\n')) {
      status = d ? 'blocked (next dialog)' : status
      break
    }
  }
  let message
  if (cmd === 'deny' && f.message) {
    await H.agentWait(s.name, ['idle', 'done'], 30000).catch(() => {})
    // Confirm the follow-up started, so a `wait` right after does not return the stale done of the denied turn.
    const r = await H.agentPrompt(s.name, f.message, { until: ['working', 'blocked'], timeout: 20000 }).catch((e) => ({ error: e.herdrCode }))
    message = r.error ? `sent, unconfirmed (${r.error})` : 'sent'
  }
  return { name: s.name, answered: chose, context: dialog?.context, status, message }
}

async function cmdSend(pos, f) {
  needHerdr()
  const { reg } = lineage(f)
  const s = ownSub(reg, pos[0])
  const text = pos.slice(1).join(' ')
  if (!text) throw usage('send needs text', `${CLI} send --help`)
  const a = await liveOf(s)
  if (!a) throw fail(`${s.name} is not running`, `${CLI} spawn a new sub`)
  if (!['idle', 'done'].includes(a.agent_status)) throw fail(`${s.name} is ${a.agent_status}`, `${CLI} wait ${s.name}`)
  const ctx = await ctxOf(s.sessionId, s.cwd)
  if (ctx && ctx.percent >= 50 && !f.force) throw fail(`${s.name} context is ${ctx.percent}% (>= 50%)`, 'spawn a fresh sub instead (or --force)')
  await H.agentPrompt(s.name, text, { until: ['working', 'blocked'], timeout: 20000 }).catch(() => {})
  return { name: s.name, ctx: ctx?.percent, next: `${CLI} wait ${s.name}` }
}

async function cmdCtx(pos, f) {
  if (f.self || !pos[0]) {
    needHerdr()
    const a = await H.agentInPane(myPane())
    const sid = a?.agent_session?.value
    if (!sid) throw fail('no agent session in this pane', 'run from inside a Claude pane')
    const c = await ctxOf(sid, a.cwd, { self: true })
    if (!c) throw fail('no usage in the transcript yet', 'retry after the first response')
    return { name: a.name ?? null, ...c }
  }
  const { reg } = lineage(f)
  const e = reg.subs[pos[0]] ?? (reg.main?.name === pos[0] ? reg.main : reg.pending?.name === pos[0] ? reg.pending : null)
  if (!e) throw fail(`${pos[0]} is not in lineage ${reg.prefix}`, `${CLI} status`)
  const c = await ctxOf(e.sessionId, e.cwd ?? reg.root)
  if (!c) throw fail(`no usage for ${pos[0]} yet`, 'retry after its first response')
  return { name: e.name, ...c }
}

async function cmdStatus(f) {
  const { reg } = lineage(f)
  const list = await H.agentList().catch(() => [])
  const row = async (e, extra = {}) => {
    const a = await liveOf(e, list)
    // The main asking about itself measures like `ctx --self` (a simulated window applies), so both agree.
    const self = e === reg.main && !!e.pane && e.pane === myPane()
    const c = f['no-ctx'] ? undefined : await ctxOf(e.sessionId, e.cwd ?? reg.root, { self })
    return { name: e.name, pane: e.pane, state: a?.agent_status ?? (e.status === 'closed' ? 'closed' : 'gone'), ctx: c?.percent, ...extra }
  }
  const subs = []
  for (const s of Object.values(reg.subs)) {
    if (s.status === 'closed' || s.status === 'failed') continue
    subs.push(await row(s, { kind: s.kind ?? undefined, brief: s.brief, result: existsSync(s.result) ? s.result : null }))
  }
  return {
    lineage: reg.prefix,
    root: reg.root,
    main: reg.main && (await row(reg.main, { generation: reg.main.generation })),
    pending: reg.pending && (await row(reg.pending, { doc: reg.pending.doc })),
    subs,
    cap: `${subs.filter((s) => s.state !== 'gone').length}/${MAX_SUBS()}`,
  }
}

async function cmdClose(pos, f) {
  needHerdr()
  const { prefix, root, reg } = lineage(f)
  const s = ownSub(reg, pos[0])
  if (!s.pane) throw fail(`${s.name} has no pane`, `${CLI} status`)
  const list = await H.agentList()
  const inPane = await H.agentInPane(s.pane, list)
  if (inPane && inPane.name && inPane.name !== s.name) throw fail(`pane ${s.pane} now hosts ${inPane.name}, not ${s.name}; not touching it`, `${CLI} status`)
  if (inPane && inPane.agent_status === 'working' && !f.force) throw fail(`${s.name} is working`, `${CLI} wait ${s.name}, or close --force`)
  if (await paneAlive(s.pane)) await H.paneClose(s.pane)
  await update(root, prefix, (r) => void Object.assign(r.subs[s.name], { status: 'closed', closedAt: now() }))
  return { closed: s.name, pane: s.pane, result: existsSync(s.result) ? s.result : null }
}

async function cmdHandover(f) {
  needHerdr()
  const { prefix, root, reg } = lineage(f)
  if (!f.doc) throw usage('handover needs --doc <path>', `${CLI} handover --help`)
  const doc = absFrom(root, f.doc)
  if (!existsSync(doc)) throw fail(`handover doc not found: ${doc}`, 'write it first')
  if (!reg.main || reg.main.pane !== myPane()) throw fail(`only the current main (${reg.main?.name} ${reg.main?.pane}) can hand over`, `${CLI} status`)
  if (reg.pending && (await liveOf(reg.pending))) throw fail(`handover to ${reg.pending.name} is already in progress`, `wait for it to run ${CLI} takeover-done`)
  const configDir = f['config-dir'] && absFrom(root, f['config-dir'])
  if (configDir && !existsSync(configDir)) throw fail(`config dir not found: ${configDir}`, 'create that profile first: start claude once with CLAUDE_CONFIG_DIR=<dir> and log in')
  const env = profileEnv(configDir || undefined)
  // Workspace attach (attach.json): appended before the next main starts, so its first read has it. Never blocks the handover.
  const attach = await attachToDoc({ root, prefix, doc })
  const next = await startNextMain({ prefix, root, reg, doc, env, tab: f.tab, workspace: process.env.HERDR_WORKSPACE_ID, prompt: f.prompt })
  return { next_main: next, doc, ...(attach ? { attach } : {}), next: 'end this turn now; the new main runs takeover-done' }
}

/**
 * The next main of a lineage: a pane below the current main (or a new tab), the pending entry, claude, then
 * "<skill> takeover <doc>". A login or onboarding screen on the new pane stops it before the prompt: the pane is
 * closed, pending cleared, error login-required.
 */
async function startNextMain({ prefix, root, reg, doc, env, tab, workspace, prompt }) {
  const retry = `${CLI} handover`
  const generation = reg.main.generation + 1
  const name = `${prefix}-main-${generation}`
  const sessionId = randomUUID()
  const layout = await H.paneLayout(reg.main.pane)
  const origin = layout.panes.find((p) => p.pane_id === reg.main.pane)?.rect
  const s = await mainSettings({ prefix, root })
  // Test only: a simulated window (to exercise the 75% handover) follows the lineage; unset in real use.
  if (process.env.PANE_LEAD_CTX_WINDOW) s.env.PANE_LEAD_CTX_WINDOW = process.env.PANE_LEAD_CTX_WINDOW
  const settings = writeSettings(root, prefix, name, s)
  // tab: the next main opens in a new tab, so there is no old area to fill (origin null → takeover-done filled null).
  const pane = tab
    ? (await H.tabCreate({ label: tab, cwd: root, env, workspace })).root_pane
    : await H.paneSplit(reg.main.pane, 'down', { ratio: 0.5, cwd: root, env })
  const configDir = env.CLAUDE_CONFIG_DIR ?? null
  const dropNew = async () => {
    await H.paneClose(pane.pane_id).catch(() => {})
    rmSync(settings, { force: true })
  }
  // Checked again under the lock: a handover that started after our checks owns the lineage now.
  try {
    await update(root, prefix, async (r) => {
      if (r.main?.name !== reg.main.name) throw new PlError('pending', { next: `the lineage main is now ${r.main?.name}; ${CLI} status --prefix ${prefix}`, data: { main: r.main?.name } })
      const seen = reg.pending
      if (r.pending && (r.pending.pane !== seen?.pane || r.pending.startedAt !== seen?.startedAt) && (await paneAlive(r.pending.pane)))
        throw new PlError('pending', { next: `handover to ${r.pending.name} (${r.pending.pane}) started meanwhile; wait for its takeover-done (${CLI} status --prefix ${prefix})`, data: { pending: r.pending.name, pane: r.pending.pane } })
      r.pending = { generation, name, pane: pane.pane_id, sessionId, doc, settings, from: r.main.pane, origin: tab ? null : origin, startedAt: now() }
    })
  } catch (e) {
    await dropNew()
    throw e
  }
  await H.paneRename(pane.pane_id, name).catch(() => {})
  let notReady
  try {
    await H.agentStartWhenShell(name, pane.pane_id, claudeArgs({ name, sessionId, settings, effort: MAIN_EFFORT() }))
  } catch (e) {
    if (H.isPaneBusy(e)) {
      await dropNew()
      await update(root, prefix, (r) => void (r.pending?.name === name && r.pending.pane === pane.pane_id && (r.pending = null)))
      throw new PlError('shell-busy', { next: `${pane.pane_id} never got a usable shell (${e.message}); it was closed and ${reg.main.name} keeps the lineage. Run ${retry} again`, data: { pane: pane.pane_id, closed: true } })
    }
    if (e.herdrCode !== 'agent_not_ready') throw fail(`new main ${name} did not start: ${e.message}`, `herdr agent read ${pane.pane_id} --source visible; fix, then run ${retry} again after closing ${pane.pane_id}`, { pane: pane.pane_id })
    notReady = e
  }
  // herdr reports the theme picker and the login method screen as idle/ready, so the screen decides. Read twice:
  // the picker can be drawn a moment after start returns.
  const read = () => H.agentRead(pane.pane_id, { source: 'visible' }).catch(() => '')
  let login = loginScreen(await read())
  await sleep(1000)
  login ??= loginScreen(await read())
  if (login) {
    await dropNew()
    await update(root, prefix, (r) => void (r.pending?.name === name && (r.pending = null)))
    const who = configDir ? `CLAUDE_CONFIG_DIR=${configDir} claude` : 'claude (no CLAUDE_CONFIG_DIR)'
    throw new PlError('login-required', {
      next: `the profile has no login; ${pane.pane_id} was closed and ${reg.main.name} keeps the lineage. Log in once with \`${who}\` in a plain shell pane, then run ${retry} again`,
      data: { pane: pane.pane_id, config_dir: configDir, screen: login },
    })
  }
  if (notReady) throw fail(`new main ${name} did not start: ${notReady.message}`, `herdr agent read ${pane.pane_id} --source visible; fix, then run ${retry} again after closing ${pane.pane_id}`, { pane: pane.pane_id })
  await H.agentPrompt(name, prompt ?? `${SKILL_CMD} takeover ${doc}`, { until: ['working', 'blocked'], timeout: 20000 }).catch(() => {})
  return { name, pane: pane.pane_id, ...(tab ? { tab: pane.tab_id } : {}), ...(configDir ? { config_dir: configDir } : {}) }
}

async function cmdTakeover(f) {
  needHerdr()
  const { prefix, root, reg } = lineage(f)
  const p = reg.pending
  if (!p) throw fail('no handover pending', `${CLI} status`)
  if (p.pane !== myPane()) throw fail(`takeover-done must run in the new main pane ${p.pane}`, `${CLI} status`)
  const old = reg.main
  const timeout = Number(f.timeout ?? 600000)
  let closed = false
  // Which tab the user is looking at, read just before the old pane closes (closing it can move herdr's focus).
  const viewedTab = async () => {
    const panes = await H.paneList().catch(() => [])
    return { tab: panes.find((x) => x.pane_id === p.pane)?.tab_id, viewing: panes.find((x) => x.focused)?.tab_id }
  }
  let viewing
  if (old && (await paneAlive(old.pane))) {
    const a = await H.agentInPane(old.pane)
    if (a) {
      if (a.name && a.name !== old.name) throw fail(`pane ${old.pane} hosts ${a.name}, not ${old.name}; not touching it`, `${CLI} status`)
      if (!['idle', 'done'].includes(a.agent_status)) {
        try {
          await H.agentWait(old.pane, ['idle', 'done'], timeout)
        } catch (e) {
          throw fail(`previous main ${old.name} is still ${a.agent_status}`, `retry ${CLI} takeover-done later`)
        }
      }
    }
    viewing = await viewedTab()
    await H.paneClose(old.pane)
    closed = true
  }
  let filled = null
  try {
    const rect = (await H.paneLayout(p.pane)).panes.find((x) => x.pane_id === p.pane)?.rect
    filled = p.origin && rect ? ['x', 'y', 'width', 'height'].every((k) => rect[k] === p.origin[k]) : null
    if (filled === false) filled = { now: rect, expected: p.origin }
  } catch {}
  // Focus moves only when the user is looking at the main's tab (user decision 10/16). herdr has no
  // tab-local focus command (pane/agent/tab focus all move the user's view), so on another tab nothing is sent.
  let focused = false
  let focus = 'not requested (--no-focus)'
  if (!f['no-focus']) {
    const { tab, viewing: seen } = viewing ?? (await viewedTab())
    if (tab && seen === tab) {
      await H.agentFocus(p.name)
      focused = true
      focus = 'moved'
    } else focus = seen ? `left alone: the user is on tab ${seen}` : 'left alone: herdr reports no focused tab'
  }
  let tabFocus
  try {
    tabFocus = (await H.paneLayout(p.pane)).focused_pane_id
  } catch {}
  await update(root, prefix, (r) => {
    if (r.main) r.mains.push({ ...r.main, endedAt: now(), end: 'handover', doc: p.doc })
    r.main = { generation: p.generation, name: p.name, pane: p.pane, sessionId: p.sessionId, startedAt: p.startedAt, settings: p.settings, fromDoc: p.doc }
    r.pending = null
  })
  return { main: p.name, generation: p.generation, closed: closed ? old.pane : null, filled, focused, focus, tab_focus: tabFocus ?? null, ...(tabFocus && tabFocus !== p.pane ? { tab_focus_note: `inside the main tab herdr focuses ${tabFocus}, not ${p.pane}` } : {}) }
}

const pretty = process.argv.includes('--pretty')
try {
  const out = await main()
  if (out?.help) {
    process.stdout.write(out.help + '\n')
    process.exit(0)
  }
  process.stdout.write(JSON.stringify({ ok: true, ...out }, null, pretty ? 2 : 0) + '\n')
  process.exit(0)
} catch (err) {
  const e = err instanceof PlError ? err : new PlError(String(err?.stack ?? err), { next: `${CLI} --help` })
  const out = { ok: false, error: e.message, next: e.next }
  if (e.data !== undefined) out.data = e.data
  process.stdout.write(JSON.stringify(out, null, pretty ? 2 : 0) + '\n')
  process.exit(e.code === 2 ? 2 : 1)
}
