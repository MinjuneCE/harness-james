#!/usr/bin/env node
// decision-check: 기능 폴더의 결정 기록(decisions.md)과 spec·plan 등 문서의 "반영한 결정" 머리 줄을 맞춰 본다.
//   node bin/decision-check.mjs <기능 폴더> [--ledger <파일>] [--current | --sync-table] [--verbose]
//   종료 코드: 0 FAIL 없음(WARN은 있을 수 있음), 1 FAIL 있음, 2 인자 오류·기록 파일 없음·쓰기 거절
//   --sync-table은 프로젝트 폴더(CLAUDE_PROJECT_DIR, 없으면 현재 폴더) 안의 기록만 고친다(DECISION_CHECK_EXTRA_WRITE_ROOT는 시험용).
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { parseLedger } from "../lib/parse.mjs";
import { evaluate, summarize, syncTable } from "../lib/check.mjs";

const USAGE = "사용: decision-check.mjs <기능 폴더> [--ledger <파일>] [--current | --sync-table] [--verbose]";
const FLAGS = new Set(["--current", "--sync-table", "--verbose"]);
const PROJECT_ROOT = resolve(process.env.CLAUDE_PROJECT_DIR || process.cwd());

function writable(path) {
  const real = realpathSync(path);
  const roots = [PROJECT_ROOT, process.env.DECISION_CHECK_EXTRA_WRITE_ROOT].filter((r) => r && existsSync(r)).map((r) => realpathSync(r));
  return roots.some((root) => real.startsWith(root + sep));
}

function fail(message) {
  console.error(`decision-check: ${message}`);
  process.exit(2);
}

const args = process.argv.slice(2);
const flags = new Set();
let dir = null;
let ledgerArg = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ledger") ledgerArg = args[++i] || fail(USAGE);
  else if (FLAGS.has(a)) flags.add(a);
  else if (a.startsWith("--")) fail(`모르는 인자 ${a}. ${USAGE}`);
  else if (dir === null) dir = a;
  else fail(USAGE);
}
if (!dir) fail(USAGE);
if (flags.has("--current") && flags.has("--sync-table")) fail("--current와 --sync-table은 함께 쓰지 않는다");

const root = resolve(dir);
if (!existsSync(root) || !statSync(root).isDirectory()) fail(`폴더가 아니다: ${root}`);
const ledgerPath = ledgerArg ? (isAbsolute(ledgerArg) ? ledgerArg : resolve(ledgerArg)) : join(root, "decisions.md");
if (!existsSync(ledgerPath)) fail(`결정 기록이 없다: ${ledgerPath}`);

const started = Date.now();
const ledgerText = readFileSync(ledgerPath, "utf8");
const ledger = parseLedger(ledgerText);

if (flags.has("--current")) {
  const s = summarize(ledger);
  if (s.prior) console.log(`이전 기록 D${s.prior.from}~D${s.prior.to}는 이 목록에 없다(기록 파일의 '이전 기록' 줄 참조)`);
  for (const d of s.valid) console.log(`D${d.n}  ${d.text}${d.reflects.length ? `  [${d.reflects.join(", ")}]` : ""}`);
  console.log(`유효한 결정 ${s.valid.length}건 · 최신 D${s.latest} · 다음 번호 D${s.latest + 1}`);
  process.exit(0);
}

if (flags.has("--sync-table")) {
  if (!writable(ledgerPath)) fail(`프로젝트 폴더(${PROJECT_ROOT}) 밖의 기록은 고치지 않는다: ${ledgerPath}`);
  const duplicates = summarize(ledger).duplicates;
  if (duplicates.length) fail(`같은 번호가 두 번 나와 표를 만들지 않는다: ${duplicates.map((d) => `D${d.n}(${d.line}줄)`).join(", ")}`);
  const next = syncTable(ledgerText, ledger);
  if (next === null) fail("'지금 유효한 결정' 절이 없다. `## 지금 유효한 결정` 제목을 먼저 넣는다");
  if (next === ledgerText) {
    console.log("표는 이미 기록과 같다");
  } else {
    writeFileSync(ledgerPath, next);
    console.log(`표를 다시 만들었다: ${ledgerPath}`);
  }
  process.exit(0);
}

const ledgerName = basename(ledgerPath);
const names = readdirSync(root).filter((f) => f.endsWith(".md") && f !== ledgerName).sort();
const reflected = [...new Set(ledger.decisions.flatMap((d) => d.reflects))];
const existing = new Set(names);
for (const file of reflected) {
  if (existsSync(join(root, file))) {
    existing.add(file);
    if (file.endsWith(".md") && !names.includes(file)) names.push(file);
  }
}
const docs = names.map((name) => ({ name, text: readFileSync(join(root, name), "utf8") }));
const { items } = evaluate(ledger, docs, { existing });

const shown = flags.has("--verbose") ? items : items.filter((it) => it.level !== "PASS" || it.id === "ledger" || it.id === "header");
for (const it of shown) {
  console.log(`${it.level.padEnd(4)}  ${it.id.padEnd(13)}  ${it.target ? `${it.target}  ` : ""}${it.summary}`);
  if (it.level !== "PASS") for (const line of it.details) console.log(`        ${line}`);
}
const count = (level) => items.filter((it) => it.level === level).length;
console.log(`결과: FAIL ${count("FAIL")} · WARN ${count("WARN")} · INFO ${count("INFO")} · ${((Date.now() - started) / 1000).toFixed(2)}s`);
process.exit(count("FAIL") ? 1 : 0);
