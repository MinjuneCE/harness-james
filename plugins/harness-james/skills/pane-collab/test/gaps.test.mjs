import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { computeGaps, forRole, toMarkdown, ownerOf, expandIds, loadConfig, backlog } from "../lib/gaps.mjs";
import { localIso } from "../lib/board.mjs";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../bin/collab.mjs", import.meta.url));
const NOW = "2026-10-23T18:00:00+09:00";
// The session env may point at a real workspace (pane-lead main, hook env, collab overrides). Tests only see temp folders.
const CLEAN = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(COLLAB_|PANE_LEAD_|CLAUDE_PROJECT_DIR$)/.test(k)));
const defaults = () => loadConfig({ env: {} });

// 가짜 작업 공간: 게시판 사건 줄, 티켓, pane-lead 등록부, 프로젝트 설정(.loop/collab/config.json)
function workspace({ events = [], tickets = {}, registries = {}, config } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "collab-gaps-"));
  fs.mkdirSync(path.join(root, ".loop/collab"), { recursive: true });
  if (config !== undefined) fs.writeFileSync(path.join(root, ".loop/collab/config.json"), typeof config === "string" ? config : JSON.stringify(config));
  fs.writeFileSync(path.join(root, ".loop/collab/board.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : ""));
  for (const [id, t] of Object.entries(tickets)) {
    const dir = path.join(root, ".loop/tickets", id);
    fs.mkdirSync(dir, { recursive: true });
    if (t.raw !== undefined) fs.writeFileSync(path.join(dir, "ticket.md"), t.raw);
    else fs.writeFileSync(path.join(dir, "ticket.md"), `\`\`\`yaml\nid: ${id}\nstatus: ${t.status}\nsource: { kind: x, received: ${t.received ?? "2026-10-21T10:00+09:00"} }\nroute: "${t.route ?? "impl: 고친다"}"\n\`\`\`\n\n# ${t.title ?? id}\n`);
    if (t.decisions) fs.writeFileSync(path.join(dir, "decisions.tsv"), t.decisions.map((r) => r.join("\t")).join("\n") + "\n");
  }
  for (const [lineage, reg] of Object.entries(registries)) {
    const dir = path.join(root, ".research/pane-lead", lineage);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "registry.json"), JSON.stringify(reg));
  }
  return root;
}

const add = (id, at, extra) => ({ op: "add", id, at, from: "qa", to: "impl", kind: "note", title: id, status: "open", links: [], ...extra });
const upd = (id, at, extra) => ({ op: "update", id, at, by: "impl", ...extra });

// config를 주지 않으면 그 작업 공간의 설정(없으면 기본값)으로 계산한다.
function gapsOf(root, role = "all", { now = NOW, config } = {}) {
  return forRole(computeGaps({ root, now: new Date(now), config: config ?? loadConfig({ root, env: {} }) }), role).gaps;
}

async function cli(root, args, env = {}) {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args, "--root", root], { env: { ...CLEAN, ...env } });
    return { code: 0, stdout, json: stdout.startsWith("{") ? JSON.parse(stdout) : null };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, json: JSON.parse(error.stdout) };
  }
}

