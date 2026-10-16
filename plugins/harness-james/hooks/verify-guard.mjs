#!/usr/bin/env node
// /verify 에이전트 전용 PreToolUse 가드. 플러그인 hooks/hooks.json에 걸려 모든 세션의 도구 호출마다 불리고,
// 훅 입력의 agent_type이 verify 에이전트(lib/verify-agents.mjs)일 때만 판정한다. 그 밖의 호출은 바로 통과시킨다.
// (플러그인 에이전트는 frontmatter hooks를 무시한다: code.claude.com/docs/en/sub-agents "plugin subagents don't support the hooks ... fields")
// 검증은 읽기 전용이어야 한다: 쓰기는 .verify/ 와 <평가 폴더>/reports/ 아래만,
// 소스 레포 변경·빌드·테스트(자격증명으로 실제 외부 시스템을 부를 수 있음)·배포·외부 전송은 거부한다.
// 평가 폴더는 프로젝트의 docs/evaluation(VERIFY_EVAL_DIR로 바꿀 수 있음). 프로젝트 전용 차단 명령은 <평가 폴더>/config/guard.json에 둔다.
// Agent 도구는 lib/verify-agents.mjs의 CHILDREN에 적힌, 자기와 같은 플러그인의 subagent_type만 띄울 수 있다.
// verify 에이전트의 호출에서 훅이 스스로 죽으면 막는다(fail closed): 입력을 못 읽거나, 모듈·guard.json을 못 읽거나, 예외가 나면
// deny JSON을 내고 exit 2로 끝낸다. Claude Code는 0·2 밖의 종료 코드와 시작 실패·시간 초과를 통과로 보므로
// (code.claude.com/docs/en/hooks "Block the action when a hook fails"), hooks.json에도 onFailure: block을 둔다.
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const denyJson = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `[verify-guard] ${reason}` } });
const crash = (e) => {
  const reason = `가드가 판정하지 못해 막음 (fail closed): ${String(e?.message ?? e).slice(0, 200)}`;
  try { process.stdout.write(`${denyJson(reason)}\n`); } catch {}
  try { process.stderr.write(`[verify-guard] ${reason}\n`); } catch {}
  process.exit(2);
};
process.on("uncaughtException", crash);
process.on("unhandledRejection", crash);

let input, classify, scan, role, allowedAgents;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch (e) {
  crash(new Error(`입력 JSON을 읽지 못함: ${e.message}`));
}
if (!input || typeof input !== "object" || Array.isArray(input)) crash(new Error("입력이 JSON 객체가 아님"));
// verify 에이전트가 아닌 호출(메인 세션, 다른 에이전트)은 판정하지 않는다
if (typeof input.agent_type !== "string" || !/(?:^|:)verify-(?:orchestrator|judge|refuter|explorer)$/.test(input.agent_type)) process.exit(0);
try {
  const agents = await import("./lib/verify-agents.mjs");
  role = agents.verifyRole(input.agent_type);
  if (!role) process.exit(0);
  allowedAgents = agents.allowedChildren(role);
  ({ classify, scan } = await import("./lib/shell-commands.mjs"));
} catch (e) {
  crash(new Error(`lib 모듈을 불러오지 못함: ${e.message}`));
}

try {
  main();
} catch (e) {
  crash(e);
}
process.exit(0);

