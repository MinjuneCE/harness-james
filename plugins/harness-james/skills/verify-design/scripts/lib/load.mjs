// 프로파일·묶음 문서 적재. 문서를 줄·절로 나누고 이력 맥락·코드 블록을 표시한다.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_VOCAB, asArray, matchesAny, readJson, sha256, shortHash } from "./util.mjs";

// --map "<논리 접두어>=<실제 접두어>" 로 경로를 바꾼다(고정 사본 시험용). 프로파일 파일은 고치지 않는다.
export function makePathMapper(root, maps = []) {
  const pairs = maps.map((m) => {
    const i = m.indexOf("=");
    if (i < 0) throw new Error(`--map 형식 오류: ${m} (from=to)`);
    return [m.slice(0, i), m.slice(i + 1)];
  });
  return (logical) => {
    for (const [from, to] of pairs) {
      if (logical.startsWith(from)) return resolve(root, to + logical.slice(from.length));
    }
    return resolve(root, logical);
  };
}

export function loadProfile(profilePath) {
  const p = readJson(profilePath);
  const errors = [];
  for (const f of ["version", "rubric_version", "profile", "design", "bundle", "requirement_sources"]) {
    if (p[f] == null) errors.push(`필수 필드 없음: ${f}`);
  }
  if (!asArray(p.requirement_sources).length) errors.push("requirement_sources가 비었다");
  const traits = asArray(p.design?.traits);
  if (traits.includes("external-integration") && !asArray(p.external_sources).length) errors.push("external-integration인데 external_sources 없음");
  if (traits.includes("multi-doc") && !p.id_patterns) errors.push("multi-doc인데 id_patterns 없음");
  const canon = new Map();
  for (const d of asArray(p.bundle?.documents)) {
    for (const t of asArray(d.canonical_for)) {
      if (canon.has(t)) errors.push(`정본 중복: "${t}" (${canon.get(t)}, ${d.path})`);
      canon.set(t, d.path);
    }
  }
  for (const [scope, obj] of [["dimensions", p.dimensions], ["criteria", p.criteria]]) {
    for (const [k, v] of Object.entries(obj || {})) {
      if (v && v.enabled === false && !v.reason) errors.push(`${scope}.${k}: enabled:false인데 reason 없음`);
    }
  }
  return { profile: p, errors };
}

// 프로파일에서 추출 어휘를 모은다. 프로파일 값이 기본값에 더해진다.
export function vocabulary(profile) {
  const m = profile.markers || {};
  const h = profile.script_hints || {};
  const pick = (key, ...extra) => [...new Set([...asArray(DEFAULT_VOCAB[key]), ...extra.flatMap(asArray)])];
  return {
    unverified: asArray(m.unverified),
    inferred: asArray(m.inferred),
    statement: asArray(m.statement),
    placeholder: pick("placeholder", m.placeholder),
    history: [...asArray(m.history_context), ...DEFAULT_VOCAB.history_extra],
    vague: asArray(h.vague_words),
    number_units: asArray(h.number_units),
    state_name_pattern: h.state_name_pattern || "\\b[A-Z][A-Z_]{2,}\\b",
    commit_pattern: h.commit_pattern || "\\b[0-9a-f]{7,40}\\b",
    time_words: pick("time_words", h.time_words),
    status_words: pick("status_words", h.status_words),
    supersede_words: pick("supersede_words", h.supersede_words),
    secondary_markers: pick("secondary_markers", h.secondary_markers),
    source_markers: pick("source_markers", h.source_markers),
    owner_words: pick("owner_words", h.owner_words),
    method_words: pick("method_words", h.method_words),
    impact_words: pick("impact_words", h.impact_words),
    acceptance_markers: pick("acceptance_markers", h.acceptance_markers),
    threat_headers: pick("threat_headers", h.threat_headers),
    timing_keys: pick("timing_keys", h.timing_keys),
  };
}

