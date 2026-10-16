#!/usr/bin/env node
// standard·deep 판정 단계 도구. LLM을 부르지 않는다.
//
//   node verdict.mjs check    <RUN_DIR> [--findings <파일>]       형식·인용·교차 모델 점검 (종료 1 = 오류 있음)
//   node verdict.mjs targets  <RUN_DIR> [--max 8]                 반증 대상(critical·high, 최대 8건) → refutation/targets.json
//   node verdict.mjs finalize <RUN_DIR> [--carried <파일>]        판정 병합·반증 반영·상한·판정 → findings.json, verdict.json
//   node verdict.mjs save-judge      <RUN_DIR> <파일|-> [--observed <모델 ID>]   판정 에이전트 최종 답(JSON) → judge/findings.json
//   node verdict.mjs save-refutation <RUN_DIR> <파일|-> [--observed <모델 ID>]   반증 에이전트 최종 답(JSON) → refutation/result.json
//   node verdict.mjs save-workflow   <RUN_DIR> <파일|-> [--observed-judge <ID>] [--observed-refuter <ID>]
//                                                                 deep 워크플로 반환값(래퍼 {summary, logs, result}도 받음) → 위 두 파일 + refutation/targets.json
//   --observed: 트랜스크립트 등으로 실제 실행 모델을 확인했을 때만 준다. 없으면 보고서에 "요청 모델, 실행 모델 미확인"으로 적는다.
//   node verdict.mjs carry --prev <이전 findings.json> --extract <extract.json> --out <파일>
//   node verdict.mjs judge-prompt  <RUN_DIR> [--carried <파일>]    standard 판정 프롬프트(기준·문서 목록을 스크립트가 채움) → judge-prompt.md
//   node verdict.mjs workflow-args <RUN_DIR> [--carried <파일>]    deep 워크플로 args(criteria·index·perspectives·limits.refute) → workflow-args.json, 워크플로 복사본 → deep.mjs
//   judge-prompt·workflow-args는 읽기 전용 에이전트 정의(design-verify-judge·refuter)가 없으면 종료 4로 멈춘다(대체 경로 없음).
//   에이전트 유형은 플러그인 이름을 붙인 AGENT_TYPES(harness-james:design-verify-judge 등)다. judge-prompt·targets는 쓸 유형을 AGENT=로 출력한다.
//   targets는 반증 프롬프트도 채운다 → refutation/prompt.md
//
// RUN_DIR 안: extract.json · criteria.json · extract/ (extract.mjs), judge/findings.json · refutation/*.json (save-* 가 씀)
// 판정·반증 에이전트는 읽기 전용이다. 결과 JSON을 최종 답으로 돌려주고, 파일은 호출한 쪽이 이 도구로 쓴다.
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { asArray, readJson, writeJson, writeText } from "./lib/util.mjs";
import { obligatedCandidates } from "./lib/candidates.mjs";
import {
  LEVEL_MODELS, REFUTE_MAX, modelAlias, applyLimits, applyRefutation, carryFindings, checkDispositions, checkFindings, computeVerdict, mergeConflicts, refutationTargets, resolveUnread,
} from "./lib/verdict.mjs";

function opt(argv, name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
}

