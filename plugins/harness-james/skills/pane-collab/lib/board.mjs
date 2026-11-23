// pane-collab 공용 게시판: <작업 공간>/.loop/collab/board.jsonl(덧붙이기만).
// 한 줄이 사건 하나다. {op:"add", ...항목} 또는 {op:"update", id, at, ...바뀐 것}.
// 지금 상태는 줄을 차례로 접어서 만든다. 줄을 고치거나 지우지 않는다.
// 역할 목록·켜고 끄기·옛 이름은 설정(lib/config.mjs: 기본값 + .loop/collab/config.json)에서 온다.
// 항목마다 project 칸(프로젝트 이름 또는 common)이 있다. 목표 프로젝트와 역할마다 보고 있는 프로젝트는
// 게시판 옆 projects.json에 있고, 명령 때마다 새로 읽는다. 파일이 없으면 프로젝트 없이(전부 common) 돈다.
import fs from "node:fs";
import path from "node:path";
import { loadConfig, roleNames, roleName } from "./config.mjs";

export const KINDS = [
  "run-request", "run-result", "defect", "impl-request", "retest-request", "infra-request",
  "doc-change", "worktree", "resource", "decision", "handover", "ack", "note",
];
export const STATUSES = ["open", "doing", "done", "blocked", "cancelled"];
export const OPEN_STATUSES = ["open", "doing", "blocked"];
// 공통 게시판 이름, 늘 공통으로 가는 종류
export const COMMON = "common";
export const COMMON_KINDS = ["handover", "resource", "worktree"];
const PROJECT_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PROJECT_RESERVED = new Set([COMMON, "all"]);

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

// project 칸이 없는 줄(프로젝트 게시판 전에 쓴 줄)의 프로젝트. 기본은 common이라 어느 프로젝트에서도 보인다.
// 프로젝트가 옛 줄을 나누고 싶으면 설정 legacyProjects(ids → commonKinds → ranges 차례)로 정한다.
export function legacyProject(e, legacy = {}) {
  if (legacy.ids?.[e.id]) return legacy.ids[e.id];
  if ((legacy.commonKinds ?? COMMON_KINDS).includes(e.kind)) return COMMON;
  for (const r of legacy.ranges ?? []) if (e.id <= r.through) return r.project;
  return COMMON;
}

// 이 명령을 부른 세션: pane-lead가 설정 env에 넣는 PANE_LEAD_ROLE(main|sub)과, project-sub 스킬이 서브에 넣는 COLLAB_PROJECT.
// 다른 프로젝트 게시판은 고정된 서브만 본다. 서브가 아닌 세션에 COLLAB_PROJECT가 있으면 거절한다.
export function sessionOf(env = process.env) {
  const sub = env.PANE_LEAD_ROLE === "sub";
  const pin = String(env.COLLAB_PROJECT ?? "").trim() || null;
  if (pin && !sub) throw new BoardError("COLLAB_PROJECT는 project-sub 서브에서만 써요", { next: "다른 프로젝트의 간단한 일은 project-sub 스킬로 서브에 맡겨요. 큰 일이면 사용자에게 전환(collab switch)을 물어요" });
  return { sub, pin };
}
const NO_SESSION = { sub: false, pin: null };
const SUB_NO_SWITCH = () => new BoardError("서브는 게시판을 전환하지 않아요", { next: "전환은 사용자가 메인에게 시켜요. 서브는 띄울 때 정해진 프로젝트에서 일하고, 끝나면 메인이 pane을 닫아요" });
const WARN = {
  missing: "projects.json이 없어요. 목록은 전부 보여 주고 새 항목은 common으로 넣어요. 만들기: collab switch <이름> --new --title \"<뜻>\" --by <역할>",
  broken: "projects.json을 읽지 못했어요(깨짐). 목록은 전부 보여 주고 새 항목은 common으로 넣어요. 파일을 고친 뒤 collab project로 확인해요",
};

function checkStatus(status) {
  if (!STATUSES.includes(status)) throw new BoardError(`unknown status ${status}`, { usage: true, next: `one of ${STATUSES.join(", ")}` });
  return status;
}

