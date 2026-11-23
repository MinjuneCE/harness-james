import { citedNumbers, docCitations, parseDocHeader } from "./parse.mjs";

const REQUIRED_DOCS = ["spec.md", "plan.md"];
const TABLE_NOTE = "<!-- decision-check --sync-table이 기록에서 만든 표다. 손으로 고치지 않는다. -->";
const label = (numbers) => numbers.map((n) => `D${n}`).join(", ");

export function summarize(ledger) {
  const byNumber = new Map();
  const duplicates = [];
  for (const d of ledger.decisions) {
    if (byNumber.has(d.n)) duplicates.push(d);
    else byNumber.set(d.n, d);
  }
  const supersededBy = new Map();
  for (const d of ledger.decisions) {
    for (const old of d.supersedes) supersededBy.set(old, [...(supersededBy.get(old) || []), d.n]);
  }
  const prior = ledger.prior;
  const latest = Math.max(prior ? prior.to : 0, ...byNumber.keys());
  const known = (n) => byNumber.has(n) || Boolean(prior && n >= prior.from && n <= prior.to);
  const valid = [...byNumber.values()].filter((d) => !supersededBy.has(d.n)).sort((a, b) => b.n - a.n);
  const resolved = new Set(ledger.decisions.flatMap((d) => d.resolves));
  const openProposals = ledger.proposals.filter((p) => !resolved.has(p.n));
  return { byNumber, duplicates, supersededBy, prior, latest, known, valid, openProposals };
}

export function renderTable(summary) {
  const cell = (s) => s.replace(/\|/g, "\\|");
  return [
    "",
    TABLE_NOTE,
    "",
    "| 번호 | 결정 | 반영 |",
    "|---|---|---|",
    ...summary.valid.map((d) => `| D${d.n} | ${cell(d.text)} | ${cell(d.reflects.join(", "))} |`),
    "",
  ];
}

export function syncTable(text, ledger) {
  if (!ledger.table) return null;
  const lines = text.split(/\r?\n/);
  const { start, end } = ledger.table;
  return [...lines.slice(0, start + 1), ...renderTable(summarize(ledger)), ...lines.slice(end)].join("\n");
}

function ledgerItems(ledger, s) {
  const items = [];
  const superseded = s.supersededBy.size;
  const scope = [`결정 ${s.byNumber.size}건`, `최신 D${s.latest}`, `대체됨 ${superseded}건`];
  if (s.prior) scope.push(`이전 기록 D${s.prior.from}~D${s.prior.to}`);
  if (s.duplicates.length) {
    items.push({
      level: "FAIL", id: "ledger", target: "", summary: `같은 번호가 두 번 나온다: ${label(s.duplicates.map((d) => d.n))}`,
      details: s.duplicates.map((d) => `${d.line}줄 D${d.n}: 먼저 나온 항목은 ${s.byNumber.get(d.n).line}줄`),
    });
  } else {
    items.push({ level: "PASS", id: "ledger", target: "", summary: scope.join(", "), details: [] });
  }

  const badRefs = [];
  for (const d of ledger.decisions) {
    for (const old of [...d.supersedes, ...d.partial]) {
      if (!s.known(old)) badRefs.push(`${d.line}줄 D${d.n}: 대체 대상 D${old}가 기록에 없다`);
      else if (old >= d.n) badRefs.push(`${d.line}줄 D${d.n}: 대체 대상 D${old}가 자신보다 앞선 번호가 아니다`);
    }
  }
  if (badRefs.length) items.push({ level: "WARN", id: "supersede-ref", target: "", summary: `대체 대상을 찾지 못한 줄 ${badRefs.length}개`, details: badRefs });

  if (!ledger.table) {
    if (ledger.decisions.length) items.push({ level: "WARN", id: "table", target: "", summary: "'지금 유효한 결정' 절이 없다", details: ["양식의 `## 지금 유효한 결정` 제목을 넣은 뒤 --sync-table"] });
  } else {
    const inTable = new Set(ledger.tableRows.map((r) => r.n));
    const validNumbers = new Set(s.valid.map((d) => d.n));
    const missing = [...validNumbers].filter((n) => !inTable.has(n)).sort((a, b) => a - b);
    const extra = [...inTable].filter((n) => !validNumbers.has(n)).sort((a, b) => a - b);
    if (missing.length || extra.length) {
      const details = [];
      if (missing.length) details.push(`표에 없는 유효 결정: ${label(missing)}`);
      if (extra.length) details.push(`표에 남은 대체됨·없는 번호: ${label(extra)}`);
      items.push({ level: "WARN", id: "table", target: "", summary: "'지금 유효한 결정' 표가 기록과 다르다 (--sync-table로 다시 만든다)", details });
    }
  }

  if (s.openProposals.length) {
    items.push({
      level: "INFO", id: "proposal", target: "", summary: `사용자 답을 기다리는 제안 ${s.openProposals.length}건`,
      details: s.openProposals.map((p) => `P${p.n} (${p.line}줄) ${p.text}`),
    });
  }
  return items;
}