function load(runDir) {
  const extract = readJson(join(runDir, "extract.json"));
  const criteria = readJson(join(runDir, "criteria.json")).criteria;
  return { extract, criteria };
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const AGENT_NAMES = ["design-verify-judge", "design-verify-refuter"];
// 이 스킬과 함께 설치된 에이전트 폴더: 플러그인 <플러그인>/skills/<스킬>/scripts → <플러그인>/agents
const SIBLING_AGENTS = resolve(HERE, "../../../agents");
// Agent 도구 subagent_type·워크플로 agentType. 플러그인 에이전트는 "<플러그인 이름>:<파일 이름>"으로 등록된다.
// workflow/deep.mjs의 TYPES와 같은 값이어야 한다(워크플로는 import를 못 해 같은 문자열을 따로 적는다. check-workflow가 대조한다).
export const PLUGIN_NAME = "harness-james";
export const AGENT_TYPES = { judge: `${PLUGIN_NAME}:${AGENT_NAMES[0]}`, refuter: `${PLUGIN_NAME}:${AGENT_NAMES[1]}` };

// 읽기 전용 에이전트 정의가 설치됐는지 본다(X3). 없으면 대체하지 않고 멈춘다.
// 찾는 곳: DV_AGENTS_DIR(시험용) → <root>/.claude/agents → 이 스킬과 함께 설치된 agents(플러그인 포함) → ~/.claude/agents
export function checkAgentDefs(root, dirs = [process.env.DV_AGENTS_DIR, join(root, ".claude/agents"), SIBLING_AGENTS, join(homedir(), ".claude/agents")].filter(Boolean)) {
  const missing = AGENT_NAMES.filter((n) => !dirs.some((d) => existsSync(join(d, `${n}.md`))));
  if (missing.length) {
    const e = new Error(`읽기 전용 에이전트 정의가 없다: ${missing.join(", ")} (찾은 곳: ${dirs.join(", ")}). 대체 경로 없이 멈춘다. 정의를 설치한 뒤 다시 실행한다.`);
    e.code = 4;
    throw e;
  }
  return dirs;
}

// 템플릿(reference/*.md)의 "---" 아래 본문에서 {{키}}를 채운다
function fillTemplate(name, vars) {
  const t = readFileSync(join(HERE, "../reference", name), "utf8");
  const body = t.slice(t.indexOf("\n---\n") + 5).replace(/^\n+/, "");
  return body.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`템플릿 ${name}: 값 없음 {{${k}}}`);
    return String(vars[k]);
  }).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

const relTo = (root, p) => {
  if (!p) return p;
  const r = relative(root, resolve(root, p));
  return r && !r.startsWith("..") && !isAbsolute(r) ? r : p;
};
const docLines = (docs) => docs.map((d) => `- ${d.path} → ${d.fs_path} (역할 ${d.role}${d.large ? `; 약 ${Math.round(d.tokens / 1000)}k 토큰, Read 한 번 한도 초과` : ""})`).join("\n");

function incrementalOf(extract, carriedFile) {
  if (!extract.changed) return null;
  const c = carriedFile ? readJson(carriedFile) : { carried: [], recheck: [] };
  return { sections: asArray(extract.changed.sections), carried_ids: asArray(c.carried).map((f) => f.id), recheck: asArray(c.recheck) };
}

// standard 판정 프롬프트: 적용 기준·문서 목록·처리 목록 수를 스크립트가 채운다(R5)
export function cmdJudgePrompt(runDir, { carried = null } = {}) {
  const { extract, criteria } = load(runDir);
  const root = rootOf(extract);
  checkAgentDefs(root);
  const app = criteria.filter((c) => c.status === "to-evaluate");
  const inc = incrementalOf(extract, carried);
  const text = fillTemplate("judge-prompt.md", {
    profile: relTo(root, extract.profile.path),
    ...criteriaPaths(root, extract),
    n_criteria: app.length,
    criteria: app.map((c) => `${c.id}(${c.scope}, ${c.method})`).join(", "),
    extract_dir: relTo(root, join(runDir, "extract")),
    n_obligated: obligatedCount(extract),
    documents: docLines(asArray(extract.documents)),
    incremental: inc
      ? `- 증분 검증이다. 범위가 \`절\`인 기준은 바뀐 절만, \`문서\`인 기준은 바뀐 문서만, \`묶음\`인 기준은 묶음 전체를 본다. 바뀐 절:\n${inc.sections.map((s) => `  - ${s.doc} § ${s.section} (${s.state})`).join("\n")}\n- 다시 볼 이전 finding(recheck): ${inc.recheck.map((f) => f.id).join(", ") || "없음"} · 이월(carried) ${inc.carried_ids.length}건`
      : "",
  });
  writeText(join(runDir, "judge-prompt.md"), text);
  return text;
}