test("helpers: expandIds and ownerOf with the derived aliases (roles, lineages, upper case) and project aliases", () => {
  assert.equal(expandIds("T-261023-14·15·16"), "T-261023-14 T-261023-15 T-261023-16");
  assert.equal(expandIds("T-261023-07..09"), "T-261023-07 T-261023-08 T-261023-09");
  const aliases = defaults().ownerAliases;
  assert.equal(ownerOf('"impl(web): 고친다', aliases), "impl");
  assert.equal(ownerOf("scn: R12", aliases), "scenarios");
  assert.equal(ownerOf("QA: 재시험", aliases), "qa");
  assert.equal(ownerOf("qa: 재시험", aliases), "qa");
  assert.equal(ownerOf("시나리오 세션: 기대값", aliases), "?");
  assert.equal(ownerOf("양쪽 묶음: 외부(개발자)", aliases), "?");
  const project = loadConfig({ root: workspace({ config: { ownerAliases: { "시나리오 세션": "scenarios", "harness 메인": "harness" }, roleAliases: { tester: "qa" }, oldLineages: { core: "impl" } } }), env: {} }).ownerAliases;
  assert.equal(ownerOf("시나리오 세션: 기대값", project), "scenarios");
  assert.equal(ownerOf("tester(오픈 뒤): fixture 1개", project), "qa"); // 옛 역할 이름
  assert.equal(ownerOf("core 메모 (x)", project), "impl"); // 옛 계보 이름
  assert.equal(ownerOf("harness 메인: 훅", project), "harness"); // 역할이 아닌 주인도 된다
});

test("G1: open defect whose ticket is fixed; not when the ticket is still triaged", () => {
  const root = workspace({
    events: [
      add("C-261021-01", "2026-10-21T15:00:00+09:00", { kind: "defect", links: ["T-261021-01"] }),
      upd("C-261021-01", "2026-10-21T15:05:00+09:00", { status: "blocked" }),
      add("C-261021-02", "2026-10-21T15:00:00+09:00", { kind: "defect", links: ["T-261021-02"], status: "blocked" }),
    ],
    tickets: { "T-261021-01": { status: "fixed   # 합친 뒤" }, "T-261021-02": { status: "triaged" } },
  });
  const g = gapsOf(root, "impl").filter((x) => x.rule === "G1");
  assert.deepEqual(g.map((x) => x.ids), [["C-261021-01", "T-261021-01"]]);
  assert.equal(gapsOf(root, "qa").length, 0);
  // 여럿에게 보낸 결함은 상태를 바꾼 쪽(impl)에만 나온다
  const multi = workspace({
    events: [
      add("C-261021-30", "2026-10-21T16:28:00+09:00", { kind: "defect", to: "impl,scenarios", links: ["T-261021-06"], status: "blocked" }),
      upd("C-261021-30", "2026-10-21T16:29:00+09:00", { status: "blocked", by: "impl" }),
    ],
    tickets: { "T-261021-06": { status: "closed" } },
  });
  assert.equal(gapsOf(multi, "impl").length, 1);
  assert.equal(gapsOf(multi, "scenarios").length, 0);
});

test("G2: open/doing untouched past staleHours; blocked and fresh items are not stale", () => {
  const root = workspace({
    events: [
      add("C-261022-01", "2026-10-22T10:00:00+09:00"),
      add("C-261022-02", "2026-10-22T10:00:00+09:00", { status: "blocked" }),
      add("C-261023-01", "2026-10-23T10:00:00+09:00", { status: "doing" }),
      add("C-261022-03", "2026-10-22T10:00:00+09:00", { to: "all", kind: "resource", status: "doing" }),
    ],
  });
  const g = gapsOf(root).filter((x) => x.rule === "G2");
  assert.deepEqual(g.map((x) => x.ids[0]), ["C-261022-01", "C-261022-03"]);
  // to=all이면 붙잡은 쪽(from)이 주인
  assert.deepEqual(g.find((x) => x.ids[0] === "C-261022-03").owners, ["qa"]);
  // --now 고정 시각: 같은 장부도 이른 시각이면 정체가 아니다
  assert.equal(gapsOf(root, "all", { now: "2026-10-22T12:00:00+09:00" }).filter((x) => x.rule === "G2").length, 0);
});

