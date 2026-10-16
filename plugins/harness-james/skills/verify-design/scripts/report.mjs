#!/usr/bin/env node
// 보고서 렌더러. framework.md 7.2 보고 형식을 따른다.
//
//   node report.mjs light <RUN_DIR> --out <보고서.md> [--per-criterion 12]   추출 후보만(판정 없음)
//   node report.mjs final <RUN_DIR> --out <보고서.md>                         standard·deep 판정 보고서
import { copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asArray, groupBy, readJson, writeText } from "./lib/util.mjs";
import { CONCRETE_KINDS, CRITERION_EXTRACTORS, KIND_PRIORITY, obligatedCandidates } from "./lib/candidates.mjs";
import { deepAdvice } from "./lib/estimate.mjs";
import { REFUTE_MAX, REFUTE_ORDER, modelAlias } from "./lib/verdict.mjs";

const CONCRETE_GROUPS = [
  ["은퇴 이름·ID", ["retired-term-live", "retired-id-reference"]],
  ["번호 체계 혼재", ["label-ref-list-only", "label-ref-undefined", "dual-numbering", "label-ref-ambiguous", "mixed-scheme"]],
  ["설정 충돌", ["config-conflict", "parameter-mismatch"]],
  ["깨진 참조", ["broken-link", "broken-anchor", "line-ref-out-of-range", "id-undefined", "ref-only-undefined"]],
  ["범위·머리말", ["range-mismatch", "header-version", "header-date"]],
];
const cands0 = (x) => x.candidates.filter((c) => c.applicable);

const kindRank = (k) => { const i = KIND_PRIORITY.indexOf(k); return i < 0 ? KIND_PRIORITY.length : i; };

const cell = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
const locStr = (e) => (e ? `${e.doc.split("/").slice(-2).join("/")}:${e.line}` : "");
const row = (xs) => `| ${xs.map(cell).join(" | ")} |`;
const table = (head, rows) => [row(head), `|${head.map(() => "---").join("|")}|`, ...rows.map(row)].join("\n");

const STATUS_KO = { "to-evaluate": "추출함(판정 안 함)", evaluated: "evaluated", "not-applicable": "not-applicable", disabled: "disabled", "skipped-unchanged": "skipped-unchanged", missing: "상태 없음" };

