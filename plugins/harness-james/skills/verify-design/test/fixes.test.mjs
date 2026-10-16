// 보정 시험(2026-10-16) B1–B15·읽기 범위·비용 계수·deep 권장 줄 수정 시험
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExtract } from "../scripts/extract.mjs";
import { renderFinal, renderLight } from "../scripts/report.mjs";
import { cmdCheck, cmdFinalize, cmdSaveJudge, cmdSaveRefutation, cmdSaveWorkflow, cmdTargets } from "../scripts/verdict.mjs";
import { checkDispositions, computeVerdict, locateQuote, mergeConflicts, resolveDocRefs, resolveUnread } from "../scripts/lib/verdict.mjs";
import { deepAdvice, estimate } from "../scripts/lib/estimate.mjs";
import { FIXTURE, SKILL, extractArgs, tmpDir } from "./helpers.mjs";

const DOCS = [
  { path: "docs/d/README.md", fs_path: "x/d/README.md", role: "overview" },
  { path: "docs/d/plan.md", fs_path: "x/d/plan.md", role: "plan" },
  { path: "docs/d/contracts/a.md", fs_path: "x/d/contracts/a.md", role: "contract" },
  { path: "docs/d/inputs/01.md", fs_path: "x/d/inputs/01.md", role: "source-material" },
  { path: "docs/d/inputs/02.md", fs_path: "x/d/inputs/02.md", role: "source-material" },
];
const PDF = { path: "docs/d/mail/re.pdf", reason: "readable:false" };

// ---------------------------------------------------------------- B1·B2
test("B1: 자유 문자열 미독 목록을 묶음 문서로 바꾼다(줄 범위·괄호·glob·묶음 밖)", () => {
  const r = resolveDocRefs(["docs/d/plan.md 270-393 (Sequences)", "docs/d/README.md (grep 일부만)", "docs/d/inputs/*", "x/d/contracts/a.md", "RUN/extract/QAS.json", "docs/other/constitution.md"], DOCS);
  assert.deepEqual(r.docs.sort(), ["docs/d/README.md", "docs/d/contracts/a.md", "docs/d/inputs/01.md", "docs/d/inputs/02.md", "docs/d/plan.md"]);
  assert.deepEqual(r.outside, ["RUN/extract/QAS.json", "docs/other/constitution.md"]);
});

test("B1: 다른 관점이 읽은 문서는 미독이 아니다, 입력 문서 미독은 따로", () => {
  const u = resolveUnread({
    documents: DOCS, unreadable: [PDF],
    read: ["docs/d/README.md", "docs/d/plan.md (1-270, 394-601)", "docs/d/contracts/a.md", "docs/d/inputs/02.md (검색)"],
    unread: ["docs/d/README.md", "docs/d/plan.md 270-393 (Sequences)", "docs/d/inputs/*", "docs/d/mail/*.pdf (readable:false)", "RUN/extract/QAS.json"],
  });
  assert.deepEqual(u.design, []);
  assert.deepEqual(u.input, ["docs/d/inputs/01.md"]);
  assert.deepEqual(u.excluded.map((x) => x.path), ["docs/d/mail/re.pdf"]);
  assert.deepEqual(u.outside, ["RUN/extract/QAS.json"]);
});

test("B2: NFD 한글 경로(파일 시스템)와 NFC 문자열(에이전트)을 같은 문서로 본다", () => {
  const nfd = "docs/d/mail/메일.pdf".normalize("NFD");
  const u = resolveUnread({ documents: DOCS, unreadable: [{ path: nfd, reason: "readable:false" }], read: [], unread: ["docs/d/mail/메일.pdf (readable:false)".normalize("NFC")] });
  assert.deepEqual(u.outside, []);
  assert.deepEqual(u.design, []);
});

