#!/usr/bin/env node
// PreToolUse(Bash) hook: work from this workspace reaches protected branches only through a PR.
// Denies any push (or GitHub API ref update / direct merge) whose destination is a protected branch:
// main, master, dev, develop, development, stg, stage, staging, prd, prod, production.
// Feature-branch pushes are left alone here; require-push-approval.mjs still asks the user for every push,
// require-verify-before-pr.mjs gates `gh pr create`, and `gh pr merge` stays an approval (ask).
// A push this hook cannot read (wrapped in xargs, $(...), an unparsable script) is denied, not guessed.
// Data is not read as commands: heredoc bodies fed to cat/tee, commit messages and echo/grep arguments that mention
// a push are left alone (lib/shell-commands.mjs); without that reader, every line is read as before.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROTECTED = new Set(["main", "master", "dev", "develop", "development", "stg", "stage", "staging", "prd", "prod", "production"]);

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_OPT = String.raw`(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+${ARG}|-{1,2}[\w-]+(?:=${ARG})?)`;
// Same detection as require-push-approval.mjs, so both hooks agree on what a push is.
const PUSH = new RegExp(String.raw`(?<![\w.-])git(?:\s+${GIT_OPT})*\s+push\b|(?<![\w.-])git-push(?![\w.-])`);
const GH_API = /(?<![\w.-])gh\s+api\b/;

const WRAPPERS = new Set(["env", "command", "exec", "nohup", "time", "sudo", "builtin", "nice"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const PUSH_VALUE_OPTS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env", "--exec-path"]);

const branchOf = (ref) => ref.replace(/^refs\/heads\//, "");
const isProtected = (ref) => PROTECTED.has(branchOf(ref));

// Split a shell command into simple commands; tokens keep `raw` (with quotes) and `value` (unquoted).
export function tokenize(src) {
  const cmds = [];
  let tokens = [];
  let cur = null;
  const pushTok = () => { if (cur) { tokens.push(cur); cur = null; } };
  const endCmd = (sep) => { pushTok(); if (tokens.length) cmds.push({ tokens, sep }); tokens = []; };
  const tok = () => (cur ??= { raw: "", value: "", subst: false });
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw new Error("unterminated single quote");
      tok().raw += src.slice(i, j + 1); cur.value += src.slice(i + 1, j); i = j; continue;
    }
    if (c === '"') {
      let j = i + 1, v = "";
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === "\\" && j + 1 < src.length) { v += src[++j]; continue; }
        if (src[j] === "`" || (src[j] === "$" && src[j + 1] === "(")) tok().subst = true;
        v += src[j];
      }
      if (j >= src.length) throw new Error("unterminated double quote");
      tok().raw += src.slice(i, j + 1); cur.value += v; i = j; continue;
    }
    if (c === "\\" && i + 1 < src.length) { tok().raw += src.slice(i, i + 2); cur.value += src[i + 1]; i++; continue; }
    if (c === "$" && src[i + 1] === "(") { // keep a whole $( ... ) in one token so its contents can be checked
      let depth = 0, j = i + 1;
      for (; j < src.length; j++) { if (src[j] === "(") depth++; else if (src[j] === ")" && --depth === 0) break; }
      if (j >= src.length) throw new Error("unterminated $(");
      tok().raw += src.slice(i, j + 1); cur.value += src.slice(i, j + 1); cur.subst = true; i = j; continue;
    }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j < 0) throw new Error("unterminated backtick");
      tok().raw += src.slice(i, j + 1); cur.value += src.slice(i, j + 1); cur.subst = true; i = j; continue;
    }
    if (c === "#" && !cur) { const j = src.indexOf("\n", i); i = j < 0 ? src.length : j - 1; continue; }
    if (c === "\n" || c === ";") { endCmd(c); continue; }
    if (c === "&" && (src[i - 1] === ">" || src[i + 1] === ">")) { tok().raw += c; cur.value += c; continue; } // 2>&1, &>file
    if (c === "&" || c === "|") { const two = src[i + 1] === c; endCmd(two ? c + c : c); if (two) i++; continue; }
    if (/\s/.test(c)) { pushTok(); continue; }
    tok().raw += c; cur.value += c;
  }
  endCmd(null);
  return cmds;
}

function git(dir, args) {
  try { return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim(); }
  catch { return null; }
}

const expand = (p, dir) => resolve(dir, p.replace(/^~(?=\/|$)/, homedir()));

