// 명령 시험: inventory·skeleton·check·table, 종료 코드, 쓰기 위치 제한, 읽기 전용 git, env 파일은 예시만 읽기.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertReadOnly, gitIn, isExampleEnv, isRealEnv, localLag } from "../lib/git.mjs";
import { baseCandidates, detectKind, inventory } from "../lib/inventory.mjs";
import { ignoreClass } from "../lib/ignore.mjs";
import { skeleton } from "../lib/skeleton.mjs";
import { confirmTable } from "../lib/table.mjs";
import { assertDraftPath } from "../lib/workspace.mjs";
import { BASE_FILES, BIN, SCORING, baseProfile, workspace, write } from "./helpers.mjs";

const SERVER_FILES = {
  ...BASE_FILES,
  "build.gradle": "plugins {}\n",
  "gradlew": "#!/bin/sh\n",
  "src/main/java/App.java": "class App {}\n",
  "src/test/java/AppTest.java": "class AppTest {}\n",
  ".gitignore": "build\n",
  ".editorconfig": "root = true\n",
  ".env.example": "# 설명\nAPI_KEY=changeme\nexport BASE_URL=https://example.com\n",
  ".env.dev": "REAL_VALUE=do-not-read\n",
};
const registered = (over = {}) => ({ ...baseProfile(), repo: { key: "svc", name: "svc", path: "svc", github: "acme/svc", default_base: "origin/dev", aliases: ["svc"], traits: ["server"] }, criteria: { "SEC-04": { season_review_threshold: 20 } }, comment_syntax: { "**/*.java": ["//", "/*", "*", "*/"] }, ignore_line_patterns: { "**/*.java": ["^\\s*import\\s"] }, ...over });

test("git: 읽기 전용 명령만 통과", () => {
  for (const ok of [["ls-tree", "-r", "HEAD"], ["show", "HEAD:a.js"], ["config", "--get", "remote.origin.url"], ["remote", "get-url", "origin"], ["show", "HEAD:.env.example"]]) assert.doesNotThrow(() => assertReadOnly(ok));
  for (const bad of [["fetch"], ["switch", "dev"], ["checkout", "dev"], ["commit", "-m", "x"], ["push"], ["config", "user.name", "x"], ["remote", "add", "o", "u"], ["update-ref", "a", "b"], ["reset", "--hard"]]) assert.throws(() => assertReadOnly(bad), /읽기 전용|--get|get-url/, bad.join(" "));
});

test("git: 진짜 env 파일 내용은 안 읽고 예시 파일만 읽는다", () => {
  assert.equal(isExampleEnv(".env.example"), true);
  assert.equal(isExampleEnv("infra/prd/app.env.example"), true);
  assert.equal(isExampleEnv(".env.dev"), false);
  assert.equal(isRealEnv(".env"), true);
  assert.equal(isRealEnv("x/.env.prd"), true);
  assert.equal(isRealEnv(".env.example"), false);
  assert.throws(() => assertReadOnly(["show", "HEAD:.env.dev"]), /\.env 파일 내용은 읽지 않는다/);
  const w = workspace({ files: SERVER_FILES });
  try {
    const g = gitIn(w.app.dir);
    assert.deepEqual(g.envKeys(w.root, ".env.example"), ["API_KEY", "BASE_URL"], "키 이름만, 값은 버린다");
    assert.throws(() => g.envKeys(w.root, ".env.dev"), /예시 env 파일만/);
    assert.throws(() => g.run("show", `${w.root}:.env.dev`), /읽지 않는다/);
  } finally { w.cleanup(); }
});

test("git: 로컬 브랜치가 origin보다 뒤처진 정도", () => {
  const w = workspace();
  try {
    const g = gitIn(w.app.dir);
    assert.deepEqual(localLag(g, "dev"), { local: w.root, origin: w.root, behind: 0, ahead: 0 });
    assert.equal(localLag(g, "origin/dev"), null);
    const c2 = w.app.commit("c2", { "src/pay/charge.js": "x\n" });
    w.app.setOrigin("dev");
    w.app.git("update-ref", "refs/heads/dev", w.root);
    assert.deepEqual(localLag(g, "dev"), { local: w.root, origin: c2, behind: 1, ahead: 0 });
  } finally { w.cleanup(); }
});

