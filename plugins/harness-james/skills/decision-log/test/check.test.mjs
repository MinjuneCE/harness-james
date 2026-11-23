import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLedger } from "../lib/parse.mjs";
import { evaluate, syncTable } from "../lib/check.mjs";

const ledgerOf = (body, table = "| 번호 | 결정 | 반영 |\n|---|---|---|\n") => `# 결정 기록\n\n## 지금 유효한 결정\n\n${table}\n## 기록\n\n${body}`;
const run = (ledgerText, docs, opts) => evaluate(parseLedger(ledgerText), docs, opts).items;
const pick = (items, id, target = "") => items.filter((it) => it.id === id && it.target === target);
const doc = (name, header, body = "") => ({ name, text: `# ${name}\n\n${header ? `**반영한 결정**: ${header}\n\n` : ""}${body}\n` });

const THREE = ledgerOf(
  "- D3 셋째\n  - 대체: D1\n  - 반영: plan.md\n- D2 둘째\n  - 반영: spec.md\n- D1 첫째\n  - 반영: plan.md\n",
  "| 번호 | 결정 | 반영 |\n|---|---|---|\n| D3 | 셋째 | plan.md |\n| D2 | 둘째 | spec.md |\n",
);

test("모두 맞으면 WARN·FAIL이 없다", () => {
  const items = run(THREE, [doc("plan.md", "~D3", "규칙 (D3)"), doc("spec.md", "~D3", "FR-001 (D2)")]);
  assert.deepEqual(items.filter((it) => it.level !== "PASS"), []);
  assert.match(pick(items, "ledger")[0].summary, /결정 3건, 최신 D3, 대체됨 1건/);
});

test("머리 줄이 뒤처지면 WARN이고, 이 문서를 반영 위치로 적은 결정을 알린다", () => {
  const items = run(THREE, [doc("plan.md", "~D1", "(D1)"), doc("spec.md", "~D3", "(D2)")]);
  const [header] = pick(items, "header", "plan.md");
  assert.equal(header.level, "WARN");
  assert.match(header.summary, /D1까지 반영, 최신 D3 \(2건 뒤\)/);
  assert.deepEqual(header.details, ["이 문서를 반영 위치로 적은 결정: D3"]);
  assert.deepEqual(pick(items, "reflect", "plan.md"), []);
  assert.deepEqual(pick(items, "stale-cite", "plan.md"), []);
});

test("머리 줄이 기록보다 앞서면 FAIL", () => {
  assert.equal(pick(run(THREE, [doc("plan.md", "~D9", "(D3)")]), "header", "plan.md")[0].level, "FAIL");
});

test("spec·plan에 머리 줄이 없으면 WARN, 다른 문서는 보지 않는다", () => {
  const items = run(THREE, [doc("plan.md", null, "(D3)"), doc("notes.md", null, "D1 D77")]);
  assert.equal(pick(items, "header", "plan.md")[0].level, "WARN");
  assert.deepEqual(items.filter((it) => it.target === "notes.md"), []);
});

test("머리 줄에서 번호를 못 읽으면 WARN", () => {
  assert.match(pick(run(THREE, [doc("plan.md", "곧", "(D3)")]), "header", "plan.md")[0].summary, /읽지 못했다/);
});

test("같은 번호가 두 번 나오면 FAIL", () => {
  const items = run(ledgerOf("- D2 둘\n- D2 또 둘\n- D1 하나\n"), []);
  assert.equal(pick(items, "ledger")[0].level, "FAIL");
});

test("반영 위치로 적힌 문서에 인용이 없으면 WARN, 범위 인용은 인정한다", () => {
  const none = run(THREE, [doc("plan.md", "~D3", "인용 없음"), doc("spec.md", "~D3", "D1~D3 반영")]);
  assert.match(pick(none, "reflect", "plan.md")[0].summary, /D3/);
  assert.deepEqual(pick(none, "reflect", "spec.md"), []);
});

