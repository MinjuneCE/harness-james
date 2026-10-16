// 1단계 규칙 25개. 각 함수는 {status, findings, note?}를 돌려준다.
import os from 'node:os';
import path from 'node:path';
import {
  KNOWN_KEYS, INVOCATION_KEYS, BOOL_KEYS, BOOL_STRINGS, EFFORT_VALUES, CONTEXT_VALUES, SHELL_VALUES,
  MODEL_ALIASES, MODEL_ID_RE, BUILTIN_AGENTS, NAME_RE, NAME_MAX, DESCRIPTION_MAX, LISTING_CAP,
  LISTING_SOFT_LIMIT, BODY_MAX_LINES, DOC_TOC_MIN_LINES, TOC_SCAN_LINES, RESERVED_NAMES,
} from './spec.mjs';
import { isTestPath, lineOfIndex } from './files.mjs';
import { clip } from './context.mjs';

const SEV_RANK = { BLOCKER: 3, MAJOR: 2, MINOR: 1 };

export function F(file, line, text, severity, message, fix) {
  return { file, line: line || 0, text: clip(text == null ? '' : String(text).replace(/\s+/g, ' ').trim()), severity, message: clip(message), fix: clip(fix) };
}

export function chars(s) {
  return Array.from(String(s || '')).length;
}

const pass = () => ({ status: 'pass', findings: [] });
const na = (note) => ({ status: 'na', findings: [], note });
const err = (note) => ({ status: 'error', findings: [], note });
const fail = (findings) => ({ status: 'fail', findings });
const result = (findings) => (findings.length ? fail(findings) : pass());

function keyLine(ctx, key) {
  const l = ctx.parse && ctx.parse.keyLines && ctx.parse.keyLines[key];
  return l ? l + 1 : 1; // frontmatter는 SKILL.md 2번째 줄부터
}

function str(v) {
  return typeof v === 'string' ? v : '';
}

// ---- 이름 ----
// 코드 포인트 범위로 문자 클래스를 만든다(소스에 보이지 않는 문자를 넣지 않기 위해).
function cpClass(ranges) {
  const hex = (n) => '\\u{' + n.toString(16) + '}';
  return new RegExp('[' + ranges.map(([a, b]) => (b ? `${hex(a)}-${hex(b)}` : hex(a))).join('') + ']', 'u');
}

const BAD_NAME_CHARS = [
  [cpClass([[0x200b, 0x200d], [0x2060], [0xfeff]]), '제로폭 문자'],
  [cpClass([[0x0, 0x1f], [0x7f, 0x9f]]), '제어 문자'],
  [cpClass([[0x61c], [0x200e], [0x200f], [0x202a, 0x202e], [0x2066, 0x2069]]), '방향을 바꾸는 문자(bidi)'],
  [cpClass([[0xe000, 0xf8ff], [0xf0000, 0xffffd], [0x100000, 0x10fffd]]), '사적 사용 영역 문자'],
  [cpClass([[0xa0], [0x1680], [0x2000, 0x200a], [0x2028], [0x2029], [0x202f], [0x205f], [0x3000]]), '비표준 공백'],
  [/[<>]/, '꺾쇠(< >)'],
];

export function S2(ctx) {
  const usesName = typeof ctx.data.name === 'string' && ctx.data.name !== '';
  const name = usesName ? ctx.data.name : ctx.dirName;
  const where = usesName ? 'name' : '폴더명';
  const line = usesName ? keyLine(ctx, 'name') : 0;
  const findings = [];
  for (const [re, label] of BAD_NAME_CHARS) {
    if (re.test(name)) findings.push(F('SKILL.md', line, name, 'BLOCKER', `${where}에 ${label}가 들어 있어요. Claude Code는 이런 이름의 스킬을 거부해요.`, `${where}을 소문자·숫자·하이픈만으로 바꿔요.`));
  }
  if (!findings.length && !NAME_RE.test(name)) {
    findings.push(F('SKILL.md', line, name, 'BLOCKER', `${where} "${name}"이 소문자·숫자·하이픈 형식(^[a-z0-9]+(-[a-z0-9]+)*$)이 아니에요.`, `${where}을 예: ${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'my-skill'} 꼴로 바꿔요.`));
  }
  if (chars(name) > NAME_MAX) findings.push(F('SKILL.md', line, name, 'BLOCKER', `${where}이 ${chars(name)}자예요. 64자를 넘으면 안 돼요.`, '64자 이하로 줄여요.'));
  return result(findings);
}

export function S3(ctx) {
  if (typeof ctx.data.name !== 'string' || ctx.data.name === '') return pass();
  if (ctx.data.name === ctx.dirName) return pass();
  return fail([F('SKILL.md', keyLine(ctx, 'name'), `name: ${ctx.data.name}`, 'MAJOR', `name(${ctx.data.name})과 폴더명(${ctx.dirName})이 달라요. 이름이 둘이 되어 헷갈려요.`, '폴더명과 name을 같게 맞춰요.')]);
}

export function S4(ctx) {
  const d = ctx.data.description;
  const sev = ctx.types.includes('auto') ? 'BLOCKER' : 'MAJOR';
  if (typeof d === 'string' && d.trim() !== '') return pass();
  const why = d === undefined ? 'description이 없어요' : typeof d !== 'string' ? 'description이 문자열이 아니에요' : 'description이 비어 있어요';
  return fail([F('SKILL.md', d === undefined ? 1 : keyLine(ctx, 'description'), d === undefined ? '' : `description: ${JSON.stringify(d)}`, sev, `${why}. 그러면 본문 첫 줄이 설명으로 쓰여서 언제 불러야 할지 알 수 없어요.`, '무엇을 하는지와 언제 쓰는지를 담은 description을 써요.')]);
}

export function listingChars(data) {
  const d = str(data.description);
  const w = str(data.when_to_use);
  return chars(d) + (w ? 1 + chars(w) : 0);
}

