#!/usr/bin/env node
// PreToolUse(Bash) hook: `gh pr create` 전에 현재 HEAD의 /pr-verify 리포트를 확인한다.
// PASS면 그대로 진행, 리포트가 없거나 REVIEW_REQUIRED·BLOCK이면 사용자 승인(ask)에서 멈춘다.
// 장기 브랜치(프로파일 long_lived_branches)의 PR은 갈림점 기준 전체 모드 리포트가 있어야 한다
// (index 항목 mode "full", base_sha = merge-base(origin/<PR base>, head)).
// ask 사유에는 PR base..head 중 어느 검증 범위(index ranges)에도 안 든 커밋 수를 정보로 붙인다.
// 프로파일에 feature_map이 있으면 피처맵 낡음 개수도 정보로 붙인다. 피처맵 검사 도구는 플러그인에 없어서
// VERIFY_FM_BIN(fm-check.mjs가 있는 폴더)을 설정한 경우에만 돈다. 설정이 없거나 못 돌리면 그 사실만 정보로 붙인다.
// 대상 레포는 프로젝트 평가 폴더(기본 docs/evaluation, VERIFY_EVAL_DIR로 바꿈)의 profiles/*.json에 등록된 것만.
// 플러그인 훅이라 모든 레포에 걸리지만, 프로파일이 없거나 등록되지 않은 레포에서는 아무것도 하지 않는다.
// 레포 찾기: -R/--repo slug → cwd의 git 공용 디렉터리(worktree도 본 레포와 같음) → cwd의 origin URL slug.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

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
  try { return { ...JSON.parse(readFileSync(join(profilesDir, f), "utf8")), _file: join(profilesDir, f) }; } catch { return null; }
}).filter(Boolean);

