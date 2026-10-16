// 추출 결과 → 기준별 후보(candidate)·S 단독 finding. 판정하지 않는다.
import { asArray, groupBy } from "./util.mjs";

// 정본이 아닌 입력 문서(원자료·점검 보고서). 후보는 남기되 보고서에서 따로 센다.
export const INPUT_ROLES = new Set(["source-material", "review-input"]);

// 기준 → 추출기 표. SCHEMA.md 2장과 같다. 시험(test/coverage.test.mjs)이 rubric의 S 기준을 모두 덮는지 확인한다.
export const CRITERION_EXTRACTORS = {
  "CON-01": ["terms.forbidden_live", "terms.identifier_variants"],
  "CON-02": ["numbers.config_conflicts", "numbers.value_groups"],
  "CON-03": ["terms.fields"],
  "CON-04": ["terms.transitions"],
  "CON-05": ["terms.retired_live", "ids.retired_references"],
  "CON-07": ["ranges", "baselines.header_mismatch"],
  "TRC-01": ["trace.uncited_source_ids", "trace.no_design"],
  "TRC-02": ["trace.no_tasks", "trace.no_verification"],
  "TRC-03": ["trace.uncited_elements"],
  "REQ-01": ["requirements.vague_unmeasured"],
  "REQ-02": ["placeholders"],
  "REQ-05": ["requirements.flows_without_acceptance"],
  "DEC-04": ["decisions.without_status", "decisions.supersede_mentions"],
  "EVD-01": ["evidence.secondary_source_lines"],
  "EVD-02": ["evidence.external_claims_unmarked"],
  "EVD-04": ["evidence.unverified_items"],
  "EVD-05": ["numbers.unsourced_numbers", "numbers.parameter_checks"],
  "THR-03": ["threats.rows_without_id"],
  "FLR-03": ["numbers.timing_settings", "numbers.parameter_checks"],
  "BND-01": ["duplicates.table_headers", "duplicates.lines", "duplicates.similar_paragraphs", "ids.duplicate_definitions"],
  "BND-02": ["baselines.off_baseline", "baselines.commit_values"],
  "BND-03": ["references.broken_links", "references.broken_anchors", "references.line_refs_out_of_range", "ids.undefined_references", "references.time_statements"],
  "BND-04": ["ids.mixed_schemes", "numbering.dual_numbering", "numbering.label_references", "ids.undefined_references"],
};

const roleClass = (c, roles) => {
  const rs = c.evidence.map((e) => roles.get(e.doc)).filter(Boolean);
  if (!rs.length) return "bundle";
  return rs.every((r) => INPUT_ROLES.has(r)) ? "input" : "design";
};
// 구체 종류: light 보고서에서 표로 보이는 종류(사용자 결정 2026-10-16). 은퇴 이름·ID, 번호 체계 혼재, 설정 충돌, 깨진 참조, 범위·머리말.
// 나머지 종류는 light에서 개수만 보이고, standard·deep 입력(extract/<차원>.json)으로는 전부 넘긴다.
export const CONCRETE_KINDS = [
  "retired-term-live", "retired-id-reference",
  "mixed-scheme", "dual-numbering", "label-ref-ambiguous", "label-ref-list-only", "label-ref-undefined",
  "config-conflict", "parameter-mismatch",
  "broken-link", "ref-only-undefined", "broken-anchor", "line-ref-out-of-range", "id-undefined",
  "range-mismatch", "header-version", "header-date",
];

// 판정자 처리 목록(사용자 결정 3, 2026-10-16): light 보고서가 표로 보이는 구체 후보 중 정본 쪽(입력 문서만이 아닌) 것.
// standard 판정자·deep 관점은 이 후보마다 채택(finding ID) 또는 기각(이유)을 출력에 적는다. verdict.mjs check가 빠진 것을 잡는다.
export const obligatedCandidates = (cands) => asArray(cands).filter((c) => c.applicable !== false && CONCRETE_KINDS.includes(c.kind) && c.doc_class !== "input");

