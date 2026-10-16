import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import { globToRegExp, parseRubric, parseUnifiedDiff, tokenizeArgs } from "../scripts/lib.mjs";

test("tokenizeArgs: 공백으로 나누고 셸 확장은 하지 않는다", () => {
  assert.deepEqual(tokenizeArgs("theme feat/a$(id);b `x` *.js $HOME"), ["theme", "feat/a$(id);b", "`x`", "*.js", "$HOME"]);
});

test("tokenizeArgs: 셸식 따옴표와 역슬래시", () => {
  assert.deepEqual(tokenizeArgs(`a 'b c' "d \\"e\\" \\$f" g\\ h`), ["a", "b c", 'd "e" $f', "g h"]);
  assert.deepEqual(tokenizeArgs(`""  ''`), ["", ""]);
  assert.deepEqual(tokenizeArgs("  \n "), []);
});

test("tokenizeArgs: 따옴표 밖에서 시작한 ~ 만 홈으로 바꾼다", () => {
  assert.deepEqual(tokenizeArgs("~/x '~/y' a~/z ~"), [`${homedir()}/x`, "~/y", "a~/z", homedir()]);
});

test("tokenizeArgs: 닫히지 않은 따옴표는 오류", () => {
  assert.throws(() => tokenizeArgs("a 'b"), /작은따옴표/);
  assert.throws(() => tokenizeArgs('a "b'), /큰따옴표/);
});

test("globToRegExp: **/, *, ?", () => {
  assert.ok(globToRegExp("src/**/*.js").test("src/a.js"));
  assert.ok(globToRegExp("src/**/*.js").test("src/x/y/a.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/x/a.js"));
  assert.ok(globToRegExp("**").test("a/b/c"));
  assert.ok(globToRegExp("a?.md").test("ab.md"));
  assert.ok(!globToRegExp("a.md").test("aXmd"));
});

test("parseUnifiedDiff: 수정 파일의 추가·삭제 줄 번호", () => {
  const patch = [
    "diff --git a/src/a.js b/src/a.js", "index 1..2 100644", "--- a/src/a.js", "+++ b/src/a.js",
    "@@ -3,3 +3,4 @@", " x", "-y", "+y2", "+y3", " z",
  ].join("\n");
  const [f] = parseUnifiedDiff(patch);
  assert.equal(f.path, "src/a.js");
  assert.equal(f.status, "M");
  assert.deepEqual(f.added.map((l) => l.line), [4, 5]);
  assert.deepEqual(f.removed.map((l) => l.line), [4]);
});

test("parseUnifiedDiff: 이름 변경, 새 파일, 삭제, 바이너리", () => {
  const patch = [
    "diff --git a/old.js b/new.js", "similarity index 90%", "rename from old.js", "rename to new.js",
    "diff --git a/n.js b/n.js", "new file mode 100644", "--- /dev/null", "+++ b/n.js", "@@ -0,0 +1 @@", "+hi",
    "diff --git a/d.js b/d.js", "deleted file mode 100644", "--- a/d.js", "+++ /dev/null", "@@ -1 +0,0 @@", "-bye",
    "diff --git a/i.png b/i.png", "Binary files a/i.png and b/i.png differ",
  ].join("\n");
  const fs = parseUnifiedDiff(patch);
  assert.deepEqual(fs.map((f) => [f.status, f.path, f.old_path]), [["R", "new.js", "old.js"], ["A", "n.js", null], ["D", "d.js", "d.js"], ["M", "i.png", "i.png"]]);
  assert.equal(fs[3].binary, true);
});

test("parseUnifiedDiff: 따옴표로 감싼 경로(비ASCII)", () => {
  const patch = ['diff --git "a/\\355\\225\\234.js" "b/\\355\\225\\234.js"', '--- "a/\\355\\225\\234.js"', '+++ "b/\\355\\225\\234.js"', "@@ -1 +1 @@", "-a", "+b"].join("\n");
  assert.equal(parseUnifiedDiff(patch)[0].path, "한.js");
});

test("parseRubric: 기준 목록, 적용 특성, 자동 신호 규칙, 버전", () => {
  const md = [
    "# REL", "", "- 버전: 2.1.0 (초안)", "", "## 기준 목록", "",
    "| ID | 이름 | 적용 | 가중치 | 임계값 |", "|---|---|---|---:|---:|",
    "| REL-01 | **멱등성** | 서버 | 1.5 | 30 |", "| REL-02 | 렌더 | 클라이언트 | 1.0 | 50 |", "| REL-03 | 공통 | 공통 | | |",
    "", "## 자동 신호", "", "```json", '{"rules":[{"id":"r1"}]}', "```", "",
  ].join("\n");
  const r = parseRubric(md, "REL");
  assert.equal(r.version, "2.1.0");
  assert.deepEqual(r.criteria.map((c) => [c.id, c.name, c.traits, c.weight, c.review_threshold]), [
    ["REL-01", "멱등성", ["server"], 1.5, 30], ["REL-02", "렌더", ["client"], 1, 50], ["REL-03", "공통", ["common"], null, null],
  ]);
  assert.deepEqual(r.rules, [{ id: "r1" }]);
  assert.throws(() => parseRubric(md.replace('{"rules"', "{rules"), "REL"), /자동 신호 JSON/);
});
