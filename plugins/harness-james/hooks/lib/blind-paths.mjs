// verify-guard의 블라인드 판정: 도구 호출이 가리키는 경로·글롭·재귀 범위가 차단 위치에 닿는지 본다.
// Read·Grep·Glob·Bash가 같은 규칙 하나를 쓴다.
// - 안쪽: 경로가 차단 위치이거나 그 안이면 막는다. 실효 cwd 기준으로 풀고 . .. // 를 접는다.
//   디스크에 있는 앞부분은 realpath로 심볼릭 링크를 푼다. 대소문자는 구분하지 않는다(macOS 기본 파일 시스템).
// - 글롭·중괄호: 패턴이 차단 위치나 그 안을 맞출 수 있으면 막는다. 세그먼트 단위, ** 는 깊이 무관, {a,b} 는 펼친다.
// - 재귀 범위: 재귀로 읽는 명령의 뿌리가 차단 위치의 상위면 막는다. 이름만 보이는 상위(ls docs/evaluation)는 허용.
// - 워크스페이스 git 기록: 차단 위치를 품은 레포에서 내용·이름을 출력하는 git 하위 명령은 피하는 pathspec이 있어야 한다.
// 디스크는 경로마다 realpath·.git 찾기 정도만 본다(순회 없음).
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { classify, scan } from "./shell-commands.mjs";

const UNKNOWN = Symbol("unknown-cwd");
const lc = (s) => s.toLowerCase();
const escGlob = (s) => s.replace(/[\\*?[\]{}()|]/g, "\\$&");

// ---------- 경로 ----------
// realpath를 세그먼트마다 풀어 간다(link/.. 가 물리 경로로 움직이는 것까지). 없는 세그먼트부터는 글자 그대로 붙인다
function physical(abs) {
  let cur = "/", missing = false;
  for (const s of abs.split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { cur = dirname(cur); continue; }
    const next = cur === "/" ? `/${s}` : `${cur}/${s}`;
    if (missing) { cur = next; continue; }
    try { cur = realpathSync.native(next); } catch { cur = next; missing = true; }
  }
  return cur;
}

// 패턴 문자열(백슬래시는 이스케이프) → 세그먼트 [{lit}|{glob, re, pre}|{any}]
function parseSeg(raw) {
  if (raw === "**") return { any: true };
  const alt = /(?<!\\)[(|)]/.exec(raw); // zsh (a|b)·extglob @(…): 그 세그먼트는 아무 이름
  if (alt) return { glob: true, re: /^/, pre: raw.slice(0, alt.index).replace(/\\(.)/g, "$1").replace(/[*?[].*$/, "") };
  let lit = "", re = "", pre = "", glob = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "\\") { const n = raw[++i] ?? ""; lit += n; re += n.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); if (!glob) pre += n; continue; }
    if (c === "*") { glob = true; re += "[^/]*"; continue; }
    if (c === "?") { glob = true; re += "[^/]"; continue; }
    if (c === "[") {
      const j = raw.indexOf("]", i + 2);
      if (j > 0) { glob = true; re += `[${raw.slice(i + 1, j).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`; i = j; continue; }
    }
    lit += c; re += c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"); if (!glob) pre += c;
  }
  if (!glob) return { lit };
  let rx;
  try { rx = new RegExp(`^${re}$`, "i"); } catch { rx = /^/; }
  return { glob: true, re: rx, pre };
}
function splitPattern(p) {
  const out = [];
  let cur = "";
  for (let i = 0; i < p.length; i++) {
    if (p[i] === "\\") { cur += p[i] + (p[i + 1] ?? ""); i++; continue; }
    if (p[i] === "/") { out.push(cur); cur = ""; continue; }
    cur += p[i];
  }
  out.push(cur);
  return out.filter((s) => s !== "" && s !== ".");
}
// . .. 를 글자 단위로 접는다. ** 뒤의 .. 는 ** 그대로(어디든 될 수 있음)
function normSegs(raws) {
  const out = [];
  for (const r of raws) {
    if (r === "..") { if (out.length && out[out.length - 1].any) continue; out.pop(); continue; }
    out.push(parseSeg(r));
  }
  return out;
}
// 절대 패턴 하나 → 비교할 세그먼트 변형들(글자 그대로, realpath를 푼 앞부분)
function variants(absPat) {
  const raws = splitPattern(absPat);
  const out = [normSegs(raws)];
  const k = raws.findIndex((r) => parseSeg(r).lit === undefined && r !== "..");
  const litPart = (k < 0 ? raws : raws.slice(0, k)).map((r) => parseSeg(r).lit ?? r);
  const real = physical(`/${litPart.join("/")}`);
  const realRaws = splitPattern(escGlob(real)).concat(k < 0 ? [] : raws.slice(k));
  const v = normSegs(realRaws);
  if (JSON.stringify(v.map(segKey)) !== JSON.stringify(out[0].map(segKey))) out.push(v);
  return out;
}
const segKey = (s) => (s.any ? "**" : s.lit !== undefined ? lc(s.lit) : `g:${s.re.source}`);

// ---------- 차단 위치 ----------
// { dir, kids: null | { prefix, except[] }, why }
//   kids null: dir 자신과 그 아래 전부
//   kids 있음: dir의 자식 중 이름이 prefix로 시작하고 except가 아닌 것과 그 아래. dir 자신은 상위(이름만)
export function makeEntry(dir, why, kids = null) {
  return { dir, why, kids: kids && { prefix: lc(kids.prefix ?? ""), except: (kids.except ?? []).map(lc) }, segs: splitPattern(escGlob(dir)).map((s) => lc(parseSeg(s).lit)) };
}
function withReal(entries) {
  const out = [...entries];
  for (const e of entries) {
    const r = physical(e.dir);
    if (lc(r) !== lc(e.dir)) out.push({ ...e, dir: r, segs: splitPattern(escGlob(r)).map((s) => lc(parseSeg(s).lit)) });
  }
  return out;
}