function docItems(doc, ledger, s, required) {
  const header = parseDocHeader(doc.text);
  if (!header) {
    if (!required.includes(doc.name)) return { items: [], header: null };
    return { items: [{ level: "WARN", id: "header", target: doc.name, summary: "'반영한 결정' 머리 줄이 없다", details: ["문서 앞쪽에 `**반영한 결정**: ~D<번호>` 한 줄을 둔다(아직 없으면 `없음`)"] }], header: null };
  }
  if (header.n === null) {
    return { items: [{ level: "WARN", id: "header", target: doc.name, summary: `머리 줄(${header.line}줄)에서 결정 번호를 읽지 못했다`, details: [] }], header: null };
  }
  const items = [];
  if (header.n > s.latest) {
    items.push({ level: "FAIL", id: "header", target: doc.name, summary: `D${header.n}까지 반영했다고 적혀 있지만 기록의 최신은 D${s.latest}다`, details: [] });
  } else if (header.n < s.latest) {
    const mine = ledger.decisions.filter((d) => d.n > header.n && d.reflects.includes(doc.name) && !s.supersededBy.has(d.n)).map((d) => d.n).sort((a, b) => a - b);
    const details = mine.length ? [`이 문서를 반영 위치로 적은 결정: ${label(mine)}`] : [];
    items.push({ level: "WARN", id: "header", target: doc.name, summary: `D${header.n}까지 반영, 최신 D${s.latest} (${s.latest - header.n}건 뒤)`, details });
  } else {
    items.push({ level: "PASS", id: "header", target: doc.name, summary: `D${header.n}까지 반영(최신)`, details: [] });
  }

  const cites = docCitations(doc.text, header.line);
  const stale = [];
  const unknown = new Set();
  for (const c of cites) {
    for (const n of c.singles) {
      if (!s.known(n)) {
        unknown.add(n);
        continue;
      }
      const by = (s.supersededBy.get(n) || []).filter((r) => r <= header.n);
      if (by.length && !by.some((r) => c.singles.includes(r))) stale.push(`${doc.name}:${c.line} D${n} (대체한 결정: ${label(by)})`);
    }
  }
  if (stale.length) items.push({ level: "WARN", id: "stale-cite", target: doc.name, summary: `대체된 결정을 가리키는 줄 ${stale.length}개`, details: stale });
  if (unknown.size) items.push({ level: "WARN", id: "unknown-cite", target: doc.name, summary: `기록에 없는 번호를 가리킨다: ${label([...unknown].sort((a, b) => a - b))}`, details: [] });
  return { items, header };
}

export function evaluate(ledger, docs, { required = REQUIRED_DOCS, existing } = {}) {
  const s = summarize(ledger);
  const items = ledgerItems(ledger, s);
  const present = existing || new Set(docs.map((d) => d.name));
  const headers = new Map();
  const cited = new Map();
  for (const doc of docs) {
    const result = docItems(doc, ledger, s, required);
    items.push(...result.items);
    headers.set(doc.name, result.header);
    const all = new Set();
    for (const c of docCitations(doc.text, result.header ? result.header.line : undefined)) for (const n of citedNumbers(c)) all.add(n);
    cited.set(doc.name, all);
  }

  const missingFiles = [];
  const uncited = new Map();
  for (const d of s.valid) {
    for (const file of d.reflects) {
      if (!present.has(file)) {
        missingFiles.push(`D${d.n} (${d.line}줄): 폴더에 없는 반영 위치 ${file}`);
        continue;
      }
      if (!cited.has(file)) continue;
      const header = headers.get(file);
      if (header && d.n > header.n) continue;
      if (!cited.get(file).has(d.n)) uncited.set(file, [...(uncited.get(file) || []), d.n]);
    }
  }
  if (missingFiles.length) items.push({ level: "WARN", id: "reflect", target: "", summary: `반영 위치로 적은 파일이 없다 ${missingFiles.length}건`, details: missingFiles });
  for (const [file, numbers] of uncited) {
    items.push({ level: "WARN", id: "reflect", target: file, summary: `반영 위치로 적혔지만 문서에 번호 인용이 없다: ${label(numbers.sort((a, b) => a - b))}`, details: [] });
  }
  return { items, summary: s };
}
