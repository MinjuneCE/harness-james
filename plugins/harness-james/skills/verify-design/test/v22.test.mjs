// skill-check(2026-10-16) 지적 반영 시험: R5 workflow-args·judge-prompt·max 대조·기준 상태, X3 대체 경로 없음, C6 별칭, C4·R10·R4 문서
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runExtract } from "../scripts/extract.mjs";
import { checkAgentDefs, cmdCheck, cmdJudgePrompt, cmdSaveJudge, cmdSaveWorkflow, cmdTargets, cmdWorkflowArgs } from "../scripts/verdict.mjs";
import { checkFindings, modelAlias } from "../scripts/lib/verdict.mjs";
import { defaultArgs, mockRun, splitScript } from "../scripts/check-workflow.mjs";
import { AGENTS_DIR, FIXTURE, SKILL, extractArgs, tmpDir } from "./helpers.mjs";

// 읽기 전용 정의: 같은 플러그인의 agents/
process.env.DV_AGENTS_DIR = AGENTS_DIR;

function setup(t, level = "deep") {
  const run = tmpDir(t);
  const { out } = runExtract(extractArgs(FIXTURE, run, { level }));
  const crits = JSON.parse(readFileSync(join(run, "criteria.json"), "utf8")).criteria.filter((c) => c.status === "to-evaluate");
  return { run, out, crits };
}
const F = (id, sev) => ({ id, criterion: "CON-02", title: "t", severity: sev, confidence: "confirmed", method: "S+L", evidence: [{ doc: "docs/design/sample/plan.md", section: "s", line: 10, quote: "대기 상한은 최대 15분이다" }], touches: ["R"], failure_scenario: "f", recommendation: "r" });

// ---------------------------------------------------------------- R5
test("R5: workflow-args는 criteria·index·perspectives·limits.refute로 args 파일을 만든다", (t) => {
  const { run, out, crits } = setup(t);
  const a = cmdWorkflowArgs(run);
  const saved = JSON.parse(readFileSync(join(run, "workflow-args.json"), "utf8"));
  assert.deepEqual(saved, a);
  assert.deepEqual(a.applicable.map((c) => c.id), crits.map((c) => c.id));
  assert.ok(a.applicable.every((c) => c.scope && c.method && typeof c.weight === "number"));
  assert.equal(a.documents.length, out.documents.length);
  assert.ok(a.documents.every((d) => d.path && d.fs_path && d.role && typeof d.large === "boolean"));
  assert.deepEqual(a.perspectives, JSON.parse(readFileSync(join(SKILL, "reference/perspectives.json"), "utf8")));
  assert.equal(a.refute_max, 3); // fixture 프로파일 limits.refute
  const idx = JSON.parse(readFileSync(join(run, "extract/index.json"), "utf8"));
  assert.deepEqual(a.obligated_candidates, idx.obligated_candidates);
  assert.ok(a.framework_path.endsWith("framework.md") && a.rubric_dir.endsWith("rubrics"));
  assert.equal(a.incremental, undefined);
  for (const k of ["run_dir", "profile_path", "extract_dir", "criteria_path"]) assert.equal(typeof a[k], "string");
});

test("R5: workflow-args 그대로 모의 실행 → save-workflow가 반증 상한을 limits.refute와 대조한다", async (t) => {
  const { run } = setup(t);
  const args = cmdWorkflowArgs(run);
  const { body } = splitScript(readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8"));
  const { result } = await mockRun(body, args);
  assert.equal(result.refutation.max, 3);
  assert.deepEqual(cmdSaveWorkflow(run, result).errors, []);
  const wrong = { ...result, refutation: { ...result.refutation, max: 8 } };
  const r = cmdSaveWorkflow(run, wrong);
  assert.match(r.errors.join(), /refutation\.max 8 ≠ 프로파일 limits\.refute 3/);
  assert.match(cmdCheck(run).errors.join(), /반증 상한 8 ≠ 프로파일 limits\.refute 3/);
});

test("R5: workflow-args 증분 — --carried의 이월 ID와 바뀐 절", (t) => {
  const { run } = setup(t);
  const x = JSON.parse(readFileSync(join(run, "extract.json"), "utf8"));
  x.changed = { any: true, documents: ["docs/design/sample/plan.md"], removed_documents: [], sections: [{ doc: "docs/design/sample/plan.md", section: "s", state: "changed" }] };
  writeFileSync(join(run, "extract.json"), JSON.stringify(x));
  const carried = join(run, "carried.json");
  writeFileSync(carried, JSON.stringify({ carried: [{ id: "F-OLD-1" }], recheck: [{ id: "F-OLD-2" }] }));
  const a = cmdWorkflowArgs(run, { carried });
  assert.deepEqual(a.incremental.carried_ids, ["F-OLD-1"]);
  assert.equal(a.incremental.sections.length, 1);
  const p = cmdJudgePrompt(run, { carried });
  assert.match(p, /증분 검증이다/);
  assert.match(p, /recheck\): F-OLD-2/);
});

