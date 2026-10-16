// frontmatter용 YAML 부분 집합 파서 (의존성 없음).
// 지원: 최상위 key: value, 따옴표 문자열과 이스케이프, 블록 스칼라(| > 와 -/+),
// flow 시퀀스/맵, 블록 시퀀스, 중첩 맵, 주석, 중복 키 감지.
// 앵커·별칭·태그·복합 키는 지원하지 않는다. parseYaml은 이런 값을 만나면 실패하고,
// parseFrontmatterYaml은 아래 재시도에서 최상위 값이면 따옴표를 씌워 문자열로 읽는다.
//
// Claude Code 2.1.301은 첫 파싱이 실패하면 특수 문자가 든 값에 따옴표를 씌워 다시 파싱한다.
// (`description: x: y`, `[a, b` 같은 값이 validate를 통과하는 이유.) parseFrontmatterYaml이 같은 재시도를 한다.

export class YamlError extends Error {
  constructor(message, line) {
    super(message);
    this.line = line;
  }
}

const NULLS = new Set(['', '~', 'null', 'Null', 'NULL']);

function resolvePlain(s) {
  if (NULLS.has(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?(0|[1-9][0-9]*)$/.test(s)) return Number(s);
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  return s;
}

const DQ_ESC = {
  '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r',
  e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: String.fromCharCode(0x85), _: String.fromCharCode(0xa0), L: String.fromCharCode(0x2028), P: String.fromCharCode(0x2029),
};

function decodeDouble(body, line) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== '\\') { out += c; continue; }
    const n = body[++i];
    if (n === undefined) throw new YamlError('따옴표 안의 역슬래시가 끝에 있어요', line);
    if (n in DQ_ESC) { out += DQ_ESC[n]; continue; }
    if (n === '\n') { // 줄 이어짐
      while (body[i + 1] === ' ' || body[i + 1] === '\t') i++;
      continue;
    }
    const hexLen = n === 'x' ? 2 : n === 'u' ? 4 : n === 'U' ? 8 : 0;
    if (hexLen) {
      const hex = body.slice(i + 1, i + 1 + hexLen);
      if (!new RegExp(`^[0-9a-fA-F]{${hexLen}}$`).test(hex)) throw new YamlError('잘못된 16진 이스케이프예요', line);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += hexLen;
      continue;
    }
    throw new YamlError(`알 수 없는 이스케이프 \\${n}`, line);
  }
  return out;
}

// 여러 줄에 걸친 따옴표 문자열의 줄바꿈 접기(빈 줄은 \n, 나머지는 공백).
function foldQuotedLines(raw) {
  const parts = raw.split('\n');
  if (parts.length === 1) return raw;
  let out = parts[0].replace(/[ \t]+$/, '');
  let pendingNewlines = 0;
  for (let k = 1; k < parts.length; k++) {
    const p = k === parts.length - 1 ? parts[k].replace(/^[ \t]+/, '') : parts[k].trim();
    if (p === '' && k !== parts.length - 1) { pendingNewlines++; continue; }
    out += pendingNewlines ? '\n'.repeat(pendingNewlines) : ' ';
    pendingNewlines = 0;
    out += p;
  }
  return out;
}

