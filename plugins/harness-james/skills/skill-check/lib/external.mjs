// 외부 명령을 쓰는 검사: S1(claude plugin validate), R6(문법 검사), CLI 버전.
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: opts.timeout || 20000, maxBuffer: 8 * 1024 * 1024, env: opts.env || process.env, cwd: opts.cwd }, (err, stdout, stderr) => {
      resolve({ err, code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), missing: err && err.code === 'ENOENT' });
    });
  });
}

function claudeBin() {
  return process.env.SKILL_CHECK_CLAUDE_BIN || 'claude';
}

export async function cliVersion() {
  const r = await run(claudeBin(), ['--version'], { timeout: 10000 });
  if (r.missing || r.code !== 0) return null;
  const m = /(\d+\.\d+\.\d+)/.exec(r.stdout);
  return m ? m[1] : null;
}

// SKILL.md 하나만 임시 디렉터리 <tmp>/skills/<name>/에 복사해 그 부모를 검사한다.
export async function validateSkill(skillMdText, dirName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-check-validate-'));
  try {
    const safe = dirName.replace(/[^A-Za-z0-9._-]/g, '_') || 'skill';
    const sd = path.join(tmp, 'skills', safe);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'SKILL.md'), skillMdText);
    const r = await run(claudeBin(), ['plugin', 'validate', '--json', tmp], { timeout: 30000 });
    if (r.missing) return { available: false, reason: 'claude CLI를 찾지 못했어요' };
    let rep;
    try { rep = JSON.parse(r.stdout); } catch {
      return { available: false, reason: `validate 출력을 읽지 못했어요 (종료 코드 ${r.code})` };
    }
    const entries = (rep.contents || []).filter((c) => c && typeof c.file === 'string' && c.file.endsWith(path.join('skills', safe, 'SKILL.md')));
    const errors = [];
    const warnings = [];
    for (const c of entries) {
      for (const e of c.errors || []) errors.push(e);
      for (const w of c.warnings || []) warnings.push(w);
    }
    return { available: true, errors, warnings };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let k = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (k < items.length) {
      const i = k++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

const PY_CHECK = [
  'import ast, json, sys',
  'out = []',
  'for p in sys.argv[1:]:',
  '    try:',
  '        with open(p, "rb") as fh:',
  '            ast.parse(fh.read(), p)',
  '    except SyntaxError as e:',
  '        out.append({"path": p, "line": e.lineno or 0, "msg": str(e.msg)})',
  '    except Exception as e:',
  '        out.append({"path": p, "line": 0, "msg": type(e).__name__ + ": " + str(e)})',
  'print(json.dumps(out))',
].join('\n');

// 반환: {results: [{file, line, message}], unavailable: [...]}
export async function checkSyntax(files) {
  const results = [];
  const unavailable = [];
  const js = files.filter((f) => /\.(mjs|cjs|js)$/.test(f.path));
  const py = files.filter((f) => /\.py$/.test(f.path));
  const sh = files.filter((f) => /\.(sh|bash)$/.test(f.path) || (!path.extname(f.path) && f.text && /^#!.*\b(ba)?sh\b/.test(f.text)));
  // Workflow 스크립트는 런타임이 본문을 async 함수로 감싸 돌리므로(최상위 return·await) 같은 방식으로 감싸 컴파일만 한다.
  // 감싼 컴파일이 실패하면 보통 모듈일 수 있으니 node --check도 돌려 둘 다 실패할 때만 Workflow 쪽 오류를 낸다.
  const wfErr = new Map();
  for (const f of js) if (f.text != null && WORKFLOW_HEAD.test(f.text)) wfErr.set(f, checkWorkflowSyntax(f.text));
  const needNode = js.filter((f) => !wfErr.has(f) || wfErr.get(f));
  const jsRes = await pool(needNode, 8, async (f) => ({ f, r: await run(process.execPath, ['--check', f.abs], { timeout: 15000 }) }));
  for (const { f, r } of jsRes) {
    const we = wfErr.get(f);
    if (we) {
      if (r.code !== 0) results.push({ file: f.path, line: we.line, message: we.message });
    } else if (r.code !== 0) {
      const m = new RegExp(`${escapeRe(f.abs)}:(\\d+)`).exec(r.stderr);
      const msg = (r.stderr.split('\n').find((l) => /Error/.test(l)) || r.stderr.trim().split('\n')[0] || 'node --check 실패').trim();
      results.push({ file: f.path, line: m ? Number(m[1]) : 0, message: msg });
    }
  }
  if (py.length) {
    const r = await run('python3', ['-I', '-c', PY_CHECK, ...py.map((f) => f.abs)], { timeout: 20000 });
    if (r.missing) unavailable.push('python3');
    else {
      try {
        for (const e of JSON.parse(r.stdout)) {
          const f = py.find((x) => x.abs === e.path);
          results.push({ file: f ? f.path : e.path, line: e.line, message: e.msg });
        }
      } catch {
        unavailable.push('python3 출력 해석 실패');
      }
    }
  }
  const shRes = await pool(sh, 8, async (f) => ({ f, r: await run('bash', ['-n', f.abs], { timeout: 10000 }) }));
  for (const { f, r } of shRes) {
    if (r.missing) { unavailable.push('bash'); continue; }
    if (r.code !== 0) {
      const m = /line (\d+)/.exec(r.stderr);
      results.push({ file: f.path, line: m ? Number(m[1]) : 0, message: r.stderr.trim().split('\n')[0].replace(f.abs, f.path) });
    }
  }
  return { results, unavailable, checked: js.length + py.length + sh.length };
}

// 앞의 셔뱅·주석·빈 줄을 건너 `export const meta`로 시작하면 Workflow 본문으로 본다.
export const WORKFLOW_HEAD = /^(?:#![^\n]*\n)?(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*export\s+const\s+meta\s*=/;

// 실행하지 않고 컴파일만 한다. 감싸는 머리를 첫 줄에 붙여 줄 번호를 원본과 맞춘다.
export function checkWorkflowSyntax(text) {
  // `export`만 지워 `const meta = ...`로 둔다. 셔뱅도 지운다(둘 다 줄 수는 그대로).
  const body = text.replace(/^#![^\n]*/, '').replace(/\bexport(?=\s+const\s+meta\s*=)/, '');
  try {
    new vm.Script(`(async function () {${body}\n})`, { filename: 'workflow.js' });
    return null;
  } catch (e) {
    const m = /workflow\.js:(\d+)/.exec(String(e.stack || ''));
    return { line: m ? Number(m[1]) : 0, message: `${e.name}: ${e.message}` };
  }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function whichSync(bin) {
  try {
    return execFileSync('/usr/bin/which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export { run };