export function S5(ctx) {
  const findings = [];
  const d = str(ctx.data.description);
  if (chars(d) > DESCRIPTION_MAX) findings.push(F('SKILL.md', keyLine(ctx, 'description'), d.slice(0, 80), 'MAJOR', `description이 ${chars(d)}자예요. 공식 스펙 한도 1,024자를 넘어요.`, '핵심 용도를 앞에 두고 1,024자 이하로 줄여요.'));
  if (ctx.types.includes('auto')) {
    const n = listingChars(ctx.data);
    if (n > LISTING_CAP) findings.push(F('SKILL.md', keyLine(ctx, ctx.data.when_to_use ? 'when_to_use' : 'description'), `listingChars=${n}`, 'MAJOR', `description과 when_to_use를 합쳐 ${n}자예요. Claude Code는 목록에서 1,536자 뒤를 잘라요.`, '합쳐서 1,536자 이하로 줄여요.'));
  }
  return result(findings);
}

// ---- S6 XML 태그 ----
// 태그로 보는 것: 닫는 태그 </x>, 자기 닫는 태그 <x/>, 속성이 있는 태그 <x a="b">,
// 같은 이름의 닫는 태그가 있는 여는 태그, 이름이 알려진 HTML·프롬프트 XML 요소인 <x>.
// 영문으로 시작하지 않는 꺾쇠(<스킬 디렉터리>), 공백·|·…가 섞인 자리표시(<branch|sha>)는 태그가 아니다.
// 그 밖의 <word>는 자리표시로 보고 note에만 남긴다.
const HTML_TAGS = new Set(('a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html i iframe img input ins kbd label legend li link main map mark meta meter nav noscript object ol optgroup option output p param picture pre progress q rp rt ruby s samp script section select small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr '
  + 'example examples instructions instruction context document documents thinking answer system user assistant prompt rules rule note tool tools result results output input query search_results').split(' '));

