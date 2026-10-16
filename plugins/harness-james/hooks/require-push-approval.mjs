#!/usr/bin/env node
// PreToolUse(Bash) hook: every git push / gh pr merge needs the user's explicit approval (no auto push).
// It asks for every form on its own, the plain ones included (a plugin cannot ship permissions.ask rules),
// e.g. `git push`, `gh pr merge 12`, `git -C <dir> push`, `bash -c "git push"`, `/usr/bin/git push`.
// Only what the shell would run is checked (lib/shell-commands.mjs), so heredoc data, echo/grep arguments and
// commit messages that merely mention a push do not ask. If that reader is missing or fails, the whole text is checked.
import { readFileSync } from "node:fs";

const ARG = String.raw`(?:"[^"]*"|'[^']*'|\S+)`;
const GIT_OPT = String.raw`(?:(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+${ARG}|-{1,2}[\w-]+(?:=${ARG})?)`;
const PUSH = new RegExp(
  String.raw`(?<![\w.-])git(?:\s+${GIT_OPT})*\s+push\b|(?<![\w.-])git-push(?![\w.-])|\bgh\s+pr\s+merge\b`,
);

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // unreadable input: nothing to check
}
const command = String(input?.tool_input?.command ?? "");

let hit;
try {
  const { mentions } = await import("./lib/shell-commands.mjs");
  hit = mentions(command, PUSH);
} catch {
  hit = PUSH.test(command);
}

if (hit) {
  // A hook "ask" is only documented to prompt in manual/acceptEdits/plan/auto, so refuse elsewhere.
  const refuse = ["bypassPermissions", "dontAsk"].includes(input.permission_mode);
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: refuse ? "deny" : "ask",
      permissionDecisionReason: "프로젝트 규칙: push/merge는 사용자 승인 필수 (auto push 금지)",
    },
  }));
}
