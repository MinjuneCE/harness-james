// 프로젝트 이름표, 전환(switch·accept), 고정된 서브(COLLAB_PROJECT), 옛 줄 규칙(설정 legacyProjects)
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { makeBoard, sessionOf, COMMON } from "../lib/board.mjs";
import { computeGaps, forRole } from "../lib/gaps.mjs";
import { loadConfig } from "../lib/config.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/collab.mjs", import.meta.url));
const LEGACY = { commonKinds: ["handover", "resource", "worktree"], ranges: [{ through: "C-261110-99", project: "alpha" }, { through: "C-261119-99", project: "beta" }], ids: { "C-261113-03": "alpha" } };
const ALL_ON = { impl: true, qa: true, scenarios: true, infra: true, pm: true };
const PM_OFF = { ...ALL_ON, pm: false };

function clock(start = "2026-11-20T10:00:00+09:00") {
  let t = new Date(start).getTime();
  return () => new Date((t += 1000));
}

// 가짜 작업 공간: 게시판, projects.json, 프로젝트 설정(.loop/collab/config.json: 역할 켜고 끄기, 옛 줄 규칙)
function ws({ events = [], state, roles = PM_OFF, tickets = {}, legacy = LEGACY } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collab-proj-"));
  const dir = path.join(root, ".loop/collab");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "board.jsonl");
  if (events.length) fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (state !== undefined) fs.writeFileSync(path.join(dir, "projects.json"), typeof state === "string" ? state : JSON.stringify(state));
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ roles, ...(legacy ? { legacyProjects: legacy } : {}) }));
  for (const [id, t] of Object.entries(tickets)) {
    const tdir = path.join(root, ".loop/tickets", id);
    fs.mkdirSync(tdir, { recursive: true });
    fs.writeFileSync(path.join(tdir, "ticket.md"), `\`\`\`yaml\nid: ${id}\nstatus: ${t.status}\nsource: { kind: x, received: 2026-11-18T10:00+09:00 }\nroute: "${t.route ?? "impl: 고친다"}"\n\`\`\`\n\n# ${id}\n`);
    if (t.decisions) fs.writeFileSync(path.join(tdir, "decisions.tsv"), t.decisions.map((r) => r.join("\t")).join("\n") + "\n");
  }
  return { root, file, projects: path.join(dir, "projects.json"), config: loadConfig({ root, env: {} }), env: { COLLAB_GAPS: "0" } };
}
const twoProjects = (over = {}) => ({
  target: "alpha", switchedAt: "2026-11-19T09:00:00+09:00", switchedBy: "qa",
  roles: { impl: "alpha", qa: "alpha", scenarios: "alpha", infra: "alpha", pm: "alpha" },
  projects: { alpha: { title: "가", since: "2026-10-21" }, beta: { title: "나", since: "2026-11-11" } },
  ...over,
});
// 라이브러리로 쓸 때: 작업 공간의 설정을 넘긴다
function lib(w, t, session) {
  return makeBoard({ file: w.file, now: clock(), config: w.config, ...(session ? { session } : {}) });
}
async function cli(w, args, env = {}) {
  const base = (({ PANE_LEAD_ROLE, PANE_LEAD_ROOT, CLAUDE_PROJECT_DIR, COLLAB_PROJECT, COLLAB_BOARD, COLLAB_ROOT, COLLAB_CONFIG, ...rest }) => rest)(process.env);
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args, "--root", w.root], { env: { ...base, ...w.env, ...env } });
    return { code: 0, stdout, ...(stdout.startsWith("{") ? JSON.parse(stdout) : {}) };
  } catch (error) {
    return { code: error.code, ...JSON.parse(error.stdout) };
  }
}
const readState = (w) => JSON.parse(fs.readFileSync(w.projects, "utf8"));
const oldAdd = (id, kind = "note", extra = {}) => ({ op: "add", id, at: `2026-${id.slice(4, 6)}-${id.slice(6, 8)}T10:00:00+09:00`, from: "qa", to: "impl", kind, title: id, status: "open", links: [], ...extra });

test("옛 줄: 설정 legacyProjects가 없으면 project 칸 없는 줄은 모두 common이다", (t) => {
  const w = ws({ legacy: null, events: [oldAdd("C-261021-01"), oldAdd("C-261104-05", "handover"), oldAdd("C-261111-02")] });
  assert.deepEqual(w.config.legacyProjects, {});
  assert.deepEqual(lib(w, t).snapshot().items.map((i) => i.project), [COMMON, COMMON, COMMON]);
});