function header(x, extra = []) {
  const docs = table(["문서", "역할", "줄", "해시"], x.documents.map((d) => [d.path, d.role, d.lines, d.hash]));
  const lines = [
    `- 프로파일: \`${x.profile.key}\` ${x.profile.version} (맞춘 rubric ${x.profile.rubric_version}) · rubric ${x.rubric.version}`,
    `- 실행 시각: ${x.generated_at}${x.label ? ` · 라벨 \`${x.label}\`` : ""}`,
    `- traits: ${x.profile.traits.join(", ")}`,
    x.path_maps?.length ? `- 경로 덮어쓰기: ${x.path_maps.map((m) => `\`${m}\``).join(", ")}` : null,
    x.changed ? `- 증분: 이전 색인 대비 바뀐 문서 ${x.changed.documents.length}개, 절 ${x.changed.sections.length}개, 삭제 문서 ${x.changed.removed_documents.length}개` : "- 증분: 없음(전체)",
    `- 분량: ${x.estimate.cost_line}`,
    ...extra,
  ].filter(Boolean);
  const unread = x.unreadable.length ? `\n읽지 않은 파일: ${x.unreadable.map((u) => `\`${u.path}\`(${u.reason})`).join(", ")}\n` : "";
  const perr = x.profile_errors.length ? `\n**프로파일 오류**\n${x.profile_errors.map((e) => `- ${e}`).join("\n")}\n` : "";
  return `${lines.join("\n")}\n${perr}\n<details><summary>묶음 문서 ${x.documents.length}개</summary>\n\n${docs}\n${unread}\n</details>\n`;
}

// ---------------------------------------------------------------- light
export function renderLight(x, { perGroup = 40 } = {}) {
  const out = [];
  const applicable = x.criteria_status.filter((c) => c.status === "to-evaluate");
  const sCrit = applicable.filter((c) => c.method.split("+").includes("S") || CRITERION_EXTRACTORS[c.id]);
  const concrete = cands0(x).filter((c) => CONCRETE_KINDS.includes(c.kind));
  const cands = x.candidates.filter((c) => c.applicable);
  const byCrit = groupBy(cands, (c) => c.criterion);
  const design = cands.filter((c) => c.doc_class !== "input");

  out.push(`# 설계 검증 light — ${x.profile.key}${x.label ? ` · ${x.label}` : ""}`);
  out.push("");
  out.push("> **light = 스크립트(S) 추출만. LLM 판단·판정·반증 없음.** 아래는 결함이 아니라 *후보*다. `S` 단독 기준(REQ-02)만 finding을 내고, 심각도는 참고값이다. 판정이 필요하면 standard를 돌린다.");
  out.push("");
  const advice = x.deep_advice ?? deepAdvice(x.profile.traits);
  out.push(header(x, [`- 검사 방법: S 수행 · L·X·H 수행 안 함 · 모델 없음`, advice ? `- **${advice}**` : null]));
  out.push("## 요약");
  out.push("");
  out.push(`- 적용 기준 ${applicable.length}개 중 S 추출 대상 ${sCrit.length}개(보조 S 포함). 후보 ${cands.length}건(정본 쪽 문서 ${design.length} · 입력 문서만 ${cands.length - design.length}). 후보 중 구체 종류 ${concrete.length}건(표), 나머지 ${cands.length - concrete.length}건(개수만). S 단독 finding ${x.script_findings.length}건.`);
  const topCrit = [...byCrit.entries()].map(([k, v]) => `${k} ${v.length}`).join(" · ");
  out.push(`- 기준별 후보: ${topCrit || "없음"}`);
  out.push(`- 판정자 처리 목록: 정본 쪽 구체 후보 ${obligatedCandidates(cands).length}건(아래 표는 묶음마다 최대 ${perGroup}건만 보인다). standard·deep 판정 출력은 이 후보마다 채택(finding ID) 또는 기각(이유)을 적는다(\`extract/index.json\`의 \`obligated_candidates\`).`);
  out.push(`- 판정자 입력: \`extract/index.json\`(요약 색인) + \`extract/<차원>.json\`(정본 쪽 후보) · 입력 문서에만 있는 후보는 개수만, 목록은 \`extract/<차원>.input.json\`. 스크립트용 전체: \`extract.json\`.`);
  out.push("");

  out.push("## S 단독 finding (REQ-02, 심각도 참고값)");
  out.push("");
  out.push(x.script_findings.length ? table(["ID", "기준", "심각도(참고)", "신뢰도", "위치", "인용", "권고"], x.script_findings.map((f) => [f.id, f.criterion, f.severity, f.confidence, locStr(f.evidence[0]), f.evidence[0].quote, f.recommendation])) : "없음");
  out.push("");

  // 구체 종류: 표로 보인다(정본 쪽 문서). 입력 문서(원자료·점검 보고서)에만 있는 후보는 개수만.
  out.push("## 구체 후보 (표)");
  out.push("");
  out.push(`종류 묶음마다 정본 쪽 문서 후보를 최대 ${perGroup}건 보인다. 원자료·점검 보고서(\`source-material\`·\`review-input\`)에만 있는 후보는 개수만 적는다.`);
  out.push("");
  for (const [title, kinds] of CONCRETE_GROUPS) {
    const list = cands.filter((k) => kinds.includes(k.kind)).sort((p, q) => kindRank(p.kind) - kindRank(q.kind) || p.criterion.localeCompare(q.criterion));
    const d = list.filter((k) => k.doc_class !== "input");
    out.push(`### ${title} — ${list.length}건${list.length - d.length ? ` (입력 문서만 ${list.length - d.length})` : ""}`);
    out.push("");
    if (!list.length) { out.push("없음."); out.push(""); continue; }
    const shown = d.slice(0, perGroup);
    if (shown.length) out.push(table(["후보", "기준", "종류", "요지", "위치", "인용"], shown.map((k) => [k.id, k.criterion, k.kind, k.summary, k.evidence.slice(0, 3).map(locStr).join(", "), k.evidence[0]?.quote || ""])));
    if (d.length > shown.length) out.push(`\n… 정본 쪽 ${d.length - shown.length}건 더 있음(\`extract/<차원>.json\`).`);
    out.push("");
  }

  // 그 밖 종류: 개수만. standard·deep 입력(extract/<차원>.json)으로는 전부 넘어간다.
  const others = cands.filter((k) => !CONCRETE_KINDS.includes(k.kind));
  out.push("## 그 밖 후보 (개수만)");
  out.push("");
  out.push("판단이 필요한 종류라 light에서는 개수만 적는다. standard·deep 판정자는 정본 쪽 후보를 `extract/<차원>.json`에서 받고, 입력 문서에만 있는 후보는 개수만 받는다(목록은 `extract/<차원>.input.json`).");
  out.push("");
  const og = [...groupBy(others, (k) => `${k.criterion}\u0000${k.kind}`).entries()].sort((a, b) => a[0].localeCompare(b[0]));
  out.push(og.length ? table(["기준", "종류", "후보", "정본 쪽", "입력 문서만"], og.map(([key, v]) => { const [cr, kd] = key.split("\u0000"); const dd = v.filter((k) => k.doc_class !== "input").length; return [cr, kd, v.length, dd, v.length - dd]; })) : "없음");
  out.push("");
  const cov = asArray(x.extract.trace.coverage);
  if (cov.length) {
    const pct = (k) => Math.round((100 * cov.filter((c) => c[k] > 0).length) / cov.length);
    out.push(`요구 ID 인용 커버리지(TRC 참고): 요구 ${cov.length}개 · 설계 ${pct("design")}% · 작업 ${pct("tasks")}% · 검증 ${pct("verification")}%.`);
    out.push("");
  }

  out.push("## 기준별 상태");
  out.push("");
  out.push(table(["기준", "범위", "방법", "상태", "후보", "사유"], x.criteria_status.map((c) => [c.id, c.scope, c.method, c.status === "to-evaluate" ? (c.method.split("+").includes("S") || CRITERION_EXTRACTORS[c.id] ? "추출함(판정 안 함)" : "light 대상 아님(L·X·H)") : STATUS_KO[c.status] || c.status, (byCrit.get(c.id) || []).length, c.reason || ""])));
  out.push("");
  return out.join("\n");
}

