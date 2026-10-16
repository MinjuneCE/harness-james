#!/usr/bin/env node
// 설계 검증 스크립트 추출(S). LLM 판단 없음. Node 내장 모듈만 쓴다.
//
// 사용:
//   node extract.mjs --profile <프로파일.json> --out <출력 디렉터리>
//        [--root <워크스페이스 루트>] [--rubric-dir <rubrics 폴더, 기본 = 스킬에 든 evaluation/rubrics>]
//        [--changed-since <이전 section-index.json>] [--map <논리 접두어>=<실제 접두어>]...
//        [--level light|standard|deep] [--label <라벨>]
// 출력: <out>/extract.json(전체, 스크립트용), <out>/extract/index.json + extract/<차원>.json(판정자용, 정본 쪽 후보)
//       + extract/<차원>.input.json(입력 문서에만 있는 후보, 있을 때만),
//       <out>/section-index.json, <out>/criteria.json
// 종료 코드: 0 성공 · 2 인자·프로파일 오류 · 3 묶음 문서 없음
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle } from "./lib/load.mjs";
import { parseRubricDir, selectCriteria } from "./lib/rubric.mjs";
import {
  extractBaselines, extractDecisions, extractDuplicates, extractEvidence, extractIds, extractNumbering,
  extractNumbers, extractPlaceholders, extractRanges, extractReferences, extractRequirementText,
  extractTerms, extractThreatTables, extractTrace,
} from "./lib/extractors.mjs";
import { CONCRETE_KINDS, CRITERION_EXTRACTORS, buildCandidates, buildScriptFindings, obligatedCandidates } from "./lib/candidates.mjs";
import { asArray, readJson, writeJson, writeText } from "./lib/util.mjs";
import { deepAdvice, estimate, estimateTokens } from "./lib/estimate.mjs";
import { REFUTE_MAX } from "./lib/verdict.mjs";

// Read 한 번에 읽을 수 있는 대략의 한도(토큰). 넘는 문서는 문서 목록에 large로 표시한다(B13). 정보일 뿐 읽는 방법은 정하지 않는다.
export const READ_LIMIT_TOKENS = 25000;

export const EXTRACT_SCHEMA_VERSION = "0.1.0";
const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const a = { maps: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => { const x = argv[++i]; if (x == null) throw new Error(`${k} 값 없음`); return x; };
    if (k === "--profile") a.profile = v();
    else if (k === "--out") a.out = v();
    else if (k === "--root") a.root = v();
    else if (k === "--rubric-dir") a.rubricDir = v();
    else if (k === "--changed-since") a.changedSince = v();
    else if (k === "--map") a.maps.push(v());
    else if (k === "--level") a.level = v();
    else if (k === "--label") a.label = v();
    else if (k === "--generated-at") a.generatedAt = v();
    else if (k === "--reports-dir") a.reportsDir = v();
    else throw new Error(`알 수 없는 인자: ${k}`);
  }
  if (!a.profile || !a.out) throw new Error("--profile 과 --out 이 필요하다");
  return a;
}

function findRoot(start) {
  for (let d = resolve(start); ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return d;
    if (dirname(d) === d) return resolve(start);
  }
}

// 프로젝트 데이터(프로파일·보고서) 기본 위치. 판정 기준(framework·rubrics·traits)은 스킬 안 evaluation/에 함께 배포한다.
export const PROJECT_DATA_DIR = "docs/evaluation/design";
export const BUNDLED_RUBRIC_DIR = resolve(HERE, "../evaluation/rubrics");

