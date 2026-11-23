const FENCE = /^\s*(```|~~~)/;
const BEFORE = "(?<![A-Za-z0-9_])";
const AFTER = "(?![A-Za-z0-9_])";
const RANGE = new RegExp(`${BEFORE}D(\\d{1,4})(?:\\s*[~∼–—]\\s*|-)D(\\d{1,4})${AFTER}`, "g");
const SINGLE = new RegExp(`${BEFORE}D(\\d{1,4})${AFTER}`, "g");
const OTHER_NUMBERING = /회의록\s*$/;
const MAX_RANGE = 500;
const TOP_BULLET = new RegExp(`^[-*]\\s+\\**([DP])(\\d{1,4})\\**${AFTER}[\\s.:：—-]*(.*)$`);
const SUB_BULLET = /^\s+[-*]\s+\**(일부 대체|대체|반영|제안)\**\s*[:：]\**\s*(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const TABLE_TITLE = /유효한 결정/;
const TABLE_ROW = /^\|\s*\**D(\d{1,4})\**\s*\|/;
const PRIOR = /^이전 기록\s*[:：](.*)$/;
const DOC_HEADER = /반영한 결정\**\s*[:：]\**\s*(.*)$/;
const FILE_REF = /[A-Za-z0-9_.\/-]+\.(?:md|ya?ml|json|graphql|sql|mjs)(?![A-Za-z0-9_])/g;
const DOC_HEADER_WITHIN = 40;

export function maskNonProse(text) {
  let inFence = false;
  let inComment = false;
  return text.split(/\r?\n/).map((line) => {
    if (inFence) {
      if (FENCE.test(line)) inFence = false;
      return "";
    }
    if (!inComment && FENCE.test(line)) {
      inFence = true;
      return "";
    }
    let kept = "";
    let rest = line;
    while (rest.length) {
      const at = rest.indexOf(inComment ? "-->" : "<!--");
      if (at < 0) {
        if (!inComment) kept += rest;
        break;
      }
      if (!inComment) kept += rest.slice(0, at);
      rest = rest.slice(at + (inComment ? 3 : 4));
      inComment = !inComment;
    }
    return kept;
  });
}

export function citations(line) {
  const ranges = [];
  const rest = line.replace(RANGE, (whole, a, b) => {
    const from = Number(a);
    const to = Number(b);
    if (to >= from && to - from <= MAX_RANGE) ranges.push([from, to]);
    return " ".repeat(whole.length);
  });
  const singles = [];
  for (const m of rest.matchAll(SINGLE)) {
    if (OTHER_NUMBERING.test(rest.slice(0, m.index))) continue;
    singles.push(Number(m[1]));
  }
  return { singles, ranges };
}

export function citedNumbers({ singles, ranges }) {
  const all = new Set(singles);
  for (const [from, to] of ranges) for (let n = from; n <= to; n++) all.add(n);
  return all;
}

export function parseLedger(text) {
  const lines = maskNonProse(text);
  const ledger = { decisions: [], proposals: [], tableRows: [], table: null, prior: null };
  let inTable = false;
  let session = null;
  let entry = null;
  lines.forEach((line, i) => {
    const heading = HEADING.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (level <= 2) {
        if (ledger.table && ledger.table.end === null) ledger.table.end = i;
        inTable = level === 2 && TABLE_TITLE.test(heading[2]);
        if (inTable && !ledger.table) ledger.table = { start: i, end: null };
        session = null;
      } else {
        session = heading[2].trim();
      }
      entry = null;
      return;
    }
    const prior = PRIOR.exec(line);
    if (prior && !ledger.prior) {
      const cited = citations(prior[1]);
      if (cited.ranges.length) ledger.prior = { from: cited.ranges[0][0], to: cited.ranges[0][1] };
      else if (cited.singles.length) ledger.prior = { from: 1, to: Math.max(...cited.singles) };
      return;
    }
    if (inTable) {
      const row = TABLE_ROW.exec(line);
      if (row) ledger.tableRows.push({ n: Number(row[1]), line: i + 1 });
      return;
    }
    const top = TOP_BULLET.exec(line);
    if (top) {
      const base = { n: Number(top[2]), line: i + 1, session, text: top[3].trim() };
      if (top[1] === "D") {
        entry = { ...base, supersedes: [], partial: [], reflects: [], resolves: [] };
        ledger.decisions.push(entry);
      } else {
        entry = null;
        ledger.proposals.push(base);
      }
      return;
    }
    if (/^\S/.test(line)) {
      entry = null;
      return;
    }
    const sub = entry && SUB_BULLET.exec(line);
    if (!sub) return;
    const [, label, value] = sub;
    if (label === "대체") entry.supersedes.push(...citedNumbers(citations(value)));
    else if (label === "일부 대체") entry.partial.push(...citedNumbers(citations(value)));
    else if (label === "반영") entry.reflects.push(...(value.match(FILE_REF) || []));
    else entry.resolves.push(...[...value.matchAll(/(?<![A-Za-z0-9_])P(\d{1,4})(?![A-Za-z0-9_])/g)].map((m) => Number(m[1])));
  });
  if (ledger.table && ledger.table.end === null) ledger.table.end = lines.length;
  return ledger;
}

export function parseDocHeader(text) {
  const lines = maskNonProse(text);
  for (let i = 0; i < Math.min(lines.length, DOC_HEADER_WITHIN); i++) {
    const m = DOC_HEADER.exec(lines[i]);
    if (!m) continue;
    const cited = citations(m[1]);
    if (cited.singles.length) return { n: cited.singles[0], line: i + 1 };
    if (/없음/.test(m[1])) return { n: 0, line: i + 1 };
    return { n: null, line: i + 1 };
  }
  return null;
}

export function docCitations(text, skipLine) {
  const found = [];
  maskNonProse(text).forEach((line, i) => {
    if (i + 1 === skipLine) return;
    const cited = citations(line);
    if (cited.singles.length || cited.ranges.length) found.push({ line: i + 1, ...cited });
  });
  return found;
}
