import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "decision-check.mjs");
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, DECISION_CHECK_EXTRA_WRITE_ROOT: tmpdir() } });
const runIn = (cwd, env, ...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", cwd, env: { ...process.env, DECISION_CHECK_EXTRA_WRITE_ROOT: "", CLAUDE_PROJECT_DIR: "", ...env } });
const runStrict = (...args) => runIn(dirname(BIN), {}, ...args);

function feature(files) {
  const dir = mkdtempSync(join(tmpdir(), "decision-log-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

const LEDGER = "# 결정 기록\n\n## 지금 유효한 결정\n\n## 기록\n\n- D2 둘째\n  - 대체: D1\n  - 반영: plan.md, contracts/api.md\n- D1 첫째\n";

test("인자가 없거나 기록 파일이 없으면 2", () => {
  assert.equal(run().status, 2);
  const r = run(feature({ "plan.md": "x" }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /결정 기록이 없다/);
  assert.equal(run(feature({ "decisions.md": LEDGER }), "--nope").status, 2);
});

test("WARN만 있으면 0, FAIL이 있으면 1", () => {
  const warn = run(feature({ "decisions.md": LEDGER, "plan.md": "**반영한 결정**: ~D1\n", "contracts/api.md": "(D2)\n" }));
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /WARN  header {9}plan\.md  D1까지 반영, 최신 D2 \(1건 뒤\)/);
  assert.match(warn.stdout, /WARN  table/);
  assert.doesNotMatch(warn.stdout, /반영 위치로 적은 파일이 없다/);
  const failed = run(feature({ "decisions.md": LEDGER, "plan.md": "**반영한 결정**: ~D7\n" }));
  assert.equal(failed.status, 1);
  assert.match(failed.stdout, /결과: FAIL 1/);
});

test("--sync-table이 표를 쓰고, --current가 유효한 결정만 보인다", () => {
  const dir = feature({ "decisions.md": LEDGER });
  assert.equal(run(dir, "--sync-table").status, 0);
  assert.match(readFileSync(join(dir, "decisions.md"), "utf8"), /\| D2 \| 둘째 \| plan\.md, contracts\/api\.md \|/);
  assert.match(run(dir, "--sync-table").stdout, /이미 기록과 같다/);
  const current = run(dir, "--current");
  assert.match(current.stdout, /^D2 {2}둘째 {2}\[plan\.md, contracts\/api\.md\]\n유효한 결정 1건 · 최신 D2 · 다음 번호 D3\n$/);
});

test("--sync-table은 프로젝트 폴더 밖의 기록을 고치지 않는다", () => {
  const dir = feature({ "decisions.md": LEDGER });
  const r = runStrict(dir, "--sync-table");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /프로젝트 폴더\(.*\) 밖의 기록은 고치지 않는다/);
  assert.equal(readFileSync(join(dir, "decisions.md"), "utf8"), LEDGER);
  assert.equal(runStrict(dir).status, 0);
});

test("--sync-table은 현재 폴더나 CLAUDE_PROJECT_DIR 안의 기록을 고친다", () => {
  const project = feature({ "specs/001-a/decisions.md": LEDGER });
  const dir = join(project, "specs", "001-a");
  assert.equal(runIn(project, {}, dir, "--sync-table").status, 0);
  assert.match(readFileSync(join(dir, "decisions.md"), "utf8"), /\| D2 \| 둘째 \|/);
  const other = feature({ "decisions.md": LEDGER });
  assert.equal(runIn(dirname(BIN), { CLAUDE_PROJECT_DIR: other }, other, "--sync-table").status, 0);
  assert.equal(runIn(dirname(BIN), { CLAUDE_PROJECT_DIR: project }, other, "--sync-table").status, 2);
});

test("--sync-table은 번호가 겹치면 표를 만들지 않는다", () => {
  const text = `${LEDGER}- D2 또 둘째\n`;
  const dir = feature({ "decisions.md": text });
  const r = run(dir, "--sync-table");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /같은 번호가 두 번 나와 표를 만들지 않는다: D2\(11줄\)/);
  assert.equal(readFileSync(join(dir, "decisions.md"), "utf8"), text);
});

test("--ledger로 다른 이름의 기록 파일을 읽는다", () => {
  const dir = feature({ "log.md": LEDGER, "plan.md": "**반영한 결정**: ~D2\n(D2)\n", "contracts/api.md": "(D2)\n" });
  const r = run(dir, "--ledger", join(dir, "log.md"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PASS  header {9}plan\.md  D2까지 반영\(최신\)/);
});
