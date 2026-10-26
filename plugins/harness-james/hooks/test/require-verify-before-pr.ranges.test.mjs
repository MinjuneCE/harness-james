// node --test hooks/test/ — PR 검증 게이트(require-verify-before-pr.mjs)의 장기 브랜치·검증 범위·worktree·clone 판정 (2026-10-23).
// 임시 워크스페이스에 레포·worktree·clone·리포트 index를 만들고, 명령 글자를 JSON으로 훅에 넣는다. 아무 명령도 실행하지 않는다.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../require-verify-before-pr.mjs");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "pr-gate-")));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const REPO = join(ROOT, "repos/demo");
const WT = join(ROOT, "repos/demo-wt");
const CLONE = join(ROOT, "elsewhere/demo-clone");
const PR = ["gh", "pr", "create"].join(" ");

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", VERIFY_EVAL_DIR: "", VERIFY_FM_BIN: "" };
const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env }).trim();
const w = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, typeof s === "string" ? s : JSON.stringify(s, null, 2)); };
const commit = (cwd, file, text, msg) => { w(join(cwd, file), text); git(cwd, "add", "-A"); git(cwd, "commit", "-q", "-m", msg); return git(cwd, "rev-parse", "HEAD"); };

const S = {};
before(() => {
  w(join(ROOT, "docs/evaluation/profiles/demo.json"), {
    repo: { key: "demo", name: "demo-svc", path: "repos/demo", github: "example/demo", default_base: "origin/main", aliases: ["demo"] },
    long_lived_branches: ["feat/long"],
  });
  mkdirSync(REPO, { recursive: true });
  git(REPO, "init", "-q", "-b", "main");
  S.fork = commit(REPO, "a.txt", "a\n", "base");
  git(REPO, "update-ref", "refs/remotes/origin/main", S.fork);
  git(REPO, "checkout", "-q", "-b", "feat/long");
  S.l1 = commit(REPO, "b.txt", "b1\n", "l1");
  S.l2 = commit(REPO, "c.txt", "c1\n", "l2");
  S.l3 = commit(REPO, "d.txt", "d1\n", "l3");
  git(REPO, "checkout", "-q", "-b", "feat/x", "main");
  S.x1 = commit(REPO, "x.txt", "x1\n", "x1");
  S.x2 = commit(REPO, "y.txt", "y1\n", "x2");
  // feat/x를 rebase한 것처럼: 같은 변경을 다른 부모 위에 다시 만든다
  git(REPO, "checkout", "-q", "-b", "feat/x-rebased", "main");
  S.r0 = commit(REPO, "z.txt", "z\n", "upstream");
  git(REPO, "update-ref", "refs/remotes/origin/next", S.r0);
  S.r1 = commit(REPO, "x.txt", "x1\n", "x1");
  S.r2 = commit(REPO, "y.txt", "y1\n", "x2");
  git(REPO, "checkout", "-q", "main");
  // worktree: git 디렉터리를 본 레포와 함께 쓴다(실험용 worktree를 따로 두는 모양)
  git(REPO, "worktree", "add", "-q", WT, "feat/long");
  // clone: 다른 곳, origin URL만 GitHub slug
  mkdirSync(dirname(CLONE), { recursive: true });
  execFileSync("git", ["clone", "-q", REPO, CLONE], { env });
  git(CLONE, "remote", "set-url", "origin", ["git", "github.com:example/demo.git"].join("@")); // SSH 모양 URL
  git(CLONE, "checkout", "-q", "feat/x");
});

const setIndex = (index) => w(join(ROOT, "docs/evaluation/reports/demo-svc/index.json"), { repo: "demo-svc", ...index });
const entry = (o) => ({ gate: "PASS", overall: 90, report: "r.md", json: "r.json", triggers: 0, block_reasons: 0, ...o });
function run(command, { cwd = ROOT, mode } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd, ...(mode ? { permission_mode: mode } : {}) }),
    encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: ROOT },
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: "none", reason: "" };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}

