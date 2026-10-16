// X1: gitleaks가 기본, 정규식은 대체. 대상이 검사를 끌 수 없어야 한다. 가짜 비밀값은 실행 중에 만든다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSkill, goodFiles, fakeGithubToken, randAlnum, rule } from './helpers.mjs';

const { runRules } = await import('../lib/check.mjs');
const { findGitleaksBin } = await import('../lib/secrets.mjs');

const ALLOW = 'gitleaks' + ':allow';
const hasGitleaks = !!findGitleaksBin();

function withEnv(env, fn) {
  const old = {};
  for (const k of Object.keys(env)) { old[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => {
    for (const k of Object.keys(env)) { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
  });
}

test('gitleaks가 있으면 기본으로 쓰고 토큰을 잡는다', { skip: !hasGitleaks && 'gitleaks 없음' }, async () => {
  const tok = fakeGithubToken();
  const r = await runRules(makeSkill('good-skill', { ...goodFiles(), 'lib/config.mjs': `export const token = "${tok}";\n` }, 'other'));
  assert.equal(r.secretsScanner, 'gitleaks');
  const x = rule(r, 'X1');
  assert.equal(x.status, 'fail');
  assert.ok(x.findings.some((f) => f.file === 'lib/config.mjs' && f.line === 1 && f.severity === 'BLOCKER'));
  assert.ok(!JSON.stringify(r).includes(tok), '비밀값이 결과에 나오면 안 돼요');
});

test('대상 안의 .gitleaks.toml, .gitleaksignore, 허용 주석은 검사를 끄지 못하고 MINOR로 남는다', { skip: !hasGitleaks && 'gitleaks 없음' }, async () => {
  const tok = fakeGithubToken();
  const tok2 = fakeGithubToken();
  const files = {
    ...goodFiles(),
    'lib/config.mjs': `export const token = "${tok}";\n`,
    'lib/other.mjs': `export const t2 = "${tok2}"; // ${ALLOW}\n`,
    '.gitleaks.toml': '[allowlist]\npaths = [\'\'\'.*\'\'\']\n',
  };
  const dir = makeSkill('good-skill', files, 'other');
  // 지문을 모두 무시 목록에 넣어도 소용없어야 한다
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(path.join(dir, '.gitleaksignore'), ['lib/config.mjs:github-pat:1', 'lib/other.mjs:github-pat:1'].join('\n') + '\n');
  const r = await runRules(dir);
  const x = rule(r, 'X1');
  assert.equal(x.severity, 'BLOCKER');
  const blockers = x.findings.filter((f) => f.severity === 'BLOCKER').map((f) => f.file).sort();
  assert.deepEqual(blockers, ['lib/config.mjs', 'lib/other.mjs']);
  const minors = x.findings.filter((f) => f.severity === 'MINOR').map((f) => `${f.file}:${f.line}`).sort();
  assert.deepEqual(minors, ['.gitleaks.toml:0', '.gitleaksignore:0', 'lib/other.mjs:1']);
  assert.ok(r.notes.some((n) => n.includes('비밀값 검사 예외 설정')));
});

test('gitleaks가 없으면 정규식으로 대신하고 미탐 가능을 남긴다', async () => {
  await withEnv({ SKILL_CHECK_GITLEAKS: '' }, async () => {
    const files = {
      ...goodFiles(),
      'lib/config.mjs': `export const token = "${fakeGithubToken()}";\n`,
      'lib/aws.mjs': `const id = "${'AK' + 'IA' + randAlnum(16).toUpperCase().replace(/[^A-Z0-9]/g, 'Q')}";\n`,
      'lib/generic.py': `api_key = "${randAlnum(32)}"\n`,
      'keys/k.pem': ['-'.repeat(5) + 'BEGIN ' + 'RSA PRIVATE KEY' + '-'.repeat(5), randAlnum(64), '-'.repeat(5) + 'END RSA PRIVATE KEY' + '-'.repeat(5)].join('\n') + '\n',
      'http/x.private.env.json': JSON.stringify({ dev: { auth: randAlnum(24) } }),
      'lib/fine.mjs': 'const apiKey = process.env.API_KEY; const token = "<token>"; const password = "xxxxxxxxxxxx";\n',
    };
    const r = await runRules(makeSkill('good-skill', files, 'other'));
    assert.equal(r.secretsScanner, 'regex');
    const x = rule(r, 'X1');
    assert.match(x.note, /미탐 가능/);
    const hit = new Set(x.findings.map((f) => f.file));
    for (const f of ['lib/config.mjs', 'lib/aws.mjs', 'lib/generic.py', 'keys/k.pem', 'http/x.private.env.json']) assert.ok(hit.has(f), `${f}를 놓쳤어요`);
    assert.ok(!hit.has('lib/fine.mjs'), '자리표시를 비밀값으로 잡았어요');
  });
});

test('관례 파일 검사는 gitleaks가 있어도 돈다', { skip: !hasGitleaks && 'gitleaks 없음' }, async () => {
  const r = await runRules(makeSkill('good-skill', { ...goodFiles(), 'http/x.private.env.json': JSON.stringify({ dev: { auth: randAlnum(24) } }) }, 'other'));
  assert.ok(rule(r, 'X1').findings.some((f) => f.file === 'http/x.private.env.json'));
});