// deep 워크플로 args: 모델이 여러 파일에서 손으로 모으지 않도록 스크립트가 만든다(R5)
export function cmdWorkflowArgs(runDir, { carried = null } = {}) {
  const { extract, criteria } = load(runDir);
  const root = rootOf(extract);
  checkAgentDefs(root);
  const idx = readJson(join(runDir, "extract/index.json"));
  const perspectives = readJson(join(HERE, "../reference/perspectives.json"));
  const inc = incrementalOf(extract, carried);
  const args = {
    run_dir: relTo(root, runDir),
    profile_path: relTo(root, extract.profile.path),
    extract_dir: relTo(root, join(runDir, "extract")),
    criteria_path: relTo(root, join(runDir, "criteria.json")),
    rubric_dir: relTo(root, extract.rubric.dir),
    framework_path: relTo(root, resolve(extract.rubric.dir, "../framework.md")),
    applicable: criteria.filter((c) => c.status === "to-evaluate").map((c) => ({ id: c.id, scope: c.scope, method: c.method, weight: c.weight ?? 1 })),
    documents: asArray(idx.documents).map((d) => ({ path: d.path, fs_path: d.fs_path, role: d.role, tokens: d.tokens, large: d.large })),
    perspectives,
    refute_max: extract.limits?.refute ?? REFUTE_MAX,
    // 옛 추출(index에 obligated_candidates 없음)이면 extract.json 후보로 같은 목록을 만든다
    obligated_candidates: idx.obligated_candidates ?? obligatedCandidates(asArray(extract.candidates)).map((c) => ({ id: c.id, criterion: c.criterion, kind: c.kind })),
  };
  if (inc) args.incremental = { sections: inc.sections, carried_ids: inc.carried_ids };
  writeJson(join(runDir, "workflow-args.json"), args);
  // Workflow scriptPath는 세션이 읽을 수 있는 파일만 받는다(플러그인 설치 경로는 작업 디렉터리 밖). 작업 폴더에 복사본을 둔다.
  copyFileSync(join(HERE, "../workflow/deep.mjs"), join(runDir, "deep.mjs"));
  return args;
}

function obligatedCount(extract) {
  return checkDispositions({ findings: [], candidate_dispositions: [] }, asArray(extract.candidates)).required;
}

// 판정 기준 경로(rubric 폴더의 형제 framework.md·traits.md). 기본은 스킬에 든 evaluation/이라 root 밖 절대 경로다.
function criteriaPaths(root, extract) {
  return {
    framework_path: relTo(root, resolve(extract.rubric.dir, "../framework.md")),
    rubric_dir: relTo(root, extract.rubric.dir),
    traits_path: relTo(root, resolve(extract.rubric.dir, "../traits.md")),
  };
}

function rootOf(extract) {
  // extract.root가 정본이다. 마지막 대체(옛 추출)는 rubric이 <root>/docs/evaluation/design/rubrics에 있던 때의 배치다. 문서 fs_path는 root 기준이다.
  return process.env.DV_ROOT || extract.root || resolve(extract.rubric.dir, "../../../..");
}

export function cmdCheck(runDir, file) {
  const { extract, criteria } = load(runDir);
  const doc = readJson(file || join(runDir, "judge/findings.json"));
  const res = checkFindings(doc, { criteria, documents: extract.documents, root: rootOf(extract), level: extract.level, candidates: asArray(extract.candidates) });
  const tgp = join(runDir, "refutation/targets.json");
  if (existsSync(tgp)) {
    const tg = readJson(tgp);
    const expected = extract.limits?.refute ?? REFUTE_MAX;
    if (tg.max != null && tg.max !== expected) res.errors.push(`반증 상한 ${tg.max} ≠ 프로파일 limits.refute ${expected}`);
  }
  return res;
}

