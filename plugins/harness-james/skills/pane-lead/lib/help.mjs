export const TOP = `pane-lead: one main Claude pane + up to 5 sub panes per lineage, on herdr.
Output: one JSON line ({"ok":true,...} | {"ok":false,"error","next"} exit 1; usage errors exit 2).

  main [--prefix p]                      start the main Claude in this (empty shell) pane
  spawn <name> --brief <path> [--kind k] [--run] [--fable] [--model fable|opus]
                                         start a sub pane and hand it the brief (model: Opus; --fable: Fable until
                                         the account's Fable weekly limit is at 90%, then Opus)
  wait <name> [--timeout ms]             block until the sub is idle/done/blocked; prints its summary or dialog
  approve <name> [--always] [--over-classifier] answer a blocked approval dialog with "Yes" (once)
  deny <name> [--message text]           answer "No"; --message tells the sub what to do instead
  switch <name> [--message text]         a sub at its Fable weekly limit dialog goes on with Opus in the same pane
  send <name> <text>                     reuse an idle sub (same deliverable, ctx < 50%)
  ctx [<name>|--self]                    context % of a sub/main or of the calling session
  status                                 lineage main/subs, state, ctx %, model, brief/result paths; the account's
                                         Fable weekly % and the next sub's model (plain, and with --fable)
  model-layer [on|off|status]            the Fable model layer of the pane-sub skill, for subs spawned from now on
  close <name> [--force]                 close a sub pane this lineage made
  handover --doc <path> [--tab label]    start the next main below this one (or in a new tab) and give it the doc
  takeover-done [--no-focus]             (new main) close the previous main, take its place

Every command but main reads the lineage from PANE_LEAD_PREFIX/PANE_LEAD_ROOT (set in the launch settings)
or --prefix. Panes this CLI starts get the caller's CLAUDE_CONFIG_DIR, so subs run on the main's account
(~/.claude counts as the default profile: no CLAUDE_CONFIG_DIR).
\`pane-lead <command> --help\` for options.`