test("G3: leftover handed to another role only in text; not when a board item to that role links it", () => {
  const ticket = { status: "fixing", route: "qa: 확인", decisions: [["2026-10-21T14:30+09:00", "5 확인", "dev", "x", "y", "dev 확인 끝 · stg 배포 메모는 impl 몫으로 남음"]] };
  const root = workspace({ tickets: { "T-261020-02": ticket } });
  const g = gapsOf(root, "impl");
  assert.deepEqual(g.map((x) => [x.rule, x.ids[0]]), [["G3", "T-261020-02"]]);
  assert.equal(gapsOf(root, "qa").length, 0);
  const linked = workspace({ tickets: { "T-261020-02": ticket }, events: [add("C-261021-05", "2026-10-21T15:00:00+09:00", { kind: "impl-request", status: "done", links: ["T-261020-02"] })] });
  assert.equal(gapsOf(linked, "impl").length, 0);
});

test("G4: a new main without a handover notice; mains before the board started are ignored", () => {
  const registries = { impl: { mains: [{ name: "impl-main-1", startedAt: "2026-10-20T00:00:00Z" }, { name: "impl-main-2", startedAt: "2026-10-22T00:00:00Z" }], main: { name: "impl-main-3", startedAt: "2026-10-23T00:00:00Z" }, subs: {} } };
  const events = [add("C-261021-01", "2026-10-21T09:00:00+09:00", { kind: "handover", to: "all", from: "impl", status: "done", title: "[인계] impl 메인이 impl-main-1 → impl-main-2로 바뀌어요" })];
  const g = gapsOf(workspace({ events, registries }), "impl");
  assert.deepEqual(g.map((x) => [x.rule, x.ids[0]]), [["G4", "impl-main-3"]]);
});

test("G5/G6: fixed ticket — PASS on the board vs no PASS anywhere; a PASS row in decisions clears both", () => {
  const root = workspace({
    events: [
      add("C-261023-12", "2026-10-23T16:37:00+09:00", { kind: "worktree", links: [".loop/tickets/T-261023-08/ticket.md"], status: "doing" }),
      upd("C-261023-12", "2026-10-23T17:16:08+09:00", { status: "done", by: "qa", note: "PASS(17:10)" }),
    ],
    tickets: {
      "T-261023-08": { status: "fixed   # qa 재시험 C-261023-12 대기" },
      "T-261021-07": { status: "fixed", route: "qa: 일지", decisions: [["2026-10-22T10:43+09:00", "3 통합", "x", "x", "x", "fixed · 다음 run에서 확인"]] },
      "T-261021-09": { status: "fixed", decisions: [["2026-10-22T10:00+09:00", "4 재시험", "PASS", "x", "x", "fixed"]] },
    },
  });
  const g = gapsOf(root);
  assert.deepEqual(g.filter((x) => x.rule === "G5").map((x) => x.ids), [["T-261023-08", "C-261023-12"]]);
  assert.deepEqual(g.filter((x) => x.rule === "G6").map((x) => [x.ids[0], x.owners[0]]), [["T-261021-07", "qa"]]);
  assert.equal(g.some((x) => x.ids.includes("T-261021-09")), false);
});

test("G7–G9 are off by default and turn on only through config", () => {
  const root = workspace({ tickets: { "T-261023-11": { status: "triaged", route: "impl: x" } } });
  assert.equal(gapsOf(root).length, 0);
  const base = defaults();
  const config = { ...base, gaps: { ...base.gaps, rules: { ...base.gaps.rules, G8: true, G9: true } } };
  assert.deepEqual(gapsOf(root, "impl", { config }).map((x) => x.rule).sort(), ["G8", "G9"]);
  // 프로젝트 설정 파일로도 켠다. G8을 볼 주인도 바꿀 수 있다
  const viaFile = workspace({ tickets: { "T-261023-11": { status: "triaged", route: "qa: x" } }, config: { gaps: { rules: { G8: true }, g8Owners: ["qa"] } } });
  assert.deepEqual(gapsOf(viaFile, "qa").map((x) => x.rule), ["G8"]);
});

test("unknown ticket owner appears only under all", () => {
  const root = workspace({ tickets: { "T-261018-02": { status: "fixed", route: "양쪽 묶음: 외부" } } });
  assert.equal(gapsOf(root, "impl").length, 0);
  assert.deepEqual(gapsOf(root, "all").map((x) => x.owners), [["?"]]);
});