test("설정 legacyProjects: 맞지 않는 항목은 건너뛰고 ignored에 남긴다", () => {
  const w = ws({ legacy: { ids: { "C-261113-03": "alpha", bad: "alpha", "C-261113-04": "Bad Name" }, commonKinds: "handover", ranges: [{ through: "C-261110-99", project: "alpha" }, { through: 3 }] } });
  assert.deepEqual(w.config.legacyProjects, { ids: { "C-261113-03": "alpha" }, ranges: [{ through: "C-261110-99", project: "alpha" }] });
  assert.deepEqual(w.config.ignored, ["legacyProjects.ids.bad", "legacyProjects.ids.C-261113-04", "legacyProjects.commonKinds", "legacyProjects.ranges.1"]);
});

test("옛 줄: project 칸이 없으면 설정 규칙으로 정한다 — 예외 번호, 공통 종류, 번호 구간 차례", (t) => {
  const w = ws({ events: [oldAdd("C-261021-01"), oldAdd("C-261104-05", "handover"), oldAdd("C-261111-02"), oldAdd("C-261113-03", "doc-change"), oldAdd("C-261125-01")] });
  const items = Object.fromEntries(lib(w, t).snapshot().items.map((i) => [i.id, i.project]));
  assert.deepEqual(items, { "C-261021-01": "alpha", "C-261104-05": COMMON, "C-261111-02": "beta", "C-261113-03": "alpha", "C-261125-01": COMMON });
});

test("add: 보낸 역할이 보고 있는 프로젝트로 들어가고, 인계·자원·worktree는 공통으로 간다", (t) => {
  const w = ws({ state: twoProjects({ target: "beta", roles: { impl: "alpha", qa: "beta", scenarios: "beta", infra: "beta", pm: "beta" } }) });
  const board = lib(w, t);
  assert.equal(board.add({ from: "qa", to: "impl", kind: "impl-request", title: "나 일" }).project, "beta");
  assert.equal(board.add({ from: "impl", to: "qa", kind: "retest-request", title: "가 마지막 일" }).project, "alpha");
  assert.equal(board.add({ from: "impl", to: "all", kind: "worktree", title: "worktree 잡음" }).project, COMMON);
  assert.equal(board.add({ from: "user", to: "impl", kind: "note", title: "역할 없는 쪽은 목표" }).project, "beta");
});

test("list: 받는 역할의 프로젝트 + 공통만 보이고, 넘어가지 않은 역할에는 pending이 붙는다", (t) => {
  const w = ws({ state: twoProjects({ target: "beta", switchedBy: "qa", switchedAt: "2026-11-20T09:30:00+09:00", roles: { impl: "alpha", qa: "beta", scenarios: "beta", infra: "beta", pm: "beta" } }) });
  const board = lib(w, t);
  const a = board.add({ from: "impl", to: "impl,qa", kind: "note", title: "가 항목" });
  const b = board.add({ from: "qa", to: "impl,qa", kind: "note", title: "나 항목" });
  const c = board.add({ from: "qa", to: "all", kind: "resource", title: "공통 항목" });
  const forImpl = board.list({ open: true, to: "impl" });
  assert.deepEqual(forImpl.items.map((i) => i.id), [a.id, c.id]);
  assert.equal(forImpl.project, "alpha");
  assert.match(forImpl.pending, /목표 프로젝트: beta \(qa가 09:30에 바꿈\).*collab switch --accept --by impl/);
  const forQa = board.list({ open: true, to: "qa" });
  assert.deepEqual(forQa.items.map((i) => i.id), [b.id, c.id]);
  assert.equal(forQa.pending, undefined);
  // 역할이 없으면 목표 프로젝트
  assert.deepEqual(board.list({}).items.map((i) => i.id), [b.id, c.id]);
  // --to 없이 --from만 있으면 보낸 역할의 프로젝트
  assert.deepEqual(board.list({ from: "impl" }).items.map((i) => i.id), [a.id]);
});

