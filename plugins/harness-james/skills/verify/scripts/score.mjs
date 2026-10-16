#!/usr/bin/env node
// /verify 채점: 판정·반증 결과 검증 → 기준 위험도·차원 품질·종합 품질·구조 영향도 → 판정(BLOCK/REVIEW_REQUIRED/PASS)
// 사용:
//   node score.mjs <run_dir>                         채점 후 scores.json 작성
//   node score.mjs <run_dir> --check [--stage judgments]  판정(·반증) 결과만 검증 (문제 있으면 exit 1)
//   node score.mjs <run_dir> --check-judgment <DIM>  판정 결과 파일 하나만 검증 (판정 에이전트 자가 점검용)
//   node score.mjs <run_dir> --list-refute           반증 대상 finding 목록(JSON) 출력
//   node score.mjs <run_dir> --refute-chunks [--chunk-size 6]   반증 대상을 refutation-targets/r<n>.json으로 나눠 쓰고 CHUNK 이름 출력
//   node score.mjs <run_dir> --refute-chunks --retry  반증 결과가 빠진 finding만 r<n>-retry.json으로 다시 묶음 (묶음마다 한 번만)
// 산식은 framework.md(context.versions.framework.path) 4–7장. 이 스크립트가 유일한 점수 계산 경로다.
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CONFIDENCES, CRITERION_STATUSES, ORIGINS, SEVERITIES, VERDICTS, atLeast, findWorkspace, matchPaths, parseArgv, readJson, sevRank, writeJson,
} from "./lib.mjs";

const USAGE = "사용: node score.mjs <run_dir> [--check [--stage judgments] | --check-judgment <DIM> | --list-refute | --refute-chunks [--chunk-size N] [--retry]]";
let args;
try {
  args = parseArgv(process.argv.slice(2), { flags: ["check", "list-refute", "refute-chunks", "retry", "quiet"], options: ["check-judgment", "stage", "chunk-size"] });
} catch (e) {
  console.error(`✖ ${e.message}\n${USAGE}`);
  process.exit(2);
}
const ws = findWorkspace();
const runDir = resolve(ws, args._[0] ?? "");
if (!args._[0] || !existsSync(join(runDir, "context.json"))) {
  console.error(USAGE);
  process.exit(2);
}
const ctx = readJson(join(runDir, "context.json"));
const scoring = readJson(resolve(ws, ctx.versions.scoring.path));
const profile = readJson(resolve(ws, ctx.versions.profile.path));
const required = scoring.model_policy.required_model;
const issues = []; // 평가 불완전 사유 (fail-closed)
const notes = []; // 정보성
const r1 = (x) => Math.round(x * 10) / 10;

const dimIds = ctx.dimensions.map((d) => d.id);
const criteriaOfDim = (d) => Object.keys(ctx.criteria).filter((c) => ctx.criteria[c].dimension === d);
const structureIds = new Set((profile.structures ?? []).map((s) => s.id));
const signalFindings = [...ctx.signals.rule_findings, ...ctx.signals.tool_findings];

// ---------- 판정 결과 검증 ----------
function validateFinding(f, where, dim) {
  const errs = [];
  if (!f || typeof f !== "object") return [`${where}: finding이 객체가 아님`];
  if (!f.id || typeof f.id !== "string") errs.push(`${where}: id 없음`);
  const crit = ctx.criteria[f.criterion];
  if (!crit) errs.push(`${where} ${f.id}: 이 레포에 적용되지 않는 기준 ${f.criterion}`);
  else if (dim && crit.dimension !== dim) errs.push(`${where} ${f.id}: ${f.criterion}은 ${crit.dimension} 차원 기준 — ${dim} 판정에서 낼 수 없음`);
  if (!SEVERITIES.includes(f.severity)) errs.push(`${where} ${f.id}: severity 값 오류 ${f.severity}`);
  if (!CONFIDENCES.includes(f.confidence)) errs.push(`${where} ${f.id}: confidence 값 오류 ${f.confidence}`);
  if (!ORIGINS.includes(f.origin)) errs.push(`${where} ${f.id}: origin 값 오류 ${f.origin}`);
  if (!f.title) errs.push(`${where} ${f.id}: title 없음`);
  if (f.severity !== "info" && !f.failure_scenario) errs.push(`${where} ${f.id}: failure_scenario 없음`);
  if (!Array.isArray(f.evidence) || !f.evidence.length) errs.push(`${where} ${f.id}: evidence 없음`);
  else for (const e of f.evidence) {
    if (!["head", "base"].includes(e.side) || !e.file || !Number.isInteger(e.line) || e.line < 1) {
      errs.push(`${where} ${f.id}: evidence 형식 오류 ${JSON.stringify(e)} (side: head|base, file, line≥1 정수)`);
      break;
    }
  }
  if (f.also_affects && (!Array.isArray(f.also_affects) || f.also_affects.some((d) => !scoring.dimensions[d]))) errs.push(`${where} ${f.id}: also_affects 값 오류`);
  return errs;
}

