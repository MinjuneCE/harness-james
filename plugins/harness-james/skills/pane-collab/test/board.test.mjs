import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeBoard, localIso } from "../lib/board.mjs";
import { loadConfig, merge } from "../lib/config.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/collab.mjs", import.meta.url));
// The session env may point at a real workspace (pane-lead main, hook env, collab overrides). Tests only see temp folders.
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COLLAB_|PANE_LEAD_|CLAUDE_PROJECT_DIR$)/.test(k)));

// <tmp>/.loop/collab/board.jsonl; the workspace root is two levels up.
function tmpBoard() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-"));
  return path.join(dir, ".loop", "collab", "board.jsonl");
}
const rootOf = (file) => path.dirname(path.dirname(path.dirname(file)));
function writeConfig(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(file), "config.json"), typeof config === "string" ? config : JSON.stringify(config));
}
const withConfig = (raw) => ({ ...merge(raw), file: "config.json", exists: true });

function clock(start = "2026-10-20T15:00:00+09:00") {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

async function cli(file, ...args) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], { env: { ...CLEAN, COLLAB_ROOT: rootOf(file), COLLAB_BOARD: file } });
    return { code: 0, ...JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, ...JSON.parse(error.stdout) };
  }
}

test("add gives day-scoped sequential ids and an open status", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const a = board.add({ from: "impl", to: "qa", kind: "retest-request", title: "api 3f2a1b0 재시험 부탁", links: ["T-261020-01"] });
  const b = board.add({ from: "scenarios", to: "qa", kind: "run-request", title: "R02 실행 부탁" });
  assert.equal(a.id, `C-${localIso(new Date("2026-10-20T15:00:01+09:00")).slice(2, 10).replaceAll("-", "")}-01`);
  assert.equal(b.id, a.id.replace(/01$/, "02"));
  assert.equal(a.status, "open");
  assert.deepEqual(a.links, ["T-261020-01"]);
});

test("add rejects unknown role, kind, status and empty title", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const base = { from: "impl", to: "qa", kind: "note", title: "x" };
  assert.throws(() => board.add({ ...base, from: "impl-main-2" }), /unknown from/);
  assert.throws(() => board.add({ ...base, to: "qa,nobody" }), /unknown to nobody/);
  assert.throws(() => board.add({ ...base, kind: "chat" }), /unknown kind/);
  assert.throws(() => board.add({ ...base, status: "closed" }), /unknown status/);
  assert.throws(() => board.add({ ...base, title: "  " }), /title is required/);
});

test("update appends, changes status, merges links and keeps history", () => {
  const file = tmpBoard();
  const board = makeBoard({ file, now: clock() });
  const { id } = board.add({ from: "qa", to: "impl", kind: "impl-request", title: "빈 목록 제출 막기", links: ["T-261020-01"] });
  board.update(id, { status: "doing", by: "impl" });
  const item = board.update(id, { status: "done", note: "api 9c1d2e0", links: ["T-261020-01", ".research/out/impl-fix.md"], by: "impl" });
  assert.equal(item.status, "done");
  assert.deepEqual(item.links, ["T-261020-01", ".research/out/impl-fix.md"]);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 3);
  const shown = board.show(id);
  assert.deepEqual(shown.history.map((h) => h.status), ["open", "doing", "done"]);
  assert.equal(shown.history[2].note, "api 9c1d2e0");
});

test("update refuses unknown id, bad status and empty change", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const { id } = board.add({ from: "impl", to: "all", kind: "resource", title: "DB 붙잡음" });
  assert.throws(() => board.update("C-000000-99", { status: "done" }), /no item/);
  assert.throws(() => board.update(id, { status: "finished" }), /unknown status/);
  assert.throws(() => board.update(id, {}), /nothing to update/);
});

