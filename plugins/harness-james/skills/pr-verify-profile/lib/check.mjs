// 프로필(초안이든 등록본이든) 기계 점검. 판단은 하지 않는다: 모양, 가중치 합, 별칭 중복, 빈 구조, 구조 밖 파일,
// 대조(dependents) 상대, 구조 id 변경과 피처맵 메타. 레포는 읽기만 한다.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { inStructure, matchesAny } from "./glob.mjs";
import { gitIn, isRealEnv, localLag } from "./git.mjs";
import { ignoreClass } from "./ignore.mjs";

export const DIMENSIONS = ["SEC", "PERF", "ARCH", "REL", "OPS", "TEST", "A11Y"];
const TRAITS = ["server", "client"];
// framework 2.0.0에서 없앤 칸. 레포 지식(기존 부채·정규식 규칙)은 프로필에 두지 않는다
// /pr-verify가 읽지 않는 옛 칸. 기존 부채는 base 트리 대조로 판단한다
const UNREAD_KEYS = ["known_debt"];
// /pr-verify 준비 단계(prepare)가 받는 규칙 종류와 값. 규칙이 틀리면 준비 단계가 멈춘다
const RULE_KINDS = ["path-modified", "path-added", "path-deleted", "added-line-regex", "removed-line-regex", "co-change-required", "added-file-missing-regex"];
const REGEX_KINDS = ["added-line-regex", "removed-line-regex", "added-file-missing-regex"];
const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const CONFIDENCES = ["confirmed", "likely", "possible"];
const CODE_EXT = new Set([".java", ".kt", ".gradle", ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".css", ".scss", ".sql", ".yml", ".yaml", ".toml", ".properties", ".sh", ".py", ".liquid", ".prisma", ".graphql"]);
const LIST_MAX = 60;

const isStr = (v) => typeof v === "string" && v.trim() !== "";
const isStrList = (v) => Array.isArray(v) && v.every(isStr);
const num = (v, lo, hi) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