function loadJudgment(dim) {
  const p = join(runDir, "judgments", `${dim}.json`);
  if (!existsSync(p)) return { errs: [`판정 결과 없음: judgments/${dim}.json`] };
  let j;
  try { j = readJson(p); } catch (e) { return { errs: [`judgments/${dim}.json JSON 파싱 실패: ${e.message}`] }; }
  const errs = [];
  if (j.dimension !== dim) errs.push(`judgments/${dim}.json: dimension 값이 ${j.dimension}`);
  if (j.run_id !== ctx.run_id) errs.push(`judgments/${dim}.json: run_id 불일치 (${j.run_id})`);
  if (j.model !== required) errs.push(`judgments/${dim}.json: model ${j.model} ≠ ${required} (모델 정책 위반)`);
  const need = criteriaOfDim(dim);
  const got = new Map((j.criteria ?? []).map((c) => [c.id, c]));
  for (const c of need) {
    const s = got.get(c);
    if (!s) errs.push(`judgments/${dim}.json: 기준 ${c}의 평가 상태 없음`);
    else if (!CRITERION_STATUSES.includes(s.status)) errs.push(`judgments/${dim}.json: 기준 ${c} status 값 오류 ${s.status}`);
  }
  for (const c of got.keys()) if (!need.includes(c)) errs.push(`judgments/${dim}.json: 적용 대상이 아닌 기준 ${c}`);
  (j.findings ?? []).forEach((f, i) => errs.push(...validateFinding({ ...f, source: "judge" }, `judgments/${dim}.json findings[${i}]`, dim)));
  return { j, errs };
}

if (args["check-judgment"]) {
  const dim = args["check-judgment"].toUpperCase();
  const { errs } = loadJudgment(dim);
  if (errs.length) { console.log(`✖ ${errs.length}건\n` + errs.map((e) => `  - ${e}`).join("\n")); process.exit(1); }
  console.log(`✔ judgments/${dim}.json 형식 정상`);
  process.exit(0);
}

const judgments = {};
for (const d of dimIds) {
  const { j, errs } = loadJudgment(d);
  issues.push(...errs);
  if (j) judgments[d] = j;
}
const judgeFindings = Object.entries(judgments).flatMap(([d, j]) => (j.findings ?? []).map((f) => ({ ...f, source: "judge", dimension: d })));
const all = [
  ...judgeFindings,
  ...signalFindings.map((f) => ({ ...f, dimension: ctx.criteria[f.criterion]?.dimension })),
];
const seenIds = new Set();
for (const f of all) {
  if (seenIds.has(f.id)) issues.push(`finding id 중복: ${f.id}`);
  seenIds.add(f.id);
}
const judgmentStageIssues = [...issues];
// 반증 대상: 감점에 들어가는(introduced·worsened) high 이상 finding만. 기존 부채·해결 finding은 점수에 영향이 없어 반증하지 않는다
const needRefute = all.filter((f) => SEVERITIES.includes(f.severity) && atLeast(f.severity, scoring.refute_min_severity) && scoring.counted_origins.includes(f.origin));

const refuteTarget = (f) => ({
  id: f.id, dimension: f.dimension, criterion: f.criterion, severity: f.severity, confidence: f.confidence, origin: f.origin,
  source: f.source, title: f.title, evidence: f.evidence, failure_scenario: f.failure_scenario,
});
if (args["list-refute"]) {
  console.log(JSON.stringify(needRefute.map(refuteTarget), null, 2));
  process.exit(0);
}