test("markdown stays within the line cap and ends with the remainder pointer", () => {
  const events = Array.from({ length: 60 }, (_, n) => add(`C-261022-${String(n + 1).padStart(2, "0")}`, "2026-10-22T10:00:00+09:00"));
  const root = workspace({ events });
  const view = forRole(computeGaps({ root, now: new Date(NOW), config: defaults() }), "impl");
  const md = toMarkdown(view, { role: "impl", now: new Date(NOW), maxLines: 40 });
  const lines = md.split("\n");
  assert.ok(lines.length <= 40, `lines ${lines.length}`);
  assert.ok(lines[0].startsWith("### "));
  assert.match(lines.at(-1), /^외 \d+개 — `collab gaps --to impl`$/);
  const small = toMarkdown(forRole(computeGaps({ root: workspace(), now: new Date(NOW), config: defaults() }), "impl"), { role: "impl", now: new Date(NOW) });
  assert.match(small, /### 장부 어긋남 \(0\)\n- 없음/);
});

test("CLI list --open --to adds a short gaps field; omitted when none, without --to, or with COLLAB_GAPS=0", async () => {
  const root = workspace({
    events: [add("C-261021-01", "2026-10-21T15:00:00+09:00", { kind: "defect", links: ["T-261021-01"], status: "blocked" })],
    tickets: { "T-261021-01": { status: "closed" } },
  });
  const r = await cli(root, ["list", "--open", "--to", "impl", "--now", NOW]);
  assert.equal(r.code, 0);
  assert.equal(r.json.count, 1);
  assert.equal(r.json.gaps.count, 1);
  assert.match(r.json.gaps.items[0], /^G1 C-261021-01 T-261021-01/);
  assert.equal(r.json.gaps.more, "collab gaps --to impl");
  assert.equal(Object.keys(r.json.gaps)[0], "backlog");
  assert.match(r.json.gaps.backlog, /^열린 티켓 0 · 2일 넘음 0 · 게시판 열린 항목 1 · 끝나지 않은 서브 0$/);
  assert.equal((await cli(root, ["list", "--open", "--to", "qa"])).json.gaps, undefined);
  assert.equal((await cli(root, ["list", "--open"])).json.gaps, undefined);
  assert.equal((await cli(root, ["list", "--open", "--to", "impl"], { COLLAB_GAPS: "0" })).json.gaps, undefined);
});

test("failure isolation: a broken ticket is skipped; a broken project config falls back to the defaults and list keeps working", async () => {
  const root = workspace({
    events: [add("C-261021-01", "2026-10-21T15:00:00+09:00", { kind: "defect", links: ["T-261021-01"], status: "blocked" })],
    tickets: { "T-261021-01": { status: "closed" }, "T-261021-02": { raw: "\u0000 깨진 파일, 머리 없음" } },
  });
  fs.mkdirSync(path.join(root, ".loop/tickets/T-261021-03")); // ticket.md 없음
  const g = await cli(root, ["gaps", "--to", "impl", "--now", NOW]);
  assert.equal(g.code, 0);
  assert.equal(g.json.counts.skipped.tickets, 2);
  assert.equal(g.json.gaps.length, 1);
  fs.writeFileSync(path.join(root, ".loop/collab/config.json"), "{nope");
  const l = await cli(root, ["list", "--open", "--to", "impl"]);
  assert.equal(l.code, 0);
  assert.equal(l.json.count, 1);
  assert.equal(l.json.gaps.count, 1); // 기본값으로 계산
  assert.equal(l.json.config.using, "defaults");
  assert.ok(l.json.config.error);
});

test("CLI gaps: json shape, md format, --limit, usage errors", async () => {
  const root = workspace({ events: [add("C-261022-01", "2026-10-22T10:00:00+09:00"), add("C-261022-02", "2026-10-22T11:00:00+09:00")] });
  const j = await cli(root, ["gaps", "--to", "impl", "--now", NOW]);
  assert.equal(j.json.ok, true);
  assert.equal(j.json.role, "impl");
  assert.equal(new Date(j.json.at).getTime(), new Date(NOW).getTime());
  assert.match(j.json.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.deepEqual(Object.keys(j.json.gaps[0]).sort(), ["ids", "rule", "since", "why"]);
  assert.equal(j.json.counts.gaps, 2);
  const lim = await cli(root, ["gaps", "--to", "impl", "--limit", "1", "--now", NOW]);
  assert.equal(lim.json.gaps.length, 1);
  assert.equal(lim.json.more, "collab gaps --to impl");
  const md = await cli(root, ["gaps", "--to", "impl", "--format", "md", "--now", NOW]);
  assert.equal(md.code, 0);
  // 티켓 장부가 없는 작업 공간: 쌓임 줄과 md에 티켓 부분이 없다
  assert.match(md.stdout, /^### 쌓임\n- 게시판 열린 항목 2 · 끝나지 않은 서브 0\n\n### 장부 어긋남 \(2\)/);
  assert.doesNotMatch(md.stdout, /열린 티켓/);
  assert.equal(j.json.backlog, "게시판 열린 항목 2 · 끝나지 않은 서브 0");
  assert.equal(j.json.counts.openTickets, undefined);
  assert.equal((await cli(root, ["gaps"])).code, 2);
  assert.equal((await cli(root, ["gaps", "--to", "user"])).code, 2);
  assert.equal((await cli(root, ["gaps", "--to", "impl", "--format", "xml"])).code, 2);
  assert.equal((await cli(root, ["gaps", "--to", "impl", "--now", "어제"])).code, 2);
});

test("add/update: related gaps for the written item and its links only, at most 2 lines", async () => {
  // add·update에는 --now가 없어 related를 실제 시계로 계산한다. 그래서 티켓은 실제 시각 기준 한 시간 전에 고친 것(staleHours 안)으로 둔다.
  const fresh = localIso(new Date(Date.now() - 3600e3));
  const root = workspace({
    tickets: {
      "T-261023-08": { status: "fixed   # 재시험 대기", received: fresh },
      "T-261023-01": { status: "fixed", received: fresh },
      "T-261023-02": { status: "fixed", received: fresh },
      "T-261023-03": { status: "fixed", received: fresh },
    },
  });
  // 이어진 어긋남이 없으면 칸이 없다
  const plain = await cli(root, ["add", "--from", "impl", "--to", "qa", "--kind", "note", "--title", "알림"]);
  assert.equal(plain.code, 0);
  assert.equal(plain.json.related, undefined);
  // 재시험 항목을 PASS로 닫았는데 이어진 티켓이 아직 fixed → 한 줄
  const rt = await cli(root, ["add", "--from", "impl", "--to", "qa", "--kind", "retest-request", "--title", "재시험", "--link", "T-261023-08"]);
  assert.equal(rt.json.related, undefined);
  const done = await cli(root, ["update", rt.json.item.id, "--status", "done", "--note", "PASS(17:10)", "--by", "qa"]);
  assert.equal(done.code, 0);
  assert.equal(done.json.item.status, "done");
  assert.deepEqual(done.json.related, [`G5 T-261023-08 ${rt.json.item.id}: 게시판에는 PASS인데 티켓은 fixed`]);
  // 셋이 걸려도 2줄, 둘째 줄 끝에 남은 수
  const many = await cli(root, ["add", "--from", "qa", "--to", "impl", "--kind", "defect", "--title", "결함 T-261023-01·02·03"]);
  assert.equal(many.json.related.length, 2);
  assert.match(many.json.related[1], /\(외 1개 — collab gaps --to all\)$/);
  // 끄면 없다
  const off = await cli(root, ["update", many.json.item.id, "--note", "다시", "--by", "impl"], { COLLAB_GAPS: "0" });
  assert.equal(off.json.related, undefined);
  // 설정이 깨져도 쓰기는 끝나고 종료 코드 0, 기본값으로 계산하고 config 칸으로 알린다
  fs.writeFileSync(path.join(root, ".loop/collab/config.json"), "{nope");
  const broken = await cli(root, ["update", many.json.item.id, "--status", "blocked", "--by", "impl"]);
  assert.equal(broken.code, 0);
  assert.equal(broken.json.item.status, "blocked");
  assert.equal(broken.json.related.length, 2);
  assert.ok(broken.json.config.error);
  assert.equal(fs.existsSync(path.join(root, ".loop/collab/board.jsonl.lock")), false);
});

test("backlog counts only: open tickets, older than 2 days, open board items, unfinished subs", () => {
  const root = workspace({
    events: [add("C-261023-01", "2026-10-23T10:00:00+09:00", { status: "doing" })],
    tickets: { "T-261020-01": { status: "triaged", received: "2026-10-20T10:00+09:00" }, "T-261023-05": { status: "triaged", received: "2026-10-23T10:00+09:00" }, "T-261019-01": { status: "closed" } },
    registries: { impl: { main: { name: "impl-main-1", startedAt: "2026-10-20T00:00:00Z" }, subs: { a: { name: "a", status: "running" }, b: { name: "b", status: "closed" } } } },
  });
  const view = forRole(computeGaps({ root, now: new Date(NOW), config: defaults() }), "impl");
  assert.equal(backlog(view, new Date(NOW)), "열린 티켓 2 · 2일 넘음 1 · 게시판 열린 항목 1 · 끝나지 않은 서브 1");
});

test("a broken or missing lib/gaps.mjs never breaks add·update·list·show; gaps exits 1", async () => {
  const pkg = fileURLToPath(new URL("..", import.meta.url));
  for (const breakIt of [(f) => fs.writeFileSync(f, "export const broken = ;\n"), (f) => fs.rmSync(f)]) {
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), "collab-broken-"));
    fs.cpSync(path.join(pkg, "bin"), path.join(copy, "bin"), { recursive: true });
    fs.cpSync(path.join(pkg, "lib"), path.join(copy, "lib"), { recursive: true });
    fs.writeFileSync(path.join(copy, "package.json"), fs.readFileSync(path.join(pkg, "package.json")));
    breakIt(path.join(copy, "lib/gaps.mjs"));
    const root = workspace();
    const env = CLEAN;
    const call = async (...args) => {
      try {
        const { stdout } = await run(process.execPath, [path.join(copy, "bin/collab.mjs"), ...args, "--root", root], { env });
        return { code: 0, json: JSON.parse(stdout) };
      } catch (error) {
        return { code: error.code, json: JSON.parse(error.stdout) };
      }
    };
    const added = await call("add", "--from", "qa", "--to", "impl", "--kind", "defect", "--title", "결함", "--link", "T-261021-01");
    assert.equal(added.code, 0);
    assert.equal(added.json.ok, true);
    assert.match(added.json.related.error, /^gaps module/);
    const updated = await call("update", added.json.item.id, "--status", "blocked", "--by", "impl");
    assert.equal(updated.code, 0);
    assert.equal(updated.json.item.status, "blocked");
    assert.match(updated.json.related.error, /^gaps module/);
    const listed = await call("list", "--open", "--to", "impl");
    assert.equal(listed.code, 0);
    assert.equal(listed.json.count, 1);
    assert.match(listed.json.gaps.error, /^gaps module/);
    const plain = await call("list", "--open");
    assert.equal(plain.json.gaps, undefined);
    const shown = await call("show", added.json.item.id);
    assert.equal(shown.code, 0);
    assert.equal(shown.json.item.history.length, 2);
    const gaps = await call("gaps", "--to", "impl");
    assert.equal(gaps.code, 1);
    assert.equal(gaps.json.ok, false);
    assert.match(gaps.json.error, /^gaps module/);
    assert.equal((await call("gaps")).code, 2); // 사용법 오류는 불러오기 전에 2
  }
});

