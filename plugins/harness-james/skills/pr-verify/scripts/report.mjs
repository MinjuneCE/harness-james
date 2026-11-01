#!/usr/bin/env node
// /pr-verify 리포트: scores.json + context.json + packets/*.md → <평가 폴더>/reports/<repo>/<날짜>-<브랜치>-<sha7>.{md,json} + index.json
// 사용: node report.mjs <run_dir>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { evalDir, findWorkspace, kstStamp, readJson, writeJson } from "./lib.mjs";

const ws = findWorkspace();
const runDir = resolve(ws, process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(runDir, "scores.json"))) {
  console.error("사용: node report.mjs <run_dir>  (먼저 score.mjs 실행)");
  process.exit(2);
}
const ctx = readJson(join(runDir, "context.json"));
const sc = readJson(join(runDir, "scores.json"));
const scoring = readJson(resolve(ws, ctx.versions.scoring.path));

const ICON = { PASS: "✅ PASS", REVIEW_REQUIRED: "⚠️ REVIEW_REQUIRED", BLOCK: "⛔ BLOCK" };
const SEV = { critical: "Critical", high: "High", medium: "Medium", low: "Low", info: "Info" };
const ORIGIN = { introduced: "신규", worsened: "악화", "pre-existing": "기존 부채", fixed: "해결" };
const VERDICT = { upheld: "유지", downgraded: "하향", rejected: "기각", uncertain: "불확실" };
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");
const ev = (e) => `\`${e.file}:${e.line}${e.end_line && e.end_line !== e.line ? `-${e.end_line}` : ""}\`${e.side === "base" ? " (이전 코드)" : ""}`;
const slug = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s/g, "-");
const short = (sha) => (sha ? sha.slice(0, 7) : "-");
const fmt = (x) => (x === null || x === undefined ? "-" : Number.isInteger(x) ? String(x) : x.toFixed(1));

const t = ctx.target;
const b = ctx.base;
const stamp = kstStamp(new Date(ctx.created_at));
const branchSlug = (t.branch ?? (t.pr ? `pr-${t.pr.number}` : "detached")).replace(/[^A-Za-z0-9._-]+/g, "-");
const outDir = join(evalDir(ws), ctx.repo_override ? "calibration/reports" : "reports", ctx.repo.name);
mkdirSync(outDir, { recursive: true });
const baseName = `${stamp.compact.slice(0, 13)}-${branchSlug}-${short(t.sha)}`;
const mdPath = join(outDir, `${baseName}.md`);
const jsonPath = join(outDir, `${baseName}.json`);

const L = [];
const P = (...xs) => L.push(...xs);