// ---------- 반증 결과 ----------
const verdicts = new Map();
const refuterModels = [];
const refDir = join(runDir, "refutation");
for (const name of existsSync(refDir) ? readdirSync(refDir).filter((n) => n.endsWith(".json")).sort() : []) {
  let r;
  try { r = readJson(join(refDir, name)); } catch (e) { issues.push(`refutation/${name} JSON 파싱 실패: ${e.message}`); continue; }
  if (r.model !== required) issues.push(`refutation/${name}: model ${r.model} ≠ ${required} (모델 정책 위반)`);
  if (r.run_id !== ctx.run_id) issues.push(`refutation/${name}: run_id 불일치`);
  refuterModels.push({ file: name, model: r.model });
  for (const v of r.verdicts ?? []) {
    if (!VERDICTS.includes(v.verdict)) { issues.push(`refutation/${name}: ${v.finding_id} verdict 값 오류 ${v.verdict}`); continue; }
    if (verdicts.has(v.finding_id)) { issues.push(`refutation: ${v.finding_id} 판정이 둘 이상`); continue; }
    verdicts.set(v.finding_id, { ...v, file: name });
  }
}
for (const f of needRefute) if (!verdicts.has(f.id)) issues.push(`반증 결과 없음: ${f.id} (${f.severity}, ${f.title})`);
for (const id of verdicts.keys()) if (!seenIds.has(id)) notes.push(`반증 결과에 있지만 finding이 없는 id: ${id}`);

// ---------- 반증 묶음 파일 ----------
// 반증 에이전트는 refutation-targets/<CHUNK>.json만 보고 판정한다. 근거·시나리오가 옮겨 적다 틀어지지 않게 스크립트가 쓴다
if (args["refute-chunks"]) {
  const size = Number(args["chunk-size"] ?? 6);
  if (!Number.isInteger(size) || size < 1) { console.error(`✖ --chunk-size는 1 이상 정수: ${args["chunk-size"]}`); process.exit(2); }
  const tdir = join(runDir, "refutation-targets");
  mkdirSync(tdir, { recursive: true });
  const baseChunks = readdirSync(tdir).filter((n) => /^r\d+\.json$/.test(n)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10));
  const split = (list) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
  const chunks = [];
  const skipped = [];
  if (!args.retry) {
    split(needRefute).forEach((items, i) => chunks.push({ name: `r${i + 1}`, items }));
    // 이전 실행에서 남은, 지금 목록보다 뒤의 묶음은 지운다
    for (const n of baseChunks) if (parseInt(n.slice(1), 10) > chunks.length) rmSync(join(tdir, n));
  } else {
    const missing = needRefute.filter((f) => !verdicts.has(f.id));
    const owner = new Map();
    for (const n of baseChunks) {
      try { for (const t of readJson(join(tdir, n))) owner.set(t.id, n.replace(/\.json$/, "")); } catch { /* 깨진 묶음은 주인 없음으로 */ }
    }
    const groups = new Map();
    const orphans = [];
    for (const f of missing) {
      const o = owner.get(f.id);
      if (!o) { orphans.push(f); continue; }
      if (!groups.has(o)) groups.set(o, []);
      groups.get(o).push(f);
    }
    const next = baseChunks.reduce((n, c) => Math.max(n, parseInt(c.slice(1), 10)), 0) + 1;
    split(orphans).forEach((items, i) => groups.set(`r${next + i}`, items));
    for (const [o, items] of groups) {
      const name = `${o}-retry`;
      // 재시도는 묶음마다 한 번만. 남은 누락은 채점에서 "평가 불완전"이 된다
      if (existsSync(join(tdir, `${name}.json`))) skipped.push(`${name}: 이미 재시도함 (${items.map((f) => f.id).join(", ")})`);
      else chunks.push({ name, items });
    }
  }
  for (const c of chunks) writeJson(join(tdir, `${c.name}.json`), c.items.map(refuteTarget));
  for (const c of chunks) console.log(`CHUNK=${c.name} ${c.items.length}건`);
  for (const s of skipped) console.log(`  - 건너뜀 ${s}`);
  if (!chunks.length) console.log(args.retry ? "다시 반증할 finding 없음" : "반증 대상 없음");
  process.exit(0);
}

