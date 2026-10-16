// node --test hooks/test/ — require-verify-before-pr.mjs: the PR gate acts only in repos a profile registers.
// It is a plugin hook, so it fires in every repo; outside registered repos it must stay silent.
// Throwaway repos in the OS temp dir; nothing is pushed or created. Inputs go to the hook as JSON on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../require-verify-before-pr.mjs");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "verify-gate-")));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

// workspace: <ws>/repo (git) + optional profile at <ws>/<evalRel>/profiles/r.json
function workspace(name, evalRel) {
  const ws = join(TMP, name), repo = join(ws, "repo");
  mkdirSync(repo, { recursive: true });
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  g("init", "-q", "-b", "feat/x");
  g("-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  if (evalRel) {
    mkdirSync(join(ws, evalRel, "profiles"), { recursive: true });
    writeFileSync(join(ws, evalRel, "profiles/r.json"), JSON.stringify({ repo: { name: "r", path: "repo", github: "o/r", aliases: ["r"] } }));
  }
  const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  return { ws, repo, sha };
}
function gate({ ws, repo }, { env = {}, mode = "default", command = "gh pr create --title t --body b" } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: repo, permission_mode: mode }), encoding: "utf8",
    env: { ...process.env, VERIFY_EVAL_DIR: "", CLAUDE_PROJECT_DIR: ws, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput : { permissionDecision: "none" };
}
const report = ({ ws, sha }, evalRel, gateValue) => {
  mkdirSync(join(ws, evalRel, "reports/r"), { recursive: true });
  writeFileSync(join(ws, evalRel, "reports/r/index.json"), JSON.stringify({ by_sha: { [sha]: { gate: gateValue, overall: 80, triggers: 1, block_reasons: 1, report: "x.md" } } }));
};

test("unregistered repos: no profiles, or a profile for another repo → silent", () => {
  const none = workspace("none");
  assert.equal(gate(none).permissionDecision, "none");
  const other = workspace("other", "docs/evaluation");
  writeFileSync(join(other.ws, "docs/evaluation/profiles/r.json"), JSON.stringify({ repo: { name: "r", path: "elsewhere", github: "o/r", aliases: ["r"] } }));
  assert.equal(gate(other).permissionDecision, "none");
});

test("registered repo, default location: no report asks; PASS passes; REVIEW_REQUIRED asks", () => {
  const w = workspace("default", "docs/evaluation");
  const r = gate(w);
  assert.equal(r.permissionDecision, "ask");
  assert.match(r.permissionDecisionReason, /검증 리포트 없음/);
  assert.equal(gate(w, { mode: "bypassPermissions" }).permissionDecision, "deny");
  report(w, "docs/evaluation", "PASS");
  assert.equal(gate(w).permissionDecision, "none");
  report(w, "docs/evaluation", "REVIEW_REQUIRED");
  assert.match(gate(w).permissionDecisionReason, /REVIEW_REQUIRED/);
  assert.equal(gate(w, { command: "gh pr view 1" }).permissionDecision, "none");
});

test("moved eval dir (VERIFY_EVAL_DIR): the gate follows the profile; without the variable the repo is unregistered", () => {
  const w = workspace("moved", "qa/eval");
  const env = { VERIFY_EVAL_DIR: "qa/eval" };
  assert.equal(gate(w, { env }).permissionDecision, "ask");
  assert.equal(gate(w).permissionDecision, "none");
  report(w, "qa/eval", "PASS");
  assert.equal(gate(w, { env }).permissionDecision, "none");
  report(w, "qa/eval", "BLOCK");
  assert.match(gate(w, { env }).permissionDecisionReason, /BLOCK/);
});
