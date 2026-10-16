import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExtract } from "../scripts/extract.mjs";
import { renderFinal, renderLight } from "../scripts/report.mjs";
import { cmdFinalize, cmdSaveRefutation, cmdTargets } from "../scripts/verdict.mjs";
import { FIXTURE, extractArgs, tmpDir } from "./helpers.mjs";

test("light 보고서: framework 7.2 절과 후보·판정 없음 안내", (t) => {
  const run = tmpDir(t);
  const { out } = runExtract(extractArgs(FIXTURE, run, { level: "light", label: "t" }));
  const md = renderLight(out);
  for (const h of ["## 요약", "## S 단독 finding", "## 구체 후보 (표)", "### 은퇴 이름·ID", "### 번호 체계 혼재", "### 설정 충돌", "### 깨진 참조", "### 범위·머리말", "## 그 밖 후보 (개수만)", "## 기준별 상태", "보정 1회 기준"]) assert.ok(md.includes(h), h);
  assert.ok(md.includes("LLM 판단·판정·반증 없음"));
  assert.ok(!/REVISE|PROCEED/.test(md));
  // 구체 종류는 표 행으로, 나머지 종류는 개수 표에만
  assert.match(md, /\| C-CON-05-\d{4} \| CON-05 \| retired-term-live \|/);
  assert.match(md, /\| CON-02 \| value-group \| \d+ \|/);
  assert.ok(!/\| C-\w{3}-\d{2}-\d{4} \| \w{3}-\d{2} \| (value-group|time-statement|vague-word) \|/.test(md));
});

test("final 보고서: 판정 줄·finding 표·모델", (t) => {
  const run = tmpDir(t);
  const { out } = runExtract(extractArgs(FIXTURE, run, { level: "standard" }));
  const crits = JSON.parse(readFileSync(join(run, "criteria.json"), "utf8")).criteria.filter((c) => c.status === "to-evaluate");
  mkdirSync(join(run, "judge"), { recursive: true });
  writeFileSync(join(run, "judge/findings.json"), JSON.stringify({ level: "standard", models: { judge: "claude-fable-5-1" }, criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [] }));
  const { out: f, verdict } = cmdFinalize(run);
  const md = renderFinal(out, f, verdict);
  assert.match(md, /✅ PROCEED/);
  assert.ok(md.includes("`fable`(요청 별칭, 실행 모델 미확인)"));
  assert.ok(md.includes("## 기준별 상태"));
});

test("final 보고서: 반증함과 상한 밖을 나눠 보인다", (t) => {
  const run = tmpDir(t);
  const { out } = runExtract(extractArgs(FIXTURE, run, { level: "standard" }));
  const crits = JSON.parse(readFileSync(join(run, "criteria.json"), "utf8")).criteria.filter((c) => c.status === "to-evaluate");
  const F = (id, sev) => ({ id, criterion: "CON-02", severity: sev, confidence: "confirmed", scope_state: "changed", method: "S+L", source: "judge", evidence: [{ doc: "docs/design/sample/plan.md", line: 10, quote: "대기 상한은 최대 15분이다" }], touches: ["REQ-001"], failure_scenario: "f", recommendation: "r" });
  mkdirSync(join(run, "judge"), { recursive: true });
  writeFileSync(join(run, "judge/findings.json"), JSON.stringify({ level: "standard", criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [1, 2, 3, 4].map((i) => F(`F-${i}`, "high")) }));
  const tg = cmdTargets(run); // 프로파일 limits.refute = 3
  assert.equal(tg.targets.length, 3);
  assert.equal(tg.over_cap.length, 1);
  cmdSaveRefutation(run, JSON.stringify({ verdicts: tg.targets.map((f) => ({ finding_id: f.id, verdict: "upheld", note: "x" })) }));
  const { out: f, verdict } = cmdFinalize(run);
  const capped = f.findings.find((k) => k.id === tg.over_cap[0]);
  assert.deepEqual(capped.refutation, { verdict: "uncertain", model: null, note: "not-refuted: cap" });
  assert.equal(verdict.verdict, "REVIEW_REQUIRED");
  assert.ok(verdict.incomplete.length === 0);
  const md = renderFinal(out, f, verdict);
  assert.match(md, /반증함 3건/);
  assert.match(md, /상한 밖이라 반증하지 않음 1건/);
  assert.match(md, /상한 밖\(반증 안 함\)/);
});