test("worktree에서 -R 없이 만든 PR도 게이트에 걸린다 (예전에는 그냥 지나감)", () => {
  setIndex({ by_sha: {} });
  const r = run(`${PR} --title t --body b`, { cwd: WT });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /demo-svc feat\/long@/);
  assert.match(r.reason, /--full/);
});

test("장기 브랜치: 증분 PASS 리포트로는 통과하지 않고, 전체 모드 + base = 갈림점이면 통과", () => {
  setIndex({ by_sha: { [S.l3]: entry({ mode: "incremental", base_sha: S.l2, fork_point: S.fork }) }, ranges: [{ base: S.l2, head: S.l3, mode: "incremental" }] });
  const inc = run(PR, { cwd: WT });
  assert.equal(inc.decision, "ask");
  assert.match(inc.reason, /증분/);
  assert.match(inc.reason, /\/harness-james:verify demo feat\/long --full/);
  assert.match(inc.reason, /어느 검증 범위에도 안 든 커밋 2개/);

  setIndex({ by_sha: { [S.l3]: entry({ mode: "full", base_sha: S.fork, fork_point: S.fork }) }, ranges: [{ base: S.fork, head: S.l3, mode: "full" }] });
  assert.equal(run(PR, { cwd: WT }).decision, "none");
  // -H로 이름을 주면 공유 체크아웃에서도 같은 판정
  assert.equal(run(`${PR} -H feat/long`, { cwd: REPO }).decision, "none");
});

test("장기 브랜치: 모드가 full이어도 base가 갈림점이 아니면 ask (fork_point만 맞아도 안 됨)", () => {
  setIndex({ by_sha: { [S.l3]: entry({ mode: "full", base_sha: S.l2, fork_point: S.fork }) } });
  const r = run(PR, { cwd: WT });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /검증 base [0-9a-f]{7} ≠ 갈림점/);
});

test("장기 브랜치 + 전체 모드라도 REVIEW_REQUIRED면 지금 규칙대로 ask", () => {
  setIndex({ by_sha: { [S.l3]: entry({ gate: "REVIEW_REQUIRED", triggers: 2, mode: "full", base_sha: S.fork, fork_point: S.fork }) } });
  const r = run(PR, { cwd: WT });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /REVIEW_REQUIRED/);
});

test("보통 브랜치: PASS는 통과, REVIEW_REQUIRED는 ask + 검증 범위 밖 커밋 정보", () => {
  setIndex({ by_sha: { [S.x2]: entry({}) } });
  assert.equal(run(`${PR} -H feat/x`, { cwd: REPO }).decision, "none");
  setIndex({ by_sha: { [S.x2]: entry({ gate: "REVIEW_REQUIRED", base_sha: S.x1 }) }, ranges: [{ base: S.x1, head: S.x2 }] });
  const r = run(`${PR} -H feat/x`, { cwd: REPO });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /PR base main\.\.head 2커밋 중 어느 검증 범위에도 안 든 커밋 1개/);
});

test("예전 index(ranges·base_sha 없음)는 리포트 json의 base.merge_base로 범위를 메운다", () => {
  w(join(ROOT, "old.json"), { base: { merge_base: S.fork } });
  setIndex({ by_sha: { [S.x2]: entry({ gate: "BLOCK", block_reasons: 1, json: "old.json" }) } });
  const r = run(`${PR} -H feat/x`, { cwd: REPO });
  assert.equal(r.decision, "ask");
  assert.doesNotMatch(r.reason, /어느 검증 범위에도/);
});

test("rebase로 SHA가 바뀐 커밋은 patch-id로 검증 범위에 맞춘다", () => {
  setIndex({ by_sha: { [S.r2]: entry({ gate: "BLOCK", block_reasons: 1 }) }, ranges: [{ base: S.fork, head: S.x2 }] });
  const r = run(`${PR} -H feat/x-rebased -B next`, { cwd: REPO });
  assert.equal(r.decision, "ask");
  assert.doesNotMatch(r.reason, /어느 검증 범위에도/);
  const none = run(`${PR} -H feat/x-rebased`, { cwd: REPO });
  assert.match(none.reason, /3커밋 중 어느 검증 범위에도 안 든 커밋 1개 \(rebase로 바뀐 2개는 patch-id로 맞춤\)/);
});