// Destination check for `git push <args>` run in `dir`. Returns a reason string to deny, or null.
export function pushVerdict(args, dir) {
  const positional = [];
  let remote = null, del = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^\d*>{1,2}&?\d*$|^&>{1,2}$|^\d*<$/.test(a)) { i++; continue; } // redirection operator + its target
    if (/^(\d*>{1,2}|&>{1,2}|\d*<)\S/.test(a)) continue; // redirection glued to its target
    if (a === "--") { positional.push(...args.slice(i + 1)); break; }
    if (["--all", "--branches", "--mirror"].includes(a)) return `${a} pushes every branch, protected ones included`;
    if (a === "--prune") return "--prune can delete remote branches, protected ones included";
    if (a === "--delete" || a === "-d") { del = true; continue; }
    if (a.startsWith("--repo=")) { remote = a.slice(7); continue; }
    if (PUSH_VALUE_OPTS.has(a)) { if (a === "--repo") remote = args[i + 1]; i++; continue; }
    if (/^-[a-zA-Z0-9]+$/.test(a)) { if (a.includes("d")) del = true; continue; }
    if (a.startsWith("-")) continue;
    positional.push(a);
  }
  if (!remote) remote = positional.shift() ?? null;
  const refspecs = positional;

  if (refspecs.length === 0) {
    if (git(dir, ["rev-parse", "--git-dir"]) === null) return null; // not a repo: the push fails on its own
    if (git(dir, ["config", "--get", "push.default"]) === "matching") return "push.default=matching pushes every matching branch";
    if (git(dir, ["config", "--get-all", `remote.${remote ?? "origin"}.push`])) return `remote.${remote ?? "origin"}.push is configured; name the branch explicitly`;
    const current = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (current && isProtected(current)) return `current branch '${current}' is protected`;
    const upstream = git(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
    const upBranch = upstream?.includes("/") ? upstream.slice(upstream.indexOf("/") + 1) : null;
    if (upBranch && isProtected(upBranch)) return `upstream '${upstream}' is a protected branch`;
    return null;
  }

  for (let spec of refspecs) {
    spec = spec.replace(/^\+/, "");
    if (spec.includes("*")) return `wildcard refspec '${spec}'`;
    let [src, dst] = spec.includes(":") ? [spec.slice(0, spec.indexOf(":")), spec.slice(spec.indexOf(":") + 1)] : [spec, null];
    if (dst === null || dst === "") dst = src;
    if (dst === "HEAD" || dst === "@") {
      const current = git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
      if (current === null) return "cannot tell which branch HEAD is; name the destination branch";
      dst = current;
    }
    if (dst.startsWith("refs/") && !dst.startsWith("refs/heads/")) continue; // tags and other refs are not branches
    if (isProtected(dst)) return `${del || src === "" ? "deleting" : "destination"} '${branchOf(dst)}' is a protected branch`;
  }
  return null;
}

// GitHub API calls that move a protected branch without a PR.
export function ghApiVerdict(args) {
  let method = null, implied = false, path = null;
  const fields = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") { method = (args[++i] ?? "").toUpperCase(); continue; }
    if (a.startsWith("--method=")) { method = a.slice(9).toUpperCase(); continue; }
    if (["-f", "-F", "--field", "--raw-field"].includes(a)) { implied = true; fields.push(args[++i] ?? ""); continue; }
    if (a === "--input") { implied = true; i++; continue; }
    if (a.startsWith("-")) { if (["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache"].includes(a)) i++; continue; }
    path ??= a;
  }
  const mutating = method ? method !== "GET" : implied;
  if (!mutating || !path) return null;
  const p = path.replace(/^\//, "");
  const ref = p.match(/\/git\/refs\/heads\/(.+)$/);
  if (ref && isProtected(ref[1])) return `GitHub API ${method ?? "POST"} on protected ref '${ref[1]}'`;
  if (/\/git\/refs\/?$/.test(p) && fields.some((f) => /^ref=refs\/heads\//.test(f) && isProtected(f.slice(4)))) return "GitHub API creates a protected ref";
  if (/\/merges\/?$/.test(p)) return "GitHub API merge bypasses a PR";
  const br = p.match(/\/branches\/([^/]+)\/rename$/);
  if (br && isProtected(br[1])) return `GitHub API renames protected branch '${br[1]}'`;
  return null;
}

// Shared shell reader (heredocs, quoting, $(...)): commands only, not the data around them. Without it, the old tokenizer.
let shell = null;
try { shell = await import("./lib/shell-commands.mjs"); } catch { shell = null; }

const RESERVED = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until"]);
const hasPush = (s) => PUSH.test(s) || GH_API.test(s);
const PROTECTED_WORD = new RegExp(String.raw`(?<![\w.-])(?:${[...PROTECTED].join("|")})(?![\w.-])`);

// One simple command. Returns { reason } to deny, { dir } after a cd, or null.
function step(tokens, dir, depth) {
  let t = [...tokens];
  for (;;) {
    while (t.length && RESERVED.has(t[0].raw)) t.shift();
    while (t.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0].value)) t.shift();
    if (!t.length || !WRAPPERS.has(t[0].value.split("/").pop())) break;
    t.shift();
    while (t.length && (t[0].value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t[0].value))) t.shift();
  }
  if (!t.length) return null;
  const vals = t.map((x) => x.value);
  const head = vals[0].split("/").pop();
  const rawJoined = t.map((x) => x.raw).join(" ");
  const sub = (src, d) => { const r = verdict(src, d, depth + 1); return r ? { reason: r } : null; };

  if (head === "cd" || head === "pushd") { if (vals[1] && !vals[1].startsWith("-")) return { dir: expand(vals[1], dir) }; return vals[1] ? null : { dir: homedir() }; }
  if (SHELLS.has(head)) {
    const k = vals.indexOf("-c");
    if (k >= 0 && vals[k + 1] !== undefined) return sub(vals[k + 1], dir);
    if (PUSH.test(rawJoined)) return { reason: `push inside a ${head} invocation that cannot be read` };
    return null;
  }
  if (head === "eval") return sub(vals.slice(1).join(" "), dir);
  if (head === "xargs" || head === "parallel" || head === "watch") return hasPush(rawJoined) ? { reason: `push run through ${head}` } : null;

  if (head === "git") {
    let i = 1, gdir = dir;
    while (i < vals.length && vals[i].startsWith("-")) {
      const o = vals[i];
      if (o === "-C") { gdir = expand(vals[i + 1] ?? ".", gdir); i += 2; continue; }
      if (GIT_VALUE_OPTS.has(o)) { i += 2; continue; }
      i++;
    }
    if (vals[i] === "push") { const r = pushVerdict(vals.slice(i + 1), gdir); if (r) return { reason: r }; }
    return null;
  }
  if (head === "git-push") { const r = pushVerdict(vals.slice(1), dir); return r ? { reason: r } : null; }
  if (head === "gh" && vals[1] === "api") { const r = ghApiVerdict(vals.slice(2)); return r ? { reason: r } : null; }
  return null;
}