if (args.check && args.stage === "judgments") {
  if (judgmentStageIssues.length) { console.log(`✖ 판정 결과 문제 ${judgmentStageIssues.length}건\n` + judgmentStageIssues.map((e) => `  - ${e}`).join("\n")); process.exit(1); }
  console.log(`✔ 판정 ${Object.keys(judgments).length}개 차원, finding ${all.length}건 — 형식·완전성 정상 (반증 대상 ${needRefute.length}건)`);
  process.exit(0);
}
if (args.check) {
  if (issues.length) { console.log(`✖ 평가 불완전 ${issues.length}건\n` + issues.map((e) => `  - ${e}`).join("\n")); process.exit(1); }
  console.log(`✔ 판정 ${Object.keys(judgments).length}개 차원, finding ${all.length}건, 반증 ${verdicts.size}건 — 형식·완전성 정상`);
  process.exit(0);
}

// ---------- 반증 반영 · 출처 검증 ----------
const diffByHead = new Map(ctx.diff.files.map((f) => [f.path, f]));
const diffByBase = new Map(ctx.diff.files.map((f) => [f.old_path ?? f.path, f]));
const tol = scoring.origin_line_tolerance;
const nearChanged = (e) => {
  const f = e.side === "head" ? diffByHead.get(e.file) : diffByBase.get(e.file);
  if (!f) return false;
  const lines = e.side === "head" ? f.added_lines : f.removed_lines;
  const lo = e.line - tol;
  const hi = (e.end_line ?? e.line) + tol;
  return lines.some((l) => l >= lo && l <= hi);
};
const reclassified = [];
const structuresOf = (f) => {
  const set = new Set((f.structures ?? []).filter((s) => structureIds.has(s)));
  for (const e of f.evidence ?? []) for (const s of profile.structures ?? []) if (matchPaths(e.file, s.paths, s.exclude)) set.add(s.id);
  return [...set];
};

const evaluated = all.map((f0) => {
  const f = { ...f0, original: { severity: f0.severity, confidence: f0.confidence, origin: f0.origin } };
  const v = verdicts.get(f.id);
  if (v) {
    f.verification = { verdict: v.verdict, reason: v.reason ?? "", severity_after: v.severity_after ?? null, confidence_after: v.confidence_after ?? null };
    if (v.verdict === "downgraded" && SEVERITIES.includes(v.severity_after) && sevRank(v.severity_after) < sevRank(f.severity)) f.severity = v.severity_after;
    if (["upheld", "downgraded"].includes(v.verdict) && CONFIDENCES.includes(v.confidence_after)) f.confidence = v.confidence_after;
    if (v.verdict === "uncertain" && f.confidence === "confirmed") f.confidence = "likely";
  }
  if (f.source === "judge" && scoring.counted_origins.includes(f.origin) && !(f.evidence ?? []).some(nearChanged)) {
    reclassified.push({ id: f.id, from: f.origin, to: "pre-existing", reason: `근거 위치가 변경 범위(±${tol}줄) 밖` });
    f.origin = "pre-existing";
  }
  f.structures = structuresOf(f);
  f.rejected = v?.verdict === "rejected";
  f.counted = !f.rejected && scoring.counted_origins.includes(f.origin) && SEVERITIES.includes(f.severity);
  f.points = f.counted ? r1(scoring.severity_points[f.severity] * scoring.confidence_factor[f.confidence]) : 0;
  return f;
});