// 1) JSON 모양. /pr-verify가 읽는 칸이 있고 타입이 맞는가
export function shapeProblems(p) {
  const out = [];
  const bad = (id, message) => out.push({ level: "FAIL", check: "shape", id, message });
  if (!p || typeof p !== "object" || Array.isArray(p)) return [{ level: "FAIL", check: "shape", id: "root", message: "프로필이 JSON 객체가 아님" }];
  if (!isStr(p.version) || !/^\d+\.\d+\.\d+$/.test(p.version)) bad("version", "version이 없거나 MAJOR.MINOR.PATCH가 아님");
  const r = p.repo;
  if (!r || typeof r !== "object") bad("repo", "repo 칸이 없음");
  else {
    for (const k of ["key", "name", "path", "github", "default_base"]) if (!isStr(r[k])) bad(`repo.${k}`, `repo.${k}가 없거나 빈 값`);
    if (isStr(r.path) && isAbsolute(r.path)) bad("repo.path", `repo.path가 절대 경로(${r.path}) — /pr-verify 준비 단계는 워크스페이스 뒤에 이어 붙이므로 워크스페이스 기준 상대 경로(밖이면 ../…)로 적어요`);
    if (isStr(r.github) && !/^[\w.-]+\/[\w.-]+$/.test(r.github)) bad("repo.github", `repo.github는 <소유자>/<레포> 모양이어야 함: ${r.github}`);
    if (!isStrList(r.aliases) || !r.aliases.length) bad("repo.aliases", "repo.aliases가 비었음(첫 별칭이 /pr-verify 안내 문구에 쓰임)");
    if (!isStrList(r.traits) || !r.traits.length) bad("repo.traits", "repo.traits가 비었음 — /pr-verify가 멈춤(server·client 중 하나 이상)");
    else for (const t of r.traits) if (!TRAITS.includes(t)) bad("repo.traits", `repo.traits의 ${t}는 server·client가 아님`);
  }
  const d = p.dimensions;
  if (!d || typeof d !== "object" || !Object.keys(d).length) bad("dimensions", "dimensions가 비었음");
  else for (const [k, v] of Object.entries(d)) {
    if (!DIMENSIONS.includes(k)) bad(`dimensions.${k}`, `모르는 차원 ${k}`);
    if (!num(v?.weight, 0, 1) || v.weight === 0) bad(`dimensions.${k}`, `dimensions.${k}.weight가 0보다 크고 1 이하인 수가 아님`);
  }
  for (const k of ["comment_syntax", "ignore_line_patterns"]) {
    if (p[k] === undefined) continue;
    if (typeof p[k] !== "object" || Array.isArray(p[k]) || !Object.values(p[k]).every(isStrList)) bad(k, `${k}는 { glob: [문자열…] } 모양이어야 함`);
  }
  for (const [glob, list] of Object.entries(p.ignore_line_patterns ?? {})) for (const rx of Array.isArray(list) ? list : []) {
    try { new RegExp(String(rx).replace(/^\(\?[ims]+\)/, "")); } catch (e) { bad("ignore_line_patterns", `${glob}의 정규식을 읽지 못함: ${e.message}`); }
  }
  if (!Array.isArray(p.structures)) bad("structures", "structures가 목록이 아님");
  else p.structures.forEach((s, i) => {
    const at = `structures[${i}]${isStr(s?.id) ? ` ${s.id}` : ""}`;
    if (!s || typeof s !== "object") return bad(at, "구조가 객체가 아님");
    if (!isStr(s.id)) bad(at, "id가 없음");
    if (!isStr(s.name)) bad(at, "name이 없음");
    if (!isStr(s.why)) bad(at, "why가 없음(왜 중요한지)");
    if (!num(s.criticality, 0, 100)) bad(at, "criticality가 0–100 수가 아님");
    if (s.review_threshold !== undefined && !num(s.review_threshold, 0, 100)) bad(at, "review_threshold가 0–100 수가 아님");
    if (!isStrList(s.paths) || !s.paths.length) bad(at, "paths가 비었음");
    if (s.exclude !== undefined && !isStrList(s.exclude)) bad(at, "exclude가 문자열 목록이 아님");
    if (s.specs !== undefined && !isStrList(s.specs) && !(Array.isArray(s.specs) && !s.specs.length)) bad(at, "specs가 문자열 목록이 아님");
  });
  for (const k of ["coverage_ignore", "long_lived_branches"]) if (p[k] !== undefined && !(Array.isArray(p[k]) && p[k].every(isStr))) bad(k, `${k}가 문자열 목록이 아님`);
  if (p.dependents !== undefined) {
    if (!Array.isArray(p.dependents)) bad("dependents", "dependents가 목록이 아님");
    else p.dependents.forEach((dep, i) => {
      if (!isStr(dep?.source)) bad(`dependents[${i}]`, "source가 없음");
      if (!Array.isArray(dep?.replicas) || !dep.replicas.length) bad(`dependents[${i}]`, "replicas가 비었음");
      else dep.replicas.forEach((rp, j) => { if (!isStr(rp?.repo) || !isStr(rp?.path)) bad(`dependents[${i}].replicas[${j}]`, "repo(상대 프로필 key)와 path가 있어야 함"); });
    });
  }
  if (p.secret_scan !== undefined && !isStr(p.secret_scan?.criterion)) bad("secret_scan", "secret_scan.criterion이 없음");
  if (p.tools !== undefined && !Array.isArray(p.tools)) bad("tools", "tools가 목록이 아님");
  if (p.feature_map !== undefined && !isStr(p.feature_map)) bad("feature_map", "feature_map이 문자열이 아님");
  for (const k of UNREAD_KEYS) if (p[k] !== undefined) out.push({ level: "WARN", check: "unread-key", id: k, message: `${k} 칸은 /pr-verify가 읽지 않음(기존 부채는 base 트리 대조로 판단) — 지워요` });
  out.push(...ruleProblems(p));
  return out;
}

// 1-1) 결정적 규칙(rules, disabled_rules, rule_overrides). /pr-verify 준비 단계와 같은 조건으로 본다
function rx(pattern, flags = "") {
  const m = /^\(\?([ims]+)\)/.exec(pattern);
  return new RegExp(m ? pattern.slice(m[0].length) : pattern, [...new Set((flags || "") + (m ? m[1] : ""))].join(""));
}
export function ruleProblems(p) {
  const out = [];
  const fail = (id, message) => out.push({ level: "FAIL", check: "rules", id, message });
  if (p.disabled_rules !== undefined && !isStrList(p.disabled_rules)) fail("disabled_rules", "disabled_rules가 문자열 목록이 아님");
  if (p.rule_overrides !== undefined && (typeof p.rule_overrides !== "object" || p.rule_overrides === null || Array.isArray(p.rule_overrides))) fail("rule_overrides", "rule_overrides가 객체가 아님");
  if (p.rules === undefined) return out;
  if (!Array.isArray(p.rules)) { fail("rules", "rules가 목록이 아님"); return out; }
  const key = p.repo?.key;
  const seen = new Set();
  p.rules.forEach((r, i) => {
    const at = isStr(r?.id) ? r.id : `rules[${i}]`;
    if (!isStr(r?.id)) return fail(at, "id가 없음");
    if (seen.has(r.id)) return fail(at, "규칙 id 중복");
    seen.add(r.id);
    if (r.repo !== key) return out.push({ level: "WARN", check: "rules", id: at, message: `repo(${r.repo ?? "없음"})가 이 프로필의 key(${key})와 달라 /pr-verify가 이 규칙을 건너뜀` });
    if (!RULE_KINDS.includes(r.kind)) return fail(at, `kind ${r.kind}는 ${RULE_KINDS.join("·")}가 아님`);
    if (!isStr(r.criterion)) fail(at, "criterion(기준 ID)이 없음");
    if (!SEVERITIES.includes(r.severity) || !CONFIDENCES.includes(r.confidence)) fail(at, "severity·confidence 값이 틀림");
    if (REGEX_KINDS.includes(r.kind) && !isStr(r.pattern)) fail(at, "pattern이 없음");
    for (const [k, f] of [["pattern", r.flags], ["path_regex", ""]]) if (isStr(r[k])) { try { rx(r[k], f); } catch (e) { fail(at, `${k} 정규식 오류: ${e.message}`); } }
  });
  return out;
}

