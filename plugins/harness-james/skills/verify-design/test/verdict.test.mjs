import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyLimits, applyRefutation, checkFindings, computeVerdict, refutationTargets } from "../scripts/lib/verdict.mjs";
import { cmdFinalize, cmdTargets, cmdCheck } from "../scripts/verdict.mjs";
import { runExtract } from "../scripts/extract.mjs";
import { FIXTURE, extractArgs, tmpDir } from "./helpers.mjs";

const crit = (id, extra = {}) => ({ id, status: "to-evaluate", final_status: "evaluated", weight: 1, review_threshold: 50, ...extra });
const F = (id, severity, confidence = "confirmed", extra = {}) => ({
  id, criterion: "CON-02", severity, confidence, scope_state: "changed", method: "S+L", source: "judge",
  evidence: [{ doc: "docs/design/sample/plan.md", section: "s", line: 10, quote: "대기 상한은 최대 15분이다" }],
  touches: ["REQ-001"], failure_scenario: "f", recommendation: "r", ...extra,
});

test("critical confirmed → REVISE", () => {
  const v = computeVerdict({ findings: [F("a", "critical", "confirmed", { refutation: { verdict: "upheld" } })], criteria: [crit("CON-02")] });
  assert.equal(v.verdict, "REVISE");
});

test("critical possible 은 REVISE가 아니고 R(c)로 본다", () => {
  const v = computeVerdict({ findings: [F("a", "critical", "possible", { refutation: { verdict: "upheld" } })], criteria: [crit("CON-02")] });
  assert.equal(v.verdict, "PROCEED"); // 60 × 0.4 = 24 < 50
});

test("R(c) ≥ 임계값 → REVIEW_REQUIRED, 가중치 반영", () => {
  const fs = [F("a", "high", "confirmed", { refutation: { verdict: "upheld" } })];
  assert.equal(computeVerdict({ findings: fs, criteria: [crit("CON-02")] }).verdict, "PROCEED"); // 30
  const v = computeVerdict({ findings: fs, criteria: [crit("CON-02", { weight: 1.5, review_threshold: 30 })] });
  assert.equal(v.verdict, "REVIEW_REQUIRED");
  assert.equal(v.criterion_risk[0].R, 45);
});

test("반증 uncertain high, 열린 X·H high → REVIEW_REQUIRED", () => {
  const u = computeVerdict({ findings: [F("a", "high", "possible", { refutation: { verdict: "uncertain" } })], criteria: [crit("CON-02")] });
  assert.equal(u.verdict, "REVIEW_REQUIRED");
  const x = computeVerdict({ findings: [F("a", "high", "possible", { method: "L+X", refutation: { verdict: "upheld" } })], criteria: [crit("CON-02")] });
  assert.equal(x.verdict, "REVIEW_REQUIRED");
  const closed = computeVerdict({ findings: [F("a", "high", "possible", { method: "L+X", open_check: false, refutation: { verdict: "upheld" } })], criteria: [crit("CON-02")] });
  assert.equal(closed.verdict, "PROCEED");
});

test("평가 불완전(fail-closed) → REVISE", () => {
  assert.equal(computeVerdict({ findings: [F("a", "high")], criteria: [crit("CON-02")] }).verdict, "REVISE"); // 반증 없음
  assert.equal(computeVerdict({ findings: [], criteria: [{ id: "CON-02", status: "to-evaluate" }] }).verdict, "REVISE"); // 상태 없음
  assert.equal(computeVerdict({ findings: [], criteria: [crit("CON-02")], extractOk: false }).verdict, "REVISE");
  assert.equal(computeVerdict({ findings: [], criteria: [crit("CON-02")], unreadable: [{ path: "x", reason: "judge-unread" }] }).verdict, "REVISE");
  assert.equal(computeVerdict({ findings: [], criteria: [crit("CON-02")], unreadable: [{ path: "x.pdf", reason: "readable:false" }] }).verdict, "PROCEED");
});

test("rejected·BND-06·증분 carried 는 판정에서 빠진다", () => {
  const c = [crit("CON-02"), crit("BND-06", { excluded_from_verdict: true })];
  const v = computeVerdict({
    findings: [
      F("a", "critical", "confirmed", { refutation: { verdict: "rejected" } }),
      F("b", "low", "confirmed", { criterion: "BND-06" }),
      F("c", "critical", "confirmed", { scope_state: "carried", refutation: { verdict: "upheld" } }),
    ],
    criteria: c, incremental: true,
  });
  assert.equal(v.verdict, "PROCEED");
});

