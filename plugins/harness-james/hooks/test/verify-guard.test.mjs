// node --test hooks/test/ — verify-guard.mjs (PreToolUse guard for the verify-* agents, keyed on the hook input's agent_type).
// Nothing here is ever run as a command; the strings only go to the hook as JSON on stdin.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), "../verify-guard.mjs");
const ROOT = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-")));
test.after(() => rmSync(ROOT, { recursive: true, force: true }));

// agent_type: what Claude Code puts in the hook input for a plugin subagent (scoped name). Default: a judge.
const JUDGE = "harness-james:verify-judge";
function run(tool_name, tool_input, agent_type = JUDGE, { root = ROOT, env = {} } = {}) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name, tool_input, cwd: root, ...(agent_type === null ? {} : { agent_type }) }), encoding: "utf8",
    env: { ...process.env, VERIFY_EVAL_DIR: "", CLAUDE_PROJECT_DIR: root, ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  if (!r.stdout.trim()) return { decision: "none", reason: "" };
  const o = JSON.parse(r.stdout).hookSpecificOutput;
  return { decision: o.permissionDecision, reason: o.permissionDecisionReason };
}
const bash = (command, agent_type) => run("Bash", { command }, agent_type);
const BUILD = /빌드·테스트·앱 실행/;

// Must deny as a build / test / app run.
const BUILD_DENY = {
  // The four forms that leaked through the old regex (found by skill-check calibration, 2026-10-16).
  leaked: [
    "/Users/x/svc-app/gradlew test",
    "../svc-app/gradlew test",
    'bash -c "./gradlew test"',
    "sh -c './gradlew test'",
  ],
  paths: [
    "./gradlew test",
    "gradlew test",
    "gradle test",
    "/opt/gradle/bin/gradle build",
    "~/svc-app/gradlew test",
    "../../svc-app/gradlew :app:test",
    '"./gradlew" test',
    "'../svc-app/gradlew' build",
    '"/Users/x/svc-app/gradlew" test',
    "./grad''lew test",
    "\\gradle test",
    "./gradlew\ttest",
  ],
  chained: [
    "cd ../svc-app && ./gradlew test",
    "cd ../svc-app; ./gradlew test",
    "a;./gradlew test",
    "a&&/abs/svc-app/gradlew test",
    "a|gradle test",
    "(cd ../svc-app; ./gradlew test)",
    "{ ./gradlew test; }",
    "true\n../svc-app/gradlew test",
    "for t in a b; do ./gradlew test; done",
    "if true; then ./gradlew test; fi",
  ],
  shellString: [
    'bash -lc "cd ../svc-app && ./gradlew test"',
    "zsh -c 'cd ../svc-app && ./gradlew test'",
    'sh -c "/Users/x/svc-app/gradlew test"',
    "bash -c ./gradlew",
    'eval "./gradlew test"',
    "eval ./gradlew test",
    "env -S './gradlew test'",
    'su me -c "./gradlew test"',
    "bash <<EOF\n./gradlew test\nEOF",
    "sh <<'EOF'\ncd ../svc-app\n./gradlew test\nEOF",
    "echo './gradlew test' | sh",
    "cat <<'EOF' | bash\n./gradlew test\nEOF",
  ],
  wrapped: [
    "env JAVA_HOME=/x ./gradlew test",
    "JAVA_HOME=/x ../svc-app/gradlew test",
    "sudo ./gradlew test",
    "nohup ./gradlew test &",
    "time ./gradlew test",
    "command ./gradlew test",
    "exec ./gradlew test",
    "timeout 600 ./gradlew test",
    "nice -n 5 gradle test",
    "watch ./gradlew test",
    "xargs ./gradlew",
    "echo test | xargs ../svc-app/gradlew",
    "xargs -n 1 -I {} ./gradlew {}",
    "xargs -I{} sh -c './gradlew {}'",
    "find src -maxdepth 0 -exec ../svc-app/gradlew test \\;",
    "find src -maxdepth 0 -execdir sh -c './gradlew test' \\;",
    "sh ../svc-app/gradlew test",
    "bash gradlew test",
  ],
  substitution: [
    "$(./gradlew test)",
    "echo `./gradlew test`",
    'x="$(../svc-app/gradlew test)"',
    "cat <(gradle test)",
    "cat <<EOF\n$(./gradlew test)\nEOF",
  ],
  computed: [
    "G=gradlew; ./$G test",
    'G=/Users/x/svc-app/gradlew; "$G" test',
    "python3 -c \"import subprocess; subprocess.run(['./gradlew','test'])\"",
    "node -e \"require('child_process').execSync('gradle test')\"",
  ],
  // Same line, same old prefix set [\s;&|(] — these leaked the same way.
  otherTools: [
    "mvn test",
    "./mvnw test",
    "/opt/maven/bin/mvn verify",
    'sh -c "mvn test"',
    "docker run x",
    "/usr/local/bin/docker run x",
    'bash -c "docker compose up"',
    "docker-compose up",
    "podman run x",
    "npm test",
    "npm run build",
    "/usr/local/bin/npm test",
    'bash -c "npm run build"',
    "pnpm install",
    "yarn",
    "yarn build",
    "bun test",
    "npx vitest run",
    "java -jar build/libs/app.jar",
    "/usr/bin/java -jar app.jar",
    "java -cp build/classes Main",
  ],
};