// 보고서에서 먼저 보일 종류(구체적인 것 먼저). 목록에 없는 종류는 뒤로 간다.
export const KIND_PRIORITY = [
  "label-ref-list-only", "label-ref-undefined", "dual-numbering", "label-ref-ambiguous",
  "retired-id-reference", "retired-term-live", "forbidden-term",
  "config-conflict", "parameter-mismatch", "value-group",
  "broken-link", "broken-anchor", "line-ref-out-of-range", "id-undefined", "ref-only-undefined",
  "range-mismatch", "header-version", "header-date",
  "requirement-no-design", "requirement-no-task", "requirement-no-verification", "source-id-uncited", "source-section-unmatched",
  "duplicate-table-header", "id-defined-in-multiple-docs", "duplicate-line", "similar-paragraph",
  "mixed-scheme", "time-statement",
];
const items = (x) => (x == null ? [] : Array.isArray(x) ? x : asArray(x.items));
const ev = (o) => ({ doc: o.doc, section: o.section, line: o.line, quote: o.quote });

export function buildCandidates(x, documents = []) {
  const roles = new Map(documents.map((d) => [d.path, d.role]));
  const c = [];
  const add = (criterion, kind, summary, evidence, extra = {}) => c.push({ criterion, kind, summary, evidence: evidence.filter(Boolean).slice(0, 6), ...extra });

  for (const t of x.terms.forbidden_live) add("CON-01", "forbidden-term", `금지 동의어 "${t.term}" (정본 "${t.canonical}")`, [ev(t)]);
  for (const v of items(x.terms.identifier_variants)) add("CON-01", "identifier-variant", `식별자 변형 쌍 ${v.a} / ${v.b} (거리 ${v.distance})`, [], { docs: { [v.a]: v.a_docs, [v.b]: v.b_docs } });

  for (const k of x.numbers.config_conflicts) add("CON-02", "config-conflict", `설정 ${k.key} 값이 갈림: ${k.values.map((v) => v.value).join(" / ")}`, k.values.flatMap((v) => v.evidence.slice(0, 2)));
  for (const g of items(x.numbers.value_groups)) add("CON-02", "value-group", `"${g.context_key}" 뒤 값이 문서마다 다름: ${g.values.map((v) => `${v.raw.join("·")}(${v.docs.length}문서)`).join(" / ")}`, g.values.flatMap((v) => v.evidence.slice(0, 1)));

  if (x.terms.fields) {
    for (const f of items(x.terms.fields.used_not_defined)) add("CON-03", "field-not-in-data-model", `필드 ${f.field}가 데이터 모델에 없음`, [ev(f)]);
    for (const f of items(x.terms.fields.defined_not_used)) add("CON-03", "field-unused", `데이터 모델 필드 ${f.field}를 다른 문서가 쓰지 않음`, [ev(f)]);
  }
  for (const t of items(x.terms.transitions.not_in_canonical)) add("CON-04", "transition-not-in-canonical", `전이 ${t.transition}가 정본(${x.terms.transitions.canonical})에 없음`, [ev(t)]);

  for (const t of x.terms.retired_live) add("CON-05", "retired-term-live", `은퇴 용어 "${t.term}"${t.canonical ? ` (→ ${t.canonical})` : ""}가 이력 맥락 없이 남음 [${t.role}]`, [ev(t)]);
  for (const r of x.ids.retired_references) add("CON-05", "retired-id-reference", `합침·삭제된 ID ${r.id}를 이력 맥락 없이 참조 [${r.role}]`, [ev(r)]);

  for (const r of x.ranges) add("CON-07", "range-mismatch", `범위 ${r.range}: 정의 최대 ${r.defined_max}${r.missing_in_range.length ? `, 범위 안 빠진 번호 ${r.missing_in_range.join(",")}` : ""}`, [ev(r)]);
  for (const h of x.baselines.header_mismatch) add("CON-07", `header-${h.kind}`, `머리말 ${h.kind} ${h.header}보다 늦은 값 ${h.later}이 본문에 있음`, h.evidence);

  const total = x.trace.coverage.length;
  const idList = (xs) => (xs.length > 40 ? `${xs.slice(0, 40).join(", ")} 외 ${xs.length - 40}` : xs.join(", "));
  for (const [src, us] of groupBy(x.trace.uncited_source_ids, (u) => u.source)) add("TRC-01", "source-id-uncited", `원 요구 출처 ${src}의 ID ${us.length}개를 다른 문서가 인용하지 않음: ${idList(us.map((u) => u.id))}`, [], { ids: us.map((u) => u.id) });
  for (const s of x.trace.source_ids.filter((s) => s.unmatched?.length)) add("TRC-01", "source-section-unmatched", `원 요구 출처 절 ${s.unmatched.map((t) => `"${t}"`).join(", ")}을 ${s.source}에서 찾지 못함${s.ids.length ? "" : "(추출 생략)"}`, []);
  if (x.trace.no_design.length) add("TRC-01", "requirement-no-design", `요구 ${x.trace.no_design.length}/${total}개를 설계 문서(plan·data-model·contract)가 인용하지 않음: ${idList(x.trace.no_design)}`, [], { ids: x.trace.no_design });
  if ((x.trace.no_tasks || []).length) add("TRC-02", "requirement-no-task", `요구 ${x.trace.no_tasks.length}/${total}개를 작업 문서가 ID로 인용하지 않음: ${idList(x.trace.no_tasks)}`, [], { ids: x.trace.no_tasks });
  if ((x.trace.no_verification || []).length) add("TRC-02", "requirement-no-verification", `요구 ${x.trace.no_verification.length}/${total}개를 검증 문서가 ID로 인용하지 않음: ${idList(x.trace.no_verification)}`, [], { ids: x.trace.no_verification });
  for (const e of items(x.trace.uncited_elements)) add("TRC-03", "element-uncited", `설계 요소 ${e.element}(${e.type})의 정의 절에 요구·결정 ID 인용 없음`, [ev(e)]);

  for (const v of items(x.requirements.vague_unmeasured)) add("REQ-01", "vague-word", `모호어 "${v.word}"에 측정 기준 없음`, [ev(v)]);
  for (const f of x.requirements.flows_without_acceptance) add("REQ-05", "flow-no-acceptance", `흐름 ${f.id} 절에 수용 기준 표지 없음`, [ev(f)]);

  for (const d of x.decisions.without_status) add("DEC-04", "decision-no-status", `결정 ${d.id} 정의 근처에 상태 표지 없음`, [ev(d)]);

  for (const s of items(x.evidence.secondary_source_lines)) add("EVD-01", "secondary-source", `${s.system} 주장에 2차 표지 "${s.marker}"`, [ev(s)]);
  for (const s of items(x.evidence.external_claims_unmarked)) add("EVD-02", "external-claim-unmarked", `${s.system} 문장에 출처·표지 없음 [${s.role}]`, [ev(s)]);
  for (const u of items(x.evidence.unverified_items)) if (u.missing.length) add("EVD-04", "unverified-missing-fields", `미확인 항목에 ${u.missing.join("·")} 없음`, [ev(u)]);
  for (const n of items(x.numbers.unsourced_numbers)) add("EVD-05", "number-unsourced", `수치 ${n.value} 근처에 근거 표지 없음`, [ev(n)]);
  for (const r of x.threats.rows_without_id) add("THR-03", "threat-row-no-id", "위협 표 행이 요구·작업·검증 ID를 인용하지 않음", [ev(r)]);
  for (const p of x.numbers.parameter_checks || []) {
    if (p.status === "ok") continue;
    const crit = p.timing ? "FLR-03" : "EVD-05";
    const rel = { gte: "≥", lte: "≤", eq: "=" }[p.relation] || "?";
    const msg = p.status === "violated" ? `설정 ${p.key} = ${p.value}가 프로파일 ${p.parameter}(${p.expected})와 관계 "설정 ${rel} 값"을 어김`
      : p.status === "key-not-found" ? `프로파일 ${p.parameter}의 비교 키 ${p.key}를 묶음에서 찾지 못함`
      : `설정 ${p.key} = ${p.value}를 ${p.parameter}(${p.expected})와 같은 단위로 바꾸지 못해 대조 못 함`;
    add(crit, p.status === "violated" ? "parameter-mismatch" : `parameter-${p.status}`, msg, p.doc ? [ev(p)] : []);
  }
  for (const t of x.numbers.timing_settings) add("FLR-03", "timing-setting", `시간 설정 ${t.key} = ${t.values.join(" / ")}`, t.evidence);

  for (const h of items(x.duplicates.table_headers)) add("BND-01", "duplicate-table-header", `같은 표 머리가 ${h.docs.length}문서에 있음`, h.evidence);
  for (const l of items(x.duplicates.lines)) add("BND-01", "duplicate-line", `같은 줄이 ${l.docs.length}문서에 있음`, l.evidence);
  for (const p of items(x.duplicates.similar_paragraphs)) add("BND-01", "similar-paragraph", `문단 유사도 ${p.jaccard}`, p.evidence);
  for (const d of x.ids.duplicate_definitions) add("BND-01", "id-defined-in-multiple-docs", `${d.id} 정의가 ${d.docs.length}문서에 있음`, d.evidence);

  for (const o of x.baselines.off_baseline) add("BND-02", "commit-off-baseline", `커밋 ${o.value}가 프로파일 baseline과 다름`, o.evidence);

  for (const b of x.references.broken_links) add("BND-03", "broken-link", `링크 대상 없음: ${b.target}`, [ev(b)]);
  for (const b of x.references.broken_anchors) add("BND-03", "broken-anchor", `앵커 없음: ${b.target}`, [ev(b)]);
  for (const b of x.references.line_refs_out_of_range) add("BND-03", "line-ref-out-of-range", `줄 참조 ${b.target}가 대상 길이(${b.target_lines}) 밖`, [ev(b)]);
  for (const r of x.ids.ref_only_missing || []) add("BND-03", "ref-only-undefined", `${r.id}: ${r.target ? `${r.target}의 번호 목록에 ${r.number}번이 없음` : "defined_in 문서를 찾지 못함"}`, [ev(r)]);
  for (const u of x.ids.undefined_references) add("BND-03", "id-undefined", `${u.id}(${u.kind}) 참조 ${u.count}건, 묶음 안 정의 없음`, u.evidence);
  for (const t of items(x.references.time_statements)) add("BND-03", "time-statement", `시간 표현 "${t.word}" 문장(낡은 진행 상태 후보)`, [ev(t)]);

  for (const m of x.ids.mixed_schemes) add("BND-04", "mixed-scheme", `${m.doc}가 ${m.kind} 체계 ${m.by_pattern.length}개를 함께 씀: ${m.by_pattern.map((p) => `${p.pattern}×${p.count}`).join(", ")}`, m.by_pattern.map((p) => p.sample));
  for (const d of x.numbering.dual_numbering) add("BND-04", "dual-numbering", `${d.doc}에 "${d.label} N" 제목 번호(${d.heading_numbers.join(",")})와 번호 목록(${d.list_numbers.join(",")})이 함께 있음`, []);
  const amb = groupBy(x.numbering.label_references.filter((r) => r.class === "ambiguous"), (r) => `${r.label} ${r.number}`);
  for (const [k, rs] of amb) {
    const docs = [...new Set(rs.map((r) => r.doc))];
    add("BND-04", "label-ref-ambiguous", `"${k}" 인용 ${rs.length}건(${docs.length}문서): ${rs[0].target_doc}에 제목 번호·목록 번호가 둘 다 있어 어느 체계인지 판단 필요`, rs.map(ev), { target_doc: rs[0].target_doc, docs });
  }
  for (const r of x.numbering.label_references.filter((r) => r.class !== "ambiguous")) add("BND-04", `label-ref-${r.class}`, `"${r.label} ${r.number}" 인용: ${r.class === "ambiguous" ? "제목 번호·목록 번호 둘 다 있음(어느 체계인지 판단 필요)" : r.class === "list-only" ? "제목 번호에는 없고 목록 번호에만 있음" : "어느 번호에도 없음"}`, [ev(r)], { target_doc: r.target_doc });

  c.forEach((k, i) => { k.id = `C-${k.criterion}-${String(i + 1).padStart(4, "0")}`; k.doc_class = roleClass(k, roles); });
  return c;
}