test("쓰기 위치: .verify 아래와 임시 폴더만", () => {
  const w = workspace();
  try {
    assert.doesNotThrow(() => assertDraftPath(w.ws, join(w.ws, ".verify/profile-drafts/app.json")));
    for (const bad of ["docs/evaluation/profiles/app.json", "app/profile.json", ".claude/skills/x/app.json", ".verify/../docs/evaluation/profiles/app.json"]) assert.throws(() => assertDraftPath(w.ws, join(w.ws, bad)), /초안은/, bad);
  } finally { w.cleanup(); }
});

test("레포 성격 추정", () => {
  assert.deepEqual(detectKind(["build.gradle", "src/main/java/A.java"]).traits, ["server"]);
  assert.deepEqual(detectKind(["Dockerfile", "web/src/App.tsx"]).traits, ["server", "client"]);
  assert.deepEqual(detectKind(["go.mod", "main.go"]).traits, ["server"]);
  assert.deepEqual(detectKind(["src/App.vue", "package.json"]).traits, ["client"]);
  assert.deepEqual(detectKind(["layout/theme.liquid", "sections/a.liquid", "templates/index.json"]).traits, ["client"]);
  assert.deepEqual(detectKind(["index.js"]).traits, []);
  assert.equal(ignoreClass("src/test/java/AppTest.java"), "시험 코드");
  assert.equal(ignoreClass("src/main/java/App.java"), null);
});

test("inventory: 폴더 묶음, 첫 커밋 그대로인 파일, 뺄 파일 후보, 주석 문법, 예시 env 키 이름", () => {
  const w = workspace({ files: SERVER_FILES });
  try {
    w.app.commit("change", { "src/main/java/App.java": "class App { int a; }\n", "src/main/java/New.java": "class New {}\n" });
    w.app.setOrigin("dev");
    const inv = inventory({ g: gitIn(w.app.dir), ref: "origin/dev", profiles: [{ ...registered(), _path: "/p/svc.json" }], repoPath: "app" });
    assert.equal(inv.repo.name, "app");
    assert.equal(inv.repo.github, "acme/app");
    assert.deepEqual(inv.repo.roots.map((r) => r.sha), [w.root]);
    assert.deepEqual(inv.repo.default_base_candidates, ["origin/dev"]);
    assert.deepEqual(inv.kind.traits, ["server"]);
    assert.deepEqual(inv.kind.preset_from, { key: "svc", file: "svc.json" });
    assert.equal(inv.files.total, Object.keys(SERVER_FILES).length + 1);
    assert.equal(inv.files.untouched_since_root, Object.keys(SERVER_FILES).length - 1, "App.java는 바뀌었고 New.java는 첫 커밋 뒤에 생겼다");
    const java = inv.groups.find((x) => x.dir === "src/main/java");
    assert.deepEqual([java.files, java.commits, java.untouched_since_root], [2, 3, 0]);
    const cand = Object.fromEntries(inv.ignore_candidates.map((c) => [c.glob, c.sure]));
    assert.deepEqual(cand, { "src/test/**": true, "gradlew": true, "README.md": true, ".gitignore": true, ".editorconfig": false }, "**/test/**는 src/test/**와 같은 파일만 잡아 빠진다");
    assert.deepEqual(inv.comment_syntax["**/*.java"], ["//", "/*", "*", "*/"]);
    assert.ok(inv.comment_syntax["**/*.gradle"] && inv.comment_syntax["**/.env*"] && !inv.comment_syntax["**/*.liquid"]);
    assert.deepEqual(Object.keys(inv.ignore_line_patterns), ["**/*.java"]);
    assert.deepEqual(inv.env_keys, { ".env.example": ["API_KEY", "BASE_URL"] });
    assert.ok(!JSON.stringify(inv).includes("do-not-read") && !JSON.stringify(inv).includes("changeme"), "env 값은 어디에도 없다");
    assert.deepEqual(inv.committed_env_files, [".env.dev"], "커밋된 진짜 env 파일은 경로만 낸다");
    assert.deepEqual(inv.registered, []);
  } finally { w.cleanup(); }
});