test("다른 곳의 clone은 origin URL slug로 프로파일을 찾는다", () => {
  setIndex({ by_sha: {} });
  const r = run(PR, { cwd: CLONE });
  assert.equal(r.decision, "ask");
  assert.match(r.reason, /demo-svc feat\/x@/);
});

test("-R slug는 그대로 쓰고, 프로파일에 없는 레포는 관여하지 않는다", () => {
  setIndex({ by_sha: {} });
  assert.equal(run(`${PR} -R example/demo -H feat/x`).decision, "ask");
  assert.equal(run(`${PR} -R https://github.com/example/demo.git -H feat/x`).decision, "ask");
  assert.equal(run(`${PR} -R other/repo -H feat/x`).decision, "none");
  const outside = mkdtempSync(join(tmpdir(), "pr-gate-out-"));
  try { assert.equal(run(PR, { cwd: outside }).decision, "none"); } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("bypassPermissions·dontAsk에서는 ask 대신 deny", () => {
  setIndex({ by_sha: {} });
  for (const mode of ["bypassPermissions", "dontAsk"]) assert.equal(run(PR, { cwd: WT, mode }).decision, "deny");
  assert.equal(run(PR, { cwd: WT, mode: "default" }).decision, "ask");
});

test("피처맵: 프로파일에 feature_map이 있으면 VERIFY_FM_BIN의 도구로 낡은 기능 개수를, 도구가 없으면 그 사실을 정보로 붙인다", () => {
  const pPath = join(ROOT, "docs/evaluation/profiles/demo.json");
  const before = JSON.parse(readFileSync(pPath, "utf8"));
  // 가짜 fm-check: 받은 --json 파일에 feature-stale 하나와 feature-uncovered 하나를 쓴다
  const fmBin = join(ROOT, "fm-bin");
  w(join(fmBin, "fm-check.mjs"), `import { writeFileSync } from "node:fs";
const a = process.argv.slice(2);
writeFileSync(a[a.indexOf("--json") + 1], JSON.stringify({ version: 1, tool: "feature-map", status: "ok", items: [
  { kind: "feature-stale", severity: "WARN", symbol: "001-x" }, { kind: "feature-uncovered", severity: "WARN", symbol: "y.txt" }] }));
`);
  w(pPath, { ...before, feature_map: "fmap" });
  const gate = (extra) => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command: `${PR} -R example/demo -H feat/x` }, cwd: ROOT }),
      encoding: "utf8", env: { ...env, CLAUDE_PROJECT_DIR: ROOT, ...extra },
    });
    return JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;
  };
  try {
    setIndex({ by_sha: {} });
    const reason = gate({ VERIFY_FM_BIN: fmBin });
    assert.match(reason, /검증 리포트 없음/);
    assert.match(reason, /\[정보\] 피처맵 낡음 1개\(001-x\)\.$/);
    // 위치 설정이 없거나 파일이 없으면 낡음은 세지 않고 그 사실만 적는다
    assert.match(gate({}), /\[정보\] 프로파일에 feature_map이 있지만 피처맵 검사 도구 위치\(VERIFY_FM_BIN\)가 설정되지 않아 낡음을 세지 않음\.$/);
    assert.match(gate({ VERIFY_FM_BIN: join(ROOT, "no-bin") }), /\[정보\] 피처맵 검사 도구 없음\(.*no-bin\/fm-check\.mjs\)/);
    // feature_map이 없는 프로파일에는 피처맵 정보가 붙지 않는다
    w(pPath, before);
    assert.doesNotMatch(gate({}), /피처맵/);
  } finally {
    w(pPath, before);
  }
});