export function findXmlTags(s) {
  const tags = [];
  const placeholders = [];
  const re = /<(\/?)([A-Za-z][A-Za-z0-9_.:-]*)((?:\s+[A-Za-z_:][-A-Za-z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(s))) {
    const [all, close, name, attrs, self] = m;
    const lower = name.toLowerCase();
    const hasAttrValue = /=/.test(attrs);
    const hasClose = new RegExp(`</${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*>`).test(s);
    if (close || self || hasAttrValue || (hasClose && !attrs.trim()) || (HTML_TAGS.has(lower) && !attrs.trim())) tags.push(all);
    else placeholders.push(all);
  }
  return { tags, placeholders };
}

export function S6(ctx) {
  const findings = [];
  const notes = [];
  for (const key of ['description', 'when_to_use']) {
    const v = str(ctx.data[key]);
    if (!v) continue;
    const { tags, placeholders } = findXmlTags(v);
    for (const t of tags) findings.push(F('SKILL.md', keyLine(ctx, key), t, 'BLOCKER', `${key}에 XML 태그 ${t}가 있어요. 스킬 목록은 시스템 프롬프트에 들어가서 태그가 구조를 흐트러뜨릴 수 있고, 스펙도 금지해요.`, '태그를 지우거나 꺾쇠 없이 풀어 써요.'));
    if (placeholders.length) notes.push(`${key}의 ${placeholders.slice(0, 5).join(' ')}는 자리표시로 보고 넘겼어요`);
  }
  const r = result(findings);
  if (notes.length) r.note = notes.join('; ');
  return r;
}

// ---- S7/S8 키 ----
export function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

const norm = (k) => k.toLowerCase().replace(/_/g, '-');

export function nearestKnownKey(key) {
  const nk = norm(key);
  let best = null;
  for (const k of KNOWN_KEYS) {
    const d = nk === norm(k) ? 0 : levenshtein(nk, norm(k));
    if (best === null || d < best.d) best = { key: k, d };
  }
  return best && best.d <= 2 ? best.key : null;
}

function unknownKeys(ctx) {
  return Object.keys(ctx.data).filter((k) => !KNOWN_KEYS.includes(k));
}

export function S7(ctx) {
  const findings = [];
  for (const k of unknownKeys(ctx)) {
    const near = nearestKnownKey(k);
    if (!near) continue;
    const sev = INVOCATION_KEYS.has(near) ? 'BLOCKER' : 'MAJOR';
    findings.push(F('SKILL.md', keyLine(ctx, k), `${k}: ${JSON.stringify(ctx.data[k])}`, sev, `알려진 키 ${near}과 철자가 거의 같은 모르는 키예요. Claude Code는 모르는 키를 경고 없이 무시해서${INVOCATION_KEYS.has(near) ? ' 호출·권한 설정이 적용되지 않아요' : ' 설정이 적용되지 않아요'}.`, `키 이름을 ${near}로 고쳐요.`));
  }
  return result(findings);
}

export function S8(ctx) {
  const findings = [];
  for (const k of unknownKeys(ctx)) {
    if (nearestKnownKey(k)) continue;
    findings.push(F('SKILL.md', keyLine(ctx, k), k, 'MINOR', `모르는 키 ${k}예요. Claude Code는 이 키를 무시해요.`, '필요 없으면 지우고, 자체 도구용 값이면 metadata 아래로 옮겨요.'));
  }
  return result(findings);
}

export function S9(ctx) {
  const findings = [];
  const names = [...new Set([typeof ctx.data.name === 'string' ? ctx.data.name : null, ctx.dirName].filter(Boolean))];
  for (const n of names) {
    const where = n === ctx.data.name ? 'name' : '폴더명';
    const lower = n.toLowerCase();
    if (lower === 'synced' || RESERVED_NAMES.includes(lower) || lower.startsWith('anthropic-skills:')) {
      findings.push(F('SKILL.md', where === 'name' ? keyLine(ctx, 'name') : 0, n, 'BLOCKER', `${where} "${n}"은 Claude Code가 예약한 이름이에요(claude.ai 동기화 스킬용). 스킬이 동작하지 않거나 다른 스킬과 섞여요.`, '다른 이름을 써요.'));
    } else if (/claude|anthropic/.test(lower)) {
      findings.push(F('SKILL.md', where === 'name' ? keyLine(ctx, 'name') : 0, n, 'MAJOR', `${where} "${n}"에 claude나 anthropic이 들어 있어요. 공식 가이드가 예약어로 금지해요.`, '예약어를 뺀 이름을 써요.'));
    }
  }
  return result(findings);
}

// ---- S10 값 ----
function isBoolValue(v) {
  if (typeof v === 'boolean') return true;
  if (v === 0 || v === 1) return true;
  return typeof v === 'string' && BOOL_STRINGS.has(v.toLowerCase());
}

function strOrList(v) {
  return typeof v === 'string' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
}

export function S10(ctx) {
  const d = ctx.data;
  const findings = [];
  const bad = (key, msg, fix) => findings.push(F('SKILL.md', keyLine(ctx, key), `${key}: ${JSON.stringify(d[key])}`, 'MAJOR', msg, fix));
  for (const k of BOOL_KEYS) {
    if (k in d && !isBoolValue(d[k])) bad(k, `${k} 값 ${JSON.stringify(d[k])}은 불리언이 아니에요. 설정이 기대대로 적용되지 않을 수 있어요.`, `${k}: true 또는 false로 써요.`);
  }
  if ('effort' in d && !EFFORT_VALUES.includes(d.effort)) bad('effort', `effort 값 ${JSON.stringify(d.effort)}은 허용 값(${EFFORT_VALUES.join(', ')})이 아니에요.`, `${EFFORT_VALUES.join(', ')} 중 하나로 써요.`);
  if ('context' in d && !CONTEXT_VALUES.includes(d.context)) bad('context', `context 값 ${JSON.stringify(d.context)}은 허용 값(fork)이 아니에요.`, 'context: fork로 쓰거나 키를 지워요.');
  if ('shell' in d && !SHELL_VALUES.includes(d.shell)) bad('shell', `shell 값 ${JSON.stringify(d.shell)}은 허용 값(bash, powershell)이 아니에요.`, 'bash 또는 powershell로 써요.');
  if ('model' in d) {
    const m = d.model;
    const ok = typeof m === 'string' && (MODEL_ALIASES.includes(m.toLowerCase()) || MODEL_ID_RE.test(m));
    if (!ok) bad('model', `model 값 ${JSON.stringify(m)}은 알려진 별칭(${MODEL_ALIASES.join(', ')})도, claude-로 시작하는 모델 id도 아니에요.`, '별칭이나 claude-opus-5-5 같은 전체 id로 써요.');
  }
  const fork = d.context === 'fork';
  if (!fork && 'agent' in d) bad('agent', 'context: fork가 아닌데 agent를 썼어요. agent는 fork에서만 쓰여서 무시돼요.', 'context: fork를 추가하거나 agent를 지워요.');
  if (!fork && 'background' in d) bad('background', 'context: fork가 아닌데 background를 썼어요. background는 fork에서만 쓰여서 무시돼요.', 'context: fork를 추가하거나 background를 지워요.');
  for (const k of ['allowed-tools', 'disallowed-tools', 'paths', 'arguments']) {
    if (k in d && !strOrList(d[k])) bad(k, `${k}는 문자열이나 문자열 목록이어야 해요.`, `${k}를 문자열이나 YAML 목록으로 써요.`);
  }
  for (const k of ['name', 'when_to_use', 'argument-hint', 'agent', 'license', 'compatibility']) {
    if (k in d && d[k] !== null && typeof d[k] !== 'string') bad(k, `${k}는 문자열이어야 해요.`, `${k}를 문자열로 써요.`);
  }
  if ('compatibility' in d && typeof d.compatibility === 'string' && chars(d.compatibility) > 500) bad('compatibility', `compatibility가 ${chars(d.compatibility)}자예요. 500자까지만 받아요.`, '500자 이하로 줄여요.');
  for (const k of ['hooks', 'metadata']) {
    if (k in d && (d[k] === null || typeof d[k] !== 'object' || Array.isArray(d[k]))) bad(k, `${k}는 맵이어야 해요. 맵이 아니면 Claude Code가 값을 버려요.`, `${k}를 key: value 맵으로 써요.`);
  }
  for (const dup of ctx.parse.dups || []) {
    if (!dup.top) continue;
    findings.push(F('SKILL.md', dup.line + 1, dup.key, 'MAJOR', `키 ${dup.key}가 두 번 있어요. 런타임은 마지막 값만 써서 앞의 값이 조용히 버려져요.`, '하나만 남겨요.'));
  }
  return result(findings);
}

// ---- S11 fork 에이전트 ----
export function S11(ctx) {
  if (!ctx.types.includes('fork')) return na('fork 유형이 아님');
  const a = ctx.data.agent;
  if (a === undefined || a === null || a === '') return pass();
  if (typeof a !== 'string') return fail([F('SKILL.md', keyLine(ctx, 'agent'), JSON.stringify(a), 'BLOCKER', 'agent 값이 문자열이 아니에요.', '에이전트 이름을 문자열로 써요.')]);
  if (BUILTIN_AGENTS.includes(a)) return pass();
  const ag = ctx.agents;
  const scope = ctx.scope;
  const has = (list) => list.includes(a);
  const notFound = () => fail([F('SKILL.md', keyLine(ctx, 'agent'), `agent: ${a}`, 'BLOCKER', `에이전트 ${a}를 찾지 못했어요(내장, ~/.claude/agents${scope === 'project' ? ', 프로젝트 .claude/agents' : ''}${a.includes(':') ? ', 켜진 플러그인' : ''}). 스킬을 부르면 fork가 실패해요.`, '에이전트 파일을 만들거나 agent 값을 있는 에이전트로 고쳐요.')]);
  if (a.includes(':')) return has(ag.plugin) ? pass() : notFound();
  if (scope === 'user') {
    if (has(ag.user) || has(ag.extra)) return pass();
    if (has(ag.anyProject)) return fail([F('SKILL.md', keyLine(ctx, 'agent'), `agent: ${a}`, 'BLOCKER', `사용자 스킬이 프로젝트 전용 에이전트 ${a}를 가리켜요. 다른 프로젝트에서는 에이전트가 없어서 fork가 실패해요.`, '에이전트를 ~/.claude/agents로 옮기거나 스킬을 프로젝트 .claude/skills로 옮겨요.')]);
    return notFound();
  }
  if (scope === 'project') return has(ag.user) || has(ag.project) || has(ag.extra) ? pass() : notFound();
  if (scope === 'plugin') return has(ag.user) || has(ag.plugin) || has(ag.extra) ? pass() : notFound();
  // other(스테이징)
  if (has(ag.user) || has(ag.sibling) || has(ag.extra)) {
    const r = pass();
    if (!has(ag.user) && has(ag.sibling)) r.note = `스킬 옆 agents/에서 ${a}를 찾았어요(설치 전 배치). 설치 뒤 ~/.claude/agents에 있어야 해요`;
    return r;
  }
  if (has(ag.cwdProject)) {
    const r = pass();
    r.note = `범위를 경로로 알 수 없어 현재 프로젝트의 ${a}를 인정했어요. --as user로 검사하면 fail이 돼요`;
    return r;
  }
  return notFound();
}

export function S12(ctx) {
  const f = ctx.files.find((x) => !x.path.includes('/') && x.path.toLowerCase() === 'readme.md');
  if (!f) return pass();
  return fail([F(f.path, 0, f.path, 'MINOR', '스킬 루트에 README.md가 있어요. 스킬은 SKILL.md만 읽혀서 README는 쓰이지 않거나 내용이 갈라져요.', '내용을 SKILL.md나 references/로 옮기고 README를 지워요.')]);
}

// ---- T6 ----
export function argumentNames(data) {
  const a = data.arguments;
  if (typeof a === 'string') return a.split(/[\s,]+/).filter(Boolean);
  if (Array.isArray(a)) return a.filter((x) => typeof x === 'string');
  return [];
}

export function findArgUses(body, names) {
  const alts = ['ARGUMENTS(?:\\[\\d+\\])?(?![A-Za-z0-9_])', '\\d+', ...names.map((n) => `${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`)];
  const re = new RegExp(`(?<!\\\\)\\$(?:${alts.join('|')})`, 'g');
  const out = [];
  let m;
  while ((m = re.exec(body))) out.push({ text: m[0], index: m.index });
  return out;
}

export function T6(ctx) {
  const uses = findArgUses(ctx.body, argumentNames(ctx.data));
  if (!uses.length) return pass();
  const hint = ctx.data['argument-hint'];
  if (typeof hint === 'string' && hint.trim() !== '') return pass();
  const u = uses[0];
  return fail([F('SKILL.md', ctx.bodyStartLine + lineOfIndex(ctx.body, u.index) - 1, u.text, 'MINOR', `본문이 인자(${[...new Set(uses.map((x) => x.text))].slice(0, 5).join(', ')})를 쓰는데 argument-hint가 없어요. 자동 완성에서 무엇을 넣어야 할지 보이지 않아요.`, 'argument-hint에 예: "<대상> [옵션]"처럼 인자 모양을 적어요.')]);
}

export function T7(ctx) {
  if (!ctx.types.includes('auto')) return na('auto 유형이 아님');
  const n = listingChars(ctx.data);
  if (n <= LISTING_SOFT_LIMIT) return pass();
  return fail([F('SKILL.md', keyLine(ctx, 'description'), `listingChars=${n}`, 'MINOR', `목록에 매 턴 올라가는 설명이 ${n}자예요(기준 ${LISTING_SOFT_LIMIT}자). 스킬이 늘수록 목록 예산(컨텍스트 1%)을 잡아먹어요.`, '핵심 용도와 사용 시점만 남기고 줄여요. 특정 파일 작업용이면 paths로 범위를 좁히는 것도 검토해요.')]);
}

export function C3(ctx) {
  if (ctx.bodyLines <= BODY_MAX_LINES) return pass();
  return fail([F('SKILL.md', ctx.bodyStartLine, `bodyLines=${ctx.bodyLines}`, 'MINOR', `본문이 ${ctx.bodyLines}줄이에요. 500줄을 넘으면 스킬을 부를 때마다 컨텍스트를 많이 써요.`, '상세 내용을 references/ 문서로 나누고 SKILL.md에는 핵심만 남겨요.')]);
}

// ---- 마크다운 도우미 ----
export function stripFences(text) {
  // 코드 블록을 같은 줄 수의 빈 줄로 바꾼다(줄 번호 보존)
  const lines = text.split('\n');
  let fence = null;
  return lines
    .map((l) => {
      const m = /^\s{0,3}(`{3,}|~{3,})/.exec(l);
      if (fence) {
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^\s*(`{3,}|~{3,})\s*$/.test(l)) fence = null;
        return '';
      }
      if (m) { fence = m[1]; return ''; }
      return l;
    })
    .join('\n');
}