// 2) 가중치 합
export function weightProblems(p) {
  const ws = Object.values(p.dimensions ?? {}).map((d) => d?.weight).filter((w) => typeof w === "number");
  if (!ws.length) return [];
  const sum = ws.reduce((a, b) => a + b, 0);
  const out = [];
  if (Math.abs(sum - 1) > 0.0005) out.push({ level: "FAIL", check: "weights", id: "dimensions", message: `차원 가중치 합이 ${sum.toFixed(3)} (1.0이어야 함)` });
  if (p.dimensions?.A11Y && !(p.repo?.traits ?? []).includes("client")) out.push({ level: "WARN", check: "weights", id: "A11Y", message: "A11Y 가중치가 있는데 traits에 client가 없음 — 적용되는 기준이 없어 항상 100점으로 종합 점수를 묽힘" });
  return out;
}

// 3) 별칭 중복. /pr-verify는 key·name·aliases로 레포를 찾고 먼저 맞는 프로필을 쓴다
export function aliasProblems(p, others) {
  const out = [];
  const names = (q) => [q.repo?.key, q.repo?.name, ...(q.repo?.aliases ?? [])].filter(isStr).map((s) => s.toLowerCase());
  const mine = names(p);
  const seen = new Set();
  for (const a of (p.repo?.aliases ?? []).map((s) => String(s).toLowerCase())) { if (seen.has(a)) out.push({ level: "INFO", check: "alias", id: a, message: `aliases 안에서 ${a}가 겹침(별칭은 대소문자를 가리지 않고 찾음) — 하나만 둬도 됨` }); seen.add(a); }
  for (const o of others) {
    const hit = [...new Set(mine.filter((a) => names(o).includes(a)))];
    if (hit.length) out.push({ level: "FAIL", check: "alias", id: hit[0], message: `${basename(o._path ?? "?")}와 이름이 겹침: ${hit.join(", ")} — /pr-verify가 엉뚱한 프로필을 고를 수 있음` });
    if (isStr(p.repo?.github) && o.repo?.github?.toLowerCase() === p.repo.github.toLowerCase()) out.push({ level: "FAIL", check: "alias", id: "github", message: `${basename(o._path ?? "?")}와 repo.github가 같음(${p.repo.github}) — PR 게이트가 먼저 읽힌 쪽만 봄` });
  }
  const ids = new Map();
  for (const s of p.structures ?? []) if (isStr(s?.id)) ids.set(s.id, (ids.get(s.id) ?? 0) + 1);
  for (const [id, n] of ids) if (n > 1) out.push({ level: "FAIL", check: "structure-id", id, message: `구조 id ${id}가 ${n}번 나옴` });
  return out;
}

// 구조 밖 파일 하나에 대한 단서: 같은 폴더의 파일을 가장 많이 잡는 구조. 없으면 위 폴더(그 아래 전체)로 올라간다.
// 루트에 바로 있는 파일은 루트의 다른 파일만 본다(트리 전체를 세면 단서가 안 된다)
export function siblingHint(path, tree, structures) {
  const score = (sibs) => structures.map((s) => ({ id: s.id, n: sibs.filter((p) => inStructure(p, s)).length })).filter((x) => x.n).sort((a, b) => b.n - a.n).slice(0, 2);
  const own = dirname(path);
  for (let dir = own; ; dir = dirname(dir)) {
    const sibs = tree.filter((p) => p !== path && (dir === "." ? !p.includes("/") : dir === own ? dirname(p) === dir : p.startsWith(dir + "/")));
    const top = score(sibs);
    if (top.length) return { dir, top };
    // 하위 폴더의 파일은 루트까지 올라가지 않는다(루트 파일을 잡는 구조는 그 파일의 단서가 못 된다)
    if (dir === "." || dirname(dir) === ".") return null;
  }
}

