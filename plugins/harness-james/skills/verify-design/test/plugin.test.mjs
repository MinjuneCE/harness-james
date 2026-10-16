// 플러그인 배치 시험: 판정 기준은 스킬 안 evaluation/, 프로젝트 데이터는 프로젝트, 작업 디렉터리 밖 파일은 작업 폴더로 복사
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUNDLED_RUBRIC_DIR, PROJECT_DATA_DIR, resolvePrevIndex, resolveProfilePath, runExtract } from "../scripts/extract.mjs";
import { AGENT_TYPES, cmdJudgePrompt, cmdTargets, cmdWorkflowArgs, cmdSaveJudge } from "../scripts/verdict.mjs";
import { AGENTS_DIR, FIXTURE, RUBRIC_DIR, SKILL, extractArgs, tmpDir } from "./helpers.mjs";

process.env.DV_AGENTS_DIR = AGENTS_DIR;

test("기본 rubric은 스킬에 든 evaluation/rubrics, 프로파일·보고서 기본은 프로젝트 docs/evaluation/design", () => {
  assert.equal(BUNDLED_RUBRIC_DIR, resolve(SKILL, "evaluation/rubrics"));
  assert.equal(PROJECT_DATA_DIR, "docs/evaluation/design");
  assert.equal(resolveProfilePath("/p", "sample"), "/p/docs/evaluation/design/profiles/sample.json");
  assert.throws(() => resolvePrevIndex("/p", "latest", null, "sample"), /\/p\/docs\/evaluation\/design\/reports\/sample/);
  for (const f of ["framework.md", "traits.md", "profile-schema.md"]) assert.ok(existsSync(join(SKILL, "evaluation", f)), f);
});

test("rubric이 프로젝트 밖이면 작업 폴더 evaluation/에 복사하고 그 경로를 쓴다", (t) => {
  const root = tmpDir(t);
  cpSync(FIXTURE, root, { recursive: true });
  const run = join(root, "docs/evaluation/design/reports/sample/runs/x");
  const { out } = runExtract({ ...extractArgs(root, run), rubricDir: undefined });
  assert.equal(out.rubric.source, BUNDLED_RUBRIC_DIR);
  assert.equal(out.rubric.dir, join(run, "evaluation/rubrics"));
  assert.equal(out.rubric.criteria, 59);
  for (const f of ["framework.md", "traits.md", "rubrics/CON.md"]) assert.ok(existsSync(join(run, "evaluation", f)), f);
  cmdSaveJudge(run, { criteria: [], findings: [] });
  cmdJudgePrompt(run);
  const p = readFileSync(join(run, "judge-prompt.md"), "utf8");
  assert.match(p, /판정 기준: framework `docs\/evaluation\/design\/reports\/sample\/runs\/x\/evaluation\/framework\.md`/);
  const a = cmdWorkflowArgs(run);
  assert.ok(a.framework_path.startsWith("docs/evaluation/design/") && a.rubric_dir.startsWith("docs/evaluation/design/"));
  assert.equal(readFileSync(join(run, "deep.mjs"), "utf8"), readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8"));
  assert.equal(cmdTargets(run).targets.length, 0);
});

test("rubric이 프로젝트 안이면 복사하지 않는다", (t) => {
  const root = tmpDir(t);
  cpSync(FIXTURE, root, { recursive: true });
  cpSync(resolve(RUBRIC_DIR, ".."), join(root, "criteria"), { recursive: true });
  const run = join(root, "run");
  const { out } = runExtract(extractArgs(root, run, { rubricDir: join(root, "criteria/rubrics") }));
  assert.equal(out.rubric.dir, join(root, "criteria/rubrics"));
  assert.ok(!existsSync(join(run, "evaluation")));
});

test("에이전트 유형은 플러그인 이름을 붙인 이름이고, 정의 파일·워크플로와 맞는다", () => {
  for (const [role, type] of Object.entries(AGENT_TYPES)) {
    const [plugin, name] = type.split(":");
    assert.equal(plugin, "harness-james", role);
    const md = readFileSync(join(AGENTS_DIR, `${name}.md`), "utf8");
    assert.match(md, new RegExp(`^name: ${name}$`, "m"));
    assert.ok(readFileSync(join(SKILL, "workflow/deep.mjs"), "utf8").includes(`'${type}'`));
    assert.ok(readFileSync(join(SKILL, "SKILL.md"), "utf8").includes(type));
  }
  const manifest = resolve(SKILL, "../../.claude-plugin/plugin.json");
  if (existsSync(manifest)) assert.equal(JSON.parse(readFileSync(manifest, "utf8")).name, "harness-james");
});