export function stripInlineCode(line) {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (s) => ' '.repeat(s.length));
}

// 마크다운 문서가 가리키는 로컬 .md (스킬 안, 존재하는 것)
export function localMdRefs(file, ctx) {
  const text = file.rel === 'SKILL.md' || file.path === 'SKILL.md' ? ctx.skillText : file.text;
  if (!text) return [];
  const known = new Set(ctx.files.filter((f) => /\.md$/i.test(f.path)).map((f) => f.path));
  const base = path.posix.dirname(file.path);
  const out = [];
  const add = (target, idx, src) => {
    let t = target.trim().replace(/^<|>$/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#')) return;
    t = t.split('#')[0].split('?')[0];
    try { t = decodeURI(t); } catch { /* 그대로 */ }
    t = t.replace(/^\$\{CLAUDE_SKILL_DIR\}\//, '/');
    const cands = t.startsWith('/') ? [path.posix.normalize(t.slice(1))] : [path.posix.normalize(path.posix.join(base, t)), path.posix.normalize(t)];
    const hit = cands.find((c) => known.has(c) && c !== file.path);
    if (hit) out.push({ target: hit, line: lineOfIndex(src, idx) });
  };
  const noFence = stripFences(text);
  let m;
  const linkRe = /\[[^\]\n]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^"']*["'])?\s*\)/g;
  while ((m = linkRe.exec(noFence))) add(m[1], m.index, noFence);
  const refRe = /^\s{0,3}\[[^\]]+\]:\s*(\S+)/gm;
  while ((m = refRe.exec(noFence))) add(m[1], m.index, noFence);
  // 링크 문법 없이 경로로만 적은 언급도 모델이 따라 읽으므로 센다
  const pathRe = /(?:^|[\s`'"(])((?:\$\{CLAUDE_SKILL_DIR\}\/)?[A-Za-z0-9_.\-/]+\.md)(?=$|[\s`'"),.:;])/g;
  while ((m = pathRe.exec(text))) add(m[1], m.index, text);
  const seen = new Set();
  return out.filter((r) => (seen.has(r.target) ? false : (seen.add(r.target), true)));
}

export function R3(ctx) {
  if (!ctx.types.includes('docs')) return na('docs 유형이 아님');
  const skill = { path: 'SKILL.md', text: ctx.skillText };
  const level1 = localMdRefs(skill, ctx).map((r) => r.target);
  const l1set = new Set(level1);
  const findings = [];
  for (const p of level1) {
    const f = ctx.files.find((x) => x.path === p);
    if (!f || !f.text) continue;
    for (const r of localMdRefs(f, ctx)) {
      if (r.target === 'SKILL.md' || l1set.has(r.target)) continue;
      findings.push(F(p, r.line, r.target, 'MAJOR', `${p}가 ${r.target}를 다시 가리키는데 SKILL.md는 ${r.target}를 직접 가리키지 않아요. 중첩 참조는 일부만 읽힐 수 있어요.`, `SKILL.md에서 ${r.target}를 직접 링크하고, 언제 읽을지 적어요.`));
    }
  }
  return result(findings);
}

export function hasToc(text) {
  const t = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const head = t.split('\n').slice(0, TOC_SCAN_LINES);
  if (head.some((l) => /^\s{0,3}#{1,6}\s*(목차|차례|contents|table of contents|toc)(?![A-Za-z])/i.test(l))) return true;
  if (head.some((l) => /^\s*(\*\*)?(목차|차례|contents|table of contents)(\*\*)?\s*:?\s*$/i.test(l))) return true;
  if (head.some((l) => /\[\[_?TOC_?\]\]|^\s*\[TOC\]\s*$|<!--\s*toc\s*-->/i.test(l))) return true;
  return head.filter((l) => /^\s*([-*+]|\d+\.)\s+.*\]\(#[^)]+\)/.test(l)).length >= 3;
}

export function R4(ctx) {
  if (!ctx.types.includes('docs')) return na('docs 유형이 아님');
  const findings = [];
  for (const f of ctx.files) {
    if (f.kind !== 'doc' || !f.text || f.lines <= DOC_TOC_MIN_LINES) continue;
    if (hasToc(f.text)) continue;
    findings.push(F(f.path, 1, `${f.lines}줄`, 'MINOR', `${f.path}가 ${f.lines}줄인데 앞 ${TOC_SCAN_LINES}줄 안에 목차가 없어요. 모델이 일부만 읽으면 전체 구성을 놓쳐요.`, '앞부분에 "## 목차"와 섹션 앵커 링크 목록을 둬요.'));
  }
  return result(findings);
}

export function R6(ctx) {
  if (!ctx.types.includes('code')) return na('code 유형이 아님');
  const s = ctx.syntax;
  if (!s) return err('문법 검사를 하지 못했어요');
  const findings = s.results.map((r) => F(r.file, r.line, r.message, 'MAJOR', `문법 오류예요: ${r.message}`, '문법 오류를 고쳐요.'));
  const r = result(findings);
  if (s.unavailable.length) r.note = `검사 도구를 쓰지 못한 파일이 있어요: ${[...new Set(s.unavailable)].join(', ')}`;
  return r;
}

export function entryPoints(ctx) {
  const codeFiles = ctx.files.filter((f) => f.kind === 'code' && !isTestPath(f.path));
  const importedBasenames = new Set();
  for (const f of ctx.files) {
    if (!f.text || (f.kind !== 'code' && f.kind !== 'test')) continue;
    const re = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
    let m;
    while ((m = re.exec(f.text))) if (m[1].startsWith('.')) importedBasenames.add(path.posix.normalize(path.posix.join(path.posix.dirname(f.path), m[1])));
  }
  return codeFiles.filter((f) => {
    const parts = f.path.split('/');
    const inEntryDir = (parts.length === 2 && (parts[0] === 'bin' || parts[0] === 'scripts')) || parts.length === 1;
    if (!inEntryDir) return false;
    const shebang = f.text && f.text.startsWith('#!');
    if (parts[0] === 'bin' || shebang) return true;
    return !importedBasenames.has(f.path);
  });
}

export function R7(ctx) {
  if (!ctx.types.includes('code')) return na('code 유형이 아님');
  const findings = [];
  for (const f of entryPoints(ctx)) {
    const base = path.posix.basename(f.path);
    if (ctx.skillText.includes(f.path) || ctx.skillText.includes(base)) continue;
    findings.push(F(f.path, 0, f.path, 'MINOR', `실행 진입점 ${f.path}가 SKILL.md에 나오지 않아요. 모델이 이 스크립트가 있는지, 언제 쓰는지 알 수 없어요.`, `SKILL.md에 \${CLAUDE_SKILL_DIR}/${f.path} 실행 방법을 적어요.`));
  }
  return result(findings);
}

// ---- R8 미완성 표시 ----
const MARKS = ['TO' + 'DO', 'FIX' + 'ME', 'X' + 'XX', 'T' + 'BD'];
const MARK_RE = new RegExp(`\\b(${MARKS.join('|')})\\b`);
const MARK_HEAD_RE = new RegExp(`^\\s*(?:[-*+]\\s+|\\d+\\.\\s+|#{1,6}\\s+|>\\s*)*(?:\\[[ xX]\\]\\s*)?(?:\\*\\*)?(${MARKS.join('|')})(?:\\*\\*)?(?=[\\s:(!.,-]|$)`);

const SLASH_COMMENT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.java', '.go', '.rs', '.kt', '.c', '.h', '.cpp', '.swift', '.css', '.scss', '.jsonc', '.json5']);
const HASH_COMMENT_EXT = new Set(['.py', '.sh', '.bash', '.zsh', '.rb', '.pl', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.env', '.properties', '.r']);

// 한 줄에서 따옴표 밖의 주석 부분을 돌려준다.
export function commentPart(line, style, state) {
  let out = '';
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end < 0) { out += line.slice(i); return out; }
      out += line.slice(i, end);
      state.block = false;
      i = end + 1;
      continue;
    }
    if (q) {
      if (c === '\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || (c === '`' && style === 'slash')) { q = c; continue; }
    if (style === 'slash' && c === '/' && line[i + 1] === '/') return out + line.slice(i + 2);
    if (style === 'slash' && c === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
    if (style === 'hash' && c === '#' && (i === 0 || /\s/.test(line[i - 1]) || style === 'hash')) return out + line.slice(i + 1);
  }
  return out;
}

export function findMarks(f) {
  const ext = path.extname(f.path).toLowerCase();
  const res = [];
  if (f.kind === 'skill' || f.kind === 'doc') {
    const text = stripFences(f.text.replace(/<!--([\s\S]*?)-->/g, (s) => s.replace(/[^\n]/g, (ch) => ch)));
    const lines = text.split('\n');
    lines.forEach((l, i) => {
      const plain = stripInlineCode(l);
      const comment = /<!--(.*?)(-->|$)/.exec(plain);
      if (MARK_HEAD_RE.test(plain) || (comment && MARK_RE.test(comment[1]))) res.push({ line: i + 1, text: l });
    });
    return res;
  }
  const style = SLASH_COMMENT_EXT.has(ext) ? 'slash' : HASH_COMMENT_EXT.has(ext) || (f.text && /^#!/.test(f.text)) ? 'hash' : null;
  const state = { block: false };
  f.text.split('\n').forEach((l, i) => {
    let hit = false;
    if (style) {
      const wasBlock = state.block;
      const c = commentPart(l, style, state);
      if (MARK_RE.test(c)) hit = true;
      if (wasBlock && MARK_HEAD_RE.test(l.replace(/^\s*\*/, ''))) hit = true;
    }
    if (!hit && MARK_HEAD_RE.test(l)) hit = true;
    if (hit) res.push({ line: i + 1, text: l });
  });
  return res;
}

export function R8(ctx) {
  const findings = [];
  for (const f of ctx.files) {
    if (!f.text || f.binary) continue;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path)) continue;
    for (const h of findMarks(f)) {
      findings.push(F(f.path, h.line, h.text, 'MINOR', '미완성 표시가 남아 있어요. 끝나지 않은 부분인지 모델과 사람이 헷갈려요.', '마무리하고 표시를 지우거나, 계속 둘 일이면 이슈나 문서로 옮겨요.'));
    }
  }
  return result(findings);
}

export function R9(ctx) {
  if (!ctx.types.includes('code')) return na('code 유형이 아님');
  if (ctx.files.some((f) => isTestPath(f.path))) return pass();
  return fail([F('', 0, '', 'MINOR', '코드가 있는데 테스트 파일(test/, tests/, *.test.*, *_test.*, *.spec.*)이 없어요. 고친 뒤 깨졌는지 확인할 방법이 없어요.', 'test/ 아래에 핵심 동작 테스트를 두고 SKILL.md에 실행 방법을 적어요.')]);
}

// ---- R11 경로 ----
function currentUser() {
  try { return os.userInfo().username; } catch { return path.basename(os.homedir()); }
}

const HOME_PLACEHOLDER = new Set(['user', 'username', 'you', 'yourname', 'your-name', 'me', 'name', 'example', 'runner', 'someone', 'foo']);
const HOME_RE = /(?<![A-Za-z0-9_])\/(Users|home)\/([A-Za-z0-9._-]+)\//g;
const WIN_HOME_RE = /\b[A-Za-z]:\\(?:Users|Documents and Settings)\\([A-Za-z0-9._ -]+)\\/g;
const BACKSLASH_RE = /(?<![\\\w])(?:[A-Za-z]:\\|[A-Za-z0-9][\w.-]*\\[A-Za-z0-9][\w.-]*(?:\\[A-Za-z0-9][\w.-]*)*\.[A-Za-z0-9]{1,6}\b)/g;

export function R11(ctx) {
  const findings = [];
  for (const f of ctx.files) {
    if (!f.text || f.binary) continue;
    if (/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(f.path)) continue;
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      HOME_RE.lastIndex = 0;
      let m;
      while ((m = HOME_RE.exec(l))) {
        if (HOME_PLACEHOLDER.has(m[2].toLowerCase()) || m[2].startsWith('$') || m[2].length === 1) continue;
        // 테스트는 가짜 경로를 픽스처로 쓰므로 실제 사용자 이름일 때만 센다
        if (isTestPath(f.path) && m[2] !== currentUser()) continue;
        findings.push(F(f.path, i + 1, `/${m[1]}/${m[2][0]}…/`, 'MINOR', '사용자 홈 절대 경로가 박혀 있어요. 다른 계정이나 기기에서는 경로가 맞지 않아요.', '${CLAUDE_SKILL_DIR}, ~, $HOME, os.homedir() 같은 대안을 써요.'));
        break;
      }
      WIN_HOME_RE.lastIndex = 0;
      if ((m = WIN_HOME_RE.exec(l)) && !HOME_PLACEHOLDER.has(m[1].toLowerCase())) {
        findings.push(F(f.path, i + 1, l.slice(m.index, m.index + 20), 'MINOR', 'Windows 사용자 홈 절대 경로가 박혀 있어요.', '${CLAUDE_SKILL_DIR}나 ~ 같은 대안을 써요.'));
      }
    });
    if (f.kind === 'skill' || f.kind === 'doc') {
      const text = f.kind === 'skill' ? ctx.skillText : f.text;
      text.split('\n').forEach((l, i) => {
        BACKSLASH_RE.lastIndex = 0;
        const m = BACKSLASH_RE.exec(l);
        if (m) findings.push(F(f.path, i + 1, m[0], 'MINOR', `역슬래시 경로 ${m[0]}가 있어요. macOS·Linux에서는 경로로 읽히지 않아요.`, `슬래시(/)로 바꾸고, 스킬 안 파일이면 \${CLAUDE_SKILL_DIR}/... 꼴로 써요.`));
      });
    }
  }
  return result(findings);
}

// ---- X1 ----
export function X1(ctx) {
  const s = ctx.secrets;
  if (!s) return err('비밀값 검사를 하지 못했어요');
  if (s.error) return err([s.glFailure && `gitleaks 실패: ${s.glFailure}`, s.error].filter(Boolean).join('; '));
  const findings = s.findings.map((x) => F(x.file, x.line, x.masked ? `값 ${x.masked}` : x.kind, 'BLOCKER', `평문 비밀값 후보예요: ${x.why}.`, '값을 지우고 환경 변수나 키체인, 저장소 밖 파일에서 읽어요. 이미 커밋·공유됐으면 키를 폐기하고 새로 발급해요.'));
  for (const e of s.exceptions || []) {
    findings.push(F(e.file, e.line, e.text, 'MINOR', '비밀값 검사 예외 설정이 있어요. 의도한 것인지 확인해요. (skill-check는 이 예외를 무시하고 검사했어요)', '필요 없으면 지우고, 테스트용 가짜 값이면 실행 중에 만들거나 문자열을 쪼개 둬요.'));
  }
  const r = result(findings);
  if (s.glFailure) r.note = `gitleaks 실패: ${s.glFailure}; 정규식으로 대신 검사했어요(미탐 가능)`;
  else if (s.scanner === 'regex') r.note = 'gitleaks가 없어 정규식으로 검사했어요(미탐 가능)';
  return r;
}

// ---- X2 ----
export function splitTools(v) {
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  const out = [];
  let cur = '';
  let depth = 0;
  for (const c of v) {
    if (c === '(') depth++;
    if (c === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === ',' || /\s/.test(c))) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const DESTRUCTIVE = [
  [/\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)\b/, 'rm -r/-f'],
  [/\bgit\s+push\b/, 'git push'],
  [/\bgit\s+reset\s+--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+-[a-zA-Z]*f/, 'git clean -f'],
  [/\bgit\s+branch\s+-D\b/, 'git branch -D'],
  [/\bgit\s+checkout\s+--\s/, 'git checkout --'],
  [/--force\b/, '--force'],
  [/\bsudo\b/, 'sudo'],
  [/\bmkfs\b/, 'mkfs'],
  [/\bdd\s+if=/, 'dd if='],
  [/\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)?(?:0?777|a\+rwx)\b/, 'chmod 777'],
  [/\bgh\s+pr\s+merge\b/, 'gh pr merge'],
  [/\bnpm\s+publish\b/, 'npm publish'],
  [/\bfind\b.*\s-delete\b/, 'find -delete'],
];
// 와일드카드 규칙이 파괴 명령을 품는지 확인하는 표본
const DESTRUCTIVE_SAMPLES = ['rm -rf ./x', 'rm -r ./x', 'git push origin main', 'git push --force', 'git reset --hard HEAD', 'git clean -fd', 'git branch -D x', 'sudo ls', 'mkfs /dev/x', 'dd if=/dev/zero of=/dev/x', 'chmod -R 777 .', 'gh pr merge 1', 'npm publish', 'find . -delete'];

function bashPatternMatcher(inner) {
  // Claude Code 권한 규칙: "cmd:*"는 접두, 그 밖의 *는 글롭
  let p = inner.trim();
  if (p.endsWith(':*')) p = p.slice(0, -2) + '*';
  const re = new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
  return (cmd) => re.test(cmd);
}

export function X2(ctx) {
  const v = ctx.data['allowed-tools'];
  if (v === undefined || v === null) return pass();
  const tokens = splitTools(v);
  const findings = [];
  const line = keyLine(ctx, 'allowed-tools');
  for (const t of tokens) {
    const m = /^(Bash|PowerShell)(?:\((.*)\))?$/s.exec(t);
    if (!m) continue;
    const inner = m[2];
    if (inner === undefined || /^[\s*:]*$/.test(inner)) {
      findings.push(F('SKILL.md', line, t, 'MAJOR', `allowed-tools가 ${m[1]} 전체를 패턴 없이 허용해요. 스킬을 부른 턴에서는 어떤 명령이든 묻지 않고 실행돼요.`, `${m[1]}(git status:*)처럼 필요한 명령만 패턴으로 허용해요.`));
      continue;
    }
    const hit = DESTRUCTIVE.find(([re]) => re.test(inner));
    if (hit) {
      findings.push(F('SKILL.md', line, t, 'BLOCKER', `allowed-tools가 파괴 명령(${hit[1]})을 묻지 않고 허용해요.`, '이 명령을 allowed-tools에서 빼서 실행할 때마다 승인을 받게 해요. 꼭 자동이어야 하면 훅이나 스크립트로 범위를 좁혀요.'));
      continue;
    }
    if (inner.includes('*')) {
      const match = bashPatternMatcher(inner);
      const sample = DESTRUCTIVE_SAMPLES.find((s) => match(s));
      if (sample) findings.push(F('SKILL.md', line, t, 'BLOCKER', `allowed-tools의 와일드카드 ${t}가 파괴 명령(예: ${sample.split(' ').slice(0, 3).join(' ')})까지 묻지 않고 허용해요.`, '접두를 좁혀서 필요한 하위 명령만 허용해요(예: Bash(git status:*)).'));
    }
  }
  return result(findings);
}


// ---- X5 인자를 따옴표 없이 셸에 넣기 ----
// Claude Code는 $ARGUMENTS·$N·$이름을 셸 해석 전에 글자 그대로 끼워 넣는다. 따옴표 없이 셸 명령에 들어가면
// 인자 속 공백·;·$(…)·백틱이 명령을 가르거나 다른 명령을 실행한다.
// 보는 곳: 셸 코드 블록(bash sh zsh shell console, 언어 표시 없음), ```! 블록, 한 줄 !`…` 주입.
// 빼는 곳: 작은따옴표·큰따옴표 안, \$로 이스케이프한 것, # 주석, 따옴표 붙인 heredoc(<<'EOF', <<"EOF", <<\EOF) 본문.
const SHELL_INFO = new Set(['', 'bash', 'sh', 'zsh', 'shell', 'console', 'shellsession', '!']);
const QUOTED_HEREDOC_RE = /<<-?\s*(?:'([^']+)'|"([^"]+)"|\\([A-Za-z_][A-Za-z0-9_]*))/;

function argPlaceholderRe(names) {
  const alts = ['ARGUMENTS(?:\\[\\d+\\])?(?![A-Za-z0-9_])', '\\d+', ...names.map((n) => `${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`)];
  return new RegExp(`^\\$(?:${alts.join('|')})`);
}

// 한 줄(또는 주입 명령)에서 따옴표 밖의 인자 자리를 찾는다.
export function unquotedArgs(line, names) {
  const re = argPlaceholderRe(names);
  const out = [];
  let q = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === '\\') { i++; continue; }
    if (q === '"') { if (c === '"') q = null; continue; }
    if (c === "'" || c === '"') { q = c; continue; }
    if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (c === '$') {
      const m = re.exec(line.slice(i));
      if (m) out.push(m[0]);
    }
  }
  return out;
}

// 셸로 해석되는 줄 목록: [{line(본문 기준 0부터), text, where}]
export function shellLines(body) {
  const lines = body.split('\n');
  const out = [];
  let fence = null;
  let heredocEnd = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const m = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`]*)/.exec(l);
    if (fence) {
      if (m && m[1][0] === fence.mark[0] && m[1].length >= fence.mark.length && /^\s*(`{3,}|~{3,})\s*$/.test(l)) { fence = null; heredocEnd = null; continue; }
      if (!fence.shell) continue;
      if (heredocEnd !== null) {
        if (l.replace(/^\t+/, '') === heredocEnd) heredocEnd = null;
        continue;
      }
      out.push({ line: i, text: l, where: fence.info === '!' ? '```! 주입 블록' : `셸 코드 블록(${fence.info || '언어 표시 없음'})` });
      const h = QUOTED_HEREDOC_RE.exec(l);
      if (h) heredocEnd = h[1] || h[2] || h[3];
      continue;
    }
    if (m) {
      const info = m[2].toLowerCase();
      fence = { mark: m[1], info, shell: SHELL_INFO.has(info) };
      heredocEnd = null;
      continue;
    }
    const inj = /!`([^`]+)`/g;
    let k;
    while ((k = inj.exec(l))) out.push({ line: i, text: k[1], where: '!`…` 주입' });
  }
  return out;
}

// 고칠 점은 인자 모양에 따라 나눈다. "$ARGUMENTS"는 인자가 여러 개면 전체를 한 덩어리로 묶어 동작을 깬다.
export function x5Fix(hits, names) {
  const parts = [];
  const whole = hits.some((h) => h === '$ARGUMENTS');
  if (whole) {
    parts.push('인자가 하나뿐이면 "$ARGUMENTS"처럼 큰따옴표로 감싸요. 여러 개를 받으면 "$ARGUMENTS"는 전체를 한 덩어리로 묶어 동작을 깨니, 따옴표 붙인 heredoc(<<\'EOF\' … EOF)으로 stdin에 넘겨 스크립트가 나누게 하거나 "$0" "$1"처럼 위치 인자를 각각 큰따옴표로 감싸요.');
  }
  if (!whole && hits.some((h) => /^\$(\d+|ARGUMENTS\[\d+\])$/.test(h))) parts.push('위치 인자는 "$0" "$1"처럼 각각 큰따옴표로 감싸요.');
  const named = hits.filter((h) => names.includes(h.slice(1)));
  if (named.length) parts.push(`arguments에 정의한 이름 인자는 ${[...new Set(named)].map((h) => `"${h}"`).join(' ')}처럼 각각 큰따옴표로 감싸요.`);
  return parts.join(' ');
}

export function X5(ctx) {
  const names = argumentNames(ctx.data);
  const findings = [];
  for (const sl of shellLines(ctx.body)) {
    const hits = unquotedArgs(sl.text, names);
    if (!hits.length) continue;
    findings.push(F('SKILL.md', ctx.bodyStartLine + sl.line, sl.text, 'MINOR',
      `${sl.where}에서 인자 ${[...new Set(hits)].join(', ')}를 따옴표 없이 셸 명령에 넣어요. Claude Code는 인자를 셸 해석 전에 글자 그대로 끼워 넣어서, 인자 속 공백·;·$(…)·백틱이 명령을 가르거나 다른 명령을 실행할 수 있어요.`,
      x5Fix(hits, names)));
  }
  return result(findings);
}

export const RULE_FNS = { S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12, T6, T7, C3, R3, R4, R6, R7, R8, R9, R11, X1, X2, X5 };
// frontmatter 값이 있어야 판정할 수 있는 규칙
export const NEEDS_VALUES = new Set(['S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'T6', 'T7', 'X2']);

export function finalize(id, title, r) {
  let sev = null;
  for (const f of r.findings) if (!sev || SEV_RANK[f.severity] > SEV_RANK[sev]) sev = f.severity;
  const out = { id, title, status: r.status, severity: r.status === 'fail' ? sev : null, findings: r.findings };
  if (r.note) out.note = r.note;
  return out;
}
