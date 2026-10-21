#!/usr/bin/env node
// Minimal herdr stand-in for tests: state in $PANE_LEAD_FAKE_STATE (JSON), every call appended to state.log.
// Layout is a split tree per tab with herdr's rounding (the original pane keeps `ratio`).
import { readFileSync, writeFileSync } from 'node:fs'

const file = process.env.PANE_LEAD_FAKE_STATE
const S = JSON.parse(readFileSync(file, 'utf8'))
S.log ??= []
S.seq ??= 100
const args = process.argv.slice(2)
S.log.push(args.join(' '))
const save = () => writeFileSync(file, JSON.stringify(S, null, 2))
const out = (result) => {
  save()
  process.stdout.write(JSON.stringify({ id: 'fake', result }) + '\n')
  process.exit(0)
}
const err = (code, message) => {
  save()
  process.stderr.write(JSON.stringify({ error: { code, message } }) + '\n')
  process.exit(1)
}
const flag = (k) => {
  const i = args.indexOf(k)
  return i >= 0 ? args[i + 1] : undefined
}
const flags = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []))

function rects(node, r, acc = {}) {
  if (node.pane) {
    acc[node.pane] = r
    return acc
  }
  if (node.dir === 'right') {
    const w = Math.round(r.width * node.ratio)
    rects(node.a, { x: r.x, y: r.y, width: w, height: r.height }, acc)
    rects(node.b, { x: r.x + w, y: r.y, width: r.width - w, height: r.height }, acc)
  } else {
    const h = Math.round(r.height * node.ratio)
    rects(node.a, { x: r.x, y: r.y, width: r.width, height: h }, acc)
    rects(node.b, { x: r.x, y: r.y + h, width: r.width, height: r.height - h }, acc)
  }
  return acc
}
function replace(node, id, fn) {
  if (node.pane) return node.pane === id ? fn(node) : node
  return { ...node, a: replace(node.a, id, fn), b: replace(node.b, id, fn) }
}
function remove(node, id) {
  if (node.pane) return node.pane === id ? null : node
  const a = remove(node.a, id)
  const b = remove(node.b, id)
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}
const tabOf = (pane) => Object.entries(S.tabs).find(([, t]) => rects(t.root, { x: 0, y: 0, ...t.area })[pane])?.[0]
const agentInfo = (pane) => {
  const a = S.agents[pane]
  return a && { agent: 'claude', name: a.name, agent_status: a.status, pane_id: pane, cwd: a.cwd ?? '/tmp', agent_session: { value: a.session } }
}
const resolve = (t) => {
  const pane = S.agents[t] ? t : Object.keys(S.agents).find((p) => S.agents[p].name === t)
  if (!pane) err('agent_not_found', `no agent ${t}`)
  return pane
}
// After a prompt/answer the agent moves to the scripted next state (default done).
const advance = (pane) => {
  const a = S.agents[pane]
  const next = (S.script?.[a.name] ?? []).shift()
  if (next) {
    a.status = next.status
    if (next.screen !== undefined) a.screen = next.screen
  } else a.status = 'done'
}

const [g, c] = args
if (g === 'pane') {
  if (c === 'list') out({ panes: Object.keys(S.panes).map((p) => ({ pane_id: p, tab_id: tabOf(p), focused: S.focused === p, ...agentInfo(p) })) })
  if (c === 'layout') {
    const pane = flag('--pane')
    const tab = tabOf(pane) ?? err('pane_not_found', pane)
    const t = S.tabs[tab]
    const r = rects(t.root, { x: 0, y: 0, ...t.area })
    out({ layout: { area: { x: 0, y: 0, ...t.area }, focused_pane_id: S.tabFocus?.[tab] ?? null, panes: Object.entries(r).map(([pane_id, rect]) => ({ pane_id, rect })), tab_id: tab } })
  }
  if (c === 'split') {
    const target = args[2]
    if (!S.panes[target]) err('pane_not_found', target)
    const tab = tabOf(target)
    const id = `w9:p${S.seq++}`
    const ratio = Number(flag('--ratio') ?? 0.5)
    S.tabs[tab].root = replace(S.tabs[tab].root, target, (leaf) => ({ dir: flag('--direction'), ratio, a: leaf, b: { pane: id } }))
    S.panes[id] = { env: flags('--env'), cwd: flag('--cwd') }
    if (args.includes('--focus')) S.focused = id
    out({ pane: { pane_id: id, tab_id: tab } })
  }
  if (c === 'close') {
    const p = args[2]
    if (!S.panes[p]) err('pane_not_found', p)
    const tab = tabOf(p)
    S.tabs[tab].root = remove(S.tabs[tab].root, p)
    // Like herdr: closing a tab's last pane closes the tab.
    if (!S.tabs[tab].root) delete S.tabs[tab]
    // Which pane inherits the tab-local focus is herdr's choice; tests pick it with S.closeFocus.
    S.tabFocus ??= {}
    if (S.tabFocus[tab] === p) S.tabFocus[tab] = S.closeFocus ?? null
    if (S.focused === p) S.focused = S.closeFocus ?? undefined
    delete S.panes[p]
    delete S.agents[p]
    out({ type: 'ok' })
  }
  if (c === 'rename') out({ type: 'ok' })
}
if (g === 'tab' && c === 'create') {
  const tab = `w9:t${S.seq++}`
  const id = `w9:p${S.seq++}`
  S.tabs[tab] = { area: { ...Object.values(S.tabs)[0].area }, root: { pane: id }, label: flag('--label'), workspace: flag('--workspace') }
  S.panes[id] = { env: flags('--env'), cwd: flag('--cwd') }
  if (args.includes('--focus')) S.focused = id
  out({ tab: { tab_id: tab, label: flag('--label') }, root_pane: { pane_id: id, tab_id: tab } })
}
if (g === 'agent') {
  if (c === 'list') out({ agents: Object.keys(S.agents).map(agentInfo) })
  if (c === 'get') out({ agent: agentInfo(resolve(args[2])) })
  if (c === 'read') out(S.agents[resolve(args[2])].screen ?? '')
  if (c === 'rename') {
    S.agents[resolve(args[2])].name = args[3]
    out({ type: 'ok' })
  }
  if (c === 'focus') {
    S.focused = resolve(args[2])
    ;(S.tabFocus ??= {})[tabOf(S.focused)] = S.focused
    out({ type: 'ok' })
  }
  if (c === 'start') {
    const pane = flag('--pane')
    if (!S.panes[pane]) err('pane_not_found', pane)
    const rest = args.slice(args.indexOf('--') + 1)
    S.agents[pane] = { name: args[2], status: S.startStatus ?? 'idle', session: rest[rest.indexOf('--session-id') + 1], args: rest, cwd: S.panes[pane].cwd }
    if (S.agents[pane].status === 'blocked') err('agent_not_ready', 'blocked during startup')
    out({ agent: agentInfo(pane) })
  }
  if (c === 'prompt') {
    const pane = resolve(args[2])
    S.agents[pane].prompts = [...(S.agents[pane].prompts ?? []), args[3]]
    S.agents[pane].status = 'working'
    out({ agent: agentInfo(pane) })
  }
  if (c === 'wait') {
    const pane = resolve(args[2])
    if (S.agents[pane].status === 'working') advance(pane)
    out({ agent: agentInfo(pane) })
  }
  if (c === 'send-keys') {
    const pane = resolve(args[2])
    S.agents[pane].keys = [...(S.agents[pane].keys ?? []), ...args.slice(3)]
    advance(pane)
    out({ type: 'ok' })
  }
}
err('unknown', `fake herdr: unsupported ${args.join(' ')}`)
