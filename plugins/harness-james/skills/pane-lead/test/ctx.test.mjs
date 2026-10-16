import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_WINDOW, contextUsage, findTranscript, windowFor, windowInfo } from '../lib/ctx.mjs'
import { ctxNoteHooks } from '../lib/ctx-hooks.mjs'

const asst = (model, input, cc, cr, out, extra = {}) => ({
  type: 'assistant',
  message: { model, usage: { input_tokens: input, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out } },
  ...extra,
})

function transcript(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'pl-ctx-'))
  const p = join(dir, 's.jsonl')
  writeFileSync(p, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  return p
}

test('percent uses the input side of the last response (band basis)', () => {
  const p = transcript([
    { type: 'user', message: { content: 'hi' } },
    asst('claude-opus-5-5', 10, 1000, 100_000, 50),
    { type: 'user', message: { content: 'next' } },
    asst('claude-opus-5-5', 5, 2000, 172_892, 860),
    { type: 'system', subtype: 'turn_duration' },
    { type: 'ai-title', title: 'x' },
  ])
  const u = contextUsage(p, { env: {} })
  assert.equal(u.used, 174_897)
  assert.equal(u.window, 1_000_000)
  assert.equal(u.percent, 17)
  assert.equal(u.pending, 860)
  assert.equal(u.model, 'claude-opus-5-5')
  assert.equal(u.windowKnown, true)
})

test('pending adds trailing tool results at chars/4; metadata entries ignored', () => {
  const big = 'x'.repeat(40_000)
  const p = transcript([
    asst('claude-opus-5-5', 0, 0, 500_000, 100),
    { type: 'user', message: { content: [{ type: 'tool_result', content: big }] } },
    { type: 'permission-mode', mode: 'auto' },
  ])
  const u = contextUsage(p, { env: {} })
  assert.equal(u.percent, 50)
  assert.ok(u.pending > 10_000 && u.pending < 10_200, String(u.pending))
  assert.equal(u.projectedPercent, 51)
})

test('sidechain and synthetic assistant entries are skipped', () => {
  const p = transcript([
    asst('claude-opus-5-5', 0, 0, 300_000, 1),
    asst('claude-opus-5-5', 0, 0, 900_000, 1, { isSidechain: true }),
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0 } } },
  ])
  assert.equal(contextUsage(p, { env: {} }).percent, 30)
})

test('compaction after the last response makes the usage stale', () => {
  const p = transcript([
    asst('claude-opus-5-5', 0, 0, 900_000, 1),
    { type: 'system', subtype: 'compact_boundary' },
    { type: 'user', isCompactSummary: true, message: { content: 'y'.repeat(4000) } },
  ])
  const u = contextUsage(p, { env: {} })
  assert.equal(u.compacted, true)
  assert.equal(u.used, 1000)
  assert.equal(u.percent, 0)
})

test('tail read grows until a response is found; first partial line dropped', () => {
  const pad = { type: 'user', message: { content: 'z'.repeat(600_000) } }
  const p = transcript([asst('claude-opus-5-5', 0, 0, 420_000, 1), pad])
  const u = contextUsage(p, { env: {}, tailBytes: 1024 })
  assert.equal(u.percent, 42)
})

test('no response yet / missing file → undefined', () => {
  assert.equal(contextUsage(transcript([{ type: 'user', message: { content: 'a' } }]), { env: {} }), undefined)
  assert.equal(contextUsage('/nonexistent/x.jsonl'), undefined)
})

test('windowFor: table, env override, conservative default flagged', () => {
  assert.equal(windowFor('claude-opus-5-5', {}), 1_000_000)
  assert.deepEqual(windowInfo('claude-haiku-5-5', {}), { window: 1_000_000, known: true, source: 'table' })
  assert.equal(windowInfo('claude-sonnet-5-5', {}).known, false) // unmeasured: stays on the default
  assert.equal(windowInfo('claude-fable-5-1', {}).known, false)
  assert.equal(windowFor('claude-sonnet-5-5[1m]', {}), 1_000_000)
  assert.deepEqual(windowInfo('claude-mystery-9', {}), { window: DEFAULT_WINDOW, known: false, source: 'default' })
  assert.equal(windowFor('claude-opus-5-5', { PANE_LEAD_CTX_WINDOW: '1000' }), 1000)
  const p = transcript([asst('claude-mystery-9', 0, 0, 100_000, 1)])
  assert.equal(contextUsage(p, { env: {} }).windowKnown, false)
})

test('findTranscript: cwd guess and full scan', () => {
  const root = mkdtempSync(join(tmpdir(), 'pl-proj-'))
  const id = 'abc-123'
  mkdirSync(join(root, '-Users-x-p-q'))
  writeFileSync(join(root, '-Users-x-p-q', `${id}.jsonl`), '')
  assert.equal(findTranscript(id, { projectsDir: root, cwd: '/Users/x/p.q' }), join(root, '-Users-x-p-q', `${id}.jsonl`))
  assert.equal(findTranscript(id, { projectsDir: root }), join(root, '-Users-x-p-q', `${id}.jsonl`))
  assert.equal(findTranscript('nope', { projectsDir: root }), undefined)
  assert.equal(findTranscript('../etc', { projectsDir: root }), undefined)
})

test('ctxNoteHooks shape', () => {
  const h = ctxNoteHooks("/opt/it's/pane-lead")
  assert.deepEqual(Object.keys(h), ['UserPromptSubmit', 'PostToolUse'])
  assert.equal(h.PostToolUse[0].matcher, '*')
  assert.equal(h.UserPromptSubmit[0].hooks[0].command, `node '/opt/it'\\''s/pane-lead/hooks/ctx-note.mjs'`)
  assert.equal(h.UserPromptSubmit[0].hooks[0].timeout, 5)
  assert.match(ctxNoteHooks().PostToolUse[0].hooks[0].command, /pane-lead\/hooks\/ctx-note\.mjs'$/)
})

test('contextUsage: PANE_LEAD_CTX_WINDOW applies only to the own session (self), never to a measured sub (C-3)', () => {
  const p = transcript([{ type: 'assistant', message: { model: 'claude-opus-5-5', usage: { input_tokens: 50_000, output_tokens: 1 } } }])
  const env = { PANE_LEAD_CTX_WINDOW: '100000' }
  assert.equal(contextUsage(p, { env, self: true }).percent, 50)
  assert.equal(contextUsage(p, { env }).percent, 5)
  assert.equal(contextUsage(p, { env }).window, 1_000_000)
})
