import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SKILL_DIR, TEST_SESSION, WEIRD_BRANCH, cleanEnv, gitIn, makeWorkspace, prepare, run } from "./fixture.mjs";

let fx;
before(() => { fx = makeWorkspace(); });
after(() => fx.cleanup());

const ctxOf2 = (ws, out) => JSON.parse(readFileSync(join(ws, out.match(/^RUN_DIR=(.+)$/m)[1], "context.json"), "utf8"));
const ctxOf = (out) => ctxOf2(fx.ws, out);

test("위치 인자: 대상·base·자동 신호를 context.json에 남긴다", () => {
  const { ctx, code } = prepare(fx.ws);
  assert.equal(code, 0);
  assert.equal(ctx.target.branch, "feat/x");
  assert.equal(ctx.target.sha, gitIn(fx.repo, "rev-parse", "feat/x"));
  assert.equal(ctx.base.ref, "main");
  assert.deepEqual(ctx.diff.files.map((f) => [f.path, f.added_lines]), [["src/core/a.js", [5, 6, 7]]]);
  assert.deepEqual(ctx.signals.rule_findings.map((f) => [f.id, f.evidence[0].line]), [["R-no-eval", 6]]);
  assert.deepEqual(ctx.structures.filter((s) => s.touched).map((s) => [s.id, s.behavioral_lines]), [["demo.core", 3]]);
});

test("--args-stdin: 위치 인자와 같은 결과", () => {
  const r = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: "demo feat/x --no-fetch --season off\n" });
  assert.equal(r.code, 0, r.err);
  const ctx = ctxOf(r.out);
  assert.equal(ctx.target.branch, "feat/x");
  assert.equal(ctx.season.active, false);
});

test("--args-stdin: $·백틱·괄호가 든 브랜치 이름을 그대로 받는다", () => {
  const r = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: `demo ${WEIRD_BRANCH} --no-fetch\n` });
  assert.equal(r.code, 0, r.err);
  assert.equal(ctxOf(r.out).target.branch, WEIRD_BRANCH);
  assert.ok(!existsSync(join(fx.ws, "PWNED")));
});

test("SKILL.md 1단계 블록을 셸로 실행해도 인자가 확장되지 않는다", () => {
  const md = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const block = md.match(/```bash\n(node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/prepare\.mjs"[\s\S]*?)```/)[1];
  // Claude Code가 $ARGUMENTS·${CLAUDE_SKILL_DIR}·${CLAUDE_SESSION_ID}를 글자 그대로 바꿔 넣는 것을 흉내 낸다
  const cmd = block.replaceAll("${CLAUDE_SKILL_DIR}", SKILL_DIR).replaceAll("${CLAUDE_SESSION_ID}", TEST_SESSION).replace("$ARGUMENTS", `demo ${WEIRD_BRANCH} --no-fetch`);
  const r = spawnSync("sh", ["-c", cmd], { cwd: fx.ws, encoding: "utf8", env: cleanEnv({ VERIFY_WORKSPACE: fx.ws }) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(ctxOf(r.stdout).target.branch, WEIRD_BRANCH);
  assert.ok(!existsSync(join(fx.ws, "PWNED")));
});

// ---- hj-blind: 실행 등록(--session) ----
const regOf = (sid) => JSON.parse(readFileSync(join(fx.ws, ".verify/sessions", `${sid}.json`), "utf8"));
const runCount = () => (existsSync(join(fx.ws, ".verify/runs")) ? readdirSync(join(fx.ws, ".verify/runs")).length : 0);

test("--session: 실행을 세션에 등록하고, 가장 최근 실행이 마지막에 온다", () => {
  const sid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const a = run(fx.ws, "prepare.mjs", ["--session", sid, "demo", "feat/x", "--no-fetch"]);
  assert.equal(a.code, 0, a.err);
  const first = ctxOf(a.out).run_dir;
  assert.deepEqual(regOf(sid).runs.map((r) => r.run_dir), [first]);
  const b = run(fx.ws, "prepare.mjs", [`--session=${sid}`, "--args-stdin"], { input: "demo feat/x --no-fetch --base main" });
  assert.equal(b.code, 0, b.err);
  const second = ctxOf(b.out).run_dir;
  const reg = regOf(sid);
  assert.equal(reg.session_id, sid);
  assert.equal(reg.runs.at(-1).run_dir, second);
  assert.ok(second.startsWith(".verify/runs/"));
});

test("--session이 없거나 UUID가 아니면 실행 폴더를 만들기 전에 종료 코드 2", () => {
  const before = runCount();
  for (const args of [
    ["demo", "feat/x", "--no-fetch"],
    ["--session", "", "demo", "feat/x", "--no-fetch"],
    ["--session", "${CLAUDE_SESSION_ID}", "demo", "feat/x", "--no-fetch"], // 치환되지 않은 글자 그대로
    ["--session", "../../x", "demo", "feat/x", "--no-fetch"],
    ["--session", TEST_SESSION, "--session", TEST_SESSION, "demo", "feat/x", "--no-fetch"],
  ]) {
    const r = run(fx.ws, "prepare.mjs", args, { session: false });
    assert.equal(r.code, 2, JSON.stringify(args));
    assert.match(r.err, /세션 id를 받지 못함/);
  }
  assert.equal(runCount(), before);
  // 인자 원문(stdin)으로는 --session을 넘길 수 없다
  const viaStdin = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: `demo feat/x --no-fetch --session ${TEST_SESSION}`, session: false });
  assert.equal(viaStdin.code, 2);
});

