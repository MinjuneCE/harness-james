// 판정 단계(standard·deep) 공통: findings 형식 점검, 반증 대상 선정·병합, 상한, 기준 위험도, 판정, 증분 이월.
// 규칙 출처: framework.md 4·5·6·7·8장.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CONF_FACTOR, CONFIDENCES, CRITERION_STATUSES, REFUTE_VERDICTS, SCOPE_STATES, SEV_POINTS, SEVERITIES, SOURCES,
  asArray, atLeast, globToRegExp, sevRank,
} from "./util.mjs";
import { INPUT_ROLES, obligatedCandidates } from "./candidates.mjs";

// 반증 상한(사용자 결정 2026-10-16): critical·high 전부, 최대 8건. 프로파일 limits.refute가 덮어쓴다.
export const REFUTE_MAX = 8;
export const REFUTE_ORDER = "심각도(critical 먼저) → 신뢰도 낮은 것 먼저(possible → likely → confirmed) → R(c)";
export const DEFAULT_LIMITS = { total: 50, per_criterion: 5, low_info: 10 };
export const DEFAULT_THRESHOLD = 50;
// 요청 모델은 별칭(fable·opus)으로 적는다. 실행 모델 ID는 트랜스크립트 등으로 확인했을 때만 *_observed에 적는다(C6).
export const MODEL_IDS = { fable: "claude-fable-5-1", opus: "claude-opus-5-5" };
// level별 찾는 모델·반증 모델(사용자 결정: 찾은 모델과 다른 모델이 반증)
export const LEVEL_MODELS = {
  standard: { judge: "fable", refuter: "opus" },
  deep: { judge: "opus", refuter: "fable" },
};
// 별칭이든 모델 ID든 같은 모델끼리 비교할 수 있게 별칭으로 바꾼다. 모르는 값은 그대로 둔다.
export function modelAlias(m) {
  if (!m) return m;
  const s = String(m);
  if (MODEL_IDS[s]) return s;
  const hit = Object.keys(MODEL_IDS).find((a) => MODEL_IDS[a] === s || s.includes(a));
  return hit || s;
}

const isHighPlus = (f) => atLeast(f.severity, "high");
const pts = (f) => SEV_POINTS[f.severity] * CONF_FACTOR[f.confidence];
const order = (a, b) => sevRank(b.severity) - sevRank(a.severity) || CONF_FACTOR[b.confidence] - CONF_FACTOR[a.confidence];