// 같은 기준·겹치는 근거(±tol줄)의 감점 finding은 점수가 가장 높은 하나만 남긴다 (규칙·도구·판정 중복 병합)
const SOURCE_PRIORITY = { judge: 0, tool: 1, rule: 2 };
const overlaps = (a, b) => (a.evidence ?? []).some((x) => (b.evidence ?? []).some((y) => x.side === y.side && x.file === y.file && Math.abs(x.line - y.line) <= tol));
const merged = [];
for (const cid of new Set(evaluated.filter((f) => f.counted).map((f) => f.criterion))) {
  const group = evaluated.filter((f) => f.counted && f.criterion === cid)
    .sort((a, b) => b.points - a.points || SOURCE_PRIORITY[a.source] - SOURCE_PRIORITY[b.source]);
  const kept = [];
  for (const f of group) {
    const dup = kept.find((k) => overlaps(k, f));
    if (!dup) { kept.push(f); continue; }
    f.counted = false;
    f.merged_into = dup.id;
    merged.push({ id: f.id, into: dup.id, criterion: cid, points: f.points });
    f.points = 0;
  }
}

// ---------- 점수 ----------
const season = ctx.season;
const sf = scoring.season;
const thr = (x) => (season.active ? Math.round(x * sf.review_threshold_factor) : x);
const floorAdd = season.active ? sf.floor_add : 0;
const dimFloor = (profile.floors?.dimension ?? scoring.defaults.dimension_floor) + floorAdd;
const overallFloor = (profile.floors?.overall ?? scoring.defaults.overall_floor) + floorAdd;

const criterionRows = {};
for (const [cid, c] of Object.entries(ctx.criteria)) {
  const fs = evaluated.filter((f) => f.criterion === cid && f.counted);
  const st = judgments[c.dimension]?.criteria?.find((x) => x.id === cid);
  criterionRows[cid] = {
    id: cid, name: c.name, dimension: c.dimension, weight: c.weight,
    review_threshold: season.active && Number.isFinite(c.season_review_threshold) ? c.season_review_threshold : thr(c.review_threshold),
    status: st?.status ?? "missing", note: st?.note ?? "",
    risk: r1(Math.min(100, fs.reduce((n, f) => n + f.points, 0))),
    finding_ids: fs.map((f) => f.id),
  };
}
const dimensions = ctx.dimensions.map((d) => {
  const rows = criteriaOfDim(d.id).map((c) => criterionRows[c]);
  const deduction = rows.reduce((n, r) => n + r.weight * r.risk, 0);
  const wEff = r1(d.weight * (season.active ? sf.dimension_weight_factor[d.id] ?? 1 : 1) * 1000) / 1000;
  const floor = Number.isFinite(d.floor) ? d.floor + floorAdd : dimFloor;
  return { id: d.id, name: d.name, weight: d.weight, weight_effective: wEff, floor, score: r1(Math.max(0, 100 - deduction)), criteria: rows };
});
const wSum = dimensions.reduce((n, d) => n + d.weight_effective, 0);
const overall = r1(dimensions.reduce((n, d) => n + d.weight_effective * d.score, 0) / (wSum || 1));

const steps = scoring.structure_impact;
const structures = ctx.structures.map((s) => {
  const bonus = evaluated.some((f) => f.counted && f.structures.includes(s.id) && atLeast(f.severity, steps.finding_bonus_min_severity));
  const impact = Math.min(100, Math.round(s.criticality * s.magnitude) + (bonus ? steps.finding_bonus : 0));
  return { ...s, review_threshold: thr(s.review_threshold), finding_bonus: bonus, impact };
});

// ---------- 판정 ----------
const blockReasons = [];
if (issues.length) blockReasons.push({ kind: "incomplete", label: `평가 불완전 ${issues.length}건 — 점수를 신뢰할 수 없음` });
for (const f of evaluated) {
  if (f.counted && f.severity === "critical" && scoring.defaults.block_on_critical_confidence.includes(f.confidence)) {
    blockReasons.push({ kind: "critical", ref: f.id, label: `critical(${f.confidence}) ${f.id} ${f.title}` });
  }
}
for (const d of dimensions) if (d.score < d.floor) blockReasons.push({ kind: "dimension-floor", ref: d.id, label: `${d.id} ${d.name} 품질 ${d.score} < 차단선 ${d.floor}` });
if (overall < overallFloor) blockReasons.push({ kind: "overall-floor", label: `종합 품질 ${overall} < 차단선 ${overallFloor}` });