test("list --open hides done and cancelled; --to includes items sent to all", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const a = board.add({ from: "scenarios", to: "qa", kind: "run-request", title: "R01" });
  const b = board.add({ from: "impl", to: "all", kind: "resource", title: "DB 붙잡음" });
  const c = board.add({ from: "qa", to: "impl", kind: "impl-request", title: "권한 자동 부여" });
  const d = board.add({ from: "qa", to: "scenarios", kind: "run-result", title: "R00" });
  board.update(a.id, { status: "blocked", note: "권한 없음" });
  board.update(c.id, { status: "cancelled" });
  board.update(d.id, { status: "done" });
  assert.deepEqual(board.list({ open: true }).items.map((i) => i.id), [a.id, b.id]);
  assert.deepEqual(board.list({ open: true, to: "qa" }).items.map((i) => i.id), [a.id, b.id]);
  assert.deepEqual(board.list({ to: "impl" }).items.map((i) => i.id), [b.id, c.id]);
  assert.deepEqual(board.list({ from: "qa", kind: "run-result" }).items.map((i) => i.id), [d.id]);
  assert.equal(board.list().count, 4);
  assert.equal(board.list().items[0].history, undefined);
});

test("broken lines are skipped and counted, not fatal", () => {
  const file = tmpBoard();
  const board = makeBoard({ file, now: clock() });
  board.add({ from: "impl", to: "qa", kind: "note", title: "ok" });
  fs.appendFileSync(file, "{not json\n" + JSON.stringify({ op: "weird" }) + "\n");
  const result = board.list();
  assert.equal(result.count, 1);
  assert.equal(result.skipped, 2);
});

test("missing board file lists empty", () => {
  const board = makeBoard({ file: tmpBoard() });
  const listed = board.list({ open: true });
  assert.equal(listed.count, 0);
  assert.deepEqual(listed.items, []);
  // projects.json도 없으면 거르지 않고 경고만 붙는다
  assert.match(listed.warn, /projects\.json이 없어요/);
  assert.equal(listed.project, undefined);
});

test("CLI prints one JSON line and uses exit codes 0/1/2", async () => {
  const file = tmpBoard();
  const added = await cli(file, "add", "--from", "impl", "--to", "qa", "--kind", "worktree", "--title", "api-auth worktree 수정 시작", "--link", "api-auth", "--link", "T-261020-02");
  assert.equal(added.code, 0);
  assert.equal(added.ok, true);
  assert.equal(added.config, undefined, "no config field without a project config");
  assert.deepEqual(added.item.links, ["api-auth", "T-261020-02"]);
  const updated = await cli(file, "update", added.item.id, "--status", "done", "--note", "HEAD 1a2b3c4", "--by", "impl");
  assert.equal(updated.item.status, "done");
  const open = await cli(file, "list", "--open");
  assert.equal(open.count, 0);
  const shown = await cli(file, "show", added.item.id);
  assert.equal(shown.item.history.length, 2);
  const missing = await cli(file, "show", "C-000000-01");
  assert.equal(missing.code, 1);
  assert.match(missing.next, /collab list/);
  const usage = await cli(file, "add", "--from", "impl");
  assert.equal(usage.code, 2);
  assert.ok(usage.usage);
  const badOption = await cli(file, "list", "--open", "--role", "impl");
  assert.equal(badOption.code, 2);
  assert.match(badOption.error, /unknown option --role/);
  const unknown = await cli(file, "frobnicate");
  assert.equal(unknown.code, 2);
  const help = await cli(file, "--help");
  assert.equal(help.code, 0);
  assert.ok(help.kinds.includes("run-request"));
});

test("parallel adds from separate processes get distinct ids", async () => {
  const file = tmpBoard();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, n) => cli(file, "add", "--from", "impl", "--to", "qa", "--kind", "note", "--title", `동시 ${n}`)),
  );
  const ids = results.map((r) => r.item.id);
  assert.equal(new Set(ids).size, 8);
  assert.equal(fs.readFileSync(file, "utf8").trim().split("\n").length, 8);
});

test("infra is a role and infra-request a kind; list --to infra sees its items and items sent to all", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const a = board.add({ from: "qa", to: "infra", kind: "infra-request", title: "개발 서버 로그 확인 부탁" });
  const b = board.add({ from: "infra", to: "impl", kind: "impl-request", title: "허용 호스트 추가 부탁" });
  const c = board.add({ from: "infra", to: "all", kind: "handover", title: "[인계] infra 메인 infra-main-1", status: "done" });
  assert.deepEqual(board.list({ open: true, to: "infra" }).items.map((i) => i.id), [a.id]);
  assert.deepEqual(board.list({ from: "infra" }).items.map((i) => i.id), [b.id, c.id]);
  assert.throws(() => board.add({ from: "infra-main-1", to: "impl", kind: "note", title: "x" }), /unknown from/);
});

