#!/usr/bin/env node
// Headless-claude stand-in for the get_usage probe (lib/fable-limit.mjs). Answers the control request with the
// JSON in $PANE_LEAD_FAKE_USAGE; each call is appended to <that file>.calls. No file → exits 1 like a profile
// without a login. { "hang": true } in the file → never answers (probe timeout).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'

const file = process.env.PANE_LEAD_FAKE_USAGE
if (file) appendFileSync(`${file}.calls`, JSON.stringify({ args: process.argv.slice(2), configDir: process.env.CLAUDE_CONFIG_DIR ?? null, role: process.env.PANE_LEAD_ROLE ?? null, cwd: process.cwd() }) + '\n')
if (!file || !existsSync(file)) {
  process.stderr.write('Not logged in · Please run /login\n')
  process.exit(1)
}
const usage = JSON.parse(readFileSync(file, 'utf8'))
let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  const nl = buf.indexOf('\n')
  if (nl < 0 || usage.hang) return
  const req = JSON.parse(buf.slice(0, nl))
  buf = buf.slice(nl + 1)
  // Like the real one: other frames first, then the answer.
  process.stdout.write(JSON.stringify({ type: 'system', subtype: 'hook_started' }) + '\n')
  if (usage.error) process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'error', request_id: req.request_id, error: usage.error } }) + '\n')
  else process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: req.request_id, response: usage } }) + '\n')
})
process.stdin.on('end', () => process.exit(0))