test("B2: 의도적 제외(readable:false·exclude)는 평가 불완전이 아니고, 읽기 실패·아무도 안 읽은 문서는 불완전이다(framework 0.2.0 8.1)", () => {
  const crit = [{ id: "CON-02", status: "to-evaluate", final_status: "evaluated", weight: 1 }];
  const u = resolveUnread({ documents: DOCS, unreadable: [PDF], read: DOCS.map((d) => d.path), unread: ["docs/d/mail/re.pdf (readable:false, 프로파일 exclude **/*.pdf; 내용은 다른 문서로 대신 읽음)"] });
  assert.deepEqual([u.design, u.input], [[], []]);
  const v = computeVerdict({ findings: [], criteria: crit, unreadable: [PDF] });
  assert.equal(v.verdict, "PROCEED");
  assert.deepEqual(v.excluded, ["docs/d/mail/re.pdf"]);
  assert.equal(computeVerdict({ findings: [], criteria: crit, unreadable: [{ path: "docs/d/x.bin", reason: "binary-or-unknown-type" }] }).verdict, "REVISE");
  assert.equal(computeVerdict({ findings: [], criteria: crit, unreadable: [{ path: "docs/d/plan.md", reason: "judge-unread" }] }).verdict, "REVISE");
  // 결정 5-1: 원자료(입력 문서)만 아무도 안 읽었으면 평가 불완전이 아니라 REVIEW_REQUIRED("원자료 미독")
  const inp = computeVerdict({ findings: [], criteria: crit, unreadInputs: ["docs/d/inputs/01.md"] });
  assert.equal(inp.verdict, "REVIEW_REQUIRED");
  assert.deepEqual(inp.incomplete, []);
  assert.match(inp.triggers.review.join(), /원자료 미독 1건: docs\/d\/inputs\/01\.md/);
  // 정본 문서 미독이 같이 있으면 REVISE
  assert.equal(computeVerdict({ findings: [], criteria: crit, unreadInputs: ["docs/d/inputs/01.md"], unreadable: [{ path: "docs/d/plan.md", reason: "judge-unread" }] }).verdict, "REVISE");
  // 구체 후보 처리 누락은 경고일 뿐 판정을 바꾸지 않는다(framework 8.1)
  const w = computeVerdict({ findings: [], criteria: crit, warnings: ["구체 후보 처리 기록 없음 1/1건: C-1"] });
  assert.equal(w.verdict, "PROCEED");
  assert.deepEqual(w.incomplete_warnings, ["구체 후보 처리 기록 없음 1/1건: C-1"]);
});

// ---------------------------------------------------------------- B4
test("B4: SKILL.md 본문에 `$` 바로 뒤 숫자가 없다(스킬 인자 치환 방지)", () => {
  const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  const hits = md.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /\$\d/.test(l));
  assert.deepEqual(hits, []);
});

// ---------------------------------------------------------------- B6·B7·B9·B11
function stdRun(t, level = "standard") {
  const run = tmpDir(t);
  const { out } = runExtract(extractArgs(FIXTURE, run, { level }));
  const crits = JSON.parse(readFileSync(join(run, "criteria.json"), "utf8")).criteria.filter((c) => c.status === "to-evaluate");
  const obligated = JSON.parse(readFileSync(join(run, "extract/index.json"), "utf8")).obligated_candidates.map((c) => c.id);
  return { run, out, crits, obligated };
}
const F = (id, sev, extra = {}) => ({
  id, criterion: "CON-02", title: "t", severity: sev, confidence: "confirmed", method: "S+L",
  evidence: [{ doc: "docs/design/sample/plan.md", section: "s", line: 10, quote: "대기 상한은 최대 15분이다" }],
  touches: ["REQ-001"], failure_scenario: "f", recommendation: "r", ...extra,
});

test("B9: 전체 검증에서 carried는 changed로 바꾼다 / B11: 요청 모델과 자기 보고·실행 확인을 나눈다", (t) => {
  const { run } = stdRun(t);
  const d = cmdSaveJudge(run, { models: { judge: "claude-fable-5-1" }, criteria: [], findings: [F("F-1", "low", { scope_state: "carried" })] });
  assert.equal(d.findings[0].scope_state, "changed");
  assert.equal(d.scope_state_normalized, 1);
  assert.equal(d.models.judge, "fable"); // 요청 모델은 별칭(C6)
  assert.equal(d.models.judge_observed, null);
  assert.equal(d.models.judge_reported, "claude-fable-5-1");
  const o = cmdSaveJudge(run, { criteria: [], findings: [] }, { observed: "claude-fable-5-1" });
  assert.equal(o.models.judge_observed, "claude-fable-5-1");
});

