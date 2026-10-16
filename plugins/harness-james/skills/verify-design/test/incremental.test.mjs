import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffIndex, runExtract } from "../scripts/extract.mjs";
import { carryFindings } from "../scripts/lib/verdict.mjs";
import { copyFixture, extractArgs, tmpDir } from "./helpers.mjs";

test("절 해시 색인과 changed 집합, 후보 scope_state", (t) => {
  const root = copyFixture(t);
  const o1 = tmpDir(t);
  runExtract(extractArgs(root, o1));
  const p = join(root, "docs/design/sample/plan.md");
  writeFileSync(p, readFileSync(p, "utf8").replace("대기 상한은 최대 15분이다.", "대기 상한은 최대 10분이다."));
  const o2 = tmpDir(t);
  const { out } = runExtract(extractArgs(root, o2, { changedSince: join(o1, "section-index.json") }));
  assert.equal(out.label, "incr");
  assert.deepEqual(out.changed.documents, ["docs/design/sample/plan.md"]);
  assert.deepEqual(out.changed.sections.map((s) => [s.section, s.state]), [["Plan (v0.2) > 설정", "changed"]]);
  // 범위 '절' 기준(REQ-01)의 후보는 바뀌지 않은 절이면 carried
  const vague = out.candidates.find((c) => c.kind === "vague-word");
  assert.equal(vague.scope_state, "carried");
  // 범위 '묶음' 기준은 바뀐 문서가 있으면 changed
  assert.ok(out.candidates.filter((c) => c.criterion === "CON-05").every((c) => c.scope_state === "changed"));
  // 범위 '절' 기준 REQ-01 은 증분 대상으로 바뀐 절만 받는다
  const crit = JSON.parse(readFileSync(join(o2, "criteria.json"), "utf8")).criteria.find((c) => c.id === "REQ-01");
  assert.deepEqual(crit.incremental_targets.map((s) => s.doc), ["docs/design/sample/plan.md"]);
});

test("변경 없음이면 skipped-unchanged", (t) => {
  const root = copyFixture(t);
  const o1 = tmpDir(t);
  runExtract(extractArgs(root, o1));
  const o2 = tmpDir(t);
  const { out } = runExtract(extractArgs(root, o2, { changedSince: join(o1, "section-index.json") }));
  assert.equal(out.changed.any, false);
  assert.ok(out.criteria_status.filter((c) => c.status !== "not-applicable" && c.status !== "disabled").every((c) => c.status === "skipped-unchanged"));
});

test("diffIndex: 추가·삭제 문서와 절", () => {
  const prev = { docs: { a: { hash: "1", sections: { s1: { hash: "x" }, s2: { hash: "y" } } }, gone: { hash: "9", sections: {} } } };
  const cur = { docs: { a: { hash: "2", sections: { s1: { hash: "x" }, s3: { hash: "z" } } }, b: { hash: "3", sections: { t: { hash: "q" } } } } };
  const d = diffIndex(prev, cur);
  assert.deepEqual(d.documents.sort(), ["a", "b"]);
  assert.deepEqual(d.removed_documents, ["gone"]);
  assert.deepEqual(d.sections.map((s) => `${s.doc}/${s.section}/${s.state}`).sort(), ["a/s2/removed", "a/s3/added", "b/t/added"]);
});

test("이전 finding 이월: 근거 절이 안 바뀌면 carried", () => {
  const changed = { documents: ["d1"], removed_documents: [], sections: [{ doc: "d1", section: "A", state: "changed" }] };
  const prev = [
    { id: "F1", evidence: [{ doc: "d1", section: "A", line: 1, quote: "q" }], scope_state: "changed" },
    { id: "F2", evidence: [{ doc: "d1", section: "B", line: 9, quote: "q" }], scope_state: "changed" },
    { id: "F3", evidence: [], absence: { searched: ["d1 § 전체"] }, scope_state: "changed" },
    { id: "F4", evidence: [{ doc: "d2", section: "X", line: 1, quote: "q" }], scope_state: "resolved" },
  ];
  const r = carryFindings(prev, changed);
  assert.deepEqual(r.recheck.map((f) => f.id), ["F1", "F3"]);
  assert.deepEqual(r.carried.map((f) => [f.id, f.scope_state]), [["F2", "carried"]]);
});
