#!/usr/bin/env node
// PreToolUse(Bash) hook: a session on a non-default Claude profile (CLAUDE_CONFIG_DIR set, e.g. a second account in
// ~/.claude-alt) must hand that profile to every herdr pane it creates. herdr starts new panes with its server's
// environment, not the caller's, so a sub started there would run on the default account.
// Checked: `herdr pane split`, `tab create`, `workspace create` (the commands that make a pane; `agent start` uses the
// pane's env). Missing `--env CLAUDE_CONFIG_DIR=…` → deny with the flag to add. Any explicit CLAUDE_CONFIG_DIR value
// passes, so a deliberate cross-account pane still works. Remote herdr targets (--machine/--remote) are left alone.
// Only what the shell would run is checked (lib/shell-commands.mjs); if that reader is missing or fails, the whole text is.
import { readFileSync } from "node:fs";

const dir = process.env.CLAUDE_CONFIG_DIR;
if (!dir) process.exit(0); // default profile: herdr's own env already matches

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}
const command = String(input?.tool_input?.command ?? "");
if (!command.includes("herdr")) process.exit(0);

const CREATES = new Set(["pane split", "tab create", "workspace create"]);
const REMOTE = new Set(["--machine", "--remote"]);
const hasEnv = (vals) =>
  vals.some((v, i) => v.startsWith("--env=CLAUDE_CONFIG_DIR=") || (v === "--env" && String(vals[i + 1] ?? "").startsWith("CLAUDE_CONFIG_DIR=")));

// Pane-making herdr calls in one simple command's arguments (after `herdr`) that lack the profile env.
function missingIn(vals) {
  let i = 0;
  while (String(vals[i] ?? "").startsWith("-")) {
    if (REMOTE.has(vals[i])) return [];
    i += vals[i] === "--session" ? 2 : 1;
  }
  const sub = `${vals[i]} ${vals[i + 1]}`;
  return CREATES.has(sub) && !hasEnv(vals) ? [sub] : [];
}

const WHOLE = /(?<![\w.-])herdr\b[^\n;&|]*?\b(pane\s+split|tab\s+create|workspace\s+create)\b/g;
function wholeText(src) {
  if (src.includes("CLAUDE_CONFIG_DIR=") || /--(machine|remote)\b/.test(src)) return [];
  return [...src.matchAll(WHOLE)].map((m) => m[1].replace(/\s+/, " "));
}

let scan;
try {
  ({ scan } = await import("./lib/shell-commands.mjs"));
} catch {}

function missing(src, depth = 0) {
  if (!scan || depth > 8) return wholeText(src);
  let r;
  try {
    r = scan(src);
  } catch {
    return wholeText(src);
  }
  if (r.fallback) return wholeText(src);
  const out = [];
  for (const c of r.commands) {
    const args = c.words.slice((c.info?.head ?? 0) + 1);
    if (c.info?.name === "herdr") out.push(...missingIn(args.map((w) => w.value)));
    // `bash -c '<code>'`: the reader keeps the code as a plain argument, so read it again.
    else if (c.info?.kind === "shell") for (const w of args) if (w.value.includes("herdr")) out.push(...missing(w.value, depth + 1));
  }
  for (const f of r.frags) if (f.kind === "subst" || f.kind === "shell") out.push(...missing(f.text, depth + 1));
  return out;
}

const subs = [...new Set(missing(command))];
if (subs.length) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        `이 세션은 CLAUDE_CONFIG_DIR=${dir} 계정으로 돌고 있어요. herdr ${subs.join(", ")}로 만드는 새 pane은 이 환경을 물려받지 않아서, ` +
        `그대로면 서브가 기본 계정으로 떠요. 같은 명령에 --env CLAUDE_CONFIG_DIR=${dir} 를 붙여 다시 실행하세요.`,
    },
  }));
}