const TEXT_EXT = new Set([".md", ".markdown", ".txt", ".graphql", ".gql", ".sql", ".toml", ".json", ".yaml", ".yml", ".java", ".ts", ".js", ".mjs", ".kt", ".py", ".go", ".rb", ".xml", ".csv", ".http", ".proto"]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

function isBinary(buf) {
  const n = Math.min(buf.length, 4096);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// 묶음 문서 목록을 만든다. roots 아래 파일 전부 + documents에 적힌 파일. 역할은 가장 긴 접두어 일치로 정한다.
export function collectBundle(profile, mapPath, root) {
  const docsCfg = asArray(profile.bundle?.documents);
  const exclude = asArray(profile.bundle?.exclude);
  const toLogical = new Map(); // fs → logical
  const missing = [];
  const unreadable = [];
  const addTree = (logical) => {
    const fsPath = mapPath(logical);
    if (!existsSync(fsPath)) { missing.push(logical); return; }
    if (statSync(fsPath).isDirectory()) {
      for (const f of walk(fsPath)) {
        const rel = relative(fsPath, f).split(sep).join("/");
        const lg = logical.replace(/\/?$/, "/") + rel;
        if (!toLogical.has(f)) toLogical.set(f, lg);
      }
    } else if (!toLogical.has(fsPath)) toLogical.set(fsPath, logical);
  };
  for (const r of asArray(profile.bundle?.roots)) addTree(r);
  for (const d of docsCfg) addTree(d.path);

  const roleOf = (logical) => {
    let best = null;
    for (const d of docsCfg) {
      const p = d.path;
      const hit = p.endsWith("/") ? logical.startsWith(p) : logical === p || logical.startsWith(p + "/");
      if (hit && (!best || p.length > best.path.length)) best = d;
    }
    return best;
  };

  const documents = [];
  for (const [fsPath, logical] of [...toLogical.entries()].sort((a, b) => a[1].localeCompare(b[1]))) {
    const cfg = roleOf(logical);
    if (matchesAny(logical, exclude) || (cfg && cfg.readable === false)) {
      unreadable.push({ path: logical, reason: cfg?.readable === false ? "readable:false" : "exclude" });
      continue;
    }
    const buf = readFileSync(fsPath);
    if (isBinary(buf) || (!TEXT_EXT.has(extname(fsPath).toLowerCase()) && extname(fsPath) !== "")) {
      unreadable.push({ path: logical, reason: "binary-or-unknown-type" });
      continue;
    }
    documents.push({
      path: logical,
      fs_path: relative(root, fsPath).split(sep).join("/"),
      role: cfg?.role || "unlisted",
      canonical_for: asArray(cfg?.canonical_for),
      reads_from: asArray(cfg?.reads_from),
      text: buf.toString("utf8"),
    });
  }
  return { documents, missing, unreadable };
}

// 문서 하나를 줄·절로 나눈다. 마크다운이 아니면 절은 파일 하나다.
export function parseDocument(doc, vocab) {
  const isMd = /\.(md|markdown)$/i.test(doc.path);
  const raw = doc.text.split(/\r?\n/);
  const lines = [];
  const sections = [];
  let inCode = false;
  let fence = null;
  const stack = []; // {level, title}
  let cur = { key: "(문서 머리)", heading: "(문서 머리)", level: 0, line_start: 1, body: [] };
  const seenKeys = new Map();
  const pushSection = (endLine) => {
    cur.line_end = endLine;
    cur.hash = shortHash(cur.body.join("\n").replace(/[ \t]+$/gm, ""));
    delete cur.body;
    sections.push(cur);
  };
  raw.forEach((text, i) => {
    const n = i + 1;
    const fenceM = text.match(/^\s*(```+|~~~+)/);
    let heading = null;
    if (isMd && !inCode) {
      const hm = text.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (hm) heading = { level: hm[1].length, title: hm[2] };
    }
    if (heading) {
      if (n > 1 || cur.body.length) pushSection(n - 1);
      while (stack.length && stack[stack.length - 1].level >= heading.level) stack.pop();
      stack.push(heading);
      const base = stack.map((s) => s.title).join(" > ");
      const cnt = (seenKeys.get(base) || 0) + 1;
      seenKeys.set(base, cnt);
      cur = { key: cnt > 1 ? `${base} #${cnt}` : base, heading: heading.title, level: heading.level, line_start: n, body: [] };
    }
    cur.body.push(text);
    const history = vocab.history.some((w) => w && text.includes(w));
    lines.push({ n, text, in_code: inCode || !!fenceM, section: cur.key, heading: !!heading, history });
    if (fenceM) {
      if (!inCode) { inCode = true; fence = fenceM[1][0]; }
      else if (fenceM[1][0] === fence) { inCode = false; fence = null; }
    }
  });
  pushSection(raw.length);
  // 첫 절이 빈 머리면 지운다
  if (sections.length > 1 && sections[0].key === "(문서 머리)" && sections[0].line_end < sections[0].line_start) sections.shift();
  return { ...doc, is_md: isMd, lines, sections, hash: sha256(doc.text).slice(0, 16), line_count: raw.length, char_count: doc.text.length };
}

// requirement_sources 한 항목 → 그 원 요구 줄들(_schema 0.1.2).
// section: 실제 절 제목(문자열·배열, '#'만 뺀 그대로). 제목 하나는 하위 절까지 포함. 생략하면 문서 전체. lines: "시작-끝"으로 더 좁힌다.
export function sourceLines(doc, src) {
  const titles = asArray(src.section).map((t) => String(t).trim()).filter(Boolean);
  const m = String(src.lines || "").match(/^\s*(\d+)\s*[-–~]\s*(\d+)\s*$/);
  const range = m ? [Number(m[1]), Number(m[2])] : null;
  const unmatched = [];
  let keys = null;
  if (titles.length) {
    keys = new Set();
    for (const t of titles) {
      const hit = doc.sections.filter((sec) => sec.key.replace(/ #\d+$/, "").split(" > ").includes(t));
      if (!hit.length) unmatched.push(t);
      for (const h of hit) keys.add(h.key);
    }
  }
  const lines = doc.lines.filter((l) => (!keys || keys.has(l.section)) && (!range || (l.n >= range[0] && l.n <= range[1])));
  return { lines, unmatched, sections: keys ? [...keys] : null, range };
}

export function loadBundle({ profilePath, root, maps }) {
  const { profile, errors } = loadProfile(profilePath);
  const mapPath = makePathMapper(root, maps);
  const vocab = vocabulary(profile);
  const { documents, missing, unreadable } = collectBundle(profile, mapPath, root);
  const docs = documents.map((d) => parseDocument(d, vocab));
  for (const m of missing) errors.push(`bundle 경로 없음: ${m}`);
  for (const [name, prm] of Object.entries(profile.parameters || {})) {
    if (prm && prm.compare_keys && !prm.relation) errors.push(`parameters.${name}: compare_keys가 있는데 relation이 없다`);
  }
  // 묶음 밖 원 요구·원칙 문서(읽을 수 있으면 읽는다)
  const external = [];
  for (const rs of asArray(profile.requirement_sources)) {
    if (docs.some((d) => d.path === rs.path)) continue;
    const fsPath = mapPath(rs.path);
    if (existsSync(fsPath) && statSync(fsPath).isFile()) {
      external.push(parseDocument({ path: rs.path, fs_path: relative(root, fsPath).split(sep).join("/"), role: rs.kind === "principle" ? "principle" : "requirement", canonical_for: [], reads_from: [], text: readFileSync(fsPath, "utf8") }, vocab));
    } else {
      external.push({ path: rs.path, missing: true });
    }
  }
  for (const rs of asArray(profile.requirement_sources)) {
    const d = [...docs, ...external].find((x) => x.path === rs.path && !x.missing);
    if (!d || rs.section == null) continue;
    for (const t of sourceLines(d, rs).unmatched) errors.push(`requirement_sources: "${t}" 절이 ${rs.path}에 없다`);
  }
  return { profile, errors, vocab, docs, unreadable, external, mapPath };
}
