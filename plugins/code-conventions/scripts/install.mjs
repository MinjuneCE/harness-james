#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = ".installed-by-code-conventions.json";
const PLACEHOLDER = /\{\{CONVENTIONS_DIR\}\}/g;

export function parseArgs(argv, env = process.env) {
  const out = { mode: "install", force: false, configDir: env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "check" || a === "--check") out.mode = "check";
    else if (a === "uninstall" || a === "--uninstall") out.mode = "uninstall";
    else if (a === "install") out.mode = "install";
    else if (a === "--force") out.force = true;
    else if (a === "--config-dir") out.configDir = argv[++i];
    else throw new Error(`모르는 인자: ${a}`);
  }
  out.configDir = resolve(out.configDir.replace(/^~(?=$|\/)/, homedir()));
  return out;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");
const walk = (dir) => readdirSync(dir).flatMap((n) => {
  const p = join(dir, n);
  return statSync(p).isDirectory() ? walk(p) : [p];
});

export function plannedFiles(configDir, pluginRoot = PLUGIN_ROOT) {
  const convDir = join(configDir, "conventions");
  const docs = walk(join(pluginRoot, "conventions")).filter((p) => p.endsWith(".md")).map((src) => ({
    target: join(convDir, relative(join(pluginRoot, "conventions"), src)),
    content: readFileSync(src, "utf8").replace(PLACEHOLDER, convDir),
  }));
  const rules = walk(join(pluginRoot, "rules")).filter((p) => p.endsWith(".md")).map((src) => ({
    target: join(configDir, "rules", relative(join(pluginRoot, "rules"), src)),
    content: readFileSync(src, "utf8").replace(PLACEHOLDER, convDir),
  }));
  return [...docs, ...rules].map((f) => ({ ...f, hash: sha(f.content) }));
}

function readManifest(configDir) {
  const p = join(configDir, "conventions", MANIFEST);
  if (!existsSync(p)) return { version: null, files: {} };
  return JSON.parse(readFileSync(p, "utf8"));
}

function pluginVersion(pluginRoot) {
  return JSON.parse(readFileSync(join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8")).version;
}

export function classify(configDir, pluginRoot = PLUGIN_ROOT) {
  const manifest = readManifest(configDir);
  const planned = plannedFiles(configDir, pluginRoot);
  const plannedSet = new Set(planned.map((f) => f.target));
  const rows = planned.map((f) => {
    const rel = relative(configDir, f.target);
    if (!existsSync(f.target)) return { ...f, rel, state: "missing" };
    const now = sha(readFileSync(f.target, "utf8"));
    if (now === f.hash) return { ...f, rel, state: "same" };
    const recorded = manifest.files[rel];
    if (!recorded) return { ...f, rel, state: "foreign" };
    return { ...f, rel, state: now === recorded ? "outdated" : "edited" };
  });
  const stale = Object.entries(manifest.files)
    .filter(([rel]) => !plannedSet.has(join(configDir, rel)))
    .map(([rel, recorded]) => {
      const target = join(configDir, rel);
      if (!existsSync(target)) return null;
      const now = sha(readFileSync(target, "utf8"));
      return { target, rel, state: now === recorded ? "removed-upstream" : "removed-upstream-edited" };
    })
    .filter(Boolean);
  return { manifest, rows, stale };
}

const LABEL = {
  same: "같음",
  missing: "없음",
  outdated: "옛 버전",
  edited: "깐 뒤 고쳐짐",
  foreign: "이 스크립트가 깔지 않은 파일",
  "removed-upstream": "플러그인에서 빠짐",
  "removed-upstream-edited": "플러그인에서 빠짐, 깐 뒤 고쳐짐",
};

export function run(argv, { env = process.env, pluginRoot = PLUGIN_ROOT, log = console.log } = {}) {
  const opt = parseArgs(argv, env);
  const version = pluginVersion(pluginRoot);
  const { manifest, rows, stale } = classify(opt.configDir, pluginRoot);
  log(`설정 폴더: ${opt.configDir}`);
  log(`플러그인 버전 ${version}, 깔린 버전 ${manifest.version ?? "없음"}`);

  if (opt.mode === "check") {
    for (const r of [...rows, ...stale]) log(`  ${LABEL[r.state]}  ${r.rel}`);
    const ok = rows.every((r) => r.state === "same") && stale.length === 0;
    log(ok ? "결과: 플러그인과 같아요." : "결과: 다른 곳이 있어요.");
    return ok ? 0 : 1;
  }

  if (opt.mode === "uninstall") {
    const editable = ["edited", "removed-upstream-edited"];
    const kept = [];
    let removed = 0;
    for (const r of [...rows, ...stale]) {
      if (r.state === "missing") continue;
      if (r.state === "foreign" || (editable.includes(r.state) && !opt.force)) { kept.push(r); continue; }
      rmSync(r.target);
      removed++;
    }
    if (!kept.some((r) => editable.includes(r.state))) rmSync(join(opt.configDir, "conventions", MANIFEST), { force: true });
    for (const r of kept) log(`  남김(${LABEL[r.state]})  ${r.rel}`);
    log(`지운 파일 ${removed}개.`);
    return 0;
  }

  const conflicts = [...rows, ...stale].filter((r) => ["edited", "foreign", "removed-upstream-edited"].includes(r.state));
  if (conflicts.length && !opt.force) {
    for (const r of conflicts) log(`  멈춤(${LABEL[r.state]})  ${r.rel}`);
    log("덮어쓰지 않았어요. 위 파일을 덮어써도 되면 --force를 붙여 다시 실행해요.");
    return 2;
  }
  let written = 0;
  for (const r of rows) {
    if (r.state === "same") continue;
    mkdirSync(dirname(r.target), { recursive: true });
    writeFileSync(r.target, r.content);
    written++;
  }
  for (const r of stale) rmSync(r.target);
  const files = Object.fromEntries(rows.map((r) => [r.rel, r.hash]));
  mkdirSync(join(opt.configDir, "conventions"), { recursive: true });
  writeFileSync(join(opt.configDir, "conventions", MANIFEST), JSON.stringify({ version, files }, null, 2) + "\n");
  log(`쓴 파일 ${written}개, 지운 파일 ${stale.length}개. 요약은 다음 세션부터 읽혀요.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 2;
  }
}
