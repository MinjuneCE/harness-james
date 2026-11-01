// node --test hooks/test/ — the plugin's guard hooks fail closed: onFailure "block" on every guard in hooks/hooks.json.
// Without it, a guard that cannot start (no node, wrong path), exits with a code other than 0/2 or times out lets
// the call through (code.claude.com/docs/en/hooks "Block the action when a hook fails", Claude Code 2.1.295+).
// A guard = a synchronous command/http hook on a gating event (PreToolUse, PermissionRequest, UserPromptSubmit).
// Plugin hooks run as `command: "node"` + `args: ["${CLAUDE_PLUGIN_ROOT}/…"]`; the script must exist, because with
// "block" a wrong path stops every matching call. The pane-lead sub settings have their own test (skills/pane-lead).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const HOOKS_JSON = resolve(PLUGIN, "hooks/hooks.json");
const GATES = new Set(["PreToolUse", "PermissionRequest", "UserPromptSubmit"]);

function* hooksOf(config) {
  for (const [event, groups] of Object.entries(config.hooks ?? {}))
    for (const g of groups ?? []) for (const h of g.hooks ?? []) yield { event, matcher: g.matcher ?? "", h };
}
const isGuard = (event, h) => GATES.has(event) && (h.type === "command" || h.type === "http") && !h.async && !h.asyncRewake;
// The docs list where onFailure does nothing: async/asyncRewake hooks and these events.
const NO_EFFECT = new Set(["Stop", "SubagentStop", "TaskCompleted", "TeammateIdle"]);
const noEffect = (event, h) => h.async || h.asyncRewake || NO_EFFECT.has(event);
const expand = (p) => p.replace(/\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT\b/g, PLUGIN);

// The script a command hook runs: the first args entry for `command: "node"`, or the word after node/bash/sh in a command string.
function scriptOf(h) {
  if (/^(node|bash|sh|zsh)$/.test(h.command ?? "") && Array.isArray(h.args) && h.args.length) return expand(h.args[0]);
  const m = /(?:^|\s)(?:node|bash|sh|zsh)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(h.command ?? "");
  const p = m && (m[1] ?? m[2] ?? m[3]);
  return p ? expand(p) : null;
}
const nameOf = (h) => /hooks\/([\w-]+)\.mjs/.exec(scriptOf(h) ?? "")?.[1];

function guardProblems(config) {
  const out = [];
  for (const { event, matcher, h } of hooksOf(config)) {
    const label = `${event}[${matcher}] ${nameOf(h) ?? h.command ?? h.url}`;
    // Keep onFailure off where it does nothing, so the file does not promise a block it cannot give.
    if (noEffect(event, h) && h.onFailure !== undefined) out.push(`onFailure has no effect here: ${label}`);
    if (!isGuard(event, h)) continue;
    if (h.onFailure !== "block") out.push(`no onFailure "block": ${label}`);
    if (h.type === "command") {
      const p = scriptOf(h);
      if (!p || !existsSync(p)) out.push(`script not found (${p}): ${label}`);
    }
  }
  return out;
}

const config = JSON.parse(readFileSync(HOOKS_JSON, "utf8"));

test("hooks.json: every guard hook has onFailure block and an existing script", () => {
  assert.deepEqual(guardProblems(config), []);
});

test("hooks.json: the guards are wired where expected", () => {
  const wired = [...hooksOf(config)].filter(({ event, h }) => isGuard(event, h)).map(({ matcher, h }) => `${matcher} ${nameOf(h)}`);
  const want = [
    "Bash require-push-approval",
    "Bash require-verify-before-pr",
    "Bash require-pr-flow",
    "Bash require-pane-account",
    "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob|Agent|Task verify-guard",
  ];
  for (const w of want) assert.ok(wired.includes(w), `${w} missing; wired: ${wired.join(", ")}`);
  assert.equal(wired.length, want.length, `unexpected guards: ${wired.join(", ")}`);
});

test("the check catches a missing onFailure, a wrong script path and onFailure where it has no effect", () => {
  const hook = (extra) => ({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/require-pr-flow.mjs"], timeout: 10, ...extra });
  const of = (event, h) => ({ hooks: { [event]: [{ matcher: "Bash", hooks: [h] }] } });
  assert.deepEqual(guardProblems(of("PreToolUse", hook({ onFailure: "block" }))), []);
  assert.match(guardProblems(of("PreToolUse", hook({})))[0], /no onFailure "block"/);
  assert.match(guardProblems(of("PreToolUse", hook({ onFailure: "continue" })))[0], /no onFailure "block"/);
  const typo = hook({ onFailure: "block", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/require-pr-flw.mjs"] });
  assert.match(guardProblems(of("PreToolUse", typo))[0], /script not found/);
  assert.match(guardProblems(of("PreToolUse", hook({ onFailure: "block", async: true })))[0], /no effect/);
  assert.match(guardProblems(of("Stop", hook({ onFailure: "block" })))[0], /no effect/);
  assert.deepEqual(guardProblems(of("PostToolUse", hook({}))), [], "non-gating events are not guards");
  assert.deepEqual(guardProblems(of("UserPromptSubmit", { type: "http", url: "http://127.0.0.1:1/x", onFailure: "block" })), []);
  assert.match(guardProblems(of("PermissionRequest", { type: "http", url: "http://127.0.0.1:1/x" }))[0], /no onFailure "block"/);
});