test("infra: lineage, owner alias (project) and G3 text all map to the infra role; CLI gaps --to infra works", async () => {
  const config = { ownerAliases: { 인프라: "infra" } };
  const aliases = loadConfig({ root: workspace({ config }), env: {} }).ownerAliases;
  assert.equal(ownerOf("infra: 컨테이너 다시 만들기", aliases), "infra");
  assert.equal(ownerOf("인프라 세션: env 확인", aliases), "infra");
  const registries = { infra: { mains: [], main: { name: "infra-main-1", startedAt: "2026-10-23T00:00:00Z" }, subs: {} } };
  const ticket = { status: "fixing", route: "impl: 고친다", decisions: [["2026-10-21T14:30+09:00", "5 확인", "dev", "x", "y", "코드 끝 · 서버 env는 인프라 몫으로 남음"]] };
  const events = [add("C-261021-01", "2026-10-21T09:00:00+09:00", { kind: "note", to: "all", from: "impl", status: "done" })];
  const root = workspace({ events, registries, tickets: { "T-261021-03": ticket }, config });
  assert.deepEqual(gapsOf(root, "infra").map((x) => [x.rule, x.ids[0]]).sort(), [["G3", "T-261021-03"], ["G4", "infra-main-1"]]);
  // 프로젝트 별칭이 없으면 "인프라 몫"은 잡히지 않는다
  assert.deepEqual(gapsOf(workspace({ events, registries, tickets: { "T-261021-03": ticket } }), "infra").map((x) => x.rule), ["G4"]);
  assert.equal(gapsOf(root, "impl").length, 0);
  const j = await cli(root, ["gaps", "--to", "infra", "--now", NOW]);
  assert.equal(j.code, 0);
  assert.equal(j.json.role, "infra");
});

