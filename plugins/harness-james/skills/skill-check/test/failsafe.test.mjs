// 실패하면 통과가 아니라 드러내기: gitleaks가 실패해도 X1이 조용히 pass가 되면 안 된다.
// 공백과 한글이 든 설치 경로에서도 CLI가 정상 동작해야 한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT, ENV, TMP, makeSkill, goodFiles, fakeGithubToken, rule } from './helpers.mjs';
import { X1 } from '../lib/rules.mjs';
import { findGitleaksBin } from '../lib/secrets.mjs';

const FAKE = path.join(ROOT, 'test', 'fake-gitleaks.mjs');
fs.chmodSync(FAKE, 0o755);

function runBin(bin, dir, extraEnv = {}) {
  const r = spawnSync(process.execPath, [bin, 'rules', dir], { env: { ...process.env, ...ENV, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, json: JSON.parse(r.stdout) };
}

const MODES = ['exit2', 'empty', 'badjson', 'notarray', 'sleep'];

test('gitleaks가 실패하면 정규식으로 대신하고, 실패를 notes와 X1 note에 남긴다', { concurrency: 5 }, async (t) => {
  const tokenDir = makeSkill('good-skill', { ...goodFiles(), 'lib/config.mjs': `export const token = "${fakeGithubToken()}";\n` }, 'other');
  const cleanDir = makeSkill('good-skill', goodFiles(), 'other');
  for (const d of [tokenDir, cleanDir]) {
    const ag = path.join(path.dirname(d), 'agents');
    fs.mkdirSync(ag, { recursive: true });
    fs.writeFileSync(path.join(ag, 'helper-agent.md'), '---\nname: helper-agent\ndescription: x\n---\n');
  }
  await Promise.all(MODES.map((mode) => t.test(mode, () => {
    const env = { SKILL_CHECK_GITLEAKS: FAKE, FAKE_GITLEAKS_MODE: mode, SKILL_CHECK_GITLEAKS_TIMEOUT_MS: '1500' };
    // 비밀값이 있는 스킬: 정규식이 잡아서 BLOCKER
    const a = runBin(path.join(ROOT, 'bin', 'skill-check.mjs'), tokenDir, env);
    assert.equal(a.code, 0);
    assert.equal(a.json.ok, true, a.json.error);
    assert.equal(a.json.secretsScanner, 'regex', mode);
    const xa = rule(a.json, 'X1');
    assert.equal(xa.status, 'fail', `${mode}: X1이 조용히 통과했어요`);
    assert.equal(xa.severity, 'BLOCKER');
    assert.match(xa.note, /gitleaks 실패/);
    assert.ok(a.json.notes.some((n) => n.startsWith('gitleaks 실패')), JSON.stringify(a.json.notes));
    // 깨끗한 스킬: pass여도 실패 사실은 남는다
    const b = runBin(path.join(ROOT, 'bin', 'skill-check.mjs'), cleanDir, env);
    const xb = rule(b.json, 'X1');
    assert.equal(xb.status, 'pass');
    assert.match(xb.note, /gitleaks 실패/);
    assert.equal(b.json.secretsScanner, 'regex');
  })));
});

test('실패 사유가 모드마다 구체적이다', () => {
  const dir = makeSkill('good-skill', goodFiles(), 'other');
  const want = { exit2: /종료 코드 2: fake: config error/, empty: /출력이 비었어요/, badjson: /JSON이 아니에요/, notarray: /JSON 배열이 아니에요/, sleep: /시간 초과/ };
  for (const [mode, re] of Object.entries(want)) {
    const r = runBin(path.join(ROOT, 'bin', 'skill-check.mjs'), dir, { SKILL_CHECK_GITLEAKS: FAKE, FAKE_GITLEAKS_MODE: mode, SKILL_CHECK_GITLEAKS_TIMEOUT_MS: '1500' });
    assert.match(rule(r.json, 'X1').note, re, mode);
  }
});

test('가짜 gitleaks가 정상("[]")이면 gitleaks 결과로 쓴다', () => {
  const dir = makeSkill('good-skill', goodFiles(), 'other');
  const r = runBin(path.join(ROOT, 'bin', 'skill-check.mjs'), dir, { SKILL_CHECK_GITLEAKS: FAKE, FAKE_GITLEAKS_MODE: 'ok-empty' });
  assert.equal(r.json.secretsScanner, 'gitleaks');
  assert.ok(!r.json.notes.some((n) => n.includes('gitleaks 실패')));
});

test('없는 경로를 가리키면 실패로 드러난다', () => {
  const dir = makeSkill('good-skill', goodFiles(), 'other');
  const r = runBin(path.join(ROOT, 'bin', 'skill-check.mjs'), dir, { SKILL_CHECK_GITLEAKS: path.join(TMP, 'no-gitleaks') });
  assert.equal(r.json.secretsScanner, 'regex');
  assert.match(rule(r.json, 'X1').note, /gitleaks 실패: 실행 파일을 찾지 못했어요/);
});

test('정규식 검사까지 실패하면 X1은 error다', () => {
  const r = X1({ secrets: { scanner: 'regex', findings: [], exceptions: [], glFailure: '출력이 비었어요', error: '정규식 검사 실패: boom' } });
  assert.equal(r.status, 'error');
  assert.match(r.note, /gitleaks 실패: 출력이 비었어요; 정규식 검사 실패: boom/);
});

test('공백과 한글이 든 설치 경로와 대상 경로에서 CLI가 정상 동작한다', () => {
  const install = path.join(TMP, '설치 경로 with space', 'skill-check');
  fs.mkdirSync(install, { recursive: true });
  for (const d of ['bin', 'lib', 'profiles']) fs.cpSync(path.join(ROOT, d), path.join(install, d), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(install, 'package.json'));
  const target = path.join(TMP, '대상 폴더 a b', 'good-skill');
  fs.cpSync(makeSkill('good-skill', goodFiles(), 'other'), target, { recursive: true });
  fs.mkdirSync(path.join(TMP, '대상 폴더 a b', 'agents'), { recursive: true });
  fs.writeFileSync(path.join(TMP, '대상 폴더 a b', 'agents', 'helper-agent.md'), '---\nname: helper-agent\ndescription: x\n---\n');
  const realGl = findGitleaksBin();
  const r = runBin(path.join(install, 'bin', 'skill-check.mjs'), target);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.target.dirName, 'good-skill');
  assert.ok(r.json.profiles.some((p) => p.id === 'user-common'), '프로파일을 읽지 못했어요');
  const bad = r.json.rules.filter((x) => x.status === 'fail' || x.status === 'error');
  assert.deepEqual(bad, [], JSON.stringify(bad));
  if (realGl) {
    assert.equal(r.json.secretsScanner, 'gitleaks', JSON.stringify(r.json.notes));
    assert.ok(!r.json.notes.some((n) => n.includes('gitleaks 실패')), JSON.stringify(r.json.notes));
  }
  assert.ok(r.json.runFile);
});
