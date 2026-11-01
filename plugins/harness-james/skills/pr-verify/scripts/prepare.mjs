#!/usr/bin/env node
// /pr-verify 1단계: 사전 점검 → 대상 해석 → base/head 트리 추출 → diff·구조 매핑 → 자동 신호 → context.json
// 사용: node prepare.mjs --session <세션 id> [repo] [target] [--base <ref>] [--full [--merge-ref <ref>]] [--resume <run_id>] [--season auto|bf|off] [--no-fetch] [--keep-runs N]
//       node prepare.mjs --session <세션 id> --args-stdin   (위 인자 원문을 stdin으로. 셸식 따옴표로만 나누고 $·백틱·글롭은 확장 안 함)
//   --session: Claude Code 세션 id(UUID). 실행을 .verify/sessions/<id>.json에 등록한다.
//              verify-guard는 그 세션의 판정·반증·탐색 에이전트에게 가장 최근 등록 실행 폴더만 열어 준다. 없으면 종료 코드 2
//   repo:   프로파일 별칭 (profiles/*.json repo.aliases)
//   target: 브랜치 | SHA | pr:N | #N   (생략 시 해당 레포의 현재 HEAD)
//   --repo-path <dir>: 프로파일의 레포 대신 이 경로의 클론을 검증 (보정용 시드 브랜치)
//   --no-gate: 리포트를 PR 게이트 index에 등록하지 않음 (원본 레포에 있는 시험용 브랜치 검증 시)
//   --full: 전체 모드. base = 갈림점(merge-base(<PR base 또는 default_base>, head)). --base가 갈림점과 다르면 경고
//   --merge-ref <ref>: (전체 모드) 머지 결과 커밋. 갈림점·head와 비교하는 reach-compare 신호를 더 돌린다
//   --resume <run_id>: 멈춘 실행을 이어 돌린다. 대상·base를 맞춰 보고 세션에 다시 등록한 뒤 끝난 단계를 출력한다
// diff 밖 결정적 신호(signals.mjs)는 모드와 상관없이 갈림점 기준으로 한 번 돈다. 판정 범위는 바꾸지 않는다.
// 소스 레포의 작업 트리·브랜치는 건드리지 않는다 (git fetch / rev-parse / archive / diff / log 만 사용).
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  AGENTS_DIR, DIMENSION_ORDER, SEVERITIES, CONFIDENCES, atLeast, compileRegex, evalDir, evalFile, extractTree, fileSha256, findWorkspace, firstGlobValue,
  git, gitTry, isNonBehavioral, kstStamp, loadConfig, loadProfiles, matchPaths, matchesAny, parseArgv, parseRubric, parseUnifiedDiff,
  readStdinText, resolveCommit, sevRank, sha256, shownPath, tokenizeArgs, writeJson,
} from "./lib.mjs";
import { forkPoint, runOutsideSignals } from "./signals.mjs";

const RULE_KINDS = ["path-modified", "path-added", "path-deleted", "added-line-regex", "removed-line-regex", "co-change-required", "added-file-missing-regex"];
const MAX_EVIDENCE = 10;

// --args-stdin: 인자 원문을 stdin으로 받는다(SKILL.md의 따옴표 붙인 heredoc). 셸이 인자를 해석하지 않게 하려는 것
function readArgs(argv) {
  if (!argv.includes("--args-stdin")) return argv;
  if (argv.length > 1) {
    console.error("✖ --args-stdin과 다른 인자를 함께 쓸 수 없음");
    process.exit(2);
  }
  try {
    return tokenizeArgs(readStdinText().replace(/(\r?\n)+$/, ""));
  } catch (e) {
    console.error(`✖ ${e.message}`);
    process.exit(2);
  }
}
// --session <id>: 인자 원문(stdin)과 따로 명령줄에서만 받는다. SKILL.md가 ${CLAUDE_SESSION_ID}를 넣는다
const SESSION_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function takeSession(argv) {
  const rest = [], found = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--session") { found.push(argv[i + 1] ?? ""); i++; continue; }
    if (argv[i].startsWith("--session=")) { found.push(argv[i].slice(10)); continue; }
    rest.push(argv[i]);
  }
  return { session: found.length === 1 ? found[0] : null, count: found.length, rest };
}
const ARG_SPEC = { flags: ["no-fetch", "json", "no-gate", "full"], options: ["base", "season", "keep-runs", "repo-path", "merge-ref", "resume"] };
const sess = takeSession(process.argv.slice(2));
let args;
try { args = parseArgv(readArgs(sess.rest), ARG_SPEC); } catch (e) {
  console.error(`✖ ${e.message}`);
  process.exit(2);
}
if (!sess.session || !SESSION_RE.test(sess.session)) {
  const got = sess.count > 1 ? "--session이 여러 번 옴" : sess.count === 0 ? "--session 없음" : `값이 UUID가 아님: "${String(sess.session).slice(0, 60)}"`;
  console.error(`✖ 세션 id를 받지 못함 (${got}) — 검증을 시작하지 않음`);
  console.error("  SKILL.md 1단계 명령을 그대로 실행해야 한다: --session \"${CLAUDE_SESSION_ID}\" 가 Claude Code 세션 id로 바뀌어 들어온다.");
  console.error("  세션 id가 없으면 verify-guard가 판정 에이전트의 실행 폴더 읽기를 모두 막는다.");
  process.exit(2);
}
const ws = findWorkspace();
const { scoring, scoringPath } = loadConfig(ws);
const profiles = loadProfiles(ws);
const now = new Date();
const stamp = kstStamp(now);
const warnings = [];
const errors = [];

function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(2);
}