test("switch: 목표와 요청한 역할·꺼진 역할만 바뀌고, 공통에 전환 기록이 남는다", (t) => {
  const w = ws({ state: twoProjects() });
  const board = lib(w, t);
  const doing = board.add({ from: "impl", to: "qa", kind: "retest-request", title: "가 진행 중" });
  board.update(doing.id, { status: "doing", by: "qa" });
  const out = board.switchTo("beta", { by: "qa" });
  assert.equal(out.from, "alpha");
  assert.equal(out.to, "beta");
  assert.deepEqual(out.leftDoing, [doing.id]);
  assert.deepEqual(out.notify, ["impl", "scenarios", "infra"]);
  assert.deepEqual(out.open, { beta: 0, common: 0 });
  const s = readState(w);
  assert.equal(s.target, "beta");
  assert.equal(s.switchedBy, "qa");
  assert.deepEqual(s.roles, { impl: "alpha", qa: "beta", scenarios: "alpha", infra: "alpha", pm: "beta" });
  const rec = board.show(out.record);
  assert.equal(rec.project, COMMON);
  assert.equal(rec.status, "done");
  assert.equal(rec.title, "[게시판 전환] alpha → beta");
  const info = board.info();
  assert.deepEqual(info.behind, ["impl", "scenarios", "infra"]);
  assert.deepEqual(info.open, { alpha: 1, beta: 0, common: 0 });
});

test("switch: 등록 안 된 이름·이미 목표·나쁜 이름은 거절, --new는 등록한다", (t) => {
  const w = ws({ state: twoProjects() });
  const board = lib(w, t);
  assert.throws(() => board.switchTo("gamma", { by: "qa" }), /등록되지 않은 프로젝트 gamma/);
  assert.throws(() => board.switchTo("alpha", { by: "qa" }), /목표가 이미 alpha/);
  assert.throws(() => board.switchTo("common", { by: "qa" }), /bad project name/);
  assert.throws(() => board.switchTo("Gamma X", { by: "qa" }), /bad project name/);
  assert.throws(() => board.switchTo("beta", { by: "all" }), /unknown by/);
  assert.throws(() => board.switchTo("beta", {}), /--by is required/);
  assert.throws(() => board.switchTo("gamma", { by: "qa", isNew: true }), /--new needs --title/);
  assert.throws(() => board.switchTo("beta", { by: "qa", isNew: true, title: "나" }), /이미 있어요/);
  assert.equal(readState(w).target, "alpha");
  const out = board.switchTo("gamma", { by: "user", isNew: true, title: "새 개발 건" });
  assert.equal(out.created, true);
  const s = readState(w);
  assert.equal(s.projects.gamma.title, "새 개발 건");
  // user가 바꾸면 켜진 역할은 아무도 바로 넘어가지 않는다
  assert.deepEqual(s.roles, { impl: "alpha", qa: "alpha", scenarios: "alpha", infra: "alpha", pm: "gamma" });
  assert.deepEqual(out.notify, ["impl", "qa", "scenarios", "infra"]);
});

test("switch --new: projects.json이 없을 때 처음 만들면 모든 역할이 그 프로젝트다", (t) => {
  const w = ws({});
  const board = lib(w, t);
  assert.throws(() => board.switchTo("alpha", { by: "qa" }), /projects\.json이 없어요/);
  const out = board.switchTo("alpha", { by: "qa", isNew: true, title: "가" });
  assert.equal(out.from, null);
  assert.equal(out.record, undefined);
  assert.deepEqual(readState(w).roles, { impl: "alpha", qa: "alpha", scenarios: "alpha", infra: "alpha", pm: "alpha" });
});

test("accept: 그 역할만 목표로 넘어가고, 그 사이 목표가 두 번 바뀌면 마지막 목표로 간다", (t) => {
  const w = ws({ state: twoProjects({ projects: { alpha: { title: "가" }, beta: { title: "나" }, gamma: { title: "다" } } }) });
  const board = lib(w, t);
  board.switchTo("beta", { by: "qa" });
  board.switchTo("gamma", { by: "qa" });
  assert.equal(board.view("impl").project, "alpha");
  const out = board.accept({ by: "impl" });
  assert.deepEqual({ role: out.role, from: out.from, to: out.to }, { role: "impl", from: "alpha", to: "gamma" });
  assert.equal(board.view("impl").project, "gamma");
  assert.equal(board.view("impl").pending, undefined);
  assert.equal(board.view("infra").project, "alpha");
  assert.equal(board.accept({ by: "impl" }).already, true);
  assert.throws(() => board.accept({ by: "user" }), /unknown by/);
  assert.throws(() => board.accept({}), /--by is required/);
});

