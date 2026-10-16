// node --test hooks/test/ — require-push-approval.mjs (ask before any push / PR merge).
// Inputs go to the hook as JSON on stdin; nothing is run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CATCH, PASS } from "./cases.mjs";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../require-push-approval.mjs");
const REASON = "프로젝트 규칙: push/merge는 사용자 승인 필수 (auto push 금지)";

function run(command, extra = {}, hook = HOOK) {
  const r = spawnSync(process.execPath, [hook], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: tmpdir(), ...extra }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const decision = (cmd, extra, hook) => run(cmd, extra, hook)?.permissionDecision ?? "none";

for (const [group, cmds] of Object.entries(CATCH)) {
  test(`asks: ${group}`, () => { for (const cmd of cmds) assert.equal(decision(cmd), "ask", cmd); });
}
for (const [group, cmds] of Object.entries(PASS)) {
  test(`does not ask: ${group}`, () => { for (const cmd of cmds) assert.equal(decision(cmd), "none", cmd); });
}

test("decision reason and bypass/dontAsk refusal are unchanged", () => {
  const out = run("git push origin feat/x");
  assert.equal(out.permissionDecision, "ask");
  assert.equal(out.permissionDecisionReason, REASON);
  assert.equal(out.hookEventName, "PreToolUse");
  for (const mode of ["bypassPermissions", "dontAsk"]) assert.equal(decision("git push", { permission_mode: mode }), "deny", mode);
  for (const mode of ["default", "acceptEdits", "plan", "auto"]) assert.equal(decision("git push", { permission_mode: mode }), "ask", mode);
});

test("without the shell reader the hook falls back to the whole-text check", () => {
  const dir = mkdtempSync(join(tmpdir(), "push-approval-"));
  try {
    const lone = join(dir, "require-push-approval.mjs");
    copyFileSync(HOOK, lone); // no lib/ next to it: the import fails
    assert.equal(decision("git push", {}, lone), "ask");
    assert.equal(decision('echo "git push"', {}, lone), "ask"); // old behaviour: any mention asks
    assert.equal(decision("ls", {}, lone), "none");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unreadable input is ignored", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});
