// 스크립트(S) 추출기. 판정하지 않는다. 후보(candidate)와 표만 만든다.
// 모든 어휘·패턴은 프로파일(id_patterns·glossary·markers·script_hints·external_sources)에서 온다.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, posix } from "node:path";
import {
  asArray, durationSeconds, escapeRe, groupBy, idRegex, isoDurationSeconds, levenshtein,
  lineHasAny, looksLikeRegex, normalizeLine, truncate,
} from "./util.mjs";
import { sourceLines } from "./load.mjs";

const MAX_LIST = 200;
export const INPUT_ROLES = new Set(["source-material", "review-input"]);

export function loc(doc, line, extra = {}) {
  return { doc: doc.path, section: line.section, line: line.n, quote: truncate(line.text, 200), ...extra };
}

function* eachLine(docs, { code = true, history = true, headings = true } = {}) {
  for (const doc of docs) {
    for (const line of doc.lines) {
      if (!code && line.in_code) continue;
      if (!history && line.history) continue;
      if (!headings && line.heading) continue;
      yield [doc, line];
    }
  }
}

const stripMd = (s) => s.replace(/[*`_~]/g, "").replace(/^\s*#+\s*/, "").trim();

function cap(list, n = MAX_LIST) {
  return { total: list.length, items: list.slice(0, n), truncated: list.length > n };
}

// ---------------------------------------------------------------- ID
// id_patterns 값: 문자열·배열(일반 패턴) 또는 객체 {pattern, ref_only, defined_in}(_schema 0.1.2)
export function idPatterns(profile) {
  const out = {};
  for (const [kind, v] of Object.entries(profile.id_patterns || {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) out[kind] = { patterns: asArray(v.pattern), ref_only: !!v.ref_only, defined_in: v.defined_in || null };
    else out[kind] = { patterns: asArray(v), ref_only: false, defined_in: null };
  }
  return out;
}
export const patternsOf = (profile, kind) => idPatterns(profile)[kind]?.patterns || [];
export const allPatterns = (profile, { refOnly = true } = {}) => Object.values(idPatterns(profile)).filter((k) => refOnly || !k.ref_only).flatMap((k) => k.patterns);

export function compileIdPatterns(profile) {
  const kinds = [];
  for (const [kind, k] of Object.entries(idPatterns(profile))) {
    k.patterns.forEach((p, i) => kinds.push({ kind, index: i, pattern: p, ref_only: k.ref_only, defined_in: k.defined_in, re: idRegex(p), full: new RegExp(`^(?:${p})$`, "u") }));
  }
  return kinds;
}

// "시작-끝" → [시작, 끝]
export function parseLines(v) {
  const m = String(v || "").match(/^\s*(\d+)\s*[-–~]\s*(\d+)\s*$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

// "wait-rules 결정 5" 처럼 선택 접두어가 붙은 매치는, 패턴에 완전히 맞는 가장 짧은 꼬리를 정규 ID로 쓴다.
function normalizeId(text, full) {
  const parts = text.split(/\s+/);
  for (let i = parts.length - 1; i >= 1; i--) {
    const tail = parts.slice(i).join(" ");
    if (full.test(tail) && /\d/.test(tail)) return { id: tail, qualifier: parts.slice(0, i).join(" ") };
  }
  return { id: text.replace(/\s+/g, " "), qualifier: null };
}

function isDefinitionLine(line, id) {
  if (line.in_code) return false;
  const t = line.text;
  if (line.heading) return stripMd(t).startsWith(id);
  const tm = t.match(/^\s*\|([^|]*)\|/);
  if (tm && !/^\s*\|\s*:?-{2,}/.test(t)) return stripMd(tm[1]).startsWith(id) && stripMd(tm[1]).length <= id.length + 4;
  const lm = t.match(/^\s*(?:[-*+]|\d+\.)\s+(.*)$/);
  if (lm) {
    const body = lm[1];
    const re = new RegExp(`^(?:\\*\\*|\`)?${escapeRe(id)}(?:\\*\\*|\`)?\\s*(?:[:：.)]|\\*\\*|\\s—|\\s-\\s|$)`);
    return re.test(body);
  }
  return false;
}