test("B6: 반증 대상 근거에 실제 파일 경로(file)를 붙인다", (t) => {
  const { run } = stdRun(t);
  cmdSaveJudge(run, { criteria: [], findings: [F("F-1", "high")] });
  const tg = cmdTargets(run);
  assert.equal(tg.targets[0].evidence[0].file, "docs/design/sample/plan.md");
  assert.match(tg.order, /신뢰도 낮은 것 먼저/);
});

test("B7: 워크플로 출력 래퍼 {summary, logs, result}를 풀어 저장한다", (t) => {
  const { run } = stdRun(t, "deep");
  const result = { judge: { level: "deep", criteria: [], findings: [F("F-1", "high")] }, refutation: { model: "claude-fable-5-1", targets: ["F-1"], over_cap: [], verdicts: [{ finding_id: "F-1", verdict: "upheld", note: "x" }] } };
  const { judge, ref } = cmdSaveWorkflow(run, JSON.stringify({ summary: "s", logs: ["l"], result }));
  assert.equal(judge.findings.length, 1);
  assert.equal(ref.verdicts.length, 1);
  assert.equal(JSON.parse(readFileSync(join(run, "refutation/targets.json"), "utf8")).max, 8);
});

test("B11·C6: 요청 모델은 별칭, 실행 모델 ID는 확인한 경우에만 적는다", (t) => {
  const { run, out, crits } = stdRun(t);
  cmdSaveJudge(run, { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [] });
  cmdSaveRefutation(run, { verdicts: [] }, { observed: "claude-opus-5-5" });
  const { out: f, verdict } = cmdFinalize(run);
  const md = renderFinal(out, f, verdict);
  assert.match(md, /판정 `fable`\(요청 별칭, 실행 모델 미확인\)/);
  assert.match(md, /반증 `opus` → 실행 `claude-opus-5-5`\(확인\)/);
  assert.ok(!/claude-fable-5-1/.test(md), "확인하지 않은 실행 모델 ID를 적지 않는다");
});

// ---------------------------------------------------------------- B12
test("B12: 생략(…) 인용은 조각마다 찾고, 줄이 다르면 실제 줄을 알려 준다", () => {
  const lines = ["a", "첫 조각 문장이다 그리고", "중간", "끝 조각 문장이다", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "옮겨 간 문장이다"];
  assert.equal(locateQuote(lines, "첫 조각 문장이다 … 끝 조각 문장이다", 2).status, "ok");
  assert.equal(locateQuote(lines, "첫 조각 문장이다 … 없는 조각이다", 2).status, "partial");
  const m = locateQuote(lines, "옮겨 간 문장이다", 3);
  assert.equal(m.status, "moved");
  assert.deepEqual(m.lines, [15]);
  assert.equal(locateQuote(lines, "전혀 없는 문장", 3).status, "missing");
});

// ---------------------------------------------------------------- B13·읽기 범위
test("B13·7-2: 문서 토큰·large 표시, 입력 문서 후보는 개수만(목록은 .input.json), 처리 목록은 정본 쪽만", (t) => {
  const { run, out } = stdRun(t);
  assert.ok(out.documents.every((d) => typeof d.tokens === "number" && typeof d.large === "boolean"));
  const idx = JSON.parse(readFileSync(join(run, "extract/index.json"), "utf8"));
  const inputOnly = out.candidates.filter((c) => c.doc_class === "input");
  assert.ok(inputOnly.length > 0, "fixture에 입력 문서 후보가 있어야 한다");
  const con = JSON.parse(readFileSync(join(run, "extract/CON.json"), "utf8"));
  assert.ok(con.candidates.every((c) => c.doc_class !== "input"));
  assert.ok(con.candidate_groups.every((g) => g.entries.every((e) => !e.endsWith("[input]"))));
  const f = idx.files.find((x) => x.dimension === "CON");
  if (f.input_only) {
    assert.ok(existsSync(join(run, f.input_file)));
    assert.equal(con.input_only.count, f.input_only);
  }
  assert.ok(idx.obligated_candidates.every((c) => out.candidates.find((k) => k.id === c.id).doc_class !== "input"));
});

