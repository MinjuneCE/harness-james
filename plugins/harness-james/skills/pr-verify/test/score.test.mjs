import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { finding, freshRun, makeWorkspace, prepare, readJsonFile, run, writeJudgment, writeRefutation } from "./fixture.mjs";

let fx;
let base;
before(() => { fx = makeWorkspace(); base = prepare(fx.ws); });
after(() => fx.cleanup());

// SEC·REL 판정을 쓰고 반증 결과를 넣은 뒤 채점한다
function scoreWith(name, { sec = [], rel = [], verdicts = null, skipRel = false } = {}) {
  const r = freshRun(fx.ws, base, name);
  writeJudgment(r.runDir, r.ctx, "SEC", sec);
  if (!skipRel) writeJudgment(r.runDir, r.ctx, "REL", rel);
  if (verdicts) writeRefutation(r.runDir, r.ctx, "r1", verdicts);
  const out = run(fx.ws, "score.mjs", [r.rel]);
  assert.equal(out.code, 0, out.err);
  return { ...r, sc: readJsonFile(join(r.runDir, "scores.json")), out };
}
const v = (finding_id, verdict, extra = {}) => ({ finding_id, verdict, reason: "테스트", ...extra });

test("finding이 없으면 PASS (규칙 finding은 medium이라 반증 없이 감점만)", () => {
  const { sc } = scoreWith("pass");
  assert.equal(sc.gate, "PASS");
  assert.equal(sc.complete, true);
  assert.deepEqual(sc.findings.counted.map((f) => [f.id, f.points]), [["R-no-eval", 8.4]]);
  assert.deepEqual(sc.dimensions.map((d) => [d.id, d.score]), [["SEC", 91.6], ["REL", 100]]);
  assert.equal(sc.overall.score, 95.8);
});

test("유지된 high finding이 기준 임계값을 넘으면 REVIEW_REQUIRED", () => {
  const { sc } = scoreWith("review", { rel: [finding("F-REL-1", "REL-01")], verdicts: [v("F-REL-1", "upheld")] });
  assert.equal(sc.gate, "REVIEW_REQUIRED");
  assert.deepEqual(sc.triggers.map((t) => [t.key, t.value, t.threshold]), [["C-REL-01", 30, 30]]);
  assert.equal(sc.dimensions.find((d) => d.id === "REL").score, 55);
  // 구조 영향도: 중요도 50 × 0.6 + finding 가산 20 = 50 < 60
  assert.equal(sc.structures[0].impact, 50);
});

test("critical(confirmed)은 BLOCK", () => {
  const { sc } = scoreWith("critical", { rel: [finding("F-REL-1", "REL-01", { severity: "critical" })], verdicts: [v("F-REL-1", "upheld")] });
  assert.equal(sc.gate, "BLOCK");
  assert.ok(sc.block_reasons.some((b) => b.kind === "critical" && b.ref === "F-REL-1"));
});

test("반증 기각은 감점하지 않고, 하향은 낮춘 심각도로 감점한다", () => {
  const rej = scoreWith("rejected", { rel: [finding("F-REL-1", "REL-01", { severity: "critical" })], verdicts: [v("F-REL-1", "rejected")] }).sc;
  assert.equal(rej.gate, "PASS");
  assert.deepEqual(rej.findings.rejected.map((f) => f.id), ["F-REL-1"]);
  const down = scoreWith("down", { rel: [finding("F-REL-1", "REL-01", { severity: "critical" })], verdicts: [v("F-REL-1", "downgraded", { severity_after: "medium" })] }).sc;
  assert.deepEqual(down.findings.counted.filter((f) => f.source === "judge").map((f) => [f.severity, f.points]), [["medium", 12]]);
});

test("uncertain은 사람 검토 트리거(D-)가 된다", () => {
  const { sc } = scoreWith("uncertain", { rel: [finding("F-REL-1", "REL-01")], verdicts: [v("F-REL-1", "uncertain")] });
  assert.ok(sc.triggers.some((t) => t.key === "D-F-REL-1"));
  assert.equal(sc.findings.counted.find((f) => f.id === "F-REL-1").confidence, "likely");
});

test("판정 파일이 빠지면 평가 불완전으로 BLOCK", () => {
  const { sc } = scoreWith("missing-judgment", { skipRel: true });
  assert.equal(sc.gate, "BLOCK");
  assert.equal(sc.complete, false);
  assert.ok(sc.issues.some((i) => i.includes("judgments/REL.json")));
  assert.equal(sc.block_reasons[0].kind, "incomplete");
});

test("반증 결과가 빠지면 --check는 1, 채점은 BLOCK", () => {
  const r = freshRun(fx.ws, base, "missing-refute");
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", [finding("F-REL-1", "REL-01")]);
  assert.equal(run(fx.ws, "score.mjs", [r.rel, "--check", "--stage", "judgments"]).code, 0);
  const chk = run(fx.ws, "score.mjs", [r.rel, "--check"]);
  assert.equal(chk.code, 1);
  assert.match(chk.out, /반증 결과 없음: F-REL-1/);
  run(fx.ws, "score.mjs", [r.rel, "--quiet"]);
  assert.equal(readJsonFile(join(r.runDir, "scores.json")).gate, "BLOCK");
});

