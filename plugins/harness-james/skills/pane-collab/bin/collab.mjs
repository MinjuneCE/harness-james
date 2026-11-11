#!/usr/bin/env node
// collab: 역할 세션들(기본 impl·qa·scenarios·infra·pm)이 함께 보는 게시판.
//   collab add --from <역할> --to <역할> --kind <종류> --title "<첫 줄>" [--link <티켓·파일·요청서>]… [--status open]
//   collab update <id> [--status <상태>] [--note "<글>"] [--link …]… [--by <역할>]
//   collab list [--open] [--to <역할>] [--from <역할>] [--kind <종류>]
//   collab show <id>
//   collab gaps --to <역할> [--format json|md] [--limit N] [--now <ISO>]
//   collab roles                       역할마다 켜짐(true)·꺼짐(false)과 계보. 꺼진 역할은 add --to에 넣을 수 없다
// 게시판 파일은 <작업 공간>/.loop/collab/board.jsonl이고 COLLAB_BOARD나 --board로 바꾼다.
// 설정은 기본값 + <작업 공간>/.loop/collab/config.json(lib/config.mjs, COLLAB_CONFIG로 바꾼다). 없어도 돈다.
// 작업 공간 뿌리: --root > COLLAB_ROOT > PANE_LEAD_ROOT > CLAUDE_PROJECT_DIR > cwd 위로 처음 만나는 .loop/collab > cwd.
// 설정 파일이 깨졌거나 건너뛴 항목이 있으면 출력에 config 칸이 붙는다(기본값으로 계속 돈다).
// list --open --to <역할>에는 그 역할의 장부 어긋남(lib/gaps.mjs)을 gaps 칸으로, add·update에는 방금 쓴 항목에 이어진
// 어긋남을 related 칸(최대 2줄)으로 얹는다. COLLAB_GAPS=0이면 둘 다 얹지 않는다.
// 출력은 JSON 한 줄, 종료 코드는 0 성공, 1 실패, 2 사용법 오류다.
import path from "node:path";
import { makeBoard, BoardError, KINDS, STATUSES, localIso } from "../lib/board.mjs";
import { resolveRoot, loadConfig, roleNames, roleName, offRoles, configNotice, BOARD_REL } from "../lib/config.mjs";

// gaps 계산은 필요할 때만 불러온다. lib/gaps.mjs가 깨져도(문법 오류·파일 없음) add·update·list·show는 원래대로 된다.
let gapsModule;
async function loadGaps() {
  gapsModule ??= import("../lib/gaps.mjs").then((mod) => ({ mod }), (error) => ({ error: `gaps module: ${String(error?.message ?? error).slice(0, 100)}` }));
  return gapsModule;
}
const short = (error) => ({ error: String(error?.message ?? error).slice(0, 120) });

const USAGE = {
  add: "collab add --from <role> --to <role[,role]> --kind <kind> --title \"<text>\" [--link <ref>]... [--status <status>]",
  update: "collab update <id> [--status <status>] [--note \"<text>\"] [--link <ref>]... [--by <role>]",
  list: "collab list [--open] [--to <role>] [--from <role>] [--kind <kind>]",
  show: "collab show <id>",
  gaps: "collab gaps --to <role|all> [--format json|md] [--limit N] [--now <ISO>]",
  roles: "collab roles",
};
const OPTIONS = {
  add: ["from", "to", "kind", "title", "link", "status", "board", "root"],
  update: ["status", "note", "link", "by", "board", "root"],
  list: ["open", "to", "from", "kind", "board", "root", "now"],
  show: ["board", "root"],
  gaps: ["to", "format", "limit", "now", "board", "root"],
  roles: ["root"],
};
const FLAGS = new Set(["open"]);
const REPEAT = new Set(["link"]);

function out(obj, code = 0) {
  process.stdout.write(JSON.stringify(obj) + "\n");
  process.exit(code);
}

function parseNow(value) {
  if (value === undefined) return new Date();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new BoardError(`bad --now ${value}`, { usage: true, next: "--now 2026-10-23T18:00:00+09:00" });
  return d;
}

// add·update 뒤에 붙이는 이어진 어긋남(최대 2줄). 잠금을 푼 뒤 부른다. 없으면 null, 실패하면 error만.
async function relatedLines({ root, file, config, item, text }) {
  const { mod, error } = await loadGaps();
  if (error) return { error };
  const { relatedGaps, computeGaps, gapLine } = mod;
  try {
    const found = relatedGaps(computeGaps({ root, boardFile: file, now: new Date(), config }), { id: item.id, links: item.links, text: [item.title, text].join(" ") });
    if (!found.length) return null;
    const lines = found.slice(0, 2).map(gapLine);
    if (found.length > 2) lines[1] += ` (외 ${found.length - 2}개 — collab gaps --to all)`;
    return lines;
  } catch (error) {
    return short(error);
  }
}

// list에 얹는 짧은 꼴. 어긋남이 없으면 null(칸을 뺀다). 실패해도 list는 깨지지 않는다.
async function listGaps({ root, file, config, role, now }) {
  const { mod, error } = await loadGaps();
  if (error) return { error };
  const { forRole, computeGaps, backlog, gapLine } = mod;
  try {
    const view = forRole(computeGaps({ root, boardFile: file, now, config }), role);
    if (!view.gaps.length) return null;
    return { backlog: backlog(view, now), count: view.gaps.length, items: view.gaps.slice(0, config.gaps.listMax).map(gapLine), more: `collab gaps --to ${role}` };
  } catch (error) {
    return short(error);
  }
}