export function cmdTargets(runDir, maxArg = null) {
  const doc = readJson(join(runDir, "judge/findings.json"));
  const { criteria, extract } = load(runDir);
  const max = Number(maxArg ?? extract.limits?.refute ?? REFUTE_MAX);
  const { targets, over_cap, order } = refutationTargets(asArray(doc.findings), max, criteria);
  const level = doc.level || "standard";
  // 반증 에이전트가 논리 경로로 파일을 열다 실패하지 않도록 근거마다 실제 파일 경로(file)를 붙인다(B6)
  const fsOf = new Map(asArray(extract.documents).map((d) => [d.path, d.fs_path]));
  const withFiles = targets.map((f) => ({ ...f, evidence: asArray(f.evidence).map((e) => ({ ...e, file: fsOf.get(e.doc) || e.doc })) }));
  const out = { level, finder_model: doc.models?.judge || LEVEL_MODELS[level]?.judge, refuter_model: LEVEL_MODELS[level]?.refuter, max, order, targets: withFiles, over_cap: over_cap.map((f) => f.id) };
  writeJson(join(runDir, "refutation/targets.json"), out);
  const root = rootOf(extract);
  if (targets.length) writeText(join(runDir, "refutation/prompt.md"), fillTemplate("refuter-prompt.md", {
    targets_path: relTo(root, join(runDir, "refutation/targets.json")), n_targets: targets.length, order,
    profile: relTo(root, extract.profile.path), extract_dir: relTo(root, join(runDir, "extract")), documents: docLines(asArray(extract.documents)),
    ...criteriaPaths(root, extract),
  }));
  return out;
}

export function cmdFinalize(runDir, carriedFile = null) {
  const { extract, criteria } = load(runDir);
  const judged = readJson(join(runDir, "judge/findings.json"));
  const level = judged.level || extract.level;
  let findings = asArray(judged.findings).map((f) => ({ ...f, found_by_model: modelAlias(f.found_by_model || judged.models?.judge || LEVEL_MODELS[level]?.judge) }));

  // S 단독 finding(REQ-02) 중 판정이 같은 위치로 다루지 않은 것을 더한다
  const judgedReq02 = new Set(findings.filter((f) => f.criterion === "REQ-02").flatMap((f) => asArray(f.evidence).map((e) => `${e.doc}:${e.line}`)));
  const req02Status = asArray(judged.criteria).find((c) => c.id === "REQ-02");
  if (!req02Status || req02Status.status === "evaluated") {
    for (const s of asArray(extract.script_findings)) {
      const k = `${s.evidence[0].doc}:${s.evidence[0].line}`;
      if (!judgedReq02.has(k)) findings.push(s);
    }
  }

  // 반증 반영
  const tg = existsSync(join(runDir, "refutation/targets.json")) ? readJson(join(runDir, "refutation/targets.json")) : null;
  const res = existsSync(join(runDir, "refutation/result.json")) ? readJson(join(runDir, "refutation/result.json")) : null;
  const overIds = asArray(tg?.over_cap ?? res?.over_cap);
  const overCap = findings.filter((f) => overIds.includes(f.id));
  findings = applyRefutation(findings, res, { refuterModel: LEVEL_MODELS[level]?.refuter, overCap });

  // 증분: 이월 finding
  const carried = carriedFile ? asArray(readJson(carriedFile).carried) : [];
  const all = [...findings, ...carried.filter((c) => !findings.some((f) => f.id === c.id))];

  const profileLimits = extract.limits || null;
  const lim = applyLimits(all.filter((f) => f.refutation?.verdict !== "rejected"), profileLimits || {});
  const { overflow, limits } = lim;
  const { findings: kept, conflicts } = mergeConflicts(lim.kept, judged.recommendation_conflicts);
  limits.refute = profileLimits?.refute ?? tg?.max ?? REFUTE_MAX;
  const rejected = all.filter((f) => f.refutation?.verdict === "rejected");

  const statusById = new Map(asArray(judged.criteria).map((c) => [c.id, c]));
  const merged = criteria.map((c) => {
    const s = statusById.get(c.id);
    if (c.status !== "to-evaluate") return { ...c, final_status: c.status };
    return s ? { ...c, final_status: s.status, note: s.note || null } : { ...c };
  });
  // 판정자의 미독 목록은 자유 문자열이다. 묶음 문서로 바꾸고, 누가 읽은 문서·묶음 밖·의도적 제외를 뺀다(B1·B2, framework 8.1).
  const unread = resolveUnread({ documents: asArray(extract.documents), unreadable: asArray(extract.unreadable), read: judged.documents_read, unread: judged.documents_unread });
  const ds = dispSummary(judged, extract);
  const verdict = computeVerdict({
    findings: kept, criteria: merged, documents: extract.documents,
    unreadable: [...asArray(extract.unreadable), ...unread.design.map((p) => ({ path: p, reason: "judge-unread" }))],
    unreadInputs: unread.input,
    warnings: ds.missing.length ? [`구체 후보 처리 기록 없음 ${ds.missing.length}/${ds.required}건: ${ds.missing.join(", ")}`] : [],
    extractOk: !!extract.candidates, incremental: !!extract.changed,
    agentFailures: [...asArray(judged.perspectives_failed).map((p) => `관점 ${p}`), ...asArray(res?.failed).map((c) => `반증 ${c}`)],
  });

  const out = {
    schema: "findings/0.1.0",
    run_id: judged.run_id || extract.label,
    level,
    label: extract.label,
    profile: extract.profile,
    rubric_version: extract.rubric.version,
    models: {
      judge: modelAlias(judged.models?.judge) || LEVEL_MODELS[level]?.judge,
      judge_observed: judged.models?.judge_observed ?? null,
      refuter: modelAlias(res?.model) || LEVEL_MODELS[level]?.refuter,
      refuter_observed: res?.model_observed ?? null,
    },
    criteria: merged.map((c) => ({ id: c.id, status: c.final_status || "missing", note: c.note || c.status_reason || null })),
    findings: kept,
    rejected,
    overflow,
    limits,
    external_checks: asArray(judged.external_checks),
    coverage: judged.coverage || null,
    candidate_dispositions: asArray(judged.candidate_dispositions),
    dispositions_summary: ds,
    recommendation_conflicts: conflicts,
    traits: asArray(extract.profile?.traits),
  };
  verdict.unread_detail = { excluded: unread.excluded.map((u) => u.path), design: unread.design, input: unread.input, outside: unread.outside, raw_count: unread.raw_count };
  writeJson(join(runDir, "findings.json"), out);
  writeJson(join(runDir, "verdict.json"), verdict);
  return { out, verdict };
}