// ---------- 0. 사전 점검 (모델 정책) ----------
function preflight() {
  const checks = [];
  const pol = scoring.model_policy;
  const env = process.env;
  const add = (ok, name, detail, level = "error") => {
    checks.push({ name, ok, detail, level: ok ? "ok" : level });
    if (!ok && level === "error") errors.push(`${name}: ${detail}`);
    if (!ok && level === "warn") warnings.push(`${name}: ${detail}`);
  };
  const eff = env.CLAUDE_CODE_EFFORT_LEVEL;
  add(!eff || eff === pol.required_effort, "CLAUDE_CODE_EFFORT_LEVEL", eff ? `값 ${eff} — 에이전트 effort(${pol.required_effort})를 덮어씀` : "미설정");
  const subModel = env.CLAUDE_CODE_SUBAGENT_MODEL;
  const force = ["1", "true"].includes(String(env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? "").toLowerCase());
  if (subModel && force) add(subModel === pol.required_model, "CLAUDE_CODE_SUBAGENT_MODEL(+FORCE)", `값 ${subModel} — 서브에이전트 모델을 강제로 덮어씀`);
  else add(!subModel, "CLAUDE_CODE_SUBAGENT_MODEL", subModel ? `값 ${subModel} (FORCE 없음, 에이전트 정의의 모델이 우선)` : "미설정", "warn");
  const depth = env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
  add(!depth || Number(depth) >= pol.min_subagent_spawn_depth, "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", depth ? `값 ${depth} — 오케스트레이터→판정→탐색 3단계 필요` : "미설정(기본 3)");
  for (const name of ["verify-orchestrator", "verify-judge", "verify-explorer", "verify-refuter"]) {
    const p = join(AGENTS_DIR, `${name}.md`);
    if (!existsSync(p)) { add(false, `agent:${name}`, "정의 파일 없음"); continue; }
    const fm = (readFileSync(p, "utf8").match(/^---\n([\s\S]*?)\n---/) || [])[1] ?? "";
    const model = (fm.match(/^model:\s*(\S+)/m) || [])[1];
    const effort = (fm.match(/^effort:\s*(\S+)/m) || [])[1];
    add(model === pol.required_model && effort === pol.required_effort, `agent:${name}`, `model=${model} effort=${effort}`);
  }
  return checks;
}

// ---------- 1. 레포·대상 해석 ----------
function findProfile(token) {
  if (!token) return null;
  const t = token.toLowerCase();
  return profiles.find((p) => p.repo.aliases.map((a) => a.toLowerCase()).includes(t) || p.repo.key === t || p.repo.name === t) ?? null;
}
// --repo-path: 보정(calibration)용 로컬 클론 등 다른 위치의 같은 레포를 검증할 때 (기본은 workspace/<profile.repo.path>)
const repoPathOf = (p) => (args["repo-path"] ? resolve(ws, args["repo-path"]) : join(ws, p.repo.path));

function resolveRepoAndTarget(positional) {
  const [a, b] = positional;
  let profile = findProfile(a);
  const targetInput = profile ? b : a;
  if (!profile && b) fail(`레포를 알 수 없음: ${a} (사용 가능: ${profiles.map((p) => p.repo.aliases[0]).join(", ")})`);
  if (!profile) {
    const top = gitTry(process.cwd(), ["rev-parse", "--show-toplevel"]);
    profile = top ? profiles.find((p) => repoPathOf(p) === top) ?? null : null;
  }
  if (!profile && targetInput) {
    const hits = profiles.filter((p) => existsSync(repoPathOf(p)) && (resolveCommit(repoPathOf(p), targetInput) || resolveCommit(repoPathOf(p), `origin/${targetInput}`)));
    if (hits.length === 1) profile = hits[0];
    else if (hits.length > 1) fail(`대상 ${targetInput}이 여러 레포에 있음 — 레포를 지정해 주세요`);
  }
  if (!profile) fail(`레포를 지정해 주세요: /pr-verify <${profiles.map((p) => p.repo.aliases[0]).join("|")}> [브랜치|SHA|pr:N]`);
  return { profile, targetInput };
}