test("skeleton: 채울 수 있는 칸만 채우고 구조·dependents는 비운다", () => {
  const w = workspace({ files: SERVER_FILES });
  try {
    const preset = registered();
    const inv = inventory({ g: gitIn(w.app.dir), ref: "origin/dev", profiles: [{ ...preset, _path: "/p/svc.json" }], repoPath: "app" });
    const d = skeleton({ inv, key: "app", aliases: ["APP", "a"], preset, today: "2026-11-16" });
    assert.deepEqual(d.repo, { key: "app", name: "app", path: "app", github: "acme/app", default_base: "origin/dev", aliases: ["app", "a"], traits: ["server"] });
    assert.deepEqual(d.dimensions, preset.dimensions);
    assert.notEqual(d.dimensions, preset.dimensions, "출발값은 복사본");
    assert.deepEqual(d.criteria, preset.criteria);
    assert.deepEqual(d.structures, []);
    assert.deepEqual(d.dependents, []);
    assert.deepEqual(d.coverage_ignore, ["src/test/**", "gradlew", "README.md", ".gitignore"], "판단이 필요한 후보(.editorconfig)는 안 넣는다");
    assert.equal(d.version, "1.0.0");
    assert.match(d.$comment, /2026-11-16 처음 만듦/);
    for (const k of ["known_debt", "rules", "feature_map"]) assert.equal(d[k], undefined);
  } finally { w.cleanup(); }
});

test("CLI inventory: 읽기만 하고 요약을 낸다", () => {
  const w = workspace({ files: SERVER_FILES });
  try {
    const r = w.run("inventory", "--repo", "app");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /# app @ origin\/dev/);
    assert.match(r.stdout, /성격 추정: server/);
    assert.match(r.stdout, /`\.env\.example`: API_KEY, BASE_URL/);
    assert.ok(!r.stdout.includes("do-not-read"));
    assert.equal(w.app.git("status", "--porcelain"), "", "레포 작업 트리는 그대로");
  } finally { w.cleanup(); }
});

test("default_base 후보: origin/HEAD가 가리키는 원격 기본 브랜치가 먼저, 그다음 main·master·dev·develop", () => {
  const w = workspace({ files: SERVER_FILES });
  try {
    w.app.setOrigin("main");
    w.app.setOrigin("develop");
    const g = gitIn(w.app.dir);
    assert.deepEqual(baseCandidates(g), ["origin/main", "origin/dev", "origin/develop"]);
    w.app.git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    assert.deepEqual(baseCandidates(g), ["origin/develop", "origin/main", "origin/dev"]);
    const r = w.run("inventory", "--repo", "app");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^# app @ origin\/develop /);
  } finally { w.cleanup(); }
});

test("skeleton: 워크스페이스 밖 레포도 repo.path를 상대 경로(../…)로 적는다", () => {
  const w = workspace({ files: SERVER_FILES });
  const inner = join(w.ws, "inner");
  try {
    write(inner, { ".verify/.keep": "" });
    const r = spawnSync(process.execPath, [BIN, "skeleton", "--repo", join(w.ws, "app"), "--key", "app"], { cwd: inner, encoding: "utf8", env: { ...process.env, VERIFY_WORKSPACE: inner, VERIFY_EVAL_DIR: "" } });
    assert.equal(r.status, 0, r.stderr);
    const d = JSON.parse(readFileSync(join(inner, ".verify/profile-drafts/app.json"), "utf8"));
    assert.equal(d.repo.path, "../app");
  } finally { w.cleanup(); }
});

test("원격 추적 브랜치가 없으면 HEAD를 본다", () => {
  const w = workspace({ files: SERVER_FILES });
  try {
    w.app.git("update-ref", "-d", "refs/remotes/origin/dev");
    const r = w.run("inventory", "--repo", "app");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^# app @ HEAD /);
  } finally { w.cleanup(); }
});

