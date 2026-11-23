// pane-collab 장부 어긋남(gaps): 게시판·티켓 장부(있을 때)·pane-lead 등록부를 읽어 서로 어긋난 곳을 계산한다.
// 읽기만 한다. 규칙 켜고 끄기, 계보, 주인 별칭은 설정(lib/config.mjs: 기본값 + .loop/collab/config.json)에서 온다.
// 티켓 장부(기본 .loop/tickets, 설정 gaps.tickets)가 없으면 티켓 규칙(G1·G3·G5·G6·G8·G9)은 조용히 건너뛴다.
// scope(프로젝트 이름)가 있으면 그 프로젝트 + common 항목만 본다. 티켓은 그 티켓을 인용한 게시판 항목으로 프로젝트를 정한다:
// 인용 항목이 범위 안에 하나라도 있거나 하나도 없으면 보고, 다른 프로젝트에만 있으면 건너뛴다. 증거 찾기는 전체 항목에서 한다.
//   G1 defect 항목은 열려 있는데 그 티켓은 고쳐졌거나 닫힘          주인: to 중 마지막으로 상태를 바꾼 역할(없으면 to 전부)
//   G2 open·doing 항목이 staleHours 넘게 갱신 없음                  주인: G1과 같음(to가 all·user뿐이면 from)
//   G3 티켓의 남은 일이 "<역할> 몫"으로 글로만 넘어가고 그 역할 앞 항목이 없음  주인: 글에 적힌 역할
//   G4 pane-lead 새 메인에 게시판 handover 알림이 없음              주인: 계보의 역할
//   G5 티켓은 fixed인데 게시판에는 그 티켓의 PASS가 있음(decisions에 PASS 줄 없음)  주인: 티켓 route
//   G6 티켓이 fixed인 채 staleHours 넘게 PASS 기록이 없음           주인: 티켓 route
//   G7 run-request에 run-result가 없음(기본 꺼짐)                   주인: 항목의 to
//   G8 gaps.g8Owners 몫 열린 티켓을 가리키는 게시판 항목이 없음(기본 꺼짐)  주인: 티켓 route
//   G9 열린 티켓인데 decisions.tsv가 비어 있음(기본 꺼짐)            주인: 티켓 route
import fs from "node:fs";
import path from "node:path";
import { makeBoard, OPEN_STATUSES, COMMON, localIso } from "./board.mjs";
import { loadConfig, BOARD_REL } from "./config.mjs";

export { loadConfig };
const T_CLOSED = new Set(["closed", "verified", "gated", "handed-off", "stopped"]);
const H = 3600e3;
const RE_T = /T-\d{6}-\d{2}/g;

// 글 속 줄임 꼴도 편다: "T-261023-14·15·16", "T-261023-07..10", "C-261021-31~33"
export function expandIds(s) {
  return String(s ?? "").replace(/([TC]-\d{6}-)(\d{2})((?:[·,/]\s?\d{2}(?!\d))+|\.\.(\d{2})|~(\d{2}))/g, (m, pre, a, rest, r1, r2) => {
    const end = r1 || r2;
    if (end) {
      const out = [];
      for (let n = +a; n <= +end && out.length < 50; n++) out.push(pre + String(n).padStart(2, "0"));
      return out.join(" ");
    }
    return [a, ...rest.match(/\d{2}/g)].map((n) => pre + n).join(" ");
  });
}
const ticketIdsIn = (s) => [...new Set(expandIds(s).match(RE_T) ?? [])];

