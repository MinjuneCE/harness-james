#!/usr/bin/env node
// spec-kit: spec-kit 형식 스펙 폴더를 프로젝트에 놓는다.
//   node bin/spec-kit.mjs init <스펙 루트>
//   node bin/spec-kit.mjs feature <스펙 루트> <짧은 이름> [--no-decisions]
//   종료 코드: 0 완료, 2 인자 오류·쓰기 거절
//   프로젝트 폴더(CLAUDE_PROJECT_DIR, 없으면 현재 폴더) 안에만 쓰고, 있는 파일은 덮어쓰지 않는다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLED = join(SKILL_DIR, "templates");
const LEDGER_TEMPLATE = join(SKILL_DIR, "..", "decision-log", "templates", "decisions.md");
const TEMPLATE_FILES = ["spec-template.md", "plan-template.md", "tasks-template.md", "checklist-template.md", "constitution-template.md", "LICENSE", "SOURCE.txt"];
const HEADER = "**반영한 결정**: 없음 ([decisions.md](decisions.md))";
const USAGE = "사용: spec-kit.mjs init <스펙 루트> | feature <스펙 루트> <짧은 이름> [--no-decisions]";
const NAME = /^[\p{Ll}\p{Lo}\p{N}][\p{Ll}\p{Lo}\p{N}-]*$/u;

function fail(message) {
  console.error(`spec-kit: ${message}`);
  process.exit(2);
}

function nearestExisting(path) {
  let p = path;
  while (!existsSync(p)) p = dirname(p);
  return realpathSync(p);
}

function insideProject(path) {
  const roots = [process.env.CLAUDE_PROJECT_DIR || process.cwd(), process.env.SPEC_KIT_EXTRA_WRITE_ROOT].filter((r) => r && existsSync(r)).map((r) => realpathSync(r));
  const real = nearestExisting(path);
  return roots.some((root) => real === root || real.startsWith(root + sep));
}

const report = [];
function place(target, content) {
  if (existsSync(target)) {
    report.push(`그대로 둠  ${target} (이미 있음)`);
    return false;
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  report.push(`만듦      ${target}`);
  return true;
}

function templateSource(root, file) {
  const local = join(root, ".specify", "templates", file);
  return existsSync(local) ? local : join(BUNDLED, file);
}

function withHeader(text) {
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("# "));
  lines.splice(at + 1, 0, "", HEADER);
  return lines.join("\n");
}

function ledgerFor(title) {
  return readFileSync(LEDGER_TEMPLATE, "utf8")
    .replace("[FEATURE NAME]", title)
    .replace(/<!-- 앞선 기록이 다른 파일에 있을 때만[^\n]*-->\n이전 기록:[^\n]*\n\n/, "");
}

function init(root) {
  for (const file of TEMPLATE_FILES) place(join(root, ".specify", "templates", file), readFileSync(join(BUNDLED, file)));
  place(join(root, ".specify", "memory", "constitution.md"), readFileSync(join(BUNDLED, "constitution-template.md")));
  mkdirSync(join(root, "specs"), { recursive: true });
}

function nextNumber(specs) {
  const used = existsSync(specs) ? readdirSync(specs).map((d) => /^(\d{3,})-/.exec(d)).filter(Boolean).map((m) => Number(m[1])) : [];
  return String(Math.max(0, ...used) + 1).padStart(3, "0");
}

function feature(root, name, decisions) {
  if (!NAME.test(name)) fail(`짧은 이름은 소문자·숫자·하이픈으로 쓴다: ${name}`);
  const specs = join(root, "specs");
  const id = `${nextNumber(specs)}-${name}`;
  const dir = join(specs, id);
  for (const [file, template] of [["spec.md", "spec-template.md"], ["plan.md", "plan-template.md"]]) {
    const text = readFileSync(templateSource(root, template), "utf8").replaceAll("[###-feature-name]", id);
    place(join(dir, file), decisions ? withHeader(text) : text);
  }
  if (decisions) place(join(dir, "decisions.md"), ledgerFor(id));
  return id;
}

const args = process.argv.slice(2);
const decisions = !args.includes("--no-decisions");
const positional = args.filter((a) => a !== "--no-decisions");
const unknown = positional.find((a) => a.startsWith("--"));
if (unknown) fail(`모르는 인자 ${unknown}. ${USAGE}`);
const [command, rootArg, name] = positional;
if (!rootArg || !["init", "feature"].includes(command)) fail(USAGE);
if (command === "init" && (positional.length !== 2 || !decisions)) fail(USAGE);
if (command === "feature" && positional.length !== 3) fail(USAGE);

const root = resolve(rootArg);
if (!insideProject(root)) fail(`프로젝트 폴더(${resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd())}) 밖에는 쓰지 않는다: ${root}`);

if (command === "init") {
  init(root);
} else {
  const id = feature(root, name, decisions);
  report.push(`기능 폴더 ${relative(process.cwd(), join(root, "specs", id)) || "."}`);
}
for (const line of report) console.log(line);