// ---------------------------------------------------------------- 형식 점검
export function checkFindings(doc, { criteria = [], documents = [], root = process.cwd(), level, candidates = null } = {}) {
  const errors = [];
  const warnings = [];
  const selected = new Map(criteria.map((c) => [c.id, c]));
  const applicable = new Set(criteria.filter((c) => c.status === "to-evaluate").map((c) => c.id));
  const fsOf = new Map(documents.map((d) => [d.path, d.fs_path]));
  const fileCache = new Map();
  const linesOf = (p) => {
    if (fileCache.has(p)) return fileCache.get(p);
    const fp = fsOf.get(p) ? resolve(root, fsOf.get(p)) : resolve(root, p);
    const v = existsSync(fp) ? readFileSync(fp, "utf8").split(/\r?\n/) : null;
    fileCache.set(p, v);
    return v;
  };
  const seen = new Set();
  for (const f of asArray(doc.findings)) {
    const at = f.id || "(id 없음)";
    if (!f.id) errors.push(`${at}: id 없음`);
    else if (seen.has(f.id)) errors.push(`${at}: id 중복`);
    seen.add(f.id);
    if (!selected.has(f.criterion)) errors.push(`${at}: 모르는 기준 ${f.criterion}`);
    else if (!applicable.has(f.criterion) && f.scope_state !== "carried") errors.push(`${at}: 적용 대상이 아닌 기준 ${f.criterion} (${selected.get(f.criterion).status})`);
    if (!SEVERITIES.includes(f.severity)) errors.push(`${at}: severity 값 오류 ${f.severity}`);
    if (!CONFIDENCES.includes(f.confidence)) errors.push(`${at}: confidence 값 오류 ${f.confidence}`);
    if (!SCOPE_STATES.includes(f.scope_state)) errors.push(`${at}: scope_state 값 오류 ${f.scope_state}`);
    if (!SOURCES.includes(f.source)) errors.push(`${at}: source 값 오류 ${f.source}`);
    if (!f.method || !/^[SLXH](\+[SLXH])*$/.test(f.method)) errors.push(`${at}: method 형식 오류 ${f.method}`);
    for (const k of ["failure_scenario", "recommendation"]) if (!f[k]) errors.push(`${at}: ${k} 없음`);
    if (!asArray(f.touches).length) errors.push(`${at}: touches 없음 (닿는 것이 없으면 올리지 않는다)`);
    const ev = asArray(f.evidence);
    if (!ev.length && !f.absence) errors.push(`${at}: evidence·absence 둘 다 없음`);
    if (f.absence && (!asArray(f.absence.searched).length)) errors.push(`${at}: absence.searched 없음`);
    if (f.criterion === "BND-06" && atLeast(f.severity, "medium")) errors.push(`${at}: BND-06 심각도 상한은 low`);
    for (const e of ev) {
      if (!e.doc || !e.quote) { errors.push(`${at}: evidence에 doc·quote 없음`); continue; }
      const ls = linesOf(e.doc);
      if (!ls) { warnings.push(`${at}: 근거 문서를 찾지 못함 ${e.doc}`); continue; }
      const q = locateQuote(ls, e.quote, e.line);
      if (q.status === "missing") errors.push(`${at}: 인용을 문서에서 찾지 못함 (${e.doc}:${e.line}) — 철회 대상`);
      else if (q.status === "moved") warnings.push(`${at}: 인용은 있으나 줄 번호가 다름 (${e.doc}:${e.line} → 실제 ${q.lines.slice(0, 3).map((n) => `:${n}`).join(", ")})`);
      else if (q.status === "partial") warnings.push(`${at}: 생략(…) 인용의 일부 조각을 ${e.doc}:${e.line} 근처에서 찾지 못함`);
    }
    if (f.refutation) {
      const r = f.refutation;
      if (!REFUTE_VERDICTS.includes(r.verdict)) errors.push(`${at}: refutation.verdict 값 오류 ${r.verdict}`);
      const finder = modelAlias(f.found_by_model || doc.models?.judge_observed || doc.models?.judge);
      if (r.model && finder && modelAlias(r.model) === finder) errors.push(`${at}: 반증 모델이 찾은 모델과 같다 (${r.model})`);
      if (r.verdict === "downgraded" && !r.severity_after) errors.push(`${at}: downgraded인데 severity_after 없음`);
    }
  }
  // light 구체 후보 처리 목록(사용자 결정 3): 후보마다 채택(finding ID) 또는 기각(이유). 빠지면 오류.
  if (candidates) {
    const disp = checkDispositions(doc, candidates);
    errors.push(...disp.errors);
    warnings.push(...disp.warnings);
  }
  // 서로 반대 방향인 권고 짝(B15, framework 7.5): 필드 자체는 있어야 한다(없으면 빈 배열). 짝의 ID는 finding에 있어야 한다.
  // finding의 conflicts_with로 적어도 된다(finalize가 둘을 합친다).
  for (const f of asArray(doc.findings)) for (const id of asArray(f.conflicts_with)) if (!seen.has(id)) errors.push(`${f.id}: conflicts_with에 모르는 finding ${id}`);
  if (!Array.isArray(doc.recommendation_conflicts)) errors.push("recommendation_conflicts 없음 (반대 방향 권고 짝이 없으면 빈 배열)");
  else for (const c of doc.recommendation_conflicts) {
    const ids = asArray(c.findings);
    if (ids.length !== 2) errors.push(`recommendation_conflicts: 짝은 finding 2개 (${ids.join(", ")})`);
    for (const id of ids) if (!seen.has(id)) errors.push(`recommendation_conflicts: 모르는 finding ${id}`);
    if (!c.note) warnings.push(`recommendation_conflicts ${ids.join("↔")}: note 없음`);
  }
  const statuses = new Map(asArray(doc.criteria).map((c) => [c.id, c.status]));
  for (const [id, st] of statuses) if (!CRITERION_STATUSES.includes(st)) errors.push(`기준 ${id}: 상태 값 오류 ${st}`);
  // 적용 기준마다 상태가 하나 있어야 한다(빠지면 finalize에서 평가 불완전 → REVISE). check에서 먼저 잡는다(R5).
  const missingStatus = [...applicable].filter((id) => !statuses.has(id));
  if (missingStatus.length) errors.push(`기준 상태 없음 ${missingStatus.length}개: ${missingStatus.join(", ")}`);
  if (level && doc.level && level !== doc.level) warnings.push(`level 불일치: 실행 ${level}, findings ${doc.level}`);
  return { errors, warnings };
}

