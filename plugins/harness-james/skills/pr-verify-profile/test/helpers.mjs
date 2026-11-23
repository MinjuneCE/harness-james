// 시험 픽스처: 임시 워크스페이스(scoring.json, 등록 프로필 폴더)와 임시 git 레포. 실제 레포·프로필은 건드리지 않는다.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = join(SKILL_DIR, "bin/pvp.mjs");
export const SCORING = {
  version: "1.0.0",
  structure_impact: { magnitude_steps: [{ max_lines: 0, factor: 0 }, { max_lines: 10, factor: 0.6 }, { max_lines: 50, factor: 0.8 }, { max_lines: null, factor: 1.0 }], finding_bonus: 20, finding_bonus_min_severity: "medium" },
  defaults: { structure_review_threshold: 60 },
  season: { review_threshold_factor: 0.8, freeze_criticality: 85 },
};

export function write(root, files) {
  for (const [p, text] of Object.entries(files)) {
    const abs = join(root, p);
    if (text === null) { rmSync(abs, { force: true }); continue; }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof text === "string" ? text : JSON.stringify(text, null, 2) + "\n");
  }
}

export function gitRepo(dir, { origin = "https://github.com/acme/app.git" } = {}) {
  mkdirSync(dir, { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  git("init", "-q", "-b", "dev");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  if (origin) git("remote", "add", "origin", origin);
  const commit = (msg, files) => { write(dir, files); git("add", "-A"); git("commit", "-q", "--allow-empty", "-m", msg); return git("rev-parse", "HEAD"); };
  // origin/<브랜치>를 지금 HEAD(또는 준 커밋)에 둔다(원격 없이 원격 추적 ref만 만든다)
  const setOrigin = (branch, sha = git("rev-parse", "HEAD")) => git("update-ref", `refs/remotes/origin/${branch}`, sha);
  return { dir, git, commit, setOrigin };
}

export const baseProfile = (over = {}) => ({
  version: "1.0.0",
  repo: { key: "app", name: "app", path: "app", github: "acme/app", default_base: "origin/dev", aliases: ["app"], traits: ["server"] },
  dimensions: { SEC: { weight: 0.5 }, REL: { weight: 0.5 } },
  comment_syntax: { "**/*.js": ["//"], "**/*.yml": ["#"] },
  structures: [
    { id: "a.pay", name: "결제", criticality: 95, review_threshold: 50, paths: ["src/pay/**"], why: "돈 경로", specs: [] },
    { id: "a.cfg", name: "설정", criticality: 70, paths: ["config/*.yml", "package.json"], why: "설정", specs: [] },
  ],
  coverage_ignore: ["src/test/**", "README.md"],
  dependents: [],
  tools: [],
  secret_scan: { criterion: "SEC-05", exclude: [] },
  ...over,
});

export const BASE_FILES = { "src/pay/charge.js": "// pay\nexport const a = 1;\n", "config/app.yml": "a: 1\n", "package.json": "{}\n", "src/test/charge.test.js": "t\n", "README.md": "# app\n" };

// ws/docs/evaluation/{config,profiles}, ws/.verify/, ws/app(git 레포: origin/dev = HEAD). scoring = false면 산식 파일을 두지 않는다(pr-verify 기본값을 읽음)
export function workspace({ files = BASE_FILES, profiles = {}, scoring = true } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "pvp-test-"));
  write(ws, { ".verify/.keep": "", ...(scoring ? { "docs/evaluation/config/scoring.json": SCORING } : {}) });
  mkdirSync(join(ws, "docs/evaluation/profiles"), { recursive: true });
  for (const [name, p] of Object.entries(profiles)) write(ws, { [`docs/evaluation/profiles/${name}`]: p });
  const app = gitRepo(join(ws, "app"));
  const root = app.commit("init", files);
  app.setOrigin("dev");
  const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ws, encoding: "utf8", env: { ...process.env, VERIFY_WORKSPACE: ws, VERIFY_EVAL_DIR: "" } });
  const cleanup = () => rmSync(ws, { recursive: true, force: true });
  return { ws, app, root, run, cleanup };
}