test("산식 파일이 평가 폴더에 없으면 pr-verify 기본값으로 표를 만든다", () => {
  const w = workspace({ scoring: false, profiles: { "app.json": baseProfile() } });
  try {
    const r = w.run("table", "--profile", "docs/evaluation/profiles/app.json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /a\.pay/);
  } finally { w.cleanup(); }
});

test("평가 폴더 위치는 VERIFY_EVAL_DIR를 따른다", () => {
  const w = workspace({ scoring: false });
  try {
    write(w.ws, { "qa/eval/profiles/app.json": baseProfile() });
    const r = spawnSync(process.execPath, [BIN, "check", "--profile", "qa/eval/profiles/app.json", "--quiet"], { cwd: join(w.ws, "app"), encoding: "utf8", env: { ...process.env, VERIFY_WORKSPACE: "", VERIFY_EVAL_DIR: "qa/eval" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /qa\/eval\/profiles\/app\.json/);
  } finally { w.cleanup(); }
});

test("CLI skeleton: 초안 폴더에 쓰고, 있는 파일은 안 덮어쓰고, 등록 폴더에는 안 쓴다", () => {
  const w = workspace({ files: SERVER_FILES, profiles: { "svc.json": registered() } });
  try {
    const r = w.run("skeleton", "--repo", "app", "--key", "app");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRAFT=\.verify\/profile-drafts\/app\.json/);
    assert.match(r.stdout, /svc\.json에서 가져온 출발값/);
    const draft = JSON.parse(readFileSync(join(w.ws, ".verify/profile-drafts/app.json"), "utf8"));
    assert.equal(draft.repo.key, "app");
    const again = w.run("skeleton", "--repo", "app", "--key", "app");
    assert.equal(again.status, 2);
    assert.match(again.stderr, /덮어쓰지 않음/);
    assert.equal(w.run("skeleton", "--repo", "app", "--key", "app", "--force").status, 0);
    const bad = w.run("skeleton", "--repo", "app", "--key", "app", "--out", "docs/evaluation/profiles");
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /초안은/);
    assert.equal(existsSync(join(w.ws, "docs/evaluation/profiles/app.json")), false);
    assert.equal(w.run("skeleton", "--repo", "app").status, 2, "--key 없음");
  } finally { w.cleanup(); }
});

test("CLI skeleton: 이미 등록된 레포면 뼈대를 만들지 않는다", () => {
  const w = workspace({ profiles: { "app.json": baseProfile() } });
  try {
    const r = w.run("skeleton", "--repo", "app", "--key", "app2");
    assert.equal(r.status, 2);
    assert.match(r.stderr, /이미 등록된 프로필이 있음: app\.json/);
  } finally { w.cleanup(); }
});

test("CLI check: 고칠 것 없는 등록 프로필은 조용하다(종료 0, 한 줄)", () => {
  const w = workspace({ profiles: { "app.json": baseProfile() } });
  try {
    const r = w.run("check", "--profile", "docs/evaluation/profiles/app.json", "--quiet");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim().split("\n").length, 1);
    assert.match(r.stdout, /check: ok — FAIL 0 · WARN 0 · INFO 0 · .* · 고칠 것 없음/);
  } finally { w.cleanup(); }
});

test("CLI check: 빠진 파일은 잡고(종료 0, WARN), 모양이 틀리면 종료 1", () => {
  const w = workspace({ profiles: { "app.json": baseProfile() } });
  try {
    w.app.commit("add", { "src/mail/send.js": "x\n" });
    w.app.setOrigin("dev");
    const r = w.run("check", "--profile", "docs/evaluation/profiles/app.json", "--base", w.root, "--json", ".verify/out/check.json");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /WARN uncovered-changed — 이 범위에서 바뀐 파일 1개 중 1개/);
    assert.match(r.stdout, /\n {4}src\/mail\/send\.js/);
    assert.match(r.stdout, /check: WARN — FAIL 0 · WARN 2/);
    const json = JSON.parse(readFileSync(join(w.ws, ".verify/out/check.json"), "utf8"));
    assert.equal(json.stats.WARN, 2);
    assert.deepEqual(json.structures.map((s) => s.id), ["a.pay", "a.cfg"]);
    const broken = baseProfile({ dimensions: { SEC: { weight: 0.3 } } });
    broken.repo.traits = [];
    write(w.ws, { ".verify/bad.json": broken, ".verify/notjson.json": "{ nope" });
    const f = w.run("check", "--profile", ".verify/bad.json");
    assert.equal(f.status, 1);
    assert.match(f.stdout, /FAIL shape repo\.traits/);
    assert.match(f.stdout, /FAIL weights — /);
    assert.equal(w.run("check", "--profile", ".verify/notjson.json").status, 1);
    assert.equal(w.run("check", "--profile", ".verify/none.json").status, 3);
    assert.equal(w.run("check").status, 2);
    assert.equal(w.run("nope").status, 2);
    assert.equal(w.run("check", "--profile", "x", "--bogus", "1").status, 2);
  } finally { w.cleanup(); }
});