// 요청 모델은 별칭(fable·opus)으로, 실행 모델 ID는 확인했을 때만 적는다(B11·C6).
export function modelStr(requested, observed) {
  if (!requested) return "`?`";
  const req = modelAlias(requested);
  if (!observed) return `\`${req}\`(요청 별칭, 실행 모델 미확인)`;
  return modelAlias(observed) === req ? `\`${req}\` → 실행 \`${observed}\`(확인)` : `\`${req}\` → 실행 \`${observed}\`(확인, 요청과 다름)`;
}

// ---------------------------------------------------------------- final (standard·deep)
export function renderFinal(x, f, v) {
  const out = [];
  const icon = { REVISE: "⛔", REVIEW_REQUIRED: "⚠️", PROCEED: "✅" }[v.verdict] || "";
  const methods = f.level === "light" ? "S" : "S 수행 · L 수행 · X·H는 확인 목록으로";
  out.push(`# 설계 검증 ${f.level} — ${x.profile.key}${x.label ? ` · ${x.label}` : ""}`);
  out.push("");
  out.push(`**${icon} ${v.verdict}** · finding ${f.findings.length}건 (critical ${v.severity_counts.critical} · high ${v.severity_counts.high} · medium ${v.severity_counts.medium} · low ${v.severity_counts.low} · info ${v.severity_counts.info}) · 반증 기각 ${f.rejected.length}건`);
  out.push("");
  const advice = f.level !== "deep" ? (x.deep_advice ?? deepAdvice(x.profile.traits)) : null;
  for (const w of asArray(v.incomplete_warnings)) out.push(`> ⚠️ 평가 불완전 경고(판정은 그대로): ${w}\n`);
  out.push(header(x, [`- 검사 방법: ${methods}`, `- 모델: 판정 ${modelStr(f.models.judge, f.models.judge_observed)} · 반증 ${modelStr(f.models.refuter, f.models.refuter_observed)}`, advice ? `- **${advice}**` : null]));
  out.push("## 판정 사유");
  out.push("");
  const trig = [...v.triggers.revise.map((t) => `- REVISE: ${t}`), ...v.triggers.review.map((t) => `- REVIEW_REQUIRED: ${t}`)];
  out.push(trig.length ? trig.join("\n") : "- 해당 없음(PROCEED)");
  if (v.incomplete.length) out.push(`\n평가 불완전: ${v.incomplete.join(" · ")}`);
  if (asArray(v.excluded).length) out.push(`\n제외 문서(의도적 제외: 프로파일 readable:false·exclude, 미평가 아님): ${v.excluded.map((p) => `\`${p}\``).join(", ")}`);
  const ud = v.unread_detail;
  if (ud && ud.raw_count) out.push(`\n판정자 미독 목록 ${ud.raw_count}개 → 묶음 문서로 정리(어느 판정자도 읽지 않은 것만): 정본 쪽 ${ud.design.length}(평가 불완전) · 원자료 ${ud.input.length}(REVIEW_REQUIRED) · 묶음 밖 ${ud.outside.length}(판정에 안 씀)`);
  if (asArray(v.unread_inputs).length) out.push(`\n원자료 미독(어느 판정자도 읽지 않은 입력 문서, 사람이 확인): ${v.unread_inputs.map((p) => `\`${p}\``).join(", ")}`);
  out.push("");
  if (v.criterion_risk.length) {
    out.push(table(["기준", "R(c)", "임계값", "가중치"], v.criterion_risk.map((r) => [r.id, r.R, r.threshold, r.weight])));
    out.push("");
  }
  out.push("## Finding");
  out.push("");
  const fs = f.findings.filter((x2) => x2.scope_state !== "carried" || !x.changed);
  out.push(fs.length ? table(["ID", "기준", "심각도", "신뢰도", "위치(문서§)", "인용", "실패 시나리오", "권고", "반증"], fs.map((k) => {
    const e = asArray(k.evidence)[0];
    const where = e ? `${locStr(e)} §${e.section || ""}` : `부재: ${asArray(k.absence?.searched).slice(0, 2).join(", ")}`;
    const ref = !k.refutation ? "—" : k.not_refuted_cap ? "상한 밖(반증 안 함)" : `${k.refutation.verdict}${k.refutation.model ? ` · ${k.refutation.model}` : ""}`;
    return [k.id, k.criterion, k.severity + (k.severity_before ? ` (←${k.severity_before})` : ""), k.confidence, where, e?.quote || k.absence?.result || "", k.failure_scenario, k.recommendation, ref];
  })) : "없음");
  out.push("");
  const conflicts = asArray(f.recommendation_conflicts);
  out.push("### 권고 충돌 (서로 반대 방향인 권고, framework 7.5)");
  out.push("");
  out.push(conflicts.length ? table(["finding A", "finding B", "어긋나는 점"], conflicts.map((c) => [asArray(c.findings)[0], asArray(c.findings)[1], c.note || ""])) : "없음");
  out.push("");
  const ds = f.dispositions_summary;
  if (ds) {
    out.push(`### 구체 후보 처리표 (light 구체 후보 ${ds.required}건, framework 7.4)`);
    out.push("");
    out.push(`- 채택 ${ds.adopted} · 기각 ${ds.rejected} · **처리 기록 없음 ${ds.missing.length}**`);
    const byId = new Map(asArray(x.candidates).map((c) => [c.id, c]));
    const dmap = new Map(asArray(f.candidate_dispositions).map((d) => [d.candidate, d]));
    const ids = [...new Set([...dmap.keys(), ...ds.missing])];
    if (ids.length) {
      const rows = ids.map((id) => {
        const c = byId.get(id);
        const d = dmap.get(id);
        const how = !d ? "처리 기록 없음" : d.disposition === "adopted" ? `채택 → ${d.finding}` : `기각 → ${d.reason || ""}`;
        return [id, c?.criterion || "", locStr(c?.evidence?.[0]), how];
      });
      out.push(`\n<details><summary>후보 ${rows.length}건</summary>\n\n${table(["후보 ID", "기준", "위치", "처리"], rows)}\n\n</details>`);
    }
    out.push("");
  }
  const carried = f.findings.filter((k) => k.scope_state === "carried");
  if (x.changed && carried.length) {
    out.push(`### 이월(carried, 참고) ${carried.length}건`);
    out.push("");
    out.push(table(["ID", "기준", "심각도", "위치"], carried.map((k) => [k.id, k.criterion, k.severity, locStr(asArray(k.evidence)[0])])));
    out.push("");
  }
  if (Object.keys(f.overflow).length) {
    out.push("### 상한 밖 (요약만)");
    out.push("");
    out.push(table(["기준", "개수", "대표 위치"], Object.entries(f.overflow).map(([k, o]) => [k, o.count, o.locations.join(", ")])));
    out.push("");
  }
  const highs = f.findings.filter((k) => ["critical", "high"].includes(k.severity_before || k.severity) || k.refutation);
  const refuted = [...highs.filter((k) => k.refutation && !k.not_refuted_cap), ...f.rejected];
  const capped = highs.filter((k) => k.not_refuted_cap);
  out.push(`### 반증 (순서: ${REFUTE_ORDER} · 상한 ${f.limits?.refute ?? REFUTE_MAX}건)`);
  out.push("");
  out.push(`- 반증함 ${refuted.length}건: ${refuted.map((k) => `${k.id}(${k.refutation?.verdict})`).join(", ") || "없음"}`);
  out.push(`- 상한 밖이라 반증하지 않음 ${capped.length}건(uncertain → 사람 검토): ${capped.map((k) => k.id).join(", ") || "없음"}`);
  out.push("");
  if (f.rejected.length) {
    out.push("### 반증으로 기각");
    out.push("");
    out.push(table(["ID", "기준", "원 심각도", "반증 메모"], f.rejected.map((k) => [k.id, k.criterion, k.severity, k.refutation?.note || ""])));
    out.push("");
  }
  if (asArray(f.external_checks).length) {
    out.push("## 외부 확인 목록");
    out.push("");
    out.push(table(["주장", "위치", "필요한 1차 출처", "담당", "틀렸을 때 영향"], f.external_checks.map((c) => [c.claim, c.location, c.primary_source_needed, c.owner, c.impact_if_wrong])));
    out.push("");
  }
  if (f.coverage && asArray(f.coverage.rows).length) {
    out.push("## 커버리지");
    out.push("");
    out.push(table(["요구 ID", "설계", "작업", "검증", "비고"], f.coverage.rows.map((r) => [r.id, r.design, r.tasks, r.verification, r.note])));
    out.push("");
  }
  out.push("## 기준별 상태");
  out.push("");
  const cnt = groupBy(f.findings, (k) => k.criterion);
  out.push(table(["기준", "상태", "finding", "메모"], f.criteria.map((c) => [c.id, STATUS_KO[c.status] || c.status, (cnt.get(c.id) || []).length, c.note || ""])));
  out.push("");
  return out.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, runDir, ...rest] = process.argv.slice(2);
  const o = (n, d = null) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : d; };
  const outPath = o("--out");
  if (!mode || !runDir || !outPath) { console.error("사용: report.mjs light|final <RUN_DIR> --out <파일>"); process.exit(2); }
  const x = readJson(join(runDir, "extract.json"));
  let md;
  if (mode === "light") md = renderLight(x, { perGroup: Number(o("--per-group", 40)) });
  else if (mode === "final") md = renderFinal(x, readJson(join(runDir, "findings.json")), readJson(join(runDir, "verdict.json")));
  else { console.error(`알 수 없는 모드: ${mode}`); process.exit(2); }
  writeText(outPath, md + "\n");
  console.log(`REPORT=${resolve(outPath)}`);
  // --with-artifacts: 보고서 옆에 <이름>.findings.json · <이름>.index.json 을 둔다(다음 증분 검증의 기준)
  if (rest.includes("--with-artifacts")) {
    const base = outPath.replace(/\.md$/, "");
    const findings = mode === "final" ? readJson(join(runDir, "findings.json")) : { schema: "findings/0.1.0", level: "light", label: x.label, profile: x.profile, findings: x.script_findings, candidates_count: x.candidates.length };
    writeText(`${base}.findings.json`, JSON.stringify(findings, null, 2) + "\n");
    copyFileSync(join(runDir, "section-index.json"), `${base}.index.json`);
    console.log(`FINDINGS=${resolve(base + ".findings.json")}`);
    console.log(`INDEX=${resolve(base + ".index.json")}`);
  }
}
