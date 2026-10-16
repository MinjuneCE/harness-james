#!/usr/bin/env node
// Stable `pane-lead` command for the plugin install. The plugin cache path changes with every version,
// so this shim reads Claude Code's install record and runs the pane-lead CLI of the version installed now.
//   node <this file> --install [dir]   copy this shim to <dir>/pane-lead (default ~/.local/bin)
//   pane-lead <command> ...            (after --install) forwards to <installPath>/skills/pane-lead/bin/pane-lead.mjs
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const PLUGIN = process.env.PANE_LEAD_PLUGIN || 'harness-james'
const argv = process.argv.slice(2)

if (argv[0] === '--install') {
  const dir = argv[1] || join(homedir(), '.local', 'bin')
  mkdirSync(dir, { recursive: true })
  const to = join(dir, 'pane-lead')
  copyFileSync(fileURLToPath(import.meta.url), to)
  chmodSync(to, 0o755)
  console.log(JSON.stringify({ ok: true, installed: to, next: `make sure ${dir} is on PATH` }))
  process.exit(0)
}

/** installPath of PLUGIN@<any marketplace>; user scope first, newest lastUpdated wins. */
function findInstall(record, plugin = PLUGIN) {
  const entries = Object.entries(record?.plugins ?? {})
    .filter(([k]) => k.split('@')[0] === plugin)
    .flatMap(([, list]) => list)
    .filter((e) => e?.installPath)
  entries.sort((a, b) => (a.scope === 'user') - (b.scope === 'user') || String(a.lastUpdated).localeCompare(String(b.lastUpdated)))
  return entries.at(-1)?.installPath ?? null
}

function fail(error, next) {
  console.log(JSON.stringify({ ok: false, error, next }))
  process.exit(1)
}

const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
const recordPath = join(configDir, 'plugins', 'installed_plugins.json')
let record
try { record = JSON.parse(readFileSync(recordPath, 'utf8')) } catch { fail(`cannot read ${recordPath}`, `install the ${PLUGIN} plugin first (claude plugin install ${PLUGIN}@<marketplace>)`) }
const base = findInstall(record)
if (!base) fail(`${PLUGIN} is not in ${recordPath}`, `claude plugin install ${PLUGIN}@<marketplace>`)
const cli = join(base, 'skills', 'pane-lead', 'bin', 'pane-lead.mjs')
if (!existsSync(cli)) fail(`missing ${cli}`, 'claude plugin update, or reinstall the plugin')
const r = spawnSync(process.execPath, [cli, ...argv], { stdio: 'inherit' })
process.exit(r.status ?? 1)
