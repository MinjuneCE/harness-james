// 시험용 가짜 신호 도구. reach.mjs·ledger-check.mjs·co-change.mjs·fm-check.mjs가 이 파일을 부른다.
// FAKE_SIGNAL_FAIL=<tool>이면 그 도구는 종료 코드 3과 status error를 낸다. 받은 인자는 FAKE_SIGNAL_LOG 파일에 한 줄씩 남긴다.
import { appendFileSync, writeFileSync } from "node:fs";

export function fake(tool, argv) {
  const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  // node --test test/ 가 test/ 아래 .mjs를 모두 실행한다. 인자 없이 불리면 아무것도 하지 않는다
  if (!argv.includes("--json")) return;
  const name = tool === "reach" && argv.includes("--compare") ? "reach-compare" : tool;
  if (process.env.FAKE_SIGNAL_LOG) appendFileSync(process.env.FAKE_SIGNAL_LOG, `${name} ${JSON.stringify(argv)}\n`);
  const out = at("--json");
  const doc = { tool: name, version: 1, repo: at("--repo"), base: at("--base"), head: at("--head") ?? at("--ref") ?? at("--a"), generated_at: new Date().toISOString(), status: "ok", note: null, items: [] };
  if (process.env.FAKE_SIGNAL_FAIL === name) {
    doc.status = "error";
    doc.note = "컴파일 실패(가짜)";
    if (out) writeFileSync(out, JSON.stringify(doc));
    console.error("compile failed");
    process.exit(3);
  }
  if (name === "reach") doc.items.push({
    id: "reach:orphaned-definition:demo.Old#run", kind: "orphaned-definition", severity: "WARN", symbol: "demo.Old#run",
    message: "갈림점에서 불렸는데 head에서 부르는 곳이 0", head: [{ file: "src/core/old.js", line: 2 }], base: [{ file: "src/core/a.js", line: 3 }], docs: [],
  }, {
    id: "reach:test-only-public:demo.Old#x", kind: "test-only-public", severity: "INFO", symbol: "demo.Old#x",
    message: "시험만 부름", head: [{ file: "src/core/old.js", line: 5 }], base: [], docs: [],
  });
  // FAKE_SIGNAL_INFO=n: reach-compare에 INFO(added-by-b)를 n개 더 낸다
  if (name === "reach-compare") for (let i = 0; i < Number(process.env.FAKE_SIGNAL_INFO ?? 0); i++) doc.items.push({
    id: `reach-compare:added-by-b:demo.New${i}`, kind: "added-by-b", severity: "INFO", symbol: `demo.New${i}`,
    message: "B에만 있는 main 클래스", head: [{ file: `src/core/new${i}.js`, line: 1 }], base: [], docs: [],
  });
  if (name === "ledger") doc.items.push({
    id: "ledger:ledger-delete-remains:demo.Old", kind: "ledger-delete-remains", severity: "FAIL", symbol: "demo.Old",
    message: "장부가 지운다고 했는데 남음", head: [{ file: "src/core/old.js", line: 1 }], base: [], docs: [{ file: "docs/design/plan.md", line: 7 }],
  });
  if (name === "co-change") doc.items.push({
    id: "co-change:replica-older:src/core/a.js", kind: "replica-older", severity: "WARN", symbol: "src/core/a.js",
    message: "원천이 바뀌었는데 복제본이 더 오래됨", head: [{ file: "src/core/a.js", line: 1 }], base: [], docs: [],
  });
  if (name === "reach-compare") doc.items.push({
    id: "reach-compare:definition-revived:demo.Old", kind: "definition-revived", severity: "WARN", symbol: "demo.Old",
    message: "A에서 지운 정의가 B에 다시 있음", head: [{ file: "src/core/old.js", line: 1 }], base: [], docs: [],
  });
  if (name === "feature-map") doc.items.push({
    id: "feature-map:feature-stale:001-cart", kind: "feature-stale", severity: "WARN", symbol: "001-cart",
    message: "기능 문서의 verified 뒤 구조 경로에 커밋이 있음", head: [{ file: "src/cart/a.js", line: 1 }], base: [], docs: [{ file: "map/001-cart.md", line: 1 }],
  }, {
    id: "feature-map:feature-uncovered:src/new.js", kind: "feature-uncovered", severity: "WARN", symbol: "src/new.js",
    message: "갈림점 뒤 바뀐 파일이 어느 구조에도 안 걸림", head: [{ file: "src/new.js", line: 1 }], base: [], docs: [],
  });
  writeFileSync(out, JSON.stringify(doc, null, 2));
  console.log(`${doc.items.length} items`);
}