test("pm: lineage, owner alias and G3 text all map to the pm role; npm is not pm; CLI gaps --to pm works", async () => {
  const aliases = defaults().ownerAliases;
  assert.equal(ownerOf("pm: 일정 다시 잡기", aliases), "pm");
  assert.equal(ownerOf("PM 세션: 우선순위 확인", aliases), "pm");
  const registries = { pm: { mains: [], main: { name: "pm-main-1", startedAt: "2026-10-23T00:00:00Z" }, subs: {} } };
  const row = (tail) => ({ status: "fixing", route: "impl: 고친다", decisions: [["2026-10-21T14:30+09:00", "5 확인", "dev", "x", "y", tail]] });
  const events = [add("C-261021-01", "2026-10-21T09:00:00+09:00", { kind: "note", to: "all", from: "impl", status: "done" })];
  const root = workspace({ events, registries, tickets: { "T-261021-03": row("코드 끝 · 운영 배포 일정은 PM 몫으로 남음") } });
  assert.deepEqual(gapsOf(root, "pm").map((x) => [x.rule, x.ids[0]]).sort(), [["G3", "T-261021-03"], ["G4", "pm-main-1"]]);
  assert.equal(gapsOf(root, "impl").length, 0);
  const other = workspace({ events, tickets: { "T-261021-04": row("패키지 정리는 npm 몫") } });
  assert.equal(gapsOf(other, "pm").length, 0);
  const j = await cli(root, ["gaps", "--to", "pm", "--now", NOW]);
  assert.equal(j.code, 0);
  assert.equal(j.json.role, "pm");
});

