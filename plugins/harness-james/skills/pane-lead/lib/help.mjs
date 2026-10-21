export const TOP = `pane-lead: one main Claude pane + up to 5 sub panes per lineage, on herdr.
Output: one JSON line ({"ok":true,...} | {"ok":false,"error","next"} exit 1; usage errors exit 2).

  main [--prefix p]                      start the main Claude in this (empty shell) pane
  spawn <name> --brief <path> [--kind k] start a sub pane and hand it the brief
  wait <name> [--timeout ms]             block until the sub is idle/done/blocked; prints its summary or dialog
  approve <name> [--always] [--over-classifier] answer a blocked approval dialog with "Yes" (once)
  deny <name> [--message text]           answer "No"; --message tells the sub what to do instead
  send <name> <text>                     reuse an idle sub (same deliverable, ctx < 50%)
  ctx [<name>|--self]                    context % of a sub/main or of the calling session
  status                                 lineage main/subs, state, ctx %, brief/result paths
  close <name> [--force]                 close a sub pane this lineage made
  handover --doc <path> [--tab label]    start the next main below this one (or in a new tab) and give it the doc
  takeover-done [--no-focus]             (new main) close the previous main, take its place

Every command but main reads the lineage from PANE_LEAD_PREFIX/PANE_LEAD_ROOT (set in the launch settings)
or --prefix. Panes this CLI starts get the caller's CLAUDE_CONFIG_DIR, so subs run on the main's account.
\`pane-lead <command> --help\` for options.`

export const CMDS = {
  main: `main [--prefix p] [--prompt text] [--dry-run]
  Run from an empty herdr shell pane. Execs: claude --model <M> --effort max -n <p>-main-<n> --session-id <id>
  --settings <lineage>/settings/<p>-main-<n>.json "/pane-lead start <p>". Names the herdr agent <p>-main-<n>.
  --dry-run prints the command and settings instead of running; it writes nothing (registry, settings, git exclude). PANE_LEAD_MODEL / PANE_LEAD_MAIN_EFFORT (none = omit) for experiments.`,
  spawn: `spawn <name> --brief <path> [--kind k] [--result path] [--cwd dir] [--prompt text] [--extra-settings file]
  Cap: 5 open subs per lineage (error "cap"). Placement from herdr pane layout (main keeps >= 45% width).
  Default result: <root>/.research/out/<name>.md. --extra-settings deep-merges a JSON file into the sub settings (tests).`,
  wait: `wait <name> [--timeout ms]   (run in the background from main; default: no timeout)
  idle/done → result-file summary (<= 15 lines) or the last screen lines; blocked → the dialog only.`,
  approve: `approve <name> [--always]
  Only when herdr reports blocked and the screen holds a numbered dialog. Picks the option labelled exactly "Yes".
  --always picks "Yes, and don't ask again…" (only when the user said so).
  Refuses an auto-mode classifier escalation (dialog.kind "classifier") unless --over-classifier (user's explicit OK).`,
  deny: `deny <name> [--message text] [--esc]
  Picks "No" (the turn stops). --message then prompts the sub with text. --esc sends Esc instead.`,
  send: `send <name> <text> [--force]   prompt an idle/done sub again; refuses at ctx >= 50% unless --force`,
  ctx: `ctx [<name>|--self]`,
  status: `status [--no-ctx]`,
  close: `close <name> [--force]   refuses while the sub is working unless --force`,
  handover: `handover --doc <path> [--prompt text] [--tab label] [--config-dir dir]
  From the current main pane only. Splits it down, starts <p>-main-<n+1> (effort max, ctx hooks), submits
  "/pane-lead takeover <doc>" and returns. Finish the turn afterwards; the new main runs takeover-done.
  --tab opens the next main in a new tab with that label instead (no old area to fill).
  --config-dir moves the lineage to another Claude account profile (e.g. ~/.claude-alt); the next main and
  every sub it spawns run there. Without it the next main keeps the caller's CLAUDE_CONFIG_DIR.`,
  'takeover-done': `takeover-done [--no-focus] [--timeout ms]
  From the new main pane. Waits for the previous main to be idle/done (default 600000 ms), closes its pane,
  focuses the new main only when the user is viewing the main's tab (else "focus" says why it was left alone;
  "tab_focus" = the pane herdr focuses inside that tab) and checks that the new pane took over the old area.`,
}