const triggers = [];
const keyFile = (k) => `packets/${k.replace(/[^A-Za-z0-9._-]+/g, "-")}.md`;
for (const r of Object.values(criterionRows).filter((r) => r.risk > 0 && r.risk >= r.review_threshold).sort((a, b) => b.risk - a.risk)) {
  const key = `C-${r.id}`;
  triggers.push({ key, kind: "criterion", ref: r.id, label: `${r.id} ${r.name}`, value: r.risk, threshold: r.review_threshold, finding_ids: r.finding_ids, packet: keyFile(key) });
}
for (const s of structures.filter((s) => s.impact > 0 && s.impact >= s.review_threshold).sort((a, b) => b.impact - a.impact)) {
  const key = `S-${s.id}`;
  triggers.push({
    key, kind: "structure", ref: s.id, label: `${s.name}`, value: s.impact, threshold: s.review_threshold,
    finding_ids: evaluated.filter((f) => f.counted && f.structures.includes(s.id)).map((f) => f.id), packet: keyFile(key),
  });
}
for (const f of evaluated.filter((f) => f.verification?.verdict === "uncertain" && f.counted && atLeast(f.severity, scoring.refute_min_severity))) {
  const key = `D-${f.id}`;
  triggers.push({ key, kind: "disputed", ref: f.id, label: `판정 불일치: ${f.title}`, value: null, threshold: null, finding_ids: [f.id], packet: keyFile(key) });
}
if (season.active) {
  for (const s of structures.filter((s) => s.criticality >= sf.freeze_criticality && s.behavioral_lines > 0)) {
    if (triggers.some((t) => t.kind === "structure" && t.ref === s.id)) continue;
    const key = `F-${s.id}`;
    triggers.push({ key, kind: "freeze", ref: s.id, label: `시즌 변경 동결 구조: ${s.name}`, value: s.impact, threshold: null, finding_ids: [], packet: keyFile(key) });
  }
}
const gate = blockReasons.length ? "BLOCK" : triggers.length ? "REVIEW_REQUIRED" : "PASS";

const bucket = (pred) => evaluated.filter(pred).sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || b.points - a.points);
const out = {
  run_id: ctx.run_id,
  generated_at: new Date().toISOString(),
  complete: issues.length === 0,
  issues,
  notes,
  gate,
  block_reasons: blockReasons,
  season,
  overall: { score: overall, floor: overallFloor },
  dimensions,
  structures,
  triggers,
  findings: {
    counted: bucket((f) => f.counted),
    pre_existing: bucket((f) => !f.rejected && !f.merged_into && f.origin === "pre-existing"),
    fixed: bucket((f) => !f.rejected && f.origin === "fixed"),
    rejected: bucket((f) => f.rejected),
    merged: bucket((f) => !!f.merged_into),
  },
  merged,
  reclassified,
  refutation: {
    required: needRefute.length,
    received: verdicts.size,
    by_verdict: Object.fromEntries(VERDICTS.map((v) => [v, [...verdicts.values()].filter((x) => x.verdict === v).length])),
  },
  models: {
    judges: Object.fromEntries(Object.entries(judgments).map(([d, j]) => [d, j.model])),
    refuters: refuterModels,
    explorer_used: Object.fromEntries(Object.entries(judgments).map(([d, j]) => [d, !!j.explorer_used])),
  },
};
writeJson(join(runDir, "scores.json"), out);

if (!args.quiet) {
  const icon = { PASS: "✅", REVIEW_REQUIRED: "⚠️", BLOCK: "⛔" }[gate];
  console.log(`${icon} ${gate}  종합 ${overall} (차단선 ${overallFloor})${season.active ? `  [시즌 모드 ${season.label}]` : ""}`);
  console.log(dimensions.map((d) => `  ${d.id.padEnd(5)} ${String(d.score).padStart(5)}  ${d.name}`).join("\n"));
  for (const b of blockReasons) console.log(`  ⛔ ${b.label}`);
  for (const t of triggers) console.log(`  ⚠ [${t.key}] ${t.label}${t.value !== null ? ` — ${t.value} ≥ ${t.threshold ?? "-"}` : ""}`);
  if (reclassified.length) console.log(`  ↺ 출처 재분류 ${reclassified.length}건 (introduced → pre-existing)`);
  for (const i of issues) console.log(`  ✖ ${i}`);
}
