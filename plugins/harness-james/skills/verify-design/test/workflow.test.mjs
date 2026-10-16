import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkMeta, contractErrors, defaultArgs, mockRun, splitScript, syntaxCheck } from "../scripts/check-workflow.mjs";
import { AGENT_TYPES } from "../scripts/verdict.mjs";
import { AGENTS_DIR, SKILL, tmpDir } from "./helpers.mjs";

// 정의는 같은 플러그인의 agents/에 있다.
const agentFile = (name) => [join(AGENTS_DIR, `${name}.md`)].find((p) => existsSync(p));

const src = readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8");
const persp = JSON.parse(readFileSync(join(SKILL, "reference/perspectives.json"), "utf8"));

test("관점 매핑: 59기준이 주 담당 관점 하나씩", () => {
  const ids = persp.flatMap((p) => p.primary);
  assert.equal(ids.length, 59);
  assert.equal(new Set(ids).size, 59);
});

test("meta는 순수 리터럴, phase 제목 일치, 금지 API 없음", () => {
  const { metaSrc, body } = splitScript(src);
  const { meta, errors } = checkMeta(metaSrc, body);
  assert.deepEqual(errors, []);
  assert.equal(meta.name, "verify-design-deep");
});

test("감싼 본문 node --check", (t) => {
  const { body } = splitScript(src);
  assert.doesNotThrow(() => syntaxCheck(body, tmpDir(t)));
});

test("모의 실행: 에이전트 ≤ 9, 관점은 opus, 반증은 fable, 반증 ≤ 8", async () => {
  const { body } = splitScript(src);
  const { result, calls } = await mockRun(body, defaultArgs(persp));
  assert.ok(calls.length <= 9, `에이전트 ${calls.length}`);
  assert.ok(calls.filter((c) => c.label.startsWith("review:")).every((c) => c.model === "opus"));
  assert.ok(calls.filter((c) => c.label.startsWith("refute:")).every((c) => c.model === "fable"));
  assert.equal(result.judge.level, "deep");
  assert.equal(result.judge.models.judge, "opus");
  assert.equal(result.refutation.model, "fable");
  assert.ok(result.refutation.verdicts.length <= 8);
  assert.equal(result.refutation.max, 8);
  assert.ok(result.judge.findings.every((f) => f.found_by_model === "opus"));
  // 프롬프트에 읽기 전용 규칙이 들어간다
  assert.ok(calls.every((c) => /읽기만 한다/.test(c.prompt)));
});

test("모의 실행: high가 5건을 넘으면 상한 밖으로 남긴다, THR 꺼지면 공격자 관점 생략", async () => {
  const args = defaultArgs(persp);
  args.applicable = args.applicable.filter((c) => !c.id.startsWith("THR-"));
  const more = persp.map((p) => ({ ...p }));
  const { body } = splitScript(src);
  const { result, calls } = await mockRun(body, { ...args, perspectives: more });
  assert.ok(!calls.some((c) => c.label === "review:attacker"));
  assert.deepEqual(result.judge.perspectives_skipped, ["attacker"]);
  // 관점 4개 × high 1 = 4 → 상한 안
  assert.equal(result.refutation.over_cap.length, 0);
  const args2 = { ...defaultArgs(persp), refute_max: 2 };
  const r2 = await mockRun(body, args2);
  assert.equal(r2.result.refutation.verdicts.length, 2);
  assert.equal(r2.result.refutation.over_cap.length, 3);
  // 기본 상한 8: high 5건이 모두 반증 대상
  const r3 = await mockRun(body, defaultArgs(persp));
  assert.equal(r3.result.refutation.targets.length, 5);
  assert.equal(r3.result.refutation.over_cap.length, 0);
});

test("읽기 전용 에이전트 정의: Read·Grep·Glob만, 워크플로가 그 유형을 쓴다", async () => {
  for (const name of ["design-verify-judge", "design-verify-refuter"]) {
    const file = agentFile(name);
    assert.ok(file, `에이전트 정의 없음: ${name}`);
    const md = readFileSync(file, "utf8");
    const fm = md.match(/^---\n([\s\S]*?)\n---/)[1];
    assert.match(fm, new RegExp(`^name: ${name}$`, "m"));
    assert.match(fm, /^tools: Read, Grep, Glob$/m);
    assert.ok(!/Write|Edit|Bash/.test(fm));
  }
  const { body } = splitScript(src);
  const { calls } = await mockRun(body, defaultArgs(persp));
  assert.ok(calls.filter((c) => c.label.startsWith("review:") || c.label === "aggregate").every((c) => c.agentType === AGENT_TYPES.judge));
  assert.ok(calls.filter((c) => c.label.startsWith("refute:")).every((c) => c.agentType === AGENT_TYPES.refuter));
  // 대체 경로 없음(X3): agent_types를 넘겨도 유형은 그대로, 관점이 모두 실패하면 멈춘다
  const forced = await mockRun(body, { ...defaultArgs(persp), agent_types: null });
  assert.ok(forced.calls.every((c) => c.agentType === AGENT_TYPES.judge || c.agentType === AGENT_TYPES.refuter));
  // 플러그인 에이전트 이름: "<플러그인>:<정의 파일 이름>"
  assert.deepEqual(AGENT_TYPES, { judge: "harness-james:design-verify-judge", refuter: "harness-james:design-verify-refuter" });
  assert.ok(!/agent_types/.test(body));
  await assert.rejects(mockRun(body, defaultArgs(persp), (label) => (label.startsWith("review:") ? null : undefined)), /관점 에이전트 결과가 하나도 없다/);
});