export const CMDS = {
  main: `main [--prefix p] [--prompt text] [--dry-run]
  Run from an empty herdr shell pane. Execs: claude --model <M> --effort max -n <p>-main-<n> --session-id <id>
  --settings <lineage>/settings/<p>-main-<n>.json "/pane-lead start <p>". Names the herdr agent <p>-main-<n>.
  --dry-run prints the command and settings instead of running; it writes nothing (registry, settings, git exclude). PANE_LEAD_MODEL / PANE_LEAD_MAIN_EFFORT (none = omit) for experiments.`,
  spawn: `spawn <name> --brief <path> [--kind k] [--run] [--fable] [--model fable|opus] [--result path] [--cwd dir] [--prompt text] [--env NAME=value[,…]] [--extra-settings file]
  Cap: 5 open subs per lineage (error "cap"). Placement from herdr pane layout (main keeps >= 45% width).
  Default result: <root>/.research/out/<name>.md. --extra-settings deep-merges a JSON file into the sub settings (tests).
  --env adds env to this sub's settings (not the pane), for a skill that marks its subs (COLLAB_PROJECT for a project-sub).
  PANE_LEAD_*, GIT_CONFIG_* and CLAUDE_CONFIG_DIR cannot be set this way. The registry row keeps it as env.
  Model: claude-opus-5-5. --fable (only when the user asked for a Fable sub): claude-fable-5-2 while the account's
  Fable weekly limit is under 90%, unknown, or past its reset; from 90% claude-opus-5-5. --model fable|opus sets the
  model whatever the limit, and wins over --fable. No --effort is passed (each model's effort comes from the user's
  settings). The limit is read only for a --fable spawn, with a headless claude's get_usage (no model call), and
  kept for 5 minutes in <state>/fable-limit/<account>.json. The registry keeps model, modelReason and the reading;
  "sub" shows them.
  Start prompt: "/harness-james:pane-sub <normal|run> <fable|none> <brief> <result>" (the plugin's pane-sub skill,
  /pane-sub when pane-lead runs as a user skill; error "no-pane-sub" when the sub could not load it). --run: a run-kind sub that works with the user in its own pane, inside the brief's
  scope; without it the sub never asks the user. The layer is fable for a Fable sub unless model-layer is off.`,
  wait: `wait <name> [--timeout ms]   (run in the background from main; default: no timeout)
  idle/done → result-file summary (<= 15 lines) or the last screen lines; blocked → the dialog only.
  dialog.kind: permission | classifier | model-limit (the weekly limit's "Switch models?" dialog → switch).
  A result file still headed by its "진행:" line comes back with in_progress true and the screen tail; "limit" is
  set when that tail reads like a model-limit stop (no dialog left: close the sub, spawn --model opus). The tail
  leaves out the context band line and "work-trace:" notices. A run-kind sub waiting for the user's choice in its
  pane also comes back as done with in_progress true.`,
  approve: `approve <name> [--always] [--over-classifier]
  Only when herdr reports blocked and the screen holds a numbered dialog. Picks the option labelled exactly "Yes".
  --always picks "Yes, and don't ask again…" (only when the user said so).
  Refuses an auto-mode classifier escalation (dialog.kind "classifier") unless --over-classifier (user's explicit OK).`,
  deny: `deny <name> [--message text] [--esc]
  Picks "No" (the turn stops). --message then prompts the sub with text. --esc sends Esc instead.`,
  switch: `switch <name> [--message text]
  For a sub stopped at its model's weekly limit dialog. The screen must hold that dialog; picks its "Switch to …"
  option ("For this session"), so the same sub goes on with its context. The registry model becomes
  claude-opus-5-5 (modelBefore keeps the old one). --message is sent to the sub right after (it queues behind the
  step in progress).
  No such dialog on screen (closed, or the sub stopped with only a notice) → error; then close the sub and spawn an
  Opus one from its brief and result file (spawn --model opus). /model is not typed: it would save the model as the
  default for new sessions.`,
  'model-layer': `model-layer [on|off|status]
  The Fable model layer of the pane-sub skill (four rules for Fable subs). off: spawn passes layer "none" to Fable
  subs too. One file, <state>/model-layer.off. Subs already running keep the layer they were given.`,
  send: `send <name> <text> [--force]   prompt an idle/done sub again; refuses at ctx >= 50% unless --force`,
  ctx: `ctx [<name>|--self]`,
  status: `status [--no-ctx]
  fable: the main account's Fable weekly reading {account, percent, resets_at, checked_at, source}; account is
  default (no CLAUDE_CONFIG_DIR, or ~/.claude) | dir-<config dir>; source is cache | probe | stale (the probe
  failed; the last reading stands) | none. next_sub: {model, reason, layer} a spawn would use now, and with_fable:
  the same for a spawn --fable (Opus once the Fable weekly limit is at 90%).
  Sub rows carry model (the last response's, else the one spawn chose), run, layer, env (a spawn --env), and progress
  (the result file's "진행:" line while the sub works).`,
  close: `close <name> [--force]   refuses while the sub is working unless --force`,
  handover: `handover --doc <path> [--prompt text] [--tab label] [--config-dir dir]
  From the current main pane only. Splits it down, starts <p>-main-<n+1> (effort max, ctx hooks), submits
  "/pane-lead takeover <doc>" and returns. Finish the turn afterwards; the new main runs takeover-done.
  --tab opens the next main in a new tab with that label instead (no old area to fill).
  --config-dir moves the lineage to another Claude account profile (e.g. ~/.claude-other); the next main and
  every sub it spawns run there. Without it the next main keeps the caller's CLAUDE_CONFIG_DIR.
  --config-dir ~/.claude (realpath) is the default profile: the next main gets no CLAUDE_CONFIG_DIR. An inherited
  CLAUDE_CONFIG_DIR=~/.claude is dropped the same way (also for spawn and main).
  The new pane's screen is read after start: a theme picker or login screen (a profile without a login) stops it
  before the prompt with error "login-required" (data: pane, config_dir); the new pane is closed, pending cleared.
  "shell-busy": the new pane's shell never came up in ~8 s; the pane is closed, run handover again.
  With <root>/.research/pane-lead/attach.json naming a command for this prefix, its output is appended to the
  doc first as a "기계 계산" section (replaced on a rerun; failure = one-line note); "attach" reports it.`,
  'takeover-done': `takeover-done [--no-focus] [--timeout ms]
  From the new main pane. Waits for the previous main to be idle/done (default 600000 ms), closes its pane,
  focuses the new main only when the user is viewing the main's tab (else "focus" says why it was left alone;
  "tab_focus" = the pane herdr focuses inside that tab) and checks that the new pane took over the old area.`,
}