const segMatch = (s, name) => (s.lit !== undefined ? lc(s.lit) === name : s.re.test(name));
function kidBlocked(s, kids) {
  if (s.lit !== undefined) { const n = lc(s.lit); return n.startsWith(kids.prefix) && !kids.except.includes(n); }
  const p = lc(s.pre);
  return p.startsWith(kids.prefix) || kids.prefix.startsWith(p); // 글롭이 prefix로 시작하는 다른 이름을 맞출 수 있으면
}
// 패턴 P가 맞출 수 있는 경로 Q 중에 (inside) 차단 위치 안이 있는가, (ancestor) 차단 위치의 상위가 있는가
// dist: 상위일 때 차단 위치까지 남은 깊이(글자 그대로인 패턴만 의미 있음)
function relate(P, e) {
  const D = e.segs, out = { inside: false, ancestor: false, dist: Infinity };
  const seen = new Set();
  const go = (i, j) => {
    const key = `${i},${j}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (j === D.length) {
      if (!e.kids) { out.inside = true; return; }
      if (i === P.length) { out.ancestor = true; out.dist = Math.min(out.dist, 0); return; }
      if (P[i].any) { out.inside = true; return; }
      if (kidBlocked(P[i], e.kids)) out.inside = true;
      return;
    }
    if (i === P.length) { out.ancestor = true; out.dist = Math.min(out.dist, D.length - j); return; }
    if (P[i].any) { out.inside = true; return; } // ** 는 차단 위치까지 내려갈 수 있다
    if (segMatch(P[i], D[j])) go(i + 1, j + 1);
  };
  go(0, 0);
  return out;
}

// ---------- 셸 단어 풀기 ----------
const ANSI = { n: "\n", t: "\t", r: "\r", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "?": "?" };
// raw 단어 → { pat: 글롭 문자를 남긴 패턴(인용된 글자는 이스케이프), lit: 글자 값, glob } 또는 null(풀 수 없음)
// partial: 풀 수 없는 부분을 와일드카드로 바꿔 계속 읽는다(단어가 그 부분으로 시작하면 null). 세그먼트 전체면 **, 일부면 *
const HOLE = "\u0000";
export function expandWord(raw, lookup, home, partial = false) {
  let pat = "", lit = "", glob = false, i = 0;
  const s = raw;
  const hole = (end) => { if (!partial || (pat === "" && lit === "")) return false; pat += HOLE; lit += HOLE; glob = true; i = end; return true; };
  const closeParen = (k) => { // $( 의 짝 ) 위치 다음
    let d = 0;
    for (; k < s.length; k++) {
      const ch = s[k];
      if (ch === "\\") { k++; continue; }
      if (ch === "'") { const j = s.indexOf("'", k + 1); if (j < 0) return -1; k = j; continue; }
      if (ch === "(") d++;
      else if (ch === ")" && --d === 0) return k + 1;
    }
    return -1;
  };
  const skipUnknown = (k) => { // k = $ 또는 ` 위치. 풀 수 없는 확장 하나의 끝
    if (s[k] === "`") { let j = k + 1; while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1; return j < s.length ? j + 1 : -1; }
    if (s[k + 1] === "(") return closeParen(k + 1);
    if (s[k + 1] === "{") { const j = s.indexOf("}", k); return j < 0 ? -1 : j + 1; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(k + 1))?.[0];
    return name ? k + 1 + name.length : k + 2;
  };
  const unknownAt = (k) => { const e = skipUnknown(k); return e > 0 && hole(e); };
  const addLit = (t) => { lit += t; pat += escGlob(t); };
  const addVar = (name, quoted) => {
    const v = lookup(name);
    if (v === null || v === undefined) return false;
    if (typeof v === "object") { lit += `{${v.alts.join(",")}}`; pat += v.alts.length > 1 ? `{${v.alts.join(",")}}` : v.alts[0]; glob = true; return true; } // for 변수: 나열된 값 중 하나
    if (quoted) addLit(v); else { lit += v; pat += v; if (/[*?[{]/.test(v)) glob = true; }
    return true;
  };
  const readName = (k) => /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(k))?.[0] ?? "";
  if (s[0] === "~" && (s.length === 1 || s[1] === "/")) { const hm = lookup("HOME") ?? home; if (!hm) return null; addLit(hm); i = 1; }
  while (i < s.length) {
    const c = s[i], n = s[i + 1];
    if (c === "\\") { addLit(n ?? ""); i += 2; continue; }
    if (c === "'") { const j = s.indexOf("'", i + 1); if (j < 0) return null; addLit(s.slice(i + 1, j)); i = j + 1; continue; }
    if (c === "$" && n === "'") {
      let v = "";
      i += 2;
      for (;;) {
        if (i >= s.length) return null;
        const d = s[i];
        if (d === "'") { i++; break; }
        if (d !== "\\") { v += d; i++; continue; }
        const m = /^x([0-9a-fA-F]{1,2})|^u([0-9a-fA-F]{1,4})|^U([0-9a-fA-F]{1,8})|^([0-7]{1,3})/.exec(s.slice(i + 1, i + 10));
        if (m) { v += String.fromCodePoint(parseInt(m[1] ?? m[2] ?? m[3] ?? m[4], m[4] ? 8 : 16)); i += 1 + m[0].length; continue; }
        v += ANSI[s[i + 1]] ?? `\\${s[i + 1] ?? ""}`;
        i += 2;
      }
      addLit(v);
      continue;
    }
    if (c === '"' || (c === "$" && n === '"')) {
      i += c === "$" ? 2 : 1;
      for (;;) {
        if (i >= s.length) return null;
        const d = s[i], e = s[i + 1];
        if (d === '"') { i++; break; }
        if (d === "\\") { if (e !== undefined && "$`\"\\\n".includes(e)) { if (e !== "\n") addLit(e); i += 2; } else { addLit(d); i++; } continue; }
        if (d === "`") { if (unknownAt(i)) continue; return null; }
        if (d === "$") {
          if (e === "(") { if (unknownAt(i)) continue; return null; }
          if (e === "{") { const j = s.indexOf("}", i); const name = s.slice(i + 2, j); if (j < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !addVar(name, true)) { if (unknownAt(i)) continue; return null; } i = j + 1; continue; }
          const name = readName(i + 1);
          if (name) { if (!addVar(name, true)) { if (unknownAt(i)) continue; return null; } i += 1 + name.length; continue; }
          if (e && /[@*#?$!0-9-]/.test(e)) { if (unknownAt(i)) continue; return null; }
        }
        addLit(d); i++;
      }
      continue;
    }
    if (c === "`") { if (unknownAt(i)) continue; return null; }
    if (c === "$") {
      if (n === "(") { if (unknownAt(i)) continue; return null; }
      if (n === "{") { const j = s.indexOf("}", i); const name = s.slice(i + 2, j); if (j < 0 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || !addVar(name, false)) { if (unknownAt(i)) continue; return null; } i = j + 1; continue; }
      const name = readName(i + 1);
      if (name) { if (!addVar(name, false)) { if (unknownAt(i)) continue; return null; } i += 1 + name.length; continue; }
      if (n && /[@*#?$!0-9-]/.test(n)) { if (unknownAt(i)) continue; return null; }
    }
    if ("*?[".includes(c)) glob = true;
    lit += c; pat += c; i++;
  }
  if (pat.includes(HOLE) && !/^[\w.~@+:=,\/\u0000-]+$/.test(lit)) return null; // 경로처럼 생긴 단어만(코드·정규식 문자열은 건너뜀)
  if (pat.includes(HOLE)) pat = pat.split("/").map((seg) => (seg === HOLE ? "**" : seg.split(HOLE).join("*"))).join("/");
  return { pat, lit, glob };
}

// 따옴표 밖 중괄호 펼치기. {x..y} 범위는 아무 이름(*)으로 본다. 너무 많으면 * 로 대신한다
export function expandBraces(p, budget = { n: 64 }) {
  let depth = 0, start = -1;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\") { i++; continue; }
    if (c === "{") { if (depth++ === 0) start = i; continue; }
    if (c === "}" && depth > 0 && --depth === 0) {
      const body = p.slice(start + 1, i), parts = [];
      let d = 0, last = 0;
      for (let k = 0; k < body.length; k++) {
        if (body[k] === "\\") { k++; continue; }
        if (body[k] === "{") d++;
        else if (body[k] === "}") d--;
        else if (body[k] === "," && d === 0) { parts.push(body.slice(last, k)); last = k + 1; }
      }
      parts.push(body.slice(last));
      const pre = p.slice(0, start), post = p.slice(i + 1);
      if (parts.length === 1) {
        if (/^[^\\]+\.\.[^\\]+$/.test(body)) return expandBraces(`${pre}*${post}`, budget);
        continue; // {x}, {} 는 글자 그대로
      }
      const out = [];
      for (const part of parts) {
        if (--budget.n < 0) return [p.replace(/(?<!\\)[{},]/g, "*")];
        out.push(...expandBraces(pre + part + post, budget));
      }
      return out;
    }
  }
  return [p];
}

// ---------- 판정기 ----------
// opts: { root, home, cwd, entries: [makeEntry(...)], words: RegExp }
export function createBlind(opts) {
  const { root, home } = opts;
  const entries = withReal(opts.entries);
  const startCwd = resolve(opts.cwd || root);
  const words = opts.words;

  // 패턴 → 첫 차단 위치 관계
  const absPat = (pat, cwd) => (pat.startsWith("/") ? pat : `${escGlob(cwd)}/${pat}`);
  function check(pat, cwd, kind, depth = Infinity) {
    for (const P of variants(absPat(pat, cwd))) {
      const literal = P.every((s) => s.lit !== undefined);
      for (const e of entries) {
        const r = relate(P, e);
        if (r.inside) return e;
        if (kind !== "recursive" || !r.ancestor) continue;
        const need = (literal ? r.dist : 0) + (e.kids ? 2 : 1);
        if (depth >= need) return e;
      }
    }
    return null;
  }
  const show = (p) => (p.length > 120 ? `${p.slice(0, 117)}...` : p);

  // ---- 전용 도구 ----
  function readHit(p) {
    if (!p) return null;
    if (words.test(p)) return `읽기 차단: ${show(p)}`;
    const e = check(escGlob(p), startCwd, "inside");
    return e ? `읽기 차단(${e.why}): ${show(p)}` : null;
  }
  function grepToolHit(p, glob) {
    if (words.test(p ?? "") || words.test(glob ?? "")) return `검색 차단: ${show(p ?? glob)}`;
    const e = check(escGlob(p || "."), startCwd, "recursive");
    return e ? `검색 범위가 차단 위치(${e.why})를 품음: ${show(p || "(현재 디렉터리)")}` : null;
  }
  function globToolHit(pattern, p) {
    if (words.test(pattern ?? "") || words.test(p ?? "")) return `검색 차단: ${show(pattern ?? p)}`;
    const base = p ? (isAbsolute(p) ? p : resolve(startCwd, p)) : startCwd;
    const pat = pattern?.startsWith("/") ? pattern : `${escGlob(base)}/${pattern ?? "*"}`;
    for (const one of expandBraces(pat)) {
      const e = check(one, startCwd, "inside");
      if (e) return `Glob 패턴이 차단 위치(${e.why})를 맞출 수 있음: ${show(pattern ?? "")}${p ? ` (path ${show(p)})` : ""}`;
    }
    return null;
  }

  // ---- git 레포 ----
  function pointer(file, base) { try { const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(file, "utf8")); return m ? resolve(base, m[1].trim()) : file; } catch { return file; } }
  function commonDir(g) {
    let c = g;
    try { c = resolve(g, readFileSync(join(g, "commondir"), "utf8").trim()); } catch {}
    try { return lc(realpathSync.native(c)); } catch { return lc(c); }
  }
  // 차단 위치를 품은 레포(워크스페이스): 디스크에 있는 차단 위치에서 위로 찾은 git 디렉터리 → 그 레포의 최상위
  let blockedRepos = null;
  const isBlockedRepo = (gd) => {
    if (blockedRepos === null) {
      blockedRepos = new Map();
      for (const e of opts.entries) {
        let d = e.dir;
        while (!existsSync(d) && dirname(d) !== d) d = dirname(d);
        const r = findRepo(physical(d));
        if (r && !blockedRepos.has(r.gd)) blockedRepos.set(r.gd, r.top);
      }
    }
    return blockedRepos.has(gd);
  };

  // ---- Bash ----
  // 상태: cwd 후보 목록(UNKNOWN = 값을 모르는 cd 뒤), 같은 명령 안의 리터럴 변수
  const known = (st) => (st.cwd.length === 1 && st.cwd[0] !== UNKNOWN ? st.cwd[0] : null);
  const lookupIn = (st) => (name) => {
    if (st.env.has(name)) return st.env.get(name);
    if (name === "HOME") return home || null;
    if (name === "PWD") return known(st);
    if (name === "CLAUDE_PROJECT_DIR") return root;
    return null;
  };
  const clone = (st) => ({ cwd: [...st.cwd], env: new Map(st.env), pending: null });
  const union = (a, b) => [...new Set([...a, ...b])];

  // 단어 하나 → 검사할 패턴 문자열들. xargs·find -exec 자리표시({})가 다른 글자와 붙어 있으면 ** 로 본다
  function wordPats(ex, repl) {
    if (!ex) return null;
    let p = ex.pat;
    if (repl && p !== escGlob(repl) && p.includes(escGlob(repl))) p = p.split(escGlob(repl)).join("**");
    if (p !== "{}" && p !== "\\{\\}" && !p.startsWith("-")) p = p.split("\\{\\}").join("**").split("{}").join("**");
    return expandBraces(p);
  }
  // 경로로 쓰였을 수 있는 부분: 단어 전체, = 뒤, : 뒤(rev:path, host:path), 붙은 짧은 옵션 값(-fFILE)
  function pieces(pat) {
    const out = [pat];
    const eq = pat.indexOf("=");
    if (eq > 0) out.push(pat.slice(eq + 1));
    for (let k = pat.indexOf(":"); k >= 0; k = pat.indexOf(":", k + 1)) out.push(pat.slice(k + 1));
    if (/^-[^-]/.test(pat) && pat.length > 2) out.push(pat.slice(2));
    return out.filter((p) => p && !p.startsWith("-"));
  }
  function insideHit(pats, st, label, strictUnknown = false) {
    for (const p of pats ?? []) for (const piece of pieces(p)) {
      for (const cwd of st.cwd) {
        if (cwd === UNKNOWN && !piece.startsWith("/")) { // 값을 모르는 cd 뒤 상대 경로: 어디를 가리키는지 알 수 없다
          if (strictUnknown) return `값을 모르는 cd 뒤라 상대 경로를 확인할 수 없음(cd에 리터럴 경로를 써라): ${show(label)}`;
          continue;
        }
        const e = check(piece, cwd === UNKNOWN ? "/" : cwd, "inside");
        if (e) return `읽기 차단(${e.why}): ${show(label)}`;
      }
    }
    return null;
  }
  // 재귀 범위 뿌리: pats null = 풀 수 없는 동적 단어
  function scopeHit(pats, st, label, depth = Infinity) {
    if (pats === null) return `재귀 범위 자리에 값을 알 수 없는 단어가 있음: ${show(label)}`;
    for (const p of pats) for (const cwd of st.cwd) {
      if (cwd === UNKNOWN && !p.startsWith("/")) return `값을 모르는 cd 뒤라 상대 경로 재귀 범위를 확인할 수 없음: ${show(label)}`;
      const e = check(p, cwd === UNKNOWN ? "/" : cwd, "recursive", depth);
      if (e) return `재귀 범위가 차단 위치(${e.why})를 품음: ${show(label)}`;
    }
    return null;
  }

  // 옵션 읽기: sv = 값을 받는 짧은 옵션 글자, lv = 값을 받는 긴 옵션. 결과: 위치 인자 색인, 본 옵션, 옵션 값
  function readOpts(vals, from, sv = "", lv = new Set()) {
    const pos = [], flags = new Set(), values = new Map();
    let k = from;
    for (; k < vals.length; k++) {
      const v = vals[k];
      if (v === "--") { for (let m = k + 1; m < vals.length; m++) pos.push(m); break; }
      if (v.startsWith("--")) {
        const eq = v.indexOf("="), name = eq > 0 ? v.slice(0, eq) : v;
        flags.add(name);
        if (eq > 0) values.set(name, v.slice(eq + 1));
        else if (lv.has(name)) { values.set(name, vals[k + 1]); k++; }
        continue;
      }
      if (v.startsWith("-") && v.length > 1 && !/^-\d+$/.test(v)) {
        for (let c = 1; c < v.length; c++) {
          const ch = v[c];
          flags.add(ch);
          if (sv.includes(ch)) {
            if (c + 1 < v.length) values.set(ch, v.slice(c + 1)); else { values.set(ch, vals[k + 1]); k++; }
            break;
          }
        }
        continue;
      }
      pos.push(k);
    }
    return { pos, flags, values };
  }
  const num = (v) => (v !== undefined && /^\d+$/.test(v) ? Number(v) : undefined);

  const GREP_LV = new Set(["--regexp", "--file", "--max-count", "--after-context", "--before-context", "--context", "--devices", "--directories", "--label", "--include", "--exclude", "--exclude-from", "--exclude-dir", "--binary-files", "--group-separator"]);
  const RG_LV = new Set(["--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--type-clear", "--threads", "--max-count", "--max-columns", "--max-depth", "--maxdepth", "--max-filesize", "--after-context", "--before-context", "--context", "--context-separator", "--field-context-separator", "--field-match-separator", "--encoding", "--replace", "--pre", "--pre-glob", "--sort", "--sortr", "--ignore-file", "--path-separator", "--colors", "--dfa-size-limit", "--regex-size-limit", "--engine", "--hostname-bin", "--hyperlink-format", "--generate"]);
  // 재귀로 읽는 명령 → { roots: [색인 | "."], depth, pick?: 색인→경로 패턴 }
  function recursiveRoots(name, vals, h) {
    const n = name.replace(/^g(?=(grep|find|ls|du|cp|tar|diff)$)/, "");
    if (["grep", "egrep", "fgrep", "rgrep", "zgrep", "ugrep", "ug"].includes(n)) {
      const o = readOpts(vals, h + 1, "ABCDdefmNJKMt", GREP_LV);
      const d = o.values.get("d") ?? o.values.get("--directories");
      const rec = n === "rgrep" || n === "ugrep" || n === "ug" || o.flags.has("r") || o.flags.has("R") || o.flags.has("--recursive") || o.flags.has("--dereference-recursive") || d === "recurse";
      if (!rec) return null;
      const given = o.flags.has("e") || o.flags.has("f") || o.flags.has("--regexp") || o.flags.has("--file");
      const roots = (given ? o.pos : o.pos.slice(1)).filter((k) => vals[k] !== "-");
      return { roots: roots.length ? roots : ["."] };
    }
    if (["rg", "rga"].includes(n)) {
      const o = readOpts(vals, h + 1, "ABCEMTdefgjmrt", RG_LV);
      if (o.flags.has("--type-list")) return null;
      const noPat = o.flags.has("--files") || o.flags.has("e") || o.flags.has("f") || o.flags.has("--regexp") || o.flags.has("--file");
      const roots = noPat ? o.pos : o.pos.slice(1);
      return { roots: roots.length ? roots : ["."], depth: num(o.values.get("d") ?? o.values.get("--max-depth") ?? o.values.get("--maxdepth")) };
    }
    if (["ag", "ack", "ack-grep", "pt", "sift"].includes(n)) {
      const o = readOpts(vals, h + 1, "ABCGgmp", new Set(["--depth", "--type", "--ignore-dir", "--ignore", "--match", "--file-search-regex", "--max-count", "--pager"]));
      const noPat = o.flags.has("g") || o.flags.has("G") || o.flags.has("f") || o.flags.has("--match");
      const roots = noPat ? o.pos : o.pos.slice(1);
      return { roots: roots.length ? roots : ["."], depth: num(o.values.get("--depth")) };
    }
    if (["fd", "fdfind"].includes(n)) {
      const o = readOpts(vals, h + 1, "deEtcjoxXS", new Set(["--max-depth", "--extension", "--exclude", "--type", "--color", "--threads", "--owner", "--exec", "--exec-batch", "--size", "--search-path", "--base-directory", "--changed-within", "--changed-before", "--ignore-file", "--max-results", "--min-depth", "--exact-depth"]));
      const roots = o.pos.slice(1);
      const sp = [...vals.keys()].filter((k) => vals[k - 1] === "--search-path");
      return { roots: roots.length || sp.length ? [...roots, ...sp] : ["."], depth: num(o.values.get("d") ?? o.values.get("--max-depth")) };
    }
    if (["find", "bfs"].includes(n)) {
      const roots = [];
      let k = h + 1;
      for (; k < vals.length; k++) {
        const v = vals[k];
        if (["-H", "-L", "-P", "-E", "-X", "-s", "-x", "-d", "-O0", "-O1", "-O2", "-O3"].includes(v)) continue;
        if (v === "-f") { roots.push(k + 1); k++; continue; }
        if (v.startsWith("-") || v === "(" || v === "!" || v === "\\(") break;
        roots.push(k);
      }
      let depth;
      for (let m = k; m < vals.length; m++) if (vals[m] === "-maxdepth") depth = num(vals[m + 1]);
      return { roots: roots.length ? roots : ["."], depth };
    }
    if (n === "ls" || n === "eza" || n === "exa" || n === "lsd") {
      const o = readOpts(vals, h + 1, "ITw", new Set(["--ignore", "--hide", "--tabsize", "--width", "--block-size", "--format", "--sort", "--time", "--time-style", "--color", "--quoting-style", "--indicator-style", "--level"]));
      if (!(o.flags.has("R") || o.flags.has("--recursive") || (n !== "ls" && (o.flags.has("T") || o.flags.has("--tree"))))) return null;
      return { roots: o.pos.length ? o.pos : ["."], depth: num(o.values.get("--level")) };
    }
    if (n === "tree") {
      const o = readOpts(vals, h + 1, "LPIo", new Set(["--filelimit", "--timefmt", "--sort", "--charset", "--matchdirs"]));
      return { roots: o.pos.length ? o.pos : ["."], depth: num(o.values.get("L")) };
    }
    if (n === "du" || n === "dust" || n === "ncdu") {
      const o = readOpts(vals, h + 1, "dBt", new Set(["--max-depth", "--block-size", "--threshold", "--exclude", "--time-style"]));
      const depth = o.flags.has("s") || o.flags.has("--summarize") ? 0 : num(o.values.get("d") ?? o.values.get("--max-depth"));
      return { roots: o.pos.length ? o.pos : ["."], depth };
    }
    if (["cp", "ditto"].includes(n)) {
      const o = readOpts(vals, h + 1, "tS", new Set(["--target-directory", "--suffix", "--backup", "--preserve", "--sparse", "--reflink"]));
      if (n === "cp" && !["r", "R", "a", "--recursive", "--archive"].some((f) => o.flags.has(f))) return null;
      const tgt = o.flags.has("t") || o.flags.has("--target-directory");
      return { roots: tgt ? o.pos : o.pos.slice(0, -1) };
    }
    if (["diff", "colordiff"].includes(n)) {
      const o = readOpts(vals, h + 1, "CUFDLSxXI", new Set(["--exclude", "--exclude-from", "--label", "--starting-file", "--ignore-matching-lines", "--context", "--unified", "--width", "--from-file", "--to-file", "--color"]));
      if (!(o.flags.has("r") || o.flags.has("--recursive"))) return null;
      return { roots: o.pos };
    }
    if (["tar", "bsdtar", "zip", "7z", "7za", "7zz", "pax", "cpio"].includes(n)) {
      if (n === "zip") { const o = readOpts(vals, h + 1, "bxinPtT", new Set()); return o.flags.has("r") || o.flags.has("R") ? { roots: o.pos.slice(1) } : null; }
      if (n.startsWith("7z")) { const o = readOpts(vals, h + 1); return vals[o.pos[0]] === "a" ? { roots: o.pos.slice(2) } : null; }
      if (n === "pax" || n === "cpio") return { roots: [] };
      // tar: 첫 인자가 대시 없는 묶음(cf x.tar dir)일 수 있다. -f 값(아카이브)은 뿌리가 아니다
      let k = h + 1, skip = new Set();
      if (vals[k] && /^[A-Za-z]+$/.test(vals[k]) && !vals[k].startsWith("-")) { if (vals[k].includes("f")) skip.add(k + 1); if (vals[k].includes("C")) skip.add(k + 1 + (vals[k].includes("f") ? 1 : 0)); k++; }
      const o = readOpts(vals, k, "fCbTXIs", new Set(["--file", "--directory", "--exclude", "--files-from", "--exclude-from", "--use-compress-program", "--transform", "--format", "--strip-components"]));
      return { roots: o.pos.filter((m) => !skip.has(m)) };
    }
    if (n === "ctags" || n === "etags") {
      const o = readOpts(vals, h + 1, "fo", new Set());
      return o.flags.has("R") || o.flags.has("--recurse") ? { roots: o.pos.length ? o.pos : ["."] } : null;
    }
    return null;
  }

  // ---- git: 차단 위치를 품은 레포에서 내용·이름을 내는 하위 명령 ----
  const GIT_GLOBAL_VAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--exec-path", "--attr-source"]);
  const LOG_SHOWS = /^(-p|-u|--patch|-U\d*|--unified(=.*)?|-c|--cc|--dd|-m|--word-diff.*|--color-words.*|-L.*|--stat.*|--numstat|--shortstat|--name-only|--name-status|--raw|--summary|--dirstat.*|-W|--function-context|--patch-with-stat|--patch-with-raw|-[a-zA-Z]*p)$/;
  const SUB_VAL = {
    grep: new Set(["-e", "-f", "-m", "--max-count", "-A", "-B", "-C", "--context", "--after-context", "--before-context", "--max-depth", "--threads", "--and", "--or", "--not"]),
    log: new Set(["-n", "--max-count", "--author", "--committer", "--grep", "--since", "--until", "--after", "--before", "--format", "--pretty", "--date", "-S", "-G", "--skip", "--encoding", "--min-parents", "--max-parents", "--decorate-refs", "--decorate-refs-exclude", "--exclude", "--glob", "--branches", "--tags", "--remotes", "-L"]),
    diff: new Set(["-S", "-G", "-O", "--diff-filter", "--relative", "--word-diff-regex", "--anchored"]),
    blame: new Set(["-L", "-S", "--contents", "--ignore-rev", "--ignore-revs-file", "-C", "-M"]),
  };
  SUB_VAL.show = SUB_VAL.whatchanged = SUB_VAL.log;
  for (const s of ["diff-tree", "diff-index", "diff-files", "range-diff"]) SUB_VAL[s] = SUB_VAL.diff;
  SUB_VAL.annotate = SUB_VAL.blame;
  function gitContent(sub, args) {
    if (["grep", "show", "cat-file", "blame", "annotate", "diff", "diff-tree", "diff-index", "diff-files", "range-diff", "whatchanged", "ls-files", "ls-tree"].includes(sub)) return true;
    if (sub === "log") return args.some((v) => LOG_SHOWS.test(v));
    if (sub === "stash") return args[0] === "show";
    return false;
  }
  function gitHit(words, exs, info, st) {
    const vals = words.map((w) => w.value), h = info.head;
    let starts = [...st.cwd], gitDirArg = null, unknown = false;
    for (let k = 0; k < h; k++) {
      const m = /^(GIT_DIR|GIT_COMMON_DIR|GIT_WORK_TREE|GIT_OBJECT_DIRECTORY)=/.exec(vals[k]);
      if (m) { if (!exs[k]) unknown = true; else if (m[1] !== "GIT_WORK_TREE") gitDirArg = exs[k].lit.slice(m[0].length); }
    }
    if (st.env.has("GIT_DIR")) { const v = st.env.get("GIT_DIR"); if (v === null) unknown = true; else gitDirArg = v; }
    let i = h + 1;
    while (i < vals.length && vals[i].startsWith("-")) {
      const v = vals[i];
      if (v === "-C") {
        const ex = exs[i + 1];
        if (!ex || ex.glob) unknown = true;
        else starts = starts.map((c) => (isAbsolute(ex.lit) ? resolve(ex.lit) : c === UNKNOWN ? UNKNOWN : resolve(c, ex.lit)));
        i += 2; continue;
      }
      if (v === "--git-dir") { if (!exs[i + 1]) unknown = true; else gitDirArg = exs[i + 1].lit; i += 2; continue; }
      if (v.startsWith("--git-dir=")) { if (!exs[i]) unknown = true; else gitDirArg = exs[i].lit.slice(10); i++; continue; }
      i += GIT_GLOBAL_VAL.has(v) ? 2 : 1;
    }
    const sub = vals[i], argIdx = [];
    for (let k = i + 1; k < vals.length; k++) argIdx.push(k);
    const args = argIdx.map((k) => vals[k]);
    if (sub === undefined || !gitContent(sub, args)) return null;
    if (sub === "show" && args.some((v) => v === "-s" || v === "--no-patch")) return null;
    const noIndex = args.includes("--no-index");
    for (const start of starts) {
      if (start === UNKNOWN && !(gitDirArg && isAbsolute(gitDirArg))) { unknown = true; continue; }
      let gd, top;
      if (gitDirArg) { const g = resolve(start === UNKNOWN ? "/" : start, gitDirArg); gd = commonDir(g); top = null; }
      else {
        if (!existsSync(start)) continue; // 없는 디렉터리면 git이 실패한다
        const r = findRepo(physical(start));
        if (!r) { if (noIndex) { const why = gitPaths(sub, argIdx, vals, exs, st, start, start, true); if (why) return why; } continue; }
        ({ gd, top } = r);
      }
      if (!isBlockedRepo(gd) && !noIndex) continue;
      top ??= blockedRepos.get(gd) ?? start;
      const base = start !== UNKNOWN && (lc(physical(start)) + "/").startsWith(lc(top) + "/") ? physical(start) : top;
      const why = gitPaths(sub, argIdx, vals, exs, st, base, top, false);
      if (why) return why;
    }
    return unknown ? `git 레포나 위치를 확인할 수 없어 기록 읽기를 막음: git ${sub}` : null;
  }
  function findRepo(start) {
    let d = start;
    for (let k = 0; k < 64; k++) {
      const g = join(d, ".git");
      let st = null;
      try { st = statSync(g); } catch {}
      if (st) return { gd: commonDir(st.isDirectory() ? g : pointer(g, d)), top: d };
      if (existsSync(join(d, "HEAD")) && existsSync(join(d, "objects")) && existsSync(join(d, "refs"))) return { gd: commonDir(d), top: d };
      const up = dirname(d);
      if (up === d) return null;
      d = up;
    }
    return null;
  }
  // pathspec·rev:path 판정. base = 상대 pathspec 기준(cwd), top = 레포 최상위
  function gitPaths(sub, argIdx, vals, exs, st, base, top, diskOnly) {
    const valSet = SUB_VAL[sub] ?? new Set();
    const grepish = sub === "grep";
    const one = { cwd: [base], env: st.env };
    const topSt = { cwd: [top], env: st.env };
    let dashdash = false, patternGiven = false, patternSkipped = false, sawRev = false, specs = 0;
    const objs = [];
    for (let n = 0; n < argIdx.length; n++) {
      const k = argIdx[n], v = vals[k];
      if (!dashdash && v === "--") { dashdash = true; continue; }
      if (!dashdash && v.startsWith("-")) {
        if (/^(-e|-f|--regexp|--file)$/.test(v) || /^-[a-zA-Z]*[ef]$/.test(v) && grepish) patternGiven = true;
        if (sub === "blame" || sub === "annotate" || sub === "log") { const m = /^-L(.*)$/.exec(v); if (m) { const spec = m[1] || vals[k + 1] || ""; const f = spec.slice(spec.lastIndexOf(":") + 1); if (f) objs.push([escGlob(f), one, v]); } }
        if (sub === "cat-file" && /^--batch/.test(v)) return `git cat-file --batch는 읽을 개체를 확인할 수 없음`;
        if (valSet.has(v)) n++;
        continue;
      }
      const ex = exs[k];
      if (grepish && !patternGiven && !patternSkipped && !dashdash) { patternSkipped = true; continue; }
      if (!ex) return `git ${sub}의 인자를 풀 수 없음: ${show(v)}`;
      // pathspec 매직: :/x, :(top)x, :!x(제외)
      let p = ex.lit, rel = base;
      const magic = /^:(\([^)]*\)|[/!^]*)/.exec(p);
      if (dashdash || (magic && magic[0].length > 1) || (!/^[^:]+:/.test(p) && existsSync(resolve(base, p)))) {
        if (magic) {
          const m = magic[1];
          if (m.includes("!") || m.includes("^") || /exclude/.test(m)) continue;
          if (m.includes("/") || /top/.test(m)) rel = top;
          p = p.slice(magic[0].length);
        }
        specs++;
        const w = p.search(/[*?[]/);
        const pat = w < 0 ? escGlob(p) : `${escGlob(p.slice(0, p.lastIndexOf("/", w) + 1))}**`;
        const listOne = sub === "ls-tree" && !vals.some((x) => /^-[a-zA-Z]*r/.test(x));
        const why = (listOne ? insideHit : scopeHit)([pat || "."], { cwd: [rel], env: st.env }, `git ${sub} ${v}`);
        if (why) return why;
        continue;
      }
      const colon = /^[^:]+:/.exec(p);
      if (colon && !diskOnly) { // rev:path
        const path = p.slice(colon[0].length);
        objs.push([escGlob(path || "."), /^\.\.?\//.test(path) ? one : topSt, v]);
        continue;
      }
      sawRev = true;
    }
    for (const [pat, s, label] of objs) {
      const why = grepish || (sub === "ls-tree" && vals.some((x) => /^-[a-zA-Z]*r/.test(x))) ? scopeHit([pat], s, `git ${sub} ${label}`) : insideHit([pat], s, `git ${sub} ${label}`);
      if (why) return why;
    }
    if (specs) return null;
    if (sub === "cat-file") return sawRev && !vals.some((x) => /^-[tse]$/.test(x)) ? `git cat-file로 워크스페이스 레포의 개체를 읽을 수 있음 — rev:path 형태로 경로를 밝혀라` : null;
    if (objs.length && !sawRev) return null;
    if (objs.length && ["show", "diff", "cat-file", "blame", "annotate"].includes(sub) && !grepish) return null;
    // pathspec이 없으면 grep·ls-files는 cwd 아래, 나머지는 레포 전체가 범위다
    const scope = grepish || sub === "ls-files" ? one : topSt;
    return scopeHit(["."], scope, `git ${sub} (pathspec 없음 — 차단 위치를 피하는 경로를 -- 뒤에 적어라)`);
  }

  // ---- 명령 걷기 ----
  const SHELLISH = new Set(["bash", "sh", "zsh", "dash", "ksh", "mksh", "ash", "fish", "csh", "tcsh", "eval", "su", "sudo", "watch", "env", "nohup", "time", "timeout", "gtimeout", "nice", "command", "exec", "builtin", "xargs", "find", "parallel", "script", "caffeinate", "stdbuf"]);
  const XARGS_VAL = new Set(["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "-J", "-R", "-S", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--replace", "--eof"]);
  const NO_READ = new Set(["echo", "printf", "true", "false", ":", "exit", "return", "sleep", "date", "set", "shift", "wait", "export", "unset", "for", "select", "read", "cd", "pushd", "popd", "do", "done", "then", "fi", "else"]);
  const LOCATE = new Set(["locate", "plocate", "glocate", "mlocate", "slocate", "mdfind"]);
  function commandHit(c, st, depth, inPipe) {
    const words = c.words;
    if (!words.length) return null;
    const look = lookupIn(st);
    const exs = words.map((w) => expandWord(w.raw, look, home));
    const vals = words.map((w, k) => (exs[k] && !exs[k].glob ? exs[k].lit : w.value));
    // 풀린 단어로 다시 분류한다(G=grep; $G -r x . 도 grep으로 본다)
    const lw = words.map((w, k) => (exs[k] && !exs[k].glob ? { raw: exs[k].lit, value: exs[k].lit, quoted: w.quoted, dyn: false, subst: false } : w));
    const info = classify(lw);
    const name = info.kind === "empty" || info.kind === "dynamic" ? null : info.name;

    // xargs 자리표시
    let repl = null;
    if (name === "xargs") {
      for (let k = info.head + 1; k < vals.length && vals[k].startsWith("-"); k++) {
        if (vals[k] === "-I" || vals[k] === "-J" || vals[k] === "--replace") repl = vals[k + 1] ?? "{}";
        else if (/^-[IJ]./.test(vals[k])) repl = vals[k].slice(2);
        else if (vals[k] === "-i" || vals[k].startsWith("--replace=")) repl = vals[k].split("=")[1] || "{}";
      }
    }
    // 1) 안쪽: 모든 단어와 리다이렉트 대상. 다 풀 수 없으면 풀 수 없는 부분을 와일드카드로 보고 본다
    const strict = !NO_READ.has(name);
    for (let k = 0; k < words.length; k++) {
      if (exs[k] && repl && exs[k].lit === repl) continue;
      const ex = exs[k] ?? expandWord(words[k].raw, look, home, true);
      const why = insideHit(wordPats(ex, repl), st, words[k].value, strict && k > info.head && !vals[k].startsWith("-"));
      if (why) return why;
    }
    for (const r of c.redirs) {
      const ex = expandWord(r.target.raw, look, home) ?? expandWord(r.target.raw, look, home, true);
      const why = insideHit(wordPats(ex), st, `${r.op} ${r.target.value}`, !/^\/dev\//.test(r.target.value));
      if (why) return why;
    }
    if (name === "ls" && !vals.slice(info.head + 1).some((v) => !v.startsWith("-"))) { // 인자 없는 ls = 현재 디렉터리의 이름 목록
      const why = insideHit(["."], st, "ls (현재 디렉터리)", true);
      if (why) return why;
    }
    // 2) 대입: 같은 명령 안의 리터럴 값만 기억한다
    const assignAt = (k) => {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(words[k].raw);
      if (!m) return;
      const ex = expandWord(words[k].raw.slice(m[0].length), look, home);
      st.env.set(m[1], ex && !ex.glob ? ex.lit : null);
    };
    if (info.kind === "empty") { for (let k = 0; k < words.length; k++) assignAt(k); return null; }
    if (["export", "declare", "typeset", "local", "readonly"].includes(name)) { for (let k = info.head + 1; k < words.length; k++) assignAt(k); return null; }
    if (name === "for" || name === "select") { // for x in a b c → x는 a·b·c 중 하나(글롭이면 그 패턴)
      const v = vals[info.head + 1];
      if (!v || !/^[A-Za-z_]\w*$/.test(v)) return null;
      const items = vals[info.head + 2] === "in" ? exs.slice(info.head + 3) : null;
      st.env.set(v, items && items.length && items.length <= 32 && items.every(Boolean) ? { alts: items.map((x) => x.pat.replace(/[,{}]/g, "\\$&")) } : null);
      return null;
    }
    if (name === "read" || name === "mapfile" || name === "readarray") { for (let k = info.head + 1; k < vals.length; k++) if (/^[A-Za-z_]\w*$/.test(vals[k])) st.env.set(vals[k], null); return null; }
    if (name === "unset") { for (let k = info.head + 1; k < vals.length; k++) st.env.delete(vals[k]); return null; }

    // 3) 이름을 모르는 명령: 위치 인자를 모두 재귀 뿌리로 본다
    if (info.kind === "dynamic") {
      for (let k = info.head + 1; k < words.length; k++) {
        if (vals[k].startsWith("-") || !exs[k]) continue;
        const why = scopeHit(wordPats(exs[k]), st, `${words[info.head].value} ${vals[k]}`);
        if (why) return why;
      }
      return null;
    }
    const h = info.head;
    // 4) 재귀 범위
    if (LOCATE.has(name)) {
      const k = vals.indexOf("-onlyin");
      if (name !== "mdfind" || k < 0) return `디스크 전체 색인 검색(${name})은 범위를 좁힐 수 없음`;
      const why = scopeHit(wordPats(exs[k + 1]), st, `${name} -onlyin ${vals[k + 1] ?? ""}`);
      if (why) return why;
    }
    const rec = recursiveRoots(name, vals, h);
    if (rec) {
      for (const r of rec.roots) {
        const why = r === "." ? scopeHit(["."], st, `${name} (현재 디렉터리)`, rec.depth) : r < words.length ? scopeHit(wordPats(exs[r], repl), st, `${name} ${vals[r]}`, rec.depth) : null;
        if (why) return why;
      }
    }
    if (name === "git") { const why = gitHit(lw, exs, info, st); if (why) return why; }

    // 5) 안쪽 명령: xargs, find -exec, 셸 문자열
    if (name === "xargs") {
      let k = h + 1;
      while (k < words.length && vals[k].startsWith("-")) k += XARGS_VAL.has(vals[k]) ? 2 : 1;
      if (k < words.length) {
        const why = commandHit({ words: words.slice(k), redirs: [], frags: [] }, st, depth, true);
        if (why) return why;
      }
    }
    if (name === "find" || name === "gfind" || name === "bfs") {
      for (let k = h + 1; k < words.length; k++) {
        if (!["-exec", "-execdir", "-ok", "-okdir"].includes(vals[k])) continue;
        let e = k + 1;
        while (e < words.length && vals[e] !== ";" && vals[e] !== "+") e++;
        const why = commandHit({ words: words.slice(k + 1, e), redirs: [], frags: [] }, st, depth, true);
        if (why) return why;
        k = e;
      }
    }
    if (info.kind !== "safe" && (SHELLISH.has(name) || info.kind === "shell")) {
      for (let k = h + 1; k < words.length; k++) {
        if (!/[\s;&|`$()<>]/.test(vals[k])) continue;
        const why = runScript(vals[k], clone(st), depth + 1);
        if (why) return why;
      }
    }
    // 6) cd·pushd·popd
    if (name === "cd" || name === "pushd" || name === "popd") {
      let k = h + 1;
      while (k < vals.length && /^-[LPe@]+$/.test(vals[k])) k++;
      if (vals[k] === "--") k++;
      let target;
      if (name === "popd" || vals[k] === "-") target = UNKNOWN;
      else if (k >= words.length) target = home || UNKNOWN;
      else {
        const ex = exs[k];
        if (!ex || ex.glob) target = UNKNOWN;
        else target = isAbsolute(ex.lit) ? resolve(ex.lit) : known(st) ? resolve(known(st), ex.lit) : UNKNOWN;
      }
      const prev = st.cwd;
      const exists = target !== UNKNOWN && existsSync(target);
      if (inPipe || c.sep === "&" || c.sep === "||") st.cwd = union(prev, [target]);
      else if (c.sep === "&&") { st.cwd = [target]; st.pending = { prev, target, exists, cmd: c }; }
      else st.cwd = exists ? [target] : union(prev, [target]);
    }
    return null;
  }

  function runScript(src, st, depth = 0) {
    if (depth > 8) return `명령이 너무 깊게 중첩됨`;
    let r;
    try { r = scan(src); } catch (e) {
      return /(^|[\s;&|(`'"/])(rg|ag|ack|fd|find|tree|du|grep|ls|cp|tar|zip|diff|git|mdfind|locate)(?=$|[\s;&|)`'"])/.test(src) ? `명령을 읽지 못해 범위를 확인할 수 없음 (${e.message})` : null;
    }
    const scopes = new Map([["", st]]);
    const stateFor = (scope) => {
      if (scopes.has(scope)) return scopes.get(scope);
      let p = scope;
      while (p && !scopes.has(p)) p = p.replace(/[^/]*\/$/, "");
      const s = clone(scopes.get(p) ?? st);
      scopes.set(scope, s);
      return s;
    };
    for (const c of r.commands) {
      const s = stateFor(c.scope);
      const inPipe = c.stage > 0 || c.sep === "|" || c.sep === "|&";
      for (const f of c.frags) {
        if (f.kind !== "subst" && f.kind !== "shell") continue;
        const why = runScript(f.text, clone(s), depth + 1);
        if (why) return why;
      }
      const why = commandHit(c, s, depth, inPipe);
      if (why) return why;
      if (s.pending && s.pending.cmd !== c && ![ "&&", "|", "|&"].includes(c.sep)) { // && 목록은 파이프를 넘어 이어진다
        const p = s.pending;
        if (s.cwd.length === 1 && s.cwd[0] === p.target) s.cwd = p.exists && c.sep !== "||" ? [p.target] : union(p.prev, [p.target]);
        s.pending = null;
      }
    }
    return null;
  }
  const bashHit = (cmd) => runScript(String(cmd), { cwd: [startCwd], env: new Map(), pending: null });

  return { readHit, grepToolHit, globToolHit, bashHit };
}

export { UNKNOWN };