function dispSummary(judged, extract) {
  const d = asArray(judged.candidate_dispositions);
  const { required, missing } = checkDispositions(judged, asArray(extract.candidates));
  return { required, adopted: d.filter((x) => x.disposition === "adopted").length, rejected: d.filter((x) => x.disposition === "rejected").length, missing };
}

// 에이전트 최종 답(JSON, 코드 펜스·앞뒤 글 허용)을 꺼낸다. 판정·반증 에이전트는 파일을 쓰지 않는다.
export function parseAgentJson(text) {
  const t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  const body = fence ? fence[1] : t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
  if (!body) throw new Error("JSON을 찾지 못함");
  return JSON.parse(body);
}

function readInput(src) {
  return src === "-" || !src ? readFileSync(0, "utf8") : readFileSync(src, "utf8");
}

// 판정 결과 저장: RUN_DIR/judge/findings.json
// 모델: judge = 요청 모델 별칭(fable·opus, 스크립트가 정한 값). 에이전트가 스스로 적은 값은 judge_reported, 트랜스크립트로 확인한 값은 judge_observed(B11).
// 전체 검증(증분 아님)에서는 carried가 뜻이 없으므로 changed로 바꾼다(B9).
export function cmdSaveJudge(runDir, text, { level, observed = null } = {}) {
  const { extract } = load(runDir);
  const doc = typeof text === "string" ? parseAgentJson(text) : text;
  const lv = doc.level || level || extract.level;
  const requested = LEVEL_MODELS[lv]?.judge;
  const prev = doc.models || {};
  const models = { judge: requested, judge_reported: prev.judge_reported ?? prev.judge ?? null, judge_observed: observed ?? prev.judge_observed ?? null };
  const out = { schema: "findings/0.1.0", ...doc, level: lv, models };
  let normalized = 0;
  out.findings = asArray(out.findings).map((f) => {
    const g = { source: "judge", scope_state: "changed", ...f };
    if (!extract.changed && g.scope_state === "carried") { g.scope_state = "changed"; normalized++; }
    return g;
  });
  if (normalized) out.scope_state_normalized = normalized;
  writeJson(join(runDir, "judge/findings.json"), out);
  return out;
}

