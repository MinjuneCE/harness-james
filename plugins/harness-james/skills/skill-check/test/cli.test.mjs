// CLI: 어떤 입력에서도 종료 코드 0, 오류는 JSON으로. 기록·옵션·크기 제한.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli, makeSkill, goodFiles, TMP, RUNS, HOME } from './helpers.mjs';

test('없는 경로', () => {
  const r = runCli(['rules', path.join(TMP, 'nope')]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /경로를 찾지 못했어요/);
});

test('빈 디렉터리(SKILL.md 없음)', () => {
  const d = path.join(TMP, 'empty-dir');
  fs.mkdirSync(d, { recursive: true });
  const r = runCli(['rules', d]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /SKILL\.md/);
});

test('권한 없는 SKILL.md', { skip: process.getuid && process.getuid() === 0 ? 'root는 권한을 무시해요' : false }, () => {
  const d = makeSkill('locked', { 'SKILL.md': '---\nname: locked\ndescription: x\n---\n' }, 'other');
  fs.chmodSync(path.join(d, 'SKILL.md'), 0o000);
  try {
    const r = runCli(['rules', d]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, false);
  } finally {
    fs.chmodSync(path.join(d, 'SKILL.md'), 0o644);
  }
});

test('권한 없는 하위 폴더는 note로 남기고 계속한다', { skip: process.getuid && process.getuid() === 0 }, () => {
  const d = makeSkill('locked-sub', { 'SKILL.md': '---\nname: locked-sub\ndescription: 잠긴 폴더 테스트. 테스트할 때 쓴다.\n---\n', 'sub/a.md': '# a\n' }, 'other');
  fs.chmodSync(path.join(d, 'sub'), 0o000);
  try {
    const r = runCli(['rules', d]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.ok(r.json.notes.some((n) => n.includes('디렉터리를 읽지 못했어요')));
  } finally {
    fs.chmodSync(path.join(d, 'sub'), 0o755);
  }
});

test('바이너리 SKILL.md', () => {
  const d = path.join(TMP, 'bin-skill');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), Buffer.from([0, 1, 2, 255, 0, 10]));
  const r = runCli(['rules', d]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /바이너리/);
});

test('파일을 디렉터리 대신 주면', () => {
  const f = path.join(TMP, 'a-file.txt');
  fs.writeFileSync(f, 'x');
  const r = runCli(['rules', f]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, false);
});

test('잘못된 명령과 옵션', () => {
  for (const args of [[], ['nope'], ['rules'], ['rules', TMP, '--as', 'team'], ['rules', TMP, '--bogus'], ['rules', TMP, TMP]]) {
    const r = runCli(args);
    assert.equal(r.code, 0, args.join(' '));
    assert.equal(r.json.ok, false, args.join(' '));
  }
});

test('claude CLI가 없으면 S1은 error, 나머지는 계속', () => {
  const d = makeSkill('good-skill', goodFiles(), 'other');
  const r = runCli(['rules', d], { SKILL_CHECK_CLAUDE_BIN: path.join(TMP, 'no-claude') });
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  const s1 = r.json.rules.find((x) => x.id === 'S1');
  assert.equal(s1.status, 'error');
  assert.equal(r.json.cliVersion, null);
  assert.equal(r.json.rules.find((x) => x.id === 'S3').status, 'pass');
});

test('정상 실행: 기록, --eval, --out, ~ 경로, 상대 경로', () => {
  const d = makeSkill('good-skill', goodFiles());
  const out = path.join(TMP, 'out.json');
  const before = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).length : 0;
  const rel = path.relative(process.cwd(), d);
  const r = runCli(['rules', rel, '--eval', '--out', out]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.evalRequested, true);
  assert.equal(r.json.tool, 'skill-check');
  assert.equal(r.json.version, '0.2.1');
  assert.equal(r.json.rubricVersion, '0.2');
  assert.match(r.json.generatedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.ok(fs.existsSync(out));
  const runs = fs.readdirSync(RUNS);
  assert.equal(runs.length, before + 1);
  assert.match(runs[runs.length - 1], /^\d{8}-\d{6}-good-skill\.json$/);
  assert.equal(r.json.runFile, path.join(RUNS, runs[runs.length - 1]));
  // ~ 해석: SKILL_CHECK_HOME 기준
  const r2 = runCli(['rules', '~/.claude/skills/good-skill']);
  assert.equal(r2.json.ok, true, r2.json.error);
  assert.equal(r2.json.target.scope, 'user');
  void HOME;
});

test('출력은 30KB 이하로 줄인다', () => {
  const files = goodFiles();
  for (let i = 0; i < 60; i++) files[`notes/n${i}.md`] = '# n\n' + '긴 줄\n'.repeat(120);
  for (let i = 0; i < 400; i++) files[`data/f${i}.txt`] = 'x\n';
  for (let i = 0; i < 30; i++) makeSkill(`filler-${i}`, { 'SKILL.md': `---\nname: filler-${i}\ndescription: ${'설명 '.repeat(200)}\n---\n` });
  const d = makeSkill('big-skill', { ...files, 'SKILL.md': files['SKILL.md'].replace('name: good-skill', 'name: big-skill') });
  const r = runCli(['rules', d]);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(r.json)) <= 30 * 1024, `크기 ${Buffer.byteLength(JSON.stringify(r.json))}`);
  for (const s of r.json.otherSkills) assert.ok(s.description.length <= 300);
  void os;
});