// Must pass: the name is only data (a file, a directory, a search pattern, text).
const BUILD_PASS = [
  "cat build.gradle",
  "cat ../svc-app/build.gradle",
  "ls gradle/",
  "ls ../svc-app/gradle/wrapper",
  "grep gradlew docs/sdd/x.md",
  "grep -n 'gradle test' README.md",
  "grep -n './gradlew test' ../svc-app/README.md",
  "rg -n gradlew ../svc-app/src",
  "head -5 ../svc-app/gradlew",
  "wc -l gradlew",
  "sed -n 1,40p build.gradle",
  "find src -name '*.gradle'",
  "which gradle",
  "git log --oneline -- build.gradle",
  "git -C ../svc-app grep -n gradle",
  "git show HEAD:build.gradle",
  "git diff a..b -- gradle/ gradlew",
  "echo 'run ./gradlew test later'",
  "printf 'gradle\\n'",
  "jq '.scripts.test' package.json",
  "cat docker-compose.yml",
  "ls .mvn",
  "java -version",
  "npm ls",
  "npm view vitest version",
  "node .verify/run/x.mjs",
];

test("build: the four leaked forms are denied", () => {
  for (const cmd of BUILD_DENY.leaked) {
    const r = bash(cmd);
    assert.equal(r.decision, "deny", cmd);
    assert.match(r.reason, BUILD, cmd);
  }
});

for (const [group, cmds] of Object.entries(BUILD_DENY).filter(([g]) => g !== "leaked")) {
  test(`build: ${group} forms are denied`, () => {
    for (const cmd of cmds) assert.equal(bash(cmd).decision, "deny", cmd);
  });
}

test("build: every verify agent is guarded, scoped or bare", () => {
  for (const t of ["harness-james:verify-orchestrator", "harness-james:verify-refuter", "harness-james:verify-explorer", "verify-judge", "other-plugin:verify-judge"]) {
    for (const cmd of [...BUILD_DENY.leaked, "mvn test"]) assert.equal(bash(cmd, t).decision, "deny", `${t}: ${cmd}`);
  }
});

// The plugin hook fires on every tool call of every session; it must stay out of everything that is not a verify agent.
test("scope: calls outside the verify agents are not judged", () => {
  for (const t of [null, "", "general-purpose", "Explore", "harness-james:pane-lead", "harness-james:verify-judge-x", "verify-judges", "my-verify-judge"]) {
    for (const cmd of ["./gradlew test", "git push origin feat/y", "rm -rf src", "curl https://example.com"]) {
      assert.equal(bash(cmd, t).decision, "none", `${t}: ${cmd}`);
    }
    assert.equal(run("Write", { file_path: join(ROOT, "src/x.js"), content: "" }, t).decision, "none", `${t}: Write`);
    assert.equal(run("Agent", { description: "d", prompt: "p" }, t).decision, "none", `${t}: Agent`);
  }
});
test("scope: a broken guard.json does not block other sessions, but blocks verify agents", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-badcfg-")));
  try {
    mkdirSync(join(root, "docs/evaluation/config"), { recursive: true });
    writeFileSync(join(root, "docs/evaluation/config/guard.json"), "{ not json");
    const input = (agent_type) => JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root, ...(agent_type ? { agent_type } : {}) });
    const r1 = spawnSync(process.execPath, [HOOK], { input: input(null), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r1.status, 0); assert.equal(r1.stdout.trim(), "");
    const r2 = spawnSync(process.execPath, [HOOK], { input: input(JUDGE), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root } });
    assert.equal(r2.status, 2, r2.stderr);
    assert.equal(JSON.parse(r2.stdout).hookSpecificOutput.permissionDecision, "deny");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Project rules: <eval dir>/config/guard.json adds commands the project wants blocked (e.g. a store/deploy CLI).