// 반증 결과 저장: RUN_DIR/refutation/result.json
export function cmdSaveRefutation(runDir, text, { observed = null } = {}) {
  const doc = typeof text === "string" ? parseAgentJson(text) : text;
  const tg = existsSync(join(runDir, "refutation/targets.json")) ? readJson(join(runDir, "refutation/targets.json")) : null;
  const out = { model: modelAlias(tg?.refuter_model || doc.model) || null, model_observed: observed ?? doc.model_observed ?? null, over_cap: doc.over_cap ?? tg?.over_cap ?? [], verdicts: asArray(doc.verdicts) };
  // 반증을 시도했는데 결과가 빠진 대상(에이전트 실패 등) → finalize에서 평가 불완전
  const tried = asArray(doc.targets ?? tg?.targets).map((t) => (typeof t === "string" ? t : t.id));
  out.failed = tried.filter((id) => !out.verdicts.some((v) => v.finding_id === id));
  writeJson(join(runDir, "refutation/result.json"), out);
  return out;
}

// deep 워크플로 반환값({judge, refutation}) 저장. 워크플로 출력 파일의 래퍼({summary, logs, result})면 result를 꺼낸다(B7).
// refutation.max는 프로파일 limits.refute(없으면 8)와 같아야 한다(args를 손으로 모으다 틀린 값을 넘긴 경우를 잡는다, R5).
export function cmdSaveWorkflow(runDir, text, { observedJudge = null, observedRefuter = null } = {}) {
  let doc = typeof text === "string" ? parseAgentJson(text) : text;
  if (!doc.judge && doc.result) doc = typeof doc.result === "string" ? parseAgentJson(doc.result) : doc.result;
  if (!doc.judge) throw new Error("워크플로 반환값에 judge가 없다");
  const { extract } = load(runDir);
  const expected = extract.limits?.refute ?? REFUTE_MAX;
  const got = doc.refutation?.max;
  const errors = got !== expected ? [`refutation.max ${got ?? "없음"} ≠ 프로파일 limits.refute ${expected} (workflow-args.json을 그대로 넘겼는지 확인)`] : [];
  const judge = cmdSaveJudge(runDir, doc.judge, { level: "deep", observed: observedJudge });
  writeJson(join(runDir, "refutation/targets.json"), { level: "deep", finder_model: judge.models.judge, refuter_model: modelAlias(doc.refutation?.model) || LEVEL_MODELS.deep.refuter, max: doc.refutation?.max ?? REFUTE_MAX, expected_max: expected, order: doc.refutation?.order, targets: asArray(doc.refutation?.targets), over_cap: asArray(doc.refutation?.over_cap) });
  const ref = cmdSaveRefutation(runDir, doc.refutation || { verdicts: [] }, { observed: observedRefuter });
  return { judge, ref, errors };
}