test("BND-06은 입력을 줄여도 적용 기준으로 남는다(판정 제외만)", (t) => {
  const { crits } = stdRun(t);
  assert.ok(crits.some((c) => c.id === "BND-06"));
  const persp = JSON.parse(readFileSync(join(SKILL, "reference/perspectives.json"), "utf8"));
  assert.equal(persp.filter((p) => p.primary.includes("BND-06")).length, 1);
});

// ---------------------------------------------------------------- B14·B15
test("B14: 구체 후보 처리 목록 — 누락·채택 ID 없음·기각 이유 없음을 잡는다", (t) => {
  const { run, obligated } = stdRun(t);
  assert.ok(obligated.length >= 2);
  const base = { criteria: [], findings: [F("F-1", "medium")], recommendation_conflicts: [] };
  cmdSaveJudge(run, { ...base, candidate_dispositions: [] });
  assert.match(cmdCheck(run).errors.join("\n"), new RegExp(`light 구체 후보 처리 누락 ${obligated.length}/${obligated.length}`));
  const disp = obligated.map((id, i) => (i === 0 ? { candidate: id, disposition: "adopted", finding: "F-없음" } : i === 1 ? { candidate: id, disposition: "rejected" } : { candidate: id, disposition: "rejected", reason: "이력 맥락" }));
  cmdSaveJudge(run, { ...base, candidate_dispositions: disp });
  const e = cmdCheck(run).errors.join("\n");
  assert.match(e, /채택인데 finding ID가 없거나/);
  assert.match(e, /기각인데 이유 없음/);
  assert.ok(!/처리 누락/.test(e));
  const ok = obligated.map((id) => ({ candidate: id, disposition: "adopted", finding: "F-1" }));
  cmdSaveJudge(run, { ...base, candidate_dispositions: ok });
  assert.ok(!/후보/.test(cmdCheck(run).errors.join("\n")));
  const { out } = cmdFinalize(run);
  assert.equal(out.dispositions_summary.adopted, obligated.length);
  assert.deepEqual(out.dispositions_summary.missing, []);
});

