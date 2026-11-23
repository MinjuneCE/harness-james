// What a sub is told at start. The rules a sub reads live in the pane-sub skill (domain layer for every sub,
// model layer for Fable subs); spawn only calls it: `<pane-sub command> <kind> <layer> <brief> <result>`.
// In the plugin the command is /<plugin>:pane-sub and the skill is the sibling folder skills/pane-sub.
// What code enforces (push block, cap, model, no --effort) stays in this CLI.
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HOME, pluginName, skillCommand, stateDir } from './common.mjs'
import { accountDir } from './account.mjs'
import { isFable } from './fable-limit.mjs'

export const SUB_SKILL = 'pane-sub'
/** The slash command that loads pane-sub: /<plugin>:pane-sub inside a plugin, /pane-sub as a user or project skill. */
export const SUB_SKILL_CMD = skillCommand(HOME, SUB_SKILL)

/** normal: never asks the user (everything goes through "메인에게"). run: works with the user in its pane, inside the brief's scope. */
export const subKind = (f) => (f.run ? 'run' : 'normal')

// Model-layer switch (the model layer can be turned off on its own). One file, like the
// ctx-note toggle: while <state>/model-layer.off exists, spawn passes layer `none` to Fable subs too.
export const layerFile = (env = process.env) => join(stateDir(env), 'model-layer.off')

export function layerSwitch(cmd, env = process.env) {
  const f = layerFile(env)
  if (cmd === 'off') {
    mkdirSync(stateDir(env), { recursive: true })
    writeFileSync(f, `${new Date().toISOString()}\n`)
  } else if (cmd === 'on') {
    rmSync(f, { force: true })
  }
  return existsSync(f) ? 'off' : 'on'
}

/** The model layer a sub on `model` gets: `fable` for a Fable model while the switch is on, else `none`. */
export const layerFor = (model, env = process.env) => (isFable(model) && !existsSync(layerFile(env)) ? 'fable' : 'none')

// Skill arguments split on spaces; a path holding one is quoted.
const arg = (s) => (/[\s"']/.test(s) ? JSON.stringify(s) : s)

export const startPrompt = ({ kind, layer, brief, result }, cmd = SUB_SKILL_CMD) => `${cmd} ${kind} ${layer} ${arg(brief)} ${arg(result)}`

/**
 * Where the sub will find the pane-sub skill. Inside a plugin: the sibling folder skills/pane-sub of the same
 * plugin (the start prompt names /<plugin>:pane-sub, so only that copy counts). As a user skill: the account's user
 * skills, or a project skill above its cwd. null when none holds it. PANE_LEAD_SUB_SKILL_DIR names it outright and
 * alone (tests, a staging copy).
 */
export function findSubSkill({ configDir, cwd, env = process.env, home = HOME } = {}) {
  const dirs = []
  if (env.PANE_LEAD_SUB_SKILL_DIR) dirs.push(env.PANE_LEAD_SUB_SKILL_DIR)
  else if (pluginName(home)) dirs.push(join(home, '..', SUB_SKILL))
  else {
    dirs.push(join(accountDir(configDir) ?? join(homedir(), '.claude'), 'skills', SUB_SKILL))
    for (let d = cwd; d; d = join(d, '..') === d ? null : join(d, '..')) dirs.push(join(d, '.claude', 'skills', SUB_SKILL))
  }
  return dirs.find((d) => existsSync(join(d, 'SKILL.md'))) ?? null
}