test("pm is a role at peer level; list --to pm sees its items and items sent to all", () => {
  const board = makeBoard({ file: tmpBoard(), now: clock() });
  const a = board.add({ from: "impl", to: "pm", kind: "note", title: "PR 머지 순서 확인 부탁" });
  const b = board.add({ from: "pm", to: "qa", kind: "note", title: "통합 시험을 먼저" });
  const c = board.add({ from: "pm", to: "all", kind: "handover", title: "[인계] pm 메인 pm-main-1", status: "done" });
  assert.deepEqual(board.list({ open: true, to: "pm" }).items.map((i) => i.id), [a.id]);
  assert.deepEqual(board.list({ from: "pm" }).items.map((i) => i.id), [b.id, c.id]);
  assert.throws(() => board.add({ from: "pm-main-1", to: "impl", kind: "note", title: "x" }), /unknown from/);
});

test("a role switched off in the project config cannot be a receiver; it can still send and update; collab roles shows the switch", async () => {
  const board = makeBoard({ file: tmpBoard(), now: clock(), config: withConfig({ _설명: "x", roles: { impl: true, pm: false } }) });
  assert.throws(() => board.add({ from: "impl", to: "qa,pm", kind: "note", title: "x" }), /pm 역할은 꺼져 있어요/);
  const a = board.add({ from: "pm", to: "all", kind: "note", title: "[알림] PM이 잠시 쉬어요", status: "done" });
  assert.equal(board.update(a.id, { note: "확인", by: "pm" }).id, a.id);
  const file = tmpBoard();
  writeConfig(file, { _설명: "x", roles: { impl: true, pm: false } });
  const refused = await cli(file, "add", "--from", "impl", "--to", "pm", "--kind", "note", "--title", "x");
  assert.equal(refused.code, 2);
  assert.match(refused.next, /--to에서 pm을 빼요/);
  const roles = await cli(file, "roles");
  assert.equal(roles.code, 0);
  assert.equal(roles.roles.pm, false);
  assert.equal(roles.roles.infra, true); // 설정에 없는 역할은 기본값(켜짐)
  assert.deepEqual(roles.off, ["pm"]);
  assert.equal(roles.lineages.scn, "scenarios");
  assert.equal(roles.configFile, path.join(path.dirname(file), "config.json"));
});

test("an old role name in roleAliases reads as the new name: old board lines, --from/--to/--by input, list filters", async () => {
  const file = tmpBoard();
  writeConfig(file, { roleAliases: { tester: "qa" } });
  const old = [
    { op: "add", id: "C-261101-01", at: "2026-11-01T10:00:00+09:00", from: "tester", to: "impl", kind: "defect", title: "옛 줄", status: "open", links: [] },
    { op: "add", id: "C-261101-02", at: "2026-11-01T10:01:00+09:00", from: "impl", to: "tester,scenarios", kind: "retest-request", title: "옛 줄 2", status: "open", links: [] },
    { op: "update", id: "C-261101-02", at: "2026-11-01T11:00:00+09:00", by: "tester", status: "doing" },
  ];
  fs.writeFileSync(file, old.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const board = makeBoard({ file, now: clock("2026-11-09T10:00:00+09:00"), config: loadConfig({ root: rootOf(file), env: {} }) });
  assert.equal(board.show("C-261101-01").from, "qa");
  assert.equal(board.show("C-261101-02").to, "qa,scenarios");
  assert.equal(board.show("C-261101-02").history.at(-1).by, "qa");
  assert.deepEqual(board.list({ to: "qa" }).items.map((i) => i.id), ["C-261101-02"]);
  assert.deepEqual(board.list({ to: "tester" }).items.map((i) => i.id), ["C-261101-02"]);
  assert.deepEqual(board.list({ from: "tester" }).items.map((i) => i.id), ["C-261101-01"]);
  const added = await cli(file, "add", "--from", "tester", "--to", "impl", "--kind", "note", "--title", "옛 이름으로 보냄");
  assert.equal(added.code, 0);
  assert.equal(added.item.from, "qa");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).from, "qa"); // 새 줄은 새 이름으로 남는다
  const updated = await cli(file, "update", "C-261101-01", "--status", "done", "--by", "tester");
  assert.equal(updated.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).by, "qa");
  assert.equal(fs.readFileSync(file, "utf8").split("\n")[0], JSON.stringify(old[0])); // 옛 줄은 그대로
  // 별칭이 없는 기본값에서는 옛 이름이 그냥 모르는 역할이다
  const plain = makeBoard({ file: tmpBoard(), now: clock() });
  assert.throws(() => plain.add({ from: "tester", to: "impl", kind: "note", title: "x" }), /unknown from tester/);
});