function main() {
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
// 평가 폴더(프로파일·리포트·보정 자료): 프로젝트 기준 상대 경로. 기본 docs/evaluation
const evalRel = (process.env.VERIFY_EVAL_DIR || "docs/evaluation").replace(/\/+$/, "");
const evalDir = resolve(root, evalRel);
const EVAL = relative(root, evalDir) || "."; // 메시지·글자 단위 판정용
const projectRules = loadProjectRules(join(evalDir, "config/guard.json"));
const allowedDirs = [join(root, ".verify"), join(evalDir, "reports")];
const WRITE_WHY = `검증 중에는 .verify/ 와 ${EVAL}/reports/ 밖에 쓸 수 없음`;
const inside = (p) => {
  const abs = isAbsolute(p) ? p : resolve(input.cwd || root, p);
  return allowedDirs.some((d) => {
    const rel = relative(d, abs);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
};
const deny = (reason) => {
  console.log(denyJson(reason));
  process.exit(0);
};

const tool = input.tool_name;
const ti = input.tool_input ?? {};

// 블라인드 유지: 검증 에이전트는 정답·시드 정보를 읽을 수 없다
// (보정 기록·시드 카탈로그, 작업 지시서, 대화 기록, 사용자 답안 파일)
const home = process.env.HOME || "";
// ~/.codex: GPT(Codex) 세션 기록에 심은 결함 계획이 남는다. 작업 트리(~/.codex/worktrees)만 허용
const AGENT_LOGS = [join(home, ".claude/projects"), join(home, ".codex"), "/private/tmp/claude-", "/tmp/claude-"];
const ALLOWED_UNDER_BLOCKED = [join(home, ".codex/worktrees")];
const BLOCKED = [join(evalDir, "calibration"), join(root, ".verify/tasks"), ...AGENT_LOGS];
const BLOCKED_WORDS = /answer[-_]?key|blind[-_]?key|seed-catalog|seeds\.json/i;
const isBlockedPath = (p) => {
  if (!p) return false;
  const abs = isAbsolute(p) ? p : resolve(input.cwd || root, p);
  if (ALLOWED_UNDER_BLOCKED.some((a) => abs === a || abs.startsWith(a + "/"))) return BLOCKED_WORDS.test(p);
  return BLOCKED.some((b) => abs === b || abs.startsWith(b.endsWith("/") || b.endsWith("-") ? b : b + "/")) || BLOCKED_WORDS.test(p);
};
// 검색 범위가 차단 디렉터리를 품는 상위(워크스페이스 루트·docs·docs/evaluation·홈)면 거부
const SEARCH_ROOTS = [...new Set([root, join(root, "docs"), dirname(evalDir), evalDir, home, "/"])];
const isTooBroad = (p) => {
  const abs = resolve(input.cwd || root, p || ".");
  return SEARCH_ROOTS.includes(abs.replace(/\/$/, "") || "/");
};
const denyBlind = (what) => deny(`${what} — 검증 에이전트는 보정·정답 자료와 대화 기록을 읽을 수 없음. 검색은 RUN_DIR/head·base, 레포, 문서 폴더처럼 구체 경로로 좁혀라`);

if (tool === "Read" && isBlockedPath(ti.file_path)) denyBlind(`읽기 차단: ${ti.file_path}`);
if (tool === "Grep" || tool === "Glob") {
  if (isBlockedPath(ti.path) || (tool === "Glob" && BLOCKED_WORDS.test(ti.pattern ?? ""))) denyBlind(`검색 차단: ${ti.path ?? ti.pattern}`);
  if (isTooBroad(ti.path)) denyBlind(`검색 범위가 너무 넓음: ${ti.path ?? "(현재 디렉터리)"}`);
}
if (["Read", "Grep", "Glob"].includes(tool)) return;

if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
  const p = ti.file_path ?? ti.notebook_path ?? "";
  if (!p || !inside(p)) deny(`${WRITE_WHY}: ${p}`);
  return;
}

// 하위 에이전트: 허용 목록의 subagent_type만. 생략(general-purpose)·fork·가드 없는 에이전트를 거친 우회를 막는다
if (tool === "Agent" || tool === "Task") {
  const t = ti.subagent_type;
  const list = allowedAgents.length ? allowedAgents.join(", ") : "(없음)";
  if (typeof t !== "string" || !allowedAgents.includes(t)) deny(`이 에이전트는 Agent 도구로 ${list}만 띄울 수 있음: ${t ?? "(subagent_type 없음 = general-purpose)"}`);
  if (ti.isolation) deny(`하위 에이전트의 isolation(${ti.isolation}) 지정 금지 — 같은 작업 디렉터리에서 가드를 받으며 돌아야 함`);
  if (ti.model) deny(`하위 에이전트의 model 지정 금지 — 에이전트 정의의 모델을 그대로 쓴다: ${ti.model}`);
  return;
}

if (tool !== "Bash") deny(`가드가 모르는 도구: ${tool}`);

// Bash 판정. 정규식 한 줄 대신 명령을 셸처럼 읽어(lib/shell-commands.mjs) 실행 파일 이름의 basename으로 본다.
// 그래서 경로 접두사(/usr/bin/curl, ../x/gradlew), 따옴표, env·sudo·nohup·xargs·find -exec, bash -c·eval 문자열 안도 잡는다.
// 읽을 수 없는 부분(파싱 실패, 계산된 명령 이름, 셸·인터프리터로 흘러가는 데이터, 인터프리터 코드)은 글자 단위로 다시 보고 막는다(fail closed).
// cat build.gradle, grep 'curl ' x, echo "git push" 처럼 이름을 데이터로만 쓰는 명령은 통과한다.
const baseName = (v) => v.slice(v.lastIndexOf("/") + 1); // gradle/ 은 디렉터리라 이름이 빈다
const P = "(?:^|[\\s;&|(){}`'\"=/:,[\\]])"; // 글자 단위 판정에서 실행 이름 앞에 올 수 있는 글자
const E = "(?=$|[\\s;&|(){}`'\",\\]])";

// 1) 빌드·테스트·앱 실행
const BUILD_WHY = `빌드·테스트·앱 실행 (${projectRules.build_note || "테스트가 자격증명으로 실제 외부 시스템을 부를 수 있음"})`;
const BUILD_ANY = new Set(["gradlew", "gradle", "mvn", "mvnw", "docker", "docker-compose", "podman", "npx", "bunx", "pnpx"]);
const PKG = new Set(["npm", "yarn", "pnpm", "bun"]);
// 패키지 매니저는 읽기 하위 명령만 허용. yarn <스크립트>·bun <파일>처럼 이름 없이도 실행되므로 허용 목록으로 본다
const PKG_READ = new Set(["-v", "--version", "-h", "--help", "help", "view", "info", "ls", "list", "why", "outdated", "explain", "root", "bin", "prefix"]);
const buildAt = (vals, j) => {
  const name = baseName(vals[j]), rest = vals.slice(j + 1);
  if (BUILD_ANY.has(name)) return BUILD_WHY;
  if (name === "java") return rest.some((v) => !/^-{1,2}(version|showversion|help|h|\?)$/.test(v)) ? BUILD_WHY : null;
  if (PKG.has(name)) {
    const sub = rest.find((v) => !v.startsWith("-"));
    const read = sub === undefined ? rest.length && rest.every((v) => PKG_READ.has(v)) : PKG_READ.has(sub);
    return read ? null : BUILD_WHY;
  }
  return null;
};

// 2) 외부 전송. 인자와 상관없이 막는다 (문서 확인은 WebFetch)
const NET_WHY = "외부 전송 (문서 확인은 WebFetch 사용)";
const NET = new Set(["curl", "wget", "nc", "ncat", "netcat", "ssh", "scp", "sftp", "rsync", "ftp", "lftp", "telnet", "socat", "aria2c"]);
const netAt = (vals, j) => (NET.has(baseName(vals[j])) ? NET_WHY : null);

// 3) 제자리 파일 수정 (sed -i, perl -i, ruby -i). 짧은 옵션 묶음(-ni, -pi.bak)을 글자 단위로 읽는다.
// stop: 이 글자 뒤는 값이라 더 읽지 않는다 (perl -Mstrict 의 i는 옵션이 아니다)
const INPLACE_WHY = "제자리 파일 수정";
const INPLACE = {
  sed: { hit: "iI", stop: "efl", value: new Set(["-e", "-f", "-l", "--expression", "--file", "--line-length"]) },
  perl: { hit: "i", stop: "eEMmIxCdDlF0123456789", value: new Set(["-e", "-E", "-I", "-M", "-m", "-x", "-C", "-d", "-D", "-l", "-F", "-0"]) },
  ruby: { hit: "i", stop: "eIrCEFx0KTW", value: new Set(["-e", "-I", "-r", "-C", "-E", "-F", "-x", "-K", "-T", "-W"]) },
};
const inplaceKind = (name) => (/^g?sed$/.test(name) ? "sed" : /^perl[\d.]*$/.test(name) ? "perl" : /^ruby[\d.]*$/.test(name) ? "ruby" : null);
const inplaceAt = (vals, j) => {
  const kind = inplaceKind(baseName(vals[j]));
  if (!kind) return null;
  const spec = INPLACE[kind];
  // GNU sed는 파일 이름 뒤의 -i도 받으므로 끝까지 본다. -e 값(스크립트)만 건너뛴다
  for (let k = j + 1; k < vals.length; k++) {
    const v = vals[k];
    if (v === "--") break;
    if (/^--in-place(=|$)/.test(v)) return INPLACE_WHY;
    if (spec.value.has(v) || v.startsWith("--")) { if (spec.value.has(v)) k++; continue; }
    if (!/^-[^-]/.test(v)) continue;
    for (const ch of v.slice(1)) {
      if (spec.hit.includes(ch)) return INPLACE_WHY;
      if (spec.stop.includes(ch)) break;
    }
  }
  return null;
};

// 4) GitHub CLI: 읽기 명령만 허용 (모르는 하위 명령·별칭·확장은 막는다)
const GH_WHY = "GitHub 쓰기 작업";
const GH_READ = {
  pr: ["view", "list", "diff", "checks", "status"], issue: ["view", "list", "status"], release: ["view", "list"],
  repo: ["view", "list"], run: ["view", "list"], workflow: ["view", "list"], label: ["list"], gist: ["view", "list"],
  cache: ["list"], ruleset: ["view", "list", "check"], auth: ["status"], search: "*", status: "*", help: "*", version: "*",
};
const ghAt = (vals, j) => {
  if (baseName(vals[j]) !== "gh") return null;
  let i = j + 1;
  while (i < vals.length && vals[i].startsWith("-")) {
    if (["--version", "--help", "-h"].includes(vals[i])) return null;
    i += ["-R", "--repo", "--hostname"].includes(vals[i]) ? 2 : 1;
  }
  const group = vals[i], verb = vals[i + 1];
  if (group === undefined) return null;
  if (group === "api") return ghApiWrites(vals.slice(i + 1)) ? "GitHub API 쓰기" : null;
  const ok = GH_READ[group];
  if (ok === "*" || (ok && (ok.includes(verb) || verb === undefined || ["--help", "-h"].includes(verb)))) return null;
  return GH_WHY;
};
// gh api는 필드(-f/-F/--input)가 있으면 기본 메서드가 POST다. 명시한 GET·HEAD만 읽기로 본다
const ghApiWrites = (args) => {
  let method = null, body = false;
  for (let k = 0; k < args.length; k++) {
    const v = args[k];
    let m;
    if (v === "-X" || v === "--method") { method = args[++k] ?? ""; continue; }
    if ((m = /^(?:-X|--method=)(.+)$/.exec(v))) { method = m[1]; continue; }
    if (/^(-f|-F|--field|--raw-field|--input)$/.test(v)) { body = true; k++; continue; }
    if (/^(-[fF].|--(field|raw-field|input)=)/.test(v)) body = true;
  }
  method = (method ?? (body ? "POST" : "GET")).toUpperCase();
  return !["GET", "HEAD"].includes(method);
};

// 5) git: 전역 옵션(-P, --no-pager, -c k=v, -C, --git-dir, --work-tree …)을 건너뛰고 하위 명령을 본다.
// 읽기 명령만 허용하고, 쓰기 형태가 섞일 수 있는 명령(branch·tag·stash·config …)은 읽기 형태만 허용한다
const GIT_WHY = "소스 레포를 바꾸는 git 명령";
const GIT_VALUE = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"]);
// -c로 바꿔도 명령을 실행하지 않는 설정만 허용 (core.pager·alias.*·core.fsmonitor·core.sshCommand 등은 명령을 실행한다)
const GIT_SAFE_CONFIG = /^(color\.|core\.quotepath$|core\.abbrev$|log\.|i18n\.|safe\.directory$|grep\.|column\.|diff\.(renames|algorithm|noprefix|mnemonicprefix|relative|context|interhunkcontext|indentheuristic|colormoved)$|blame\.|status\.)/i;
const GIT_READ = new Set(["grep", "ls-tree", "ls-files", "cat-file", "show", "log", "diff", "blame", "annotate", "rev-parse", "status", "merge-base", "describe", "shortlog", "rev-list", "name-rev", "for-each-ref", "show-ref", "show-branch", "cherry", "count-objects", "check-ignore", "check-attr", "diff-tree", "diff-index", "diff-files", "range-diff", "whatchanged", "version", "help", "var"]);
const LIST_FLAG = /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at|-n\d*)$/;
const VALUE_FLAG = /^(--contains|--no-contains|--merged|--no-merged|--points-at|--sort|--format|--abbrev)$/;
const positionals = (args) => {
  const out = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k];
    if (v === "--") { out.push(...args.slice(k + 1)); break; }
    if (VALUE_FLAG.test(v)) { if (args[k + 1] !== undefined && !args[k + 1].startsWith("-")) k++; continue; }
    if (!v.startsWith("-")) out.push(v);
  }
  return out;
};
const gitSubRead = (sub, args) => {
  if (GIT_READ.has(sub)) {
    if (sub === "grep" && args.some((v) => /^(-O|--open-files-in-pager)/.test(v))) return false; // 페이저 명령 실행
    for (let k = 0; k < args.length; k++) { // log·diff --output=<파일>은 쓰기
      const m = /^--output(?:=(.*))?$/.exec(args[k]);
      if (m && !inside(m[1] ?? args[k + 1] ?? "")) return false;
    }
    return true;
  }
  const first = args[0];
  switch (sub) {
    case "branch": {
      if (!args.every((v) => /^-[arvliq]+$/.test(v) || LIST_FLAG.test(v) || VALUE_FLAG.test(v) || /^--(all|remotes|verbose|show-current|ignore-case|no-color|no-column|no-abbrev|quiet)$/.test(v) || /^--(sort|format|color|column|abbrev)=/.test(v) || !v.startsWith("-"))) return false;
      const listing = args.some((v) => /^-[a-z]*l[a-z]*$/.test(v) || LIST_FLAG.test(v));
      return positionals(args).length === 0 || listing;
    }
    case "tag": {
      if (args.some((v) => /^(-[a-zA-Z]*[dasufmFe]|--(delete|annotate|sign|local-user|force|message|file|edit|create-reflog|cleanup|trailer))/.test(v) && !LIST_FLAG.test(v))) return false;
      return positionals(args).length === 0 || args.some((v) => LIST_FLAG.test(v));
    }
    case "stash": return ["list", "show"].includes(first);
    case "reflog": return !["expire", "delete", "drop"].includes(first);
    case "worktree": return first === "list";
    case "notes": { const p = positionals(args)[0]; return p === undefined || ["list", "show"].includes(p); }
    case "remote": return args.length === 0 || args.every((v) => v === "-v" || v === "--verbose") || first === "get-url";
    case "symbolic-ref": return positionals(args).length <= 1 && !args.some((v) => /^(-d|--delete)$/.test(v));
    case "config": {
      if (args.some((v) => /^(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|-e|--edit)$/.test(v))) return false;
      return ["get", "list"].includes(first) || args.some((v) => /^(--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/.test(v));
    }
    default: return false;
  }
};
const gitAt = (vals, j) => {
  if (baseName(vals[j]) !== "git") return null;
  let i = j + 1;
  while (i < vals.length && vals[i].startsWith("-")) {
    const v = vals[i];
    let key = null;
    if (v === "-c") { key = vals[i + 1] ?? ""; i += 2; }
    else if (v.startsWith("-c") && v.length > 2) { key = v.slice(2); i++; }
    else if (v === "--config-env") { key = vals[i + 1] ?? ""; i += 2; }
    else if (v.startsWith("--config-env=")) { key = v.slice(13); i++; }
    else if (v.startsWith("--exec-path=")) return "git 실행 경로 바꾸기";
    else { i += GIT_VALUE.has(v) ? 2 : 1; continue; }
    if (!GIT_SAFE_CONFIG.test(key.split("=")[0])) return `명령을 실행할 수 있는 git 설정(-c ${key.split("=")[0]})`;
  }
  const sub = vals[i];
  if (sub === undefined) return null;
  return gitSubRead(sub, vals.slice(i + 1)) ? null : GIT_WHY;
};

// 6) 프로젝트 전용 명령(<평가 폴더>/config/guard.json의 commands): 인자 없이 부르거나 allow의 앞부분 인자로 시작할 때만 허용
const projectAt = (vals, j) => {
  const rule = projectRules.commands.find((c) => c.name === baseName(vals[j]));
  if (!rule) return null;
  const rest = vals.slice(j + 1);
  if (!rest.length || rule.allow.some((pre) => pre.length <= rest.length && pre.every((v, k) => rest[k] === v))) return null;
  return rule.why;
};

// 7) 파일 쓰기 명령의 대상: 허용 디렉터리 안이어야 한다
const TGT = ["-t", "--target-directory"];
const WRITE_CMDS = {
  rm: {}, rmdir: {}, unlink: {}, tee: {}, shred: { val: ["-n", "-s", "--iterations", "--size"] },
  mv: { val: [...TGT, "-S", "--suffix"], tgt: TGT },
  cp: { last: true, val: [...TGT, "-S", "--suffix"], tgt: TGT },
  ln: { last: true, val: [...TGT, "-S", "--suffix"], tgt: TGT },
  install: { last: true, val: [...TGT, "-m", "-o", "-g", "-S", "--mode", "--owner", "--group", "--suffix"], tgt: TGT },
  touch: { val: ["-r", "-t", "-d", "--reference", "--date"] }, mkdir: { val: ["-m", "--mode"] },
  truncate: { val: ["-s", "-r", "--size", "--reference"] },
  chmod: { skip: 1 }, chown: { skip: 1 }, chgrp: { skip: 1 }, dd: { dd: true },
};
const DEV_OK = (t) => ["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"].includes(t) || t.startsWith("/dev/fd/");
const checkTarget = (t, dyn, cwdUnknown) => {
  if (dyn) return /^(\$\{?RUN_DIR\}?|\.verify)\//.test(t) && !t.includes("..") ? null : `대상 경로를 확인할 수 없는 쓰기 (${t})`;
  if (DEV_OK(t)) return null;
  if (cwdUnknown && !isAbsolute(t)) return `cd 뒤의 상대 경로라 쓰기 위치를 확인할 수 없음 (${t})`;
  return inside(t) ? null : `${WRITE_WHY} (${t})`;
};
const writeAt = (vals, j, words, cwdUnknown) => {
  const spec = WRITE_CMDS[baseName(vals[j])];
  if (!spec) return null;
  const tgts = [], pos = [];
  let opts = true;
  for (let k = j + 1; k < vals.length; k++) {
    const v = vals[k], dyn = words[k].dyn;
    if (spec.dd) { if (v.startsWith("of=")) tgts.push([v.slice(3), dyn]); continue; }
    if (opts && v === "--") { opts = false; continue; }
    if (opts && v.startsWith("-") && v !== "-") {
      const eq = v.indexOf("="), name = eq > 0 ? v.slice(0, eq) : v;
      if (spec.tgt?.includes(name)) {
        if (eq > 0) tgts.push([v.slice(eq + 1), dyn]);
        else { tgts.push([vals[k + 1] ?? "", words[k + 1]?.dyn]); k++; }
      } else if (eq < 0 && spec.val?.includes(v)) k++;
      continue;
    }
    pos.push([v, dyn]);
  }
  const p = pos.slice(spec.skip ?? 0);
  if (!(spec.last && tgts.length)) tgts.push(...(spec.last ? p.slice(-1) : p));
  for (const [t, dyn] of tgts) { const why = checkTarget(t, dyn, cwdUnknown); if (why) return why; }
  return null;
};

const AT_RULES = [buildAt, netAt, inplaceAt, ghAt, gitAt, projectAt];
const hitAt = (vals, j, words, cwdUnknown) => {
  for (const at of AT_RULES) { const why = at(vals, j); if (why) return why; }
  return writeAt(vals, j, words, cwdUnknown);
};

// 읽지 못하는 부분에 대는 글자 단위 판정 (fail closed)
const TEXT_RULES = [
  [new RegExp(`${P}(?:gradlew|gradle|mvnw?|docker(?:-compose)?|podman|npx|bunx|pnpx)${E}|${P}(?:npm|yarn|pnpm|bun)\\s+(?:install|i|ci|run|test|exec|start|add|dlx|x)\\b|(?:^|[\\s;&|(){}\`'"=/])java\\s+(?:-\\S+\\s+)*-(?:jar|cp|classpath)\\b`), BUILD_WHY],
  [new RegExp(`${P}(?:${[...NET].join("|")})${E}`), NET_WHY],
  [new RegExp(`${P}g?sed\\b[^;&|\\n]*?\\s(?:-[a-zA-Z]*[iI]|--in-place)|${P}(?:perl|ruby)[\\d.]*\\b[^;&|\\n]*?\\s-[a-zA-Z]*i|\\$\\^I\\b|inplace\\s*=\\s*True`), INPLACE_WHY],
  [new RegExp(`${P}gh\\s+(?:pr\\s+(?!view|list|diff|checks|status)\\S|issue\\s+(?!view|list|status)\\S|release\\s+(?!view|list)\\S|repo\\s+(?!view|list)\\S|workflow\\s+(?!view|list)\\S|run\\s+(?!view|list)\\S|secret|variable|label\\s+(?!list)\\S|gist\\s+(?!view|list)\\S|api\\b[^|;&\\n]*(?:-X\\s*(?!GET\\b|HEAD\\b)\\w|--method[=\\s]+(?!GET\\b|HEAD\\b)\\w|\\s-[fF]|--field|--raw-field|--input))`, "i"), GH_WHY],
  [new RegExp(`(?:^|[^\\w.-])git\\b[^;&|\\n]*?\\s(?:push|commit|checkout|switch|reset|clean|rebase|merge|cherry-pick|revert|restore|rm|mv|apply|am|pull|fetch|clone|init|submodule|update-ref|update-index|filter-branch|gc|prune|stash|tag|branch|worktree|config|notes|remote|symbolic-ref|replace)(?=$|[\\s;&|)'"\`])|(?:^|[^\\w.-])git\\s[^;&|\\n]*?(?:-c\\s*\\S*(?:pager|alias|fsmonitor|sshcommand|editor|hookspath)|--exec-path=)`, "i"), GIT_WHY],
  ...projectRules.commands.map((c) => [c.text, c.why]),
];
// 인터프리터 인라인 코드에서 네트워크 API를 쓰면 외부 전송으로 본다
const INTERP_NET = /\b(fetch|XMLHttpRequest|urllib\d?|requests|http\.client|httpx|aiohttp|socket|net\.connect|https?\.(request|get)|LWP|IO::Socket|Net::HTTP|open-uri|curl_exec|fsockopen|WebSocket)\b/;
const textHit = (src) => TEXT_RULES.find(([rx]) => rx.test(src))?.[1] ?? null;
const DYN = Symbol("dynamic");

const XARGS_VAL = new Set(["-I", "-L", "-n", "-P", "-s", "-E", "-d", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--max-lines", "--max-chars", "--replace", "--eof"]);
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
// 단순 명령 하나(단어 목록)가 막을 일을 하나: 이유 문자열, null(괜찮음), DYN(이름을 알 수 없음).
// xargs·find -exec는 안쪽 명령을 다시 읽고, 모르는 명령은 인자를 모두 의심한다
function wordsHit(words, depth, cwdUnknown) {
  if (!words.length) return null;
  const info = classify(words), vals = words.map((w) => w.value);
  if (info.kind === "empty") return null;
  if (info.kind === "dynamic") return textHit(vals.join(" ")) ?? DYN;
  const own = hitAt(vals, info.head, words, cwdUnknown);
  if (own) return own;
  if (info.name === "git" || info.name === "gh") return null; // 읽기 형태로 판정됨. 인자(경로·패턴·메시지)는 실행되지 않는다
  if (info.kind === "safe") return null;
  if (info.name === "xargs") {
    let k = info.head + 1;
    while (k < words.length && vals[k].startsWith("-")) k += XARGS_VAL.has(vals[k]) ? 2 : 1;
    const inner = words.slice(k);
    if (inner.length && WRITE_CMDS[baseName(inner[0].value)]) return `대상 경로를 확인할 수 없는 쓰기 (xargs ${inner[0].value})`;
    return wordsHit(inner, depth, cwdUnknown);
  }
  if (info.name === "find") {
    if (vals.some((v) => /^-(delete|fprint\w*|fls)$/.test(v))) return "find로 파일 지우기·쓰기";
    for (let i = info.head + 1; i < words.length; i++) {
      if (!FIND_EXEC.has(vals[i])) continue;
      let e = i + 1;
      while (e < words.length && vals[e] !== ";" && vals[e] !== "+") e++;
      const inner = words.slice(i + 1, e);
      if (inner.length && WRITE_CMDS[baseName(inner[0].value)]) return `대상 경로를 확인할 수 없는 쓰기 (find -exec ${inner[0].value})`;
      const hit = wordsHit(inner, depth, cwdUnknown);
      if (hit === DYN) return "find -exec의 명령 이름을 확인할 수 없음";
      if (hit) return hit;
      i = e;
    }
    return null;
  }
  for (let j = info.head + 1; j < vals.length; j++) {
    const at = hitAt(vals, j, words, cwdUnknown);
    if (at) return at; // sh ../x/gradlew, watch curl …, nice -n 5 …
    if (/[\s;&|`$()<>]/.test(vals[j])) { const s = runsHit(vals[j], depth + 1, cwdUnknown); if (s) return s; } // bash -c "…", eval "…", su -c "…"
  }
  if (info.kind === "interp") {
    for (const x of info.codes) {
      const t = textHit(x.text);
      if (t) return t;
      if (INTERP_NET.test(x.text)) return NET_WHY;
    }
  }
  return null;
}
function redirHit(c, cwdUnknown) {
  for (const r of c.redirs) {
    if (r.op === "<" || r.op === "<&") continue;
    if (r.op === ">&" && /^(\d+|-)$/.test(r.target.value)) continue;
    const why = checkTarget(r.target.value, r.target.dyn, cwdUnknown);
    if (why) return why;
  }
  return null;
}
function runsHit(src, depth = 0, cwdUnknown = false) {
  src = String(src);
  if (depth > 8) return textHit(src);
  let r;
  try { r = scan(src); } catch { return textHit(src); }
  for (const c of r.commands) {
    const rd = redirHit(c, cwdUnknown);
    if (rd) return rd;
    const hit = wordsHit(c.words, depth, cwdUnknown);
    if (hit === DYN) { const t = textHit(src); if (t) return t; } // G=gradlew; ./$G test
    else if (hit) return hit;
    if (c.fed && c.info.kind !== "safe") { const t = textHit(src); if (t) return t; } // echo 'curl x' | sh
    if (["cd", "pushd", "popd"].includes(c.info.name)) cwdUnknown = true;
  }
  for (const f of r.frags) {
    if (f.kind === "subst" || f.kind === "shell") { const s = runsHit(f.text, depth + 1, cwdUnknown); if (s) return s; }
    else { const t = textHit(f.text); if (t) return t; if (f.kind === "code" && INTERP_NET.test(f.text)) return NET_WHY; }
  }
  return null;
}

const cmd = String(ti.command ?? "");
const blockedFrag = new RegExp(`${reEsc(`${EVAL}/calibration`)}|\\.verify\\/tasks|\\.claude\\/projects|\\.codex\\/(?!worktrees)`);
const cmdNoWorktrees = cmd.split(join(home, ".codex/worktrees")).join("");
if (BLOCKED.some((b) => cmdNoWorktrees.includes(b) || cmd.includes(relative(root, b) + "/") || cmd.includes(relative(root, b) + " ") || cmd.endsWith(relative(root, b))) || blockedFrag.test(cmd) || BLOCKED_WORDS.test(cmd)) {
  denyBlind(`명령 차단: ${cmd.slice(0, 120)}`);
}
// 재귀 검색이 워크스페이스 루트·docs 전체를 훑으면 차단 (보정 자료가 섞여 나옴)
// grep은 -r·-R이 다른 옵션과 묶이거나(-rn) 뒤에 와도(-n -r), --recursive여도 재귀다
if (/(?:^|[\s;&|(])(?:rg|ag|find|grep(?:\s+-[^\s-][^\s]*|\s+--[\w-]+(?:=\S*)?)*?\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*|--(?:recursive|dereference-recursive)))(?=$|[\s;&|)])/.test(cmd)) {
  const toks = cmd.split(/\s+/);
  const broad = [".", "./", "..", "../", "docs", "docs/", ...[relative(root, dirname(evalDir)), EVAL].filter((d) => d && d !== ".").flatMap((d) => [d, d + "/"]), root, root + "/", "~", home];
  if (toks.some((t) => broad.includes(t))) denyBlind(`넓은 재귀 검색 차단: ${cmd.slice(0, 120)}`);
}
const why = runsHit(cmd);
if (why) deny(`${why} 금지: ${cmd.slice(0, 160)}`);
// 글자 단위 쓰기 대상 판정(기존). 위 판정이 못 읽은 경우(파싱 실패 등)의 안전망으로 남긴다
const targets = [];
const unquoted = cmd.replace(/'[^']*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""'); // jq '.a > 1' 같은 인용 안 부등호 제외
for (const m of unquoted.matchAll(/(?<![<>&\d])>{1,2}\s*([^\s;&|)]+)/g)) targets.push(m[1]);
for (const m of cmd.matchAll(/(?:^|[\s;&|(])tee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) targets.push(m[1]);
for (const m of cmd.matchAll(/(?:^|[\s;&|(])(rm|rmdir|mv|cp|touch|mkdir|chmod|ln)\s+((?:-[\w-]+\s+)*)([^;&|]+)/g)) {
  const paths = m[3].trim().split(/\s+/).filter((t) => t && !t.startsWith("-"));
  // cp·ln은 마지막 인자(목적지)만 쓰기 대상. rm·mv 등은 모든 인자가 바뀜
  targets.push(...(["cp", "ln"].includes(m[1]) ? paths.slice(-1) : paths));
}
for (const raw of targets) {
  const t = raw.replace(/^["']|["']$/g, "");
  if (t === "/dev/null" || t.startsWith("/dev/fd/") || t === "&1" || t === "&2") continue;
  if (t.startsWith("$") || t.includes("$(")) {
    if (/\$\{?RUN_DIR|\.verify\//.test(t)) continue;
    deny(`대상 경로를 확인할 수 없는 쓰기: ${t}`);
  }
  if (!inside(t)) deny(`${WRITE_WHY}: ${t}`);
}
}

// <평가 폴더>/config/guard.json (없으면 빈 규칙). 형식:
// { "build_note": "빌드 거부 사유에 붙일 말", "commands": [{ "name": "<실행 파일 이름>", "why": "거부 사유", "allow": [["<하위 명령>", "<동사>"], ...] }] }
// 파일이 있는데 읽을 수 없으면 예외를 내서 막는다(fail closed)
function loadProjectRules(path) {
  if (!existsSync(path)) return { build_note: null, commands: [] };
  let cfg;
  try { cfg = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new Error(`${path}를 읽지 못함: ${e.message}`); }
  const bad = (what) => { throw new Error(`${path}: ${what}`); };
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) bad("JSON 객체가 아님");
  if (cfg.build_note != null && typeof cfg.build_note !== "string") bad("build_note는 문자열");
  if (cfg.commands != null && !Array.isArray(cfg.commands)) bad("commands는 배열");
  const commands = (cfg.commands ?? []).map((c, i) => {
    if (!c || typeof c.name !== "string" || !/^[\w.+-]+$/.test(c.name)) bad(`commands[${i}].name은 실행 파일 이름`);
    const allow = c.allow ?? [];
    if (!Array.isArray(allow) || !allow.every((a) => Array.isArray(a) && a.length && a.every((v) => typeof v === "string" && v))) bad(`commands[${i}].allow는 비지 않은 문자열 배열의 배열`);
    const why = typeof c.why === "string" && c.why ? c.why : `프로젝트가 막은 명령(${c.name})`;
    // 글자 단위 판정: 이름 뒤에 인자가 오는데 allow 앞부분이 아니면 막는다
    const ok = allow.map((a) => a.map(reEsc).join("\\s+")).join("|");
    const before = "(?:^|[\\s;&|(){}`'\"=/:,[\\]])"; // 실행 이름 앞에 올 수 있는 글자 (main의 P와 같음)
    const text = new RegExp(`${before}${reEsc(c.name)}\\s+${ok ? `(?!(?:${ok})(?=$|[\\s;&|)'"\`]))` : ""}[^\\s;&|)]`);
    return { name: c.name, why, allow, text };
  });
  return { build_note: cfg.build_note ?? null, commands };
}
function reEsc(t) { return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