test("renamed role and lineage (roleAliases, oldLineages): old names in G3 text and gaps --to <old> map to the new role; names inside other words do not", async () => {
  const config = { roleAliases: { tester: "qa" }, oldLineages: { tst: "qa" } };
  const registries = { qa: { mains: [{ name: "tst-main-13", startedAt: "2026-10-20T00:00:00Z" }], main: { name: "qa-main-14", startedAt: "2026-10-23T00:00:00Z" }, subs: {} } };
  const row = (tail) => ({ status: "fixing", route: "impl: 고친다", decisions: [["2026-10-21T14:30+09:00", "5 확인", "dev", "x", "y", tail]] });
  const events = [add("C-261021-01", "2026-10-21T09:00:00+09:00", { kind: "note", to: "all", from: "impl", status: "done" })];
  const tickets = { "T-261021-03": row("코드 끝 · 재시험은 qa 몫으로 남음"), "T-261021-04": row("코드 끝 · 재시험은 tester 몫"), "T-261021-05": row("aqa 몫"), "T-261021-06": row("retester 몫") };
  const root = workspace({ events, registries, tickets, config });
  assert.deepEqual(gapsOf(root, "qa").map((x) => [x.rule, x.ids[0]]).sort(), [["G3", "T-261021-03"], ["G3", "T-261021-04"], ["G4", "qa-main-14"]]);
  const j = await cli(root, ["gaps", "--to", "tester", "--now", NOW]);
  assert.equal(j.code, 0);
  assert.equal(j.json.role, "qa");
});