function dirSummary(files, max = 8) {
  const by = new Map();
  for (const f of files) { const seg = f.split("/"); const d = seg.length === 1 ? "." : seg.slice(0, seg.length > 2 ? 2 : 1).join("/"); by.set(d, (by.get(d) ?? 0) + 1); }
  const top = [...by.entries()].sort((a, b) => b[1] - a[1]);
  return top.slice(0, max).map(([d, n]) => `${d}/ ${n}`).join(", ") + (top.length > max ? ` 외 ${top.length - max}곳` : "");
}

// 4) 레포 트리와 맞춰 보기: 빈 구조, 구조 밖 파일, 구조별 파일 수
export function treeCheck({ profile, tree, changed = null }) {
  const structures = (profile.structures ?? []).filter((s) => s && Array.isArray(s.paths));
  const ignore = profile.coverage_ignore ?? [];
  const items = [];
  const rows = structures.map((s) => {
    const files = tree.filter((p) => inStructure(p, s));
    const dead = s.paths.filter((g) => !tree.some((p) => matchesAny(p, [g])));
    return { id: s.id, name: s.name, criticality: s.criticality, review_threshold: s.review_threshold ?? null, why: s.why, specs: s.specs ?? [], files: files.length, changed: changed ? changed.filter((p) => inStructure(p, s)).length : null, dead_paths: dead };
  });
  for (const r of rows.filter((r) => !r.files)) items.push({ level: "WARN", check: "empty-structure", id: r.id, message: `구조 ${r.id}의 경로가 이 트리에서 파일을 하나도 못 잡음 — /pr-verify 준비 단계가 같은 경고를 냄` });
  const deadTotal = rows.filter((r) => r.files).flatMap((r) => r.dead_paths.map((g) => `${r.id}: ${g}`));
  if (deadTotal.length) items.push({ level: "INFO", check: "dead-path", id: "paths", message: `파일을 못 잡는 경로 ${deadTotal.length}개(구조는 다른 경로로 파일을 잡음)`, files: deadTotal });
  const covered = (p) => structures.some((s) => inStructure(p, s));
  const uncovered = (p) => !covered(p) && !matchesAny(p, ignore);
  const withHint = (list) => list.map((p) => {
    const h = siblingHint(p, tree, structures);
    const c = ignoreClass(p);
    const notes = [isRealEnv(p) ? "커밋된 env 파일(내용은 읽지 않음): 값을 쓰는 구조에 넣을 후보" : null, h ? `${h.dir === "." ? "루트" : h.dir + "/"}의 다른 파일: ${h.top.map((t) => `${t.id} ${t.n}개`).join(", ")}` : null, c ? `coverage_ignore 후보(${c})` : null].filter(Boolean);
    return notes.length ? `${p}  ← ${notes.join(" · ")}` : p;
  });
  if (changed) {
    const unc = changed.filter(uncovered);
    if (unc.length) items.push({ level: "WARN", check: "uncovered-changed", id: "changed", message: `이 범위에서 바뀐 파일 ${changed.length}개 중 ${unc.length}개가 구조에도 coverage_ignore에도 안 걸림 — /pr-verify 준비 단계가 경고하는 파일`, files: withHint(unc.slice(0, LIST_MAX)), more: Math.max(0, unc.length - LIST_MAX) });
  }
  const treeUnc = tree.filter(uncovered);
  if (treeUnc.length) items.push({ level: "WARN", check: "uncovered-tree", id: "tree", message: `트리 전체 ${tree.length}개 중 ${treeUnc.length}개가 구조에도 coverage_ignore에도 안 걸림(바뀌면 경고가 날 파일) — ${dirSummary(treeUnc)}`, files: treeUnc.length <= LIST_MAX ? withHint(treeUnc) : [], more: treeUnc.length > LIST_MAX ? treeUnc.length : 0 });
  const deadIgnore = ignore.filter((g) => !tree.some((p) => matchesAny(p, [g])));
  if (deadIgnore.length) items.push({ level: "INFO", check: "ignore-dead", id: "coverage_ignore", message: `coverage_ignore 중 파일을 못 잡는 것 ${deadIgnore.length}개`, files: deadIgnore });
  const over = tree.map((p) => ({ p, ids: structures.filter((s) => inStructure(p, s)).map((s) => s.id) })).filter((x) => x.ids.length > 1);
  const overlap = over.length;
  if (overlap) items.push({ level: "INFO", check: "overlap", id: "overlap", message: `여러 구조에 걸리는 파일 ${overlap}개(겹쳐도 됨: 놓치느니 더 경고)`, files: over.slice(0, 12).map((x) => `${x.p}: ${x.ids.join(", ")}`), more: Math.max(0, overlap - 12) });
  const noSyntax = [...new Set(tree.filter(covered).map((p) => extname(p)).filter((e) => CODE_EXT.has(e)))].filter((e) => !Object.keys(profile.comment_syntax ?? {}).some((g) => matchesAny(`x/y${e}`, [g])));
  if (noSyntax.length) items.push({ level: "INFO", check: "comment-syntax", id: "comment_syntax", message: `구조에 든 파일 확장자 중 주석 문법이 없는 것: ${noSyntax.join(", ")} — 주석만 바뀐 줄도 동작 변경으로 세어짐` });
  return { items, rows, stats: { tree: tree.length, uncovered_tree: treeUnc.length, changed: changed?.length ?? null, overlap } };
}