function findingBlock(f) {
  const v = f.verification;
  const sevNote = f.original && f.original.severity !== f.severity ? ` (원래 ${SEV[f.original.severity]})` : "";
  P(`#### ${f.id} · ${SEV[f.severity]}${sevNote} · ${f.confidence} — ${esc(f.title)}`);
  P("");
  P(`- 기준: \`${f.criterion}\` ${esc(ctx.criteria[f.criterion]?.name ?? "")} · 출처: ${ORIGIN[f.origin]} · 수집: ${f.source}${f.points ? ` · ${f.points}점` : ""}`);
  P(`- 근거: ${(f.evidence ?? []).map(ev).join(", ")}${f.match_count > (f.evidence ?? []).length ? ` 외 ${f.match_count - f.evidence.length}곳` : ""}`);
  if (f.failure_scenario) P(`- 실패 시나리오: ${esc(f.failure_scenario)}`);
  if (f.rationale) P(`- 판단 근거: ${esc(f.rationale)}`);
  if (f.recommendation) P(`- 권장 조치: ${esc(f.recommendation)}`);
  if (f.structures?.length) P(`- 관련 구조: ${f.structures.map((s) => `\`${s}\``).join(", ")}`);
  if (f.also_affects?.length) P(`- 다른 차원 영향: ${f.also_affects.join(", ")}`);
  if (v) P(`- 반증: **${VERDICT[v.verdict]}**${v.severity_after ? ` → ${SEV[v.severity_after]}` : ""} — ${esc(v.reason)}`);
  P("");
}

// ---------- 머리말 ----------
P(`# PR 검증 리포트 — ${ctx.repo.name} \`${t.branch ?? t.ref}\` → \`${b.ref.replace(/^origin\//, "")}\``, "");
P("| 항목 | 값 |", "|---|---|");
P(`| 판정 | **${ICON[sc.gate]}** |`);
P(`| 종합 품질 | **${fmt(sc.overall.score)}** / 100 (차단선 ${sc.overall.floor}) |`);
P(`| 대상 | \`${t.branch ?? t.ref}\` @ \`${short(t.sha)}\`${t.pr ? ` · PR [#${t.pr.number}](${t.pr.url}) ${esc(t.pr.title)}` : ""} |`);
P(`| base | \`${b.ref}\` @ \`${short(b.sha)}\` (merge-base \`${short(b.merge_base)}\`) |`);
P(`| 모드 | ${ctx.mode === "full" ? "전체" : "증분"}${ctx.fork_point ? ` · 갈림점 \`${short(ctx.fork_point)}\`${ctx.fork_point === b.merge_base ? " (= merge-base)" : ""}` : ""} |`);
P(`| 변경 | 파일 ${ctx.diff.totals.files}개 · +${ctx.diff.totals.added} −${ctx.diff.totals.removed} · 동작 변경 ${ctx.diff.totals.behavioral}줄 |`);
P(`| 실행 | ${stamp.human} · \`${ctx.run_id}\` |`);
P(`| 시즌 모드 | ${sc.season.active ? `ON (${sc.season.label}) — 임계값 ×${scoring.season.review_threshold_factor}, 차단선 +${scoring.season.floor_add}` : "off"} |`);
P(`| 모델 | 판정 ${[...new Set(Object.values(sc.models.judges))].join(", ") || "-"} · 반증 ${[...new Set(sc.models.refuters.map((r) => r.model))].join(", ") || "-"} · effort ${scoring.model_policy.required_effort} |`);
P(`| 기준 버전 | scoring ${ctx.versions.scoring.version} · profile ${ctx.versions.profile.version} · rubric bundle \`${ctx.versions.rubric_bundle_sha256.slice(0, 12)}\` |`);
P("");

// ---------- 요약 ----------
P("## 요약", "");
if (sc.block_reasons.length) {
  P("**차단 사유**", "");
  for (const r of sc.block_reasons) P(`- ⛔ ${esc(r.label)}`);
  P("");
}
if (sc.triggers.length) {
  P("**직접 검토 트리거**", "");
  for (const tr of sc.triggers) P(`- ⚠️ [${tr.key}](#${slug(tr.key)}) ${esc(tr.label)}${tr.value !== null ? ` — ${fmt(tr.value)} ≥ ${tr.threshold ?? "-"}` : ""}`);
  P("");
}
if (!sc.block_reasons.length && !sc.triggers.length) P("차단 사유와 검토 트리거가 없습니다.", "");
const counted = sc.findings.counted;
const bySev = (s) => counted.filter((f) => f.severity === s).length;
P(`감점 finding ${counted.length}건 (Critical ${bySev("critical")} · High ${bySev("high")} · Medium ${bySev("medium")} · Low ${bySev("low")}), 기존 부채 ${sc.findings.pre_existing.length}건, 해결 ${sc.findings.fixed.length}건, 반증 기각 ${sc.findings.rejected.length}건.`, "");

// ---------- 품질 점수 ----------
P("## 품질 점수", "", "| 차원 | 품질 | 차단선 | 가중치 | 위험도 상위 기준 |", "|---|---:|---:|---:|---|");
for (const d of sc.dimensions) {
  const top = d.criteria.filter((c) => c.risk > 0).sort((a, b) => b.risk - a.risk).slice(0, 3).map((c) => `${c.id} ${fmt(c.risk)}`).join(", ");
  P(`| ${d.id} ${d.name} | ${d.score < d.floor ? `**${fmt(d.score)}**` : fmt(d.score)} | ${d.floor} | ${d.weight_effective} | ${top || "-"} |`);
}
P(`| **종합** | **${fmt(sc.overall.score)}** | ${sc.overall.floor} | | |`, "");

// ---------- 트리거와 검토 패킷 ----------
if (sc.triggers.length) {
  P("## 직접 검토 트리거", "");
  for (const tr of sc.triggers) {
    P(`### ${tr.key}`, "");
    P(`**${esc(tr.label)}**${tr.value !== null ? ` — ${tr.kind === "structure" || tr.kind === "freeze" ? "구조 영향도" : "기준 위험도"} ${fmt(tr.value)}${tr.threshold !== null ? ` ≥ 임계값 ${tr.threshold}` : ""}` : ""}`, "");
    if (tr.kind === "structure" || tr.kind === "freeze") {
      const s = sc.structures.find((x) => x.id === tr.ref);
      if (s) P(`- 산식: 중요도 ${s.criticality} × 변경 규모 ${s.magnitude} (동작 변경 ${s.behavioral_lines}줄)${s.finding_bonus ? ` + finding 가산 ${scoring.structure_impact.finding_bonus}` : ""} = ${s.impact}`, `- 파일: ${s.files.map((f) => `\`${f}\``).join(", ")}`);
    }
    if (tr.finding_ids.length) {
      const fs = tr.finding_ids.map((id) => counted.find((f) => f.id === id)).filter(Boolean);
      P(`- 구성 finding: ${fs.map((f) => `${f.id}(${SEV[f.severity]}·${f.confidence} ${f.points}점)`).join(", ")}`);
    }
    P("");
    const pk = join(runDir, tr.packet);
    if (existsSync(pk)) {
      // 패킷의 가장 높은 제목이 트리거 제목(###) 바로 아래(####)가 되도록 단계를 맞춘다
      const body = readFileSync(pk, "utf8").trim();
      const levels = [...body.matchAll(/^(#{1,6}) /gm)].map((m) => m[1].length);
      const shift = levels.length ? 4 - Math.min(...levels) : 0;
      P(body.replace(/^(#{1,6}) /gm, (_, h) => `${"#".repeat(Math.min(6, Math.max(4, h.length + shift)))} `), "");
    }
    else P("> 검토 패킷이 생성되지 않았습니다.", "");
  }
}

// ---------- finding ----------
P("## 감점 finding", "");
if (!counted.length) P("없음.", "");
for (const f of counted) findingBlock(f);

if (sc.findings.pre_existing.length) {
  P("## 참고: 건드린 영역의 기존 부채 (감점 없음)", "");
  for (const f of sc.findings.pre_existing) findingBlock(f);
}
if (sc.findings.fixed.length) {
  P("## 개선: 이 PR이 해결한 문제", "");
  for (const f of sc.findings.fixed) findingBlock(f);
}
if (sc.findings.rejected.length) {
  P("## 반증에서 기각된 finding", "");
  for (const f of sc.findings.rejected) findingBlock(f);
}
if (sc.findings.merged?.length) {
  P("## 중복 병합 (같은 기준·같은 위치)", "", "| finding | 병합 대상 | 기준 |", "|---|---|---|");
  for (const f of sc.findings.merged) P(`| ${f.id} ${esc(f.title)} | ${f.merged_into} | ${f.criterion} |`);
  P("");
}
if (sc.reclassified.length) {
  P("## 출처 자동 재분류", "", "| finding | 변경 | 사유 |", "|---|---|---|");
  for (const r of sc.reclassified) P(`| ${r.id} | ${ORIGIN[r.from]} → ${ORIGIN[r.to]} | ${esc(r.reason)} |`);
  P("");
}

// ---------- 평가 범위 ----------
P("## 평가 범위 (기준별)", "", "| 기준 | 상태 | 위험도 | 임계값 | 메모 |", "|---|---|---:|---:|---|");
for (const d of sc.dimensions) for (const c of d.criteria) P(`| ${c.id} ${esc(c.name)} | ${c.status} | ${fmt(c.risk)} | ${c.review_threshold} | ${esc(c.note).slice(0, 160)} |`);
P("");

P("## 변경 요약", "", "| 구조 | 중요도 | 동작 변경 줄 | 영향도 | 임계값 |", "|---|---:|---:|---:|---:|");
for (const s of sc.structures.filter((s) => s.touched)) P(`| \`${s.id}\` ${esc(s.name)} | ${s.criticality} | ${s.behavioral_lines} | ${s.impact} | ${s.review_threshold} |`);
if (!sc.structures.some((s) => s.touched)) P("| (핵심 구조 변경 없음) | | | | |");
P("");
P("<details><summary>변경 파일</summary>", "", "| 파일 | 상태 | + | − | 동작 | 구조 |", "|---|---|---:|---:|---:|---|");
for (const f of ctx.diff.files) P(`| \`${f.path}\`${f.old_path ? ` ← \`${f.old_path}\`` : ""} | ${f.status}${f.binary ? " (바이너리)" : ""} | ${f.added} | ${f.removed} | ${f.behavioral} | ${f.structures.join(", ")} |`);
P("", "</details>", "");

P("## 자동 신호", "");
P(`- 규칙 finding ${ctx.signals.rule_findings.length}건, 도구 finding ${ctx.signals.tool_findings.length}건`);
for (const r of ctx.signals.tool_runs) P(`- ${r.tool}: ${r.status}${r.note ? ` (${esc(r.note)})` : ""}${r.head_offenses !== null && r.head_offenses !== undefined ? ` · 오프펜스 base ${r.base_offenses} → head ${r.head_offenses}, 변경 파일 신규 ${r.introduced}` : ""}${r.unmapped && Object.keys(r.unmapped).length ? ` · 기준 미매핑 ${Object.entries(r.unmapped).map(([k, v]) => `${k} ${v}`).join(", ")}` : ""}`);
for (const w of ctx.warnings) P(`- ⚠ ${esc(w)}`);
P("");

// diff 밖 결정적 신호: 전체 모드는 판정 자료, 증분 모드는 누적 범위 info. 둘 다 점수에 넣지 않는다
const os = ctx.outside_signals;
if (os) {
  const SEVS = ["FAIL", "WARN", "INFO"];
  P(ctx.mode === "full" ? "## 결정적 신호" : "## 증분 범위 밖 누적 신호", "");
  P(`갈림점 \`${short(os.base)}\`..\`${short(t.sha)}\` 기준 · 점수에 넣지 않음 · 도구 시간 ${(os.elapsed_ms / 1000).toFixed(1)}초 · 자료 \`${os.summary}\``, "");
  P("| 도구 | 상태 | 항목 | 메모 |", "|---|---|---:|---|");
  for (const x of os.tools) P(`| ${x.tool} | ${x.status} | ${x.items}${x.items ? ` (${SEVS.filter((v) => x.by_severity[v]).map((v) => `${v} ${x.by_severity[v]}`).join(" · ")})` : ""} | ${esc(x.note ?? "")} |`);
  P("");
  const items = [];
  for (const x of os.tools) {
    if (!x.json || !x.items) continue;
    try { for (const it of readJson(join(ws, x.json)).items ?? []) items.push({ tool: x.tool, ...it }); } catch {}
  }
  const shown = items.filter((it) => it.severity !== "INFO").sort((a, c) => SEVS.indexOf(a.severity) - SEVS.indexOf(c.severity));
  for (const it of shown.slice(0, 50)) {
    const at = [...(it.head ?? []).map((e) => `\`${e.file}:${e.line}\``), ...(it.base ?? []).map((e) => `\`${e.file}:${e.line}\` (갈림점)`)].slice(0, 3).join(", ");
    P(`- ${it.severity} \`${it.tool}\` ${it.kind} \`${esc(it.symbol)}\` — ${esc(it.message)}${at ? ` (${at})` : ""}`);
  }
  if (shown.length > 50) P(`- … 외 ${shown.length - 50}건`);
  if (items.length > shown.length) P(`- INFO ${items.length - shown.length}건은 \`${os.summary}\`에 있음`);
  if (os.replicas?.length) P(`- 다른 레포 복제본 ${os.replicas.length}건: ${os.replicas.map((r) => `${r.repo} \`${r.path}\`${r.missing ? ` (못 가져옴: ${esc(r.missing)})` : ""}`).join(", ")}`);
  P("");
}
if (sc.issues.length) {
  P("## 평가 불완전 사유", "");
  for (const i of sc.issues) P(`- ${esc(i)}`);
  P("");
}
P("---", `_생성: /pr-verify${ctx.repo_override ? " (보정 실행 — PR 게이트에 반영 안 됨)" : ""} · 실행 산출물 \`${ctx.run_dir}\` · 산식 ${frameworkRef()}_`, "");

