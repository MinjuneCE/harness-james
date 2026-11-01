// node --test hooks/test/ — verify-guard blind reads judged by path (lib/blind-paths.mjs).
// Builds a temp workspace (its own git repo with the calibration folder committed, a separate target repo, a mirror,
// two run folders, symlinks into the calibration folder) and feeds tool calls to the hook as JSON, as a verify agent
// (agent_type). Nothing is run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DENY, PASS, UNREGISTERED } from "./verify-guard.blind.cases.mjs";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../verify-guard.mjs");
const PARENT = realpathSync(mkdtempSync(join(tmpdir(), "vg-blind-")));
const ROOT = join(PARENT, "ws");
const OWN = "demo-1111111-20261016-120000";
const OTHER = "demo-2222222-20261015-120000";
const SID = "0b5e2c1a-1d2e-4f30-8a4b-5c6d7e8f9a0b";
const HOME = process.env.HOME;
const JUDGE = "harness-james:verify-judge";
after(() => rmSync(PARENT, { recursive: true, force: true }));

const w = (p, s = "x\n") => { mkdirSync(dirname(join(ROOT, p)), { recursive: true }); writeFileSync(join(ROOT, p), s); };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
before(() => {
  w("docs/evaluation/config/guard.json", JSON.stringify({ blind: [
    { path: "notes/review.md", why: "리뷰 결과" },
    { path: "notes", prefix: "gap-", why: "결함 분석" },
    { path: "notes/briefs", why: "작업 지시서" },
  ] }));
  for (const f of ["notes/review.md", "notes/gap-proposal.md", "notes/gap-gates.md", "notes/GAP-gates.md", "notes/gap-trace.md", "notes/other.md", "notes/briefs/common.md"]) w(f);
  for (const f of ["docs/evaluation/calibration/README.md", "docs/evaluation/calibration/notes.md", "docs/evaluation/rubrics/SEC.md", "docs/evaluation/framework.md", "docs/evaluation/profiles/demo.json", "docs/sdd/x.md", "src/a.js", "qa/eval/calibration/x.json", "qa/eval/rubrics/SEC.md"]) w(f);
  mkdirSync(ROOT, { recursive: true });
  git(ROOT, "init", "-q", "-b", "main");
  git(ROOT, "add", "-A");
  git(ROOT, "commit", "-q", "-m", "base");
  w("docs/sdd/x.md", "y\n");
  git(ROOT, "commit", "-q", "-am", "second");
  for (const f of [".verify/tasks/eval-sec.md", ".verify/crosscheck/review-a.md", `.verify/runs/${OWN}/context.json`, `.verify/runs/${OWN}/judgments/SEC.json`, `.verify/runs/${OWN}/head/src/a.js`, `.verify/runs/${OWN}/base/src/a.js`, `.verify/runs/${OTHER}/judgments/TEST.json`, `.verify/runs/${OTHER}/head/src/a.js`, ".verify/mirror/m1/src/a.js", "sample-api/src/main/a.java"]) w(f);
  for (const repo of [".verify/mirror/m1", "sample-api"]) { git(join(ROOT, repo), "init", "-q", "-b", "main"); git(join(ROOT, repo), "add", "-A"); git(join(ROOT, repo), "commit", "-q", "-m", "r"); }
  w(`.verify/sessions/${SID}.json`, JSON.stringify({ session_id: SID, runs: [{ run_dir: `.verify/runs/${OTHER}` }, { run_dir: `.verify/runs/${OWN}` }] }));
  symlinkSync(join(ROOT, "docs/evaluation/calibration"), join(ROOT, `.verify/runs/${OWN}/head/link`));
  symlinkSync(join(ROOT, "docs"), join(ROOT, "alias"));
});

const fill = (s) => s.replaceAll("@ROOT", ROOT).replaceAll("@NAME", basename(ROOT)).replaceAll("@OWN", OWN).replaceAll("@OTHER", OTHER).replaceAll("@HOME", HOME);
const fillInput = (o) => JSON.parse(fill(JSON.stringify(o)));
function run(c, { sid = SID, agent_type = JUDGE, env = {} } = {}) {
  const [tool_name, tool_input] = typeof c === "string" ? ["Bash", { command: fill(c) }] : [c[0], fillInput(c[1])];
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name, tool_input, cwd: ROOT, ...(sid ? { session_id: sid } : {}), ...(agent_type ? { agent_type } : {}) }),
    encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT, VERIFY_EVAL_DIR: "", VERIFY_GUARD_SESSIONS_DIR: "", ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: "none", reason: "" };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}
