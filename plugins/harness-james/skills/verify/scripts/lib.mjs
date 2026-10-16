// /verify 공통 유틸: 경로·glob·git·diff 파싱·rubric 파싱·해시
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
export const CONFIDENCES = ["confirmed", "likely", "possible"];
export const ORIGINS = ["introduced", "worsened", "pre-existing", "fixed"];
export const SOURCES = ["judge", "rule", "tool"];
export const VERDICTS = ["upheld", "downgraded", "rejected", "uncertain"];
export const CRITERION_STATUSES = ["evaluated", "not-touched"];
export const DIMENSION_ORDER = ["SEC", "PERF", "ARCH", "REL", "OPS", "TEST", "A11Y"];

// critical=5 … info=1
export const sevRank = (s) => SEVERITIES.length - SEVERITIES.indexOf(s);
export const atLeast = (sev, min) => sevRank(sev) >= sevRank(min);

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// 데이터 위치.
// - 플러그인 기본값(읽기 전용): 이 스킬의 evaluation/ (framework.md, config/scoring.json, rubrics/)
// - 프로젝트 데이터: 워크스페이스의 평가 폴더(기본 docs/evaluation, VERIFY_EVAL_DIR로 바꿈): profiles/, reports/, calibration/
//   프로젝트 평가 폴더에 framework.md·config/scoring.json·rubrics/<차원>.md가 있으면 플러그인 기본값 대신 쓴다
// - 에이전트 정의: 플러그인의 agents/ (모델 정책 사전 점검용)
export const PLUGIN_EVAL_DIR = resolve(SCRIPT_DIR, "../evaluation");
export const AGENTS_DIR = resolve(SCRIPT_DIR, "../../../agents");
export const evalRel = () => (process.env.VERIFY_EVAL_DIR || "docs/evaluation").replace(/\/+$/, "");
export const evalDir = (ws) => resolve(ws, evalRel());
export function evalFile(ws, rel) {
  const own = join(evalDir(ws), rel);
  return existsSync(own) ? own : join(PLUGIN_EVAL_DIR, rel);
}
// context.json·리포트에 남기는 경로: 워크스페이스 안이면 상대 경로, 밖(플러그인 기본값)이면 절대 경로
export function shownPath(ws, p) {
  const rel = relative(ws, p);
  return rel.startsWith("..") || isAbsolute(rel) ? p : rel;
}

// 워크스페이스: 평가 폴더의 profiles/가 있는 가장 가까운 상위 디렉터리 (VERIFY_WORKSPACE가 있으면 그 값)
export function findWorkspace(start = process.cwd()) {
  const marker = join(evalRel(), "profiles");
  if (process.env.VERIFY_WORKSPACE) return resolve(process.env.VERIFY_WORKSPACE);
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) return dir;
    if (dirname(dir) === dir) break;
  }
  throw new Error(`workspace를 찾지 못함 (${marker}): 레포 프로파일을 둔 프로젝트 루트에서 실행하세요`);
}

export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export function writeJson(p, data) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}
export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const fileSha256 = (p) => sha256(readFileSync(p));

// ---------- glob ----------
const globCache = new Map();
export function globToRegExp(glob) {
  if (globCache.has(glob)) return globCache.get(glob);
  let re = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const atSegStart = i === 0 || glob[i - 1] === "/";
      if (atSegStart && glob[i + 2] === "/") { re += "(?:.*/)?"; i += 3; continue; }
      re += ".*"; i += 2; continue;
    }
    if (c === "*") { re += "[^/]*"; i += 1; continue; }
    if (c === "?") { re += "[^/]"; i += 1; continue; }
    re += "\\^$+.()|{}[]".includes(c) ? "\\" + c : c;
    i += 1;
  }
  const rx = new RegExp(`^${re}$`);
  globCache.set(glob, rx);
  return rx;
}
export const matchesAny = (path, globs = []) => globs.some((g) => globToRegExp(g).test(path));
export const matchPaths = (path, include = [], exclude = []) => matchesAny(path, include) && !matchesAny(path, exclude);
export function firstGlobValue(path, map = {}) {
  for (const [g, v] of Object.entries(map)) if (globToRegExp(g).test(path)) return v;
  return null;
}

// ---------- regex (supports leading (?i) / (?m) / (?s) inline flags) ----------
export function compileRegex(pattern, flags = "") {
  let p = pattern;
  let f = flags || "";
  const m = p.match(/^\(\?([ims]+)\)/);
  if (m) {
    p = p.slice(m[0].length);
    for (const ch of m[1]) if (!f.includes(ch)) f += ch;
  }
  return new RegExp(p, f);
}