test("update --project로 옮긴 항목은 새 프로젝트 목록에 나오고, update·show는 다른 프로젝트 항목에도 된다", (t) => {
  const w = ws({ state: twoProjects() });
  const board = lib(w, t);
  const item = board.add({ from: "qa", to: "impl", kind: "note", title: "잘못 들어감" });
  assert.equal(item.project, "alpha");
  assert.throws(() => board.update(item.id, { project: "nope" }), /등록되지 않은 프로젝트 nope/);
  const moved = board.update(item.id, { project: "beta", by: "qa" });
  assert.equal(moved.project, "beta");
  assert.deepEqual(board.list({ to: "impl" }).items.map((i) => i.id), []);
  // 보고 있는 프로젝트가 아니어도 번호로 고치고 본다
  assert.equal(board.update(item.id, { status: "done", by: "impl" }).status, "done");
  const shown = board.show(item.id);
  assert.equal(shown.project, "beta");
  assert.equal(shown.history.at(-2).project, "beta");
  board.update(item.id, { project: COMMON });
  assert.equal(board.show(item.id).project, COMMON);
});

test("projects.json이 없거나 깨졌으면 지금처럼 동작한다 — 전부 보이고, 새 항목은 공통, 경고가 붙는다", (t) => {
  for (const state of [undefined, "{ not json", JSON.stringify({ target: "ghost", projects: {} })]) {
    const w = ws({ events: [oldAdd("C-261021-01"), oldAdd("C-261111-02")], state });
    const board = lib(w, t);
    const listed = board.list({ open: true, to: "impl" });
    assert.equal(listed.count, 2);
    assert.equal(listed.project, undefined);
    assert.match(listed.warn, state === undefined ? /없어요/ : /깨짐/);
    assert.equal(board.add({ from: "qa", to: "impl", kind: "note", title: "x" }).project, COMMON);
    assert.throws(() => board.update("C-261021-01", { project: "alpha" }), /프로젝트를 옮길 수 없어요/);
    assert.equal(board.info().target, null);
    if (state !== undefined) {
      assert.throws(() => board.switchTo("alpha", { by: "qa", isNew: true, title: "가" }), /깨짐/);
      assert.equal(fs.readFileSync(w.projects, "utf8"), state);
    }
  }
});

test("서브: switch·accept는 거절된다", (t) => {
  const w = ws({ state: twoProjects() });
  const board = lib(w, t, { sub: true, pin: null });
  assert.throws(() => board.switchTo("beta", { by: "qa" }), /서브는 게시판을 전환하지 않아요/);
  assert.throws(() => board.accept({ by: "qa" }), /서브는 게시판을 전환하지 않아요/);
  assert.equal(readState(w).target, "alpha");
  // 고정되지 않은 서브는 메인처럼 역할의 프로젝트를 쓴다
  assert.equal(board.add({ from: "qa", to: "impl", kind: "note", title: "x" }).project, "alpha");
});

test("고정된 서브: add·list가 역할의 프로젝트와 상관없이 고정된 프로젝트 + 공통으로 간다", (t) => {
  const w = ws({ state: twoProjects() });
  const main = lib(w, t);
  const a = main.add({ from: "qa", to: "impl", kind: "note", title: "가 항목" });
  const sub = makeBoard({ file: w.file, now: clock("2026-11-20T11:00:00+09:00"), config: w.config, session: { sub: true, pin: "beta" } });
  const b = sub.add({ from: "qa", to: "impl", kind: "impl-request", title: "나 간단한 일" });
  const c = sub.add({ from: "qa", to: "all", kind: "resource", title: "자원 잡음" });
  assert.equal(b.project, "beta");
  assert.equal(c.project, COMMON);
  const listed = sub.list({ open: true, to: "impl" });
  assert.deepEqual(listed.items.map((i) => i.id), [b.id, c.id]);
  assert.equal(listed.project, "beta");
  assert.equal(listed.pinned, true);
  assert.equal(listed.pending, undefined);
  // 메인 쪽 목록에는 가 항목과 공통만
  assert.deepEqual(main.list({ open: true, to: "impl" }).items.map((i) => i.id), [a.id, c.id]);
  assert.throws(() => makeBoard({ file: w.file, config: w.config, session: { sub: true, pin: "nope" } }).list({}), /등록되지 않은 프로젝트 nope/);
});