const label = (c) => (typeof c === "string" ? c : JSON.stringify(c));

for (const [group, cases] of Object.entries(DENY)) {
  test(`blind deny: ${group}`, () => {
    for (const c of cases) { const r = run(c); assert.equal(r.decision, "deny", `${label(c)} → ${r.decision}`); }
  });
}
test("blind pass: own run, repos, rubrics, names, scoped git", () => {
  for (const c of PASS) { const r = run(c); assert.equal(r.decision, "none", `${label(c)} → ${r.reason}`); }
});
test("blind: reasons name the blocked location", () => {
  assert.match(run("grep -rn TODO .").reason, /재귀 범위가 차단 위치\(보정 자료\)/);
  assert.match(run("cat .verify/runs/@OTHER/judgments/TEST.json").reason, /다른 \/pr-verify 실행/);
  assert.match(run(["Read", { file_path: "@ROOT/.verify/runs/@OTHER/judgments/TEST.json" }]).reason, /다른 \/pr-verify 실행/);
  assert.match(run("git log -p").reason, /pathspec 없음/);
  assert.match(run('cd "$X" && grep -rn TODO .').reason, /값을 모르는 cd/);
});
test("every verify role is judged; other agents and the main session are not", () => {
  for (const t of ["harness-james:verify-orchestrator", "harness-james:verify-refuter", "harness-james:verify-explorer", "verify-judge"]) {
    assert.equal(run("cat .verify/runs/@OTHER/judgments/TEST.json", { agent_type: t }).decision, "deny", t);
    assert.equal(run("cat .verify/runs/@OWN/judgments/SEC.json", { agent_type: t }).decision, "none", t);
  }
  for (const t of [null, "general-purpose", "harness-james:skill-check-judge"]) {
    for (const c of ["cat docs/evaluation/calibration/README.md", "grep -rn TODO .", ["Read", { file_path: "@ROOT/.verify/runs/@OTHER/judgments/TEST.json" }]]) {
      assert.equal(run(c, { agent_type: t, sid: null }).decision, "none", `${t} ${label(c)}`);
    }
  }
});
test("no registered run: .verify/runs closed with the reason, names visible", () => {
  for (const sid of [null, "not-a-uuid", "99999999-9999-4999-8999-999999999999"]) {
    for (const c of UNREGISTERED.deny) {
      const r = run(c, { sid });
      assert.equal(r.decision, "deny", `${sid} ${label(c)}`);
      assert.match(r.reason, /등록된 실행이? 없음|session_id/, `${sid} ${label(c)}`);
    }
    for (const c of UNREGISTERED.pass) assert.equal(run(c, { sid }).decision, "none", `${sid} ${label(c)}`);
  }
});
test("registry location override (hook env only) is honored and protected", () => {
  const alt = join(PARENT, "alt-sessions");
  mkdirSync(alt, { recursive: true });
  writeFileSync(join(alt, `${SID}.json`), JSON.stringify({ runs: [{ run_dir: `.verify/runs/${OTHER}` }] }));
  const env = { VERIFY_GUARD_SESSIONS_DIR: alt };
  assert.equal(run("cat .verify/runs/@OTHER/judgments/TEST.json", { env }).decision, "none");
  assert.equal(run("cat .verify/runs/@OWN/judgments/SEC.json", { env }).decision, "deny");
  assert.equal(run(["Write", { file_path: join(alt, "x.json"), content: "{}" }], { env }).decision, "deny");
});
test("eval dir: VERIFY_EVAL_DIR moves the blocked calibration folder (path rule and text net)", () => {
  const env = { VERIFY_EVAL_DIR: "qa/eval" };
  for (const c of [
    "cat qa/eval/calibration/x.json",
    "cat qa/eval/cal''ibration/x.json",
    "cat qa/eval/cal*/x.json",
    "cd qa/eval && cat calibration/x.json",
    "grep -rn TODO qa",
    "node -e \"require('fs').readFileSync('qa/eval/calibration/x.json')\"",
    ["Read", { file_path: "@ROOT/qa/eval/calibration/x.json" }],
    ["Glob", { pattern: "qa/eval/**" }],
  ]) assert.equal(run(c, { env }).decision, "deny", label(c));
  for (const c of ["cat qa/eval/rubrics/SEC.md", "ls qa/eval", "grep -rn TODO qa/eval/rubrics", "cat docs/evaluation/calibration/README.md"]) {
    const r = run(c, { env });
    assert.equal(r.decision, "none", `${label(c)} → ${r.reason}`);
  }
});
