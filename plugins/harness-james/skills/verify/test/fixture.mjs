// 테스트용 임시 워크스페이스와 임시 git 레포. 실제 평가 폴더·레포는 쓰지 않는다(에이전트 정의는 플러그인 agents/를 읽기만 한다).
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPTS = join(SKILL_DIR, "scripts");
export const MODEL = "claude-opus-5-5";

const SCORING = {
  version: "test",
  model_policy: { required_model: MODEL, required_effort: "max", min_subagent_spawn_depth: 3 },
  severity_points: { critical: 60, high: 30, medium: 12, low: 4, info: 0 },
  confidence_factor: { confirmed: 1.0, likely: 0.7, possible: 0.4 },
  counted_origins: ["introduced", "worsened"],
  origin_line_tolerance: 5,
  refute_min_severity: "high",
  structure_impact: {
    magnitude_steps: [{ max_lines: 0, factor: 0 }, { max_lines: 10, factor: 0.6 }, { max_lines: 50, factor: 0.8 }, { max_lines: null, factor: 1.0 }],
    finding_bonus: 20,
    finding_bonus_min_severity: "medium",
  },
  defaults: {
    criterion_weight: 1.0, criterion_review_threshold: 50, structure_review_threshold: 60,
    dimension_floor: 60, overall_floor: 70, block_on_critical_confidence: ["confirmed", "likely"],
  },
  season: {
    name: "BFCM", windows: [], review_threshold_factor: 0.8, floor_add: 10, freeze_criticality: 85,
    dimension_weight_factor: { PERF: 1.5, REL: 1.5 },
  },
  dimensions: { SEC: "보안·프라이버시", PERF: "성능·확장성(BF)", ARCH: "아키텍처", REL: "신뢰성·정합성", OPS: "관측성·운영", TEST: "테스트 적정성", A11Y: "접근성·i18n·마켓" },
  secret_patterns: [{ id: "fixture-key", pattern: "FIXTURE_KEY_[0-9]{8}", severity: "critical" }],
};

const rubric = (dim, rows) => `# ${dim}\n\n- 버전: 1.0.0\n\n## 기준 목록\n\n| ID | 이름 | 적용 | 권장 가중치 | 권장 검토 임계값 |\n|---|---|---|---:|---:|\n${rows.join("\n")}\n\n## 자동 신호\n\n없음.\n`;

const PROFILE = {
  version: "1.0.0",
  repo: { key: "demo", name: "demo-svc", path: "repos/demo", github: "example/demo", default_base: "main", aliases: ["demo"], traits: ["server"] },
  dimensions: { SEC: { weight: 0.5 }, REL: { weight: 0.5 } },
  floors: { dimension: 40, overall: 50 },
  structures: [{ id: "demo.core", name: "코어", criticality: 50, paths: ["src/core/**"] }],
  comment_syntax: { "**/*.js": ["//"] },
  rules: [{
    id: "no-eval", repo: "demo", kind: "added-line-regex", criterion: "SEC-01", severity: "medium", confidence: "likely",
    paths: ["src/**"], pattern: "\\beval\\(", title: "eval 사용", message: "입력이 코드로 실행될 수 있음",
  }],
};

// 같은 레포를 가리키는 프로젝트 도구 프로파일 (kind "module": 평가 폴더 기준 모듈 파일)
const TOOL_PROFILE = {
  ...PROFILE,
  repo: { ...PROFILE.repo, key: "dtool", name: "demo-svc-tool", aliases: ["dtool"] },
  rules: [],
  tools: [
    { id: "lint", kind: "module", module: "tools/lint.mjs", criterion: "SEC-01" },
    { id: "missing", kind: "module", module: "tools/missing.mjs" },
    { id: "odd", kind: "linter-x" },
  ],
};
// 변경 파일의 eval( 줄마다 자동 신호 하나. 실제 린터 대신 쓰는 합성 도구
const LINT_TOOL = `export default function ({ tool, files, criteria, groupFinding, profile, helpers }) {
  const hits = [];
  for (const f of files) {
    const ls = f.added.filter((l) => /\\beval\\(/.test(l.text)).map((l) => l.line);
    if (ls.length) hits.push({ file: f.path, count: ls.length, evidence: ls.map((line) => ({ side: "head", file: f.path, line })) });
  }
  const run = { tool: tool.id, kind: tool.kind, status: "ok", note: null, introduced: hits.length, sevs: helpers.SEVERITIES.length };
  if (!hits.length || !criteria[tool.criterion]) return { run, findings: [] };
  return { run, findings: [groupFinding(profile, { id: "T-lint-eval", criterion: tool.criterion, title: "lint: eval", severity: "medium", confidence: "likely",
    failure_scenario: "입력이 코드로 실행됨", rationale: "합성 린터", recommendation: "eval 제거" }, hits)] };
}
`;

const base20 = Array.from({ length: 20 }, (_, i) => `const v${i + 1} = ${i + 1};`);

