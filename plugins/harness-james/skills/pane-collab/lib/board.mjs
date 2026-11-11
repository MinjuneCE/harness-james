// pane-collab 공용 게시판: <작업 공간>/.loop/collab/board.jsonl(덧붙이기만).
// 한 줄이 사건 하나다. {op:"add", ...항목} 또는 {op:"update", id, at, ...바뀐 것}.
// 지금 상태는 줄을 차례로 접어서 만든다. 줄을 고치거나 지우지 않는다.
// 역할 목록·켜고 끄기·옛 이름은 설정(lib/config.mjs: 기본값 + .loop/collab/config.json)에서 온다.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, roleNames, roleName } from "./config.mjs";

export const KINDS = [
  "run-request", "run-result", "defect", "impl-request", "retest-request", "infra-request",
  "doc-change", "worktree", "resource", "decision", "handover", "ack", "note",
];
export const STATUSES = ["open", "doing", "done", "blocked", "cancelled"];
export const OPEN_STATUSES = ["open", "doing", "blocked"];

const LOCK_STALE_MS = 30_000;

export class BoardError extends Error {
  constructor(message, { next, usage } = {}) {
    super(message);
    if (next) this.next = next;
    if (usage) this.usage = true;
  }
}

// 2026-10-20T16:04:05+09:00 꼴(로컬 시각 + 오프셋)
export function localIso(date) {
  const pad = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`;
}

function checkStatus(status) {
  if (!STATUSES.includes(status)) throw new BoardError(`unknown status ${status}`, { usage: true, next: `one of ${STATUSES.join(", ")}` });
  return status;
}

export function makeBoard({ file, now = () => new Date(), config = loadConfig() }) {
  const lockDir = `${file}.lock`;
  // 받는 쪽·보내는 쪽에 쓸 수 있는 이름: 설정의 역할 + user + all. 옛 이름(roleAliases)은 지금 이름으로 읽는다.
  const ROLES = [...roleNames(config), "user", "all"];
  const name = (r) => roleName(config, r);
  const normRoles = (s) => (s == null ? s : String(s).split(",").map((r) => name(r.trim())).join(","));

  function checkRoles(value, field) {
    const list = String(value ?? "").split(",").map((s) => name(s.trim())).filter(Boolean);
    if (list.length === 0) throw new BoardError(`${field} is required`, { usage: true, next: `--${field} <${ROLES.join("|")}>` });
    const bad = list.filter((r) => !ROLES.includes(r));
    if (bad.length) throw new BoardError(`unknown ${field} ${bad.join(",")}`, { usage: true, next: `one of ${ROLES.join(", ")}` });
    return list.join(",");
  }

  // 꺼진 역할(설정 roles의 false)은 받는 쪽에 넣을 수 없다. 보내기·고치기(--from·--by)는 된다.
  function checkOn(to) {
    const off = to.split(",").filter((r) => config.roles[r] === false);
    if (off.length) throw new BoardError(`${off.join(",")} 역할은 꺼져 있어요`, { usage: true, next: `--to에서 ${off.join(",")}을 빼요. 켜고 끄기는 사용자가 정해요(설정 ${config.file ?? ".loop/collab/config.json"}의 roles, collab roles)` });
    return to;
  }

  function readEvents() {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { events: [], skipped: 0 };
      throw error;
    }
    const events = [];
    let skipped = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && (e.op === "add" || e.op === "update") && typeof e.id === "string") events.push(e);
        else skipped++;
      } catch {
        skipped++;
      }
    }
    return { events, skipped };
  }

  function fold(events) {
    const items = new Map();
    for (const e of events) {
      if (e.op === "add") {
        if (items.has(e.id)) continue;
        const { op, ...item } = e;
        item.from = normRoles(item.from);
        item.to = normRoles(item.to);
        items.set(e.id, { ...item, links: item.links ?? [], updated: e.at, history: [{ at: e.at, by: item.from, status: e.status }] });
      } else {
        const item = items.get(e.id);
        if (!item) continue;
        if (e.status) item.status = e.status;
        if (e.links?.length) item.links = [...new Set([...item.links, ...e.links])];
        item.updated = e.at;
        item.history.push({ at: e.at, ...(e.by ? { by: normRoles(e.by) } : {}), ...(e.status ? { status: e.status } : {}), ...(e.note ? { note: e.note } : {}) });
      }
    }
    return items;
  }

  // 여러 세션이 같은 파일에 쓰므로 id 고르기와 덧붙이기를 잠금 안에서 한다.
  function withLock(fn) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.mkdirSync(lockDir);
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) fs.rmSync(lockDir, { recursive: true, force: true });
        } catch {}
        if (Date.now() > deadline) throw new BoardError("board is locked", { next: `remove ${lockDir} if no collab command is running` });
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }
  }

  function append(event) {
    fs.appendFileSync(file, JSON.stringify(event) + "\n");
  }

  function summary(item) {
    const { history, ...rest } = item;
    return rest;
  }

  return {
    add({ from, to, kind, title, links = [], status = "open" }) {
      from = checkRoles(from, "from");
      to = checkOn(checkRoles(to, "to"));
      if (!KINDS.includes(kind)) throw new BoardError(`unknown kind ${kind}`, { usage: true, next: `one of ${KINDS.join(", ")}` });
      if (!title || !String(title).trim()) throw new BoardError("title is required", { usage: true, next: "--title \"<SendMessage 첫 줄과 같은 한 문장>\"" });
      checkStatus(status);
      return withLock(() => {
        const at = now();
        const day = localIso(at).slice(2, 10).replaceAll("-", "");
        const prefix = `C-${day}-`;
        const used = readEvents().events.filter((e) => e.op === "add" && e.id.startsWith(prefix)).map((e) => Number(e.id.slice(prefix.length)));
        const id = `${prefix}${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
        const event = { op: "add", id, at: localIso(at), from, to, kind, title: String(title).trim(), status, links: [...new Set(links)] };
        append(event);
        const { op, ...item } = event;
        return item;
      });
    },

    update(id, { status, note, links = [], by } = {}) {
      if (!id) throw new BoardError("id is required", { usage: true, next: "collab update <C-YYMMDD-NN> --status <s>" });
      if (status !== undefined) checkStatus(status);
      if (by !== undefined) by = checkRoles(by, "by");
      if (status === undefined && !note && links.length === 0) throw new BoardError("nothing to update", { usage: true, next: "--status, --note or --link" });
      return withLock(() => {
        const items = fold(readEvents().events);
        if (!items.has(id)) throw new BoardError(`no item ${id}`, { next: "collab list" });
        const event = { op: "update", id, at: localIso(now()), ...(by ? { by } : {}), ...(status ? { status } : {}), ...(note ? { note } : {}), ...(links.length ? { links: [...new Set(links)] } : {}) };
        append(event);
        return summary(fold(readEvents().events).get(id));
      });
    },

    list({ open = false, to, from, kind } = {}) {
      to = to && name(to);
      from = from && name(from);
      const { events, skipped } = readEvents();
      let items = [...fold(events).values()];
      if (open) items = items.filter((i) => OPEN_STATUSES.includes(i.status));
      // 받는 쪽 거르기에는 "all"로 보낸 항목도 들어간다.
      if (to) items = items.filter((i) => i.to.split(",").some((r) => r === to || r === "all"));
      if (from) items = items.filter((i) => i.from.split(",").includes(from));
      if (kind) items = items.filter((i) => i.kind === kind);
      return { count: items.length, items: items.map(summary), ...(skipped ? { skipped } : {}) };
    },

    // 접은 항목 전부(history 포함)와 사건 줄. gaps 계산이 읽기만 한다.
    snapshot() {
      const { events, skipped } = readEvents();
      return { events, items: [...fold(events).values()], skipped };
    },

    show(id) {
      if (!id) throw new BoardError("id is required", { usage: true, next: "collab show <C-YYMMDD-NN>" });
      const item = fold(readEvents().events).get(id);
      if (!item) throw new BoardError(`no item ${id}`, { next: "collab list" });
      return item;
    },
  };
}
