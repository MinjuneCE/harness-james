import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(SKILL, "bin", "spec-kit.mjs");
const CHECK = join(SKILL, "..", "decision-log", "bin", "decision-check.mjs");
const project = () => realpathSync(mkdtempSync(join(tmpdir(), "spec-kit-")));
const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: { ...process.env, CLAUDE_PROJECT_DIR: "", SPEC_KIT_EXTRA_WRITE_ROOT: "" } });
const read = (...p) => readFileSync(join(...p), "utf8");
const TEMPLATES = ["spec-template.md", "plan-template.md", "tasks-template.md", "checklist-template.md", "constitution-template.md"];

test("담은 템플릿은 SOURCE.txt가 적은 파일 그대로이고 LICENSE가 함께 있다", () => {
  const source = read(SKILL, "templates", "SOURCE.txt");
  assert.match(source, /github\/spec-kit\/tree\/0443760542e7e5269724744a2ac55c4bd386d095\/templates/);
  for (const file of TEMPLATES) assert.match(source, new RegExp(file.replace(".", "\\.")));
  const license = read(SKILL, "templates", "LICENSE");
  assert.match(license, /^MIT License\n\nCopyright GitHub, Inc\./);
  assert.match(license, /The above copyright notice and this permission notice shall be included/);
  for (const file of TEMPLATES) assert.doesNotMatch(read(SKILL, "templates", file), /반영한 결정/);
});

test("init이 템플릿·LICENSE·constitution 자리를 놓고, 다시 불러도 고친 파일을 덮지 않는다", () => {
  const dir = project();
  const r = run(dir, "init", "docs/sdd/app");
  assert.equal(r.status, 0, r.stderr);
  for (const file of [...TEMPLATES, "LICENSE", "SOURCE.txt"]) assert.equal(read(dir, "docs/sdd/app/.specify/templates", file), read(SKILL, "templates", file));
  assert.equal(read(dir, "docs/sdd/app/.specify/memory/constitution.md"), read(SKILL, "templates", "constitution-template.md"));
  assert.ok(existsSync(join(dir, "docs/sdd/app/specs")));
  writeFileSync(join(dir, "docs/sdd/app/.specify/memory/constitution.md"), "# 우리 원칙\n");
  const again = run(dir, "init", "docs/sdd/app");
  assert.equal(again.status, 0);
  assert.match(again.stdout, /그대로 둠 .*constitution\.md/);
  assert.equal(read(dir, "docs/sdd/app/.specify/memory/constitution.md"), "# 우리 원칙\n");
});

test("feature가 다음 번호 폴더에 머리 줄 달린 spec·plan과 decisions.md를 만들고 검사기가 돈다", () => {
  const dir = project();
  run(dir, "init", ".");
  mkdirSync(join(dir, "specs", "004-old"), { recursive: true });
  const r = run(dir, "feature", ".", "billing-retry");
  assert.equal(r.status, 0, r.stderr);
  const f = join(dir, "specs", "005-billing-retry");
  const spec = read(f, "spec.md");
  assert.match(spec, /^# Feature Specification: \[FEATURE NAME\]\n\n\*\*반영한 결정\*\*: 없음 \(\[decisions\.md\]\(decisions\.md\)\)\n/);
  assert.match(spec, /`005-billing-retry`/);
  assert.match(read(f, "plan.md"), /^# Implementation Plan: \[FEATURE\]\n\n\*\*반영한 결정\*\*: 없음/);
  const ledger = read(f, "decisions.md");
  assert.match(ledger, /^# 결정 기록: 005-billing-retry\n/);
  assert.doesNotMatch(ledger, /이전 기록:/);
  const check = spawnSync(process.execPath, [CHECK, f], { encoding: "utf8", cwd: dir });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /PASS  header {9}plan\.md/);
  assert.match(check.stdout, /결과: FAIL 0 · WARN 0/);
  const sync = spawnSync(process.execPath, [CHECK, f, "--sync-table"], { encoding: "utf8", cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: "", DECISION_CHECK_EXTRA_WRITE_ROOT: "" } });
  assert.equal(sync.status, 0, sync.stderr);
});

test("feature는 스펙 루트에서 고친 템플릿을 쓰고, --no-decisions면 원본 그대로 둔다", () => {
  const dir = project();
  run(dir, "init", ".");
  writeFileSync(join(dir, ".specify/templates/spec-template.md"), "# 우리 스펙: [FEATURE NAME]\n\n`[###-feature-name]`\n");
  assert.equal(run(dir, "feature", ".", "a").status, 0);
  assert.match(read(dir, "specs/001-a/spec.md"), /^# 우리 스펙: \[FEATURE NAME\]\n\n\*\*반영한 결정\*\*/);
  assert.equal(run(dir, "feature", ".", "b", "--no-decisions").status, 0);
  assert.equal(read(dir, "specs/002-b/plan.md"), read(SKILL, "templates", "plan-template.md").replaceAll("[###-feature-name]", "002-b"));
  assert.ok(!existsSync(join(dir, "specs/002-b/decisions.md")));
});

test("프로젝트 폴더 밖과 잘못된 인자는 아무것도 쓰지 않고 2", () => {
  const dir = project();
  const outside = project();
  const r = run(dir, "init", outside);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /밖에는 쓰지 않는다/);
  assert.ok(!existsSync(join(outside, ".specify")));
  const viaEnv = spawnSync(process.execPath, [BIN, "init", outside], { encoding: "utf8", cwd: dir, env: { ...process.env, CLAUDE_PROJECT_DIR: outside } });
  assert.equal(viaEnv.status, 0, viaEnv.stderr);
  assert.equal(run(dir).status, 2);
  assert.equal(run(dir, "feature", ".").status, 2);
  assert.equal(run(dir, "feature", ".", "Bad Name").status, 2);
  assert.equal(run(dir, "init", ".", "--no-decisions").status, 2);
  assert.equal(run(dir, "init", ".", "--force").status, 2);
  assert.ok(!existsSync(join(dir, "specs")));
});