// 인용 위치 찾기. "…"(또는 "...")로 생략한 인용은 조각마다 찾는다(B12).
// status: ok(줄 ±3 안) · moved(문서 안 다른 줄, lines = 실제 줄) · partial(첫 조각은 근처, 나머지 조각이 근처에 없음) · missing
export function locateQuote(lines, quote, line) {
  const parts = String(quote).split(/…|\.\.\./).map((x) => x.trim()).filter((x) => x.length >= 4).map((x) => x.slice(0, 80));
  if (!parts.length) return { status: "ok", lines: [] };
  const head = parts[0];
  const hits = [];
  lines.forEach((l, i) => { if (l.includes(head)) hits.push(i + 1); });
  const all = lines.join("\n");
  if (!hits.length && !all.includes(head)) return { status: "missing", lines: [] };
  if (!line) return { status: "ok", lines: hits };
  const lo = Math.max(0, line - 4);
  const win = lines.slice(lo, Math.min(lines.length, line + 3)).join("\n");
  if (!win.includes(head)) return { status: "moved", lines: hits };
  const wide = lines.slice(lo, Math.min(lines.length, line + 12)).join("\n");
  return parts.slice(1).every((p) => wide.includes(p)) ? { status: "ok", lines: hits } : { status: "partial", lines: hits };
}

// light 구체 후보 처리 목록 점검. doc.candidate_dispositions = [{candidate, disposition: adopted|rejected, finding?, reason?}]
export function checkDispositions(doc, candidates) {
  const errors = [];
  const warnings = [];
  const required = obligatedCandidates(candidates).filter((c) => c.scope_state !== "carried");
  const known = new Set(asArray(candidates).map((c) => c.id));
  const fids = new Set(asArray(doc.findings).map((f) => f.id));
  const byCand = new Map();
  for (const d of asArray(doc.candidate_dispositions)) {
    if (!d.candidate) { errors.push("candidate_dispositions: candidate 없음"); continue; }
    if (!known.has(d.candidate)) warnings.push(`candidate_dispositions: 모르는 후보 ${d.candidate}`);
    byCand.set(d.candidate, d);
    if (d.disposition === "adopted") { if (!d.finding || !fids.has(d.finding)) errors.push(`후보 ${d.candidate}: 채택인데 finding ID가 없거나 findings에 없음 (${d.finding || "-"})`); }
    else if (d.disposition === "rejected") { if (!d.reason) errors.push(`후보 ${d.candidate}: 기각인데 이유 없음`); }
    else errors.push(`후보 ${d.candidate}: disposition 값 오류 ${d.disposition}`);
  }
  const missing = required.filter((c) => !byCand.has(c.id)).map((c) => c.id);
  if (missing.length) errors.push(`light 구체 후보 처리 누락 ${missing.length}/${required.length}건: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? " …" : ""}`);
  return { errors, warnings, required: required.length, missing };
}