test("project rules: guard.json commands are denied except their allow prefixes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-cfg-")));
  try {
    mkdirSync(join(root, "docs/evaluation/config"), { recursive: true });
    writeFileSync(join(root, "docs/evaluation/config/guard.json"), JSON.stringify({
      build_note: "tests call the live staging API",
      commands: [{ name: "storecli", why: "store changes or access", allow: [["version"], ["--help"], ["site", "list"], ["site", "check"]] }],
    }));
    const b = (command) => run("Bash", { command }, JUDGE, { root });
    for (const cmd of ["storecli site push", "storecli site", "storecli service deploy", "/usr/local/bin/storecli site push", 'bash -c "storecli site publish"',
      "x=1; storecli store info", "echo 'storecli site push' | sh", "python3 -c \"import os; os.system('storecli site push')\""]) {
      const r = b(cmd);
      assert.equal(r.decision, "deny", cmd);
      assert.match(r.reason, /store changes or access/, cmd);
    }
    for (const cmd of ["storecli", "storecli version", "storecli --help", "storecli site list", "storecli site check --path x", "grep storecli README.md", "echo 'storecli site push'"]) {
      assert.equal(b(cmd).decision, "none", `${cmd} → ${b(cmd).reason}`);
    }
    assert.match(b("./gradlew test").reason, /tests call the live staging API/);
    // without the file the command is just another command
    assert.equal(bash("storecli site push").decision, "none");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Project blind paths: guard.json "blind" hides notes that name the known defects (review results, gap analysis).
test("project rules: guard.json blind paths are hidden from verify agents; a malformed entry fails closed", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "verify-guard-blindcfg-")));
  try {
    mkdirSync(join(root, "docs/evaluation/config"), { recursive: true });
    mkdirSync(join(root, "notes"), { recursive: true });
    for (const f of ["notes/review.md", "notes/gap-a.md", "notes/other.md"]) writeFileSync(join(root, f), "x\n");
    const cfg = (blind) => writeFileSync(join(root, "docs/evaluation/config/guard.json"), JSON.stringify({ blind }));
    cfg([{ path: "notes/review.md", why: "리뷰 결과" }, { path: "notes", prefix: "gap-" }]);
    const b = (command) => run("Bash", { command }, JUDGE, { root });
    for (const cmd of ["cat notes/review.md", "cat notes/gap-a.md", "grep -rn x notes"]) assert.equal(b(cmd).decision, "deny", cmd);
    assert.match(run("Read", { file_path: join(root, "notes/review.md") }, JUDGE, { root }).reason, /읽기 차단\(리뷰 결과\)/);
    assert.match(run("Read", { file_path: join(root, "notes/gap-a.md") }, JUDGE, { root }).reason, /읽기 차단\(프로젝트가 막은 기록\)/);
    for (const cmd of ["cat notes/other.md", "ls notes"]) assert.equal(b(cmd).decision, "none", cmd);
    // other sessions are not affected
    assert.equal(run("Bash", { command: "cat notes/review.md" }, null, { root }).decision, "none");
    for (const bad of [[{ path: "/abs/x" }], [{ path: "../up" }], [{ path: "notes", prefix: "a/b" }], [{}], "notes"]) {
      cfg(bad);
      const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: root, agent_type: JUDGE }), encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: root, VERIFY_EVAL_DIR: "" } });
      assert.equal(r.status, 2, JSON.stringify(bad));
      assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /blind/, JSON.stringify(bad));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The eval dir can move (VERIFY_EVAL_DIR); allowed writes and blind reads follow it.