function parse(command, args) {
  const opts = { _: [], link: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const key = a.slice(2);
    if (!OPTIONS[command].includes(key)) throw new BoardError(`unknown option --${key}`, { usage: true, next: `options for ${command}: ${OPTIONS[command].map((o) => `--${o}`).join(" ")}` });
    if (FLAGS.has(key)) {
      opts[key] = true;
      continue;
    }
    const value = args[++i];
    if (value === undefined) throw new BoardError(`--${key} needs a value`, { usage: true });
    if (REPEAT.has(key)) opts[key].push(value);
    else opts[key] = value;
  }
  return opts;
}

const [command, ...rest] = process.argv.slice(2);
if (!command || command === "--help" || command === "help" || !USAGE[command]) {
  const config = loadConfig({ root: resolveRoot() });
  out({ ok: !command || command === "--help" || command === "help", usage: Object.values(USAGE), roles: [...roleNames(config), "user", "all"], kinds: KINDS, statuses: STATUSES }, command && !["--help", "help"].includes(command) ? 2 : 0);
}

let notice = null;
try {
  const opts = parse(command, rest);
  const root = resolveRoot({ root: opts.root });
  const file = opts.board ?? process.env.COLLAB_BOARD ?? path.join(root, BOARD_REL);
  const config = loadConfig({ root });
  notice = configNotice(config);
  const board = makeBoard({ file, config });
  let result;
  if (command === "add" || command === "update") {
    const item = command === "add"
      ? board.add({ from: opts.from, to: opts.to, kind: opts.kind, title: opts.title, links: opts.link, status: opts.status })
      : board.update(opts._[0], { status: opts.status, note: opts.note, links: opts.link, by: opts.by });
    result = { item };
    // 쓰기와 잠금이 끝난 뒤에 계산한다.
    if (process.env.COLLAB_GAPS !== "0") {
      const related = await relatedLines({ root, file, config, item, text: opts.note ?? "" });
      if (related) result.related = related;
    }
  }
  else if (command === "list") {
    result = board.list({ open: opts.open, to: opts.to, from: opts.from, kind: opts.kind });
    if (opts.open && opts.to && process.env.COLLAB_GAPS !== "0") {
      let now;
      try { now = parseNow(opts.now); } catch { now = new Date(); }
      const gaps = await listGaps({ root, file, config, role: roleName(config, opts.to), now });
      if (gaps) result.gaps = gaps;
    }
  } else if (command === "gaps") {
    const role = opts.to && roleName(config, opts.to);
    const roles = [...roleNames(config), "all"];
    if (!roles.includes(role)) throw new BoardError(role ? `unknown role ${role}` : "--to is required", { usage: true, next: `--to <${roles.join("|")}>` });
    const format = opts.format ?? "json";
    if (!["json", "md"].includes(format)) throw new BoardError(`unknown format ${format}`, { usage: true, next: "--format json|md" });
    const limit = opts.limit === undefined ? Infinity : Number(opts.limit);
    if (!(limit >= 0)) throw new BoardError(`bad --limit ${opts.limit}`, { usage: true, next: "--limit 20" });
    const now = parseNow(opts.now);
    const { mod, error } = await loadGaps();
    if (error) throw new BoardError(error, { next: "lib/gaps.mjs를 불러오지 못했어요. add·update·list·show는 그대로 돼요" });
    const { computeGaps, forRole, toMarkdown, backlog, counts } = mod;
    let computed;
    try {
      computed = computeGaps({ root, boardFile: file, now, config });
    } catch (e) {
      throw new BoardError(`gaps: ${short(e).error}`);
    }
    const view = forRole(computed, role);
    if (format === "md") {
      process.stdout.write(toMarkdown(view, { role, now, maxLines: config.gaps.mdMaxLines }) + "\n");
      process.exit(0);
    }
    const shown = view.gaps.slice(0, limit);
    result = { role, at: localIso(now), backlog: backlog(view, now), gaps: shown.map(({ owners, ...g }) => (role === "all" ? { ...g, owners } : g)), counts: counts(view, computed.skipped), ...(shown.length < view.gaps.length ? { more: `collab gaps --to ${role}` } : {}) };
  } else if (command === "roles") {
    // 프로젝트 설정 파일이 있는지(config), 역할 켜짐·꺼짐, 계보 → 역할(훅이 막는 세션 이름 <계보>-main-*)
    result = { roles: { ...config.roles }, off: offRoles(config), lineages: { ...config.oldLineages, ...config.lineages }, configFile: config.exists ? config.file : null };
  } else result = { item: board.show(opts._[0]) };
  out({ ok: true, ...result, ...(notice ? { config: notice } : {}) });
} catch (error) {
  if (!(error instanceof BoardError)) throw error;
  out({ ok: false, error: error.message, ...(error.next ? { next: error.next } : {}), ...(error.usage ? { usage: USAGE[command] } : {}), ...(notice ? { config: notice } : {}) }, error.usage ? 2 : 1);
}
