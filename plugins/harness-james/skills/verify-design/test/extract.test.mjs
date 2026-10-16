import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CONCRETE_KINDS } from "../scripts/lib/candidates.mjs";
import { runExtract, resolveProfilePath } from "../scripts/extract.mjs";
import { FIXTURE, extractArgs, tmpDir } from "./helpers.mjs";

function run(t) {
  const out = tmpDir(t);
  return runExtract(extractArgs(FIXTURE, out)).out;
}
const kinds = (x, kind) => x.candidates.filter((c) => c.kind === kind);
const at = (c) => c.evidence.map((e) => `${e.doc.split("/").pop()}:${e.line}`);

test("문서 수집과 역할", (t) => {
  const x = run(t);
  assert.equal(x.documents.length, 7);
  // 0.1.2 검사 규칙: 맞는 절 없는 원 요구 출처, relation 없는 compare_keys
  assert.deepEqual(x.profile_errors.sort(), ['parameters.no_rel: compare_keys가 있는데 relation이 없다', 'requirement_sources: "없는 절" 절이 docs/design/sample/spec.md에 없다']);
  assert.equal(x.documents.find((d) => d.path.endsWith("notes/rules.md")).role, "requirement");
  assert.ok(x.estimate.cost_line.includes("보정 1회 기준"));
});

test("CON-05: 은퇴 용어는 이력 맥락 밖에서만 후보", (t) => {
  const x = run(t);
  const r = kinds(x, "retired-term-live");
  assert.deepEqual(r.map((c) => at(c)[0]).sort(), ["input.md:3", "plan.md:12"]);
  // legacyFlush 는 v0.1·삭제 줄에만 있다
  assert.ok(!r.some((c) => c.summary.includes("legacyFlush")));
  assert.equal(r.find((c) => at(c)[0] === "input.md:3").doc_class, "input");
});

test("CON-05: 합친 ID를 이력 맥락 없이 참조", (t) => {
  const x = run(t);
  const r = kinds(x, "retired-id-reference").filter((c) => c.summary.includes("SC-A-01"));
  assert.deepEqual(r.map((c) => at(c)[0]), ["spec.md:26"]);
});

test("CON-01: 금지 동의어", (t) => {
  const x = run(t);
  assert.deepEqual(kinds(x, "forbidden-term").map((c) => at(c)[0]), ["plan.md:14"]);
});

test("CON-02: 설정 값 충돌과 수치 묶음", (t) => {
  const x = run(t);
  const cfg = kinds(x, "config-conflict");
  assert.equal(cfg.length, 1);
  assert.match(cfg[0].summary, /retry\.max-wait.*PT5M.*PT3M/);
  const vg = kinds(x, "value-group");
  assert.ok(vg.some((c) => c.summary.includes("최대") && c.summary.includes("15분") && c.summary.includes("10분")));
  assert.ok(!vg.some((c) => c.summary.includes("retry.max-wait")), "설정 키는 config-conflict 몫");
});

test("BND-04: 두 번호 체계와 인용 분류", (t) => {
  const x = run(t);
  assert.equal(kinds(x, "dual-numbering").length, 1);
  assert.deepEqual(kinds(x, "label-ref-undefined").map((c) => c.summary), ['"규칙 4" 인용: 어느 번호에도 없음']);
  assert.ok(kinds(x, "label-ref-ambiguous").some((c) => c.summary.startsWith('"규칙 2"')));
});