const git = (dir, args, stdin) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", input: stdin, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"], maxBuffer: 512 * 1024 * 1024 }).trim();
  } catch { return null; }
};
const opt = (names) => {
  for (const n of names) {
    const m = cmd.match(new RegExp(`(?:^|\\s)${n}(?:=|\\s+)("[^"]+"|'[^']+'|\\S+)`));
    if (m) return m[1].replace(/^["']|["']$/g, "");
  }
  return null;
};

// 1) 레포: -R/--repo 우선, 없으면 `cd <dir> &&` 또는 cwd의 git 공용 디렉터리, 그다음 origin URL
let cwd = input.cwd || root;
const cd = cmd.match(/(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)\s*&&[^;|]*gh\s+pr\s+create/);
if (cd) cwd = resolve(cwd, cd[1].replace(/^["']|["']$/g, ""));
const slugOf = (url) => {
  const s = String(url ?? "").trim();
  const m = s.match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i) || s.match(/^([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
  return m ? m[1].toLowerCase() : null;
};
const bySlug = (slug) => (slug ? profiles.find((p) => p.repo.github.toLowerCase() === slug) ?? null : null);
const realOf = (p) => { try { return realpathSync(p); } catch { return p; } };
// 공용 git 디렉터리: worktree(git 디렉터리를 본 레포와 함께 씀)도 본 레포와 같은 값이 나온다
const commonDir = (dir) => {
  const d = git(dir, ["rev-parse", "--git-common-dir"]);
  return d ? realOf(isAbsolute(d) ? d : resolve(dir, d)) : null;
};
const repoFlag = opt(["-R", "--repo"]);
const cwdCommon = commonDir(cwd);
const cwdProfile = cwdCommon ? profiles.find((p) => commonDir(resolve(root, p.repo.path)) === cwdCommon) ?? bySlug(slugOf(git(cwd, ["config", "--get", "remote.origin.url"]))) : null;
const profile = repoFlag ? bySlug(slugOf(repoFlag)) : cwdProfile;
if (!profile) process.exit(0);
// 브랜치·HEAD는 명령이 도는 작업 트리에서 읽는다(같은 레포일 때). 다른 곳이면 프로파일의 레포 경로
const repoDir = cwdProfile === profile ? cwd : resolve(root, profile.repo.path);

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

if (!sha) ask(`${profile.repo.name} ${label ?? "?"}의 커밋을 확인하지 못함 — /harness-james:pr-verify ${profile.repo.aliases[0]} ${label ?? ""} 실행 후 PR 생성 권장`);
const indexPath = join(evalDir, "reports", profile.repo.name, "index.json");
let index = null;
try { index = JSON.parse(readFileSync(indexPath, "utf8")); } catch { index = null; }
const entry = index?.by_sha?.[sha] ?? null;
const target = `${profile.repo.name} ${label}@${sha.slice(0, 7)}`;

// 3) PR base: -B/--base, 없으면 프로파일 default_base에서 origin/을 뺀 값. 갈림점 = merge-base(origin/<PR base>, head)
const prBase = String(opt(["-B", "--base"]) ?? profile.repo.default_base ?? "").replace(/^origin\//, "");
const prBaseSha = prBase && git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${prBase}^{commit}`]) || git(repoDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${prBase}^{commit}`]);
const fork = prBaseSha ? git(repoDir, ["merge-base", prBaseSha, sha]) : null;

// 4) 검증 범위 장부: PR base..head 중 어느 범위(base..head)에도 안 든 커밋. rebase로 SHA가 바뀐 커밋은 patch-id로 맞춘다
function uncovered() {
  if (!fork) return null;
  const has = (c) => git(repoDir, ["cat-file", "-e", `${c}^{commit}`]) !== null;
  const list = (revs) => (git(repoDir, ["rev-list", ...revs]) ?? "").split("\n").filter(Boolean);
  const all = list([sha, `^${fork}`]);
  if (!all.length) return { n: 0, total: 0, byPatch: 0 };
  // index ranges[]. 예전 항목(ranges 없음)은 base_sha나 리포트 json의 base.merge_base로 메운다
  const ranges = [...(index?.ranges ?? [])];
  for (const [head, v] of Object.entries(index?.by_sha ?? {})) {
    if (ranges.some((r) => r.head === head)) continue;
    let mb = v.base_sha ?? null;
    if (!mb && v.json) { try { mb = JSON.parse(readFileSync(join(root, v.json), "utf8")).base?.merge_base ?? null; } catch {} }
    if (mb) ranges.push({ base: mb, head });
  }
  const revsOf = (r) => [r.head, ...(r.base && has(r.base) ? [`^${r.base}`] : [])];
  const known = ranges.filter((r) => r.head && has(r.head));
  const covered = new Set();
  for (const r of known) for (const c of list(revsOf(r))) covered.add(c);
  let left = all.filter((c) => !covered.has(c));
  let byPatch = 0;
  if (left.length && left.length <= 500 && known.length) {
    const pid = (revs) => {
      const out = git(repoDir, ["patch-id", "--stable"], git(repoDir, ["log", "-p", "--no-color", "--no-merges", ...revs]) ?? "") ?? "";
      return new Map(out.split("\n").filter(Boolean).map((l) => l.split(" ")).map(([p, c]) => [c, p]));
    };
    const coveredIds = new Set();
    for (const r of known) for (const p of pid(revsOf(r)).values()) coveredIds.add(p);
    const leftIds = pid(["--no-walk=unsorted", ...left]);
    const before = left.length;
    left = left.filter((c) => !(leftIds.has(c) && coveredIds.has(leftIds.get(c))));
    byPatch = before - left.length;
  }
  return { n: left.length, total: all.length, byPatch };
}
const cov = (() => { try { return uncovered(); } catch { return null; } })();
const covNote = cov === null
  ? ` [정보] PR base ${prBase}를 찾지 못해 검증 범위 밖 커밋을 세지 못함.`
  : cov.n ? ` [정보] PR base ${prBase}..head ${cov.total}커밋 중 어느 검증 범위에도 안 든 커밋 ${cov.n}개${cov.byPatch ? ` (rebase로 바뀐 ${cov.byPatch}개는 patch-id로 맞춤)` : ""}.` : "";
// 피처맵 낡음: 기능 파일의 verified 뒤 구조 경로에 커밋이 있는 것. 결정적이고 수 초 안이라 ask 직전에만 돌린다
function featureNote() {
  if (!profile.feature_map) return "";
  if (!process.env.VERIFY_FM_BIN) return " [정보] 프로파일에 feature_map이 있지만 피처맵 검사 도구 위치(VERIFY_FM_BIN)가 설정되지 않아 낡음을 세지 않음.";
  const bin = join(resolve(root, process.env.VERIFY_FM_BIN), "fm-check.mjs");
  if (!existsSync(bin)) return ` [정보] 피처맵 검사 도구 없음(${bin}) — 낡음을 세지 않음.`;
  const dir = mkdtempSync(join(tmpdir(), "pr-gate-fm-"));
  try {
    const r = spawnSync(process.execPath, [bin, "--profile", profile._file, "--repo", repoDir, "--head", sha, "--json", join(dir, "fm.json"), "--quiet"], { cwd: root, encoding: "utf8", timeout: 15_000 });
    if (r.status !== 0) return " [정보] 피처맵 검사 도구 실패 — 낡음을 세지 않음.";
    const sig = JSON.parse(readFileSync(join(dir, "fm.json"), "utf8"));
    const stale = (sig.items ?? []).filter((i) => i.kind === "feature-stale").map((i) => i.symbol);
    return stale.length ? ` [정보] 피처맵 낡음 ${stale.length}개(${stale.slice(0, 5).join(", ")}${stale.length > 5 ? " …" : ""}).` : "";
  } catch { return " [정보] 피처맵 검사 도구 실패 — 낡음을 세지 않음."; } finally { rmSync(dir, { recursive: true, force: true }); }
}
const askInfo = (reason) => ask(`${reason}${covNote}${featureNote()}`);

// 5) 장기 브랜치 → PR base: 갈림점 기준 전체 모드 리포트가 있어야 지금 규칙으로 넘어간다
if ((profile.long_lived_branches ?? []).includes(label)) {
  const fullCmd = `/harness-james:pr-verify ${profile.repo.aliases[0]} ${label} --full`;
  if (!fork) askInfo(`${target}는 장기 브랜치인데 PR base ${prBase}를 찾지 못해 갈림점을 확인할 수 없음. fetch 뒤 ${fullCmd} 결과로 다시 시도하세요. 그래도 PR을 만들려면 승인.`);
  const miss = [];
  if (!entry) miss.push("head SHA의 검증 리포트 없음");
  else {
    if (entry.mode !== "full") miss.push(`리포트가 ${entry.mode === "incremental" ? "증분" : "모드 기록 없는"} 실행`);
    if (entry.base_sha !== fork) miss.push(`검증 base ${entry.base_sha ? entry.base_sha.slice(0, 7) : "기록 없음"} ≠ 갈림점 ${fork.slice(0, 7)}`);
    else if (entry.fork_point && entry.fork_point !== fork) miss.push(`리포트 갈림점 ${entry.fork_point.slice(0, 7)} ≠ ${fork.slice(0, 7)}`);
  }
  if (miss.length) askInfo(`${target}는 장기 브랜치 → ${prBase} PR이라 갈림점(${fork.slice(0, 7)}) 기준 전체 검증이 필요함: ${miss.join(", ")}. 먼저 ${fullCmd} 를 실행하세요. 그래도 PR을 만들려면 승인.`);
}
if (!entry) askInfo(`${target}의 검증 리포트 없음. 먼저 /harness-james:pr-verify ${profile.repo.aliases[0]} ${label} 를 실행하세요. 그래도 PR을 만들려면 승인.`);
if (entry.gate === "PASS") process.exit(0);
if (entry.gate === "REVIEW_REQUIRED") askInfo(`${target} = REVIEW_REQUIRED (종합 ${entry.overall}, 직접 검토 트리거 ${entry.triggers}건). 리포트 ${entry.report} 의 검토 패킷을 확인했으면 승인.`);
askInfo(`${target} = BLOCK (종합 ${entry.overall}, 차단 사유 ${entry.block_reasons}건). 리포트 ${entry.report}. 수정 후 /harness-james:pr-verify 재실행 권장 — 그래도 PR을 만들려면 승인.`);
