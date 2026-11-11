// node --test hooks/test/ — role-switch-guard.mjs (no SendMessage to the main of a pane-collab role switched off).
// The switch is the project file <root>/.loop/collab/config.json, read through skills/pane-collab/lib/config.mjs
// (the same module the collab CLI uses). Inputs go to the hook as JSON on stdin; nothing is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../role-switch-guard.mjs");
// The session env may carry a real workspace (pane-lead main, collab settings); the hook must only see the temp project.
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COLLAB_|PANE_LEAD_|CLAUDE_PROJECT_DIR$)/.test(k)));

function project(config) {
  const root = mkdtempSync(join(tmpdir(), "role-switch-"));
  mkdirSync(join(root, ".loop/collab"), { recursive: true });
  if (config !== undefined) writeFileSync(join(root, ".loop/collab/config.json"), typeof config === "string" ? config : JSON.stringify(config));
  return root;
}

function decide(root, to, { env = { CLAUDE_PROJECT_DIR: root }, cwd = root } = {}) {
  const input = JSON.stringify({ tool_name: "SendMessage", tool_input: { to, message: "x" }, cwd });
  const r = spawnSync(process.execPath, [HOOK], { input, encoding: "utf8", env: { ...CLEAN, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

test("denies a SendMessage to the main of a role switched off", () => {
  const root = project({ _설명: "x", roles: { impl: true, pm: false } });
  const d = decide(root, "pm-main-3");
  assert.equal(d.permissionDecision, "deny");
  assert.match(d.permissionDecisionReason, /^pm 역할은 지금 꺼져 있어요\(pane-collab 설정 \.loop\/collab\/config\.json의 roles/);
  assert.equal(decide(root, "pm-main-12 [a1b2c3]").permissionDecision, "deny");
  assert.equal(decide(root, "scn-main-2"), null);
});

test("lets through mains of roles that are on, names that are not mains, and socket addresses", () => {
  const root = project({ roles: { impl: true, pm: false } });
  for (const to of ["impl-main-17", "xyzimpl-main-14", "infra-main-9", "pm", "pmx-main-1", "uds:/tmp/cc-socks/1.sock", "main", ""]) assert.equal(decide(root, to), null, to);
});

test("does nothing without a project config, when every role is on, or when the config is broken", () => {
  assert.equal(decide(project(undefined), "pm-main-3"), null);
  assert.equal(decide(project({ roles: { pm: true } }), "pm-main-3"), null);
  assert.equal(decide(project("{not json"), "pm-main-3"), null);
  assert.equal(decide(project("[]"), "pm-main-3"), null);
  assert.equal(decide(project({ roles: { pm: "off" } }), "pm-main-3"), null, "a non-boolean switch is ignored, not read as off");
});

test("project roles and lineages: an added role and its own lineage are guarded too", () => {
  const root = project({ roles: { design: false }, lineages: { dsg: "design" } });
  assert.match(decide(root, "dsg-main-1").permissionDecisionReason, /^design 역할은 지금 꺼져 있어요/);
  assert.equal(decide(root, "impl-main-1"), null);
});

test("old lineage names (oldLineages) are guarded too, until their mains hand over to the new name", () => {
  const root = project({ roles: { qa: false }, oldLineages: { tester: "qa" } });
  assert.equal(decide(root, "qa-main-14").permissionDecision, "deny");
  assert.equal(decide(root, "tester-main-13").permissionDecision, "deny");
  assert.match(decide(root, "tester-main-13").permissionDecisionReason, /^qa 역할은 지금 꺼져 있어요/);
  assert.equal(decide(root, "scn-main-8"), null);
});

test("finds the project from the hook input cwd when CLAUDE_PROJECT_DIR is not set (nearest .loop/collab above it)", () => {
  const root = project({ roles: { pm: false } });
  const nested = join(root, "apps/web");
  mkdirSync(nested, { recursive: true });
  assert.equal(decide(root, "pm-main-3", { env: {}, cwd: nested }).permissionDecision, "deny");
  // the CLI's own override works for the hook as well (same module)
  const other = project(undefined);
  assert.equal(decide(other, "pm-main-3", { env: { COLLAB_CONFIG: join(root, ".loop/collab/config.json") } }).permissionDecision, "deny");
});