export function makeBoard({ file, now = () => new Date(), config = loadConfig(), session = NO_SESSION, projectsFile }) {
  const lockDir = `${file}.lock`;
  projectsFile ??= path.join(path.dirname(file), "projects.json");
  const legacy = config.legacyProjects ?? {};
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

  // 프로젝트를 갖는 역할: 설정의 역할 전부(user·all 말고)
  const PROJECT_ROLES = roleNames(config);

  // projects.json: { target, switchedAt, switchedBy, roles: {역할: 프로젝트}, projects: {이름: {title, since}} }
  function readState() {
    let text;
    try {
      text = fs.readFileSync(projectsFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { state: null, problem: "missing" };
      throw error;
    }
    try {
      const s = JSON.parse(text);
      if (!s || typeof s.target !== "string" || !s.projects || typeof s.projects !== "object" || !s.projects[s.target]) throw new Error("shape");
      s.roles = s.roles && typeof s.roles === "object" ? { ...s.roles } : {};
      return { state: s };
    } catch {
      return { state: null, problem: "broken" };
    }
  }
  function writeState(s) {
    fs.mkdirSync(path.dirname(projectsFile), { recursive: true });
    const tmp = `${projectsFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, projectsFile);
  }
  const roleProject = (s, role) => (s.projects[s.roles[role]] ? s.roles[role] : s.target);
  const names = (s) => Object.keys(s.projects).join(", ");
  const hhmm = (iso) => String(iso ?? "").slice(11, 16) || "?";

  // 이 명령이 쓸 프로젝트. 고정된 서브 → 고정값, 역할이 있으면 그 역할이 보고 있는 것, 없으면 목표.
  // projects.json이 없거나 깨졌으면 project는 null(거르지 않음)이고 warn이 붙는다.
  function view(role) {
    const { state, problem } = readState();
    if (!state) {
      if (session.pin) throw new BoardError(`COLLAB_PROJECT=${session.pin}인데 projects.json을 읽지 못했어요`, { next: "이 서브를 띄운 메인에게 알려요" });
      return { project: null, warn: WARN[problem] };
    }
    if (session.pin) {
      if (!state.projects[session.pin]) throw new BoardError(`등록되지 않은 프로젝트 ${session.pin}`, { next: `등록된 것: ${names(state)}. 이 서브를 띄운 메인에게 알려요` });
      return { project: session.pin, pinned: true };
    }
    const r = name(String(role ?? "").split(",")[0].trim());
    if (!PROJECT_ROLES.includes(r)) return { project: state.target };
    const project = roleProject(state, r);
    if (project === state.target) return { project };
    return { project, pending: `목표 프로젝트: ${state.target} (${state.switchedBy ?? "?"}가 ${hhmm(state.switchedAt)}에 바꿈). 하던 턴을 마친 뒤 collab switch --accept --by ${r}` };
  }
  const meta = ({ project, pinned, pending, warn }) => ({ ...(project ? { project } : {}), ...(pinned ? { pinned: true } : {}), ...(pending ? { pending } : {}), ...(warn ? { warn } : {}) });
  function openCounts(items, projects) {
    const open = Object.fromEntries(projects.map((p) => [p, 0]));
    for (const i of items) if (OPEN_STATUSES.includes(i.status) && i.project in open) open[i.project]++;
    return open;
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
        item.project ??= legacyProject(e, legacy);
        items.set(e.id, { ...item, links: item.links ?? [], updated: e.at, history: [{ at: e.at, by: item.from, status: e.status }] });
      } else {
        const item = items.get(e.id);
        if (!item) continue;
        if (e.status) item.status = e.status;
        if (e.links?.length) item.links = [...new Set([...item.links, ...e.links])];
        if (e.project) item.project = e.project;
        item.updated = e.at;
        item.history.push({ at: e.at, ...(e.by ? { by: normRoles(e.by) } : {}), ...(e.status ? { status: e.status } : {}), ...(e.project ? { project: e.project } : {}), ...(e.note ? { note: e.note } : {}) });
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

  // 잠금 안에서 부른다: 그날의 다음 번호를 골라 add 줄을 덧붙인다.
  function appendAdd(fields) {
    const at = now();
    const day = localIso(at).slice(2, 10).replaceAll("-", "");
    const prefix = `C-${day}-`;
    const used = readEvents().events.filter((e) => e.op === "add" && e.id.startsWith(prefix)).map((e) => Number(e.id.slice(prefix.length)));
    const id = `${prefix}${String(Math.max(0, ...used) + 1).padStart(2, "0")}`;
    const event = { op: "add", id, at: localIso(at), ...fields };
    append(event);
    const { op, ...item } = event;
    return item;
  }
  function oneRole(by, allowed, usageText) {
    const r = name(String(by ?? "").trim());
    if (!allowed.includes(r)) throw new BoardError(by ? `unknown by ${by}` : "--by is required", { usage: true, next: usageText });
    return r;
  }

  return {
    add({ from, to, kind, title, links = [], status = "open" }) {
      from = checkRoles(from, "from");
      to = checkOn(checkRoles(to, "to"));
      if (!KINDS.includes(kind)) throw new BoardError(`unknown kind ${kind}`, { usage: true, next: `one of ${KINDS.join(", ")}` });
      if (!title || !String(title).trim()) throw new BoardError("title is required", { usage: true, next: "--title \"<SendMessage 첫 줄과 같은 한 문장>\"" });
      checkStatus(status);
      return withLock(() => {
        // 인계·자원·worktree는 공통, 나머지는 쓰는 역할이 보고 있는 프로젝트(고정된 서브는 고정값). projects.json이 없으면 공통.
        const project = COMMON_KINDS.includes(kind) ? (view(from), COMMON) : view(from).project ?? COMMON;
        return appendAdd({ from, to, kind, title: String(title).trim(), status, links: [...new Set(links)], project });
      });
    },

    update(id, { status, note, links = [], by, project } = {}) {
      if (!id) throw new BoardError("id is required", { usage: true, next: "collab update <C-YYMMDD-NN> --status <s>" });
      if (status !== undefined) checkStatus(status);
      if (by !== undefined) by = checkRoles(by, "by");
      if (status === undefined && !note && links.length === 0 && project === undefined) throw new BoardError("nothing to update", { usage: true, next: "--status, --note, --link or --project" });
      return withLock(() => {
        const items = fold(readEvents().events);
        if (!items.has(id)) throw new BoardError(`no item ${id}`, { next: "collab list" });
        if (project !== undefined) {
          // 잘못 들어간 항목의 이름표를 옮긴다. 등록된 프로젝트나 common만.
          const { state } = readState();
          if (!state) throw new BoardError("projects.json이 없거나 깨져서 프로젝트를 옮길 수 없어요", { next: "collab project" });
          if (project !== COMMON && !state.projects[project]) throw new BoardError(`등록되지 않은 프로젝트 ${project}`, { usage: true, next: `등록된 것: ${names(state)}, ${COMMON}` });
        }
        const event = { op: "update", id, at: localIso(now()), ...(by ? { by } : {}), ...(status ? { status } : {}), ...(project ? { project } : {}), ...(note ? { note } : {}), ...(links.length ? { links: [...new Set(links)] } : {}) };
        append(event);
        return summary(fold(readEvents().events).get(id));
      });
    },

    list({ open = false, to, from, kind } = {}) {
      to = to && name(to);
      from = from && name(from);
      const { events, skipped } = readEvents();
      let items = [...fold(events).values()];
      // 범위: 받는 역할(없으면 보낸 역할)이 보고 있는 프로젝트 + 공통. 고정된 서브는 고정된 프로젝트 + 공통.
      const v = view(to ?? from);
      if (v.project) items = items.filter((i) => i.project === v.project || i.project === COMMON);
      if (open) items = items.filter((i) => OPEN_STATUSES.includes(i.status));
      // 받는 쪽 거르기에는 "all"로 보낸 항목도 들어간다.
      if (to) items = items.filter((i) => i.to.split(",").some((r) => r === to || r === "all"));
      if (from) items = items.filter((i) => i.from.split(",").includes(from));
      if (kind) items = items.filter((i) => i.kind === kind);
      return { ...meta(v), count: items.length, items: items.map(summary), ...(skipped ? { skipped } : {}) };
    },

    // 역할(없으면 목표)에 걸리는 프로젝트와 pending·warn. 쓰지는 않는다.
    view(role) {
      const v = view(role);
      return { ...v, meta: meta(v) };
    },

    // 목표, 역할마다 보고 있는 프로젝트, 아직 안 넘어간 역할, 프로젝트마다 열린 항목 수.
    info() {
      const { state, problem } = readState();
      const items = [...fold(readEvents().events).values()];
      if (!state) return { target: null, warn: WARN[problem], open: openCounts(items, [...new Set(items.map((i) => i.project))]) };
      const roles = Object.fromEntries(PROJECT_ROLES.map((r) => [r, roleProject(state, r)]));
      return {
        target: state.target, switchedAt: state.switchedAt ?? null, switchedBy: state.switchedBy ?? null,
        roles, behind: PROJECT_ROLES.filter((r) => roles[r] !== state.target),
        projects: Object.fromEntries(Object.entries(state.projects).map(([k, p]) => [k, p?.title ?? ""])),
        open: openCounts(items, [...Object.keys(state.projects), COMMON]),
        ...(session.pin ? { pinned: session.pin } : {}),
      };
    },

    // 목표 프로젝트를 바꾼다. 요청한 역할과 꺼진 역할만 바로 넘어가고, 나머지는 턴이 끝난 뒤 accept로 넘어간다.
    switchTo(project, { by, isNew = false, title } = {}) {
      if (session.sub) throw SUB_NO_SWITCH();
      const usageText = `collab switch <project> --by <${[...PROJECT_ROLES, "user"].join("|")}>`;
      by = oneRole(by, [...PROJECT_ROLES, "user"], usageText);
      project = String(project ?? "").trim();
      if (!project) throw new BoardError("project is required", { usage: true, next: usageText });
      if (!PROJECT_RE.test(project) || PROJECT_RESERVED.has(project)) throw new BoardError(`bad project name ${project}`, { usage: true, next: "영문 소문자·숫자·-만 써요(common, all은 못 써요). 예: billing-v2" });
      if (isNew && !String(title ?? "").trim()) throw new BoardError("--new needs --title", { usage: true, next: `collab switch ${project} --new --title "<뜻>" --by ${by}` });
      return withLock(() => {
        const { state, problem } = readState();
        if (problem === "broken") throw new BoardError("projects.json을 읽지 못했어요(깨짐)", { next: `${projectsFile}을 고치거나 사용자에게 알려요. 덮어쓰지 않아요` });
        if (!state && !isNew) throw new BoardError("projects.json이 없어요", { next: `collab switch ${project} --new --title "<뜻>" --by ${by}` });
        const s = state ?? { target: null, switchedAt: null, switchedBy: null, roles: {}, projects: {} };
        if (isNew && s.projects[project]) throw new BoardError(`프로젝트 ${project}은 이미 있어요`, { next: `collab switch ${project} --by ${by}` });
        if (!isNew && !s.projects[project]) throw new BoardError(`등록되지 않은 프로젝트 ${project}`, { next: `등록된 것: ${names(s)}. 새 프로젝트면 --new --title "<뜻>"을 붙여요` });
        const from = s.target;
        if (from === project) throw new BoardError(`목표가 이미 ${project}예요`, { next: PROJECT_ROLES.includes(by) && roleProject(s, by) !== project ? `collab switch --accept --by ${by}` : "collab project" });
        const at = localIso(now());
        const roles = {};
        for (const r of PROJECT_ROLES) roles[r] = from === null || r === by || config.roles[r] === false ? project : roleProject(s, r);
        if (isNew) s.projects[project] = { title: String(title).trim(), since: at.slice(0, 10) };
        Object.assign(s, { target: project, switchedAt: at, switchedBy: by, roles });
        writeState(s);
        // 전환 기록은 공통에 끝난 메모 하나로 남긴다(첫 등록은 남기지 않는다).
        const record = from === null ? null : appendAdd({ from: by, to: "all", kind: "note", title: `[게시판 전환] ${from} → ${project}`, status: "done", links: [], project: COMMON });
        const items = [...fold(readEvents().events).values()];
        return {
          from, to: project, ...(isNew ? { created: true } : {}),
          open: openCounts(items, [project, COMMON]),
          leftDoing: from === null ? [] : items.filter((i) => i.project === from && i.status === "doing").map((i) => i.id),
          notify: PROJECT_ROLES.filter((r) => r !== by && config.roles[r] !== false),
          ...(record ? { record: record.id } : {}),
        };
      });
    },

    // 한 역할을 목표 프로젝트로 넘긴다(전환 알림을 받은 메인이 턴을 마친 뒤 부른다).
    accept({ by } = {}) {
      if (session.sub) throw SUB_NO_SWITCH();
      by = oneRole(by, PROJECT_ROLES, `collab switch --accept --by <${PROJECT_ROLES.join("|")}>`);
      return withLock(() => {
        const { state } = readState();
        if (!state) throw new BoardError("projects.json이 없거나 깨졌어요", { next: "collab project" });
        const from = roleProject(state, by);
        const items = [...fold(readEvents().events).values()];
        const open = openCounts(items, [state.target, COMMON]);
        if (from === state.target) return { role: by, project: state.target, already: true, open };
        state.roles = Object.fromEntries(PROJECT_ROLES.map((r) => [r, r === by ? state.target : roleProject(state, r)]));
        writeState(state);
        return { role: by, from, to: state.target, open };
      });
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