export function extractIds(docs, profile) {
  const kinds = compileIdPatterns(profile);
  const mentions = [];
  for (const [doc, line] of eachLine(docs)) {
    const hits = [];
    for (const k of kinds) {
      k.re.lastIndex = 0;
      let m;
      while ((m = k.re.exec(line.text))) {
        if (!m[0].length) { k.re.lastIndex++; continue; }
        hits.push({ k, start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    // 겹치면 긴 매치를 남긴다
    hits.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    let lastEnd = -1;
    for (const h of hits) {
      if (h.start < lastEnd) continue;
      lastEnd = h.end;
      const { id, qualifier } = normalizeId(h.text, h.k.full);
      mentions.push({ id, qualifier, kind: h.k.kind, ref_only: h.k.ref_only, pattern_index: h.k.index, doc, line, def: !h.k.ref_only && isDefinitionLine(line, id) });
    }
  }

  const byId = groupBy(mentions, (m) => m.id);
  const definitions = {};
  const kindStats = {};
  const ip = idPatterns(profile);
  for (const k of kinds) kindStats[k.kind] ??= { patterns: ip[k.kind].patterns, ref_only: ip[k.kind].ref_only, defined: 0, mentioned: 0, ids: new Set() };
  for (const [id, ms] of byId) {
    const st = kindStats[ms[0].kind];
    st.ids.add(id);
    st.mentioned += ms.length;
    const defs = ms.filter((m) => m.def);
    if (defs.length) {
      st.defined += 1;
      definitions[id] = defs.map((m) => loc(m.doc, m.line, { kind: m.kind, history: m.line.history }));
    }
  }

  // 정의가 여러 문서에 있음 (BND-01·BND-04 후보)
  const duplicate_definitions = [];
  for (const [id, defs] of Object.entries(definitions)) {
    const docsSet = [...new Set(defs.map((d) => d.doc))];
    if (docsSet.length >= 2) duplicate_definitions.push({ id, kind: defs[0].kind, docs: docsSet, evidence: defs.slice(0, 6) });
  }

  // 정의 없는 참조 (BND-03·BND-04). 그 종류의 정의가 묶음 안에 하나라도 있을 때만.
  const kindsWithDefs = new Set(Object.values(definitions).flat().map((d) => d.kind));
  const undefined_references = [];
  for (const [id, ms] of byId) {
    if (ms[0].ref_only || definitions[id] || !kindsWithDefs.has(ms[0].kind)) continue;
    const live = ms.filter((m) => !m.line.history);
    if (!live.length) continue;
    undefined_references.push({ id, kind: ms[0].kind, count: live.length, evidence: live.slice(0, 6).map((m) => loc(m.doc, m.line, { qualifier: m.qualifier })) });
  }

  // ref_only 종류: 정의 없는 참조로 세지 않고, defined_in(번호 목록)에 그 번호가 있는지 본다 (BND-03·04)
  const ref_only_missing = [];
  const ref_only_checked = [];
  for (const [kind, k] of Object.entries(ip)) {
    if (!k.ref_only) continue;
    const di = k.defined_in;
    const target = di && docs.find((d) => d.path === di.path);
    const range = di && parseLines(di.lines);
    const nums = new Set();
    if (target) {
      for (const l of target.lines) {
        if (range && (l.n < range[0] || l.n > range[1])) continue;
        const m = l.text.match(/^(?:>\s*)?(\d{1,3})[.)]\s/);
        if (m) nums.add(Number(m[1]));
      }
    }
    const ms = mentions.filter((m) => m.kind === kind);
    ref_only_checked.push({ kind, defined_in: di, target_found: !!target, numbers: [...nums].sort((a, b) => a - b), mentions: ms.length });
    for (const m of ms) {
      const n = Number((m.id.match(/(\d+)\D*$/) || [])[1]);
      if (!target || !nums.has(n)) ref_only_missing.push({ id: m.id, kind, number: n, target: di?.path || null, ...loc(m.doc, m.line) });
    }
  }

  // 은퇴 ID: 정의 줄에 이력 맥락 표지가 있다(합침·삭제 등). 이력 맥락 없는 줄에서의 참조가 후보 (CON-05·BND-03)
  const retired_ids = [];
  const retired_references = [];
  for (const [id, defs] of Object.entries(definitions)) {
    if (!defs.some((d) => d.history)) continue;
    if (defs.some((d) => !d.history)) continue; // 살아 있는 정의가 따로 있으면 은퇴 아님
    retired_ids.push({ id, evidence: defs.slice(0, 3) });
    for (const m of byId.get(id)) {
      if (m.def || m.line.history) continue;
      retired_references.push({ id, ...loc(m.doc, m.line), role: m.doc.role });
    }
  }

  // 한 종류에 체계가 둘 이상이면 문서별로 어느 체계를 쓰는지 (BND-04)
  const mixed_schemes = [];
  for (const [kind, ms] of groupBy(mentions, (m) => m.kind)) {
    const pats = ip[kind].patterns;
    if (pats.length < 2) continue;
    for (const [docPath, dms] of groupBy(ms, (m) => m.doc.path)) {
      const used = groupBy(dms, (m) => m.pattern_index);
      if (used.size >= 2) {
        mixed_schemes.push({
          kind, doc: docPath,
          by_pattern: [...used.entries()].map(([i, xs]) => ({ pattern: pats[i], count: xs.length, sample: loc(xs[0].doc, xs[0].line) })),
        });
      }
    }
  }

  const kinds_summary = Object.fromEntries(Object.entries(kindStats).map(([k, v]) => [k, { patterns: v.patterns, ref_only: v.ref_only, distinct_ids: v.ids.size, defined_ids: v.defined, mentions: v.mentioned }]));
  return { mentions, definitions, kinds_summary, duplicate_definitions, undefined_references, ref_only_checked, ref_only_missing, retired_ids, retired_references, mixed_schemes };
}

// 한 문서 안의 번호 체계: "<라벨> N" 제목 줄 묶음과 번호 목록. 둘이 겹치면 BND-04 후보. 라벨 인용은 어느 쪽인지 분류.
export function extractNumbering(docs) {
  const perDoc = [];
  for (const doc of docs) {
    if (!doc.is_md) continue;
    const headingSeq = new Map(); // label → [{n, line}]
    const lists = [];
    let run = null;
    for (const line of doc.lines) {
      if (line.in_code) { run = null; continue; }
      if (line.heading) {
        const m = stripMd(line.text).match(/^(\p{L}{1,12}?)\s+(\d{1,3})(?:[.)]|\s|$)/u);
        if (m) {
          if (!headingSeq.has(m[1])) headingSeq.set(m[1], []);
          headingSeq.get(m[1]).push({ n: Number(m[2]), line: line.n });
        }
        run = null;
        continue;
      }
      const lm = line.text.match(/^(?:>\s*)?(\d{1,3})\.\s+\S/);
      if (lm) {
        if (!run) { run = { section: line.section, start: line.n, numbers: [] }; lists.push(run); }
        run.numbers.push(Number(lm[1]));
      } else if (line.text.trim() !== "" && !/^\s{2,}|^>\s*$|^\s*[-*]/.test(line.text)) {
        run = null;
      }
    }
    const seqs = [...headingSeq.entries()].filter(([, xs]) => xs.length >= 3).map(([label, xs]) => ({ label, numbers: xs.map((x) => x.n), lines: xs.map((x) => x.line) }));
    const longLists = lists.filter((l) => l.numbers.length >= 3);
    if (seqs.length) perDoc.push({ doc, seqs, lists: longLists });
  }

  const dual = [];
  const labelRefs = [];
  // 라벨별로 제목 번호 체계를 가진 문서가 하나일 때만 인용을 분류한다
  const byLabel = groupBy(perDoc.flatMap((p) => p.seqs.map((s) => ({ ...s, doc: p.doc, lists: p.lists }))), (s) => s.label);
  for (const [label, entries] of byLabel) {
    if (entries.length !== 1) continue;
    const e = entries[0];
    const headingNums = new Set(e.numbers);
    const listNums = new Set(e.lists.flatMap((l) => l.numbers));
    const overlap = [...headingNums].filter((n) => listNums.has(n));
    if (e.lists.length && overlap.length) {
      dual.push({
        doc: e.doc.path, label,
        heading_numbers: [...headingNums].sort((a, b) => a - b),
        list_numbers: [...listNums].sort((a, b) => a - b),
        lists: e.lists.map((l) => ({ section: l.section, line: l.start, count: l.numbers.length })),
      });
    }
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(label)}\\s*(\\d{1,3})(?!\\d)`, "gu");
    for (const doc of docs) {
      for (const line of doc.lines) {
        // 번호 인용은 이력 맥락 줄에서도 센다(옛 이름 잔존 검사와 달리 "어느 체계를 뜻했나"는 이력 서술에도 걸린다)
        if (doc.path === e.doc.path && line.heading) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(line.text))) {
          const n = Number(m[1]);
          const inH = headingNums.has(n);
          const inL = listNums.has(n);
          const cls = inH && inL ? "ambiguous" : inH ? "heading-only" : inL ? "list-only" : "undefined";
          if (cls === "heading-only") continue;
          labelRefs.push({ label, number: n, class: cls, target_doc: e.doc.path, ...loc(doc, line) });
        }
      }
    }
  }
  return { dual_numbering: dual, label_references: labelRefs };
}

// ID 범위 표기(X1~X38)와 실제 정의 비교 (CON-07)
export function extractRanges(docs, ids) {
  const out = [];
  const defined = Object.keys(ids.definitions);
  const famOf = (id) => {
    const m = id.match(/^(.*?)(\d+)([a-z]?)$/);
    return m ? { prefix: m[1], n: Number(m[2]), width: m[2].length } : null;
  };
  const families = groupBy(defined.map((id) => ({ id, f: famOf(id) })).filter((x) => x.f), (x) => x.f.prefix);
  const re = /(?<![A-Za-z0-9-])([A-Za-z][A-Za-z-]{0,6}?)(\d{1,4})\s*[~–]\s*(?:\1)?(\d{1,4})(?!\d)/g;
  for (const [doc, line] of eachLine(docs, { code: false, history: false })) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line.text))) {
      const prefix = m[1];
      const fam = families.get(prefix);
      if (!fam) continue;
      const lo = Number(m[2]);
      const hi = Number(m[3]);
      if (hi <= lo) continue;
      const nums = fam.map((x) => x.f.n);
      const max = Math.max(...nums);
      const inRange = new Set(nums.filter((n) => n >= lo && n <= hi));
      const missing = [];
      for (let n = lo; n <= hi && missing.length < 20; n++) if (!inRange.has(n)) missing.push(n);
      if (hi > max || missing.length) {
        const w = fam[0].f.width;
        out.push({ range: m[0], prefix, low: lo, high: hi, defined_max: `${prefix}${String(max).padStart(w, "0")}`, missing_in_range: missing, ...loc(doc, line) });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- 참조 (BND-03)
function slugify(h) {
  return stripMd(h).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").trim().replace(/\s/g, "-");
}

export function extractReferences(docs, vocab, { mapPath, root, roots = [] }) {
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const anchorCache = new Map();
  const anchorsOf = (doc) => {
    if (anchorCache.has(doc.path)) return anchorCache.get(doc.path);
    const s = new Set();
    const counts = new Map();
    for (const l of doc.lines) {
      if (!l.heading) continue;
      const base = slugify(l.text);
      const c = counts.get(base) || 0;
      counts.set(base, c + 1);
      s.add(c ? `${base}-${c}` : base);
    }
    anchorCache.set(doc.path, s);
    return s;
  };
  const lineCountOf = (logical) => {
    const d = byPath.get(logical);
    if (d) return d.line_count;
    const fs = mapPath(logical);
    if (existsSync(fs) && statSync(fs).isFile()) return readFileSync(fs, "utf8").split(/\r?\n/).length;
    return null;
  };
  const resolveLogical = (fromDoc, target) => {
    const cands = [];
    const dir = posix.dirname(fromDoc.path);
    cands.push(posix.normalize(posix.join(dir, target)));
    for (const r of roots) cands.push(posix.normalize(posix.join(r, target)));
    cands.push(posix.normalize(target));
    // 묶음 안 파일 이름 끝 일치(경로 일부만 적은 경우)
    for (const c of cands) {
      if (byPath.has(c)) return c;
      const fs = mapPath(c);
      if (existsSync(fs)) return c;
    }
    const tail = [...byPath.keys()].filter((p) => p.endsWith("/" + target) || p === target);
    if (tail.length === 1) return tail[0];
    return null;
  };

  const broken_links = [];
  const broken_anchors = [];
  const line_refs_out_of_range = [];
  const unresolved_paths = [];
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const pathRe = /(?<![\w/.-])((?:\.{1,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.(?:md|sql|graphql|toml|java|json|ya?ml|mjs|js|ts|kt|py|txt))(?::(\d+)(?:-(\d+))?)?/g;
  for (const [doc, line] of eachLine(docs, { code: false })) {
    linkRe.lastIndex = 0;
    let m;
    const linkSpans = [];
    while ((m = linkRe.exec(line.text))) {
      linkSpans.push([m.index, m.index + m[0].length]);
      const href = m[2];
      if (/^(https?:|mailto:)/.test(href)) continue;
      const [p, anchor] = href.split("#");
      let targetDoc = doc;
      if (p) {
        const lg = resolveLogical(doc, decodeURI(p));
        if (!lg) { broken_links.push({ target: href, ...loc(doc, line) }); continue; }
        targetDoc = byPath.get(lg);
      }
      if (anchor && targetDoc && targetDoc.is_md && !anchorsOf(targetDoc).has(decodeURIComponent(anchor).toLowerCase())) {
        broken_anchors.push({ target: href, ...loc(doc, line) });
      }
    }
    pathRe.lastIndex = 0;
    while ((m = pathRe.exec(line.text))) {
      if (linkSpans.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if (/^https?:/.test(line.text.slice(Math.max(0, m.index - 8), m.index))) continue;
      const target = m[1];
      if (!target.includes("/") && !m[2] && !target.endsWith(".md")) continue; // 확장자 붙은 단어 노이즈 줄이기
      const lg = resolveLogical(doc, target);
      if (!lg) { unresolved_paths.push({ target: m[0], ...loc(doc, line) }); continue; }
      if (m[2]) {
        const n = lineCountOf(lg);
        const hi = Number(m[3] || m[2]);
        if (n != null && hi > n) line_refs_out_of_range.push({ target: m[0], resolved: lg, target_lines: n, ...loc(doc, line) });
      }
    }
  }

  // 시간 표현 문장 (낡은 진행 상태 문장 후보, BND-03·C06)
  const time_statements = [];
  for (const [doc, line] of eachLine(docs, { code: false, history: false, headings: false })) {
    const w = vocab.time_words.find((t) => line.text.includes(t));
    if (w) time_statements.push({ word: w, ...loc(doc, line) });
  }
  return {
    broken_links, broken_anchors, line_refs_out_of_range,
    unresolved_paths: cap(unresolved_paths),
    time_statements: cap(time_statements),
  };
}

// ---------------------------------------------------------------- 수치 (CON-02·EVD-05·FLR-03)
const FILLER = new Set(["약", "about", "around", "~", "총", "최소", "최장", "approx", "approximately", "="]);
const DEFAULT_UNITS = ["초", "분", "시간", "일", "ms", "s", "sec", "min", "h", "hours", "minutes", "seconds", "days"];

function sourceNearby(doc, line, vocab, decisionRes) {
  const idx = line.n - 1;
  const near = [doc.lines[idx - 1], line, doc.lines[idx + 1]].filter(Boolean).map((l) => l.text).join(" \n ");
  if (/https?:\/\/|\]\(|\[[A-Z]{1,4}#?\d+\]/.test(near)) return "link";
  if (lineHasAny(near, [...vocab.unverified, ...vocab.inferred, ...vocab.statement])) return "marker";
  if (lineHasAny(near, vocab.source_markers)) return "source-word";
  if (decisionRes.some((re) => { re.lastIndex = 0; return re.test(near); })) return "decision-id";
  return null;
}

export function extractNumbers(docs, profile, vocab) {
  const literal = [];
  const regexUnits = [];
  for (const u of vocab.number_units.length ? vocab.number_units : DEFAULT_UNITS) {
    if (looksLikeRegex(u)) regexUnits.push(new RegExp(`(?<![A-Za-z0-9])${u}(?![A-Za-z0-9])`, "g"));
    else literal.push(u);
  }
  literal.sort((a, b) => b.length - a.length);
  const numRe = literal.length ? new RegExp(`(?<![\\w.\\-/:])(\\d+(?:\\.\\d+)?)\\s?(${literal.map(escapeRe).join("|")})(?![A-Za-z])`, "gu") : null;
  const decisionRes = patternsOf(profile, "decision").map((p) => idRegex(p));
  const designRoles = new Set(["spec", "plan", "data-model", "contract", "verification", "tasks", "scenarios"]);

  const mentions = [];
  for (const [doc, line] of eachLine(docs, { headings: true })) {
    const found = [];
    if (numRe) {
      numRe.lastIndex = 0;
      let m;
      while ((m = numRe.exec(line.text))) {
        const sec = durationSeconds(m[1], m[2]);
        found.push({ raw: m[0], value: Number(m[1]), unit: m[2], seconds: sec, index: m.index });
      }
    }
    for (const re of regexUnits) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line.text))) found.push({ raw: m[0], value: null, unit: "iso", seconds: isoDurationSeconds(m[0]), index: m.index });
    }
    for (const f of found) {
      const before = line.text.slice(0, f.index).replace(/[`*|(),:]/g, " ").trim().split(/\s+/).filter((t) => t && !FILLER.has(t));
      const lastTok = before.length ? before[before.length - 1] : "";
      const key = /[.!?。]$/.test(lastTok) || !/\p{L}/u.test(lastTok) ? "" : lastTok.replace(/[^\p{L}\p{N}_-]+$/u, "").replace(/(은|는|이|가|을|를|의|에|도)$/u, "");
      mentions.push({ ...f, context_key: key, doc, line });
    }
  }

  // 설정 키 = 값 (키에 . 또는 - 가 있어야 설정으로 본다)
  const configs = [];
  for (const [doc, line] of eachLine(docs)) {
    for (const p of configPairs(line)) {
      configs.push({ key: p.key, value: p.value, seconds: isoDurationSeconds(p.value), doc, line });
    }
  }
  const config_conflicts = [];
  for (const [key, xs] of groupBy(configs.filter((c) => !c.line.history), (c) => c.key)) {
    const vals = groupBy(xs, (c) => (c.seconds != null ? `${c.seconds}s` : c.value));
    if (vals.size >= 2) {
      config_conflicts.push({ key, values: [...vals.entries()].map(([v, ys]) => ({ value: ys[0].value, normalized: v, evidence: ys.slice(0, 4).map((y) => loc(y.doc, y.line)) })) });
    }
  }
  const timingRe = new RegExp(vocab.timing_keys.map(escapeRe).join("|"), "i");
  const timing_settings = [];
  for (const [key, xs] of groupBy(configs, (c) => c.key)) {
    if (!timingRe.test(key)) continue;
    timing_settings.push({ key, values: [...new Set(xs.map((x) => x.value))], evidence: xs.slice(0, 4).map((y) => loc(y.doc, y.line, { history: y.line.history })) });
  }

  // 프로파일 parameters.compare_keys: 설정 값과 프로파일 값을 relation(gte·lte·eq)으로 대조 (EVD-05·FLR-03·QAS-02 후보)
  const parameter_checks = [];
  for (const [name, prm] of Object.entries(profile.parameters || {})) {
    if (!prm || !asArray(prm.compare_keys).length) continue;
    const want = typeof prm.value === "number" ? durationSeconds(prm.value, String(prm.unit || "").trim()) : null;
    for (const key of asArray(prm.compare_keys)) {
      const hits = configs.filter((c) => c.key === key && !c.line.history);
      if (!hits.length) { parameter_checks.push({ parameter: name, key, relation: prm.relation || null, status: "key-not-found", expected: `${prm.value} ${prm.unit || ""}`.trim() }); continue; }
      for (const c of hits) {
        let status;
        if (want == null || c.seconds == null) status = "cannot-compare";
        else if (!prm.relation) status = "no-relation";
        else {
          const ok = prm.relation === "gte" ? c.seconds >= want : prm.relation === "lte" ? c.seconds <= want : c.seconds === want;
          status = ok ? "ok" : "violated";
        }
        parameter_checks.push({ parameter: name, key, relation: prm.relation || null, status, value: c.value, value_seconds: c.seconds, expected: `${prm.value} ${prm.unit || ""}`.trim(), expected_seconds: want, timing: timingRe.test(key), source: prm.source || null, ...loc(c.doc, c.line) });
      }
    }
  }

  // 같은 맥락어 앞에서 값이 문서마다 다름 (CON-02 후보). 이력 맥락 제외.
  const value_groups = [];
  // 설정 키 앞의 값은 config_conflicts가 맡는다
  const live = mentions.filter((m) => !m.line.history && m.seconds != null && m.context_key && !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/.test(m.context_key));
  for (const [key, xs] of groupBy(live, (m) => m.context_key)) {
    const byVal = groupBy(xs, (m) => m.seconds);
    const docsSet = new Set(xs.map((x) => x.doc.path));
    if (byVal.size < 2 || docsSet.size < 2) continue;
    // 값마다 문서가 다르게 갈리는 경우만
    const valueDocs = [...byVal.entries()].map(([sec, ys]) => ({ seconds: Number(sec), raw: [...new Set(ys.map((y) => y.raw))], docs: [...new Set(ys.map((y) => y.doc.path))], evidence: ys.slice(0, 4).map((y) => loc(y.doc, y.line)) }));
    value_groups.push({ context_key: key, distinct_values: byVal.size, docs: docsSet.size, values: valueDocs });
  }
  value_groups.sort((a, b) => b.docs - a.docs || b.distinct_values - a.distinct_values);

  // 근거 표지 없는 수치 (EVD-05 후보). 설계 문서 역할만, 코드 블록·이력 제외.
  const unsourced = [];
  for (const m of mentions) {
    if (m.line.history || m.line.in_code || m.line.heading) continue;
    if (!designRoles.has(m.doc.role)) continue;
    const src = sourceNearby(m.doc, m.line, vocab, decisionRes);
    if (!src) unsourced.push({ value: m.raw, ...loc(m.doc, m.line) });
  }
  const dedup = [...new Map(unsourced.map((u) => [`${u.doc}:${u.line}`, u])).values()];

  return {
    mention_count: mentions.length,
    config_conflicts,
    timing_settings,
    parameter_checks,
    value_groups: cap(value_groups, 60),
    unsourced_numbers: cap(dedup),
    profile_parameters: profile.parameters || {},
  };
}