test("BND-03: 깨진 앵커는 잡고 맞는 앵커는 통과", (t) => {
  const x = run(t);
  const a = kinds(x, "broken-anchor");
  assert.equal(a.length, 1);
  assert.match(a[0].summary, /#없는-절/);
  assert.ok(kinds(x, "time-statement").some((c) => at(c)[0] === "plan.md:12"));
});

test("BND-01·BND-02·CON-07·CON-04·CON-03", (t) => {
  const x = run(t);
  assert.equal(kinds(x, "duplicate-table-header").length, 1);
  assert.deepEqual(kinds(x, "commit-off-baseline").map((c) => c.summary), ["커밋 def5678가 프로파일 baseline과 다름"]);
  assert.equal(kinds(x, "header-version").length, 1);
  assert.deepEqual(kinds(x, "transition-not-in-canonical").map((c) => c.summary.match(/전이 (\S+?)가/)[1]), ["WAITING→CANCELED"]);
  assert.ok(kinds(x, "field-not-in-data-model").some((c) => c.summary.includes("poll_cursor")));
});

test("REQ·EVD·TRC·THR·FLR 추출", (t) => {
  const x = run(t);
  assert.deepEqual(kinds(x, "vague-word").map((c) => at(c)[0]), ["spec.md:7"]);
  assert.deepEqual(kinds(x, "flow-no-acceptance").map((c) => c.summary), ["흐름 US2 절에 수용 기준 표지 없음"]);
  assert.ok(kinds(x, "external-claim-unmarked").some((c) => at(c)[0] === "spec.md:6"));
  const unv = kinds(x, "unverified-missing-fields");
  assert.equal(unv.length, 1);
  assert.match(unv[0].summary, /impact/);
  const noTask = kinds(x, "requirement-no-task")[0];
  assert.deepEqual(noTask.ids, ["REQ-002", "REQ-003", "US1", "US2"]);
  assert.equal(kinds(x, "threat-row-no-id").length, 1);
  assert.ok(kinds(x, "timing-setting").some((c) => c.summary.includes("poll.interval")));
});

test("REQ-02: S 단독 finding", (t) => {
  const x = run(t);
  assert.equal(x.script_findings.length, 1);
  const f = x.script_findings[0];
  assert.equal(f.criterion, "REQ-02");
  assert.equal(f.source, "script");
  assert.equal(f.evidence[0].line, 19);
  assert.ok(f.severity_note);
});

test("모든 후보가 기준·종류·id를 가진다", (t) => {
  const x = run(t);
  for (const c of x.candidates) {
    assert.match(c.id, /^C-[A-Z]{3}-\d{2}-\d{4}$/);
    assert.ok(c.kind && c.summary);
    for (const e of c.evidence) assert.ok(e.doc && Number.isInteger(e.line) && typeof e.quote === "string");
  }
});

test("--map 으로 논리 경로를 다른 폴더로 읽는다", (t) => {
  const out = tmpDir(t);
  const x = runExtract(extractArgs(join(FIXTURE, ".."), out, { profile: "bundle-a/profile.json", maps: ["docs/design/=bundle-a/docs/design/"] })).out;
  assert.equal(x.documents.length, 7);
  assert.ok(x.documents[0].path.startsWith("docs/design/"));
  assert.ok(x.documents[0].fs_path.startsWith("bundle-a/"));
});

test("프로파일 이름 해석", () => {
  assert.match(resolveProfilePath("/r", "sample"), /docs\/evaluation\/design\/profiles\/sample\.json$/);
  assert.equal(resolveProfilePath("/r", "x/p.json"), "/r/x/p.json");
});

test("REQ-02: 낱말을 언급만 하는 문장은 자리표시가 아니다", (t) => {
  const x = run(t);
  assert.deepEqual(x.script_findings.map((f) => f.evidence[0].quote), ["- 알림 채널은 TBD."]);
});

test("0.1.2 requirement_sources: 실제 절 제목·배열·lines", (t) => {
  const x = run(t);
  const s = x.extract.trace.source_ids;
  assert.equal(s[0].matched_sections, 1);
  assert.equal(s[1].matched_sections, 2);
  assert.equal(s[2].lines, "3-3");
  assert.deepEqual(s[2].ids.sort(), ["DEC1", "DEC3", "REQ-001", "REQ-003"]);
  assert.deepEqual(s[3].unmatched, ["없는 절"]);
  assert.ok(x.candidates.some((c) => c.kind === "source-section-unmatched" && c.summary.includes("없는 절")));
});

test("0.1.2 ref_only: 정의 없는 참조로 세지 않고 번호 목록과 대조", (t) => {
  const x = run(t);
  assert.ok(!x.extract.ids.undefined_references.some((u) => u.id.startsWith("요약")));
  const miss = x.candidates.filter((c) => c.kind === "ref-only-undefined");
  assert.deepEqual(miss.map((c) => c.summary), ["요약 9: docs/design/sample/notes/rules.md의 번호 목록에 9번이 없음"]);
  assert.deepEqual(x.extract.ids.ref_only_checked[0].numbers, [1, 2, 3]);
});

test("0.1.2 parameters.compare_keys: relation 대조", (t) => {
  const x = run(t);
  const pc = x.extract.numbers.parameter_checks;
  const v = pc.filter((p) => p.parameter === "vendor_max_wait");
  assert.deepEqual(v.map((p) => [p.value, p.status]).sort(), [["PT3M", "violated"], ["PT5M", "violated"]]);
  assert.ok(pc.some((p) => p.parameter === "no_rel" && p.status === "no-relation"));
  const c = x.candidates.filter((k) => k.kind === "parameter-mismatch");
  assert.equal(c.length, 2);
  assert.ok(c.every((k) => k.criterion === "FLR-03"));
});

test("판정자용 분할: index.json + 차원 파일, 후보 수 합 = 전체", (t) => {
  const out = tmpDir(t);
  const { out: x } = runExtract(extractArgs(FIXTURE, out));
  const idx = JSON.parse(readFileSync(join(out, "extract/index.json"), "utf8"));
  assert.equal(idx.files.length, 11);
  assert.equal(idx.files.reduce((n, f) => n + f.candidates + f.input_only, 0), x.candidates.length);
  const bnd = JSON.parse(readFileSync(join(out, "extract/BND.json"), "utf8"));
  assert.ok(bnd.candidates.every((c) => CONCRETE_KINDS.includes(c.kind) && c.evidence.every((e) => typeof e.quote === "string")));
  assert.ok(bnd.candidate_groups.every((g) => !CONCRETE_KINDS.includes(g.kind) && g.entries.length === g.count));
  const req = JSON.parse(readFileSync(join(out, "extract/REQ.json"), "utf8"));
  assert.equal(req.script_findings.length, 1);
  assert.ok(!("extract" in idx));
});
