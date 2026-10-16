#!/usr/bin/env node
// PreToolUse(Bash) hook: `gh pr create` 전에 현재 HEAD의 /verify 리포트를 확인한다.
// PASS면 그대로 진행, 리포트가 없거나 REVIEW_REQUIRED·BLOCK이면 사용자 승인(ask)에서 멈춘다.
// 대상 레포는 프로젝트 평가 폴더(기본 docs/evaluation, VERIFY_EVAL_DIR로 바꿈)의 profiles/*.json에 등록된 것만.
// 플러그인 훅이라 모든 레포에 걸리지만, 프로파일이 없거나 등록되지 않은 레포에서는 아무것도 하지 않는다.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const PR_CREATE = /(?<![\w.-])gh\s+pr\s+create\b|(?<![\w.-])gh\s+api\b[^|;&]*\/pulls\b[^|;&]*(-X\s*POST|--method\s+POST|\s-f\s|\s-F\s|--field|--raw-field|--input)/i;

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const cmd = String(input.tool_input?.command ?? "");
// 실제로 실행되는 명령만 본다 (heredoc 데이터·커밋 메시지·grep 인자 속 문구 제외). 읽기 모듈이 없거나 실패하면 전체 텍스트.
let hit;
try {
  const { mentions } = await import("./lib/shell-commands.mjs");
  hit = mentions(cmd, PR_CREATE);
} catch {
  hit = PR_CREATE.test(cmd);
}
if (!hit) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const evalDir = resolve(root, (process.env.VERIFY_EVAL_DIR || "docs/evaluation").replace(/\/+$/, ""));
const profilesDir = join(evalDir, "profiles");
if (!existsSync(profilesDir)) process.exit(0);
const profiles = readdirSync(profilesDir).filter((f) => f.endsWith(".json")).map((f) => {
  try { return JSON.parse(readFileSync(join(profilesDir, f), "utf8")); } catch { return null; }
}).filter(Boolean);

const git = (dir, args) => {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; }
};
const opt = (names) => {
  for (const n of names) {
    const m = cmd.match(new RegExp(`(?:^|\\s)${n}(?:=|\\s+)("[^"]+"|'[^']+'|\\S+)`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
};

// 1) 레포: -R/--repo 우선, 없으면 `cd <dir> &&` 또는 cwd의 git 루트
let cwd = input.cwd || root;
const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&[^;|]*gh\s+pr\s+create/);
if (cd) cwd = resolve(cwd, cd[1].replace(/^["']|["']$/g, ""));
const repoFlag = opt(["-R", "--repo"]);
let profile = null;
if (repoFlag) {
  const slug = repoFlag.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase();
  profile = profiles.find((p) => p.repo.github.toLowerCase() === slug) ?? null;
} else {
  const top = git(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) profile = profiles.find((p) => resolve(root, p.repo.path) === top) ?? null;
}
if (!profile) process.exit(0);
const repoDir = resolve(root, profile.repo.path);

// 2) head: --head/-H 우선, 없으면 현재 HEAD
const headFlag = opt(["-H", "--head"]);
let sha = null;
let label = headFlag;
if (headFlag) {
  const name = headFlag.includes(":") ? headFlag.split(":").pop() : headFlag;
  sha = git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${name}^{commit}`]) || git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}^{commit}`]);
  label = name;
} else {
  sha = git(repoDir, ["rev-parse", "HEAD"]);
  label = git(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

const ask = (reason) => {
  const refuse = ["bypassPermissions", "dontAsk"].includes(input.permission_mode);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: refuse ? "deny" : "ask",
      permissionDecisionReason: `[PR 검증 게이트] ${reason}`,
    },
  }));
  process.exit(0);
};

if (!sha) ask(`${profile.repo.name} ${label ?? "?"}의 커밋을 확인하지 못함 — /harness-james:verify ${profile.repo.aliases[0]} ${label ?? ""} 실행 후 PR 생성 권장`);
const indexPath = join(evalDir, "reports", profile.repo.name, "index.json");
let entry = null;
try { entry = JSON.parse(readFileSync(indexPath, "utf8")).by_sha?.[sha] ?? null; } catch { entry = null; }
const target = `${profile.repo.name} ${label}@${sha.slice(0, 7)}`;
if (!entry) ask(`${target}의 검증 리포트 없음. 먼저 /harness-james:verify ${profile.repo.aliases[0]} ${label} 를 실행하세요. 그래도 PR을 만들려면 승인.`);
if (entry.gate === "PASS") process.exit(0);
if (entry.gate === "REVIEW_REQUIRED") ask(`${target} = REVIEW_REQUIRED (종합 ${entry.overall}, 직접 검토 트리거 ${entry.triggers}건). 리포트 ${entry.report} 의 검토 패킷을 확인했으면 승인.`);
ask(`${target} = BLOCK (종합 ${entry.overall}, 차단 사유 ${entry.block_reasons}건). 리포트 ${entry.report}. 수정 후 /harness-james:verify 재실행 권장 — 그래도 PR을 만들려면 승인.`);