test("반증 대상 기본 최대 8건, 상한 밖은 uncertain", () => {
  const fs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => F(`f${i}`, i === 7 ? "critical" : "high", i % 2 ? "confirmed" : "possible"));
  fs.push(F("m", "medium"));
  const { targets, over_cap } = refutationTargets(fs);
  assert.equal(targets.length, 8);
  assert.equal(targets[0].id, "f7");
  assert.equal(over_cap.length, 2);
  // 상한 밖은 같은 high 안에서 확신이 높은(confirmed) 것
  assert.ok(over_cap.every((f) => f.confidence === "confirmed"));
  assert.ok(!targets.some((f) => f.id === "m"));
  const out = applyRefutation(fs, { model: "m-ref", verdicts: [{ finding_id: "f7", verdict: "downgraded", severity_after: "medium", note: "n" }] }, { overCap: over_cap });
  const f7 = out.find((f) => f.id === "f7");
  assert.equal(f7.severity, "medium");
  assert.equal(f7.severity_before, "critical");
  assert.ok(out.filter((f) => over_cap.some((o) => o.id === f.id)).every((f) => f.refutation.verdict === "uncertain"));
});

test("상한: 전체·기준당·low/info", () => {
  const fs = [];
  for (let i = 0; i < 8; i++) fs.push(F(`h${i}`, "high", "confirmed", { criterion: "CON-01" }));
  for (let i = 0; i < 14; i++) fs.push(F(`l${i}`, "low", "confirmed", { criterion: `BND-0${(i % 5) + 1}` }));
  const r = applyLimits(fs, { per_criterion: 5, low_info: 10, total: 50 });
  assert.equal(r.kept.filter((f) => f.criterion === "CON-01").length, 5);
  assert.equal(r.kept.filter((f) => f.severity === "low").length, 10);
  assert.equal(r.overflow["CON-01"].count, 3);
});

test("checkFindings: 인용 없음·같은 모델 반증·touches 없음·BND-06 상한", () => {
  const documents = [{ path: "docs/design/sample/plan.md", fs_path: "docs/design/sample/plan.md" }];
  const criteria = [crit("CON-02"), crit("BND-06")];
  const doc = {
    models: { judge: "claude-fable-5-1" },
    criteria: [{ id: "CON-02", status: "evaluated" }],
    findings: [
      F("ok", "medium"),
      F("badquote", "medium", "confirmed", { evidence: [{ doc: "docs/design/sample/plan.md", line: 10, quote: "없는 문장이다" }] }),
      F("same", "high", "confirmed", { refutation: { verdict: "upheld", model: "claude-fable-5-1" } }),
      F("notouch", "low", "confirmed", { touches: [] }),
      F("bnd", "medium", "confirmed", { criterion: "BND-06" }),
    ],
  };
  const { errors } = checkFindings(doc, { criteria, documents, root: FIXTURE });
  const s = errors.join("\n");
  assert.ok(!/ok:/.test(s));
  assert.match(s, /badquote: 인용을 문서에서 찾지 못함/);
  assert.match(s, /same: 반증 모델이 찾은 모델과 같다/);
  assert.match(s, /notouch: touches 없음/);
  assert.match(s, /bnd: BND-06 심각도 상한은 low/);
});

test("finalize: 판정 파일 → findings.json·verdict.json (S 단독 finding 병합, 반증 반영)", (t) => {
  const run = tmpDir(t);
  runExtract(extractArgs(FIXTURE, run, { level: "standard" }));
  const crits = JSON.parse(JSON.stringify(require_criteria(run)));
  const statuses = crits.filter((c) => c.status === "to-evaluate").map((c) => ({ id: c.id, status: "evaluated" }));
  mkdirSync(join(run, "judge"), { recursive: true });
  writeFileSync(join(run, "judge/findings.json"), JSON.stringify({
    schema: "findings/0.1.0", level: "standard", models: { judge: "claude-fable-5-1" }, criteria: statuses,
    findings: [F("F-CON-02-01", "high", "confirmed", { criterion: "CON-02" })],
    recommendation_conflicts: [],
    candidate_dispositions: obligatedIds(run).map((id) => ({ candidate: id, disposition: "rejected", reason: "시험" })),
  }));
  assert.deepEqual(cmdCheck(run).errors, []);
  const tg = cmdTargets(run);
  assert.deepEqual(tg.targets.map((f) => f.id), ["F-CON-02-01"]);
  assert.equal(tg.refuter_model, "opus");
  mkdirSync(join(run, "refutation"), { recursive: true });
  writeFileSync(join(run, "refutation/result.json"), JSON.stringify({ model: "claude-opus-5-5", verdicts: [{ finding_id: "F-CON-02-01", verdict: "upheld", note: "plan.md:10" }] }));
  const { out, verdict } = cmdFinalize(run);
  assert.equal(out.findings.length, 2); // 판정 1 + REQ-02 스크립트 1
  assert.ok(out.findings.some((f) => f.source === "script"));
  assert.equal(out.findings.find((f) => f.id === "F-CON-02-01").refutation.model, "opus");
  assert.equal(verdict.verdict, "REVIEW_REQUIRED"); // CON-02 가중치 1.5 → R=45 ≥ 30
});