test("CLI check·table: 등록본을 고친 초안은 자동으로 등록본과 견주고, id 변경을 표 아래에 표시한다", () => {
  const w = workspace({ profiles: { "app.json": baseProfile({ feature_map: "map" }) } });
  try {
    write(w.ws, { "map/001-pay.md": "<!-- fm: id=001-pay; repo=app; spec=s; structures=a.cfg; verified=dev@abc1234; date=2026-11-16; status=clean -->\n# x\n" });
    w.app.commit("add", { "src/mail/send.js": "x\n" });
    w.app.setOrigin("dev");
    const draft = baseProfile({ feature_map: "map", version: "2.0.0" });
    draft.structures[1].id = "a.config";
    draft.structures.push({ id: "a.mail", name: "메일 | 발송", criticality: 85, paths: ["src/mail/**"], why: "고객에게 메일이 나간다", specs: [] });
    write(w.ws, { ".verify/profile-drafts/app.json": draft });
    const c = w.run("check", "--profile", ".verify/profile-drafts/app.json");
    assert.equal(c.status, 0, c.stdout + c.stderr);
    assert.match(c.stdout, /WARN structure-id-change a\.cfg — 기존 구조 id a\.cfg를 a\.config로 이름 바꿈 — 피처맵 메타 1곳/);
    assert.match(c.stdout, /등록본과의 차이: 새 구조 1 · 없앤 구조 0 · id 바꿈 1/);
    assert.match(c.stdout, /등록본 docs\/evaluation\/profiles\/app\.json/);
    const t = w.run("table", "--profile", ".verify/profile-drafts/app.json");
    assert.equal(t.status, 0, t.stderr);
    assert.match(t.stdout, /### app 구조 목록 변경안/);
    assert.match(t.stdout, /\| 결제 `a\.pay` \| 95 \(가장 높음\) \| 문턱 50: 한 줄만 바뀌어도 사람이 봐요/);
    assert.match(t.stdout, /\| 메일 \\\| 발송 `a\.mail` \| 85 \(높음\) \| 문턱 60: 11줄 이상 바뀌면 사람이 봐요.*\| 1 \| 고객에게 메일이 나간다 \| 새로 넣음 \|/);
    assert.match(t.stdout, /⚠ id 바꿈\(전 a\.cfg\)/);
    assert.match(t.stdout, /- ⚠ 기존 구조 id a\.cfg를 a\.config로 이름 바꿈.*map\/001-pay\.md/);
  } finally { w.cleanup(); }
});

test("확인 표: 새 초안은 바뀐 파일 칸(--base)과 빈 구조 표시를 낸다", () => {
  const rows = [
    { id: "a.pay", name: "결제", criticality: 95, review_threshold: 50, why: "돈 경로", files: 3, changed: 2 },
    { id: "a.tpl", name: "템플릿", criticality: 60, review_threshold: null, why: "앱 셸", files: 0, changed: 0 },
  ];
  const md = confirmTable({ profile: baseProfile(), rows, scoring: SCORING });
  assert.match(md, /### app 구조 목록 초안/);
  assert.match(md, /\| 구조 \| 중요도 \| 사람이 직접 보게 되는 변경 \| 파일 수 \| 바뀐 파일 \| 왜 중요한지 \|\n/);
  assert.match(md, /\| 템플릿 `a\.tpl` \| 60 \(낮음\) \| 문턱 60: 51줄 이상 바뀌면 사람이 봐요.*\| 0 ⚠ \| 0 \| 앱 셸 \|/);
  assert.match(md, /파일 수 0인 구조는 지금 트리에서 아무 파일도 못 잡아요/);
});

test("CLI table: 레포를 못 읽으면 0으로 채운 표 대신 종료 3", () => {
  const w = workspace();
  try {
    const p = baseProfile();
    p.repo.path = "nowhere";
    write(w.ws, { ".verify/p.json": p });
    const r = w.run("table", "--profile", ".verify/p.json");
    assert.equal(r.status, 3);
    assert.match(r.stderr, /레포를 열지 못함/);
    assert.equal(r.stdout, "");
    assert.equal(w.run("table", "--profile", ".verify/p.json", "--repo", "app").status, 0);
  } finally { w.cleanup(); }
});

test("CLI check: github을 고친 초안도 key가 같으면 등록본과 견준다", () => {
  const w = workspace({ profiles: { "app.json": baseProfile() } });
  try {
    const d = baseProfile({ version: "1.0.1" });
    d.repo.github = "acme/app-renamed";
    write(w.ws, { ".verify/profile-drafts/app.json": d });
    const r = w.run("check", "--profile", ".verify/profile-drafts/app.json");
    assert.match(r.stdout, /등록본 docs\/evaluation\/profiles\/app\.json/);
    assert.doesNotMatch(r.stdout, /FAIL alias/);
  } finally { w.cleanup(); }
});
