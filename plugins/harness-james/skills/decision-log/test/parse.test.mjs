import { test } from "node:test";
import assert from "node:assert/strict";
import { citations, citedNumbers, docCitations, maskNonProse, parseDocHeader, parseLedger } from "../lib/parse.mjs";

test("citations: 낱개와 범위를 나눠 읽는다", () => {
  assert.deepEqual(citations("D12와 D33~D35, D40-D41을 따른다 (D7)"), { singles: [12, 7], ranges: [[33, 35], [40, 41]] });
});

test("citations: 띄어 쓴 하이픈은 범위가 아니다", () => {
  assert.deepEqual(citations("D64 - D189가 대체"), { singles: [64, 189], ranges: [] });
});

test("citations: 다른 번호 체계는 세지 않는다", () => {
  assert.deepEqual(citations("D-05, ID12, D2C, 회의록 D6, DEF-001").singles, []);
});

test("citedNumbers: 범위를 펼친다", () => {
  assert.deepEqual([...citedNumbers({ singles: [1], ranges: [[3, 5]] })].sort((a, b) => a - b), [1, 3, 4, 5]);
});

test("maskNonProse: 코드 블록과 HTML 주석을 비우고 줄 수는 지킨다", () => {
  const text = ["a D1", "```", "- D2 x", "```", "b <!-- D3", "D4 --> c D5", "~~~", "D6", "~~~"].join("\n");
  assert.deepEqual(maskNonProse(text), ["a D1", "", "", "", "b ", " c D5", "", "", ""]);
});

const LEDGER = `# 결정 기록: 예시

이전 기록: [README.md](README.md#결정-기록) (D1~D10)

## 지금 유효한 결정

| 번호 | 결정 | 반영 |
|---|---|---|
| D13 | 셋째 | plan.md |
| D11 | 첫째 | spec.md |

## 기록

### 2026-11-24 10:12 (사용자, 구현 세션 — 대기 규칙)

원자료: \`a.log\` 12줄 "그렇게 가자"

- D13 셋째 결정이다.
  - 이유: 값이 싸다
  - 대체: D12
  - 일부 대체: D4 (다시 시도 쪽만)
  - **반영:** plan.md, contracts/api.yaml
  - 제안: P1
- P2 구현 중에 본 것

### 2026-11-23 09:00 (사용자)

- D12 둘째 결정이다.
  - 반영: plan.md §3, spec.md FR-012
- D11 첫째 결정이다.
- P1 먼저 낸 제안

\`\`\`markdown
- D99 예시일 뿐
\`\`\`
`;

test("parseLedger: 결정·제안·표·이전 기록을 읽는다", () => {
  const ledger = parseLedger(LEDGER);
  assert.deepEqual(ledger.decisions.map((d) => d.n), [13, 12, 11]);
  const d13 = ledger.decisions[0];
  assert.equal(d13.text, "셋째 결정이다.");
  assert.equal(d13.session, "2026-11-24 10:12 (사용자, 구현 세션 — 대기 규칙)");
  assert.deepEqual(d13.supersedes, [12]);
  assert.deepEqual(d13.partial, [4]);
  assert.deepEqual(d13.reflects, ["plan.md", "contracts/api.yaml"]);
  assert.deepEqual(d13.resolves, [1]);
  assert.deepEqual(ledger.decisions[1].reflects, ["plan.md", "spec.md"]);
  assert.deepEqual(ledger.proposals.map((p) => p.n), [2, 1]);
  assert.deepEqual(ledger.tableRows.map((r) => r.n), [13, 11]);
  assert.deepEqual(ledger.prior, { from: 1, to: 10 });
  assert.equal(LEDGER.split("\n")[ledger.table.start], "## 지금 유효한 결정");
  assert.equal(LEDGER.split("\n")[ledger.table.end], "## 기록");
});

test("parseLedger: 들여쓰지 않은 문단 뒤의 하위 줄은 결정에 붙지 않는다", () => {
  const ledger = parseLedger("## 기록\n\n- D1 하나\n\n문단\n  - 반영: plan.md\n");
  assert.deepEqual(ledger.decisions[0].reflects, []);
});

test("parseDocHeader: 굵은 글씨, 없음, 줄 없음", () => {
  assert.deepEqual(parseDocHeader("# 제목\n\n**반영한 결정**: ~D40 ([decisions.md](decisions.md))\n"), { n: 40, line: 3 });
  assert.deepEqual(parseDocHeader("반영한 결정: 없음\n"), { n: 0, line: 1 });
  assert.equal(parseDocHeader("# 제목\n본문 D5\n"), null);
  assert.equal(parseDocHeader(`${"\n".repeat(60)}반영한 결정: ~D3\n`), null);
  assert.deepEqual(parseDocHeader("반영한 결정: 곧\n"), { n: null, line: 1 });
});

test("docCitations: 머리 줄은 뺀다", () => {
  assert.deepEqual(docCitations("반영한 결정: ~D9\n본문 (D3)\n", 1), [{ line: 2, singles: [3], ranges: [] }]);
});