writeFileSync(mdPath, L.join("\n"));
const summary = {
  report: relative(ws, mdPath),
  json: relative(ws, jsonPath),
  repo: ctx.repo.name,
  run_id: ctx.run_id,
  created_at: ctx.created_at,
  target: t,
  base: b,
  gate: sc.gate,
  overall: sc.overall,
  dimensions: sc.dimensions.map((d) => ({ id: d.id, score: d.score, floor: d.floor })),
  triggers: sc.triggers.map((x) => ({ key: x.key, label: x.label, value: x.value, threshold: x.threshold })),
  block_reasons: sc.block_reasons,
  season: sc.season,
  versions: ctx.versions,
  models: sc.models,
};
writeJson(jsonPath, { ...summary, scores: sc, context: { ...ctx, diff: { ...ctx.diff, files: ctx.diff.files.map(({ hunks, added_lines, removed_lines, ...f }) => f) } } });

const indexPath = join(outDir, "index.json");
const index = existsSync(indexPath) ? readJson(indexPath) : { repo: ctx.repo.name, by_sha: {} };
index.by_sha[t.sha] = {
  gate: sc.gate, overall: sc.overall.score, report: summary.report, json: summary.json, created_at: ctx.created_at,
  branch: t.branch, base: b.ref, run_id: ctx.run_id, triggers: sc.triggers.length, block_reasons: sc.block_reasons.length, season: sc.season.active,
  // PR 게이트: 장기 브랜치는 mode "full"이고 base_sha가 merge-base(origin/<PR base>, head)여야 통과
  mode: ctx.mode ?? "incremental", base_sha: b.merge_base, fork_point: ctx.fork_point ?? null,
};
// 검증 범위 장부: PR 게이트가 "어느 검증 범위에도 안 든 커밋"을 센다. 같은 실행을 다시 리포트하면 한 번만 남긴다
index.ranges = (index.ranges ?? []).filter((r) => r.run_id !== ctx.run_id);
index.ranges.push({ base: b.merge_base, head: t.sha, run_id: ctx.run_id, mode: ctx.mode ?? "incremental" });
index.updated_at = new Date().toISOString();
writeJson(indexPath, index);
console.log(`REPORT=${summary.report}`);
console.log(`${ICON[sc.gate]} 종합 ${fmt(sc.overall.score)} · 트리거 ${sc.triggers.length} · 차단 사유 ${sc.block_reasons.length}`);

// 산식 문서 링크: 원래 위치(source_path)가 워크스페이스 안이면 리포트 기준 상대 링크, 플러그인 기본값이면 해시만 적는다(경로는 버전마다 바뀜)
function frameworkRef() {
  const p = ctx.versions.framework.source_path ?? ctx.versions.framework.path;
  return isAbsolute(p) ? `framework.md (플러그인 기본값, sha256 \`${ctx.versions.framework.sha256.slice(0, 12)}\`)` : `[framework.md](${relative(outDir, resolve(ws, p))})`;
}
