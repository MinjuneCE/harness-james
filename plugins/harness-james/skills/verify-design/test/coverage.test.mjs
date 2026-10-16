import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { CRITERION_EXTRACTORS } from "../scripts/lib/candidates.mjs";
import { parseRubricDir } from "../scripts/lib/rubric.mjs";
import { HAS_RUBRIC, RUBRIC_DIR, SKILL } from "./helpers.mjs";

test("rubric에서 S를 쓰는 기준을 추출기가 모두 덮는다", { skip: !HAS_RUBRIC && "rubric 폴더 없음" }, () => {
  const { criteria, rubricVersion } = parseRubricDir(RUBRIC_DIR);
  assert.equal(criteria.length, 59);
  assert.ok(rubricVersion);
  const sCrit = criteria.filter((c) => c.uses_script).map((c) => c.id);
  const missing = sCrit.filter((id) => !CRITERION_EXTRACTORS[id]);
  assert.deepEqual(missing, []);
  const unknown = Object.keys(CRITERION_EXTRACTORS).filter((id) => !criteria.some((c) => c.id === id));
  assert.deepEqual(unknown, []);
  assert.equal(criteria.find((c) => c.id === "REQ-02").script_only, true);
  assert.equal(criteria.find((c) => c.id === "BND-06").excluded_from_verdict, true);
});

test("SCHEMA.md 기준 → 추출기 표가 코드 표와 같다", () => {
  const md = readFileSync(join(SKILL, "SCHEMA.md"), "utf8");
  const rows = [...md.matchAll(/^\| ([A-Z]{3}-\d{2})(?: \(보조\))? \|/gm)].map((m) => m[1]);
  assert.deepEqual([...new Set(rows)].sort(), Object.keys(CRITERION_EXTRACTORS).sort());
});

// 범용성: 스킬 코드·문서에 특정 프로젝트·도메인 이름이 없어야 한다(결정 1). 시험 fixture는 합성이다.
// 프로젝트 이름 목록은 플러그인에 넣지 않는다(목록 자체가 그 이름을 담기 때문). 각 사용처가 자기 목록을 밖에 두고
// DV_FORBIDDEN_TERMS_FILE=<파일>로 넘긴다. 파일은 한 줄에 정규식 하나(/패턴/플래그 또는 맨 패턴은 대소문자 무시), # 줄과 빈 줄은 건너뛴다.
// 목록이 없어도 늘 도는 범용 검사: 개인 홈 절대 경로, 예시 도메인이 아닌 메일 주소.
const BUILTIN = [/\/(?:Users|home)\/(?!u\b|user\b|me\b|example\b)[a-z][\w.-]*\//, /[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b|anthropic\.com\b)[A-Za-z0-9-]+\.[A-Za-z]{2,}/];
export function parseTermsFile(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map((l) => {
    const m = l.match(/^\/(.+)\/([a-z]*)$/);
    return m ? new RegExp(m[1], m[2]) : new RegExp(l, "i");
  });
}
const TERMS_FILE = process.env.DV_FORBIDDEN_TERMS_FILE;
const FORBIDDEN = [...BUILTIN, ...(TERMS_FILE ? parseTermsFile(readFileSync(TERMS_FILE, "utf8")) : [])];
function walk(d) {
  return readdirSync(d).flatMap((n) => {
    if (n === ".tmp" || n === "runs" || n === "node_modules") return [];
    const p = join(d, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
test("금지어 목록 파일: /패턴/플래그와 맨 패턴, 주석·빈 줄", () => {
  const re = parseTermsFile("# 주석\n\n/\\bACME\\b/\nwidget-?co\n");
  assert.equal(re.length, 2);
  assert.ok(re[0].test("ACME 주문") && !re[0].test("acme"));
  assert.ok(re[1].test("Widget-Co") && re[1].test("widgetco"));
});
test(`스킬 파일에 프로젝트·도메인 이름이 없다${TERMS_FILE ? "" : " (DV_FORBIDDEN_TERMS_FILE 없음: 범용 검사만)"}`, () => {
  const hits = [];
  for (const p of walk(SKILL)) {
    if (p.endsWith("coverage.test.mjs")) continue;
    const text = readFileSync(p, "utf8");
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${relative(SKILL, p)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});