// ---------- git ----------
export function git(repo, args, { quiet = false, encoding = "utf8" } = {}) {
  return execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], {
    encoding,
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ["ignore", "pipe", quiet ? "ignore" : "pipe"],
  });
}
export function gitTry(repo, args) {
  try {
    return git(repo, args, { quiet: true }).trim();
  } catch {
    return null;
  }
}
export const resolveCommit = (repo, ref) => gitTry(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);

export function extractTree(repo, sha, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync("sh", ["-c", 'git -C "$1" archive --format=tar "$2" | tar -x -C "$3"', "sh", repo, sha, dest], {
    stdio: ["ignore", "ignore", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

// ---------- unified diff ----------
function unquoteGitPath(s) {
  if (!s.startsWith('"')) return s;
  const body = s.slice(1, s.lastIndexOf('"'));
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") { bytes.push(...Buffer.from(ch, "utf8")); continue; }
    const n = body[i + 1];
    if (/[0-7]/.test(n)) { bytes.push(parseInt(body.slice(i + 1, i + 4), 8)); i += 3; continue; }
    const map = { n: 10, t: 9, r: 13, '"': 34, "\\": 92, a: 7, b: 8, f: 12, v: 11 };
    bytes.push(map[n] ?? n.charCodeAt(0));
    i += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}
const stripAB = (p) => (p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p);

function pathFromDiffHeader(rest) {
  // "a/P b/P" (경로가 같을 때만 안전하게 복원)
  if (rest.startsWith('"')) {
    const m = rest.match(/^"(?:[^"\\]|\\.)*" ("(?:[^"\\]|\\.)*")$/);
    return m ? stripAB(unquoteGitPath(m[1])) : null;
  }
  const len = (rest.length - 5) / 2;
  if (Number.isInteger(len) && rest.startsWith("a/") && rest.slice(2 + len, 5 + len) === " b/" && rest.slice(2, 2 + len) === rest.slice(5 + len)) {
    return rest.slice(2, 2 + len);
  }
  return null;
}

export function parseUnifiedDiff(patch) {
  const files = [];
  let cur = null;
  let hunk = null;
  let oldLn = 0;
  let newLn = 0;
  for (const l of patch.split("\n")) {
    if (l.startsWith("diff --git ")) {
      cur = { path: pathFromDiffHeader(l.slice(11)), old_path: null, status: "M", binary: false, hunks: [], added: [], removed: [] };
      cur.old_path = cur.path;
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    if (!hunk) {
      if (l.startsWith("new file mode")) { cur.status = "A"; continue; }
      if (l.startsWith("deleted file mode")) { cur.status = "D"; continue; }
      if (l.startsWith("rename from ")) { cur.old_path = unquoteGitPath(l.slice(12)); cur.status = "R"; continue; }
      if (l.startsWith("rename to ")) { cur.path = unquoteGitPath(l.slice(10)); continue; }
      if (l.startsWith("copy from ")) { cur.old_path = unquoteGitPath(l.slice(10)); cur.status = "C"; continue; }
      if (l.startsWith("copy to ")) { cur.path = unquoteGitPath(l.slice(8)); continue; }
      if (l.startsWith("Binary files ") || l.startsWith("GIT binary patch")) { cur.binary = true; continue; }
      if (l.startsWith("--- ")) {
        const p = unquoteGitPath(l.slice(4).replace(/\t$/, ""));
        if (p !== "/dev/null") cur.old_path = stripAB(p);
        continue;
      }
      if (l.startsWith("+++ ")) {
        const p = unquoteGitPath(l.slice(4).replace(/\t$/, ""));
        if (p !== "/dev/null") cur.path = stripAB(p);
        continue;
      }
    }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) {
      hunk = { old_start: +m[1], old_lines: m[2] === undefined ? 1 : +m[2], new_start: +m[3], new_lines: m[4] === undefined ? 1 : +m[4] };
      cur.hunks.push(hunk);
      oldLn = hunk.old_start;
      newLn = hunk.new_start;
      continue;
    }
    if (!hunk) continue;
    const t = l[0];
    const h = cur.hunks.length - 1;
    if (t === "+") { cur.added.push({ line: newLn++, text: l.slice(1), h }); }
    else if (t === "-") { cur.removed.push({ line: oldLn++, text: l.slice(1), h }); }
    else if (t === " ") { oldLn++; newLn++; }
  }
  for (const f of files) {
    if (f.status === "D") f.path = f.path ?? f.old_path;
    if (f.status === "A") f.old_path = null;
    f.path = f.path ?? f.old_path;
  }
  return files;
}

export function isNonBehavioral(text, commentPrefixes = [], ignoreRegexes = []) {
  const t = text.trim();
  if (t === "") return true;
  if (commentPrefixes.some((p) => t.startsWith(p))) return true;
  return ignoreRegexes.some((rx) => rx.test(text));
}

// ---------- rubric ----------
export function parseRubric(md, dim) {
  const sections = md.split(/\n(?=## )/);
  const table = sections.find((s) => /^## 기준 목록/.test(s)) ?? "";
  const criteria = [];
  for (const line of table.split("\n")) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 4 || !new RegExp(`^${dim}-\\d{2}$`).test(cells[1])) continue;
    const [, id, name, applies, weight, threshold] = cells;
    // 적용: 공통 | 서버 | 클라이언트. 레포는 프로파일 repo.traits(server·client)로 고른다
    const a = (applies || "").toLowerCase();
    const traits = a.includes("공통") || a.includes("common") ? ["common"] : [
      ...(a.includes("서버") || a.includes("server") ? ["server"] : []),
      ...(a.includes("클라이언트") || a.includes("client") ? ["client"] : []),
    ];
    criteria.push({
      id,
      dimension: dim,
      name: name.replace(/\*\*/g, ""),
      traits,
      weight: Number.parseFloat(weight) || null,
      review_threshold: Number.parseInt(threshold, 10) || null,
    });
  }
  let rules = [];
  const sig = sections.find((s) => /^## 자동 신호/.test(s));
  if (sig) {
    for (const block of sig.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
      try {
        const parsed = JSON.parse(block[1]);
        if (Array.isArray(parsed.rules)) rules = rules.concat(parsed.rules);
      } catch (e) {
        throw new Error(`${dim} rubric 자동 신호 JSON 파싱 실패: ${e.message}`);
      }
    }
  }
  const version = (md.match(/^- 버전:\s*([^\s(]+)/m) || [])[1] ?? null;
  return { criteria, rules, version };
}

// ---------- time ----------
export function kstStamp(d = new Date()) {
  const k = new Date(d.getTime() + 9 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return {
    date: `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())}`,
    compact: `${k.getUTCFullYear()}${p(k.getUTCMonth() + 1)}${p(k.getUTCDate())}-${p(k.getUTCHours())}${p(k.getUTCMinutes())}${p(k.getUTCSeconds())}`,
    human: `${k.getUTCFullYear()}-${p(k.getUTCMonth() + 1)}-${p(k.getUTCDate())} ${p(k.getUTCHours())}:${p(k.getUTCMinutes())} KST`,
  };
}

// --args-stdin: 사용자 인자 원문을 셸을 거치지 않고 토큰으로 나눈다.
// 셸식 따옴표('…', "…", \)로만 나누고 $, 백틱, 글롭은 확장하지 않는다. 따옴표 밖에서 시작한 ~, ~/ 만 홈으로 바꾼다.
export function tokenizeArgs(src) {
  const out = [];
  let cur = "";
  let started = false;
  let tilde = false;
  const push = () => {
    if (started) out.push(tilde && (cur === "~" || cur.startsWith("~/")) ? homedir() + cur.slice(1) : cur);
    cur = "";
    started = false;
    tilde = false;
  };
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (" \t\r\n".includes(c)) { push(); i++; continue; }
    if (!started) { started = true; tilde = c === "~"; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new Error("인자의 작은따옴표가 닫히지 않음");
      cur += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      let closed = false;
      for (i++; i < src.length; ) {
        const d = src[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === "\\" && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
          if (src[i + 1] !== "\n") cur += src[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) throw new Error("인자의 큰따옴표가 닫히지 않음");
      continue;
    }
    if (c === "\\") {
      if (i + 1 < src.length && src[i + 1] !== "\n") cur += src[i + 1];
      else if (cur === "") started = false;
      i += 2;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

// stdin 전체를 읽는다. 터미널이면 기다리지 않고 빈 문자열.
export function readStdinText() {
  if (process.stdin.isTTY) return "";
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

export function parseArgv(argv, { flags = [], options = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=", 2);
      if (flags.includes(k)) out[k] = true;
      else if (options.includes(k)) out[k] = v ?? argv[++i];
      else throw new Error(`알 수 없는 옵션: ${a}`);
    } else out._.push(a);
  }
  return out;
}

export function loadConfig(ws) {
  const scoringPath = evalFile(ws, "config/scoring.json");
  return { scoring: readJson(scoringPath), scoringPath };
}

export function loadProfiles(ws) {
  const dir = join(evalDir(ws), "profiles");
  // 프로파일 폴더의 *.json 전부. 레포를 추가할 때 코드 수정 없이 프로파일만 두면 된다
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => join(dir, f))
    .map((p) => ({ ...readJson(p), _path: p }));
}