// 5) 다른 레포와의 대조(dependents). 상대 프로필이 없으면 /pr-verify는 경고만 내고 대조를 건너뛴다
export function dependentProblems({ profile, tree, registered, siblings = [], ws, gitFor = gitIn }) {
  const items = [];
  const seen = new Set();
  const once = (key, item) => { if (!seen.has(key)) { seen.add(key); items.push(item); } };
  for (const dep of profile.dependents ?? []) {
    if (!isStr(dep?.source) || !Array.isArray(dep.replicas)) continue;
    if (tree && !tree.some((p) => matchesAny(p, [dep.source]))) once(`src:${dep.source}`, { level: "WARN", check: "dependent-source", id: dep.source, message: `dependents 원천 ${dep.source}가 이 트리에 없음 — 바뀌어도 대조가 안 걸림` });
    for (const rp of dep.replicas) {
      if (!isStr(rp?.repo) || !isStr(rp?.path)) continue;
      const reg = registered.find((q) => q.repo?.key === rp.repo);
      const sib = siblings.find((q) => q.repo?.key === rp.repo);
      const other = reg ?? sib;
      if (!other) { once(`repo:${rp.repo}`, { level: "WARN", check: "dependent-repo", id: rp.repo, message: `대조 상대 ${rp.repo}의 프로필이 없음(repo는 상대 프로필의 key) — /pr-verify가 경고만 내고 이 대조를 건너뜀` }); continue; }
      if (!reg) once(`repo:${rp.repo}`, { level: "INFO", check: "dependent-repo", id: rp.repo, message: `대조 상대 ${rp.repo}는 초안(${basename(sib._path ?? "?")})에만 있음 — 두 프로필을 함께 등록해야 대조가 돎` });
      const ref = rp.ref ?? other.repo?.default_base;
      const repoDir = resolve(ws, other.repo?.path ?? "");
      if (!existsSync(repoDir)) { once(`dir:${rp.repo}`, { level: "WARN", check: "dependent-ref", id: rp.repo, message: `대조 상대 레포 폴더가 없음: ${other.repo?.path}` }); continue; }
      const g = gitFor(repoDir);
      const named = isStr(rp.ref) && !/^origin\//.test(rp.ref) && !/^[0-9a-f]{7,40}$/.test(rp.ref);
      if (named) {
        // /pr-verify는 이 이름을 로컬 브랜치에서 먼저 찾는다. 로컬 브랜치는 origin보다 뒤처져 있을 수 있다
        const lag = localLag(g, rp.ref);
        const hasOrigin = !!g.commit(`refs/remotes/origin/${rp.ref}`);
        const say = lag?.behind ? `지금 origin/${rp.ref}보다 ${lag.behind}커밋 뒤` : hasOrigin ? "지금은 origin과 같거나 앞섬" : "origin에는 이 브랜치가 없음";
        once(`ref:${rp.repo}:${rp.ref}`, { level: lag?.behind ? "WARN" : "INFO", check: "dependent-ref", id: `${rp.repo}:${rp.ref}`, message: `대조 ref ${rp.ref}는 로컬 브랜치를 먼저 찾음(${say}) — origin/… 이름으로 적어요` });
      }
      const sha = g.commit(ref) ?? g.commit(`origin/${String(ref).replace(/^origin\//, "")}`);
      if (!sha) { once(`noref:${rp.repo}:${ref}`, { level: "WARN", check: "dependent-ref", id: `${rp.repo}:${ref}`, message: `대조 ref ${ref}를 ${other.repo?.path}에서 찾지 못함` }); continue; }
      // 이미 상대 레포 default_base에 들어간 브랜치면 그 뒤 커밋이 빠진 옛 내용과 대조하게 된다
      const def = isStr(rp.ref) ? g.commit(other.repo?.default_base) : null;
      if (def && def !== sha && g.tryRun("merge-base", "--is-ancestor", sha, def) !== null) {
        const behind = Number(g.tryRun("rev-list", "--count", `${sha}..${def}`)?.trim() ?? 0);
        once(`stale:${rp.repo}:${rp.ref}`, { level: "WARN", check: "dependent-ref", id: `${rp.repo}:${rp.ref}:stale`, message: `대조 ref ${rp.ref}는 이미 ${rp.repo}의 ${other.repo.default_base}에 들어갔고 ${behind}커밋 뒤 — 옛 내용과 대조함. ${other.repo.default_base}로 바꾸거나 ref를 빼요(빼면 상대 default_base)` });
      }
      const otherTree = g.tree(sha);
      if (!otherTree.some((p) => matchesAny(p, [rp.path]))) once(`path:${rp.repo}:${rp.path}:${ref}`, { level: "WARN", check: "dependent-path", id: `${rp.repo}:${rp.path}`, message: `대조 파일 ${rp.path}가 ${rp.repo} @ ${ref}에 없음` });
    }
  }
  return items;
}

