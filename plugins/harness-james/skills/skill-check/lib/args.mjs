// --args-stdin 모드의 입력 해석. 셸을 거치지 않고 인자를 받는다.
//   1줄째: 프로젝트 경로(${CLAUDE_PROJECT_DIR} 치환값). 비었거나 "${"로 시작하면(치환 안 됨) 무시하고 cwd.
//   2줄째부터 끝까지: 사용자 인자 원문. 끝 줄바꿈은 지운다.
// 토큰은 셸식 따옴표('…', "…", \)로만 나눈다. $, 백틱, 글롭 같은 확장은 하지 않는다.
// 따옴표 밖에서 시작하는 ~ 와 ~/ 만 홈으로 바꾼다.
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './context.mjs';

export class ArgsError extends Error {}

export const EMPTY_ARGS_ERROR = '검사할 스킬 디렉터리를 인자로 주세요. 예: /skill-check ~/.claude/skills/my-skill';

// 반환: [{value, tildeOk}] — tildeOk는 토큰이 따옴표 밖의 ~로 시작했는지
export function tokenize(src) {
  const out = [];
  let cur = '';
  let started = false;
  let tildeOk = false;
  let i = 0;
  const push = () => {
    if (started) out.push({ value: cur, tildeOk });
    cur = '';
    started = false;
    tildeOk = false;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { push(); i++; continue; }
    if (!started) { started = true; tildeOk = c === '~'; }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) throw new ArgsError('작은따옴표가 닫히지 않았어요');
      cur += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      i++;
      let closed = false;
      while (i < src.length) {
        const d = src[i];
        if (d === '"') { closed = true; i++; break; }
        if (d === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1])) {
          if (src[i + 1] !== '\n') cur += src[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
      if (!closed) throw new ArgsError('큰따옴표가 닫히지 않았어요');
      continue;
    }
    if (c === '\\') {
      if (i + 1 < src.length) {
        if (src[i + 1] !== '\n') cur += src[i + 1];
        else if (cur === '') started = false; // 줄 이어짐만 있는 자리
      }
      i += 2;
      continue;
    }
    cur += c;
    i++;
  }
  push();
  return out;
}

export function expandTilde(tok) {
  if (!tok.tildeOk) return tok.value;
  if (tok.value === '~') return homeDir();
  if (tok.value.startsWith('~/')) return path.join(homeDir(), tok.value.slice(2));
  return tok.value;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// stdin 전체 텍스트를 {projectDir, projectSource, dir, as, eval, notes}로 바꾼다. 문제가 있으면 ArgsError.
export function parseStdinArgs(text, cwd = process.cwd()) {
  const notes = [];
  const nl = text.indexOf('\n');
  const first = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, '');
  const rest = (nl < 0 ? '' : text.slice(nl + 1)).replace(/(\r?\n)+$/, '');
  let projectDir = cwd;
  let projectSource = 'cwd';
  const p = first.trim();
  if (p && !p.startsWith('${')) {
    const abs = path.resolve(cwd, p);
    if (isDir(abs)) {
      projectDir = abs;
      projectSource = 'stdin';
    } else {
      notes.push('1줄째 프로젝트 경로가 디렉터리가 아니어서 현재 디렉터리를 기준으로 썼어요');
    }
  }
  const toks = tokenize(rest);
  if (!toks.length) throw new ArgsError(EMPTY_ARGS_ERROR);
  const o = { projectDir, projectSource, dir: null, as: null, eval: false, notes };
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i].value;
    if (v === '--eval') o.eval = true;
    else if (v === '--as') {
      const n = toks[++i];
      if (!n) throw new ArgsError('--as 다음에 user나 project를 주세요');
      o.as = n.value;
    } else if (v.startsWith('--as=')) o.as = v.slice(5);
    else if (v.startsWith('--')) throw new ArgsError(`인자 모드에서 쓸 수 없는 옵션이에요: ${v.slice(0, 40)}`);
    else if (o.dir === null) o.dir = expandTilde(toks[i]);
    else throw new ArgsError(`스킬 디렉터리는 하나만 주세요: ${v.slice(0, 40)}`);
  }
  if (o.dir === null || o.dir === '') throw new ArgsError(EMPTY_ARGS_ERROR);
  if (o.as != null && o.as !== 'user' && o.as !== 'project') throw new ArgsError('--as는 user나 project만 받아요');
  o.dir = path.resolve(projectDir, o.dir);
  return o;
}

// stdin을 끝까지 읽는다. 터미널이면 기다리지 않고 빈 문자열.
export function readStdin(timeoutMs = 10000) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve(''); return; }
    const chunks = [];
    let size = 0;
    const done = () => { clearTimeout(t); resolve(Buffer.concat(chunks).toString('utf8')); };
    const t = setTimeout(() => { process.stdin.pause(); done(); }, timeoutMs);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= 1024 * 1024) chunks.push(c);
    });
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}