// ---------------------------------------------------------------- 읽지 못한 문서 (B1·B2)
// 판정자·관점이 적은 자유 문자열("plan.md 270-393 (Sequences)", "research.md (grep 일부만)", "inputs/*")을 묶음 문서 논리 경로로 바꾼다.
// 묶음 밖 경로(추출 파일·원칙 문서 등)는 outside로 뺀다.
export function resolveDocRefs(list, documents = []) {
  const docs = [];
  const outside = [];
  // 한글 파일 이름은 NFD(macOS 파일 시스템)와 NFC(에이전트 출력)가 섞인다. 대조는 NFC로 한다.
  const nfc = (v) => String(v).normalize("NFC");
  const paths = documents.map((d) => ({ path: d.path, alts: [d.path, d.fs_path].filter(Boolean).map(nfc) }));
  for (const raw of asArray(list)) {
    const s = nfc(raw).trim();
    const head = s.split(/\s+\(|\s+\d+\s*[-–~]\s*\d+|:\d/)[0].trim();
    let hit = [];
    if (/[*?]/.test(head)) {
      const re = globToRegExp(head);
      hit = paths.filter((p) => p.alts.some((a) => re.test(a))).map((p) => p.path);
    } else {
      const m = paths.filter((p) => p.alts.some((a) => s === a || (s.startsWith(a) && /^[\s(:,]/.test(s.slice(a.length))) || head === a));
      hit = m.map((p) => p.path);
    }
    if (hit.length) docs.push(...hit);
    else outside.push(s);
  }
  return { docs: [...new Set(docs)], outside };
}

// 묶음 문서 중 실제로 아무도 읽지 않은 것을 가른다.
//  excluded : 프로파일이 일부러 뺀 것(readable:false · exclude) — 평가 불완전 아님(B2)
//  failed   : 추출 단계 읽기 실패(그 밖 이유) — 평가 불완전
//  design   : 정본 쪽 문서를 어느 판정자도 읽지 않음 — 평가 불완전 → REVISE(framework 8.1)
//  input    : 입력 문서(원자료·점검 보고서)를 어느 판정자도 읽지 않음 — "원자료 미독" → REVIEW_REQUIRED(사용자 결정 5-1, framework 0.2.1)
export function resolveUnread({ documents = [], unreadable = [], read = [], unread = [] }) {
  const isExcluded = (u) => u.reason === "readable:false" || u.reason === "exclude";
  const excluded = asArray(unreadable).filter(isExcluded);
  const failed = asArray(unreadable).filter((u) => !isExcluded(u));
  const excludedSet = new Set(excluded.map((u) => u.path));
  // 제외·실패 문서도 경로 대조에 넣는다(판정자가 "x.pdf (readable:false…)"처럼 적는다)
  const universe = [...documents, ...asArray(unreadable).map((u) => ({ path: u.path, role: null }))];
  const readDocs = new Set(resolveDocRefs(read, universe).docs);
  const un = resolveDocRefs(unread, universe);
  const roleOf = new Map(documents.map((d) => [d.path, d.role]));
  const left = un.docs.filter((p) => roleOf.has(p) && !readDocs.has(p) && !excludedSet.has(p));
  return {
    excluded,
    failed,
    design: left.filter((p) => !INPUT_ROLES.has(roleOf.get(p))),
    input: left.filter((p) => INPUT_ROLES.has(roleOf.get(p))),
    outside: un.outside,
    raw_count: asArray(unread).length,
  };
}

// ---------------------------------------------------------------- 반증
// 반증 순서(사용자 결정 2026-10-16): 심각도(critical 먼저) → 같은 심각도 안에서 신뢰도 낮은 것 먼저(possible → likely → confirmed)
// → 그 finding이 속한 기준의 위험도 R(c)(반증 전, 가중치 반영) 높은 순.
// 상한(기본 8, 프로파일 limits.refute) 밖의 high 이상은 반증하지 않고 uncertain(note "not-refuted: cap") → REVIEW_REQUIRED.
export function criterionRiskMap(findings, criteria = []) {
  const w = new Map(criteria.map((c) => [c.id, c.weight ?? 1]));
  const sum = new Map();
  for (const f of findings) {
    if (f.refutation?.verdict === "rejected" || f.scope_state === "resolved" || f.criterion === "BND-06") continue;
    sum.set(f.criterion, (sum.get(f.criterion) || 0) + pts(f));
  }
  return new Map([...sum].map(([id, v]) => [id, Math.min(100, (w.get(id) ?? 1) * v)]));
}

export function refutationTargets(findings, max = REFUTE_MAX, criteria = []) {
  const risk = criterionRiskMap(findings, criteria);
  const cand = findings.filter((f) => isHighPlus(f) && f.source !== "human" && !f.refutation && f.scope_state !== "resolved")
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity)
      || CONF_FACTOR[a.confidence] - CONF_FACTOR[b.confidence]
      || (risk.get(b.criterion) || 0) - (risk.get(a.criterion) || 0));
  return { targets: cand.slice(0, max), over_cap: cand.slice(max), order: REFUTE_ORDER };
}

