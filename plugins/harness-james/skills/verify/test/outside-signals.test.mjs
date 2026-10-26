// diff 밖 신호 (2026-10-23): 전체 모드, diff 밖 결정적 신호, 복제본, 프로파일 점검, 이어 돌리기, index 범위 장부, base 근거 출처.
// 신호 도구는 test/fake-signal-bin의 가짜를 VERIFY_SIGNAL_BIN으로 끼운다.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { SKILL_DIR, TEST_SESSION, finding, gitIn, makeWorkspace, readJsonFile, run, writeJudgment, writeRefutation } from "./fixture.mjs";

const BIN = join(SKILL_DIR, "test/fake-signal-bin");
let fx, log, S = {};
before(() => {
  fx = makeWorkspace();
  log = join(fx.ws, "signal-calls.log");
  const repo = fx.repo;
  // main에 build.gradle(→ reach 대상), feat/long: a.js 3줄 지움 + 5줄 고침 + old.js 추가 (커밋 둘)
  writeFileSync(join(repo, "build.gradle"), "// fixture\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "gradle");
  S.fork = gitIn(repo, "rev-parse", "main");
  gitIn(repo, "checkout", "-q", "-b", "feat/long", "main");
  const a = readFileSync(join(repo, "src/core/a.js"), "utf8").split("\n");
  writeFileSync(join(repo, "src/core/a.js"), a.filter((_, i) => i !== 2).join("\n"));
  gitIn(repo, "commit", "-q", "-am", "drop v3");
  S.mid = gitIn(repo, "rev-parse", "HEAD");
  mkdirSync(join(repo, "lib"), { recursive: true });
  writeFileSync(join(repo, "lib/util.js"), "export const u = 1;\nexport const w = 2;\n");
  writeFileSync(join(repo, "src/core/old.js"), "export class Old {}\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "add old + util");
  S.head = gitIn(repo, "rev-parse", "HEAD");
  gitIn(repo, "checkout", "-q", "-b", "merge/preview", "feat/long");
  gitIn(repo, "checkout", "-q", "main");
  // 복제본 레포(다른 프로파일)
  const other = join(fx.ws, "repos/other");
  mkdirSync(join(other, "ext/src"), { recursive: true });
  gitIn(other, "init", "-q", "-b", "dev");
  writeFileSync(join(other, "ext/src/status.js"), "// replica of a.js\n");
  writeFileSync(join(other, "ext/src/other.txt"), "x\n");
  gitIn(other, "add", "-A");
  gitIn(other, "commit", "-q", "-m", "r");
  const pPath = join(fx.ws, "docs/evaluation/profiles/demo.json");
  const p = readJsonFile(pPath);
  p.structures.push({ id: "demo.ghost", name: "없는 경로", criticality: 50, paths: ["nowhere/**"] });
  p.long_lived_branches = ["feat/long"];
  p.ledgers = [{ branches: ["feat/long"], plan: "docs/design/plan.md", tasks: "docs/design/tasks.md", docs: ["docs/design/*.md"] }];
  p.dependents = [{ source: "src/core/**", replicas: [{ repo: "other", path: "ext/src/*.js" }, { repo: "nope", path: "x.js" }], note: "판정 상수 복제" }];
  writeFileSync(pPath, JSON.stringify(p, null, 2));
  writeFileSync(join(fx.ws, "docs/evaluation/profiles/other.json"), JSON.stringify({
    ...p, repo: { key: "other", name: "demo-other", path: "repos/other", github: "example/other", default_base: "dev", aliases: ["other"], traits: ["client"] },
    structures: [], rules: [], long_lived_branches: [], ledgers: [], dependents: [],
  }, null, 2));
});
after(() => fx.cleanup());

const env = (extra = {}) => ({ VERIFY_SIGNAL_BIN: BIN, FAKE_SIGNAL_LOG: log, ...extra });
function prep(args, extra) {
  const r = run(fx.ws, "prepare.mjs", [...args, "--no-fetch", "--season", "off"], { env: env(extra) });
  const m = r.out.match(/^RUN_DIR=(.+)$/m);
  assert.ok(m, `prepare 실패 (${r.code}): ${r.err}${r.out}`);
  const runDir = join(fx.ws, m[1]);
  return { ...r, runDir, rel: m[1], ctx: readJsonFile(join(runDir, "context.json")) };
}

test("전체 모드: base = 갈림점, 신호 넷(merge-ref 포함)을 갈림점 기준으로 돌려 signals/에 둔다", () => {
  const r = prep(["demo", "feat/long", "--full", "--merge-ref", "merge/preview"]);
  assert.equal(r.code, 0, r.err);
  const c = r.ctx;
  assert.equal(c.mode, "full");
  assert.equal(c.fork_point, S.fork);
  assert.equal(c.base.merge_base, S.fork);
  const tools = Object.fromEntries(c.outside_signals.tools.map((t) => [t.tool, t]));
  assert.deepEqual(Object.keys(tools), ["reach", "ledger", "co-change", "reach-compare"]);
  for (const t of Object.values(tools)) assert.equal(t.status, "ok", `${t.tool} ${t.note}`);
  assert.deepEqual(c.outside_signals.counts, { total: 5, FAIL: 1, WARN: 3, INFO: 1 });
  for (const t of ["reach", "ledger", "co-change", "reach-compare"]) assert.ok(existsSync(join(r.runDir, "signals", `${t}.json`)), t);
  // 도구가 받은 인자: 갈림점과 head, 장부 칸
  const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => [l.split(" ")[0], JSON.parse(l.slice(l.indexOf(" ") + 1))]);
  const reach = calls.find(([n]) => n === "reach")[1];
  assert.equal(reach[reach.indexOf("--base") + 1], S.fork);
  assert.equal(reach[reach.indexOf("--head") + 1], S.head);
  const ledger = calls.find(([n]) => n === "ledger")[1];
  assert.deepEqual([ledger[ledger.indexOf("--ledger") + 1], ledger[ledger.indexOf("--tasks") + 1], ledger[ledger.indexOf("--docs") + 1]], ["docs/design/plan.md", "docs/design/tasks.md", "docs/design/*.md"]);
  const cmp = calls.find(([n]) => n === "reach-compare")[1];
  assert.equal(cmp[cmp.indexOf("--b") + 1], gitIn(fx.repo, "rev-parse", "merge/preview"));
  // summary.md: 중립 머리말, 항목마다 근거 file:line, FAIL이 먼저
  const md = readFileSync(join(r.runDir, "signals/summary.md"), "utf8");
  assert.match(md, /도구가 찾은 diff 밖 사실과 근거예요\. 판정에 쓰려면 코드에서 확인해요/);
  assert.match(md, /- WARN orphaned-definition `demo\.Old#run` — .+\n  - head: `src\/core\/old\.js:2`\n  - base: `src\/core\/a\.js:3`/);
  assert.match(md, /- FAIL ledger-delete-remains `demo\.Old`[^\n]*\n  - head: `src\/core\/old\.js:1`\n  - 문서: `docs\/design\/plan\.md:7`/);
  assert.match(r.out, /모드: 전체  갈림점: [0-9a-f]{7}/);
});

test("summary.md: 도구 하나의 INFO가 많으면 종류별 개수만 싣고 WARN은 그대로", () => {
  const r = prep(["demo", "feat/long", "--full", "--merge-ref", "merge/preview"], { FAKE_SIGNAL_INFO: "12" });
  const md = readFileSync(join(r.runDir, "signals/summary.md"), "utf8");
  const sec = md.slice(md.indexOf("## reach-compare"));
  assert.match(sec, /- INFO 12건은 개수만 적어요: added-by-b 12/);
  assert.doesNotMatch(sec, /demo\.New0/);
  assert.match(sec, /- WARN definition-revived `demo\.Old`/);
  assert.match(md.slice(md.indexOf("## reach —"), md.indexOf("## ledger")), /- INFO test-only-public `demo\.Old#x`/); // 1건이면 그대로
});

test("전체 모드에 --base를 따로 주면 갈림점과 다를 때 경고", () => {
  const r = prep(["demo", "feat/long", "--full", "--base", S.mid]);
  assert.equal(r.ctx.mode, "full");
  assert.equal(r.ctx.base.merge_base, S.mid);
  assert.equal(r.ctx.fork_point, S.fork);
  assert.ok(r.ctx.warnings.some((w) => /전체 모드인데 base.+갈림점.+다름/.test(w)), r.ctx.warnings.join("\n"));
});

test("--merge-ref는 --full과 같이만, 없는 ref면 2", () => {
  assert.equal(run(fx.ws, "prepare.mjs", ["demo", "feat/long", "--no-fetch", "--merge-ref", "merge/preview"], { env: env() }).code, 2);
  assert.equal(run(fx.ws, "prepare.mjs", ["demo", "feat/long", "--no-fetch", "--full", "--merge-ref", "no/such"], { env: env() }).code, 2);
});

test("증분 실행도 같은 신호를 갈림점 기준으로 한 번 더 돌린다(누적)", () => {
  const r = prep(["demo", "feat/long", "--base", S.mid]);
  assert.equal(r.ctx.mode, "incremental");
  assert.equal(r.ctx.base.merge_base, S.mid);
  assert.equal(r.ctx.outside_signals.base, S.fork);
  assert.deepEqual(r.ctx.outside_signals.tools.map((t) => [t.tool, t.status]), [["reach", "ok"], ["ledger", "ok"], ["co-change", "ok"]]);
  const md = readFileSync(join(r.runDir, "signals/summary.md"), "utf8");
  assert.match(md, /증분 범위 밖 누적/);
  assert.match(md, /이 실행의 diff는 `[0-9a-f]{7}`부터예요/);
});

test("신호 도구가 실패해도 실행은 계속하고 status error와 경고를 남긴다", () => {
  const r = prep(["demo", "feat/long", "--full"], { FAKE_SIGNAL_FAIL: "reach" });
  assert.equal(r.code, 0, r.err);
  const reach = r.ctx.outside_signals.tools.find((t) => t.tool === "reach");
  assert.equal(reach.status, "error");
  assert.match(reach.note, /종료 코드 3: 컴파일 실패\(가짜\)/);
  assert.ok(r.ctx.warnings.some((w) => w.startsWith("신호 reach 실패")));
  assert.equal(r.ctx.outside_signals.tools.find((t) => t.tool === "ledger").status, "ok");
  // 도구가 아예 없을 때
  const none = prep(["demo", "feat/long", "--full"], { VERIFY_SIGNAL_BIN: join(fx.ws, "no-bin") });
  assert.ok(none.ctx.outside_signals.tools.filter((t) => t.status !== "skipped").every((t) => t.status === "error" && /도구 없음/.test(t.note)));
  // 도구 위치를 설정하지 않았을 때(플러그인 기본): 경고만 남기고 판정 준비는 끝까지 간다
  const unset = prep(["demo", "feat/long", "--full"], { VERIFY_SIGNAL_BIN: "" });
  assert.equal(unset.code, 0, unset.err);
  const ran = unset.ctx.outside_signals.tools.filter((t) => t.status !== "skipped");
  assert.ok(ran.length && ran.every((t) => t.status === "error" && /도구 위치 설정 안 됨: VERIFY_SIGNAL_BIN/.test(t.note)), JSON.stringify(ran));
  assert.ok(unset.ctx.warnings.some((w) => /^신호 reach 실패 — 이 신호 없이 진행: 도구 위치 설정 안 됨/.test(w)));
  assert.equal(unset.ctx.outside_signals.bin, null);
  assert.ok(existsSync(join(unset.runDir, "signals/summary.md")));
});

test("장부·dependents·Gradle이 없으면 skipped로 남긴다", () => {
  const r = prep(["demo", "feat/x"]);
  assert.deepEqual(r.ctx.outside_signals.tools.map((t) => [t.tool, t.status]), [["reach", "skipped"], ["ledger", "skipped"], ["co-change", "ok"]]);
  assert.match(r.ctx.outside_signals.tools[0].note, /Gradle 레포 아님/);
  assert.match(r.ctx.outside_signals.tools[1].note, /ledgers에 feat\/x 없음/);
});

test("SHA 대상은 그 커밋을 품은 장부 브랜치의 장부를 쓴다", () => {
  const r = prep(["demo", S.mid]);
  assert.equal(r.ctx.target.branch, null);
  assert.equal(r.ctx.outside_signals.tools.find((t) => t.tool === "ledger").status, "ok");
});

test("coverage_ignore에 걸린 경로는 '구조에 안 걸린 변경 파일' 경고에서 뺀다", () => {
  const pPath = join(fx.ws, "docs/evaluation/profiles/demo.json");
  const before = readFileSync(pPath, "utf8");
  writeFileSync(pPath, JSON.stringify({ ...JSON.parse(before), coverage_ignore: ["lib/**"] }, null, 2));
  try {
    const r = prep(["demo", "feat/long", "--full"]);
    assert.deepEqual(r.ctx.profile_coverage.unmapped_files, []);
    assert.ok(!r.ctx.warnings.some((w) => w.startsWith("어느 구조에도")));
  } finally { writeFileSync(pPath, before); }
});

test("dependents: diff가 원천을 건드리면 복제본을 그 ref 내용으로 replicas/에 둔다", () => {
  const r = prep(["demo", "feat/long", "--full"]);
  const reps = r.ctx.outside_signals.replicas;
  const ok = reps.find((x) => x.repo === "other");
  assert.deepEqual(ok.files, ["replicas/other/ext/src/status.js"]);
  assert.equal(readFileSync(join(r.runDir, ok.files[0]), "utf8"), "// replica of a.js\n");
  assert.equal(ok.ref, "dev");
  assert.match(reps.find((x) => x.repo === "nope").missing, /프로파일 없음/);
  const md = readFileSync(join(r.runDir, "signals/summary.md"), "utf8");
  assert.match(md, /## 다른 레포 복제본/);
  assert.match(md, /사본: `replicas\/other\/ext\/src\/status\.js`/);
});

test("프로파일 점검: 트리에서 아무것도 안 잡는 구조와 어느 구조에도 안 걸린 변경 파일을 경고", () => {
  const r = prep(["demo", "feat/long", "--full"]);
  assert.deepEqual(r.ctx.profile_coverage.empty_structures, ["demo.ghost"]);
  assert.deepEqual(r.ctx.profile_coverage.unmapped_files, [{ path: "lib/util.js", behavioral: 2 }]);
  assert.match(r.out, /⚠ 프로파일 구조 demo\.ghost의 경로가 head 트리에서 아무 파일도 잡지 않음/);
  assert.match(r.out, /⚠ 어느 구조에도 안 걸린 동작 변경 파일 1개: lib\/util\.js\(2줄\)/);
});

test("base 쪽 지워진 줄을 근거로 쓴 판정 finding은 출처 규칙에서 introduced로 센다", () => {
  const r = prep(["demo", "feat/long", "--full"]);
  assert.deepEqual(r.ctx.diff.files.find((f) => f.path === "src/core/a.js").removed_lines, [3]);
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", [
    finding("F-REL-1", "REL-01", { severity: "medium", evidence: [{ side: "base", file: "src/core/a.js", line: 3 }] }),
    finding("F-REL-2", "REL-01", { severity: "medium", evidence: [{ side: "base", file: "src/core/a.js", line: 15 }] }),
  ]);
  const s = run(fx.ws, "score.mjs", [r.rel, "--quiet"]);
  assert.equal(s.code, 0, s.err + s.out);
  const sc = readJsonFile(join(r.runDir, "scores.json"));
  assert.deepEqual(sc.findings.counted.map((f) => [f.id, f.origin]), [["F-REL-1", "introduced"]]);
  assert.deepEqual(sc.reclassified.map((x) => x.id), ["F-REL-2"]);
});

