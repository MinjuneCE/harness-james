// /verify 신호의 feature-map: 프로파일에 feature_map이 있을 때만 돈다. 피처맵 도구는 플러그인에 없어서
// VERIFY_FM_BIN이 가리키는 프로젝트 도구를 부르고, 설정이 없거나 파일이 없으면 경고만 남기고 계속한다.
// 여기서는 test/fake-signal-bin의 가짜 fm-check를 쓴다. 다른 신호 도구는 위치를 주지 않아 error로 둔다.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runOutsideSignals } from "../scripts/signals.mjs";

const FAKE_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "fake-signal-bin");

function setup() {
  const ws = mkdtempSync(join(tmpdir(), "verify-fm-"));
  const repo = join(ws, "repo");
  mkdirSync(join(repo, "src/cart"), { recursive: true });
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com"); git("config", "user.name", "t");
  writeFileSync(join(repo, "src/cart/a.js"), "1\n");
  git("add", "-A"); git("commit", "-q", "-m", "init");
  const fork = git("rev-parse", "HEAD");
  writeFileSync(join(repo, "src/cart/a.js"), "2\n");
  writeFileSync(join(repo, "src/new.js"), "1\n");
  git("add", "-A"); git("commit", "-q", "-m", "change cart");
  const head = git("rev-parse", "HEAD");
  const profile = { repo: { key: "demo", name: "demo", path: "repo" }, structures: [{ id: "d.cart", paths: ["src/cart/**"] }], _path: join(ws, "profile.json") };
  writeFileSync(profile._path, JSON.stringify(profile));
  return { ws, repo, fork, head, profile, cleanup: () => rmSync(ws, { recursive: true, force: true }) };
}

const go = (s, profile, fmBin) => {
  const saved = { signal: process.env.VERIFY_SIGNAL_BIN, fm: process.env.VERIFY_FM_BIN };
  delete process.env.VERIFY_SIGNAL_BIN;
  if (fmBin === undefined) delete process.env.VERIFY_FM_BIN;
  else process.env.VERIFY_FM_BIN = fmBin;
  try {
    const runDir = join(s.ws, "run");
    const warnings = [];
    const out = runOutsideSignals({ ws: s.ws, runDir, profile, profiles: [profile], repo: s.repo, mode: "full", fork: s.fork, head: s.head, runBase: s.fork, branch: "main", mergeRef: null, changedPaths: [], warnings });
    return { out, warnings, summary: readFileSync(join(runDir, "signals/summary.md"), "utf8") };
  } finally {
    for (const [k, v] of [["VERIFY_SIGNAL_BIN", saved.signal], ["VERIFY_FM_BIN", saved.fm]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
};
const withMap = (s) => {
  const profile = { ...s.profile, feature_map: "map" };
  writeFileSync(profile._path, JSON.stringify(profile));
  return profile;
};

test("feature_map 없는 프로파일: feature-map 도구를 목록에 넣지 않는다(기존 도구 목록 그대로)", (t) => {
  const s = setup(); t.after(s.cleanup);
  const { out } = go(s, s.profile, FAKE_BIN);
  assert.deepEqual(out.tools.map((x) => x.tool), ["reach", "ledger", "co-change"]);
});

test("feature_map 있는데 VERIFY_FM_BIN이 없으면: feature-map은 error, 경고를 남기고 실행은 이어진다", (t) => {
  const s = setup(); t.after(s.cleanup);
  const { out, warnings, summary } = go(s, withMap(s));
  const fm = out.tools.find((x) => x.tool === "feature-map");
  assert.equal(fm.status, "error");
  assert.match(fm.note, /도구 위치 설정 안 됨: VERIFY_FM_BIN/);
  assert.ok(warnings.some((w) => /^신호 feature-map 실패 — 이 신호 없이 진행: 도구 위치 설정 안 됨/.test(w)), warnings.join("\n"));
  assert.match(summary, /## feature-map — error/);
});

test("VERIFY_FM_BIN 폴더에 fm-check.mjs가 없으면: 도구 없음 경고", (t) => {
  const s = setup(); t.after(s.cleanup);
  const { out, warnings } = go(s, withMap(s), join(s.ws, "no-bin"));
  const fm = out.tools.find((x) => x.tool === "feature-map");
  assert.equal(fm.status, "error");
  assert.match(fm.note, /도구 없음: no-bin\/fm-check\.mjs/);
  assert.ok(warnings.some((w) => w.startsWith("신호 feature-map 실패")));
});

test("feature_map 있고 도구가 있으면: 낡음·구조 밖 파일이 summary.md에 실린다", (t) => {
  const s = setup(); t.after(s.cleanup);
  const { out, summary } = go(s, withMap(s), FAKE_BIN);
  const fm = out.tools.find((x) => x.tool === "feature-map");
  assert.equal(fm.status, "ok", fm.note);
  assert.deepEqual(fm.by_severity, { WARN: 2 });
  assert.match(summary, /## feature-map — ok, 2건/);
  assert.match(summary, /WARN feature-stale `001-cart`/);
  assert.match(summary, /문서: `map\/001-cart\.md:1`/);
  assert.match(summary, /WARN feature-uncovered `src\/new\.js`/);
});