export function ownerOf(route, aliases) {
  const token = String(route ?? "").replace(/^"/, "").split(/[:(.·]/)[0].trim();
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  const key = keys.find((k) => token === k || token.startsWith(k + " ") || token.startsWith(k));
  return key ? aliases[key] : "?";
}

// 티켓 장부: <dir>/T-YYMMDD-NN/ticket.md(+ decisions.tsv). 폴더가 없거나 dir이 false면 on: false.
export function readTickets(dir, aliases) {
  const tickets = [];
  let skipped = 0;
  let names = [];
  if (!dir) return { tickets, skipped, on: false };
  try {
    names = fs.readdirSync(dir).filter((d) => /^T-\d{6}-\d{2}$/.test(d)).sort();
  } catch {
    return { tickets, skipped, on: false };
  }
  for (const d of names) {
    try {
      const text = fs.readFileSync(path.join(dir, d, "ticket.md"), "utf8");
      const g = (k) => (text.match(new RegExp(`^${k}:[ \\t]*(.*)$`, "m")) ?? [])[1]?.trim() ?? "";
      const statusRaw = g("status");
      const status = statusRaw.split(/[\s#]/)[0];
      if (!status) throw new Error("no status");
      let decisions = [];
      try {
        decisions = fs.readFileSync(path.join(dir, d, "decisions.tsv"), "utf8").split("\n").filter(Boolean).map((r) => r.split("\t"));
      } catch {}
      const route = g("route");
      tickets.push({
        id: d, status, statusRaw, route, owner: ownerOf(route, aliases),
        title: (text.match(/^# (.*)$/m) ?? [])[1] ?? "",
        received: (g("source").match(/received:\s*([0-9T:+\-]+)/) ?? [])[1] ?? "",
        decisions,
      });
    } catch {
      skipped++;
    }
  }
  return { tickets, skipped, on: true };
}

function readRegistries(root, lineages) {
  const out = [];
  for (const [lineage, role] of Object.entries(lineages)) {
    try {
      const reg = JSON.parse(fs.readFileSync(path.join(root, ".research/pane-lead", lineage, "registry.json"), "utf8"));
      const subs = Array.isArray(reg.subs) ? reg.subs : Object.values(reg.subs ?? {});
      out.push({ lineage, role, mains: [...(reg.mains ?? []), reg.main].filter(Boolean), subs });
    } catch {}
  }
  return out;
}

const textOf = (item) => [item.title, ...(item.links ?? []), ...(item.history ?? []).map((h) => h.note ?? "")].join(" ");
const rolesOf = (s) => String(s ?? "").split(",").map((r) => r.trim()).filter(Boolean);
function receivers(item) {
  const to = rolesOf(item.to).filter((r) => r !== "all" && r !== "user");
  return to.length ? to : rolesOf(item.from);
}
// 받은 역할 가운데 마지막으로 상태를 바꾼 쪽이 주인이다(여럿에게 보낸 항목을 한쪽이 맡은 경우).
function statusOwner(item) {
  const to = receivers(item);
  const last = [...(item.history ?? [])].reverse().find((h) => h.status && h.by && to.includes(h.by));
  return last ? [last.by] : to;
}
const decisionTime = (row) => {
  const m = String(row?.[0] ?? "").match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?:x|:\d{2})?([+-]\d{2}:\d{2})?/);
  return m ? `${m[1]}:00${m[2] ?? "+09:00"}` : "";
};
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// "<이름> 몫"을 찾는 정규식. 이름은 ownerAliases 키(역할·계보·옛 이름 포함)이고, 영문으로 시작하는 이름은 다른 낱말 속에서 잡지 않는다(npm ≠ pm).
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function shareRe(aliases) {
  const keys = Object.keys(aliases).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  return new RegExp(`(${keys.map((k) => (/^[A-Za-z0-9]/.test(k) ? `(?<![A-Za-z0-9_-])${esc(k)}` : esc(k))).join("|")})\\s*몫`);
}

export function computeGaps({ root, boardFile, now = new Date(), config = loadConfig({ root }), scope = null }) {
  const board = makeBoard({ file: boardFile ?? path.join(root, BOARD_REL), config });
  const { events, items: allItems, skipped: skippedLines } = board.snapshot();
  const inScope = (i) => !scope || i.project === scope || i.project === COMMON;
  const items = allItems.filter(inScope);
  const g = config.gaps;
  const ticketDir = g.tickets ? path.resolve(root, g.tickets) : null;
  const { tickets: allTickets, skipped: skippedTickets, on: ticketsOn } = readTickets(ticketDir, config.ownerAliases);
  const registries = readRegistries(root, config.lineages);
  const byId = new Map(allTickets.map((t) => [t.id, t]));
  const stale = g.staleHours * H;
  const on = g.rules;
  const share = shareRe(config.ownerAliases);
  const gaps = [];
  const localSince = (v) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? localIso(d) : ""; };
  const add = (rule, owners, ids, why, since) => gaps.push({ rule, owners: [...new Set(owners)], ids, why, since: localSince(since) });
  const cites = new Map();
  for (const i of allItems) for (const tid of ticketIdsIn(textOf(i))) cites.set(tid, [...(cites.get(tid) ?? []), i]);
  const itemsFor = (tid) => cites.get(tid) ?? [];
  const tickets = scope ? allTickets.filter((t) => !itemsFor(t.id).length || itemsFor(t.id).some(inScope)) : allTickets;
  const passEvent = (list) => {
    let first = "";
    for (const i of list) for (const h of i.history) if (/PASS|통과/.test(h.note ?? "") && (!first || h.at < first)) first = h.at;
    if (!first && list.some((i) => /PASS|통과/.test(i.title))) first = list[0].at;
    return first;
  };

  if (on.G1) for (const i of items) {
    if (i.kind !== "defect" || !OPEN_STATUSES.includes(i.status)) continue;
    for (const tid of ticketIdsIn([i.title, ...i.links].join(" "))) {
      const t = byId.get(tid);
      if (t && (T_CLOSED.has(t.status) || t.status === "fixed")) add("G1", statusOwner(i), [i.id, tid], `게시판 ${i.status} ↔ 티켓 ${t.status}`, i.updated);
    }
  }

  if (on.G2) for (const i of items) {
    if (i.status !== "open" && i.status !== "doing") continue;
    const age = now - new Date(i.updated);
    if (age > stale) add("G2", statusOwner(i), [i.id], `${i.kind} ${i.status} ${Math.round(age / H)}시간 갱신 없음`, i.updated);
  }

  if (on.G3) for (const t of tickets) {
    if (T_CLOSED.has(t.status)) continue;
    const last = t.decisions.at(-1) ?? [];
    const tail = [t.statusRaw, ...last].join(" ");
    const m = share && tail.match(share);
    if (!m) continue;
    const target = config.ownerAliases[m[1]] ?? m[1];
    if (target === t.owner) continue;
    if (itemsFor(t.id).some((i) => rolesOf(i.to).includes(target))) continue;
    add("G3", [target], [t.id], `남은 일이 글로만 ${target} 몫(티켓 주인 ${t.owner})`, decisionTime(last) || t.received);
  }

  if (on.G4 && events.length) {
    const start = new Date(events[0].at);
    for (const r of registries) for (const m of r.mains) {
      if (!m.name || !m.startedAt || new Date(m.startedAt) < start) continue;
      if (!allItems.some((i) => i.kind === "handover" && i.title.includes(m.name))) add("G4", [r.role], [m.name], "새 메인인데 게시판 handover 알림 없음", m.startedAt);
    }
  }

  if (on.G5 || on.G6) for (const t of tickets) {
    if (t.status !== "fixed") continue;
    const rows = t.decisions.some((r) => /재시험|retest/i.test((r[1] ?? "") + (r[2] ?? "")) && /PASS|통과/.test(r.join(" ")));
    const related = itemsFor(t.id).filter((i) => i.kind === "retest-request" || /PASS|통과/.test(textOf(i)));
    const pass = passEvent(related.filter((i) => /PASS|통과/.test(textOf(i))));
    if (on.G5 && pass && !rows) {
      add("G5", [t.owner], [t.id, ...related.map((i) => i.id)], "게시판에는 PASS인데 티켓은 fixed", pass);
    } else if (on.G6 && !pass && !rows) {
      const since = decisionTime(t.decisions.at(-1)) || t.received;
      if (since && now - new Date(since) > stale) add("G6", [t.owner], [t.id], `fixed인데 재시험 PASS 기록 없음 ${Math.round((now - new Date(since)) / H)}시간`, since);
    }
  }

  if (on.G7) for (const i of items) {
    if (i.kind !== "run-request" || i.status === "cancelled") continue;
    const rid = i.links.find((l) => /^R\d+$/.test(l)) ?? (i.title.match(/\bR\d+\b/) ?? [])[0];
    const res = allItems.some((r) => r.kind === "run-result" && (textOf(r).includes(i.id) || (rid && new RegExp(`\\b${rid}\\b`).test(r.title))));
    const self = i.status === "done" && i.history.some((h) => h.status === "done" && h.note);
    if (!res && !self && (i.status === "done" || now - new Date(i.at) > stale)) add("G7", receivers(i), [i.id], "run-request에 run-result가 없음", i.at);
  }

  if (on.G8 || on.G9) for (const t of tickets) {
    if (T_CLOSED.has(t.status)) continue;
    if (on.G8 && g.g8Owners.includes(t.owner) && !itemsFor(t.id).length) add("G8", [t.owner], [t.id], `${t.owner} 몫 열린 티켓을 가리키는 게시판 항목 없음`, t.received);
    if (on.G9 && !t.decisions.length) add("G9", [t.owner], [t.id], "열린 티켓인데 decisions.tsv가 비어 있음", t.received);
  }

  return { at: now, items, tickets, ticketsOn, registries, gaps, skipped: { lines: skippedLines, tickets: skippedTickets } };
}

// 역할 하나에 해당하는 것만 고른다. all은 전부(주인을 모르는 것 포함).
export function forRole(result, role) {
  const mine = (owners) => role === "all" || owners.includes(role);
  const gaps = result.gaps.filter((g) => mine(g.owners)).sort((a, b) => a.rule.localeCompare(b.rule) || String(a.since).localeCompare(String(b.since)));
  const openItems = result.items.filter((i) => OPEN_STATUSES.includes(i.status) && (role === "all" || rolesOf(i.to).some((r) => r === role || r === "all") || rolesOf(i.from).includes(role)));
  const openTickets = result.tickets.filter((t) => !T_CLOSED.has(t.status) && (role === "all" || t.owner === role));
  const subs = result.registries.filter((r) => role === "all" || r.role === role).flatMap((r) => r.subs.filter((s) => s.status !== "closed").map((s) => ({ ...s, lineage: r.lineage })));
  return { gaps, openItems, openTickets, subs, ticketsOn: result.ticketsOn !== false };
}

export function counts(view, skipped) {
  const byRule = {};
  for (const g of view.gaps) byRule[g.rule] = (byRule[g.rule] ?? 0) + 1;
  return { gaps: view.gaps.length, byRule, openItems: view.openItems.length, ...(view.ticketsOn ? { openTickets: view.openTickets.length } : {}), subs: view.subs.length, ...(skipped.lines || skipped.tickets ? { skipped } : {}) };
}

export const gapLine = (g) => `${g.rule} ${g.ids.join(" ")}: ${g.why}`;

// 쌓임 한 줄: 숫자만. 순서·재촉은 없다. 티켓 장부가 없으면 티켓 부분을 뺀다.
export function backlog(view, now) {
  const board = `게시판 열린 항목 ${view.openItems.length} · 끝나지 않은 서브 ${view.subs.length}`;
  if (view.ticketsOn === false) return board;
  const old = view.openTickets.filter((t) => t.received && now - new Date(t.received) > 48 * H).length;
  return `열린 티켓 ${view.openTickets.length} · 2일 넘음 ${old} · ${board}`;
}

// add·update 뒤: 방금 쓴 항목과 그 links·글로 이어진 ID에 걸린 어긋남만. 역할은 가리지 않는다.
export function relatedGaps(result, { id, links = [], text = "" }) {
  const ids = new Set([id, ...(expandIds([...links, text].join(" ")).match(/[CT]-\d{6}-\d{2}/g) ?? [])]);
  return result.gaps.filter((g) => g.ids.some((x) => ids.has(x)));
}

const age = (iso, now) => {
  const h = (now - new Date(iso)) / H;
  return Number.isFinite(h) ? (h >= 48 ? `${Math.round(h / 24)}일` : `${Math.max(0, Math.round(h))}시간`) : "?";
};

export function toMarkdown(view, { role, now, maxLines = 40, head = [] }) {
  if (head.length) return [...head, "", toMarkdown(view, { role, now, maxLines })].join("\n");
  const sections = [];
  sections.push(["### 쌓임", `- ${backlog(view, now)}`]);
  sections.push([`### 장부 어긋남 (${view.gaps.length})`, ...(view.gaps.length ? view.gaps.map((g) => `- ${gapLine(g)} · ${String(g.since).slice(5, 16)}부터`) : ["- 없음"])]);
  sections.push([`### 열린 게시판 항목 (${view.openItems.length})`, ...(view.openItems.length ? view.openItems.map((i) => `- ${i.id} ${i.kind} ${i.status} · ${i.from}→${i.to} · ${age(i.updated, now)} 전 갱신 · ${short(i.title, 60)}`) : ["- 없음"])]);
  if (view.ticketsOn !== false) sections.push([`### 열린 티켓${role === "all" ? "" : ` (주인 ${role})`} (${view.openTickets.length})`, ...(view.openTickets.length ? view.openTickets.map((t) => `- ${t.id} ${t.status}${role === "all" ? ` · ${t.owner}` : ""} · ${t.received ? age(t.received, now) : "?"} · ${short(t.title, 60)}`) : ["- 없음"])]);
  sections.push([`### 끝나지 않은 서브 (${view.subs.length})`, ...(view.subs.length ? view.subs.map((s) => `- ${s.name} ${s.status} · ${s.lineage} ${s.pane ?? ""} · ${s.startedAt ? age(s.startedAt, now) + " 전 시작" : ""}`) : ["- 없음"])]);
  const lines = [];
  let total = 0;
  for (const s of sections) total += s.length + (total ? 1 : 0);
  if (total <= maxLines) {
    for (const s of sections) lines.push(...(lines.length ? ["", ...s] : s));
    return lines.join("\n");
  }
  // 넘치면 앞에서부터 채우고 마지막 줄에 남은 수를 적는다. 소제목은 지키고 항목을 자른다.
  const budget = maxLines - 1;
  let shown = 0;
  let hidden = 0;
  for (const s of sections) {
    const head = lines.length ? ["", s[0]] : [s[0]];
    const real = s.slice(1).filter((l) => l !== "- 없음");
    if (lines.length + head.length > budget) { hidden += real.length; continue; }
    lines.push(...head);
    for (const l of s.slice(1)) {
      if (lines.length < budget) { lines.push(l); shown++; } else if (l !== "- 없음") hidden++;
    }
  }
  lines.push(`외 ${hidden}개 — \`collab gaps --to ${role}\``);
  return lines.join("\n");
}
