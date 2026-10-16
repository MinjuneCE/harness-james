#!/usr/bin/env node
// deep 워크플로 스크립트를 토큰 없이 점검한다.
//  1) 문법: 워크플로 본문은 async 함수 안에서 돌고 맨 위 return을 쓰므로, 같은 모양으로 감싸 `node --check` 한다.
//  2) meta: 순수 리터럴인지, phase() 제목이 meta.phases와 같은지.
//  3) 모의 실행: agent()를 가짜로 바꿔 끝까지 돌린다(관점 수·에이전트 수 ≤ 9·모델·반환 형태).
//
//   node check-workflow.mjs [workflow/deep.mjs] [--perspectives reference/perspectives.json] [--tmp <디렉터리>]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AGENT_TYPES } from "./verdict.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function splitScript(src) {
  const m = src.match(/^export const meta = (\{[\s\S]*?\n\})\n/);
  if (!m) throw new Error("맨 앞에 `export const meta = {...}`가 없다");
  return { metaSrc: m[1], body: src.slice(m[0].length) };
}

export function checkMeta(metaSrc, body) {
  const errors = [];
  if (/\$\{|\.\.\.|\w\(/.test(metaSrc.replace(/'[^']*'|"[^"]*"/g, "''"))) errors.push("meta가 순수 리터럴이 아니다(보간·전개·호출)");
  // eslint-disable-next-line no-new-func
  const meta = Function(`"use strict"; return (${metaSrc});`)();
  if (!meta.name || !meta.description) errors.push("meta.name·description 필요");
  const titles = new Set((meta.phases || []).map((p) => p.title));
  const used = [...body.matchAll(/phase\('([^']+)'\)/g)].map((x) => x[1]);
  for (const t of used) if (!titles.has(t)) errors.push(`phase('${t}')가 meta.phases에 없다`);
  if (/Date\.now\(|Math\.random\(|new Date\(\)/.test(body)) errors.push("Date.now/Math.random/new Date() 사용 금지");
  if (/\b(require|import)\s*\(|from\s+['"]node:/.test(body)) errors.push("파일·모듈 접근 금지");
  return { meta, errors };
}

export function syntaxCheck(body, tmp) {
  const wrapped = `async function __workflow(args, agent, parallel, pipeline, phase, log, budget, workflow) {\n${body}\n}\n`;
  const p = join(tmp, "deep.wrapped.mjs");
  writeFileSync(p, wrapped);
  execFileSync(process.execPath, ["--check", p], { stdio: "pipe" });
  return p;
}

function fakeFinding(id, sev, crit) {
  return { id, criterion: crit, title: "t", severity: sev, confidence: "confirmed", scope_state: "changed", method: "L", evidence: [{ doc: "d.md", line: 1, quote: "q" }], touches: ["R1"], failure_scenario: "f", recommendation: "r" };
}

// respond(label, prompt, opts): 시험용으로 특정 호출의 답을 바꾼다(undefined면 기본 가짜 답)
export async function mockRun(body, args, respond = null) {
  const calls = [];
  const agent = async (prompt, opts = {}) => {
    calls.push({ label: opts.label, model: opts.model, phase: opts.phase, agentType: opts.agentType, prompt, schema: opts.schema });
    const custom = respond ? await respond(opts.label, prompt, opts) : undefined;
    if (custom !== undefined) return custom;
    if (opts.label?.startsWith("review:")) {
      const key = opts.label.slice(7);
      const p = args.perspectives.find((x) => x.key === key);
      const c = p.primary[0];
      const mine = (args.obligated_candidates || []).filter((o) => p.primary.includes(o.criterion));
      return {
        findings: [fakeFinding(`F-${c}-${key}-01`, "high", c), fakeFinding(`F-${c}-${key}-02`, "medium", c)],
        candidate_dispositions: mine.map((o) => ({ candidate: o.id, disposition: "adopted", finding: `F-${c}-${key}-02` })),
        criteria: p.primary.map((id) => ({ id, status: "evaluated" })),
        documents_read: ["d.md"],
        documents_unread: key === "implementer" ? ["src.md (grep 일부만)", "d.md 10-20"] : [],
      };
    }
    if (opts.label === "aggregate") {
      const list = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      return { findings: list, merged: [], recommendation_conflicts: [] };
    }
    if (opts.label?.startsWith("refute:")) {
      const list = JSON.parse(prompt.slice(prompt.lastIndexOf("\n") + 1));
      return { verdicts: list.map((f) => ({ finding_id: f.id, verdict: "upheld", note: "d.md:1" })) };
    }
    throw new Error(`예상하지 못한 agent 호출: ${opts.label}`);
  };
  const parallel = async (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => { let r = it; for (const s of stages) r = await s(r, it, i); return r; }));
  const logs = [];
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", "budget", "workflow", body);
  const result = await fn(args, agent, parallel, pipeline, () => {}, (m) => logs.push(m), { total: null, spent: () => 0, remaining: () => Infinity }, async () => null);
  return { result, calls, logs };
}

// 결정·보정 반영 점검(토큰 없음): 구체 후보 처리 목록, 원자료 담당 관점 하나, 미독 합산 금지, 반증 근거의 실제 파일 경로, BND-06 유지
export function contractErrors(result, calls, perspectives) {
  const errors = [];
  const reviews = calls.filter((c) => c.label?.startsWith("review:"));
  const srcIn = reviews.filter((c) => c.prompt.includes("mapped/src.md"));
  if (srcIn.length !== 1) errors.push(`원자료(source-material)를 받는 관점이 하나가 아니다(${srcIn.length})`);
  if (!reviews.some((c) => /BND-06/.test(c.prompt))) errors.push("BND-06이 어느 관점의 주 담당 기준에도 없다");
  if (!result.judge.candidate_dispositions || !Array.isArray(result.judge.recommendation_conflicts)) errors.push("judge에 candidate_dispositions·recommendation_conflicts가 없다");
  if (result.judge.documents_unread.some((s) => /^d\.md/.test(s))) errors.push("다른 관점이 읽은 문서가 미독으로 남았다(단순 합산)");
  const ref = calls.filter((c) => c.label?.startsWith("refute:"));
  if (ref.length && !ref.every((c) => c.prompt.includes('"file":"mapped/'))) errors.push("반증 대상 근거에 실제 파일 경로(file)가 없다");
  if (!reviews.some((c) => /Read 한 번 한도/.test(c.prompt))) errors.push("큰 문서 표시가 없다");
  return errors;
}

export function defaultArgs(perspectives) {
  const all = perspectives.flatMap((p) => p.primary);
  return {
    run_dir: "RUN", profile_path: "profile.json", extract_dir: "RUN/extract", criteria_path: "RUN/criteria.json",
    rubric_dir: "rubrics", framework_path: "framework.md",
    applicable: all.map((id) => ({ id, scope: "bundle", method: "L", weight: 1 })),
    documents: [{ path: "d.md", fs_path: "mapped/d.md", role: "spec" }, { path: "src.md", fs_path: "mapped/src.md", role: "source-material", tokens: 40000, large: true }],
    obligated_candidates: [{ id: "C-CON-05-0001", criterion: "CON-05", kind: "retired-id-reference" }, { id: "C-BND-04-0002", criterion: "BND-04", kind: "mixed-scheme" }],
    perspectives,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const o = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const file = argv.find((a) => !a.startsWith("--") && !argv[argv.indexOf(a) - 1]?.startsWith("--")) || join(HERE, "../workflow/deep.mjs");
  const persp = JSON.parse(readFileSync(o("--perspectives", join(HERE, "../reference/perspectives.json")), "utf8"));
  const tmp = o("--tmp", null) || mkdtempSync(join(tmpdir(), "dv-wf-"));
  const src = readFileSync(file, "utf8");
  const { metaSrc, body } = splitScript(src);
  const { meta, errors } = checkMeta(metaSrc, body);
  try { syntaxCheck(body, tmp); console.log("문법: OK (감싼 본문 node --check)"); } catch (e) { errors.push(`문법 오류: ${e.stderr?.toString() || e.message}`); }
  const { result, calls } = await mockRun(body, defaultArgs(persp));
  const n = calls.length;
  console.log(`meta: ${meta.name} · phases ${meta.phases.map((p) => p.title).join(" → ")}`);
  console.log(`모의 실행: 에이전트 ${n}개 (관점 ${calls.filter((c) => c.label.startsWith("review:")).length} · 집계 ${calls.filter((c) => c.label === "aggregate").length} · 반증 ${calls.filter((c) => c.label.startsWith("refute:")).length})`);
  if (n > 9) errors.push(`에이전트 ${n}개 > 9`);
  if (calls.some((c) => c.label.startsWith("review:") && c.model !== "opus")) errors.push("관점 검토가 opus가 아니다");
  if (calls.some((c) => c.label.startsWith("refute:") && c.model !== "fable")) errors.push("반증이 fable이 아니다");
  if (result.refutation.verdicts.length > 8) errors.push("반증 8건 초과");
  for (const e of contractErrors(result, calls, persp)) errors.push(e);
  if (calls.some((c) => (c.label.startsWith("review:") || c.label === "aggregate") && c.agentType !== AGENT_TYPES.judge)) errors.push(`판정·집계가 ${AGENT_TYPES.judge} 유형이 아니다`);
  if (calls.some((c) => c.label.startsWith("refute:") && c.agentType !== AGENT_TYPES.refuter)) errors.push(`반증이 ${AGENT_TYPES.refuter} 유형이 아니다`);
  if (/agent_types/.test(body)) errors.push("agent_types 대체 경로가 남았다");
  if (/extract_path/.test(body)) errors.push("extract_path(통짜 추출 파일) 참조가 남았다");
  console.log(`에이전트 유형: ${[...new Set(calls.map((c) => c.agentType || "(기본)"))].join(", ")}`);
  console.log(`반환: finding ${result.judge.findings.length} · 반증 ${result.refutation.verdicts.length} · 상한 밖 ${result.refutation.over_cap.length}`);
  for (const e of errors) console.log(`오류: ${e}`);
  console.log(errors.length ? "WORKFLOW_CHECK=FAIL" : "WORKFLOW_CHECK=OK");
  process.exit(errors.length ? 1 : 0);
}