test("R5: judge-prompt는 기준·문서 목록을 스크립트가 채운다(빈 자리 없음)", (t) => {
  const { run, out, crits } = setup(t, "standard");
  const p = cmdJudgePrompt(run);
  assert.equal(readFileSync(join(run, "judge-prompt.md"), "utf8"), p);
  assert.ok(!/\{\{|<[^>]*(목록|경로)[^>]*>/.test(p), "채우지 않은 자리가 남았다");
  for (const c of crits) assert.ok(p.includes(`${c.id}(`), c.id);
  for (const d of out.documents) assert.ok(p.includes(`- ${d.path} → ${d.fs_path}`), d.path);
  assert.match(p, new RegExp(`적용 기준\\(${crits.length}개`));
  assert.ok(!p.includes("메인 세션이"), "틀의 설명 부분(--- 위)은 넣지 않는다");
});

test("R5: targets는 반증 프롬프트를 채운다(targets.json 경로, 건수, 순서)", (t) => {
  const { run } = setup(t, "standard");
  cmdSaveJudge(run, { criteria: [], findings: [F("F-1", "high"), F("F-2", "high")] });
  cmdTargets(run);
  const p = readFileSync(join(run, "refutation/prompt.md"), "utf8");
  assert.match(p, /refutation\/targets\.json`의 `targets`\(2건/);
  assert.match(p, /신뢰도 낮은 것 먼저/);
  assert.ok(!/\{\{/.test(p));
});

test("R5: check는 빠진 기준 상태를 오류로 낸다", (t) => {
  const { run, crits } = setup(t, "standard");
  cmdSaveJudge(run, { criteria: crits.slice(1).map((c) => ({ id: c.id, status: "evaluated" })), findings: [], recommendation_conflicts: [] });
  assert.match(cmdCheck(run).errors.join("\n"), new RegExp(`기준 상태 없음 1개: ${crits[0].id}`));
  cmdSaveJudge(run, { criteria: crits.map((c) => ({ id: c.id, status: "evaluated" })), findings: [], recommendation_conflicts: [] });
  assert.ok(!/기준 상태 없음/.test(cmdCheck(run).errors.join()));
});

// ---------------------------------------------------------------- X3
test("X3: 읽기 전용 에이전트 정의가 없으면 대체하지 않고 종료 4로 멈춘다", (t) => {
  const empty = tmpDir(t);
  assert.throws(() => checkAgentDefs(empty, [empty]), (e) => e.code === 4 && /design-verify-judge, design-verify-refuter/.test(e.message) && /대체 경로 없이 멈춘다/.test(e.message));
  assert.doesNotThrow(() => checkAgentDefs(empty, [AGENTS_DIR]));
});

test("X3: 워크플로에 agent_types 대체 경로가 없다", () => {
  const src = readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8");
  assert.ok(!/agent_types/.test(src));
  assert.ok(!/agent_types/.test(readFileSync(join(SKILL, "SKILL.md"), "utf8")));
});

// ---------------------------------------------------------------- C6
test("C6: 요청 모델은 별칭, ID와 별칭을 같은 모델로 본다", () => {
  assert.equal(modelAlias("claude-fable-5-1"), "fable");
  assert.equal(modelAlias("opus"), "opus");
  assert.equal(modelAlias("other-model"), "other-model");
  const doc = { models: { judge: "fable" }, criteria: [], recommendation_conflicts: [], findings: [{ ...F("x", "high"), source: "judge", scope_state: "changed", refutation: { verdict: "upheld", model: "claude-fable-5-1" } }] };
  assert.match(checkFindings(doc, {}).errors.join(), /반증 모델이 찾은 모델과 같다/);
});

test("C6: deep 워크플로 반환 모델은 별칭", async () => {
  const { body } = splitScript(readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8"));
  const { result } = await mockRun(body, defaultArgs(JSON.parse(readFileSync(join(SKILL, "reference/perspectives.json"), "utf8"))));
  assert.deepEqual(result.judge.models, { judge: "opus", refuter: "fable" });
  assert.ok(!/claude-(opus|fable)-/.test(readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8")));
});

// ---------------------------------------------------------------- C4·R10·R4
test("C4·R10: SKILL.md — deep check 오류는 손으로 고치지 않고 멈춤, 런타임 한 줄", () => {
  const md = readFileSync(join(SKILL, "SKILL.md"), "utf8");
  assert.match(md, /오류가 나면 findings JSON을 손으로 고치지 않는다/);
  assert.match(md, /그 관점만 다시 돌리자고 제안/);
  assert.match(md, /런타임: Node 18 이상\. 스크립트는 Node 내장 모듈만 쓰고 외부 패키지·CLI 설치가 필요 없다/);
  assert.match(md, /workflow-args\.json` 내용을 그대로 넘긴다/);
  assert.match(md, /judge-prompt\.md` 내용을 그대로 넘긴다/);
});

const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
test("R4: SCHEMA.md 앞 30줄 안에 목차, 링크 앵커가 실제 제목과 맞는다", () => {
  const md = readFileSync(join(SKILL, "SCHEMA.md"), "utf8");
  const lines = md.split("\n");
  assert.ok(lines.slice(0, 30).some((l) => l === "## 목차"));
  const anchors = new Set(lines.filter((l) => /^#{2,3} /.test(l)).map((l) => slug(l.replace(/^#+ /, ""))));
  const links = [...md.matchAll(/\]\(#([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(links.length >= 7);
  for (const a of links) assert.ok(anchors.has(a), `앵커 없음: ${a}`);
});

test("R5: 옛 추출(index에 obligated_candidates 없음)도 workflow-args가 처리 목록을 만든다", (t) => {
  const { run } = setup(t);
  const want = cmdWorkflowArgs(run).obligated_candidates;
  const ip = join(run, "extract/index.json");
  const idx = JSON.parse(readFileSync(ip, "utf8"));
  delete idx.obligated_candidates;
  writeFileSync(ip, JSON.stringify(idx));
  assert.deepEqual(cmdWorkflowArgs(run).obligated_candidates, want);
  assert.ok(want.length > 0);
});