test("eval dir: VERIFY_EVAL_DIR moves reports, calibration and guard.json", () => {
  const env = { VERIFY_EVAL_DIR: "qa/eval" };
  const w = (p) => run("Write", { file_path: join(ROOT, p), content: "" }, JUDGE, { env }).decision;
  assert.equal(w("qa/eval/reports/r/x.md"), "none");
  assert.equal(w("docs/evaluation/reports/r/x.md"), "deny");
  assert.equal(run("Read", { file_path: join(ROOT, "qa/eval/calibration/x.json") }, JUDGE, { env }).decision, "deny");
  assert.equal(run("Bash", { command: "cat qa/eval/calibration/x.json" }, JUDGE, { env }).decision, "deny");
  assert.equal(run("Bash", { command: "grep -r foo qa/eval" }, JUDGE, { env }).decision, "deny");
  assert.equal(run("Bash", { command: "echo x > qa/eval/reports/r/x.md" }, JUDGE, { env }).decision, "none");
});

test("build: names used only as data pass", () => {
  for (const cmd of BUILD_PASS) assert.equal(bash(cmd).decision, "none", cmd);
});

// The other rules keep working.
test("rules: repo, GitHub, store, network and in-place edits are denied", () => {
  for (const cmd of [
    "git commit -m x",
    "git push origin feat/x",
    "git -C ../svc-app checkout main",
    "git branch -D x",
    "gh pr merge 12",
    "gh pr create --title t",
    "gh api -X POST repos/o/r/issues",
    "curl https://example.com",
    "sed -i s/a/b/ x.txt",
    "perl -pi -e s/a/b/ x.txt",
    "echo hi > out.txt",
    "rm -rf ../svc-app/build",
  ]) assert.equal(bash(cmd).decision, "deny", cmd);
});

test("rules: blind reads and broad searches are denied", () => {
  for (const cmd of ["cat docs/evaluation/calibration/x.json", "grep -r foo .", "find docs -name x",
    // bundled or later recursive flags (the old \\b after -r let these through)
    "grep -rn foo .", "grep -Rni foo docs", "grep -n -r foo .", "grep --recursive foo docs/evaluation", "grep -i --line-number -r foo ~"]) assert.equal(bash(cmd).decision, "deny", cmd);
  for (const cmd of ["grep -n foo README.md", "grep -rn foo src", "grep -c x docs/sdd/a.md"]) assert.equal(bash(cmd).decision, "none", cmd);
  assert.equal(run("Read", { file_path: join(ROOT, "docs/evaluation/calibration/x.json") }).decision, "deny");
});

test("rules: reads and allowed writes pass", () => {
  for (const cmd of [
    "git diff a..b",
    "git log --oneline -5",
    "git merge-base a b",
    "gh pr view 12",
    "echo hi > .verify/run/x.txt",
    "mkdir -p .verify/run",
  ]) assert.equal(bash(cmd).decision, "none", cmd);
  assert.equal(run("Write", { file_path: join(ROOT, ".verify/run/x.json"), content: "{}" }).decision, "none");
  assert.equal(run("Write", { file_path: join(ROOT, "src/x.js"), content: "" }).decision, "deny");
});