// The pre-reader path: every line of the text read as commands (heredoc bodies included), tracking `cd`.
function legacyVerdict(src, cwd, depth) {
  let cmds;
  try { cmds = tokenize(src); } catch (e) { return `cannot parse the command (${e.message})`; }
  let dir = cwd;
  for (const { tokens } of cmds) {
    if (tokens.some((x) => x.subst && hasPush(x.raw))) return "push inside $(...) or backticks";
    const r = step(tokens, dir, depth);
    if (r?.reason) return r.reason;
    if (r?.dir) dir = r.dir;
  }
  return null;
}

// Walk the simple commands of `src`, tracking `cd` per subshell. Returns a deny reason or null.
export function verdict(src, cwd, depth = 0) {
  if (!PUSH.test(src) && !GH_API.test(src)) return null;
  if (depth > 3) return "push nested too deeply to read";
  if (!shell) return legacyVerdict(src, cwd, depth);
  let parsed;
  try { parsed = shell.scan(src); } catch (e) { return `cannot parse the command (${e.message})`; }
  if (parsed.fallback) return legacyVerdict(src, cwd, depth); // e.g. a script written and run in one command
  const dirs = new Map([["", cwd]]);
  const dirOf = (scope) => { while (!dirs.has(scope)) scope = scope.replace(/[^/]*\/$/, ""); return dirs.get(scope); };
  for (const c of parsed.commands) {
    const dir = dirOf(c.scope);
    const inline = c.info.kind === "interp" ? c.info.codes.filter((x) => shell.EXEC_API[c.info.lang].test(x.text)).map((x) => ({ kind: "code", text: x.text })) : [];
    for (const f of [...c.frags, ...inline]) {
      if (f.kind === "subst") { if (shell.mentions(f.text, PUSH, { fed: f.fed }) || shell.mentions(f.text, GH_API, { fed: f.fed })) return "push inside $(...) or backticks"; }
      else if (f.kind === "code") { // only when a protected branch is named; other pushes in code are left to the approval hook
        if (hasPush(f.text) && PROTECTED_WORD.test(f.text)) return "push to a protected branch inside script code that cannot be read";
      }
      else { const r = verdict(f.text, dir, depth + 1); if (r) return r; } // a heredoc a shell (or ssh, ...) runs
    }
    const r = step(c.words, dir, depth);
    if (r?.reason) return r.reason;
    if (r?.dir) dirs.set(c.scope, r.dir);
  }
  return null;
}

const isMain = Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  let input;
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
  const command = input?.tool_input?.command ?? "";
  let reason;
  try { reason = verdict(command, input?.cwd || process.cwd()); }
  catch (e) { reason = PUSH.test(command) ? `could not check the push (${e.message})` : null; }
  if (reason) {
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          `프로젝트 규칙: 보호 브랜치(${[...PROTECTED].join("·")})로는 직접 push할 수 없습니다 — ${reason}. ` +
          "이 워크스페이스는 PR 방식만 허용합니다: feat/<이름> 브랜치로 push(사용자 승인) → gh pr create(프로파일이 있는 레포는 /harness-james:pr-verify 게이트) → 사용자 승인 후 gh pr merge.",
      },
    }));
  }
}