export function applyRefutation(findings, refutation, { refuterModel, overCap = [] } = {}) {
  const byId = new Map(asArray(refutation?.verdicts).map((v) => [v.finding_id, v]));
  const capIds = new Set(overCap.map((f) => f.id));
  return findings.map((f) => {
    const v = byId.get(f.id);
    if (v) {
      const out = { ...f, refutation: { verdict: v.verdict, model: modelAlias(refutation.model || refuterModel), note: v.note || "" } };
      if (v.verdict === "downgraded" && v.severity_after) { out.severity_before = f.severity; out.severity = v.severity_after; out.refutation.severity_after = v.severity_after; }
      if (v.confidence_after) { out.confidence_before = f.confidence; out.confidence = v.confidence_after; out.refutation.confidence_after = v.confidence_after; }
      return out;
    }
    if (capIds.has(f.id) && !f.refutation) {
      return { ...f, refutation: { verdict: "uncertain", model: null, note: "not-refuted: cap" }, not_refuted_cap: true };
    }
    return f;
  });
}

// 반대 방향 권고 짝: 최상위 recommendation_conflicts와 finding별 conflicts_with를 합쳐
// 짝 목록(보고서 권고 충돌 표)과 finding마다 conflicts_with(상대 ID)를 만든다(framework 7.5). 한쪽을 지우거나 고치지 않는다.
export function mergeConflicts(findings, pairs = []) {
  const ids = new Set(findings.map((f) => f.id));
  const key = (a, b) => [a, b].sort().join("\u0000");
  const out = new Map();
  for (const c of asArray(pairs)) {
    const [a, b] = asArray(c.findings);
    if (a && b && a !== b) out.set(key(a, b), { findings: [a, b], note: c.note || "" });
  }
  for (const f of findings) for (const o of asArray(f.conflicts_with)) if (o !== f.id && !out.has(key(f.id, o))) out.set(key(f.id, o), { findings: [f.id, o], note: "" });
  const list = [...out.values()].filter((c) => c.findings.every((id) => ids.has(id)));
  const partners = new Map();
  for (const { findings: [a, b] } of list) {
    partners.set(a, [...(partners.get(a) || []), b]);
    partners.set(b, [...(partners.get(b) || []), a]);
  }
  const withLinks = findings.map((f) => (partners.has(f.id) ? { ...f, conflicts_with: [...new Set(partners.get(f.id))] } : f));
  return { findings: withLinks, conflicts: list };
}

// ---------------------------------------------------------------- 상한 (framework 6장)
export function applyLimits(findings, limits = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const sorted = [...findings].sort(order);
  const kept = [];
  const dropped = [];
  const perCrit = new Map();
  let lowInfo = 0;
  for (const f of sorted) {
    const n = perCrit.get(f.criterion) || 0;
    const isLow = f.severity === "low" || f.severity === "info";
    if (kept.length >= L.total || n >= L.per_criterion || (isLow && lowInfo >= L.low_info)) { dropped.push(f); continue; }
    kept.push(f);
    perCrit.set(f.criterion, n + 1);
    if (isLow) lowInfo++;
  }
  const overflow = {};
  for (const f of dropped) {
    overflow[f.criterion] ??= { count: 0, locations: [] };
    overflow[f.criterion].count++;
    const e = asArray(f.evidence)[0];
    if (e && overflow[f.criterion].locations.length < 3) overflow[f.criterion].locations.push(`${e.doc}:${e.line}`);
  }
  return { kept, dropped, overflow, limits: L };
}