function isBlankOrComment(l) {
  return /^\s*(#.*)?$/.test(l);
}

function indentOf(l) {
  const m = /^( *)/.exec(l);
  return m[1].length;
}

function stripComment(s) {
  // 따옴표 밖의 ' #' 이후를 버린다(plain 스칼라용).
  const m = /(^|[ \t])#/.exec(s);
  return (m ? s.slice(0, m.index) : s).replace(/[ \t]+$/, '');
}

const PLAIN_BAD_START = /^[-?:,\[\]{}#&*!|>'"%@`]/;

function checkPlain(s, line) {
  if (s === '') return;
  if (PLAIN_BAD_START.test(s) && !/^[-?:][^\s,\[\]{}]/.test(s)) {
    throw new YamlError(`plain 값이 특수 문자 ${s[0]}로 시작해요`, line);
  }
  if (/^[&*!]/.test(s)) throw new YamlError('앵커·별칭·태그는 지원하지 않아요', line);
  if (/:(\s|$)/.test(s)) throw new YamlError('값 안에 ": "가 있어요', line);
}

class Parser {
  constructor(text) {
    if (/\t/.test(text.split('\n').map((l) => l.match(/^\s*/)[0]).join(''))) {
      // 들여쓰기에 탭이 있으면 YAML 오류
      const idx = text.split('\n').findIndex((l) => /^\s*\t/.test(l) && !isBlankOrComment(l));
      if (idx >= 0) throw new YamlError('들여쓰기에 탭이 있어요', idx + 1);
    }
    this.lines = text.split('\n');
    this.i = 0;
    this.dups = [];
    this.keyLines = {};
  }

  skip() {
    while (this.i < this.lines.length && isBlankOrComment(this.lines[this.i])) this.i++;
  }

  parseDocument() {
    this.skip();
    if (this.i >= this.lines.length) return {};
    const ind = indentOf(this.lines[this.i]);
    const v = this.parseNode(ind, true);
    this.skip();
    if (this.i < this.lines.length) throw new YamlError('들여쓰기가 맞지 않아요', this.i + 1);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new YamlError('frontmatter 최상위가 맵이 아니에요', 1);
    }
    return v;
  }

  parseNode(ind, top = false) {
    const l = this.lines[this.i];
    const t = l.slice(ind);
    if (t === '-' || t.startsWith('- ')) return this.parseSeq(ind);
    return this.parseMap(ind, top);
  }

  parseSeq(ind) {
    const arr = [];
    for (;;) {
      this.skip();
      if (this.i >= this.lines.length) break;
      const l = this.lines[this.i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) throw new YamlError('시퀀스 들여쓰기가 맞지 않아요', this.i + 1);
      const t = l.slice(ind);
      if (!(t === '-' || t.startsWith('- '))) break;
      const rest = t.slice(1).replace(/^ +/, '');
      const restInd = ind + (t.length - t.slice(1).replace(/^ +/, '').length);
      if (rest === '' || rest.startsWith('#')) {
        this.i++;
        arr.push(this.parseChild(ind));
      } else if (/^[^'"\[{#][^:]*:(\s|$)/.test(rest) || /^(["']).*\1:(\s|$)/.test(rest)) {
        // "- key: v" → 들여쓴 맵으로 다시 읽는다
        this.lines[this.i] = ' '.repeat(restInd) + rest;
        arr.push(this.parseMap(restInd, false));
      } else {
        arr.push(this.parseInlineValue(rest, ind, restInd));
      }
    }
    return arr;
  }

  // "key:" 다음 줄의 자식 노드(없으면 null).
  parseChild(ind, allowSameIndentSeq = false) {
    this.skip();
    if (this.i >= this.lines.length) return null;
    const l = this.lines[this.i];
    const li = indentOf(l);
    const t = l.slice(li);
    if (li > ind) return this.parseNode(li);
    if (allowSameIndentSeq && li === ind && (t === '-' || t.startsWith('- '))) return this.parseSeq(li);
    return null;
  }

  parseMap(ind, top) {
    const obj = {};
    for (;;) {
      this.skip();
      if (this.i >= this.lines.length) break;
      const l = this.lines[this.i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) throw new YamlError('맵 들여쓰기가 맞지 않아요', this.i + 1);
      const t = l.slice(ind);
      if (t === '-' || t.startsWith('- ')) break;
      const lineNo = this.i + 1;
      let key;
      let rest;
      let m;
      if ((m = /^"((?:[^"\\]|\\.)*)"\s*:(?:\s+|$)(.*)$/.exec(t))) {
        key = decodeDouble(m[1], lineNo);
        rest = m[2];
      } else if ((m = /^'((?:[^']|'')*)'\s*:(?:\s+|$)(.*)$/.exec(t))) {
        key = m[1].replace(/''/g, "'");
        rest = m[2];
      } else if ((m = /^([^\s#'"?\[\]{},&*!|>%@`][^:#]*?|[^\s#'"?\[\]{},&*!|>%@`])\s*:(?:\s+|$)(.*)$/.exec(t))) {
        key = m[1].trim();
        rest = m[2];
      } else {
        throw new YamlError(`키: 값 꼴이 아니에요: ${t.slice(0, 40)}`, lineNo);
      }
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        this.dups.push({ key, line: lineNo, top });
      }
      if (top) this.keyLines[key] = lineNo;
      const valInd = ind + (t.length - rest.length);
      if (rest === '' || rest.startsWith('#')) {
        this.i++;
        obj[key] = this.parseChild(ind, true);
      } else {
        obj[key] = this.parseInlineValue(rest, ind, valInd);
      }
    }
    return obj;
  }

  // 한 줄에서 시작하는 값. this.i는 그 줄을 가리킨다. 끝나면 다음 줄로 옮긴다.
  parseInlineValue(rest, ownerInd, valInd) {
    const lineNo = this.i + 1;
    const c = rest[0];
    if (c === '|' || c === '>') return this.parseBlockScalar(rest, ownerInd);
    if (c === '"' || c === "'") return this.parseQuoted(rest, ownerInd, valInd);
    if (c === '[' || c === '{') return this.parseFlowFromLines(rest, ownerInd);
    // plain (여러 줄 이어짐 가능)
    let s = stripComment(rest);
    checkPlain(s, lineNo);
    const hadComment = s.length !== rest.replace(/[ \t]+$/, '').length;
    this.i++;
    if (!hadComment) {
      const more = [];
      while (this.i < this.lines.length) {
        const l = this.lines[this.i];
        if (l.trim() === '') { more.push(''); this.i++; continue; }
        if (indentOf(l) <= ownerInd) break;
        const tt = l.trim();
        if (tt.startsWith('#')) break;
        if (/:(\s|$)/.test(stripComment(tt))) throw new YamlError('값 안에 ": "가 있어요', this.i + 1);
        more.push(stripComment(tt));
        this.i++;
        if (stripComment(tt) !== tt) break;
      }
      while (more.length && more[more.length - 1] === '') { more.pop(); }
      if (more.length) {
        // 빈 줄을 되돌려 놓을 필요는 없다(다음 키 탐색은 skip()이 한다)
        let out = s;
        let nl = 0;
        for (const p of more) {
          if (p === '') { nl++; continue; }
          out += nl ? '\n'.repeat(nl) : ' ';
          nl = 0;
          out += p;
        }
        s = out;
      }
    }
    return resolvePlain(s);
  }

  parseQuoted(rest, ownerInd, valInd) {
    const q = rest[0];
    const startLine = this.i + 1;
    let buf = rest.slice(1);
    let lineIdx = this.i;
    for (;;) {
      const end = q === '"' ? findDqEnd(buf) : findSqEnd(buf);
      if (end >= 0) {
        const body = buf.slice(0, end);
        const after = buf.slice(end + 1);
        if (!/^\s*(#.*)?$/.test(after)) throw new YamlError('따옴표 뒤에 다른 글자가 있어요', lineIdx + 1);
        this.i = lineIdx + 1;
        const folded = foldQuotedLines(body);
        return q === '"' ? decodeDouble(folded, startLine) : folded.replace(/''/g, "'");
      }
      lineIdx++;
      if (lineIdx >= this.lines.length) throw new YamlError('따옴표가 닫히지 않았어요', startLine);
      const nl = this.lines[lineIdx];
      if (nl.trim() !== '' && indentOf(nl) <= ownerInd) throw new YamlError('따옴표가 닫히지 않았어요', startLine);
      buf += '\n' + nl;
    }
  }

  parseBlockScalar(rest, ownerInd) {
    const lineNo = this.i + 1;
    const m = /^([|>])([1-9]?)([-+]?)([1-9]?)\s*(#.*)?$/.exec(rest);
    if (!m) throw new YamlError('블록 스칼라 표시가 잘못됐어요', lineNo);
    const style = m[1];
    const explicit = Number(m[2] || m[4] || 0);
    const chomp = m[3];
    this.i++;
    const raw = [];
    let blockInd = explicit ? ownerInd + explicit : 0;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i];
      if (l.trim() === '') { raw.push(''); this.i++; continue; }
      const li = indentOf(l);
      if (!blockInd) {
        if (li <= ownerInd) break;
        blockInd = li;
      }
      if (li < blockInd) break;
      raw.push(l.slice(blockInd));
      this.i++;
    }
    // 끝의 빈 줄 처리
    let trailing = 0;
    while (raw.length && raw[raw.length - 1] === '') { raw.pop(); trailing++; }
    let text;
    if (style === '|') {
      text = raw.join('\n');
    } else {
      text = '';
      let prevMore = false;
      for (let k = 0; k < raw.length; k++) {
        const p = raw[k];
        const more = /^[ \t]/.test(p);
        if (k === 0) { text = p; prevMore = more; continue; }
        if (p === '') { text += '\n'; continue; }
        const prev = raw[k - 1];
        if (prev === '' || more || prevMore) text += prev === '' ? '' : '\n';
        else text += ' ';
        text += p;
        prevMore = more;
      }
    }
    if (raw.length === 0) return chomp === '+' ? '\n'.repeat(trailing) : '';
    if (chomp === '-') return text;
    if (chomp === '+') return text + '\n' + '\n'.repeat(trailing);
    return text + '\n';
  }

  parseFlowFromLines(rest, ownerInd) {
    const startLine = this.i + 1;
    let buf = rest;
    let lineIdx = this.i;
    for (;;) {
      const r = tryFlow(buf, startLine);
      if (r.done) {
        if (!/^\s*(#.*)?$/.test(r.after)) throw new YamlError('flow 값 뒤에 다른 글자가 있어요', lineIdx + 1);
        this.i = lineIdx + 1;
        return r.value;
      }
      lineIdx++;
      if (lineIdx >= this.lines.length) throw new YamlError('괄호가 닫히지 않았어요', startLine);
      const nl = this.lines[lineIdx];
      if (nl.trim() !== '' && indentOf(nl) <= ownerInd) throw new YamlError('괄호가 닫히지 않았어요', startLine);
      buf += '\n' + nl;
    }
  }
}

function findDqEnd(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return -1;
}

function findSqEnd(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i++; continue; }
      return i;
    }
  }
  return -1;
}