test("deep 반증 순서와 상한: critical 먼저, refute_max", async () => {
  const { body } = splitScript(src);
  const r = await mockRun(body, { ...defaultArgs(persp), refute_max: 3 });
  assert.equal(r.result.refutation.max, 3);
  assert.equal(r.result.refutation.targets.length, 3);
  assert.equal(r.result.refutation.over_cap.length, 2);
  assert.ok(r.calls.filter((c) => c.label.startsWith("refute:")).length <= 3);
});

const FF = (id, sev, conf, crit) => ({ id, criterion: crit, title: "t", severity: sev, confidence: conf, scope_state: "changed", method: "L", evidence: [{ doc: "d.md", line: 1, quote: "q" }], absence: null, touches: ["R"], failure_scenario: "f", recommendation: "r" });

test("deep 반증 순서(결정 2): 심각도 → 신뢰도 낮은 것 먼저 → R(c)", async () => {
  const { body } = splitScript(src);
  const respond = (label) => {
    if (label === "review:verifier") return { findings: [FF("V1", "high", "confirmed", "TRC-02"), FF("V2", "high", "confirmed", "TRC-02"), FF("V3", "medium", "confirmed", "TRC-02")], criteria: [], documents_read: [] };
    if (label === "review:implementer") return { findings: [FF("I1", "high", "likely", "BEH-03"), FF("I2", "critical", "confirmed", "BEH-07")], criteria: [], documents_read: [] };
    if (label === "review:attacker") return { findings: [FF("A1", "high", "possible", "THR-02")], criteria: [], documents_read: [] };
    if (label?.startsWith("review:")) return { findings: [], criteria: [], documents_read: [] };
    return undefined;
  };
  const r = await mockRun(body, { ...defaultArgs(persp), refute_max: 3 }, respond);
  // critical I2 → high possible A1 → high likely I1; R(TRC-02)가 커도 confirmed V1·V2는 뒤
  assert.deepEqual(r.result.refutation.targets, ["I2", "A1", "I1"]);
  assert.deepEqual(r.result.refutation.over_cap.sort(), ["V1", "V2"]);
  assert.match(r.result.refutation.order, /신뢰도 낮은 것 먼저/);
});

test("deep 계약: 원자료 담당 관점 하나, 미독 합산 금지, 반증 근거 실제 경로, BND-06 유지, 큰 문서 표시", async () => {
  const { body } = splitScript(src);
  const { result, calls } = await mockRun(body, defaultArgs(persp));
  assert.deepEqual(contractErrors(result, calls, persp), []);
  // 원자료는 결정 검토자만
  assert.deepEqual(calls.filter((c) => c.label.startsWith("review:") && c.prompt.includes("mapped/src.md")).map((c) => c.label), ["review:decision-reviewer"]);
  assert.deepEqual(result.judge.documents_unread, ["src.md (grep 일부만)"]);
  assert.equal(result.judge.documents_unread_raw, 2);
});

test("deep 구체 후보 처리 목록: 관점별 수집, 집계에서 합쳐진 id는 남은 id로", async () => {
  const { body } = splitScript(src);
  const respond = (label, prompt) => {
    if (label === "aggregate") {
      const list = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      const keep = list[0];
      return { findings: [keep, ...list.slice(2)], merged: [{ kept: keep.id, absorbed: [list[1].id] }], recommendation_conflicts: [{ findings: [keep.id, list[2].id], note: "더하라 대 빼라" }] };
    }
    return undefined;
  };
  const { result, calls } = await mockRun(body, defaultArgs(persp), respond);
  const disp = result.judge.candidate_dispositions;
  assert.deepEqual(disp.map((d) => d.candidate).sort(), ["C-BND-04-0002", "C-CON-05-0001"]);
  // implementer(CON-05)가 낸 F-CON-01-implementer-02는 집계에서 F-CON-01-implementer-01로 합쳐졌다
  const con = disp.find((d) => d.candidate === "C-CON-05-0001");
  assert.equal(con.finding, "F-CON-01-implementer-01");
  assert.equal(con.finding_before_merge, "F-CON-01-implementer-02");
  assert.equal(result.judge.recommendation_conflicts.length, 1);
  // 후보 목록은 주 담당 관점 프롬프트에만 간다
  assert.ok(calls.find((c) => c.label === "review:implementer").prompt.includes("C-CON-05-0001"));
  assert.ok(!calls.find((c) => c.label === "review:operator").prompt.includes("C-CON-05-0001"));
});

test("deep 스키마: absence는 null 허용(B5), 집계는 recommendation_conflicts 필수(B15)", async () => {
  const { body } = splitScript(src);
  const { calls } = await mockRun(body, defaultArgs(persp));
  const rv = calls.find((c) => c.label === "review:implementer").schema;
  assert.deepEqual(rv.properties.findings.items.properties.absence.type, ["object", "null"]);
  assert.ok(rv.properties.candidate_dispositions);
  const ag = calls.find((c) => c.label === "aggregate").schema;
  assert.ok(ag.required.includes("recommendation_conflicts"));
});