test("B14: 처리 기록이 빠지면 보고서 머리에 평가 불완전 경고, 처리표에 '처리 기록 없음'", (t) => {
  const { run, out, obligated, crits } = stdRun(t);
  cmdSaveJudge(run, { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [], recommendation_conflicts: [], candidate_dispositions: [{ candidate: obligated[0], disposition: "rejected", reason: "이력 맥락" }] });
  const { out: f, verdict } = cmdFinalize(run);
  assert.equal(verdict.verdict, "PROCEED");
  const md = renderFinal(out, f, verdict);
  assert.match(md, new RegExp(`평가 불완전 경고\\(판정은 그대로\\): 구체 후보 처리 기록 없음 ${obligated.length - 1}/${obligated.length}건`));
  assert.match(md, /### 구체 후보 처리표/);
  assert.match(md, new RegExp(`\\| ${obligated[0]} \\| [A-Z]{3}-\\d{2} \\| [^|]+ \\| 기각 → 이력 맥락 \\|`));
  assert.match(md, new RegExp(`\\| ${obligated[1]} \\| .* \\| 처리 기록 없음 \\|`));
});

test("B14: 증분에서 carried 후보는 처리 목록에서 빠진다", () => {
  const cands = [
    { id: "C1", kind: "retired-term-live", doc_class: "design", applicable: true, scope_state: "carried" },
    { id: "C2", kind: "retired-term-live", doc_class: "design", applicable: true, scope_state: "changed" },
    { id: "C3", kind: "retired-term-live", doc_class: "input", applicable: true },
    { id: "C4", kind: "value-group", doc_class: "design", applicable: true },
  ];
  const r = checkDispositions({ findings: [], candidate_dispositions: [] }, cands);
  assert.deepEqual(r.missing, ["C2"]);
});

test("B15: 반대 방향 권고 짝 — 필드 필수, 짝은 2개, 모르는 finding은 오류, 보고서에 보인다", (t) => {
  const { run, out, obligated, crits } = stdRun(t);
  const disp = obligated.map((id) => ({ candidate: id, disposition: "rejected", reason: "r" }));
  cmdSaveJudge(run, { criteria: [], findings: [F("F-1", "medium")], candidate_dispositions: disp });
  assert.match(cmdCheck(run).errors.join(), /recommendation_conflicts 없음/);
  cmdSaveJudge(run, { criteria: [], findings: [F("F-1", "medium")], candidate_dispositions: disp, recommendation_conflicts: [{ findings: ["F-1", "F-9"], note: "n" }] });
  assert.match(cmdCheck(run).errors.join(), /모르는 finding F-9/);
  cmdSaveJudge(run, { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [F("F-1", "medium"), F("F-2", "medium", { evidence: [{ doc: "docs/design/sample/plan.md", line: 10, quote: "대기 상한은 최대 15분이다" }] })], candidate_dispositions: disp, recommendation_conflicts: [{ findings: ["F-1", "F-2"], note: "한쪽은 더하라, 한쪽은 빼라" }] });
  assert.ok(!/recommendation_conflicts/.test(cmdCheck(run).errors.join()));
  const { out: f, verdict } = cmdFinalize(run);
  const md = renderFinal(out, f, verdict);
  assert.match(md, /### 권고 충돌/);
  assert.match(md, /\| F-1 \| F-2 \| 한쪽은 더하라, 한쪽은 빼라 \|/);
  // 각 finding의 conflicts_with에 상대 ID(framework 7.5)
  assert.deepEqual(f.findings.find((k) => k.id === "F-1").conflicts_with, ["F-2"]);
  assert.deepEqual(f.findings.find((k) => k.id === "F-2").conflicts_with, ["F-1"]);
});

test("B15: finding의 conflicts_with만 적어도 짝이 된다, 한쪽을 지우지 않는다", () => {
  const { findings, conflicts } = mergeConflicts([{ id: "A", conflicts_with: ["B"] }, { id: "B" }, { id: "C" }], []);
  assert.deepEqual(conflicts.map((c) => c.findings), [["A", "B"]]);
  assert.equal(findings.length, 3);
  assert.deepEqual(findings.find((f) => f.id === "B").conflicts_with, ["A"]);
});

// ---------------------------------------------------------------- 비용 계수·deep 권장 줄
test("비용 계수(결정 5-2 (a)): 판정 1k당 0.092·0.104 ±25%, 반증은 0건~상한 × 모델별 단가, '달러' 표기", () => {
  const text = "a".repeat(4 * 161000); // 161k 토큰
  const e = estimate([{ text }], { refuteMax: 8 });
  // standard: 14.81×0.75 = 11.1 ~ 14.81×1.25 + 0.20×8 = 20.1 · deep: 16.74×0.75 = 12.6 ~ 16.74×1.25 + 1.23×8 = 30.8
  assert.deepEqual(e.standard_usd, [11, 20]);
  assert.deepEqual(e.deep_usd, [13, 31]);
  assert.equal(e.judge_usd.standard, 14.81);
  assert.equal(e.judge_usd.deep, 16.74);
  // 기준값이 범위 안
  const inRange = (r, x) => r[0] <= x && x <= r[1];
  assert.ok(inRange(e.standard_usd, 15.43), `standard 기준값 15.43 ∉ ${e.standard_usd}`);
  assert.ok(inRange(e.deep_usd, 22.87), `deep 기준값 22.87 ∉ ${e.deep_usd}`);
  // 반증 0건이면 판정 몫만
  assert.deepEqual(estimate([{ text }], { refuteMax: 0 }).standard_usd, [11, 19]);
  assert.equal(e.refute_usd.standard.model, "opus");
  assert.equal(e.refute_usd.standard.per, 0.2);
  assert.equal(e.refute_usd.deep.model, "fable");
  assert.equal(e.refute_usd.deep.per, 1.23);
  // 판정·반증 범위를 따로 보이고 합계를 적는다(framework 8.4)
  assert.match(e.cost_line, /standard 11–20달러 = 판정 11–19달러\(1k 토큰당 0\.092 ±25%\) \+ 반증 0–1\.60달러\(Opus 건당 0\.20 × 0–8건\)/);
  assert.match(e.cost_line, /deep 13–31달러 = 판정 13–21달러\(1k 토큰당 0\.104 ±25%\) \+ 반증 0–9\.84달러\(Fable 건당 1\.23 × 0–8건\)/);
  assert.match(e.cost_line, /보정 1회 기준/);
  assert.ok(!e.cost_line.includes("$"));
});

test("결정 1: 되돌릴 수 없는 부작용·데이터 이전 trait면 light·standard 보고서에 deep 권장 줄", (t) => {
  assert.equal(deepAdvice(["multi-doc"]), null);
  assert.match(deepAdvice(["irreversible-effects"]), /구현 직전·확정 때는 deep 권장/);
  assert.match(deepAdvice(["data-migration"]), /data-migration/);
  const { run, out, crits } = stdRun(t);
  assert.equal(out.deep_advice, null);
  const x = { ...out, deep_advice: undefined, profile: { ...out.profile, traits: [...out.profile.traits, "irreversible-effects"] } };
  assert.match(renderLight(x), /구현 직전·확정 때는 deep 권장/);
  cmdSaveJudge(run, { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [] });
  const { out: f, verdict } = cmdFinalize(run);
  assert.match(renderFinal(x, f, verdict), /구현 직전·확정 때는 deep 권장/);
  assert.ok(!/deep 권장/.test(renderFinal(x, { ...f, level: "deep" }, verdict)));
  // 정보만: level은 바꾸지 않는다
  assert.equal(f.level, "standard");
});

test("B8: 반증 요청 틀은 대상 JSON을 붙여 넣지 않고 targets.json 경로를 준다 / B10: 큰 답은 저장 파일 경로를 넘긴다", () => {
  const rp = readFileSync(join(SKILL, "reference/refuter-prompt.md"), "utf8");
  assert.match(rp, /\{\{targets_path\}\}/); // 경로는 targets가 채운다(v22.test.mjs에서 생성 결과 확인)
  assert.ok(!/<targets JSON>/.test(rp));
  const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  assert.match(md, /harness가 파일로 따로 저장했으면/);
  assert.match(md, /`\{summary, logs, result\}` 래퍼/);
});

test("결정 5-1: finalize·보고서 — 원자료만 미독이면 REVIEW_REQUIRED와 '원자료 미독', 정본 미독은 REVISE", (t) => {
  const { run, out, obligated, crits } = stdRun(t);
  const input = out.documents.find((d) => d.role === "source-material" || d.role === "review-input");
  assert.ok(input, "fixture에 원자료 문서가 있어야 한다");
  const others = out.documents.filter((d) => d !== input).map((d) => d.path);
  const base = { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [], recommendation_conflicts: [], candidate_dispositions: obligated.map((id) => ({ candidate: id, disposition: "rejected", reason: "r" })) };
  cmdSaveJudge(run, { ...base, documents_read: others, documents_unread: [`${input.path} (안 읽음)`] });
  let r = cmdFinalize(run);
  assert.equal(r.verdict.verdict, "REVIEW_REQUIRED");
  assert.deepEqual(r.verdict.incomplete, []);
  assert.match(renderFinal(out, r.out, r.verdict), /원자료 미독\(어느 판정자도 읽지 않은 입력 문서/);
  const plan = others.find((p) => p.endsWith("plan.md"));
  cmdSaveJudge(run, { ...base, documents_read: others.filter((p) => p !== plan), documents_unread: [input.path, plan] });
  r = cmdFinalize(run);
  assert.equal(r.verdict.verdict, "REVISE");
  assert.match(r.verdict.incomplete.join(), /plan\.md \(정본 문서, 재실행 필요\)/);
});