test("sessionOf: 서브가 아닌 세션에 COLLAB_PROJECT가 있으면 거절하고 project-sub를 안내한다", () => {
  assert.deepEqual(sessionOf({}), { sub: false, pin: null });
  assert.deepEqual(sessionOf({ PANE_LEAD_ROLE: "sub" }), { sub: true, pin: null });
  assert.deepEqual(sessionOf({ PANE_LEAD_ROLE: "sub", COLLAB_PROJECT: " beta " }), { sub: true, pin: "beta" });
  for (const env of [{ COLLAB_PROJECT: "beta" }, { PANE_LEAD_ROLE: "main", COLLAB_PROJECT: "beta" }]) {
    assert.throws(() => sessionOf(env), (e) => /project-sub 서브에서만/.test(e.message) && /project-sub 스킬/.test(e.next));
  }
});

test("CLI: switch → 안 넘어간 역할의 add·list는 원래 프로젝트 + pending, accept 뒤에는 목표 프로젝트", async () => {
  const w = ws({ state: twoProjects() });
  const sw = await cli(w, ["switch", "beta", "--by", "qa"]);
  assert.equal(sw.code, 0);
  assert.deepEqual([sw.from, sw.to], ["alpha", "beta"]);
  const implAdd = await cli(w, ["add", "--from", "impl", "--to", "qa", "--kind", "retest-request", "--title", "가 마지막 재시험"]);
  assert.equal(implAdd.item.project, "alpha");
  assert.match(implAdd.pending, /collab switch --accept --by impl/);
  const qaAdd = await cli(w, ["add", "--from", "qa", "--to", "impl", "--kind", "impl-request", "--title", "나 구현 요청"]);
  assert.equal(qaAdd.item.project, "beta");
  assert.equal(qaAdd.pending, undefined);
  const before = await cli(w, ["list", "--open", "--to", "impl"]);
  assert.equal(before.project, "alpha");
  assert.deepEqual(before.items.map((i) => i.id), []);
  assert.match(before.pending, /목표 프로젝트: beta/);
  const proj = await cli(w, ["project"]);
  assert.deepEqual(proj.behind, ["impl", "scenarios", "infra"]);
  assert.deepEqual(proj.open, { alpha: 1, beta: 1, common: 0 });
  const acc = await cli(w, ["switch", "--accept", "--by", "impl"]);
  assert.deepEqual([acc.role, acc.from, acc.to], ["impl", "alpha", "beta"]);
  const after = await cli(w, ["list", "--open", "--to", "impl"]);
  assert.equal(after.project, "beta");
  assert.deepEqual(after.items.map((i) => i.id), [qaAdd.item.id]);
  assert.equal(after.pending, undefined);
  // 옮기기와 잘못된 쓰임
  const moved = await cli(w, ["update", implAdd.item.id, "--project", "beta", "--by", "impl"]);
  assert.equal(moved.item.project, "beta");
  assert.equal((await cli(w, ["switch", "--accept", "beta", "--by", "impl"])).code, 2);
  assert.equal((await cli(w, ["switch", "gamma", "--by", "qa"])).code, 1);
  assert.equal((await cli(w, ["list", "--project", "alpha"])).code, 2);
  assert.equal((await cli(w, ["add", "--from", "qa", "--to", "impl", "--kind", "note", "--title", "x", "--project", "alpha"])).code, 2);
});

