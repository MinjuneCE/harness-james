import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { finding, freshRun, makeWorkspace, prepare, readJsonFile, run, writeJudgment, writeRefutation } from "./fixture.mjs";

let fx;
let base;
before(() => { fx = makeWorkspace(); base = prepare(fx.ws); });
after(() => fx.cleanup());

function scored(name, ctxPatch = {}) {
  const r = freshRun(fx.ws, { ...base, ctx: { ...base.ctx, ...ctxPatch } }, name);
  writeJudgment(r.runDir, r.ctx, "SEC", []);
  writeJudgment(r.runDir, r.ctx, "REL", [finding("F-REL-1", "REL-01")]);
  writeRefutation(r.runDir, r.ctx, "r1", [{ finding_id: "F-REL-1", verdict: "upheld", reason: "확인" }]);
  assert.equal(run(fx.ws, "score.mjs", [r.rel, "--quiet"]).code, 0);
  return r;
}

test("리포트 md·json과 PR 게이트 index를 쓴다", () => {
  const r = scored("report");
  writeFileSync(join(r.runDir, "packets", "C-REL-01.md"), "# 구조 요약\n패킷 본문\n## 읽는 순서\n1. a\n");
  const out = run(fx.ws, "report.mjs", [r.rel]);
  assert.equal(out.code, 0, out.err);
  const rel = out.out.match(/^REPORT=(.+)$/m)[1];
  assert.match(rel, /^docs\/evaluation\/reports\/demo-svc\/\d{8}-\d{4}-feat-x-[0-9a-f]{7}\.md$/);
  const md = readFileSync(join(fx.ws, rel), "utf8");
  assert.match(md, /⚠️ REVIEW_REQUIRED/);
  assert.match(md, /### C-REL-01/);
  // 패킷 제목은 트리거(###) 아래 단계로 내린다
  assert.match(md, /^#### 구조 요약$/m);
  assert.match(md, /^##### 읽는 순서$/m);

  const json = readJsonFile(join(fx.ws, rel.replace(/\.md$/, ".json")));
  // verify-crosscheck와 PR 게이트가 읽는 형식. 키가 바뀌면 이 테스트가 깨진다
  assert.deepEqual(Object.keys(json), ["report", "json", "repo", "run_id", "created_at", "target", "base", "gate", "overall", "dimensions", "triggers", "block_reasons", "season", "versions", "models", "scores", "context"]);
  assert.equal(json.gate, "REVIEW_REQUIRED");
  assert.equal(json.context.diff.files[0].added_lines, undefined);

  const index = readJsonFile(join(fx.ws, "docs/evaluation/reports/demo-svc/index.json"));
  const entry = index.by_sha[base.ctx.target.sha];
  assert.deepEqual([entry.gate, entry.report, entry.triggers, entry.block_reasons], ["REVIEW_REQUIRED", rel, 1, 0]);
});

test("--repo-path·--no-gate 실행은 calibration/reports로 가고 PR 게이트 index에 넣지 않는다", () => {
  const r = scored("calib", { repo_override: true, target: { ...base.ctx.target, sha: "c".repeat(40) } });
  const out = run(fx.ws, "report.mjs", [r.rel]);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /^REPORT=docs\/evaluation\/calibration\/reports\/demo-svc\//m);
  const gate = join(fx.ws, "docs/evaluation/reports/demo-svc/index.json");
  assert.ok(!existsSync(gate) || !readJsonFile(gate).by_sha["c".repeat(40)]);
});

test("scores.json이 없으면 종료 코드 2", () => {
  const r = freshRun(fx.ws, base, "no-scores");
  assert.equal(run(fx.ws, "report.mjs", [r.rel]).code, 2);
});