test("SKILL.md 1단계 블록: 세션 id가 치환되지 않으면(셸이 빈 값으로 확장) 종료 코드 2", () => {
  const md = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  const block = md.match(/```bash\n(node "\$\{CLAUDE_SKILL_DIR\}\/scripts\/prepare\.mjs"[\s\S]*?)```/)[1];
  assert.match(block, /--session "\$\{CLAUDE_SESSION_ID\}"/);
  const cmd = block.replaceAll("${CLAUDE_SKILL_DIR}", SKILL_DIR).replace("$ARGUMENTS", "demo feat/x --no-fetch");
  const env = cleanEnv({ VERIFY_WORKSPACE: fx.ws });
  delete env.CLAUDE_SESSION_ID;
  const r = spawnSync("sh", ["-c", cmd], { cwd: fx.ws, encoding: "utf8", env });
  assert.equal(r.status, 2, r.stdout);
  assert.match(r.stderr, /세션 id를 받지 못함/);
});

test("오래된 세션 등록은 실행 정리와 함께 지운다", () => {
  const dir = join(fx.ws, ".verify/sessions");
  mkdirSync(dir, { recursive: true });
  const stale = join(dir, "99999999-9999-4999-8999-999999999999.json");
  writeFileSync(stale, JSON.stringify({ runs: [] }));
  const old = new Date(Date.now() - 40 * 86400e3);
  utimesSync(stale, old, old);
  assert.equal(prepare(fx.ws).code, 0);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(join(dir, `${TEST_SESSION}.json`)));
});

test("--args-stdin: 따옴표로 묶은 인자", () => {
  const r = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: `'demo' "feat/x" --base='main' --no-fetch` });
  assert.equal(r.code, 0, r.err);
  assert.equal(ctxOf(r.out).base.ref, "main");
});

test("--args-stdin 오류는 종료 코드 2", () => {
  assert.equal(run(fx.ws, "prepare.mjs", ["--args-stdin", "demo"]).code, 2);
  const unclosed = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: "demo 'feat/x" });
  assert.equal(unclosed.code, 2);
  assert.match(unclosed.err, /작은따옴표/);
  const unknown = run(fx.ws, "prepare.mjs", ["--args-stdin"], { input: "demo feat/x --bogus" });
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /알 수 없는 옵션/);
});

test("대상을 못 찾으면 2, 변경이 없으면 3", () => {
  assert.equal(run(fx.ws, "prepare.mjs", ["demo", "no-such-branch", "--no-fetch"]).code, 2);
  const same = run(fx.ws, "prepare.mjs", ["demo", "main", "--no-fetch"]);
  assert.equal(same.code, 3);
  assert.match(same.out, /^RUN_DIR=/m);
});

test("모델 정책 사전 점검: effort를 덮어쓰는 환경 변수가 있으면 2", () => {
  const r = run(fx.ws, "prepare.mjs", ["demo", "feat/x", "--no-fetch"], { env: { CLAUDE_CODE_EFFORT_LEVEL: "low" } });
  assert.equal(r.code, 2);
  assert.match(r.err, /CLAUDE_CODE_EFFORT_LEVEL/);
});

test("프로젝트 도구(kind module): 모듈의 자동 신호를 싣고, 없는 모듈·모르는 kind는 경고만 남긴다", () => {
  const r = run(fx.ws, "prepare.mjs", ["dtool", "feat/x", "--no-fetch", "--season", "off"]);
  assert.equal(r.code, 0, r.err);
  const ctx = ctxOf(r.out);
  assert.deepEqual(ctx.signals.tool_runs.map((x) => [x.tool, x.status]), [["lint", "ok"], ["missing", "error"]]);
  assert.deepEqual(ctx.signals.tool_findings.map((f) => [f.id, f.source, f.tool_id, f.evidence[0].line]), [["T-lint-eval", "tool", "lint", 6]]);
  assert.match(r.out, /⚠ 도구 missing 건너뜀: 모듈 없음/);
  assert.ok(ctx.warnings.some((w) => w.includes("알 수 없는 도구 kind: linter-x")));
});