// 기능 문서 폴더(feature_map)의 파일 첫 줄 메타 `<!-- fm: …; structures=<id>,… -->`(구조 id를 가리킴). 메타가 없는 파일은 빈 목록
export function featureRefs(ws, profile) {
  if (!isStr(profile?.feature_map)) return [];
  const dir = resolve(ws, profile.feature_map);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.endsWith(".md") && n !== "README.md").sort().map((n) => {
    const first = readFileSync(join(dir, n), "utf8").split("\n", 1)[0];
    const m = /^<!--\s*fm:\s*(.*?)\s*-->\s*$/.exec(first);
    const st = m ? /(?:^|;)\s*structures=([^;]*)/.exec(m[1])?.[1] ?? "" : "";
    return { file: join(profile.feature_map, n), id: basename(n, ".md"), structures: st.split(",").map((s) => s.trim()).filter(Boolean) };
  });
}

// 6) 등록본과의 차이. 구조 id를 없애거나 바꾸면 피처맵 메타가 깨진다
export function diffProfiles({ current, draft, ws, currentTree = null, draftTree = null }) {
  const cur = new Map((current.structures ?? []).map((s) => [s.id, s]));
  const nxt = new Map((draft.structures ?? []).map((s) => [s.id, s]));
  const same = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  const count = (s, tree) => (tree ? tree.filter((p) => inStructure(p, s)).length : null);
  const addedAll = [...nxt.keys()].filter((id) => !cur.has(id));
  const removedAll = [...cur.keys()].filter((id) => !nxt.has(id));
  // 없어진 id와 경로가 똑같은 새 id는 이름만 바꾼 것으로 본다
  const renamed = [];
  for (const id of removedAll) {
    const to = addedAll.find((a) => same(nxt.get(a).paths, cur.get(id).paths) && same(nxt.get(a).exclude, cur.get(id).exclude) && !renamed.some((r) => r.to === a));
    if (to) renamed.push({ from: id, to });
  }
  const removed = removedAll.filter((id) => !renamed.some((r) => r.from === id));
  const added = addedAll.filter((id) => !renamed.some((r) => r.to === id));
  const changed = [];
  for (const [id, s] of nxt) {
    const o = cur.get(id);
    if (!o) continue;
    const f = {};
    for (const k of ["criticality", "review_threshold", "name", "why"]) if (o[k] !== s[k]) f[k] = [o[k] ?? null, s[k] ?? null];
    const pa = (s.paths ?? []).filter((g) => !(o.paths ?? []).includes(g));
    const pr = (o.paths ?? []).filter((g) => !(s.paths ?? []).includes(g));
    if (pa.length || pr.length) f.paths = { added: pa, removed: pr };
    if (!same(o.exclude, s.exclude)) f.exclude = [o.exclude ?? [], s.exclude ?? []];
    if (!same(o.specs, s.specs)) f.specs = [o.specs ?? [], s.specs ?? []];
    if (Object.keys(f).length) changed.push({ id, ...f, files: [count(o, currentTree ?? draftTree), count(s, draftTree)] });
  }
  const ci = { added: (draft.coverage_ignore ?? []).filter((g) => !(current.coverage_ignore ?? []).includes(g)), removed: (current.coverage_ignore ?? []).filter((g) => !(draft.coverage_ignore ?? []).includes(g)) };
  // 대조(dependents): 원천 → 상대 파일 짝이 더해지거나 빠진 것, ref만 바뀐 것
  const pairs = (p) => new Map((p.dependents ?? []).flatMap((d) => (d.replicas ?? []).map((r) => [`${d.source} → ${r.repo}:${r.path}`, r.ref ?? "(상대 default_base)"])));
  const dc = pairs(current), dn = pairs(draft);
  const refMoves = new Map();
  for (const [k, ref] of dn) if (dc.has(k) && dc.get(k) !== ref) { const m = `${dc.get(k)} → ${ref}`; refMoves.set(m, (refMoves.get(m) ?? 0) + 1); }
  const dependents = { added: [...dn.keys()].filter((k) => !dc.has(k)), removed: [...dc.keys()].filter((k) => !dn.has(k)), refs: [...refMoves].map(([move, n]) => ({ move, n })) };
  const depTouched = dependents.added.length || dependents.removed.length || dependents.refs.length;
  const items = [];
  const refs = featureRefs(ws, current);
  const gone = [...removed.map((id) => ({ id, how: "없앰" })), ...renamed.map((r) => ({ id: r.from, how: `${r.to}로 이름 바꿈` }))];
  for (const gn of gone) {
    const hit = refs.filter((r) => r.structures.includes(gn.id)).map((r) => r.file);
    items.push({ level: "WARN", check: "structure-id-change", id: gn.id, message: `기존 구조 id ${gn.id}를 ${gn.how}${hit.length ? ` — 피처맵 메타 ${hit.length}곳이 이 id를 가리켜 깨짐` : " — 이 id를 가리키는 피처맵 메타는 없음"}. 확인 표에 따로 표시해요`, files: hit });
  }
  for (const c of changed.filter((c) => c.specs)) items.push({ level: "INFO", check: "structure-specs-change", id: c.id, message: `구조 ${c.id}의 specs가 바뀜(${c.specs[0].join(",") || "없음"} → ${c.specs[1].join(",") || "없음"}) — 메타 structures가 빈 기능 파일은 specs로 구조를 찾음` });
  const touched = addedAll.length || removedAll.length || changed.length || ci.added.length || ci.removed.length;
  // 필요한 version 단계: 구조 삭제·id 변경은 MAJOR, 그 밖의 구조·coverage_ignore·dependents 변경은 MINOR
  if (touched || depTouched) {
    const need = removedAll.length ? "MAJOR" : "MINOR";
    const [a, b] = [current.version, draft.version].map((v) => String(v ?? "").split(".").map(Number));
    const enough = need === "MAJOR" ? b[0] > a[0] : b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]);
    if (!enough) items.push({ level: "WARN", check: "version", id: "version", message: `version ${current.version} → ${draft.version}: ${need === "MAJOR" ? "구조 id를 없애거나 바꿨으므로 MAJOR" : "구조 목록이나 coverage_ignore·dependents가 바뀌었으므로 MINOR"}를 올려요` });
  }
  return { added, removed, renamed, changed, coverage_ignore: ci, dependents, version: [current.version ?? null, draft.version ?? null], items, unchanged: !touched && !depTouched };
}