test("모델 정책 위반 판정은 형식 오류", () => {
  const r = freshRun(fx.ws, base, "bad-model");
  writeJudgment(r.runDir, r.ctx, "SEC", [], { model: "claude-sonnet-5-5" });
  const out = run(fx.ws, "score.mjs", [r.rel, "--check-judgment", "SEC"]);
  assert.equal(out.code, 1);
  assert.match(out.out, /모델 정책 위반/);
});

test("변경 범위 밖 근거는 기존 부채로 재분류", () => {
  const far = finding("F-REL-1", "REL-01", { evidence: [{ side: "head", file: "src/core/a.js", line: 20 }] });
  const { sc } = scoreWith("reclass", { rel: [far], verdicts: [v("F-REL-1", "upheld")] });
  assert.deepEqual(sc.reclassified.map((x) => [x.id, x.to]), [["F-REL-1", "pre-existing"]]);
  assert.equal(sc.gate, "PASS");
});

test("같은 기준·같은 위치의 판정 finding과 규칙 finding은 하나로 병합", () => {
  const dup = finding("F-SEC-1", "SEC-01", { severity: "medium", confidence: "confirmed" });
  const { sc } = scoreWith("merge", { sec: [dup] });
  assert.deepEqual(sc.merged.map((m) => [m.id, m.into]), [["R-no-eval", "F-SEC-1"]]);
  assert.equal(sc.dimensions.find((d) => d.id === "SEC").score, 88);
});

test("--refute-chunks: 6개씩 나눠 쓰고, 내용은 --list-refute와 같다", () => {
  const r = freshRun(fx.ws, base, "chunks");
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", Array.from({ length: 8 }, (_, i) => finding(`F-REL-${i + 1}`, "REL-01")));
  const out = run(fx.ws, "score.mjs", [r.rel, "--refute-chunks"]);
  assert.equal(out.code, 0, out.err);
  assert.deepEqual(out.out.trim().split("\n"), ["CHUNK=r1 6건", "CHUNK=r2 2건"]);
  const list = JSON.parse(run(fx.ws, "score.mjs", [r.rel, "--list-refute"]).out);
  const tdir = join(r.runDir, "refutation-targets");
  assert.deepEqual([...readJsonFile(join(tdir, "r1.json")), ...readJsonFile(join(tdir, "r2.json"))], list);

  // 묶음 크기를 바꿔 다시 쓰면 남는 묶음을 지운다
  run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--chunk-size", "3"]);
  run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--chunk-size", "8"]);
  assert.deepEqual(readdirSync(tdir).sort(), ["r1.json"]);
  assert.equal(run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--chunk-size", "0"]).code, 2);
});

test("--refute-chunks --retry: 빠진 finding만 원래 묶음 이름으로, 한 번만", () => {
  const r = freshRun(fx.ws, base, "retry");
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", Array.from({ length: 8 }, (_, i) => finding(`F-REL-${i + 1}`, "REL-01")));
  run(fx.ws, "score.mjs", [r.rel, "--refute-chunks"]);
  writeRefutation(r.runDir, r.ctx, "r1", ["F-REL-1", "F-REL-2", "F-REL-3", "F-REL-5", "F-REL-6"].map((id) => v(id, "upheld")));
  const out = run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--retry"]);
  assert.deepEqual(out.out.trim().split("\n"), ["CHUNK=r1-retry 1건", "CHUNK=r2-retry 2건"]);
  const tdir = join(r.runDir, "refutation-targets");
  assert.deepEqual(readJsonFile(join(tdir, "r1-retry.json")).map((t) => t.id), ["F-REL-4"]);
  assert.deepEqual(readJsonFile(join(tdir, "r2-retry.json")).map((t) => t.id), ["F-REL-7", "F-REL-8"]);

  // 두 번째 재시도 요청은 새 묶음을 만들지 않는다
  const again = run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--retry"]);
  assert.doesNotMatch(again.out, /^CHUNK=/m);
  assert.match(again.out, /건너뜀 r1-retry/);

  // 재시도 결과가 다 들어오면 --check 통과
  writeRefutation(r.runDir, r.ctx, "r1-retry", [v("F-REL-4", "upheld")]);
  writeRefutation(r.runDir, r.ctx, "r2-retry", [v("F-REL-7", "rejected"), v("F-REL-8", "upheld")]);
  assert.equal(run(fx.ws, "score.mjs", [r.rel, "--check"]).code, 0);
  assert.match(run(fx.ws, "score.mjs", [r.rel, "--refute-chunks", "--retry"]).out, /다시 반증할 finding 없음/);
});

test("--refute-chunks: 반증 대상이 없으면 묶음을 만들지 않는다", () => {
  const r = freshRun(fx.ws, base, "no-chunks");
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", []);
  assert.match(run(fx.ws, "score.mjs", [r.rel, "--refute-chunks"]).out, /^반증 대상 없음$/m);
  assert.ok(!existsSync(join(r.runDir, "refutation-targets", "r1.json")));
});

test("모르는 옵션은 종료 코드 2", () => {
  const r = freshRun(fx.ws, base, "bad-opt");
  assert.equal(run(fx.ws, "score.mjs", [r.rel, "--bogus"]).code, 2);
  assert.equal(run(fx.ws, "score.mjs", []).code, 2);
});
