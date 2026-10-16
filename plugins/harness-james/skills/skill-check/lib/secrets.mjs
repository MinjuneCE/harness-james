// X1 평문 비밀값 검사. gitleaks가 기본이고, gitleaks가 없거나 실패하면 정규식 토큰 검사로 대신한다.
// 관례 파일(.env 등) 검사와 예외 설정 탐지는 gitleaks 여부와 상관없이 언제나 돈다.
// 정규식은 미탐을 줄이는 쪽으로 맞추되, 자리표시와 테스트용 가짜 값은 걸러 낸다.
// 값은 결과에 남기지 않는다. 정규식은 앞 4자와 길이만, gitleaks는 --redact라 규칙 ID만 남는다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, whichSync } from './external.mjs';

const DASH5 = '-'.repeat(5);

// [id, 설명, 정규식(값은 캡처 그룹 1 또는 전체)]
const TOKEN_PATTERNS = [
  ['aws-access-key', 'AWS 액세스 키', /\b((?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16})\b/g],
  ['aws-secret-key', 'AWS 시크릿 키', /aws_?secret_?access_?key["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})/gi],
  ['private-key', '개인 키 블록', new RegExp(`${DASH5}BEGIN ((?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?)${DASH5}`, 'g')],
  ['github-token', 'GitHub 토큰', /\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,})\b/g],
  ['github-pat', 'GitHub 토큰', /\b(github_pat_[A-Za-z0-9_]{22,})/g],
  ['slack-token', 'Slack 토큰', /\b(xox[abposr]-[A-Za-z0-9-]{10,})/g],
  ['slack-webhook', 'Slack 웹훅', /(hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{8,})/g],
  ['shp-token', 'shp 접두 커머스 API 토큰', /\b(shp(?:at|ca|pa|ss|ua)_[a-fA-F0-9]{32})\b/g],
  ['anthropic-key', 'Anthropic 키', /\b(sk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{20,})/g],
  ['openai-key', 'OpenAI 키', /\b(sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{48})\b/g],
  ['google-api-key', 'Google API 키', /\b(AIza[0-9A-Za-z_-]{35})/g],
  ['google-oauth-secret', 'Google OAuth 시크릿', /\b(GOCSPX-[A-Za-z0-9_-]{28})/g],
  ['google-oauth-token', 'Google OAuth 토큰', /\b(ya29\.[0-9A-Za-z_-]{20,})/g],
  ['stripe-key', 'Stripe 키', /\b((?:sk|rk)_live_[0-9a-zA-Z]{24,})/g],
  ['npm-token', 'npm 토큰', /\b(npm_[A-Za-z0-9]{36})\b/g],
  ['jwt', 'JWT', /\b(eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/g],
  ['url-credentials', 'URL 안의 비밀번호', /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'<>]+:([^\s@/"'<>]{6,})@[^\s"'<>]+/g],
];

const SECRET_WORD = '(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|passwd|pwd|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credential)';
// key = "value" / "key": "value" / key: 'value'
const ASSIGN_QUOTED = new RegExp(`([A-Za-z0-9_.-]*${SECRET_WORD}[A-Za-z0-9_.-]*)["']?\\s*[:=]\\s*(["'\`])([^"'\`\\s]{8,})\\2`, 'gi');
// KEY=value (env 꼴, 따옴표 없음)
const ASSIGN_ENV = new RegExp(`^\\s*(?:export\\s+)?([A-Za-z0-9_]*${SECRET_WORD}[A-Za-z0-9_]*)\\s*=\\s*([^\\s#'"\`]{8,})`, 'gim');

const PLACEHOLDER_WORDS = /(example|sample|dummy|fake|placeholder|changeme|change[_-]?me|your[_-]|redacted|mock|stub|test|dev[_-]?only|not[_-]?a[_-]?real|insert|replace|todo|none|null|undefined|secret[_-]?here|token[_-]?here)/i;

export function mask(v) {
  const chars = Array.from(String(v));
  return `${chars.slice(0, 4).join('')}…(${chars.length}자)`;
}

function entropy(s) {
  const m = new Map();
  for (const c of s) m.set(c, (m.get(c) || 0) + 1);
  let h = 0;
  for (const n of m.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

// 자리표시·가짜 값이면 true
export function isPlaceholder(v) {
  const s = String(v);
  if (/^<[^>]*>$/.test(s) || /^\[[^\]]*\]$/.test(s)) return true;
  if (/\$\{|\{\{|%\(|process\.env|os\.environ|getenv|ENV\[/.test(s)) return true;
  if (/(x{4,}|X{4,}|\*{3,}|\.{3,}|…|0{8,}|1{8,})/.test(s)) return true;
  if (PLACEHOLDER_WORDS.test(s)) return true;
  const body = s.replace(/^[a-z]+[_-]/i, '');
  if (body.length >= 8 && entropy(body) < 2.5) return true;
  return false;
}

function looksGenericNonSecret(v) {
  const s = String(v);
  if (/^(\/|\.\/|\.\.\/|~\/|https?:\/\/|file:)/.test(s)) return true; // 경로, URL
  if (/^[a-z]+(-[a-z]+)+$/.test(s)) return true; // 헤더 이름 같은 케밥 단어
  if (/^[A-Z_]+$/.test(s)) return true; // 환경 변수 이름
  if (/^[a-z][a-zA-Z]*(\.[a-zA-Z]+)+$/.test(s)) return true; // obj.prop
  if (/^(true|false|null|bearer|basic)$/i.test(s)) return true;
  if (/\(\?|\\[sdwbSDW]|\|.*\|/.test(s)) return true; // 정규식 소스 같은 코드 조각
  if (entropy(s) < 3.0) return true;
  return false;
}

const CONVENTION_FILE = [
  [/(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/, (b) => !/\.(example|sample|template|dist|defaults)$/i.test(b)],
  [/\.private\.env\.json$/, () => true],
  [/(^|\/)(credentials|secrets?)\.(json|ya?ml|toml)$/i, () => true],
  [/(^|\/)(\.npmrc|\.netrc|\.pgpass)$/, () => true],
  [/(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, () => true],
  [/\.(p12|pfx|keystore|jks)$/i, () => true],
];

function isConventionFile(rel) {
  const base = path.basename(rel);
  return CONVENTION_FILE.some(([re, ok]) => re.test(rel) && ok(base));
}

function lineAt(text, idx) {
  let n = 1;
  for (let i = 0; i < idx; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

function jsonLeaves(v, keyPath, out) {
  if (typeof v === 'string') out.push({ key: keyPath, value: v });
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) jsonLeaves(x, keyPath ? `${keyPath}.${k}` : k, out);
}

// patterns=false면 관례 파일 검사만 한다(gitleaks가 정상으로 끝났을 때).
export function regexScan(files, { patterns = true } = {}) {
  const findings = [];
  const seen = new Set();
  const push = (f, line, kind, value, why) => {
    const key = `${f.path}:${line}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ file: f.path, line, kind, masked: value == null ? null : mask(value), why });
  };
  for (const f of files) {
    if (f.binary) {
      if (isConventionFile(f.path)) push(f, 0, 'convention-file', null, '비밀값을 담는 관례 파일(바이너리)이에요');
      continue;
    }
    const text = f.text;
    if (text == null) continue;
    if (patterns) for (const [id, desc, re] of TOKEN_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const v = m[1] || m[0];
        if (id !== 'private-key' && isPlaceholder(v)) continue;
        push(f, lineAt(text, m.index), id, id === 'private-key' ? null : v, `${desc} 형식이에요`);
      }
    }
    if (patterns) for (const re of [ASSIGN_QUOTED, ASSIGN_ENV]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const v = re === ASSIGN_QUOTED ? m[3] : m[2];
        if (isPlaceholder(v) || looksGenericNonSecret(v)) continue;
        push(f, lineAt(text, m.index), 'assignment', v, `비밀값 이름(${m[1].slice(0, 40)})에 긴 값이 들어 있어요`);
      }
    }
    if (isConventionFile(f.path)) {
      let leaves = [];
      if (f.path.endsWith('.json')) {
        try { jsonLeaves(JSON.parse(text), '', leaves); } catch { leaves = null; }
      }
      if (leaves) {
        for (const lf of leaves) {
          if (lf.value.length < 6 || isPlaceholder(lf.value) || /^(https?:\/\/|\/|\.\/)/.test(lf.value)) continue;
          if (!new RegExp(SECRET_WORD, 'i').test(lf.key) && entropy(lf.value) < 3.0) continue;
          const idx = text.indexOf(JSON.stringify(lf.value).slice(1, -1));
          push(f, idx >= 0 ? lineAt(text, idx) : 0, 'convention-file', lf.value, `비밀값 관례 파일의 값이에요 (${lf.key.slice(0, 60)})`);
        }
      } else {
        const lines = text.split('\n');
        lines.forEach((l, i) => {
          const m = /^\s*(?:export\s+)?[A-Za-z0-9_.-]+\s*[=:]\s*["']?([^"'\s#]{6,})/.exec(l) || /(_authToken|password|login)\s*[= ]\s*(\S{6,})/.exec(l);
          if (!m) return;
          const v = m[2] || m[1];
          if (isPlaceholder(v)) return;
          push(f, i + 1, 'convention-file', v, '비밀값 관례 파일의 값이에요');
        });
      }
    }
  }
  return findings;
}

const ALLOW_MARK = 'gitleaks' + ':allow';
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GITLEAKS_CONFIG = path.join(HERE, 'gitleaks.toml');
const EXCEPTION_FILES = new Set(['.gitleaks.toml', '.gitleaksignore']);
const ANSI_RE = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g'); // 터미널 색상 코드

export function findGitleaksBin() {
  if (process.env.SKILL_CHECK_GITLEAKS !== undefined) return process.env.SKILL_CHECK_GITLEAKS || null;
  const w = whichSync('gitleaks');
  if (w) return w;
  // ! 주입의 PATH에 Homebrew가 빠져 있을 수 있다
  for (const p of ['/opt/homebrew/bin/gitleaks', '/usr/local/bin/gitleaks']) if (fs.existsSync(p)) return p;
  return null;
}

// 대상이 스스로 검사를 끄려는 설정: .gitleaks.toml, .gitleaksignore, 인라인 허용 주석
export function findScanExceptions(files) {
  const out = [];
  for (const f of files) {
    const base = path.basename(f.path);
    if (EXCEPTION_FILES.has(base)) out.push({ file: f.path, line: 0, text: base });
    if (!f.text || f.binary) continue;
    const lines = f.text.split('\n');
    lines.forEach((l, i) => {
      if (l.includes(ALLOW_MARK)) out.push({ file: f.path, line: i + 1, text: ALLOW_MARK });
    });
  }
  return out;
}

// gitleaks 디렉터리 모드.
// 반환: {status: 'absent'} 설치 안 됨 · {status: 'ok', findings} · {status: 'failed', reason}
// 실패(0이 아닌 종료 코드, 시간 초과, 빈 출력, JSON이 아님, 복사 실패)는 '발견 없음'으로 읽지 않는다.
// 정상 실행은 --exit-code 0이라 늘 0으로 끝나고, 발견이 없어도 "[]"를 낸다(8.30.1에서 확인).
// 대상이 검사를 끌 수 없게: 걸어 둔 파일 목록을 임시 복사본으로 옮기고(예외 파일은 빼고),
// 우리 설정(--config)을 주고, 인라인 허용 주석을 무시하고, cwd와 -i를 빈 임시 디렉터리로 둔다.
// (gitleaks 8.30.1은 -i와 상관없이 검사 대상 폴더의 .gitleaksignore를 읽어서 복사본이 필요하다.)
export async function gitleaksScan(files) {
  const bin = findGitleaksBin();
  if (!bin) return { status: 'absent' };
  const timeout = Number(process.env.SKILL_CHECK_GITLEAKS_TIMEOUT_MS) || 30000;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-check-gl-'));
  const failed = (reason) => ({ status: 'failed', reason });
  try {
    const src = path.join(tmp, 'src');
    const empty = path.join(tmp, 'empty');
    fs.mkdirSync(empty);
    fs.mkdirSync(src);
    const notCopied = [];
    for (const f of files) {
      if (EXCEPTION_FILES.has(path.basename(f.path))) continue;
      if (f.unreadable) { notCopied.push(f.path); continue; }
      const to = path.join(src, f.path);
      try {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(f.abs, to);
      } catch {
        notCopied.push(f.path);
      }
    }
    if (notCopied.length) return failed(`검사용 복사본에 옮기지 못한 파일이 ${notCopied.length}개 있어요(${notCopied.slice(0, 3).join(', ')})`);
    const args = ['dir', src, '--config', GITLEAKS_CONFIG, '-i', empty, '--report-format', 'json', '--report-path', '-',
      '--redact', '--no-banner', '--log-level', 'error', '--exit-code', '0', '--ignore-gitleaks-allow', '--max-target-megabytes', '5'];
    const r = await run(bin, args, { timeout, cwd: empty });
    if (r.missing) return failed(`실행 파일을 찾지 못했어요(${bin})`);
    if (r.err && (r.err.killed || r.err.signal)) return failed(`시간 초과(${Math.round(timeout / 1000)}초)이거나 신호(${r.err.signal || 'kill'})로 멈췄어요`);
    if (r.code !== 0) {
      const msg = r.stderr.replace(ANSI_RE, '').trim().split('\n')[0].slice(0, 160);
      return failed(`종료 코드 ${r.code}${msg ? `: ${msg}` : ''}`);
    }
    if (!r.stdout.trim()) return failed('출력이 비었어요');
    let rows;
    try { rows = JSON.parse(r.stdout); } catch { return failed('출력이 JSON이 아니에요'); }
    if (!Array.isArray(rows)) return failed('출력이 JSON 배열이 아니에요');
    return {
      status: 'ok',
      findings: rows.map((x) => ({
        file: path.relative(src, path.resolve(src, x.File || '')).split(path.sep).join('/'),
        line: x.StartLine || 0,
        kind: `gitleaks:${x.RuleID || 'rule'}`,
        masked: null,
        why: `gitleaks 규칙 ${x.RuleID || ''}에 걸렸어요`,
      })),
    };
  } catch (e) {
    return failed(`실행 중 오류: ${e && e.message ? e.message : String(e)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