test("반영 위치 파일이 없으면 WARN, 대체된 결정의 반영 위치는 보지 않는다", () => {
  const items = run(THREE, [doc("plan.md", "~D3", "(D3)")]);
  const [missing] = pick(items, "reflect");
  assert.equal(missing.details.length, 1);
  assert.match(missing.details[0], /D2 .*spec\.md/);
});

test("대체된 결정만 가리키는 줄은 WARN, 대체한 결정과 함께 적은 줄은 괜찮다", () => {
  const items = run(THREE, [doc("plan.md", "~D3", "옛 규칙 (D1)\n새 규칙 (D3, D1을 대체)\nD1~D2 묶음"), doc("spec.md", "~D3", "(D2)")]);
  const [stale] = pick(items, "stale-cite", "plan.md");
  assert.deepEqual(stale.details, ["plan.md:5 D1 (대체한 결정: D3)"]);
});

test("기록에 없는 번호 인용은 WARN, 이전 기록 범위 안의 번호는 안다", () => {
  const text = `이전 기록: README.md (D1~D10)\n\n${ledgerOf("- D11 열하나\n", "| 번호 | 결정 | 반영 |\n|---|---|---|\n| D11 | 열하나 | |\n")}`;
  const items = run(text, [doc("plan.md", "~D11", "(D4) (D11) (D50)")]);
  assert.match(pick(items, "unknown-cite", "plan.md")[0].summary, /D50$/);
  assert.match(pick(items, "ledger")[0].summary, /이전 기록 D1~D10/);
});

test("이전 기록만 있어도 최신 번호가 된다", () => {
  const items = run("# 결정 기록\n\n이전 기록: README.md (D1~D60)\n", [doc("plan.md", "~D40"), doc("spec.md", "~D60")]);
  assert.match(pick(items, "header", "plan.md")[0].summary, /D40까지 반영, 최신 D60 \(20건 뒤\)/);
  assert.equal(pick(items, "header", "spec.md")[0].level, "PASS");
  assert.deepEqual(pick(items, "table"), []);
});

test("대체 대상이 없거나 뒤 번호면 WARN", () => {
  const items = run(ledgerOf("- D2 둘\n  - 대체: D9\n- D1 하나\n  - 대체: D2\n"), []);
  assert.equal(pick(items, "supersede-ref")[0].details.length, 2);
});

test("표가 기록과 다르면 WARN이고 sync-table 뒤에는 맞는다", () => {
  const text = ledgerOf("- D3 셋째 a|b\n  - 대체: D1\n  - 반영: plan.md\n- D2 둘째\n- D1 첫째\n", "| 번호 | 결정 | 반영 |\n|---|---|---|\n| D1 | 첫째 | |\n");
  const [table] = pick(run(text, []), "table");
  assert.deepEqual(table.details, ["표에 없는 유효 결정: D2, D3", "표에 남은 대체됨·없는 번호: D1"]);
  const synced = syncTable(text, parseLedger(text));
  assert.match(synced, /\| D3 \| 셋째 a\\\|b \| plan\.md \|\n\| D2 \| 둘째 \|  \|\n\n## 기록/);
  assert.deepEqual(pick(run(synced, []), "table"), []);
  assert.equal(syncTable(synced, parseLedger(synced)), synced);
});

test("표 절이 없으면 WARN이고 sync-table은 null", () => {
  const text = "# 결정 기록\n\n## 기록\n\n- D1 하나\n";
  assert.match(pick(run(text, []), "table")[0].summary, /절이 없다/);
  assert.equal(syncTable(text, parseLedger(text)), null);
});

test("답을 기다리는 제안만 INFO로 남는다", () => {
  const items = run(ledgerOf("- D1 하나\n  - 제안: P1\n- P2 둘째 제안\n- P1 첫 제안\n", "| 번호 | 결정 | 반영 |\n|---|---|---|\n| D1 | 하나 | |\n"), []);
  assert.deepEqual(pick(items, "proposal")[0].details, ["P2 (13줄) 둘째 제안"]);
});