test("데이터 위치: 프로젝트에 scoring·rubric·framework가 없으면 플러그인 기본값을 쓴다", () => {
  const w2 = makeWorkspace();
  try {
    for (const p of ["docs/evaluation/config", "docs/evaluation/rubrics", "docs/evaluation/framework.md"]) rmSync(join(w2.ws, p), { recursive: true, force: true });
    const { ctx, runDir } = prepare(w2.ws);
    const plugin = join(SKILL_DIR, "evaluation");
    assert.equal(ctx.versions.scoring.source_path, join(plugin, "config/scoring.json"));
    assert.equal(ctx.versions.framework.source_path, join(plugin, "framework.md"));
    assert.equal(ctx.versions.rubrics.SEC.source_path, join(plugin, "rubrics/SEC.md"));
    assert.equal(ctx.versions.profile.path, "docs/evaluation/profiles/demo.json");
    // 에이전트가 읽는 path는 RUN_DIR 안의 사본이고 내용이 원본과 같다 (플러그인 경로는 작업 폴더 밖이라 Read가 권한 확인에 걸림)
    for (const [v, rel] of [[ctx.versions.scoring, "config/scoring.json"], [ctx.versions.framework, "framework.md"], [ctx.versions.rubrics.SEC, "rubrics/SEC.md"], [ctx.versions.rubrics.REL, "rubrics/REL.md"]]) {
      assert.equal(v.path, `${ctx.run_dir}/evaluation/${rel}`);
      assert.equal(readFileSync(join(w2.ws, v.path), "utf8"), readFileSync(join(plugin, rel), "utf8"));
    }
    assert.ok(!existsSync(join(runDir, "evaluation/rubrics/PERF.md")), "적용하지 않는 차원의 rubric은 복사하지 않음");
  } finally { w2.cleanup(); }
});

test("데이터 위치: VERIFY_EVAL_DIR로 평가 폴더를 옮길 수 있다", () => {
  const w2 = makeWorkspace();
  try {
    mkdirSync(join(w2.ws, "qa"), { recursive: true });
    renameSync(join(w2.ws, "docs/evaluation"), join(w2.ws, "qa/eval"));
    const r = run(w2.ws, "prepare.mjs", ["demo", "feat/x", "--no-fetch", "--season", "off"], { env: { VERIFY_EVAL_DIR: "qa/eval" } });
    assert.equal(r.code, 0, r.err);
    const ctx = ctxOf2(w2.ws, r.out);
    assert.equal(ctx.versions.profile.path, "qa/eval/profiles/demo.json");
    assert.equal(ctx.versions.scoring.source_path, "qa/eval/config/scoring.json");
    assert.equal(ctx.versions.scoring.path, `${ctx.run_dir}/evaluation/config/scoring.json`);
    // 옮긴 뒤 기본 위치로는 못 찾는다
    assert.equal(run(w2.ws, "prepare.mjs", ["demo", "feat/x", "--no-fetch"], { env: { VERIFY_WORKSPACE: "" } }).code !== 0, true);
  } finally { w2.cleanup(); }
});

test("예시 프로파일(examples/profile.example.json)이 그대로 로드된다", () => {
  const w2 = makeWorkspace();
  try {
    const ex = JSON.parse(readFileSync(join(SKILL_DIR, "examples/profile.example.json"), "utf8"));
    ex.repo.path = "repos/demo";
    ex.repo.default_base = "main"; // 픽스처 레포에는 origin이 없다
    rmSync(join(w2.ws, "docs/evaluation/profiles"), { recursive: true, force: true });
    mkdirSync(join(w2.ws, "docs/evaluation/profiles"), { recursive: true });
    writeFileSync(join(w2.ws, "docs/evaluation/profiles/api.json"), JSON.stringify(ex));
    for (const p of ["docs/evaluation/config", "docs/evaluation/rubrics", "docs/evaluation/framework.md"]) rmSync(join(w2.ws, p), { recursive: true, force: true });
    const r = run(w2.ws, "prepare.mjs", ["api", "feat/x", "--no-fetch", "--season", "off"]);
    assert.equal(r.code, 0, r.err + r.out);
    const ctx = ctxOf2(w2.ws, r.out);
    assert.deepEqual(ctx.dimensions.map((d) => d.id), ["SEC", "PERF", "ARCH", "REL", "OPS", "TEST"]);
    assert.ok(ctx.signals.rule_findings.some((f) => f.id === "R-no-eval"));
  } finally { w2.cleanup(); }
});
