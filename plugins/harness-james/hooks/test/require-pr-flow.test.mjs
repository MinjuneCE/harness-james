// node --test hooks/test/ — require-pr-flow.mjs (deny direct pushes to protected branches).
// Branch-dependent cases use a throwaway repo in the OS temp dir; nothing is pushed anywhere.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verdict, pushVerdict, tokenize } from "../require-pr-flow.mjs";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../require-pr-flow.mjs");
const REPO = mkdtempSync(join(tmpdir(), "pr-flow-"));
const g = (...a) => execFileSync("git", ["-C", REPO, ...a], { stdio: "ignore" });
g("init", "-q", "-b", "dev");
g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
g("remote", "add", "origin", "https://example.invalid/repo.git");
const checkout = (b, upstream) => {
  g("checkout", "-q", "-B", b);
  if (upstream) {
    g("update-ref", `refs/remotes/origin/${upstream}`, "HEAD");
    g("branch", "-q", `--set-upstream-to=origin/${upstream}`);
  }
};
test.after(() => rmSync(REPO, { recursive: true, force: true }));

function run(command, cwd = REPO) {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "none";
}
const denies = (cmd, cwd) => assert.equal(run(cmd, cwd), "deny", cmd);
const passes = (cmd, cwd) => assert.equal(run(cmd, cwd), "none", cmd);

test("explicit protected destinations are denied", () => {
  for (const cmd of [
    "git push origin dev",
    "git push origin main",
    "git push -u origin HEAD:stg",
    "git push --force origin prd",
    "git push origin feat/x:refs/heads/production",
    "git push origin +feat/x:master",
    "git push origin refs/heads/develop",
    `git -C ${REPO} push origin main`,
    "git push origin dev 2>&1 | tail -3",
    "GIT_TRACE=1 git push origin dev",
    "env GIT_TRACE=1 git push origin dev",
    "/usr/bin/git push origin dev",
    "git-push origin dev",
  ]) denies(cmd);
});

test("feature-branch pushes and non-push commands are left to the approval hook", () => {
  for (const cmd of [
    "git push origin feat/cancel-text",
    "git push -u origin feat/x",
    "git push --force-with-lease origin fix/y",
    "git push origin dev:feat/x",
    "git push origin v1.2.0",
    "git push origin refs/tags/dev",
    "git push origin feat/x > dev",
    "git status && git log --oneline -3",
    "echo 'git push origin dev'",
    "herdr agent prompt x \"never run git push origin dev\"",
    "gh pr create --base dev --title t --body b",
    "gh pr merge 12 --squash",
  ]) passes(cmd);
});

test("deletes, every-branch pushes and wildcards are denied", () => {
  for (const cmd of [
    "git push origin --delete prd",
    "git push origin :dev",
    "git push -d origin main",
    "git push --all origin",
    "git push --mirror origin",
    "git push --prune origin 'refs/heads/*:refs/heads/*'",
    "git push origin 'refs/heads/*:refs/heads/*'",
  ]) denies(cmd);
  passes("git push origin --delete feat/old");
});

test("bare push follows the current branch and its upstream", () => {
  checkout("dev", "dev");
  denies("git push");
  denies("git push origin");
  denies("git push origin HEAD");
  denies(`cd ${REPO} && git push`, tmpdir());
  checkout("feat/x", "feat/x");
  passes("git push");
  passes("git push origin HEAD");
  checkout("feat/y", "dev");
  denies("git push"); // feature branch tracking a protected upstream
  checkout("feat/z");
  passes("git push -u origin feat/z");
});

test("push.default=matching and configured push refspecs are denied for a bare push", () => {
  checkout("feat/m", "feat/m");
  g("config", "push.default", "matching");
  denies("git push");
  g("config", "--unset", "push.default");
  g("config", "remote.origin.push", "refs/heads/*:refs/heads/*");
  denies("git push");
  g("config", "--unset", "remote.origin.push");
  passes("git push");
});

test("wrapped pushes are read when possible and denied when not", () => {
  denies("bash -c 'git push origin dev'");
  passes("bash -c 'git push origin feat/x'");
  denies("sh -c \"cd /tmp && git push origin main\"");
  denies("eval git push origin stg");
  denies("echo dev | xargs git push origin");
  denies("result=$(git push origin feat/x)");
  denies("git push origin dev # comment");
});

test("GitHub API calls that move a protected branch are denied", () => {
  denies("gh api -X PATCH repos/acme-org/r/git/refs/heads/dev -f sha=abc");
  denies("gh api repos/acme-org/r/git/refs -f ref=refs/heads/main -f sha=abc");
  denies("gh api repos/acme-org/r/merges -f base=dev -f head=feat/x");
  denies("gh api -X POST repos/acme-org/r/branches/stg/rename -f new_name=x");
  passes("gh api repos/acme-org/r/git/refs/heads/dev");
  passes("gh api -X PATCH repos/acme-org/r/git/refs/heads/feat/x -f sha=abc");
  passes("gh api repos/acme-org/r/pulls --jq length");
});

test("unparsable commands that contain a push fail closed; unreadable input is ignored", () => {
  denies("git push origin 'feat/x");
  const r = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "");
});

test("deny reason names the plugin's verify skill", () => {
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "git push origin main" }, cwd: REPO }), encoding: "utf8" });
  const name = JSON.parse(readFileSync(resolve(dirname(HOOK), "../.claude-plugin/plugin.json"), "utf8")).name;
  assert.ok(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason.includes(`/${name}:verify 게이트`));
});

test("pure helpers", () => {
  assert.equal(pushVerdict(["origin", "feat/x"], REPO), null);
  assert.match(pushVerdict(["origin", "main"], REPO), /protected/);
  assert.equal(verdict("ls -la", REPO), null);
  assert.deepEqual(tokenize("a 'b c' && d").map((c) => c.tokens.map((t) => t.value)), [["a", "b c"], ["d"]]);
});