import { readFileSync } from "node:fs";
function obligatedIds(run) { return JSON.parse(readFileSync(join(run, "extract/index.json"), "utf8")).obligated_candidates.map((c) => c.id); }
function require_criteria(run) { return JSON.parse(readFileSync(join(run, "criteria.json"), "utf8")).criteria; }

import { criterionRiskMap } from "../scripts/lib/verdict.mjs";
import { cmdSaveJudge, cmdSaveWorkflow, parseAgentJson } from "../scripts/verdict.mjs";

test("반증 순서(결정 2): 심각도 → 신뢰도 낮은 것 먼저 → R(c)", () => {
  const crits = [crit("CON-01"), crit("CON-02", { weight: 1.5 }), crit("BEH-01")];
  const fs = [
    F("a", "high", "confirmed", { criterion: "CON-01" }),
    F("b", "high", "possible", { criterion: "CON-02" }),
    F("b2", "high", "confirmed", { criterion: "CON-02" }),
    F("c", "critical", "possible", { criterion: "BEH-01" }),
    F("d", "medium", "confirmed", { criterion: "CON-01" }),
  ];
  const r = criterionRiskMap(fs, crits);
  assert.equal(r.get("CON-02"), Math.min(100, 1.5 * (12 + 30)));
  const { targets, order } = refutationTargets(fs, 5, crits);
  // c(critical) → b(high possible) → b2(high confirmed, R(CON-02) 큼) → a(high confirmed)
  assert.deepEqual(targets.map((f) => f.id), ["c", "b", "b2", "a"]);
  assert.match(order, /critical/);
  // 같은 심각도·같은 신뢰도면 R(c) 높은 순
  const t2 = refutationTargets([F("x", "high", "likely", { criterion: "CON-01" }), F("y", "high", "likely", { criterion: "CON-02" })], 1, crits);
  assert.deepEqual(t2.targets.map((f) => f.id), ["y"]);
});

test("관점·반증 에이전트 실패는 평가 불완전(REVISE), 상한 밖은 아님", () => {
  const v = computeVerdict({ findings: [], criteria: [crit("CON-02")], agentFailures: ["관점 operator"] });
  assert.equal(v.verdict, "REVISE");
  assert.match(v.incomplete.join(), /관점 operator/);
});

test("에이전트 답 저장: 코드 펜스·앞뒤 글 허용, 기본 필드 채움", (t) => {
  assert.deepEqual(parseAgentJson("결과입니다\n```json\n{\"a\": 1}\n```\n끝"), { a: 1 });
  assert.deepEqual(parseAgentJson("앞 {\"b\": [1]} 뒤"), { b: [1] });
  const run = tmpDir(t);
  runExtract(extractArgs(FIXTURE, run, { level: "standard" }));
  const d = cmdSaveJudge(run, "```json\n" + JSON.stringify({ criteria: [], findings: [{ id: "F-1", criterion: "CON-02", severity: "low" }] }) + "\n```");
  assert.equal(d.models.judge, "fable");
  assert.equal(d.findings[0].source, "judge");
  assert.equal(d.findings[0].scope_state, "changed");
  assert.ok(JSON.parse(readFileSync(join(run, "judge/findings.json"), "utf8")).findings.length === 1);
});

test("deep 반환값 저장: judge·targets·result, 반증 실패는 failed", (t) => {
  const run = tmpDir(t);
  runExtract(extractArgs(FIXTURE, run, { level: "deep" }));
  const wf = { judge: { level: "deep", models: { judge: "claude-opus-5-5" }, criteria: [], findings: [F("F-1", "high"), F("F-2", "high")] }, refutation: { model: "claude-fable-5-1", max: 5, targets: ["F-1", "F-2"], over_cap: [], verdicts: [{ finding_id: "F-1", verdict: "upheld", note: "x" }] } };
  const { judge, ref } = cmdSaveWorkflow(run, JSON.stringify(wf));
  assert.equal(judge.level, "deep");
  assert.deepEqual(ref.failed, ["F-2"]);
  const tg = JSON.parse(readFileSync(join(run, "refutation/targets.json"), "utf8"));
  assert.equal(tg.refuter_model, "fable");
});