// 파일 이름 그대로 적은 경로가 파일을 못 잡으면 이름이 바뀐 것인지 git 기록에서 찾는다
export function renamedPaths(g, headSha, tree, rows, structures = []) {
  const dead = rows.flatMap((r) => r.dead_paths.filter((p) => !/[*?]/.test(p.split("/").at(-1))).map((p) => ({ id: r.id, path: p })));
  if (!dead.length) return [];
  const moved = new Map();
  for (const l of g.lines("log", "-M", "--diff-filter=R", "--name-status", "--format=", "-n", "3000", headSha)) {
    const [st, from, to] = l.split("\t");
    if (st?.startsWith("R") && from && to && !moved.has(from)) moved.set(from, to);
  }
  const out = [];
  for (const d of dead) {
    let to = moved.get([...moved.keys()].find((from) => matchesAny(from, [d.path])));
    for (let i = 0; to && !tree.includes(to) && i < 5; i++) to = moved.get(to);
    if (!to || !tree.includes(to)) continue;
    const held = structures.filter((s) => inStructure(to, s)).map((s) => s.id);
    out.push({ level: "WARN", check: "renamed-path", id: `${d.id}:${d.path}`, message: `구조 ${d.id}의 경로 ${d.path}는 git 기록에서 이름이 바뀐 것으로 보임 → ${to} — ${held.length ? `새 파일은 ${held.join(", ")}에 걸려 있음. 이 구조에도 둘지 정하고 옛 경로는 지워요` : "맞으면 경로를 새 이름으로 고쳐요"}` });
  }
  return out;
}