test("a project config can add a role: it becomes a sender and receiver and shows in help and roles", async () => {
  const file = tmpBoard();
  writeConfig(file, { roles: { design: true }, lineages: { dsg: "design" } });
  const added = await cli(file, "add", "--from", "impl", "--to", "design", "--kind", "note", "--title", "화면 시안 확인 부탁");
  assert.equal(added.code, 0);
  assert.equal(added.item.to, "design");
  const roles = await cli(file, "roles");
  assert.equal(roles.roles.design, true);
  assert.equal(roles.lineages.dsg, "design");
  const help = await cli(file, "--help");
  assert.ok(help.roles.includes("design"));
  // 설정이 없는 작업 공간에서는 모르는 역할이다
  const other = await cli(tmpBoard(), "add", "--from", "impl", "--to", "design", "--kind", "note", "--title", "x");
  assert.equal(other.code, 2);
  assert.match(other.error, /unknown to design/);
});

test("a broken project config falls back to the defaults and says so; wrong-typed entries are skipped and listed", async () => {
  const file = tmpBoard();
  writeConfig(file, "{not json");
  const added = await cli(file, "add", "--from", "impl", "--to", "pm", "--kind", "note", "--title", "x");
  assert.equal(added.code, 0);
  assert.equal(added.config.using, "defaults");
  assert.ok(added.config.error);
  const roles = await cli(file, "roles");
  assert.equal(roles.configFile, null);
  assert.deepEqual(roles.off, []);
  assert.ok(roles.config.error);
  const typed = tmpBoard();
  writeConfig(typed, { roles: { pm: "off", qa: false, user: false }, lineages: { "Bad Name": "impl", web: "nobody" }, gaps: { staleHours: "x" } });
  const r = await cli(typed, "roles");
  assert.equal(r.code, 0);
  assert.deepEqual(r.off, ["qa"]);
  assert.equal(r.roles.pm, true);
  assert.deepEqual(r.config.ignored.sort(), ["gaps.staleHours", "lineages.Bad Name", "lineages.web", "roles.pm", "roles.user"].sort());
  assert.equal(r.config.error, undefined);
});

test("the CLI finds the workspace: --root, COLLAB_ROOT, PANE_LEAD_ROOT, then the nearest .loop/collab above cwd", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collab-root-"));
  fs.mkdirSync(path.join(root, ".loop/collab"), { recursive: true });
  fs.writeFileSync(path.join(root, ".loop/collab/config.json"), JSON.stringify({ roles: { infra: false } }));
  const nested = path.join(root, "services/api/src");
  fs.mkdirSync(nested, { recursive: true });
  const call = async (env, cwd, ...args) => JSON.parse((await run(process.execPath, [CLI, ...args], { env: { ...CLEAN, ...env }, cwd })).stdout);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "collab-elsewhere-"));
  assert.deepEqual((await call({}, nested, "roles")).off, ["infra"], "walks up from a nested folder");
  assert.deepEqual((await call({}, other, "roles")).off, [], "no .loop/collab above: cwd, defaults");
  assert.deepEqual((await call({ PANE_LEAD_ROOT: root }, other, "roles")).off, ["infra"]);
  assert.deepEqual((await call({ COLLAB_ROOT: other, PANE_LEAD_ROOT: root }, other, "roles")).off, []);
  assert.deepEqual((await call({ COLLAB_ROOT: other }, other, "roles", "--root", root)).off, ["infra"]);
  const added = await call({}, nested, "add", "--from", "impl", "--to", "qa", "--kind", "note", "--title", "중첩 폴더에서 씀");
  assert.equal(added.ok, true);
  assert.equal(fs.readFileSync(path.join(root, ".loop/collab/board.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.equal(fs.existsSync(path.join(nested, ".loop")), false);
});