test("CLI: 서브 env에서 switch 거절, 고정된 서브는 그 프로젝트로 고정, 메인 env의 COLLAB_PROJECT는 모든 명령 거절", async () => {
  const w = ws({ state: twoProjects() });
  const sub = { PANE_LEAD_ROLE: "sub" };
  const denied = await cli(w, ["switch", "beta", "--by", "qa"], sub);
  assert.equal(denied.code, 1);
  assert.match(denied.error, /서브는 게시판을 전환하지 않아요/);
  assert.equal((await cli(w, ["switch", "--accept", "--by", "qa"], sub)).code, 1);
  assert.equal(readState(w).target, "alpha");
  const pinned = { PANE_LEAD_ROLE: "sub", COLLAB_PROJECT: "beta" };
  const added = await cli(w, ["add", "--from", "qa", "--to", "impl", "--kind", "note", "--title", "나 서브 메모"], pinned);
  assert.equal(added.item.project, "beta");
  const listed = await cli(w, ["list", "--open", "--to", "impl"], pinned);
  assert.deepEqual([listed.project, listed.pinned, listed.count], ["beta", true, 1]);
  const gaps = await cli(w, ["gaps", "--to", "impl"], pinned);
  assert.deepEqual([gaps.project, gaps.pinned], ["beta", true]);
  const md = await cli(w, ["gaps", "--to", "impl", "--format", "md"], pinned);
  assert.match(md.stdout, /^프로젝트: beta \(이 서브에 고정\)\n\n### 쌓임/);
  assert.equal((await cli(w, ["list", "--open", "--to", "impl"])).count, 0);
  for (const env of [{ COLLAB_PROJECT: "beta" }, { PANE_LEAD_ROLE: "main", COLLAB_PROJECT: "beta" }]) {
    for (const args of [["list", "--open"], ["add", "--from", "qa", "--to", "impl", "--kind", "note", "--title", "x"], ["gaps", "--to", "qa"], ["project"]]) {
      const r = await cli(w, args, env);
      assert.equal(r.code, 1);
      assert.match(r.next, /project-sub 스킬/);
    }
  }
  const unknown = await cli(w, ["list", "--open"], { PANE_LEAD_ROLE: "sub", COLLAB_PROJECT: "nope" });
  assert.equal(unknown.code, 1);
  assert.match(unknown.error, /등록되지 않은 프로젝트 nope/);
});

test("gaps: 다른 프로젝트의 갱신 없는 항목은 안 나오고, 티켓은 인용한 항목의 프로젝트를 따른다", () => {
  const at = "2026-11-18T10:00:00+09:00";
  const item = (id, project, extra = {}) => ({ op: "add", id, at, from: "qa", to: "impl", kind: "note", title: id, status: "open", links: [], project, ...extra });
  const w = ws({
    state: twoProjects({ target: "beta" }),
    events: [
      item("C-261118-01", "alpha"),
      item("C-261118-02", "beta"),
      item("C-261118-03", COMMON),
      item("C-261118-04", "alpha", { kind: "defect", links: ["T-261118-01"] }),
      item("C-261118-05", "beta", { kind: "defect", links: ["T-261118-02"] }),
    ],
    tickets: {
      "T-261118-01": { status: "fixed", decisions: [["2026-11-18T11:00+09:00", "fix", "고침"]] },
      "T-261118-02": { status: "fixed", decisions: [["2026-11-18T11:00+09:00", "fix", "고침"]] },
      "T-261118-03": { status: "fixed", decisions: [["2026-11-18T11:00+09:00", "fix", "고침"]] },
    },
  });
  const ids = (scope) => {
    const r = computeGaps({ root: w.root, now: new Date("2026-11-20T12:00:00+09:00"), config: w.config, scope });
    const g = forRole(r, "all").gaps;
    return { g2: g.filter((x) => x.rule === "G2").map((x) => x.ids[0]), g1: g.filter((x) => x.rule === "G1").map((x) => x.ids[1]), g6: g.filter((x) => x.rule === "G6").map((x) => x.ids[0]), tickets: r.tickets.map((x) => x.id), items: r.items.map((x) => x.id) };
  };
  const all = ids(null);
  assert.deepEqual(all.g2, ["C-261118-01", "C-261118-02", "C-261118-03", "C-261118-04", "C-261118-05"]);
  assert.deepEqual(all.g6, ["T-261118-01", "T-261118-02", "T-261118-03"]);
  const beta = ids("beta");
  assert.deepEqual(beta.g2, ["C-261118-02", "C-261118-03", "C-261118-05"]);
  assert.deepEqual(beta.g1, ["T-261118-02"]);
  // 인용한 항목이 다른 프로젝트에만 있는 티켓(01)은 빠지고, 아무 항목도 인용하지 않은 티켓(03)은 남는다
  assert.deepEqual(beta.g6, ["T-261118-02", "T-261118-03"]);
  assert.deepEqual(beta.tickets, ["T-261118-02", "T-261118-03"]);
  assert.deepEqual(beta.items, ["C-261118-02", "C-261118-03", "C-261118-05"]);
});