test("리포트: 신호 칸과 index의 mode·base_sha·fork_point·ranges", () => {
  const full = prep(["demo", "feat/long", "--full"]);
  const inc = prep(["demo", "feat/long", "--base", S.mid]);
  for (const r of [full, inc]) {
    writeJudgment(r.runDir, r.ctx, "SEC", []);
    writeJudgment(r.runDir, r.ctx, "REL", []);
    assert.equal(run(fx.ws, "score.mjs", [r.rel, "--quiet"]).code, 0);
  }
  const rf = run(fx.ws, "report.mjs", [full.rel]);
  assert.equal(rf.code, 0, rf.err);
  const md = readFileSync(join(fx.ws, rf.out.match(/^REPORT=(.+)$/m)[1]), "utf8");
  assert.match(md, /\| 모드 \| 전체 · 갈림점 `[0-9a-f]{7}` \(= merge-base\) \|/);
  assert.match(md, /## 결정적 신호/);
  assert.match(md, /- FAIL `ledger` ledger-delete-remains `demo\.Old`/);
  assert.match(md, /INFO 1건은/);
  const idxPath = join(fx.ws, "docs/evaluation/reports/demo-svc/index.json");
  let idx = readJsonFile(idxPath);
  assert.deepEqual([idx.by_sha[S.head].mode, idx.by_sha[S.head].base_sha, idx.by_sha[S.head].fork_point], ["full", S.fork, S.fork]);

  const ri = run(fx.ws, "report.mjs", [inc.rel]);
  assert.match(readFileSync(join(fx.ws, ri.out.match(/^REPORT=(.+)$/m)[1]), "utf8"), /## 증분 범위 밖 누적 신호/);
  run(fx.ws, "report.mjs", [inc.rel]); // 같은 실행을 다시 리포트해도 범위는 한 번
  idx = readJsonFile(idxPath);
  assert.deepEqual(idx.by_sha[S.head].mode, "incremental"); // 같은 head의 마지막 리포트가 by_sha를 덮는다
  assert.deepEqual(idx.ranges.map((x) => [x.base, x.head, x.mode]), [[S.fork, S.head, "full"], [S.mid, S.head, "incremental"]]);
});

test("--resume: 대상·base를 맞춰 보고, 새 세션에 다시 등록하고, 끝난 단계를 출력한다", () => {
  const r = prep(["demo", "feat/long", "--full"]);
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeFileSync(join(r.runDir, "judgments/REL.json"), "{}");
  for (const c of ["r1", "r2"]) writeFileSync(join(r.runDir, "refutation-targets", `${c}.json`), "[]");
  writeRefutation(r.runDir, r.ctx, "r1", []);
  const sid = "aaaaaaaa-0000-4000-8000-000000000001";
  const res = run(fx.ws, "prepare.mjs", ["--session", sid, "--resume", r.ctx.run_id], { env: env(), session: false });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, new RegExp(`^RUN_DIR=${r.rel}$`, "m"));
  assert.match(res.out, /재개: .+ \(full 모드\)/);
  assert.match(res.out, /- 판정: 형식 점검 통과 SEC \/ 다시 띄울 것 REL\(형식 오류\)/);
  assert.match(res.out, /- 반증 묶음: 결과 있음 r1 \/ 결과 없음 r2/);
  assert.match(res.out, /- 채점: 안 함/);
  const reg = readJsonFile(join(fx.ws, ".verify/sessions", `${sid}.json`));
  assert.equal(reg.runs.at(-1).run_dir, r.rel);
  // 같은 대상을 다시 적어도 되고, 다른 대상이면 2
  assert.equal(run(fx.ws, "prepare.mjs", ["--resume", r.ctx.run_id, "demo", "feat/long", "--full"], { env: env() }).code, 0);
  const bad = run(fx.ws, "prepare.mjs", ["--resume", r.ctx.run_id, "demo", "feat/x"], { env: env() });
  assert.equal(bad.code, 2);
  assert.match(bad.err, /이어 돌릴 실행과 맞지 않음/);
  assert.equal(run(fx.ws, "prepare.mjs", ["--resume", "../x"], { env: env() }).code, 2);
  assert.equal(run(fx.ws, "prepare.mjs", ["--resume", "no-such-run"], { env: env() }).code, 2);
  assert.ok(TEST_SESSION);
});