// ---------------------------------------------------------------- 판정 (framework 8장)
// unreadable: 추출 단계 unreadable(이유 포함) + 어느 판정자도 읽지 않은 정본 쪽 묶음 문서({path, reason: "judge-unread"}).
// unreadInputs: 어느 판정자도 읽지 않은 입력 문서(원자료) → 평가 불완전이 아니라 REVIEW_REQUIRED("원자료 미독").
// readable:false·exclude는 의도적 제외라 불완전이 아니다(framework 8.1). warnings: 판정은 바꾸지 않는 평가 불완전 경고(구체 후보 처리 누락).
export function computeVerdict({ findings, criteria, documents = [], unreadable = [], extractOk = true, incremental = false, agentFailures = [], warnings = [], unreadInputs = [] }) {
  const counted = findings.filter((f) => f.refutation?.verdict !== "rejected" && f.scope_state !== "resolved" && (f.scope_state !== "carried" || !incremental));
  const critById = new Map(criteria.map((c) => [c.id, c]));
  const risk = {};
  for (const f of counted) {
    const c = critById.get(f.criterion);
    if (!c || c.excluded_from_verdict || f.criterion === "BND-06") continue;
    risk[f.criterion] = (risk[f.criterion] || 0) + pts(f);
  }
  const criterionRisk = Object.entries(risk).map(([id, sum]) => {
    const c = critById.get(id);
    const R = Math.min(100, Number((c.weight ?? 1) * sum).toFixed(1) * 1);
    return { id, R, threshold: c.review_threshold ?? DEFAULT_THRESHOLD, weight: c.weight ?? 1 };
  }).sort((a, b) => b.R - a.R);

  const incomplete = [];
  const statusIds = new Set(criteria.filter((c) => c.final_status).map((c) => c.id));
  for (const c of criteria) if (c.status === "to-evaluate" && !statusIds.has(c.id)) incomplete.push(`기준 상태 없음: ${c.id}`);
  // 반증을 시도한(또는 시도했어야 할) high 이상의 결과가 없으면 불완전. 상한 밖(uncertain, not-refuted: cap)은 불완전이 아니다(8.1).
  for (const f of counted) if (isHighPlus(f) && !f.refutation) incomplete.push(`반증 결과 없음: ${f.id}`);
  for (const u of unreadable) if (u.reason !== "readable:false" && u.reason !== "exclude") incomplete.push(`읽지 못한 문서: ${u.path}${u.reason === "judge-unread" ? " (정본 문서, 재실행 필요)" : ""}`);
  if (!extractOk) incomplete.push("스크립트 추출 결과 없음(S 기준)");
  for (const a of agentFailures) incomplete.push(`에이전트 실패: ${a}`);

  const triggers = { revise: [], review: [] };
  for (const f of counted) {
    if (f.criterion === "BND-06") continue;
    if (f.severity === "critical" && (f.confidence === "confirmed" || f.confidence === "likely")) triggers.revise.push(`critical ${f.id} (${f.criterion}, ${f.confidence})`);
  }
  if (incomplete.length) triggers.revise.push(`평가 불완전 ${incomplete.length}건`);
  for (const r of criterionRisk) if (r.R >= r.threshold) triggers.review.push(`R(${r.id}) = ${r.R} ≥ ${r.threshold}`);
  if (unreadInputs.length) triggers.review.push(`원자료 미독 ${unreadInputs.length}건: ${unreadInputs.join(", ")}`);
  for (const f of counted) {
    if (f.criterion === "BND-06" || !isHighPlus(f)) continue;
    if (f.refutation?.verdict === "uncertain") triggers.review.push(f.not_refuted_cap ? `반증 상한 밖(not-refuted: cap) ${f.id}` : `반증 uncertain ${f.id}`);
    else if (/[XH]/.test(f.method) && f.open_check !== false) triggers.review.push(`X·H 확인 열림 ${f.id}`);
  }
  const verdict = triggers.revise.length ? "REVISE" : triggers.review.length ? "REVIEW_REQUIRED" : "PROCEED";
  const sevCount = Object.fromEntries(SEVERITIES.map((s) => [s, counted.filter((f) => f.severity === s).length]));
  const excluded = unreadable.filter((u) => u.reason === "readable:false" || u.reason === "exclude").map((u) => u.path);
  return { verdict, triggers, incomplete, incomplete_warnings: warnings, unread_inputs: unreadInputs, excluded, criterion_risk: criterionRisk, severity_counts: sevCount, counted: counted.length };
}

// ---------------------------------------------------------------- 증분 이월
// 이전 findings 중 근거 절이 이번 변경에 없는 것은 carried, 있는 것은 다시 볼 목록(recheck)으로 나눈다.
export function carryFindings(prevFindings, changed) {
  if (!changed) return { carried: [], recheck: asArray(prevFindings) };
  const chDocs = new Set([...changed.documents, ...changed.removed_documents]);
  const chSecs = new Set(changed.sections.map((s) => `${s.doc}\u0000${s.section}`));
  const carried = [];
  const recheck = [];
  for (const f of asArray(prevFindings)) {
    if (f.scope_state === "resolved") continue;
    const ev = asArray(f.evidence);
    const docsTouched = ev.map((e) => e.doc).concat(asArray(f.absence?.searched).map((s) => String(s).split(/[§#:]/)[0].trim()));
    const hit = ev.some((e) => chSecs.has(`${e.doc}\u0000${e.section}`)) || (!ev.length && docsTouched.some((d) => chDocs.has(d))) || ev.some((e) => changed.removed_documents.includes(e.doc));
    if (hit) recheck.push(f);
    else carried.push({ ...f, scope_state: "carried" });
  }
  return { carried, recheck };
}