// 설정 키 = 값. 코드 블록 줄은 줄 머리의 "key: value"·"key = value", 본문은 코드 스팬 안의 같은 형태만 본다.
// 키에 . 또는 - 가 있어야 하고 버전 표기·파일 이름은 뺀다.
const CFG_FULL = /^\s*["']?([a-z][a-z0-9]*(?:[.-][a-z0-9]+)+)["']?\s*(?::\s+|\s*=\s*)["'`]?([A-Za-z0-9.+\-_/]+)["'`]?\s*(?:#.*|\/\/.*|,)?$/;
export function configPairs(line) {
  const out = [];
  const take = (s) => {
    const m = s.match(CFG_FULL);
    if (!m) return;
    if (/^v\d/.test(m[1]) || /\.(md|sql|graphql|toml|java|json|ya?ml|mjs|js|ts|liquid|html|css)$/.test(m[1])) return;
    if (/^\d{4}-\d{2}-\d{2}/.test(m[2])) return;
    out.push({ key: m[1], value: m[2] });
  };
  if (line.in_code) take(line.text);
  else for (const m of line.text.matchAll(/`([^`]+)`/g)) take(m[1]);
  return out;
}

// ---------------------------------------------------------------- 용어 (CON-01·CON-03·CON-04·CON-05)
function wordRegex(w) {
  const edge = /^[A-Za-z0-9_]/.test(w) ? "(?<![A-Za-z0-9_])" : "";
  const tail = /[A-Za-z0-9_]$/.test(w) ? "(?![A-Za-z0-9_])" : "";
  return new RegExp(`${edge}${escapeRe(w)}${tail}`, "u");
}

export function extractTerms(docs, profile, vocab) {
  const g = profile.glossary || {};
  const retiredWords = [];
  const forbiddenWords = [];
  for (const t of asArray(g.terms)) {
    for (const r of asArray(t.retired)) retiredWords.push({ word: r, canonical: t.term });
    for (const f of asArray(t.forbidden)) forbiddenWords.push({ word: f, canonical: t.term });
  }
  for (const [k, v] of Object.entries(g)) {
    if (k !== "terms" && /^retired/.test(k)) for (const w of asArray(v)) retiredWords.push({ word: w, canonical: null });
  }
  const scan = (words) => {
    const live = [];
    let historyCount = 0;
    for (const w of words) {
      const re = wordRegex(w.word);
      for (const [doc, line] of eachLine(docs)) {
        if (!re.test(line.text)) continue;
        if (line.history) { historyCount++; continue; }
        live.push({ term: w.word, canonical: w.canonical, role: doc.role, ...loc(doc, line) });
      }
    }
    return { live, historyCount };
  };
  const retired = scan(retiredWords);
  const forbidden = scan(forbiddenWords);

  // 대문자 식별자 변형 쌍 (철자 변형·접미어)
  const stateRe = new RegExp(vocab.state_name_pattern, "gu");
  const idents = new Map(); // name → {docs:Set, count}
  const transitions = [];
  const arrowRe = new RegExp(`(${vocab.state_name_pattern.replace(/\\b/g, "")})\\s*(?:→|->|=>)\\s*(${vocab.state_name_pattern.replace(/\\b/g, "")})`, "gu");
  for (const [doc, line] of eachLine(docs)) {
    stateRe.lastIndex = 0;
    let m;
    while ((m = stateRe.exec(line.text))) {
      const e = idents.get(m[0]) || { docs: new Set(), count: 0 };
      e.docs.add(doc.path);
      e.count++;
      idents.set(m[0], e);
    }
    if (line.history) continue;
    arrowRe.lastIndex = 0;
    while ((m = arrowRe.exec(line.text))) transitions.push({ from: m[1], to: m[2], doc, line });
  }
  const names = [...idents.keys()].filter((n) => n.length >= 5);
  const variants = [];
  const retiredSet = new Set(retiredWords.map((w) => w.word));
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (retiredSet.has(a) || retiredSet.has(b)) continue;
      const d = levenshtein(a, b, 2);
      const affix = (a.startsWith(b + "_") || b.startsWith(a + "_") || a.endsWith("_" + b) || b.endsWith("_" + a));
      if ((d <= 2 && Math.min(a.length, b.length) >= 7) || affix) {
        variants.push({ a, b, distance: d, a_docs: [...idents.get(a).docs], b_docs: [...idents.get(b).docs], a_count: idents.get(a).count, b_count: idents.get(b).count });
      }
    }
  }
  variants.sort((x, y) => x.distance - y.distance);

  // 전이 집합: 정본 = script_hints.transitions_canonical 또는 전이가 가장 많은 문서
  const byDoc = groupBy(transitions, (t) => t.doc.path);
  let canonical = profile.script_hints?.transitions_canonical || null;
  if (!canonical && byDoc.size) {
    const rank = (r) => { const i = ["data-model", "plan", "spec", "contract"].indexOf(r); return i < 0 ? (INPUT_ROLES.has(r) ? 9 : 5) : i; };
    const ranked = [...byDoc.entries()].sort((a, b) => rank(a[1][0].doc.role) - rank(b[1][0].doc.role) || b[1].length - a[1].length);
    canonical = ranked[0][0];
  }
  const canonSet = new Set((byDoc.get(canonical) || []).map((t) => `${t.from}→${t.to}`));
  const transitions_not_in_canonical = [];
  for (const [p, ts] of byDoc) {
    if (p === canonical) continue;
    for (const t of ts) {
      const k = `${t.from}→${t.to}`;
      if (!canonSet.has(k)) transitions_not_in_canonical.push({ transition: k, ...loc(t.doc, t.line) });
    }
  }

  // 필드(snake_case) 정합: data-model 역할 문서 대 나머지
  const fieldRe = /(?<![A-Za-z0-9_])([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?![A-Za-z0-9_])/g;
  const defined = new Map();
  const used = new Map();
  for (const [doc, line] of eachLine(docs, { history: false })) {
    const isCodeish = line.in_code || line.text.includes("`") || /\.(sql|graphql|java|toml)/.test(doc.path);
    if (!isCodeish) continue;
    const target = doc.role === "data-model" ? defined : ["contract", "tasks", "plan", "verification"].includes(doc.role) ? used : null;
    if (!target) continue;
    fieldRe.lastIndex = 0;
    let m;
    while ((m = fieldRe.exec(line.text))) {
      if (m[1].length < 4) continue;
      if (!target.has(m[1])) target.set(m[1], loc(doc, line));
    }
  }
  const hasDataModel = docs.some((d) => d.role === "data-model");
  const fields = hasDataModel ? {
    used_not_defined: [...used.entries()].filter(([k]) => !defined.has(k)).map(([field, l]) => ({ field, ...l })),
    defined_not_used: [...defined.entries()].filter(([k]) => !used.has(k)).map(([field, l]) => ({ field, ...l })),
  } : null;

  return {
    retired_live: retired.live,
    retired_history_count: retired.historyCount,
    forbidden_live: forbidden.live,
    identifier_variants: cap(variants, 60),
    transitions: { canonical, count: transitions.length, not_in_canonical: cap(transitions_not_in_canonical, 100) },
    fields: fields && { used_not_defined: cap(fields.used_not_defined, 100), defined_not_used: cap(fields.defined_not_used, 100) },
  };
}