// 장기 브랜치 목록(long_lived_branches·ledgers)에 이미 default_base에 들어갔거나 없어진 브랜치가 남았는지
export function branchProblems(g, profile) {
  const def = g.commit(profile.repo?.default_base);
  const names = [...new Set([...(profile.long_lived_branches ?? []), ...(profile.ledgers ?? []).flatMap((l) => l.branches ?? [])])].filter(isStr);
  const out = [];
  for (const b of names) {
    const tip = g.commit(`refs/remotes/origin/${b}`) ?? g.commit(`refs/heads/${b}`);
    if (!tip) out.push({ level: "INFO", check: "stale-branch", id: b, message: `장기 브랜치 ${b}가 레포에 없음(long_lived_branches·ledgers)` });
    else if (def && tip !== def && g.tryRun("merge-base", "--is-ancestor", tip, def) !== null) out.push({ level: "INFO", check: "stale-branch", id: b, message: `장기 브랜치 ${b}는 이미 ${profile.repo.default_base}에 들어감 — long_lived_branches·ledgers에서 뺄지 봐요` });
  }
  return out;
}

// 전체 점검. head 트리와 (base가 있으면) 그 뒤 바뀐 파일을 git으로 읽는다
export function checkProfile({ profile, profilePath = null, ws, registered = [], siblings = [], repoDir = null, head = null, base = null, against = null, gitFor = gitIn }) {
  const items = [...shapeProblems(profile)];
  const me = profilePath ? resolve(profilePath) : null;
  const others = registered.filter((q) => (!me || resolve(q._path ?? "") !== me) && (!against || q.repo?.key !== against.repo?.key));
  if (!profile || typeof profile !== "object") return { items, rows: [], stats: {}, diff: null, head: null, base: null };
  items.push(...weightProblems(profile), ...aliasProblems(profile, others));
  let tree = null, rows = [], stats = {}, headSha = null, baseSha = null, changed = null;
  const dir = repoDir ?? (isStr(profile.repo?.path) ? resolve(ws, profile.repo.path) : null);
  const g = dir && existsSync(dir) ? gitFor(dir) : null;
  if (!g || !g.isRepo()) items.push({ level: "FAIL", check: "repo", id: "repo.path", message: `레포를 열지 못함: ${profile.repo?.path ?? "(경로 없음)"} — 트리 점검을 건너뜀` });
  else {
    const ref = head ?? profile.repo?.default_base;
    headSha = g.commit(ref);
    if (!headSha) items.push({ level: "FAIL", check: "repo", id: "head", message: `ref ${ref}를 찾지 못함 — 트리 점검을 건너뜀` });
    else {
      if (isStr(profile.repo?.default_base) && !g.commit(profile.repo.default_base)) items.push({ level: "WARN", check: "repo", id: "repo.default_base", message: `default_base ${profile.repo.default_base}를 레포에서 찾지 못함` });
      const origin = g.tryRun("remote", "get-url", "origin")?.trim() ?? "";
      if (isStr(profile.repo?.github) && origin && !origin.toLowerCase().replace(/\.git$/, "").endsWith(profile.repo.github.toLowerCase())) items.push({ level: "WARN", check: "repo", id: "repo.github", message: `repo.github(${profile.repo.github})가 origin(${origin})과 다름 — PR 게이트가 이 레포를 못 찾음` });
      tree = g.tree(headSha);
      if (base) {
        baseSha = g.commit(base);
        if (!baseSha) items.push({ level: "FAIL", check: "repo", id: "base", message: `base ${base}를 찾지 못함` });
        else changed = g.lines("diff", "--name-only", "--no-renames", "--diff-filter=d", baseSha, headSha);
      }
      const tc = treeCheck({ profile, tree, changed });
      items.push(...tc.items, ...renamedPaths(g, headSha, tree, tc.rows, profile.structures ?? []), ...branchProblems(g, profile)); rows = tc.rows; stats = tc.stats;
    }
  }
  items.push(...dependentProblems({ profile, tree, registered: others, siblings, ws, gitFor }));
  let diff = null;
  if (against) {
    diff = diffProfiles({ current: against, draft: profile, ws, currentTree: tree, draftTree: tree });
    items.push(...diff.items);
  } else {
    const ids = new Set((profile.structures ?? []).map((s) => s?.id));
    for (const r of featureRefs(ws, profile)) for (const id of r.structures) if (!ids.has(id)) items.push({ level: "WARN", check: "feature-meta", id: `${r.id}:${id}`, message: `피처맵 ${r.file}의 메타가 없는 구조 ${id}를 가리킴`, files: [r.file] });
  }
  const count = (lv) => items.filter((i) => i.level === lv).length;
  return { items, rows, stats: { ...stats, FAIL: count("FAIL"), WARN: count("WARN"), INFO: count("INFO") }, diff, head: headSha, base: baseSha };
}