// 판정 기준이 프로젝트 밖(플러그인 설치 경로)에 있으면 작업 폴더 <out>/evaluation/에 복사본을 두고 그 경로를 쓴다.
// 판정·반증 에이전트의 Read는 작업 디렉터리 밖에서 권한을 묻거나 막히기 때문이다. 복사본은 그 실행이 쓴 기준 판의 기록도 된다.
export function snapshotCriteria(root, rubricDir, outDir) {
  const r = relative(root, rubricDir);
  if (r && !r.startsWith("..") && !isAbsolute(r)) return rubricDir;
  const src = dirname(rubricDir);
  const dst = join(outDir, "evaluation");
  mkdirSync(dst, { recursive: true });
  cpSync(rubricDir, join(dst, "rubrics"), { recursive: true });
  for (const f of ["framework.md", "traits.md"]) if (existsSync(join(src, f))) cpSync(join(src, f), join(dst, f));
  return join(dst, "rubrics");
}

// 프로파일: 경로가 아니면 <root>/docs/evaluation/design/profiles/<이름>.json
export function resolveProfilePath(root, p) {
  if (/[\\/]/.test(p) || p.endsWith(".json")) return resolve(root, p);
  return resolve(root, PROJECT_DATA_DIR, "profiles", `${p}.json`);
}

// --changed-since latest: <reports-dir>/<profile>/ 의 가장 최근 *.index.json
export function resolvePrevIndex(root, v, reportsDir, key) {
  if (v !== "latest") return resolve(root, v);
  const dir = resolve(root, reportsDir || `${PROJECT_DATA_DIR}/reports`, key || "");
  if (!existsSync(dir)) throw new Error(`이전 색인 없음: ${dir}`);
  const files = readdirSync(dir).filter((f) => f.endsWith(".index.json")).sort();
  if (!files.length) throw new Error(`이전 색인 없음: ${dir}/*.index.json`);
  return join(dir, files[files.length - 1]);
}