// flow 컬렉션 파싱. 닫히지 않았으면 {done:false}.
function tryFlow(src, line) {
  let p = 0;
  const ws = () => {
    for (;;) {
      while (p < src.length && /\s/.test(src[p])) p++;
      if (src[p] === '#' && (p === 0 || /\s/.test(src[p - 1]))) {
        while (p < src.length && src[p] !== '\n') p++;
        continue;
      }
      break;
    }
  };
  const INCOMPLETE = Symbol('incomplete');
  function scalar(inMap) {
    ws();
    if (p >= src.length) throw INCOMPLETE;
    const c = src[p];
    if (c === '[' || c === '{') return node();
    if (c === '"') {
      const end = findDqEnd(src.slice(p + 1));
      if (end < 0) throw INCOMPLETE;
      const body = src.slice(p + 1, p + 1 + end);
      p += end + 2;
      return decodeDouble(foldQuotedLines(body), line);
    }
    if (c === "'") {
      const end = findSqEnd(src.slice(p + 1));
      if (end < 0) throw INCOMPLETE;
      const body = src.slice(p + 1, p + 1 + end);
      p += end + 2;
      return foldQuotedLines(body).replace(/''/g, "'");
    }
    if (/[&*!|>%@`]/.test(c)) throw new YamlError('flow 값이 특수 문자로 시작해요', line);
    let s = '';
    while (p < src.length) {
      const ch = src[p];
      if (ch === ',' || ch === ']' || ch === '}' || ch === '[' || ch === '{') break;
      if (ch === ':' && (inMap || true) && (p + 1 >= src.length || /[\s,\]\}]/.test(src[p + 1]))) break;
      if (ch === '#' && /\s/.test(src[p - 1] || '')) break;
      s += ch;
      p++;
    }
    return resolvePlain(s.replace(/\s+/g, ' ').trim());
  }
  function node() {
    const open = src[p];
    const close = open === '[' ? ']' : '}';
    p++;
    const isSeq = open === '[';
    const out = isSeq ? [] : {};
    for (;;) {
      ws();
      if (p >= src.length) throw INCOMPLETE;
      if (src[p] === close) { p++; return out; }
      const k = scalar(!isSeq);
      ws();
      if (p >= src.length) throw INCOMPLETE;
      if (src[p] === ':') {
        p++;
        ws();
        let v = null;
        if (src[p] !== ',' && src[p] !== close) v = scalar(true);
        if (isSeq) out.push({ [String(k)]: v });
        else out[String(k)] = v;
      } else if (isSeq) {
        out.push(k);
      } else {
        out[String(k)] = null;
      }
      ws();
      if (p >= src.length) throw INCOMPLETE;
      if (src[p] === ',') { p++; continue; }
      if (src[p] === close) { p++; return out; }
      throw new YamlError('flow 컬렉션 구분자가 잘못됐어요', line);
    }
  }
  try {
    const value = node();
    return { done: true, value, after: src.slice(p) };
  } catch (e) {
    if (e === INCOMPLETE) return { done: false };
    throw e;
  }
}

export function parseYaml(text) {
  const p = new Parser(text);
  const data = p.parseDocument();
  return { data, dups: p.dups, keyLines: p.keyLines };
}

// Claude Code의 재시도와 같은 꼴: 최상위 `key: value`에서 따옴표로 시작하지 않고
// 특수 문자가 든 값을 큰따옴표로 감싼다.
const RETRY_SPECIAL = /[{}\[\]*&#!|>%@`]|: /;

export function quoteProblematicValues(text) {
  return text
    .split('\n')
    .map((l) => {
      const m = /^([A-Za-z0-9_-]+):[ \t]+(.+?)[ \t]*$/.exec(l);
      if (!m) return l;
      const v = m[2];
      if (/^["']/.test(v)) return l;
      if (/^[|>][1-9+-]*$/.test(v)) return l;
      if (!RETRY_SPECIAL.test(v)) return l;
      return `${m[1]}: "${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    })
    .join('\n');
}

export function parseFrontmatterYaml(text) {
  try {
    return { ok: true, retried: false, ...parseYaml(text) };
  } catch (e1) {
    if (!(e1 instanceof YamlError)) throw e1;
    const fixed = quoteProblematicValues(text);
    if (fixed !== text) {
      try {
        return { ok: true, retried: true, ...parseYaml(fixed) };
      } catch (e2) {
        if (!(e2 instanceof YamlError)) throw e2;
      }
    }
    return { ok: false, error: e1.message, line: e1.line };
  }
}