export const gitIn = (repo, ...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", env: cleanEnv() }).trim();

export function cleanEnv(extra = {}) {
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  for (const k of ["VERIFY_EVAL_DIR", "VERIFY_WORKSPACE", "CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH"]) delete env[k];
  return { ...env, ...extra };
}

// 브랜치: main(기준), feat/x(src/core/a.js 5–7줄 추가, 6줄에 eval), 이상한 이름 브랜치(같은 변경)
export const WEIRD_BRANCH = "feat/x$(touch${IFS}PWNED);b`id`";

export function makeWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), "verify-test-"));
  const w = (p, s) => { mkdirSync(dirname(join(ws, p)), { recursive: true }); writeFileSync(join(ws, p), typeof s === "string" ? s : JSON.stringify(s, null, 2)); };
  w("docs/evaluation/config/scoring.json", SCORING);
  w("docs/evaluation/framework.md", "# framework (fixture)\n");
  w("docs/evaluation/rubrics/SEC.md", rubric("SEC", ["| SEC-01 | 입력 검증 | 공통 | 1.0 | 50 |"]));
  w("docs/evaluation/rubrics/REL.md", rubric("REL", ["| REL-01 | 멱등성 | 서버 | 1.5 | 30 |", "| REL-08 | 구매 흐름 | 클라이언트 | 1.5 | 30 |"]));
  w("docs/evaluation/profiles/demo.json", PROFILE);
  w("docs/evaluation/profiles/dtool.json", TOOL_PROFILE);
  w("docs/evaluation/tools/lint.mjs", LINT_TOOL);

  const repo = join(ws, "repos/demo");
  mkdirSync(join(repo, "src/core"), { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "src/core/a.js"), base20.join("\n") + "\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "base");
  for (const br of ["feat/x", WEIRD_BRANCH]) {
    gitIn(repo, "checkout", "-q", "-b", br, "main");
    const lines = [...base20.slice(0, 4), "const a = 1;", "eval(a);", "const b = 2;", ...base20.slice(4)];
    writeFileSync(join(repo, "src/core/a.js"), lines.join("\n") + "\n");
    gitIn(repo, "commit", "-q", "-am", `change ${br.length}`);
  }
  gitIn(repo, "checkout", "-q", "main");
  return { ws, repo, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

// prepare.mjs는 --session이 있어야 돈다. 시험은 고정 세션 id를 넣는다(session: false면 넣지 않음)
export const TEST_SESSION = "11111111-2222-4333-8444-555555555555";
export function run(ws, script, args = [], { input, env = {}, session = true } = {}) {
  const sessionArgs = script === "prepare.mjs" && session && !args.some((a) => a.startsWith("--session")) ? ["--session", TEST_SESSION] : [];
  const r = spawnSync(process.execPath, [join(SCRIPTS, script), ...sessionArgs, ...args], {
    cwd: ws, input: input ?? "", encoding: "utf8", env: cleanEnv({ VERIFY_WORKSPACE: ws, ...env }),
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function prepare(ws, args = ["demo", "feat/x", "--no-fetch", "--season", "off"]) {
  const r = run(ws, "prepare.mjs", args);
  const m = r.out.match(/^RUN_DIR=(.+)$/m);
  if (!m) throw new Error(`prepare 실패 (${r.code}): ${r.err}${r.out}`);
  const runDir = join(ws, m[1]);
  return { ...r, runDir, ctx: JSON.parse(readFileSync(join(runDir, "context.json"), "utf8")) };
}

export const readJsonFile = (p) => JSON.parse(readFileSync(p, "utf8"));

export function finding(id, criterion, extra = {}) {
  return {
    id, criterion, severity: "high", confidence: "confirmed", origin: "introduced", title: `${id} 제목`,
    failure_scenario: "시나리오", evidence: [{ side: "head", file: "src/core/a.js", line: 6 }], ...extra,
  };
}

export function writeJudgment(runDir, ctx, dim, findings = [], extra = {}) {
  const criteria = ctx.dimensions.find((d) => d.id === dim).criteria.map((id) => ({ id, status: "evaluated" }));
  const p = join(runDir, "judgments", `${dim}.json`);
  writeFileSync(p, JSON.stringify({ dimension: dim, run_id: ctx.run_id, model: MODEL, criteria, findings, ...extra }, null, 2));
}

export function writeRefutation(runDir, ctx, chunk, verdicts) {
  writeFileSync(join(runDir, "refutation", `${chunk}.json`), JSON.stringify({ run_id: ctx.run_id, model: MODEL, chunk, verdicts }, null, 2));
}

// 테스트마다 독립된 실행 디렉터리: prepare가 만든 context.json만 복사한다
export function freshRun(ws, base, name) {
  const runDir = join(ws, ".verify/runs", name);
  for (const d of ["judgments", "refutation", "refutation-targets", "packets"]) mkdirSync(join(runDir, d), { recursive: true });
  const ctx = { ...base.ctx, run_dir: `.verify/runs/${name}` };
  writeFileSync(join(runDir, "context.json"), JSON.stringify(ctx, null, 2));
  return { runDir, ctx, rel: ctx.run_dir };
}
