// 이름 pr-verify(0.6.0, 옛 이름 verify)와 그 이름이 박힌 경로. 경로를 놓치면 판정 에이전트의 형식 점검
// (`node "${CLAUDE_PLUGIN_ROOT}/skills/pr-verify/scripts/score.mjs" … --check-judgment`)이 없는 파일을 부르게 된다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN = resolve(SKILL, "../..");
const read = (f) => readFileSync(f, "utf8");
const mdUnder = (d) => readdirSync(d, { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => join(d, f));
// `${VAR}/경로`에서 경로만 뽑는다. 자리표시(<…>)나 glob(*)이 든 것은 빼고, 끝 문장부호는 뗀다.
const refs = (text, v) => [...text.matchAll(new RegExp(`\\$\\{${v}\\}/([A-Za-z0-9_./-]+)`, "g"))].map((m) => m[1].replace(/[.,]+$/, "")).filter((p) => !/[<*]/.test(p));

test("스킬 이름은 폴더 이름과 같은 pr-verify이고, 설명에 옛 이름을 적는다", () => {
  const md = read(join(SKILL, "SKILL.md"));
  assert.equal(basename(SKILL), "pr-verify");
  assert.match(md, /^name: pr-verify$/m);
  assert.match(md, /^description: .*\/harness-james:pr-verify\(옛 이름 \/harness-james:verify\)/m);
});

test("verify 에이전트 정의의 ${CLAUDE_PLUGIN_ROOT} 경로가 플러그인 안에 있다 (판정 에이전트의 score.mjs 포함)", () => {
  const agents = readdirSync(join(PLUGIN, "agents")).filter((f) => /^verify-.*\.md$/.test(f));
  assert.ok(agents.length >= 4, agents.join(","));
  const seen = [];
  for (const a of agents) for (const p of refs(read(join(PLUGIN, "agents", a)), "CLAUDE_PLUGIN_ROOT")) {
    seen.push(p);
    assert.ok(existsSync(join(PLUGIN, p)), `${a}: \${CLAUDE_PLUGIN_ROOT}/${p} 없음`);
  }
  assert.ok(seen.includes("skills/pr-verify/scripts/score.mjs"), `판정 에이전트의 점수 점검 경로가 안 보임: ${seen.join(", ")}`);
});

test("스킬 문서의 ${CLAUDE_SKILL_DIR} 경로가 스킬 안에 있다", () => {
  const files = mdUnder(SKILL).filter((f) => !f.includes(`${join(SKILL, "test")}/`));
  let n = 0;
  for (const f of files) for (const p of refs(read(f), "CLAUDE_SKILL_DIR")) {
    n++;
    assert.ok(existsSync(join(SKILL, p)), `${f.slice(SKILL.length + 1)}: \${CLAUDE_SKILL_DIR}/${p} 없음`);
  }
  assert.ok(n >= 3, `확인한 경로 ${n}개`);
});

test("옛 이름으로 부르는 안내가 남아 있지 않다 (설명의 옛 이름 안내는 뺀다)", () => {
  const OLD = /\/harness-james:verify(?![\w-])|skills\/verify(?![\w-])|(?<![\w.:\\/-])\/verify(?![\w-])/;
  const files = [...mdUnder(join(PLUGIN, "agents")), ...mdUnder(SKILL), join(PLUGIN, "hooks/hooks.json"),
    ...readdirSync(join(PLUGIN, "hooks")).filter((f) => f.endsWith(".mjs")).map((f) => join(PLUGIN, "hooks", f)),
    ...readdirSync(join(SKILL, "scripts")).map((f) => join(SKILL, "scripts", f))];
  const hits = [];
  for (const f of files) read(f).split("\n").forEach((line, i) => {
    if (OLD.test(line.replace("(옛 이름 /harness-james:verify)", ""))) hits.push(`${f.slice(PLUGIN.length + 1)}:${i + 1}: ${line.trim().slice(0, 120)}`);
  });
  assert.deepEqual(hits, []);
});