test("no ticket ledger: ticket rules skip silently; gaps.tickets moves or turns off the ledger", async () => {
  const events = [add("C-261021-01", "2026-10-21T15:00:00+09:00", { kind: "defect", links: ["T-261021-01"], status: "blocked" })];
  const none = workspace({ events });
  assert.deepEqual(gapsOf(none, "impl"), []);
  const r = await cli(none, ["gaps", "--to", "impl", "--now", NOW]);
  assert.equal(r.code, 0);
  assert.equal(r.json.backlog, "게시판 열린 항목 1 · 끝나지 않은 서브 0");
  // 같은 결함이라도 장부가 있으면 G1
  const withTickets = workspace({ events, tickets: { "T-261021-01": { status: "closed" } } });
  assert.deepEqual(gapsOf(withTickets, "impl").map((x) => x.rule), ["G1"]);
  // 끄면 장부가 있어도 건너뛴다
  fs.writeFileSync(path.join(withTickets, ".loop/collab/config.json"), JSON.stringify({ gaps: { tickets: false } }));
  assert.deepEqual(gapsOf(withTickets, "impl"), []);
  assert.equal((await cli(withTickets, ["gaps", "--to", "impl", "--now", NOW])).json.backlog, "게시판 열린 항목 1 · 끝나지 않은 서브 0");
  // 다른 자리의 장부
  const moved = workspace({ events, config: { gaps: { tickets: "work/tickets" } } });
  fs.mkdirSync(path.join(moved, "work/tickets/T-261021-01"), { recursive: true });
  fs.writeFileSync(path.join(moved, "work/tickets/T-261021-01/ticket.md"), "status: closed\nroute: impl: x\n\n# moved\n");
  assert.deepEqual(gapsOf(moved, "impl").map((x) => x.rule), ["G1"]);
});

test("an added role (project config) has its own lineage registry and gaps --to <role>", async () => {
  const config = { roles: { design: true }, lineages: { dsg: "design" } };
  const registries = { dsg: { mains: [], main: { name: "dsg-main-1", startedAt: "2026-10-23T00:00:00Z" }, subs: { a: { name: "a", status: "running" } } } };
  const events = [add("C-261021-01", "2026-10-21T09:00:00+09:00", { kind: "note", to: "design", from: "impl" })];
  const root = workspace({ events, registries, config });
  const j = await cli(root, ["gaps", "--to", "design", "--now", NOW]);
  assert.equal(j.code, 0);
  assert.deepEqual(j.json.gaps.map((x) => x.rule).sort(), ["G2", "G4"]);
  assert.equal(j.json.backlog, "게시판 열린 항목 1 · 끝나지 않은 서브 1");
  assert.equal((await cli(workspace({ events }), ["gaps", "--to", "design"])).code, 2);
});
