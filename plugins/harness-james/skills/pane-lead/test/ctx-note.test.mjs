import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { decide } from '../hooks/ctx-note.mjs'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'ctx-note.mjs')

function setup(input = 520_000) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-note-'))
  const tp = join(dir, 't.jsonl')
  writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 0, cache_read_input_tokens: input, output_tokens: 1 } } }) + '\n')
  return { dir, tp, env: { PATH: process.env.PATH, PANE_LEAD_STATE_DIR: join(dir, 'state'), PANE_LEAD_ROLE: 'main' } }
}

function hook(env, input, args = []) {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [HOOK, ...args], { env, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8' })
  return { ...r, ms: Date.now() - t0 }
}

const ev = (tp, name) => ({ hook_event_name: name, transcript_path: tp, session_id: 'sess-1' })

test('decide: role, threshold, events', () => {
  const u = p => ({ percent: p })
  assert.equal(decide({ input: { hook_event_name: 'UserPromptSubmit' }, usage: u(70), env: {} }).out, '')
  assert.equal(decide({ input: { hook_event_name: 'UserPromptSubmit' }, usage: u(49), env: { PANE_LEAD_ROLE: 'main' } }).out, '')
  assert.equal(decide({ input: { hook_event_name: 'Stop' }, usage: u(70), env: { PANE_LEAD_ROLE: 'main' } }).out, '')
  const r = decide({ input: { hook_event_name: 'UserPromptSubmit' }, usage: u(57), lastStep: 55, env: { PANE_LEAD_ROLE: 'main' } })
  assert.deepEqual(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: '컨텍스트 57%' } })
  assert.equal(r.step, 55)
})

test('decide: PostToolUse only on a new 5%p step', () => {
  const env = { PANE_LEAD_ROLE: 'main' }
  const at = (p, last) => decide({ input: { hook_event_name: 'PostToolUse' }, usage: { percent: p }, lastStep: last, env })
  assert.notEqual(at(50, undefined).out, '')
  assert.equal(at(54, 50).out, '')
  assert.equal(JSON.parse(at(55, 50).out).hookSpecificOutput.additionalContext, '컨텍스트 55%')
  assert.equal(JSON.parse(at(55, 50).out).hookSpecificOutput.hookEventName, 'PostToolUse')
  assert.equal(at(56, 55).out, '')
})

test('process: sub role prints nothing, exit 0', () => {
  const { tp, env } = setup()
  const r = hook({ ...env, PANE_LEAD_ROLE: 'sub' }, ev(tp, 'UserPromptSubmit'))
  assert.equal(r.status, 0)
  assert.equal(r.stdout, '')
})

test('process: main ≥50% → one JSON line; PostToolUse de-duplicated per step', () => {
  const { tp, env } = setup(520_000)
  const a = hook(env, ev(tp, 'UserPromptSubmit'))
  assert.equal(a.status, 0)
  assert.equal(JSON.parse(a.stdout).hookSpecificOutput.additionalContext, '컨텍스트 52%')
  assert.ok(a.ms < 1000, `slow: ${a.ms}ms`)
  assert.equal(hook(env, ev(tp, 'PostToolUse')).stdout, '') // step 50 already told by UserPromptSubmit
  assert.match(hook(env, ev(tp, 'UserPromptSubmit')).stdout, /컨텍스트 52%/) // prompts always
  writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { cache_read_input_tokens: 610_000, output_tokens: 1 } } }) + '\n')
  assert.match(hook(env, ev(tp, 'PostToolUse')).stdout, /컨텍스트 61%/)
  assert.equal(hook(env, ev(tp, 'PostToolUse')).stdout, '')
})

test('process: under threshold, small window env simulates ≥50%', () => {
  const { tp, env } = setup(5_000)
  assert.equal(hook(env, ev(tp, 'UserPromptSubmit')).stdout, '')
  assert.match(hook({ ...env, PANE_LEAD_CTX_WINDOW: '8000' }, ev(tp, 'UserPromptSubmit')).stdout, /컨텍스트 63%/)
})

test('process: toggle off/on/status', () => {
  const { tp, env } = setup()
  assert.equal(hook(env, '', ['status']).stdout.trim(), 'ctx-note: on')
  assert.equal(hook(env, '', ['off']).stdout.trim(), 'ctx-note: off')
  assert.ok(existsSync(join(env.PANE_LEAD_STATE_DIR, 'ctx-note.off')))
  assert.equal(hook(env, ev(tp, 'UserPromptSubmit')).stdout, '')
  assert.equal(hook(env, '', ['on']).stdout.trim(), 'ctx-note: on')
  assert.match(hook(env, ev(tp, 'UserPromptSubmit')).stdout, /컨텍스트/)
})

test('process: bad input or missing transcript → silent exit 0', () => {
  const { env } = setup()
  for (const input of ['not json', '{}', JSON.stringify({ hook_event_name: 'UserPromptSubmit', transcript_path: '/nope.jsonl' })]) {
    const r = hook(env, input)
    assert.equal(r.status, 0)
    assert.equal(r.stdout, '')
    assert.equal(r.stderr, '')
  }
})