// ---------------------------------------------------------------- 중복 블록 (BND-01)
export function extractDuplicates(docs) {
  const headers = [];
  for (const doc of docs) {
    doc.lines.forEach((l, i) => {
      const next = doc.lines[i + 1];
      if (!l.in_code && /^\s*\|/.test(l.text) && next && /^\s*\|\s*:?-{2,}/.test(next.text)) {
        headers.push({ key: normalizeLine(l.text).replace(/\s*\|\s*/g, "|"), doc, line: l });
      }
    });
  }
  const dupHeaders = [];
  for (const [key, xs] of groupBy(headers, (h) => h.key)) {
    const ds = new Set(xs.map((x) => x.doc.path));
    if (ds.size >= 2 && key.split("|").filter(Boolean).length >= 3) dupHeaders.push({ header: truncate(xs[0].line.text, 160), docs: [...ds], evidence: xs.slice(0, 6).map((x) => loc(x.doc, x.line)) });
  }

  const lineMap = new Map();
  for (const [doc, line] of eachLine(docs, { headings: false })) {
    if (/^\s*\|\s*:?-{2,}/.test(line.text)) continue;
    const k = normalizeLine(line.text);
    if (k.length < 40) continue;
    if (!lineMap.has(k)) lineMap.set(k, []);
    lineMap.get(k).push({ doc, line });
  }
  const dupLines = [];
  for (const xs of lineMap.values()) {
    const ds = new Set(xs.map((x) => x.doc.path));
    if (ds.size >= 2) dupLines.push({ docs: [...ds], evidence: xs.slice(0, 4).map((x) => loc(x.doc, x.line)) });
  }

  // 문단 유사도(단어 2-gram Jaccard). 희귀 2-gram 역색인으로 후보 쌍만 비교한다.
  const paras = [];
  for (const doc of docs) {
    let buf = [];
    const flush = () => {
      const text = buf.map((l) => l.text).join(" ");
      if (text.length >= 80) {
        const toks = normalizeLine(text).split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);
        const grams = new Set();
        for (let i = 0; i + 1 < toks.length; i++) grams.add(toks[i] + " " + toks[i + 1]);
        if (grams.size >= 8) paras.push({ doc, first: buf[0], grams });
      }
      buf = [];
    };
    for (const l of doc.lines) {
      if (l.in_code || l.heading || l.text.trim() === "") { flush(); continue; }
      buf.push(l);
    }
    flush();
  }
  const df = new Map();
  for (const p of paras) for (const g of p.grams) df.set(g, (df.get(g) || 0) + 1);
  const index = new Map();
  paras.forEach((p, i) => {
    for (const g of p.grams) {
      const c = df.get(g);
      if (c >= 2 && c <= 6) { if (!index.has(g)) index.set(g, []); index.get(g).push(i); }
    }
  });
  const seen = new Set();
  const similar = [];
  for (const ids of index.values()) {
    for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
      const i = ids[a], j = ids[b];
      if (paras[i].doc.path === paras[j].doc.path) continue;
      const key = `${i}:${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let inter = 0;
      for (const g of paras[i].grams) if (paras[j].grams.has(g)) inter++;
      const jac = inter / (paras[i].grams.size + paras[j].grams.size - inter);
      if (jac >= 0.5) similar.push({ jaccard: Number(jac.toFixed(2)), evidence: [loc(paras[i].doc, paras[i].first), loc(paras[j].doc, paras[j].first)] });
    }
  }
  similar.sort((a, b) => b.jaccard - a.jaccard);
  return { table_headers: cap(dupHeaders, 60), lines: cap(dupLines, 60), similar_paragraphs: cap(similar, 40) };
}

// ---------------------------------------------------------------- 자리표시 (REQ-02, S 단독)
// 낱말을 언급만 하는 경우(따옴표·백틱 안, 뒤에 "라는·이라는" 같은 인용 조사)는 자리표시로 보지 않는다.
const QUOTE_OPEN = `"'“‘「『\``;
const QUOTE_CLOSE = `"'”’」』\``;
const MENTION_AFTER = /^\s*(?:이라는|라는|라고|란|이란|표시|표기|낱말|단어|문구)/u;
export function usedAsPlaceholder(text, token) {
  const re = new RegExp(wordRegex(token).source, "gu");
  let m;
  while ((m = re.exec(text))) {
    const before = text[m.index - 1] || "";
    const after = text[m.index + m[0].length] || "";
    const rest = text.slice(m.index + m[0].length);
    if (QUOTE_OPEN.includes(before) && QUOTE_CLOSE.includes(after)) continue;
    if (MENTION_AFTER.test(rest)) continue;
    return true;
  }
  return false;
}

export function extractPlaceholders(docs, profile, vocab) {
  const decisionRes = patternsOf(profile, "decision").map((p) => idRegex(p));
  const anyIdRes = allPatterns(profile).map((p) => idRegex(p));
  const out = [];
  for (const [doc, line] of eachLine(docs, { history: false })) {
    if (INPUT_ROLES.has(doc.role)) continue; // 원자료·점검 보고서는 요구 문서가 아니다
    const tok = vocab.placeholder.find((t) => usedAsPlaceholder(line.text, t));
    if (!tok) continue;
    const sectionLines = doc.lines.filter((l) => l.section === line.section).map((l) => l.text).join("\n");
    const has_owner = lineHasAny(line.text, vocab.owner_words);
    const has_due = /\d{4}-\d{2}-\d{2}|\b\d{1,2}\/\d{1,2}\b/.test(line.text);
    const has_decision = decisionRes.some((re) => { re.lastIndex = 0; return re.test(line.text); });
    const section_has_decision = decisionRes.some((re) => { re.lastIndex = 0; return re.test(sectionLines); });
    const has_any_id = anyIdRes.some((re) => { re.lastIndex = 0; return re.test(line.text); });
    out.push({ token: tok, role: doc.role, has_owner, has_due, has_decision, section_has_decision, has_any_id, ...loc(doc, line) });
  }
  return out;
}

// ---------------------------------------------------------------- 기준 시점 (BND-02) · 머리말 정합 (CON-07)
export function extractBaselines(docs, profile, vocab) {
  const commitRe = new RegExp(vocab.commit_pattern, "g");
  const commits = [];
  for (const [doc, line] of eachLine(docs)) {
    commitRe.lastIndex = 0;
    let m;
    while ((m = commitRe.exec(line.text))) {
      const v = m[0];
      if (!/\d/.test(v) || !/[a-f]/.test(v)) continue;
      const pre = line.text.slice(Math.max(0, m.index - 30), m.index);
      if (/https?:\/\/\S*$/.test(pre) || /[#-]$/.test(pre)) continue;
      commits.push({ value: v, doc, line });
    }
  }
  const baselineCommits = asArray(profile.baseline).map((b) => b.commit).filter(Boolean);
  const matchesBaseline = (v) => baselineCommits.some((b) => b.startsWith(v) || v.startsWith(b));
  const commit_values = [...groupBy(commits, (c) => c.value).entries()].map(([value, xs]) => ({
    value, matches_baseline: baselineCommits.length ? matchesBaseline(value) : null, count: xs.length,
    evidence: xs.slice(0, 4).map((x) => loc(x.doc, x.line, { history: x.line.history })),
  }));
  const off_baseline = baselineCommits.length ? commit_values.filter((c) => !c.matches_baseline) : [];

  const verRe = /(?<![\w.])v(\d+(?:\.\d+){1,3})(?![\w.]*\d)/g;
  const dateRe = /\b(20\d{2}-\d{2}-\d{2})\b/g;
  const cmpVer = (a, b) => {
    const x = a.split(".").map(Number), y = b.split(".").map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  };
  const header_mismatch = [];
  const doc_versions = [];
  for (const doc of docs) {
    const head = doc.lines.slice(0, 15);
    let hv = null, hd = null;
    for (const l of head) {
      verRe.lastIndex = 0;
      const vm = verRe.exec(l.text);
      if (vm && !hv) hv = { v: vm[1], line: l };
      dateRe.lastIndex = 0;
      const dm = dateRe.exec(l.text);
      if (dm && !hd) hd = { d: dm[1], line: l };
    }
    let maxV = null, maxD = null;
    for (const l of doc.lines) {
      verRe.lastIndex = 0;
      let m;
      while ((m = verRe.exec(l.text))) if (!maxV || cmpVer(m[1], maxV.v) > 0) maxV = { v: m[1], line: l };
      dateRe.lastIndex = 0;
      while ((m = dateRe.exec(l.text))) if (!maxD || m[1] > maxD.d) maxD = { d: m[1], line: l };
    }
    doc_versions.push({ doc: doc.path, header_version: hv?.v || null, max_version: maxV?.v || null, header_date: hd?.d || null, max_date: maxD?.d || null });
    if (hv) {
      maxV = null;
      for (const l of doc.lines) {
        verRe.lastIndex = 0;
        let m;
        while ((m = verRe.exec(l.text))) if (m[1].split(".")[0] === hv.v.split(".")[0] && (!maxV || cmpVer(m[1], maxV.v) > 0)) maxV = { v: m[1], line: l };
      }
    }
    if (hv && maxV && cmpVer(maxV.v, hv.v) > 0) header_mismatch.push({ kind: "version", header: hv.v, later: maxV.v, evidence: [loc(doc, hv.line), loc(doc, maxV.line)] });
    if (hd && maxD && maxD.d > hd.d) header_mismatch.push({ kind: "date", header: hd.d, later: maxD.d, evidence: [loc(doc, hd.line), loc(doc, maxD.line)] });
  }
  return { baseline: profile.baseline || [], commit_values, off_baseline, doc_versions, header_mismatch };
}

// ---------------------------------------------------------------- 결정 상태 (DEC-04)
export function extractDecisions(ids, docs, profile, vocab) {
  const kinds = new Set(asArray(profile.script_hints?.decision_kinds || "decision"));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const out = [];
  for (const [id, defs] of Object.entries(ids.definitions)) {
    if (!kinds.has(defs[0].kind)) continue;
    for (const d of defs) {
      const doc = byPath.get(d.doc);
      const ctx = doc.lines.slice(d.line - 1, d.line + 3).map((l) => l.text).join(" ");
      const status = vocab.status_words.filter((w) => ctx.includes(w));
      out.push({ id, status_words: status, has_status: status.length > 0, ...d });
    }
  }
  const supersede = [];
  for (const m of ids.mentions) {
    if (!kinds.has(m.kind) || m.line.history) continue;
    if (lineHasAny(m.line.text, vocab.supersede_words)) supersede.push({ id: m.id, ...loc(m.doc, m.line) });
  }
  return { definitions: out, without_status: out.filter((x) => !x.has_status), supersede_mentions: cap(supersede, 80) };
}

// ---------------------------------------------------------------- 추적 (TRC-01·02·03)
export function extractTrace(ids, docs, profile, vocab, externalDocs = []) {
  const reqKinds = new Set(asArray(profile.script_hints?.requirement_kinds || ["requirement", "user-story", "success-criterion"]));
  const roleBucket = { plan: "design", "data-model": "design", contract: "design", tasks: "tasks", verification: "verification", scenarios: "scenarios" };
  const coverage = [];
  const byId = groupBy(ids.mentions, (m) => m.id);
  for (const [id, defs] of Object.entries(ids.definitions)) {
    if (!reqKinds.has(defs[0].kind)) continue;
    const ms = byId.get(id) || [];
    const c = { id, kind: defs[0].kind, defined_in: [...new Set(defs.map((d) => d.doc))], design: 0, tasks: 0, verification: 0, scenarios: 0 };
    for (const m of ms) {
      if (m.def) continue;
      const b = roleBucket[m.doc.role];
      if (b) c[b] += 1;
    }
    coverage.push(c);
  }
  const hasRole = (r) => docs.some((d) => d.role === r);

  // 원 요구 출처 절에서 ID를 모으고, 그 밖에서 인용 0건인 것을 낸다
  const sources = asArray(profile.requirement_sources);
  const kinds = compileIdPatterns(profile);
  const source_ids = [];
  const all = [...docs, ...externalDocs.filter((d) => !d.missing)];
  for (const s of sources) {
    const doc = all.find((d) => d.path === s.path);
    if (!doc) { source_ids.push({ source: s.path, missing: true }); continue; }
    const sl = sourceLines(doc, s);
    if (sl.unmatched.length && !sl.lines.length) {
      source_ids.push({ source: s.path, section: s.section, lines: s.lines || null, unmatched: sl.unmatched, ids: [] });
      continue;
    }
    const lines = sl.lines;
    const found = new Set();
    for (const l of lines) for (const k of kinds) { k.re.lastIndex = 0; let m; while ((m = k.re.exec(l.text))) found.add(normalizeId(m[0], k.full).id); }
    source_ids.push({ source: s.path, section: s.section ?? "(문서 전체)", lines: s.lines || null, matched_sections: sl.sections ? sl.sections.length : "(문서 전체)", unmatched: sl.unmatched.length ? sl.unmatched : undefined, ids: [...found] });
  }
  const sourcePaths = new Set(sources.map((s) => s.path));
  const uncited_source_ids = [];
  for (const s of source_ids) {
    for (const id of s.ids || []) {
      const outside = (byId.get(id) || []).filter((m) => !sourcePaths.has(m.doc.path));
      if (!outside.length) uncited_source_ids.push({ id, source: s.source });
    }
  }

  // 설계 요소(설정 키·상태 이름·작업 ID) 중 정의 절에 요구·결정 ID 인용이 없는 것 (TRC-03 후보)
  const citeKinds = kinds.filter((k) => reqKinds.has(k.kind) || k.kind === "decision");
  const designRoles = new Set(["plan", "data-model", "contract"]);
  const elements = new Map();
  const stateRe = new RegExp(vocab.state_name_pattern, "gu");
  for (const doc of docs) {
    if (!designRoles.has(doc.role)) continue;
    for (const line of doc.lines) {
      if (line.history) continue;
      const add = (name, type) => { if (!elements.has(name)) elements.set(name, { name, type, doc, line }); };
      for (const p of configPairs(line)) add(p.key, "setting");
      let m;
      stateRe.lastIndex = 0;
      while ((m = stateRe.exec(line.text))) add(m[0], "identifier");
    }
  }
  const uncited_elements = [];
  for (const e of elements.values()) {
    const secText = e.doc.lines.filter((l) => l.section === e.line.section).map((l) => l.text).join("\n");
    const cited = citeKinds.some((k) => { k.re.lastIndex = 0; return k.re.test(secText); });
    if (!cited) uncited_elements.push({ element: e.name, type: e.type, ...loc(e.doc, e.line) });
  }

  return {
    requirement_kinds: [...reqKinds],
    coverage,
    no_design: coverage.filter((c) => c.design === 0).map((c) => c.id),
    no_tasks: hasRole("tasks") ? coverage.filter((c) => c.tasks === 0).map((c) => c.id) : null,
    no_verification: hasRole("verification") ? coverage.filter((c) => c.verification === 0).map((c) => c.id) : null,
    source_ids,
    uncited_source_ids,
    uncited_elements: cap(uncited_elements, 80),
  };
}

// ---------------------------------------------------------------- 요구 문장 (REQ-01·REQ-05)
export function extractRequirementText(ids, docs, profile, vocab) {
  const roles = new Set(["spec", "requirement", "plan"]);
  const vague = [];
  if (vocab.vague.length) {
    for (const [doc, line] of eachLine(docs, { code: false, history: false, headings: false })) {
      if (!roles.has(doc.role)) continue;
      const w = vocab.vague.find((x) => line.text.includes(x));
      if (!w) continue;
      const measured = /\d+(?:\.\d+)?\s?(?:초|분|시간|일|ms|s|sec|min|h|%|건|회|개)|PT\d|P\d+D/.test(line.text);
      if (!measured) vague.push({ word: w, ...loc(doc, line) });
    }
  }
  const storyKinds = new Set(asArray(profile.script_hints?.flow_kinds || "user-story"));
  const byPath = new Map(docs.map((d) => [d.path, d]));
  const flows = [];
  for (const [id, defs] of Object.entries(ids.definitions)) {
    if (!storyKinds.has(defs[0].kind)) continue;
    const d = defs[0];
    const doc = byPath.get(d.doc);
    const secText = doc.lines.filter((l) => l.section === d.section).map((l) => l.text).join("\n");
    const has = vocab.acceptance_markers.some((m) => secText.includes(m));
    flows.push({ id, has_acceptance: has, ...d });
  }
  return { vague_unmeasured: cap(vague, 120), flows, flows_without_acceptance: flows.filter((f) => !f.has_acceptance) };
}

// ---------------------------------------------------------------- 근거 (EVD-01·02·04)
export function extractEvidence(docs, profile, vocab) {
  const markers = [...vocab.unverified, ...vocab.inferred, ...vocab.statement];
  // 미확인 항목과 담당·방법·영향 필드 (EVD-04)
  const unverified = [];
  if (vocab.unverified.length) {
    for (const [doc, line] of eachLine(docs, { code: false, history: false })) {
      if (!lineHasAny(line.text, vocab.unverified)) continue;
      const f = { owner: lineHasAny(line.text, vocab.owner_words), method: lineHasAny(line.text, vocab.method_words), impact: lineHasAny(line.text, vocab.impact_words) };
      unverified.push({ ...f, missing: Object.entries(f).filter(([, v]) => !v).map(([k]) => k), ...loc(doc, line) });
    }
  }
  // 외부 주체가 나오는 문장 중 출처·표지가 없는 것 (EVD-02)
  const systems = asArray(profile.external_sources).map((s) => ({ system: s.system, aliases: [...new Set([s.system, ...asArray(s.aliases)])].filter((a) => a && a.length >= 2), primaryWhere: asArray(s.primary).map((p) => p.where).filter(Boolean) }));
  const claims = [];
  const secondary = [];
  for (const [doc, line] of eachLine(docs, { code: false, history: false, headings: false })) {
    if (["source-material", "review-input"].includes(doc.role)) continue;
    const t = line.text;
    if (t.trim().length < 20 || /^\s*\|\s*:?-{2,}/.test(t)) continue;
    for (const s of systems) {
      const alias = s.aliases.find((a) => wordRegex(a).test(t));
      if (!alias) continue;
      const linked = /https?:\/\/|\]\(|\[[A-Z]{1,4}#?\d+\]|\.md\b/.test(t);
      const marked = lineHasAny(t, markers);
      if (!linked && !marked) claims.push({ system: s.system, alias, role: doc.role, ...loc(doc, line) });
      if (lineHasAny(t, vocab.secondary_markers)) secondary.push({ system: s.system, marker: vocab.secondary_markers.find((w) => t.includes(w)), ...loc(doc, line) });
      break;
    }
  }
  const claimsByDoc = Object.fromEntries([...groupBy(claims, (c) => c.doc)].map(([k, v]) => [k, v.length]));
  return {
    unverified_items: cap(unverified, 150),
    unverified_missing_fields: unverified.filter((u) => u.missing.length).length,
    external_claims_unmarked: cap(claims, 150),
    external_claims_by_doc: claimsByDoc,
    secondary_source_lines: cap(secondary, 60),
  };
}

// ---------------------------------------------------------------- 위협 표 (THR-03)
export function extractThreatTables(docs, profile, vocab) {
  const anyIdRes = allPatterns(profile).map((p) => idRegex(p));
  const rows = [];
  for (const doc of docs) {
    let inThreat = false;
    doc.lines.forEach((l, i) => {
      const next = doc.lines[i + 1];
      if (/^\s*\|/.test(l.text) && next && /^\s*\|\s*:?-{2,}/.test(next.text)) {
        inThreat = vocab.threat_headers.some((h) => l.text.toLowerCase().includes(h.toLowerCase()));
        return;
      }
      if (!/^\s*\|/.test(l.text)) { inThreat = false; return; }
      if (!inThreat || /^\s*\|\s*:?-{2,}/.test(l.text)) return;
      const cited = anyIdRes.some((re) => { re.lastIndex = 0; return re.test(l.text); });
      rows.push({ cites_id: cited, ...loc(doc, l) });
    });
  }
  return { rows: rows.length, rows_without_id: rows.filter((r) => !r.cites_id) };
}