function resolveTarget(repo, profile, targetInput) {
  const target = { input: targetInput ?? null, ref: null, sha: null, branch: null, pr: null };
  let baseRef = args.base ?? null;
  let prBase = null;
  const prm = targetInput && targetInput.match(/^(?:pr[:/#]?|#)(\d+)$/i);
  if (prm) {
    const n = prm[1];
    let pr;
    try {
      pr = JSON.parse(execFileSync("gh", ["pr", "view", n, "-R", profile.repo.github, "--json", "number,title,url,headRefName,headRefOid,baseRefName,state,author,body"], { encoding: "utf8" }));
    } catch (e) {
      fail(`PR #${n} 조회 실패 (gh): ${e.message.split("\n")[0]}`);
    }
    target.pr = { number: pr.number, title: pr.title, url: pr.url, state: pr.state, author: pr.author?.login ?? null, body: (pr.body ?? "").slice(0, 6000) };
    target.branch = pr.headRefName;
    target.sha = pr.headRefOid;
    target.ref = `pr:${n}`;
    if (!gitTry(repo, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) gitTry(repo, ["fetch", "--quiet", "origin", `pull/${n}/head`]);
    if (!gitTry(repo, ["cat-file", "-e", `${pr.headRefOid}^{commit}`])) fail(`PR head 커밋을 가져오지 못함: ${pr.headRefOid}`);
    baseRef = baseRef ?? `origin/${pr.baseRefName}`;
    prBase = pr.baseRefName;
  } else if (targetInput) {
    for (const ref of [targetInput, `origin/${targetInput}`]) {
      const sha = resolveCommit(repo, ref);
      if (sha) { target.ref = ref; target.sha = sha; break; }
    }
    if (!target.sha) fail(`대상을 찾지 못함: ${targetInput} (브랜치·SHA·pr:N)`);
    const name = targetInput.replace(/^origin\//, "");
    const local = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    const remote = gitTry(repo, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`]);
    target.branch = local || remote ? name : null;
    if (local && remote && local !== remote && target.ref === targetInput) warnings.push(`로컬 ${name}(${local.slice(0, 7)})과 origin(${remote.slice(0, 7)})이 다름 — 로컬 기준으로 검증`);
  } else {
    target.branch = gitTry(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
    target.ref = "HEAD";
    target.sha = resolveCommit(repo, "HEAD");
    const dirty = gitTry(repo, ["status", "--porcelain", "--untracked-files=no"]);
    if (dirty) warnings.push("작업 트리에 커밋 안 된 변경이 있음 — 커밋된 HEAD만 검증함");
  }
  // 갈림점: PR 대상이면 PR base, 아니면 프로파일 default_base와 head의 merge-base
  const fork = forkPoint(repo, target.pr ? `origin/${prBase}` : profile.repo.default_base, target.sha);
  baseRef = baseRef ?? profile.repo.default_base;
  const baseSha = resolveCommit(repo, baseRef);
  if (!baseSha) fail(`base를 찾지 못함: ${baseRef}`);
  const mergeBase = gitTry(repo, ["merge-base", baseSha, target.sha]);
  if (!mergeBase) fail(`merge-base 계산 실패: ${baseRef}..${target.sha}`);
  if (!fork.fork) warnings.push(`갈림점을 계산하지 못함(${fork.ref}) — diff 밖 신호는 이 실행의 merge-base 기준으로 돈다`);
  if (args.full && fork.fork && mergeBase !== fork.fork) warnings.push(`전체 모드인데 base(${baseRef} → merge-base ${mergeBase.slice(0, 7)})가 갈림점(${fork.ref} → ${fork.fork.slice(0, 7)})과 다름 — PR 게이트는 이 실행을 전체 검증으로 세지 않음`);
  return { target, base: { input: args.base ?? null, ref: baseRef, sha: baseSha, merge_base: mergeBase }, fork: { ref: fork.ref, sha: fork.fork ?? mergeBase } };
}

function computeSeason() {
  const mode = (args.season ?? "auto").toLowerCase();
  if (mode === "bf" || mode === "on") return { active: true, forced: true, label: scoring.season.name };
  if (mode === "off") return { active: false, forced: true, label: null };
  const win = scoring.season.windows.find((w) => stamp.date >= w.from && stamp.date <= w.to);
  return { active: !!win, forced: false, label: win?.label ?? null };
}

// ---------- 2. rubric·기준 ----------
function loadCriteria(profile, season) {
  const dims = DIMENSION_ORDER.filter((d) => profile.dimensions[d]);
  if (!(profile.repo.traits ?? []).length) errors.push(`프로파일 repo.traits가 비어 있음(server·client 중 하나 이상): ${shownPath(ws, profile._path)}`);
  const rubrics = {};
  const criteria = {};
  let rules = [];
  for (const d of dims) {
    const p = evalFile(ws, `rubrics/${d}.md`);
    if (!existsSync(p)) { errors.push(`rubric 없음: ${shownPath(ws, p)}`); continue; }
    const md = readFileSync(p, "utf8");
    let parsed;
    try { parsed = parseRubric(md, d); } catch (e) { errors.push(e.message); continue; }
    rubrics[d] = { path: shownPath(ws, p), sha256: sha256(md), version: parsed.version, criteria: parsed.criteria.length, _abs: p };
    if (!parsed.criteria.length) errors.push(`${d} rubric에서 기준 목록을 읽지 못함`);
    for (const c of parsed.criteria) {
      if (!c.traits.includes("common") && !c.traits.some((t) => (profile.repo.traits ?? []).includes(t))) continue;
      const o = profile.criteria?.[c.id] ?? {};
      if (o.disabled) continue;
      criteria[c.id] = {
        dimension: d,
        name: c.name,
        weight: o.weight ?? c.weight ?? scoring.defaults.criterion_weight,
        review_threshold: o.review_threshold ?? c.review_threshold ?? scoring.defaults.criterion_review_threshold,
        season_review_threshold: o.season_review_threshold ?? null,
      };
    }
    rules = rules.concat(parsed.rules.map((r) => ({ ...r, _from: rubrics[d].path })));
  }
  rules = rules.concat((profile.rules ?? []).map((r) => ({ ...r, _from: shownPath(ws, profile._path) })));
  const disabled = new Set(profile.disabled_rules ?? []);
  const overrides = profile.rule_overrides ?? {};
  const active = [];
  const ids = new Set();
  for (const r0 of rules) {
    if (r0.repo !== profile.repo.key || disabled.has(r0.id)) continue;
    const r = { ...r0, ...(overrides[r0.id] ?? {}) };
    if (season.active && r.season_override) Object.assign(r, r.season_override);
    const where = `${r.id} (${r._from})`;
    if (ids.has(r.id)) { errors.push(`규칙 id 중복: ${where}`); continue; }
    ids.add(r.id);
    if (!RULE_KINDS.includes(r.kind)) { errors.push(`규칙 kind 오류: ${where} ${r.kind}`); continue; }
    if (!criteria[r.criterion]) { warnings.push(`규칙 ${where}의 기준 ${r.criterion}이 이 레포에 적용되지 않아 건너뜀`); continue; }
    if (!SEVERITIES.includes(r.severity) || !CONFIDENCES.includes(r.confidence)) { errors.push(`규칙 severity/confidence 오류: ${where}`); continue; }
    try {
      if (r.pattern) r._rx = compileRegex(r.pattern, r.flags);
      if (r.path_regex) r._prx = compileRegex(r.path_regex);
      if (r.skip_if_commits_match) {
        r._skipAuthor = r.skip_if_commits_match.author ? compileRegex(r.skip_if_commits_match.author) : null;
        r._skipMsg = r.skip_if_commits_match.message ? compileRegex(r.skip_if_commits_match.message) : null;
      }
    } catch (e) { errors.push(`규칙 정규식 오류: ${where} ${e.message}`); continue; }
    if (["added-line-regex", "removed-line-regex", "added-file-missing-regex"].includes(r.kind) && !r._rx) { errors.push(`규칙 pattern 없음: ${where}`); continue; }
    active.push(r);
  }
  const bundle = sha256(Object.keys(rubrics).sort().map((d) => `${d}:${rubrics[d].sha256}`).join("\n"));
  return { dims, rubrics, criteria, rules: active, bundle };
}

// ---------- 3. diff·커밋 ----------
function buildDiff(repo, profile, mb, head, runDir) {
  const patch = git(repo, ["diff", "--no-color", "--no-ext-diff", "-M", "-U3", mb, head]);
  writeFileSync(join(runDir, "diff.patch"), patch);
  const files = parseUnifiedDiff(patch);
  const ignore = Object.fromEntries(Object.entries(profile.ignore_line_patterns ?? {}).map(([g, list]) => [g, list.map((s) => compileRegex(s))]));
  for (const f of files) {
    const prefixes = firstGlobValue(f.path, profile.comment_syntax) ?? [];
    const ign = firstGlobValue(f.path, ignore) ?? [];
    const code = (l) => !isNonBehavioral(l.text, prefixes, ign);
    // hunk 단위로 주석·공백을 뺀 코드가 공백 무시 시 같으면 줄바꿈·들여쓰기만 바뀐 것(reflow) → 동작 변경 아님
    const squash = (arr) => arr.filter(code).map((l) => l.text).join("").replace(/\s+/g, "");
    f.behavioral = 0;
    f.hunks.forEach((hk, i) => {
      const add = f.added.filter((l) => l.h === i);
      const rem = f.removed.filter((l) => l.h === i);
      // reflow = 코드 줄이 실제로 바뀌었는데 공백만 다른 경우. 주석·import만 바뀐 hunk는 reflow가 아니다(규칙은 그대로 적용)
      const sa = squash(add);
      const sr = squash(rem);
      const reflow = (sa !== "" || sr !== "") && sa === sr;
      hk.reflow = reflow;
      // reflow 표시는 코드 줄에만 — import·주석 줄은 줄 정규식 규칙(예: 계층 위반 import) 대상으로 남긴다
      for (const l of [...add, ...rem]) l.reflow = reflow && code(l);
      if (!reflow) f.behavioral += add.filter(code).length + rem.filter(code).length;
    });
    f.added_count = f.added.length;
    f.removed_count = f.removed.length;
    f.structures = (profile.structures ?? [])
      .filter((s) => matchPaths(f.path, s.paths, s.exclude) || (f.old_path && matchPaths(f.old_path, s.paths, s.exclude)))
      .map((s) => s.id);
  }
  return files;
}

function collectCommits(repo, mb, head) {
  const out = gitTry(repo, ["log", "--no-color", "-n", "300", "--format=%x1e%H%x1f%an%x1f%aI%x1f%s%x1f%b%x1f", "--name-only", `${mb}..${head}`]) ?? "";
  return out.split("\x1e").filter((r) => r.trim()).map((r) => {
    const [sha, author, date, subject, body, rest] = r.split("\x1f");
    return { sha: sha.trim(), author, date, subject, body: (body ?? "").trim().slice(0, 800), files: (rest ?? "").split("\n").map((s) => s.trim()).filter(Boolean) };
  });
}

function structureSummary(profile, files) {
  const steps = scoring.structure_impact.magnitude_steps;
  return (profile.structures ?? []).map((s) => {
    const fs = files.filter((f) => f.structures.includes(s.id));
    const lines = fs.reduce((n, f) => n + f.behavioral, 0);
    const step = steps.find((st) => st.max_lines === null || lines <= st.max_lines);
    return {
      id: s.id, name: s.name, criticality: s.criticality, specs: s.specs ?? [],
      review_threshold: s.review_threshold ?? scoring.defaults.structure_review_threshold,
      touched: fs.length > 0, files: fs.map((f) => f.path), behavioral_lines: lines, magnitude: fs.length ? step.factor : 0,
    };
  });
}

// 프로파일 구조 경로 점검: head 트리에서 아무것도 안 잡는 구조, 어느 구조에도 안 걸린 동작 변경 파일
function structureCoverage(repo, profile, headSha, files) {
  const tree = (gitTry(repo, ["ls-tree", "-r", "--name-only", headSha]) ?? "").split("\n").filter(Boolean);
  const empty = (profile.structures ?? []).filter((s) => !tree.some((p) => matchPaths(p, s.paths, s.exclude))).map((s) => s.id);
  // coverage_ignore(프로파일, 선택): 시험·문서처럼 구조에 넣지 않는 경로는 이 경고에서 뺀다
  const unmapped = files.filter((f) => !f.structures.length && f.behavioral > 0 && !matchesAny(f.path, profile.coverage_ignore ?? [])).sort((a, b) => b.behavioral - a.behavioral).map((f) => ({ path: f.path, behavioral: f.behavioral }));
  for (const id of empty) warnings.push(`프로파일 구조 ${id}의 경로가 head 트리에서 아무 파일도 잡지 않음 — 프로파일 경로 확인 필요`);
  if (unmapped.length) warnings.push(`어느 구조에도 안 걸린 동작 변경 파일 ${unmapped.length}개: ${unmapped.slice(0, 10).map((f) => `${f.path}(${f.behavioral}줄)`).join(", ")}${unmapped.length > 10 ? ` 외 ${unmapped.length - 10}개` : ""}`);
  return { empty_structures: empty, unmapped_files: unmapped };
}

// ---------- 4. 자동 신호 ----------
const structuresFor = (profile, file) => (profile.structures ?? []).filter((s) => matchPaths(file, s.paths, s.exclude)).map((s) => s.id);
const norm = (s) => s.replace(/\s+/g, "");

function groupFinding(profile, base, hits) {
  // 한 규칙(또는 한 체크)의 여러 파일 히트를 finding 하나로 묶는다 — "한 원인, 한 finding"
  const evidence = [];
  for (let round = 0; evidence.length < MAX_EVIDENCE; round++) {
    let added = false;
    for (const h of hits) if (h.evidence[round]) { evidence.push(h.evidence[round]); added = true; if (evidence.length >= MAX_EVIDENCE) break; }
    if (!added) break;
  }
  const files = [...new Set(hits.map((h) => h.file))];
  const count = hits.reduce((n, h) => n + h.count, 0);
  return {
    ...base,
    origin: "introduced",
    evidence,
    files,
    match_count: count,
    structures: [...new Set(files.flatMap((f) => structuresFor(profile, f)))],
    failure_scenario: `${base.failure_scenario}${count > 1 ? ` (파일 ${files.length}개, ${count}곳)` : ""}`,
  };
}

function evalRules(profile, files, rules, commits) {
  const out = [];
  const changed = (f) => ["A", "M", "R", "C", "D"].includes(f.status);
  const changedPaths = files.filter(changed).flatMap((f) => [f.path, f.old_path].filter(Boolean));
  const allAddedText = files.flatMap((f) => f.added.map((l) => norm(l.text))).join("\n");
  for (const r of rules) {
    const inc = r.paths ?? ["**"];
    const exc = r.exclude ?? [];
    const pathOk = (p) => !!p && matchPaths(p, inc, exc) && (!r._prx || r._prx.test(p));
    if (r.unless_paths_modified && changedPaths.some((p) => matchPaths(p, r.unless_paths_modified))) continue;
    const skipByCommits = (path) => {
      if (!r.skip_if_commits_match) return false;
      const cs = commits.filter((c) => c.files.includes(path));
      return cs.length > 0 && cs.every((c) => (!r._skipAuthor || r._skipAuthor.test(c.author)) && (!r._skipMsg || r._skipMsg.test(c.subject)));
    };
    const hits = [];
    const hit = (f, side, lines) => {
      const file = side === "base" ? f.old_path ?? f.path : f.path;
      if (skipByCommits(f.path)) return;
      hits.push({ file, count: lines.length, evidence: lines.map((line) => ({ side, file, line })) });
    };
    if (r.kind === "co-change-required") {
      // with_paths 중 하나라도 바뀌면 충족
      const a = files.filter((f) => changed(f) && (f.behavioral > 0 || f.binary || f.status !== "M") && (pathOk(f.path) || pathOk(f.old_path)));
      const b = files.some((f) => changed(f) && (matchPaths(f.path, r.with_paths ?? []) || (f.old_path && matchPaths(f.old_path, r.with_paths ?? []))));
      if (a.length && !b) for (const f of a) hit(f, f.status === "D" ? "base" : "head", [f.status === "D" ? f.hunks[0]?.old_start || 1 : f.hunks[0]?.new_start || 1]);
    } else {
      for (const f of files) {
        if (!pathOk(f.path) && !pathOk(f.old_path)) continue;
        if (r.kind === "path-modified" && changed(f)) hit(f, f.status === "D" ? "base" : "head", [f.status === "D" ? f.hunks[0]?.old_start || 1 : f.hunks[0]?.new_start || 1]);
        else if (r.kind === "path-added" && f.status === "A") hit(f, "head", [1]);
        else if (r.kind === "path-deleted" && f.status === "D") hit(f, "base", [1]);
        else if (r.kind === "added-line-regex") {
          const ls = f.added.filter((l) => !l.reflow && r._rx.test(l.text)).map((l) => l.line);
          if (ls.length) hit(f, "head", ls);
        } else if (r.kind === "removed-line-regex") {
          // 이동·파일 이름 변경·줄 합치기 대응: 규칙이 잡은 토큰이 공백 무시로 diff 어디든(다른 파일 포함) 다시 추가됐으면 삭제로 보지 않는다
          const readded = (l) => {
            if (!r.ignore_if_readded) return false;
            const m = l.text.match(r._rx);
            return !!m && norm(m[0]) !== "" && allAddedText.includes(norm(m[0]));
          };
          const ls = f.removed.filter((l) => !l.reflow && r._rx.test(l.text) && !readded(l)).map((l) => l.line);
          if (ls.length) hit(f, "base", ls);
        } else if (r.kind === "added-file-missing-regex" && f.status === "A" && !f.binary) {
          if (!f.added.some((l) => r._rx.test(l.text))) hit(f, "head", [1]);
        }
      }
    }
    if (!hits.length) continue;
    out.push(groupFinding(profile, {
      id: `R-${r.id}`,
      criterion: r.criterion,
      title: r.title,
      severity: r.severity,
      confidence: r.confidence,
      failure_scenario: r.message,
      rationale: `자동 규칙 ${r.id} (${r.kind}${r.pattern ? `: /${r.pattern}/${r.flags ?? ""}` : ""})`,
      recommendation: r.recommendation ?? "",
      source: "rule",
      rule_id: r.id,
    }, hits));
  }
  return out;
}

function secretScan(profile, files, criteria) {
  const crit = profile.secret_scan?.criterion;
  const pats = scoring.secret_patterns.map((p) => ({ ...p, rx: compileRegex(p.pattern) }));
  const exclude = profile.secret_scan?.exclude ?? [];
  const out = [];
  for (const p of pats) {
    const hits = [];
    for (const f of files) {
      if (f.binary || matchPaths(f.path, exclude)) continue;
      const ls = f.added.filter((l) => p.rx.test(l.text)).map((l) => l.line);
      if (ls.length) hits.push({ file: f.path, count: ls.length, evidence: ls.map((line) => ({ side: "head", file: f.path, line })) });
    }
    if (!hits.length) continue;
    if (!crit || !criteria[crit]) { warnings.push(`비밀값 패턴 ${p.id} 일치 ${hits[0].file}:${hits[0].evidence[0].line} — profile.secret_scan.criterion 미설정으로 경고만 남김`); continue; }
    out.push(groupFinding(profile, {
      id: `S-${p.id}`,
      criterion: crit,
      title: `비밀값으로 보이는 문자열 추가 (${p.id})`,
      severity: p.severity,
      confidence: "likely",
      failure_scenario: "커밋된 비밀값은 저장소 접근자 누구나 볼 수 있고 git 이력에 남음 → 키 폐기·재발급 필요",
      rationale: `비밀값 패턴 ${p.id}`,
      recommendation: "값을 환경변수·.env(커밋 제외)로 옮기고 노출된 키는 즉시 폐기",
      source: "rule",
      rule_id: `secret:${p.id}`,
    }, hits));
  }
  return out;
}

// 프로젝트 도구: profile.tools[]의 kind "module"은 평가 폴더 기준 tool.module 파일(ES 모듈)을 불러 default export를 부른다.
// 플랫폼 전용 검사(린터·테마 검사 등)는 플러그인에 넣지 않고 프로젝트가 이 모양으로 더한다. 안내: references/profile-guide.md
//   export default async function (api) → { run: { tool, kind, status, note, ... }, findings: [자동 신호 finding] }
//   api: { profile, tool, files, trees, criteria, season, warnings, groupFinding, helpers: { SEVERITIES, sevRank, matchPaths } }
async function runModuleTool(profile, tool, files, trees, criteria, season) {
  const path = resolve(evalDir(ws), tool.module ?? "");
  const fail = (note) => { warnings.push(`도구 ${tool.id} 건너뜀: ${note} — 이 도구의 자동 신호 없이 채점함`); return { run: { tool: tool.id, kind: tool.kind, status: "error", note }, findings: [] }; };
  if (!tool.module || !existsSync(path)) return fail(`모듈 없음 (${shownPath(ws, path)})`);
  let fn;
  try { fn = (await import(pathToFileURL(path).href)).default; } catch (e) { return fail(`모듈을 불러오지 못함: ${e.message}`); }
  if (typeof fn !== "function") return fail("default export가 함수가 아님");
  try {
    const r = await fn({ profile, tool, files, trees, criteria, season, warnings, groupFinding, helpers: { SEVERITIES, sevRank, matchPaths } });
    if (!r || !r.run || !Array.isArray(r.findings)) return fail("반환값이 { run, findings }가 아님");
    for (const f of r.findings) { f.source ??= "tool"; f.tool_id ??= tool.id; }
    return r;
  } catch (e) { return fail(`실행 오류: ${e.message}`); }
}

// ---------- 5. 실행 등록 · 오래된 실행 정리 ----------
// .verify/sessions/<세션 id>.json = { session_id, runs: [{ run_dir, created_at }], updated_at }. 마지막 항목이 그 세션의 자기 실행이다.
// prepare만 쓴다(verify-guard가 에이전트의 쓰기를 막음)
const SESSIONS_DIR = join(ws, ".verify/sessions");
const SESSION_KEEP_DAYS = 30;
function registerRun(sid, runDir) {
  mkdirSync(SESSIONS_DIR, { recursive: true });
  const file = join(SESSIONS_DIR, `${sid}.json`), rel = relative(ws, runDir);
  let runs = [];
  try { const old = JSON.parse(readFileSync(file, "utf8")); if (Array.isArray(old?.runs)) runs = old.runs.filter((r) => typeof r?.run_dir === "string" && r.run_dir !== rel); } catch {}
  runs = [...runs, { run_dir: rel, created_at: now.toISOString() }].slice(-20);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ session_id: sid, runs, updated_at: now.toISOString() }, null, 2)}\n`);
  renameSync(tmp, file);
}
function pruneRuns(keep) {
  const dir = join(ws, ".verify/runs");
  if (existsSync(dir)) {
    const runs = readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory()).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const p of runs.slice(keep)) for (const t of ["head", "base"]) rmSync(join(p, t), { recursive: true, force: true });
  }
  if (existsSync(SESSIONS_DIR)) {
    const cutoff = now.getTime() - SESSION_KEEP_DAYS * 86400e3;
    for (const n of readdirSync(SESSIONS_DIR)) {
      const p = join(SESSIONS_DIR, n);
      try { if (statSync(p).mtimeMs < cutoff) rmSync(p, { force: true }); } catch {}
    }
  }
}

// ---------- 6. 이어 돌리기 (--resume) ----------
// 실행 폴더가 대상·base와 맞는지 보고, 이 세션에 다시 등록하고, 끝난 단계를 출력한다. 새 실행 폴더는 만들지 않는다
function resumeContext(id) {
  if (!/^[\w.-]+$/.test(id)) fail(`--resume 값이 실행 id 형식이 아님: ${id}`);
  const dir = join(ws, ".verify/runs", id);
  const p = join(dir, "context.json");
  if (!existsSync(p)) fail(`이어 돌릴 실행이 없음: .verify/runs/${id}/context.json`);
  return { dir, ctx: JSON.parse(readFileSync(p, "utf8")) };
}
function resumeStatus(runDir, ctx) {
  const lines = [];
  const scoreJs = join(dirname(fileURLToPath(import.meta.url)), "score.mjs");
  const ok = [], redo = [];
  for (const d of ctx.dimensions.map((x) => x.id)) {
    if (!existsSync(join(runDir, "judgments", `${d}.json`))) { redo.push(`${d}(파일 없음)`); continue; }
    const r = spawnSync(process.execPath, [scoreJs, runDir, "--check-judgment", d], { cwd: ws, encoding: "utf8" });
    if (r.status === 0) ok.push(d);
    else redo.push(`${d}(형식 오류)`);
  }
  lines.push(`- 판정: 형식 점검 통과 ${ok.join(", ") || "없음"}${redo.length ? ` / 다시 띄울 것 ${redo.join(", ")}` : ""}`);
  const tdir = join(runDir, "refutation-targets");
  const chunks = existsSync(tdir) ? readdirSync(tdir).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).sort() : [];
  const done = chunks.filter((c) => existsSync(join(runDir, "refutation", `${c}.json`)));
  lines.push(chunks.length
    ? `- 반증 묶음: 결과 있음 ${done.join(", ") || "없음"}${done.length < chunks.length ? ` / 결과 없음 ${chunks.filter((c) => !done.includes(c)).join(", ")}` : ""}`
    : "- 반증 묶음: 아직 안 나눔");
  const scored = existsSync(join(runDir, "scores.json"));
  lines.push(`- 채점: ${scored ? "scores.json 있음" : "안 함"}`);
  if (scored) {
    let triggers = [];
    try { triggers = JSON.parse(readFileSync(join(runDir, "scores.json"), "utf8")).triggers ?? []; } catch {}
    const missing = triggers.filter((t) => !existsSync(join(runDir, t.packet))).map((t) => t.key);
    lines.push(`- 검토 패킷: ${triggers.length - missing.length}/${triggers.length}${missing.length ? ` (없음 ${missing.join(", ")})` : ""}`);
  }
  return lines;
}

// ---------- main ----------
const stopIfErrors = (stage) => {
  if (!errors.length) return;
  console.error(`✖ ${stage} 실패 — 검증을 시작하지 않음`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(2);
};
const pre = preflight();
stopIfErrors("사전 점검(모델 정책)");
const resumed = args.resume ? resumeContext(args.resume) : null;
if (resumed) {
  // 재개: 생략한 인자는 원래 실행의 값으로 채운다
  const c = resumed.ctx;
  if (!args._.length) args._ = [c.repo.key, c.target.sha];
  args.base = args.base ?? c.base.ref;
  if (c.repo.path && !args["repo-path"] && c.repo_override) args["repo-path"] = c.repo.path;
  if (args.full && c.mode !== "full") fail(`--full로 재개하려는데 원래 실행은 ${c.mode ?? "incremental"} 모드임: ${args.resume}`);
  args.full = c.mode === "full";
  args["no-fetch"] = true;
}
const { profile, targetInput } = resolveRepoAndTarget(args._);
const repo = repoPathOf(profile);
if (!existsSync(join(repo, ".git"))) fail(`레포 없음: ${repo}`);
const season = computeSeason();
const crit = loadCriteria(profile, season);
stopIfErrors("rubric·규칙 로드");
if (!args["no-fetch"]) {
  if (gitTry(repo, ["fetch", "--quiet", "--prune", "origin"]) === null) warnings.push("git fetch 실패 — 로컬에 있는 ref로 진행");
}
const { target, base, fork } = resolveTarget(repo, profile, targetInput);
const mode = args.full ? "full" : "incremental";
let mergeRef = null;
if (args["merge-ref"]) {
  if (!args.full) fail("--merge-ref는 --full과 같이 쓴다");
  mergeRef = resolveCommit(repo, args["merge-ref"]);
  if (!mergeRef) fail(`--merge-ref를 찾지 못함: ${args["merge-ref"]} (레포 ${repo}에 있는 커밋이어야 함)`);
}

if (resumed) {
  const c = resumed.ctx;
  const diff = [];
  if (c.repo.key !== profile.repo.key) diff.push(`레포 ${c.repo.key} ≠ ${profile.repo.key}`);
  if (c.target.sha !== target.sha) diff.push(`대상 ${c.target.sha.slice(0, 7)} ≠ 지금 ${target.sha.slice(0, 7)}${targetInput ? ` (${targetInput}가 움직였으면 새로 실행)` : ""}`);
  if (c.base.merge_base !== base.merge_base) diff.push(`base merge-base ${c.base.merge_base.slice(0, 7)} ≠ ${base.merge_base.slice(0, 7)}`);
  if (diff.length) fail(`이어 돌릴 실행과 맞지 않음 (${args.resume}): ${diff.join(", ")}`);
  registerRun(sess.session, resumed.dir);
  // 오래된 실행 정리로 트리가 지워졌으면 다시 푼다
  if (!existsSync(join(resumed.dir, "head"))) extractTree(repo, c.target.sha, join(resumed.dir, "head"));
  if (!existsSync(join(resumed.dir, "base"))) extractTree(repo, c.base.merge_base, join(resumed.dir, "base"));
  console.log(`RUN_DIR=${c.run_dir}`);
  console.log(`재개: ${c.run_id} (${c.mode ?? "incremental"} 모드) 레포 ${profile.repo.name} 대상 ${c.target.branch ?? c.target.ref} @ ${c.target.sha.slice(0, 7)} base merge-base ${c.base.merge_base.slice(0, 7)}`);
  console.log("끝난 단계 (끝난 것은 건너뛴다):");
  for (const l of resumeStatus(resumed.dir, c)) console.log(l);
  process.exit(0);
}

const frameworkPath = evalFile(ws, "framework.md");
// 같은 head를 같은 초에 다시 준비하면 앞 실행 폴더(판정·채점 결과)를 섞지 않게 뒤에 번호를 붙인다
let runId = `${profile.repo.key}-${target.sha.slice(0, 7)}-${stamp.compact}`;
for (let n = 2; existsSync(join(ws, ".verify/runs", runId)); n++) runId = `${profile.repo.key}-${target.sha.slice(0, 7)}-${stamp.compact}-${n}`;
const runDir = join(ws, ".verify/runs", runId);
for (const d of ["judgments", "refutation", "refutation-targets", "packets", "explore"]) mkdirSync(join(runDir, d), { recursive: true });
registerRun(sess.session, runDir);

// 판정 기준 사본: 플러그인 설치 경로는 작업 폴더 밖이라 하위 에이전트의 Read가 권한 확인에 걸린다(-p에서는 거부).
// 이번 실행에 쓰는 framework·scoring·적용 차원 rubric을 RUN_DIR/evaluation/에 복사하고, context의 path는 사본을, source_path는 원래 위치를 가리킨다
const copyCriterion = (src, rel) => {
  const dst = join(runDir, "evaluation", rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  return { path: shownPath(ws, dst), source_path: shownPath(ws, src) };
};
const evalCopies = {
  scoring: copyCriterion(scoringPath, "config/scoring.json"),
  framework: copyCriterion(frameworkPath, "framework.md"),
  rubrics: Object.fromEntries(Object.entries(crit.rubrics).map(([d, { _abs, ...r }]) => [d, { ...r, ...copyCriterion(_abs, `rubrics/${d}.md`) }])),
};
pruneRuns(Number(args["keep-runs"] ?? 8));

const trees = { head: join(runDir, "head"), base: join(runDir, "base") };
extractTree(repo, target.sha, trees.head);
extractTree(repo, base.merge_base, trees.base);

const files = buildDiff(repo, profile, base.merge_base, target.sha, runDir);
const commits = collectCommits(repo, base.merge_base, target.sha);
const structures = structureSummary(profile, files);
const coverage = structureCoverage(repo, profile, target.sha, files);
const outside = runOutsideSignals({
  ws, runDir, profile, profiles, repo, mode, fork: fork.sha, head: target.sha, runBase: base.merge_base, branch: target.branch, mergeRef,
  changedPaths: [...new Set(files.flatMap((f) => [f.path, f.old_path].filter(Boolean)))], warnings,
});

let ruleFindings = [];
let toolFindings = [];
const toolRuns = [];
if (files.length) {
  ruleFindings = evalRules(profile, files, crit.rules, commits).concat(secretScan(profile, files, crit.criteria));
  for (const tool of profile.tools ?? []) {
    const r = tool.kind === "module" ? await runModuleTool(profile, tool, files, trees, crit.criteria, season) : null;
    if (!r) { warnings.push(`알 수 없는 도구 kind: ${tool.kind} (도구 ${tool.id}) — kind는 "module"`); continue; }
    toolRuns.push(r.run);
    toolFindings = toolFindings.concat(r.findings);
  }
}

const ctx = {
  run_id: runId,
  run_dir: relative(ws, runDir),
  created_at: now.toISOString(),
  created_kst: stamp.human,
  workspace: ws,
  repo: { key: profile.repo.key, name: profile.repo.name, path: repo, github: profile.repo.github },
  // 다른 위치의 클론(--repo-path)이나 PR 게이트에 넣지 않을 실행(--no-gate): 리포트는 calibration/reports/로, PR 게이트 index에는 넣지 않음
  repo_override: !!args["repo-path"] || !!args["no-gate"],
  mode,
  // 갈림점: PR base(또는 default_base)와 head의 merge-base. 전체 모드면 base.merge_base와 같다
  fork_point: fork.sha,
  fork_ref: fork.ref,
  target,
  base,
  trees: { head: relative(ws, trees.head), base: relative(ws, trees.base) },
  season,
  versions: {
    scoring: { ...evalCopies.scoring, version: scoring.version, sha256: fileSha256(scoringPath) },
    profile: { path: shownPath(ws, profile._path), version: profile.version, sha256: fileSha256(profile._path) },
    framework: { ...evalCopies.framework, sha256: fileSha256(frameworkPath) },
    rubrics: evalCopies.rubrics,
    rubric_bundle_sha256: crit.bundle,
  },
  dimensions: crit.dims.map((d) => ({ id: d, name: scoring.dimensions[d], weight: profile.dimensions[d].weight, floor: profile.dimensions[d].floor ?? null, criteria: Object.keys(crit.criteria).filter((c) => crit.criteria[c].dimension === d) })),
  criteria: crit.criteria,
  parameters: profile.parameters ?? {},
  commits: commits.map(({ files: fs, ...c }) => ({ ...c, files: fs.slice(0, 50), file_count: fs.length })),
  diff: {
    patch: relative(ws, join(runDir, "diff.patch")),
    totals: {
      files: files.length,
      added: files.reduce((n, f) => n + f.added_count, 0),
      removed: files.reduce((n, f) => n + f.removed_count, 0),
      behavioral: files.reduce((n, f) => n + f.behavioral, 0),
    },
    files: files.map((f) => ({
      path: f.path, old_path: f.old_path !== f.path ? f.old_path : null, status: f.status, binary: f.binary,
      added: f.added_count, removed: f.removed_count, behavioral: f.behavioral, structures: f.structures,
      hunks: f.hunks, removed_lines: f.removed.map((l) => l.line), added_lines: f.added.map((l) => l.line),
    })),
  },
  structures,
  signals: { rule_findings: ruleFindings, tool_findings: toolFindings, tool_runs: toolRuns },
  // diff 밖 결정적 신호(갈림점 기준). 점수에 넣지 않는다. 판정 자료는 outside_signals.summary
  outside_signals: { ...outside, merge_ref: mergeRef },
  profile_coverage: coverage,
  refute_min_severity: scoring.refute_min_severity,
  preflight: { ok: errors.length === 0, checks: pre, errors },
  warnings,
};
writeJson(join(runDir, "context.json"), ctx);

// ---------- 요약 출력 ----------
const touched = structures.filter((s) => s.touched);
const signals = [...ruleFindings, ...toolFindings];
const refuteCount = signals.filter((f) => atLeast(f.severity, scoring.refute_min_severity)).length;
if (args.json) {
  console.log(JSON.stringify({ run_dir: ctx.run_dir, ok: ctx.preflight.ok }));
} else {
  console.log(`RUN_DIR=${ctx.run_dir}`);
  console.log(`레포: ${profile.repo.name}  대상: ${target.branch ?? target.ref} @ ${target.sha.slice(0, 7)}${target.pr ? ` (PR #${target.pr.number})` : ""}  base: ${base.ref} @ ${base.sha.slice(0, 7)} (merge-base ${base.merge_base.slice(0, 7)})`);
  console.log(`변경: 파일 ${ctx.diff.totals.files}개, +${ctx.diff.totals.added} −${ctx.diff.totals.removed}, 동작 변경 ${ctx.diff.totals.behavioral}줄, 커밋 ${commits.length}개`);
  console.log(`핵심 구조: ${touched.length ? touched.map((s) => `${s.id}(중요도 ${s.criticality}, ${s.behavioral_lines}줄)`).join(", ") : "없음"}`);
  console.log(`적용 차원: ${crit.dims.join(", ")} / 기준 ${Object.keys(crit.criteria).length}개 / 규칙 ${crit.rules.length}개`);
  console.log(`자동 신호: 규칙 ${ruleFindings.length}건, 도구 ${toolFindings.length}건 (반증 대상 ${refuteCount}건)${toolRuns.length ? ` / ${toolRuns.map((t) => `${t.tool}:${t.status}${t.introduced ? ` 신규 ${t.introduced}` : ""}`).join(", ")}` : ""}`);
  for (const s of signals) console.log(`  · ${s.id} [${s.criterion} ${s.severity}/${s.confidence}] ${s.title}${s.files?.length > 1 ? ` (파일 ${s.files.length}개)` : ""}`);
  console.log(`모드: ${mode === "full" ? "전체" : "증분"}  갈림점: ${fork.sha.slice(0, 7)} (${fork.ref})`);
  console.log(`diff 밖 신호(갈림점 기준, ${(outside.elapsed_ms / 1000).toFixed(1)}초): ${outside.tools.map((t) => `${t.tool}:${t.status}${t.status === "ok" ? ` ${t.items}건` : ""}`).join(", ")} → ${outside.summary}${outside.replica_files ? ` / 복제본 ${outside.replica_files}개` : ""}`);
  console.log(`시즌 모드: ${season.active ? `ON (${season.label})` : "off"}`);
  for (const w of warnings) console.log(`⚠ ${w}`);
}
if (!files.length) process.exit(3); // 변경 없음
