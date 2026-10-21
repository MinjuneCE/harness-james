// node --test hooks/test/ — require-pane-account.mjs (herdr panes made by a non-default profile carry it).
// Inputs go to the hook as JSON on stdin; nothing is run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../require-pane-account.mjs");
const WORK = "/x/.claude-alt";

function run(command, { dir = WORK, hook = HOOK } = {}) {
  const env = { ...process.env };
  delete env.CLAUDE_CONFIG_DIR;
  if (dir) env.CLAUDE_CONFIG_DIR = dir;
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir() }), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const decision = (cmd, opts) => run(cmd, opts)?.permissionDecision ?? "none";

const DENY = {
  "plain pane-making calls": [
    "herdr pane split w2:p1 --direction down",
    "herdr tab create --workspace w2 --label t --no-focus",
    "herdr workspace create --cwd /tmp",
    "herdr --session main pane split w2:p1",
    "env FOO=1 herdr pane split w2:p1 --direction right",
  ],
  "inside compound commands": [
    "cd /tmp && herdr pane split w2:p1 --direction down | tail -3",
    "P=$(herdr pane split w2:p1 --direction down | jq -r .result.pane.pane_id); herdr agent start x --kind claude --pane $P",
    "bash -c 'herdr tab create --label x'",
    "herdr pane split w2:p1 --env CLAUDE_CONFIG_DIR=/x; herdr tab create --label y",
  ],
  "path-invoked or unparsable (whole-text check)": [
    "/opt/homebrew/bin/herdr pane split w2:p1",
    'herdr pane split w2:p1 --direction down "',
  ],
};
const PASS = {
  "env given": [
    `herdr pane split w2:p1 --direction down --env CLAUDE_CONFIG_DIR=${WORK}`,
    'herdr tab create --label t --env "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR" --no-focus',
    "herdr workspace create --env=CLAUDE_CONFIG_DIR=/y",
    "herdr pane split w2:p1 --env CLAUDE_CONFIG_DIR=/home/u/.claude",
  ],
  "not a pane-making call": [
    "herdr agent start x --kind claude --pane w2:p1 -- --model claude-haiku-5-5",
    "herdr pane list",
    "herdr tab list | jq .",
    "herdr agent read w2:p1 --source visible",
  ],
  "only data mentions it": [
    'echo "herdr pane split w2:p1"',
    "grep -n 'herdr tab create' notes.md",
    "cat <<'EOF'\nherdr pane split w2:p1\nEOF",
  ],
  "remote herdr target": ["herdr --machine mini pane split w2:p1", "herdr --remote me@host tab create"],
};

for (const [group, cmds] of Object.entries(DENY)) {
  test(`denies: ${group}`, () => { for (const cmd of cmds) assert.equal(decision(cmd), "deny", cmd); });
}
for (const [group, cmds] of Object.entries(PASS)) {
  test(`passes: ${group}`, () => { for (const cmd of cmds) assert.equal(decision(cmd), "none", cmd); });
}

test("default profile (no CLAUDE_CONFIG_DIR) never denies", () => {
  for (const cmds of Object.values(DENY)) for (const cmd of cmds) assert.equal(decision(cmd, { dir: null }), "none", cmd);
});

test("the reason names the profile dir and the flag to add", () => {
  const out = run("herdr pane split w2:p1 --direction down");
  assert.equal(out.hookEventName, "PreToolUse");
  assert.match(out.permissionDecisionReason, /CLAUDE_CONFIG_DIR=\/x\/\.claude-alt 계정/);
  assert.match(out.permissionDecisionReason, /--env CLAUDE_CONFIG_DIR=\/x\/\.claude-alt 를 붙여/);
  assert.match(out.permissionDecisionReason, /herdr pane split로/);
});

test("without the shell reader the hook falls back to the whole-text check", () => {
  const dir = mkdtempSync(join(tmpdir(), "pane-account-"));
  try {
    const copy = join(dir, "require-pane-account.mjs");
    copyFileSync(HOOK, copy);
    assert.equal(decision("herdr tab create --label t", { hook: copy }), "deny");
    assert.equal(decision(`herdr tab create --label t --env CLAUDE_CONFIG_DIR=${WORK}`, { hook: copy }), "none");
    assert.equal(decision("herdr pane list", { hook: copy }), "none");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