// 분할 파일에 그대로 둘 원 표(후보로 옮기지 않은 정보). 나머지 추출기 목록은 후보에 있으므로 개수만 둔다.
const RAW_KEEP = new Set(["numbers.config_conflicts", "numbers.timing_settings", "numbers.parameter_checks", "terms.transitions", "trace.no_design", "trace.no_tasks", "trace.no_verification", "numbering.dual_numbering"]);
const RAW_EXTRA = {
  TRC: ["trace.coverage", "trace.source_ids", "trace.requirement_kinds"],
  BND: ["baselines.baseline", "baselines.doc_versions", "ids.kinds_summary", "ids.retired_ids", "ids.ref_only_checked"],
  CON: ["numbers.profile_parameters", "numbers.parameter_checks"],
  EVD: ["numbers.profile_parameters", "evidence.external_claims_by_doc"],
  FLR: ["numbers.profile_parameters", "numbers.parameter_checks"],
  QAS: ["numbers.profile_parameters"],
  DEC: ["decisions.definitions"],
};
// 위는 들여쓰기, 배열 원소는 한 줄씩(사람도 읽고 토큰도 아낀다)
function compactJson(body) {
  const lines = ["{"];
  const keys = Object.keys(body);
  keys.forEach((k, i) => {
    const v = body[k];
    const end = i < keys.length - 1 ? "," : "";
    if (k === "candidate_groups" && v.length) {
      const gs = v.map((g) => `    {"criterion":${JSON.stringify(g.criterion)},"kind":${JSON.stringify(g.kind)},"count":${g.count},"entries":[\n${g.entries.map((e) => "      " + JSON.stringify(e)).join(",\n")}\n    ]}`);
      lines.push(`  ${JSON.stringify(k)}: [\n${gs.join(",\n")}\n  ]${end}`);
    } else if (Array.isArray(v) && v.length) lines.push(`  ${JSON.stringify(k)}: [\n${v.map((x) => "    " + JSON.stringify(x)).join(",\n")}\n  ]${end}`);
    else if (v && typeof v === "object" && !Array.isArray(v)) lines.push(`  ${JSON.stringify(k)}: {\n${Object.entries(v).map(([a, b]) => `    ${JSON.stringify(a)}: ${JSON.stringify(b)}`).join(",\n")}\n  }${end}`);
    else lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${end}`);
  });
  lines.push("}");
  return lines.join("\n") + "\n";
}

// 분할 파일용 후보: 구체 종류는 인용(120자)까지, 나머지 종류는 위치(문서:줄)만. 원문은 판정자가 필요할 때 연다.
const CONCRETE = new Set(CONCRETE_KINDS);
function slimCandidate(c) {
  const { applicable, ...rest } = c;
  if (CONCRETE.has(c.kind)) return { ...rest, evidence_total: c.evidence.length, evidence: c.evidence.slice(0, 3).map((e) => ({ doc: e.doc, line: e.line, quote: e.quote.length > 120 ? e.quote.slice(0, 119) + "…" : e.quote })) };
  return { ...rest, evidence: c.evidence.map((e) => `${e.doc}:${e.line}`) };
}

// 구체 종류가 아닌 후보는 (기준, 종류)로 묶어 "요지 @ 문서:줄" 한 줄씩 둔다.
function groupOthers(cands) {
  const m = new Map();
  for (const c of cands) {
    const k = `${c.criterion}\u0000${c.kind}`;
    if (!m.has(k)) m.set(k, { criterion: c.criterion, kind: c.kind, count: 0, entries: [] });
    const g = m.get(k);
    g.count++;
    const locs = c.evidence.slice(0, 3).map((e) => `${e.doc}:${e.line}`).join(", ");
    g.entries.push(`${c.id} ${c.summary.length > 90 ? c.summary.slice(0, 89) + "…" : c.summary}${locs ? ` @ ${locs}` : ""}${c.doc_class === "input" ? " [input]" : ""}`);
  }
  return [...m.values()];
}

const getPath = (obj, path) => path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

// 판정자용 분할: extract/index.json(요약 색인) + extract/<차원>.json(그 차원 기준의 후보 전부·원 추출 표·S 단독 finding).
// extract.json(전체)은 스크립트(verdict·report)용으로 남긴다.
export function writeSplit(outDir, out, criteria) {
  const dir = join(outDir, "extract");
  const dims = [...new Set(criteria.map((c) => c.dimension))].sort();
  const files = [];
  for (const dim of dims) {
    const ids = criteria.filter((c) => c.dimension === dim).map((c) => c.id);
    // 원 표: 후보로 이미 옮겨진 목록은 개수만, 후보에 없는 작은 표는 그대로 둔다
    const raw = {};
    for (const id of ids) {
      for (const p of CRITERION_EXTRACTORS[id] || []) {
        const v = getPath(out.extract, p);
        if (RAW_KEEP.has(p)) raw[p] = v ?? null;
        else raw[p] = { count: Array.isArray(v) ? v.length : v?.total ?? (v && typeof v === "object" ? Object.keys(v).length : v ?? 0), in: "candidates" };
      }
    }
    for (const p of RAW_EXTRA[dim] || []) raw[p] = getPath(out.extract, p) ?? null;
    // 정본 쪽 후보는 차원 파일에, 입력 문서(원자료·점검 보고서)에만 있는 후보는 (기준, 종류)별 개수만 두고 목록은 <차원>.input.json으로 뺀다(7-2).
    const mine = out.candidates.filter((c) => ids.includes(c.criterion));
    const canon = mine.filter((c) => c.doc_class !== "input");
    const inputOnly = mine.filter((c) => c.doc_class === "input");
    const inputCounts = {};
    for (const c of inputOnly) {
      inputCounts[c.criterion] ??= {};
      inputCounts[c.criterion][c.kind] = (inputCounts[c.criterion][c.kind] || 0) + 1;
    }
    const inputFile = inputOnly.length ? `extract/${dim}.input.json` : null;
    const body = {
      schema: `extract-dim/${EXTRACT_SCHEMA_VERSION}`,
      dimension: dim,
      criteria: out.criteria_status.filter((c) => ids.includes(c.id)),
      extractors: Object.fromEntries(ids.filter((id) => CRITERION_EXTRACTORS[id]).map((id) => [id, CRITERION_EXTRACTORS[id]])),
      obligated: obligatedCandidates(canon).map((c) => c.id),
      candidates: canon.filter((c) => CONCRETE.has(c.kind)).map(slimCandidate),
      candidate_groups: groupOthers(canon.filter((c) => !CONCRETE.has(c.kind))),
      input_only: { count: inputOnly.length, by_criterion: inputCounts, file: inputFile },
      script_findings: out.script_findings.filter((f) => ids.includes(f.criterion)),
      raw,
    };
    const file = join(dir, `${dim}.json`);
    const text = compactJson(body);
    writeText(file, text);
    let inputBytes = 0;
    if (inputFile) {
      const itext = compactJson({
        schema: `extract-dim-input/${EXTRACT_SCHEMA_VERSION}`,
        dimension: dim,
        note: "입력 문서(원자료·점검 보고서)에만 근거가 있는 후보. 정본이 아니다.",
        candidates: inputOnly.filter((c) => CONCRETE.has(c.kind)).map(slimCandidate),
        candidate_groups: groupOthers(inputOnly.filter((c) => !CONCRETE.has(c.kind))),
      });
      writeText(join(outDir, inputFile), itext);
      inputBytes = Buffer.byteLength(itext);
    }
    files.push({ dimension: dim, file: `extract/${dim}.json`, criteria: ids, candidates: canon.length, obligated: body.obligated.length, input_only: inputOnly.length, input_file: inputFile, input_bytes: inputBytes, script_findings: body.script_findings.length, bytes: Buffer.byteLength(text), tokens_est: estimateTokens(text) });
  }
  const byKind = {};
  for (const c of out.candidates) {
    byKind[c.criterion] ??= {};
    byKind[c.criterion][c.kind] = (byKind[c.criterion][c.kind] || 0) + 1;
  }
  const index = {
    schema: `extract-index/${EXTRACT_SCHEMA_VERSION}`,
    generated_at: out.generated_at, label: out.label, level: out.level,
    profile: out.profile, rubric: out.rubric, root: out.root, path_maps: out.path_maps,
    limits: out.limits, external_sources: out.external_sources, known_risks_accepted: out.known_risks_accepted,
    profile_errors: out.profile_errors, documents: out.documents, unreadable: out.unreadable,
    outside_bundle_sources: out.outside_bundle_sources, estimate: out.estimate, changed: out.changed,
    criteria_status: out.criteria_status,
    counts: { candidates: out.candidates.length, script_findings: out.script_findings.length, by_criterion: out.counts, by_kind: byKind },
    files,
    obligated_candidates: obligatedCandidates(out.candidates).map((c) => ({ id: c.id, criterion: c.criterion, kind: c.kind })),
    deep_advice: out.deep_advice,
    note: "판정자는 이 색인과 필요한 차원 파일만 읽는다. 후보는 결함이 아닐 수 있다. obligated_candidates는 판정 출력의 candidate_dispositions에 하나씩 채택·기각으로 적는 목록이다.",
  };
  writeJson(join(dir, "index.json"), index);
  return { index: "extract/index.json", files: files.map((f) => f.file) };
}

export function buildIndex(profile, docs, generatedAt) {
  return {
    schema: "section-index/0.1.0",
    profile: profile.profile?.key,
    profile_version: profile.version,
    generated_at: generatedAt,
    docs: Object.fromEntries(docs.map((d) => [d.path, {
      hash: d.hash,
      lines: d.line_count,
      sections: Object.fromEntries(d.sections.map((s) => [s.key, { hash: s.hash, line_start: s.line_start, line_end: s.line_end }])),
    }])),
  };
}

export function diffIndex(prev, cur) {
  const documents = [];
  const sections = [];
  const removed = [];
  for (const [p, d] of Object.entries(cur.docs)) {
    const old = prev.docs?.[p];
    if (!old) { documents.push(p); sections.push(...Object.keys(d.sections).map((k) => ({ doc: p, section: k, state: "added" }))); continue; }
    if (old.hash === d.hash) continue;
    documents.push(p);
    for (const [k, s] of Object.entries(d.sections)) {
      if (!old.sections?.[k]) sections.push({ doc: p, section: k, state: "added" });
      else if (old.sections[k].hash !== s.hash) sections.push({ doc: p, section: k, state: "changed" });
    }
    for (const k of Object.keys(old.sections || {})) if (!d.sections[k]) sections.push({ doc: p, section: k, state: "removed" });
  }
  for (const p of Object.keys(prev.docs || {})) if (!cur.docs[p]) removed.push(p);
  return { any: documents.length + removed.length > 0, documents, removed_documents: removed, sections };
}

export function runExtract(args) {
  const root = resolve(args.root || findRoot(process.cwd()));
  const rubricDir = resolve(args.rubricDir || BUNDLED_RUBRIC_DIR);
  const generatedAt = args.generatedAt || new Date().toISOString();
  const profilePath = resolveProfilePath(root, args.profile);
  const bundle = loadBundle({ profilePath, root, maps: args.maps });
  const { profile, docs, vocab } = bundle;

  const { criteria, rubricVersion } = existsSync(rubricDir) ? parseRubricDir(rubricDir) : { criteria: [], rubricVersion: null };
  const index = buildIndex(profile, docs, generatedAt);
  const prevIndex = args.changedSince ? resolvePrevIndex(root, args.changedSince, args.reportsDir, profile.profile?.key) : null;
  const changed = prevIndex ? { ...diffIndex(readJson(prevIndex), index), previous_index: prevIndex } : null;
  const selected = selectCriteria(criteria, profile, changed);
  const applicable = new Set(selected.filter((c) => c.status === "to-evaluate").map((c) => c.id));

  const ids = extractIds(docs, profile);
  const x = {
    ids,
    numbering: extractNumbering(docs),
    ranges: extractRanges(docs, ids),
    references: extractReferences(docs, vocab, { mapPath: bundle.mapPath, root, roots: asArray(profile.bundle?.roots) }),
    numbers: extractNumbers(docs, profile, vocab),
    terms: extractTerms(docs, profile, vocab),
    duplicates: extractDuplicates(docs),
    placeholders: extractPlaceholders(docs, profile, vocab),
    baselines: extractBaselines(docs, profile, vocab),
    decisions: extractDecisions(ids, docs, profile, vocab),
    trace: extractTrace(ids, docs, profile, vocab, bundle.external),
    requirements: extractRequirementText(ids, docs, profile, vocab),
    evidence: extractEvidence(docs, profile, vocab),
    threats: extractThreatTables(docs, profile, vocab),
  };
  const docRoles = docs.map((d) => ({ path: d.path, role: d.role }));
  let candidates = buildCandidates(x, docRoles);
  for (const c of candidates) c.applicable = applicable.has(c.criterion);
  // 증분이면 S 기준도 범위대로: 절·문서 범위 기준의 후보는 바뀐 곳에 근거가 있을 때 changed, 아니면 carried
  if (changed) {
    const chDocs = new Set(changed.documents);
    const chSecs = new Set(changed.sections.map((s) => `${s.doc}\u0000${s.section}`));
    const scopeOf = Object.fromEntries(criteria.map((c) => [c.id, c.scope]));
    for (const c of candidates) {
      const sc = scopeOf[c.criterion];
      const hit = c.evidence.some((e) => (sc === "section" ? chSecs.has(`${e.doc}\u0000${e.section}`) : chDocs.has(e.doc)));
      c.scope_state = sc === "bundle" ? (changed.any ? "changed" : "carried") : hit ? "changed" : "carried";
    }
  }
  const scriptFindings = buildScriptFindings(x, applicable);
  if (changed) {
    const chSecs = new Set(changed.sections.map((s) => `${s.doc}\u0000${s.section}`));
    for (const f of scriptFindings) f.scope_state = f.evidence.some((e) => chSecs.has(`${e.doc}\u0000${e.section}`)) ? "changed" : "carried";
  }

  // 출력에서 순환 참조(doc·line 객체)를 뺀다
  const slim = JSON.parse(JSON.stringify({ ...x, ids: { ...ids, mentions: undefined, mention_count: ids.mentions.length } }, (k, v) => (k === "doc" && v && typeof v === "object" ? v.path : k === "line" && v && typeof v === "object" ? v.n : v)));

  const documents = docs.map((d) => {
    const tokens = estimateTokens(d.text);
    return { path: d.path, fs_path: d.fs_path, role: d.role, canonical_for: d.canonical_for, reads_from: d.reads_from, hash: d.hash, lines: d.line_count, chars: d.char_count, tokens, large: tokens > READ_LIMIT_TOKENS, sections: d.sections.length };
  });
  const est = estimate(docs, { refuteMax: profile.limits?.refute ?? REFUTE_MAX });
  const out = {
    schema: `extract/${EXTRACT_SCHEMA_VERSION}`,
    generated_at: generatedAt,
    label: args.label || (args.changedSince ? "incr" : "full"),
    level: args.level || profile.level || "standard",
    profile: { key: profile.profile?.key, version: profile.version, rubric_version: profile.rubric_version, path: profilePath, traits: asArray(profile.design?.traits) },
    rubric: { dir: rubricDir, source: rubricDir, version: rubricVersion, criteria: criteria.length },
    root,
    path_maps: args.maps,
    limits: profile.limits || null,
    external_sources: asArray(profile.external_sources).map((e) => ({ system: e.system, primary: asArray(e.primary).map((p) => p.where), pending_confirmations: e.pending_confirmations || null })),
    known_risks_accepted: asArray(profile.known_risks_accepted),
    profile_errors: bundle.errors,
    documents,
    unreadable: bundle.unreadable,
    outside_bundle_sources: bundle.external.map((d) => ({ path: d.path, fs_path: d.fs_path || null, missing: !!d.missing })),
    estimate: est,
    changed,
    criteria_status: selected.map((c) => ({ id: c.id, status: c.status, reason: c.status_reason || null, scope: c.scope, method: c.method })),
    counts: {},
    candidates,
    script_findings: scriptFindings,
    deep_advice: deepAdvice(asArray(profile.design?.traits)),
    extract: slim,
  };
  for (const c of candidates) out.counts[c.criterion] = (out.counts[c.criterion] || 0) + 1;

  const outDir = resolve(root, args.out);
  if (existsSync(rubricDir)) out.rubric.dir = snapshotCriteria(root, rubricDir, outDir);
  writeJson(join(outDir, "extract.json"), out);
  out.split = writeSplit(outDir, out, criteria);
  writeJson(join(outDir, "section-index.json"), index);
  writeJson(join(outDir, "criteria.json"), { rubric_version: rubricVersion, profile: profile.profile?.key, criteria: selected });
  return { out, outDir, docs };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`오류: ${e.message}`); process.exit(2); }
  let res;
  try { res = runExtract(args); } catch (e) { console.error(`오류: ${e.stack || e.message}`); process.exit(2); }
  const { out, outDir } = res;
  if (!out.documents.length) { console.error("묶음 문서가 없다"); process.exit(3); }
  console.log(`OUT_DIR=${outDir}`);
  console.log(`문서 ${out.documents.length}개 · 읽지 않음 ${out.unreadable.length}개 · 프로파일 오류 ${out.profile_errors.length}개`);
  console.log(`후보 ${out.candidates.length}건 (적용 기준 ${out.candidates.filter((c) => c.applicable).length}) · S 단독 finding ${out.script_findings.length}건`);
  if (out.changed) console.log(`변경: 문서 ${out.changed.documents.length} · 절 ${out.changed.sections.length} · 삭제 문서 ${out.changed.removed_documents.length}`);
  console.log(out.estimate.cost_line);
  if (out.deep_advice) console.log(out.deep_advice);
  for (const e of out.profile_errors) console.log(`경고: ${e}`);
}
