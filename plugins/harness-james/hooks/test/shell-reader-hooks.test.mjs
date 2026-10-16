// node --test hooks/test/ — require-pr-flow.mjs and require-verify-before-pr.mjs with the shared shell reader:
// data that mentions a push / PR creation is not read as a command; real ones still are.
// Throwaway repos in the OS temp dir; nothing is pushed or created. Inputs go to the hooks as JSON on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { scan, mentions } from "../lib/shell-commands.mjs";

const HOOKS = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "shell-reader-")));
const REPO = join(TMP, "repo");
mkdirSync(REPO);
const g = (...a) => execFileSync("git", ["-C", REPO, ...a], { stdio: "ignore" });
g("init", "-q", "-b", "dev");
g("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
g("remote", "add", "origin", "https://example.invalid/repo.git");
// a workspace root whose profile lists REPO, for the /verify gate
mkdirSync(join(TMP, "docs/evaluation/profiles"), { recursive: true });
writeFileSync(join(TMP, "docs/evaluation/profiles/r.json"), JSON.stringify({ repo: { name: "r", path: "repo", github: "o/r", aliases: ["r"] } }));
test.after(() => rmSync(TMP, { recursive: true, force: true }));

function run(hook, command, cwd = REPO) {
  const r = spawnSync(process.execPath, [join(HOOKS, hook)], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: TMP, VERIFY_EVAL_DIR: "" },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : "none";
}
const flow = (cmd, cwd) => run("require-pr-flow.mjs", cmd, cwd);
const gate = (cmd, cwd) => run("require-verify-before-pr.mjs", cmd, cwd);

test("pr-flow: data that mentions a protected push is not denied", () => {
  for (const cmd of [
    "cat > notes.md <<'EOF'\ngit push origin main\nEOF",
    "cat > notes.md <<'EOF'\ndon't git push to dev\nEOF",
    "git commit -m \"$(cat <<'EOF'\nnever git push origin main directly\nEOF\n)\"",
    'echo "$(date) git push origin feat/x"',
    "gh pr create --base dev --title t --body \"$(cat <<'EOF'\nthen git push origin dev is blocked\nEOF\n)\"",
    "python3 - <<'EOF'\nprint('git push origin main')\nEOF",
    "tee -a log.md <<EOF\ngit push origin stg\nEOF",
  ]) assert.equal(flow(cmd), "none", cmd);
});

test("pr-flow: protected pushes in groups, heredocs to a shell and code are denied", () => {
  for (const cmd of [
    "(git push origin main)",
    "{ git push origin main; }",
    "if true; then git push origin dev; fi",
    "bash <<'EOF'\ngit push origin main\nEOF",
    "ssh host <<'EOF'\ngit push origin main\nEOF",
    "cat <<'EOF' | bash\ngit push origin main\nEOF",
    "cat > x.sh <<'EOF'\ngit push origin main\nEOF\nbash x.sh",
    "x=$(git push origin feat/x)",
    "git commit -m \"$(git push origin feat/x)\"",
  ]) assert.equal(flow(cmd), "deny", cmd);
});

test("pr-flow: interpreter code with a process API denies only when it names a protected branch", () => {
  const approval = (cmd) => run("require-push-approval.mjs", cmd);
  for (const cmd of [
    "python3 - <<'EOF'\nimport subprocess\nsubprocess.run('git push origin main', shell=True)\nEOF",
    "python3 -c \"import os; os.system('git push origin dev')\"",
    "node -e \"require('child_process').execSync('git push -u origin HEAD:refs/heads/stg')\"",
    "perl -e 'system(\"git push origin production\")'",
  ]) {
    assert.equal(flow(cmd), "deny", cmd);
    assert.equal(approval(cmd), "ask", cmd);
  }
  for (const cmd of [
    "python3 - <<'EOF'\nimport subprocess\nsubprocess.run('git push origin feat/x', shell=True)\nEOF",
    "python3 -c \"import os; os.system('git push')\"",
    "node -e \"require('child_process').execSync('git push origin fix/main-menu')\"",
    "ruby -e '`git push origin feat/dev-tools`'",
  ]) {
    assert.equal(flow(cmd), "none", cmd); // left to the approval hook
    assert.equal(approval(cmd), "ask", cmd);
  }
});

test("pr-flow: cd is tracked per subshell and into heredocs a shell runs", () => {
  g("checkout", "-q", "-B", "dev");
  assert.equal(flow(`cd ${REPO} && bash <<'EOF'\ngit push\nEOF`, TMP), "deny"); // bare push on dev, read in REPO
  assert.equal(flow(`(cd ${REPO} && git push)`, TMP), "deny");
  assert.equal(flow(`(cd ${REPO}); git push`, TMP), "none"); // the cd stayed in the subshell; TMP is not a repo
});

test("verify gate: mentions of gh pr create do not ask; real ones still do", () => {
  for (const cmd of [
    'git commit -m "next: gh pr create --base dev"',
    'grep -rn "gh pr create" .',
    "cat > notes.md <<'EOF'\ngh pr create --base dev\nEOF",
    'echo "run gh pr create later"',
  ]) assert.equal(gate(cmd), "none", cmd);
  for (const cmd of [
    "gh pr create --base dev --title t --body b",
    'bash -c "gh pr create --base dev --title t --body b"',
    "cd . && gh pr create --fill",
    "gh api repos/o/r/pulls -f title=t -f head=x -f base=dev",
  ]) assert.equal(gate(cmd), "ask", cmd);
});

test("reader: parse errors throw; fallbacks are named", () => {
  assert.throws(() => scan("echo 'x"));
  assert.throws(() => scan("cat <<EOF\nno end"));
  assert.throws(() => scan("a )"));
  assert.match(scan("cat > x.sh <<'EOF'\nx\nEOF\nbash x.sh").fallback, /script file/);
  assert.match(scan("echo x | sh").fallback, /pipes data/);
  assert.match(scan("$cmd arg").fallback, /computed/);
  assert.equal(scan("cat <<'EOF' | grep x\nbody\nEOF").fallback, null);
  const { commands } = scan("A=1 sudo -u me git -C d push origin x 2>&1 | tail -3");
  assert.deepEqual(commands.map((c) => c.info.name), ["git", "tail"]);
  assert.deepEqual(commands[0].words.map((w) => w.value), ["A=1", "sudo", "-u", "me", "git", "-C", "d", "push", "origin", "x"]);
  assert.equal(mentions("echo \"$(echo hi)\"", /hi/), false);
  assert.equal(mentions("echo \"$(printf hi | sh)\"", /hi/), true); // fallback inside the substitution
});

test("reader: a few hundred KB stays fast", () => {
  const big = `cat > f <<'EOF'\n${"git push origin main 'x' \"y\" $(z)\n".repeat(8000)}EOF\necho done`;
  const t = performance.now();
  assert.equal(mentions(big, /(?<![\w.-])git\s+push\b/), false);
  assert.ok(performance.now() - t < 500, `${performance.now() - t} ms`);
});