// S 단독 기준(REQ-02)의 finding. 심각도는 참고값(핵심 흐름 여부는 판단하지 않았다).
export function buildScriptFindings(x, applicable) {
  const out = [];
  if (!applicable.has("REQ-02")) return out;
  let n = 0;
  for (const p of x.placeholders) {
    if (p.has_owner && (p.has_due || p.has_decision)) continue;
    n += 1;
    const sev = p.has_decision || p.section_has_decision ? "low" : "medium";
    out.push({
      id: `F-REQ-02-S${String(n).padStart(3, "0")}`,
      criterion: "REQ-02",
      title: `자리표시 "${p.token}"에 ${[!p.has_owner && "담당", !p.has_due && "기한", !p.has_decision && "결정 ID"].filter(Boolean).join("·")} 없음`,
      severity: sev,
      severity_note: "참고값: 핵심 흐름이면 high/medium, 부가 항목이면 low (판단 안 함)",
      confidence: "likely",
      scope_state: "changed",
      method: "S",
      evidence: [{ doc: p.doc, section: p.section, line: p.line, quote: p.quote }],
      absence: null,
      touches: ["REQ-02 판정 질문: 자리표시에 담당·기한·결정 ID가 붙었는가"],
      failure_scenario: "구현자가 자리표시를 추측으로 채운다",
      recommendation: "자리표시를 값으로 바꾸거나 결정 항목 ID·담당·기한을 붙인다",
      also_affects: [],
      source: "script",
      refutation: null,
    });
  }
  return out;
}