export function cmdCarry(prevFile, extractFile, outFile) {
  const prev = readJson(prevFile);
  const extract = readJson(extractFile);
  const res = carryFindings(asArray(prev.findings), extract.changed);
  writeJson(outFile, res);
  return res;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === "check") {
      const { errors, warnings } = cmdCheck(rest[0], opt(rest, "--findings"));
      for (const w of warnings) console.log(`경고: ${w}`);
      for (const e of errors) console.log(`오류: ${e}`);
      console.log(errors.length ? `CHECK=FAIL (${errors.length})` : "CHECK=OK");
      process.exit(errors.length ? 1 : 0);
    } else if (cmd === "targets") {
      const t = cmdTargets(rest[0], opt(rest, "--max"));
      console.log(`반증 대상 ${t.targets.length}건 · 상한 밖 ${t.over_cap.length}건 · 반증 모델 ${t.refuter_model}`);
      console.log(`TARGETS=${join(rest[0], "refutation/targets.json")}`);
      if (t.targets.length) console.log(`AGENT=${AGENT_TYPES.refuter}`);
    } else if (cmd === "finalize") {
      const { verdict, out } = cmdFinalize(rest[0], opt(rest, "--carried"));
      console.log(`VERDICT=${verdict.verdict}`);
      console.log(`finding ${out.findings.length}건 (기각 ${out.rejected.length}) · critical ${verdict.severity_counts.critical} · high ${verdict.severity_counts.high}`);
      for (const t of [...verdict.triggers.revise, ...verdict.triggers.review]) console.log(`- ${t}`);
      if (verdict.excluded.length) console.log(`의도적 제외(평가 불완전 아님): ${verdict.excluded.length}건`);
      const ds = out.dispositions_summary;
      console.log(`light 구체 후보 처리: 채택 ${ds.adopted} · 기각 ${ds.rejected} · 처리 기록 없음 ${ds.missing.length}/${ds.required}${ds.missing.length ? " (평가 불완전 경고)" : ""}`);
    } else if (cmd === "save-judge") {
      const d = cmdSaveJudge(rest[0], readInput(rest[1]), { observed: opt(rest, "--observed") });
      console.log(`저장: ${join(rest[0], "judge/findings.json")} · finding ${d.findings.length}건 · 기준 상태 ${asArray(d.criteria).length}개`);
    } else if (cmd === "save-refutation") {
      const d = cmdSaveRefutation(rest[0], readInput(rest[1]), { observed: opt(rest, "--observed") });
      console.log(`저장: ${join(rest[0], "refutation/result.json")} · 판정 ${d.verdicts.length}건 · 반증 모델 ${d.model}`);
    } else if (cmd === "save-workflow") {
      const { judge, ref, errors } = cmdSaveWorkflow(rest[0], readInput(rest[1]), { observedJudge: opt(rest, "--observed-judge"), observedRefuter: opt(rest, "--observed-refuter") });
      console.log(`저장: judge/findings.json(finding ${judge.findings.length}) · refutation/result.json(판정 ${ref.verdicts.length}, 상한 밖 ${ref.over_cap.length})`);
      for (const e of errors) console.log(`오류: ${e}`);
      if (errors.length) process.exit(1);
    } else if (cmd === "judge-prompt") {
      cmdJudgePrompt(rest[0], { carried: opt(rest, "--carried") });
      console.log(`PROMPT=${join(rest[0], "judge-prompt.md")}`);
      console.log(`AGENT=${AGENT_TYPES.judge}`);
    } else if (cmd === "workflow-args") {
      const a = cmdWorkflowArgs(rest[0], { carried: opt(rest, "--carried") });
      console.log(`적용 기준 ${a.applicable.length} · 문서 ${a.documents.length} · 관점 ${a.perspectives.length} · 반증 상한 ${a.refute_max} · 처리 목록 ${a.obligated_candidates.length}${a.incremental ? " · 증분" : ""}`);
      console.log(`ARGS=${join(rest[0], "workflow-args.json")} · 에이전트 ${AGENT_TYPES.judge}, ${AGENT_TYPES.refuter}`);
      console.log(`SCRIPT=${resolve(rest[0], "deep.mjs")}`);
    } else if (cmd === "carry") {
      const r = cmdCarry(opt(rest, "--prev"), opt(rest, "--extract"), opt(rest, "--out"));
      console.log(`이월 ${r.carried.length}건 · 다시 볼 것 ${r.recheck.length}건`);
    } else {
      console.error("사용: verdict.mjs check|targets|finalize|carry …");
      process.exit(2);
    }
  } catch (e) {
    console.error(`오류: ${e.message}`);
    process.exit(e.code === 4 ? 4 : 2);
  }
}