// ---- sc-guard2: the remaining gaps (2026-10-16) ----
// Tables live in verify-guard.cases.mjs: per gap, forms that must be denied and forms that must pass.
import { readFileSync, readdirSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { GAPS, AGENT_CASES } from "./verify-guard.cases.mjs";

for (const [gap, { deny, pass }] of Object.entries(GAPS)) {
  test(`${gap}: denied forms`, () => {
    for (const [cmd, why] of deny) {
      const r = bash(cmd);
      assert.equal(r.decision, "deny", cmd);
      if (why) assert.match(r.reason.split(" 금지: ")[0], why, cmd); // the reason, not the echoed command
    }
  });
  test(`${gap}: passing forms`, () => {
    for (const cmd of pass) assert.equal(bash(cmd).decision, "none", `${cmd} → ${bash(cmd).reason}`);
  });
}

test("agent: only the listed subagent types pass", () => {
  for (const { agent, tool = "Agent", input, expect } of AGENT_CASES) {
    assert.equal(run(tool, input, agent).decision, expect, `${agent} ${JSON.stringify(input)}`);
  }
});

test("agent: unknown tools are denied", () => {
  assert.equal(run("WebSearch", { query: "x" }).decision, "deny");
});

// Plugin agents ignore frontmatter hooks, so the guard comes from the plugin's hooks/hooks.json (written by the bundling step).
// It must cover every tool a verify agent has, block on failure, and the allow lists must match what each body says it spawns.
import { CHILDREN, VERIFY_AGENTS } from "../lib/verify-agents.mjs";
const PLUGIN = resolve(dirname(HOOK), "..");
const AGENTS_DIR = join(PLUGIN, "agents");
const frontmatter = (f) => readFileSync(join(AGENTS_DIR, `${f}.md`), "utf8").split("\n---")[0];
test("agent definitions: no frontmatter hooks, names match, allow list matches the body", () => {
  const files = readdirSync(AGENTS_DIR).filter((f) => /^verify-.*\.md$/.test(f)).map((f) => f.slice(0, -3)).sort();
  assert.deepEqual(files, [...VERIFY_AGENTS].sort());
  for (const f of files) {
    const fm = frontmatter(f), body = readFileSync(join(AGENTS_DIR, `${f}.md`), "utf8").slice(fm.length);
    assert.equal(/^name:\s*(\S+)/m.exec(fm)[1], f);
    assert.ok(!/^hooks:/m.test(fm), `${f}: frontmatter hooks are ignored for plugin agents`);
    const tools = /^tools:\s*(.*)$/m.exec(fm)[1].split(",").map((s) => s.trim());
    assert.equal(tools.includes("Agent"), CHILDREN[f].length > 0, `${f}: Agent tool vs CHILDREN`);
    for (const c of CHILDREN[f]) assert.ok(body.includes(`harness-james:${c}`), `${f}: body never names harness-james:${c}`);
  }
});
test("hooks.json: verify-guard covers every verify agent tool and blocks on failure", (t) => {
  const path = join(PLUGIN, "hooks/hooks.json");
  if (!existsSync(path)) return t.skip("hooks/hooks.json is written by the bundling step");
  const entries = JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse ?? [];
  const runsGuard = (h) => [h.command, ...(h.args ?? [])].join(" ").includes("verify-guard.mjs");
  const entry = entries.find((e) => e.hooks.some(runsGuard));
  assert.ok(entry, "no PreToolUse entry runs verify-guard.mjs");
  assert.equal(entry.hooks.find(runsGuard).onFailure, "block");
  const matcher = new RegExp(`^(?:${entry.matcher})$`);
  for (const f of VERIFY_AGENTS) {
    const tools = /^tools:\s*(.*)$/m.exec(frontmatter(f))[1].split(",").map((s) => s.trim());
    for (const tool of [...tools.filter((x) => x !== "WebFetch"), "Edit", "MultiEdit", "NotebookEdit", "Task"]) assert.ok(matcher.test(tool), `${f}: ${tool} not in matcher`);
  }
});

// Fail closed: a guard that cannot judge denies (exit 2 + deny JSON) instead of letting the call through.
function raw(input, hook = HOOK) {
  return spawnSync(process.execPath, [hook], { input, encoding: "utf8", env: { ...process.env, CLAUDE_PROJECT_DIR: ROOT } });
}
const assertCrashDeny = (r, label) => {
  assert.equal(r.status, 2, `${label}: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "deny", label);
  assert.match(r.stderr, /fail closed/, label);
};
test("crash: unreadable input is denied", () => {
  for (const input of ["", "not json", "[]", "null", "42"]) assertCrashDeny(raw(input), JSON.stringify(input));
});
test("crash: a missing lib module is denied", () => {
  const dir = mkdtempSync(join(tmpdir(), "verify-guard-nolib-"));
  try {
    const hook = join(dir, "verify-guard.mjs");
    copyFileSync(HOOK, hook);
    assertCrashDeny(raw(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: ROOT, agent_type: JUDGE }), hook), "no lib");
    // other sessions never load the lib, so a missing lib does not block them
    const r = raw(JSON.stringify({ tool_name: "Bash", tool_input: { command: "ls" }, cwd: ROOT }), hook);
    assert.equal(r.status, 0, r.stderr);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("crash: a runtime exception is denied", () => {
  // cwd that is not a string makes path.resolve throw inside the checks
  assertCrashDeny(raw(JSON.stringify({ tool_name: "Write", tool_input: { file_path: "x.txt" }, cwd: 123, agent_type: JUDGE })), "runtime");
});
