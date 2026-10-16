// --args-stdin: 인자는 셸을 거치지 않고 경로 토큰으로만 다뤄져야 하고, 종료 코드는 언제나 0이다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { BIN, ENV, TMP, HOME, PROJECT, makeSkill, goodFiles } from './helpers.mjs';
import { tokenize, parseStdinArgs, EMPTY_ARGS_ERROR, ArgsError } from '../lib/args.mjs';

function runStdin(input, extraEnv = {}, cwd = TMP) {
  const r = spawnSync(process.execPath, [BIN, 'rules', '--args-stdin'], { input, cwd, env: { ...process.env, ...ENV, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 아래 assert에서 드러난다 */ }
  return { code: r.status, json, stdout: r.stdout };
}

const CANARY = path.join(TMP, 'canary');
const touched = () => fs.existsSync(CANARY);
const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;

test('토큰 분리: 따옴표와 역슬래시만 해석하고 확장은 하지 않는다', () => {
  const v = (s) => tokenize(s).map((t) => t.value);
  assert.deepEqual(v('a b\tc'), ['a', 'b', 'c']);
  assert.deepEqual(v(`'a b' "c d" e\\ f`), ['a b', 'c d', 'e f']);
  assert.deepEqual(v('"x\\"y" \'$HOME\' $HOME `id` $(id)'), ['x"y', '$HOME', '$HOME', '`id`', '$(id)']);
  assert.deepEqual(v('"a\\$b\\`c\\\\d\\n"'), ['a$b`c\\d\\n']);
  assert.deepEqual(v("a'b'c"), ['abc']);
  assert.deepEqual(v("''"), ['']);
  assert.deepEqual(v('a\\\nb'), ['ab']);
  assert.deepEqual(v('a\nb'), ['a', 'b']);
  assert.throws(() => tokenize("'open"), ArgsError);
  assert.throws(() => tokenize('"open'), ArgsError);
});

test('stdin 해석: 1줄째 프로젝트, ~ 확장, 상대 경로 기준', () => {
  const a = parseStdinArgs(`${PROJECT}\nsub/dir --as user --eval\n`, TMP);
  assert.equal(a.projectSource, 'stdin');
  assert.equal(a.dir, path.join(PROJECT, 'sub/dir'));
  assert.equal(a.as, 'user');
  assert.equal(a.eval, true);
  for (const first of ['', '${CLAUDE_PROJECT_DIR}', path.join(TMP, 'no-such-dir')]) {
    const b = parseStdinArgs(`${first}\nrel\n`, TMP);
    assert.equal(b.projectDir, TMP, first);
    assert.equal(b.dir, path.join(TMP, 'rel'));
  }
  assert.equal(parseStdinArgs('\n~/x\n', TMP).dir, path.join(HOME, 'x'));
  assert.equal(parseStdinArgs('\n~\n', TMP).dir, HOME);
  assert.equal(parseStdinArgs("\n'~/x'\n", TMP).dir, path.join(TMP, '~/x'), '따옴표 안의 ~는 그대로');
  assert.equal(parseStdinArgs('\n~other/x\n', TMP).dir, path.join(TMP, '~other/x'), '~user 꼴은 확장하지 않음');
  for (const bad of ['', '\n', 'p\n', 'p\n   \n', 'p\n""\n']) assert.throws(() => parseStdinArgs(bad, TMP), (e) => e.message === EMPTY_ARGS_ERROR, JSON.stringify(bad));
  assert.throws(() => parseStdinArgs('\na --out /tmp/x\n', TMP), ArgsError);
  assert.throws(() => parseStdinArgs('\na b\n', TMP), ArgsError);
  assert.throws(() => parseStdinArgs('\na --as team\n', TMP), ArgsError);
});

test('정상 실행: 상대 경로는 1줄째 프로젝트 기준, runFile이 남는다', () => {
  makeSkill('good-skill', goodFiles(), 'project');
  const r = runStdin(`${PROJECT}\n.claude/skills/good-skill --eval\n`);
  assert.equal(r.code, 0);
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.target.scope, 'project');
  assert.equal(r.json.evalRequested, true);
  assert.ok(r.json.runFile, 'runFile이 있어야 해요');
  assert.ok(fs.existsSync(r.json.runFile.replace(/^~(?=\/)/, HOME)), r.json.runFile);
});

test('프로젝트 스킬 목록(T4)은 1줄째 프로젝트에서 찾는다', () => {
  const p2 = path.join(TMP, 'project2');
  fs.mkdirSync(path.join(p2, '.claude', 'skills', 'p2-skill'), { recursive: true });
  fs.writeFileSync(path.join(p2, '.claude', 'skills', 'p2-skill', 'SKILL.md'), '---\nname: p2-skill\ndescription: 두 번째 프로젝트 스킬\n---\n');
  const dir = makeSkill('good-skill', goodFiles());
  const r = runStdin(`${p2}\n${dir}\n`);
  assert.equal(r.json.ok, true, r.json.error);
  assert.ok(r.json.otherSkills.some((s) => s.name === 'p2-skill' && s.scope === 'project'));
});

test('~ 경로는 홈으로 풀린다', () => {
  makeSkill('good-skill', goodFiles());
  const r = runStdin('${CLAUDE_PROJECT_DIR}\n~/.claude/skills/good-skill\n');
  assert.equal(r.json.ok, true, r.json.error);
  assert.equal(r.json.target.scope, 'user');
});

test('인자가 비면 ok:false 오류 JSON, 종료 코드 0', () => {
  for (const input of ['', `${PROJECT}\n`, `${PROJECT}\n\n\n`, `${PROJECT}`]) {
    const r = runStdin(input);
    assert.equal(r.code, 0);
    assert.deepEqual({ ok: r.json.ok, error: r.json.error }, { ok: false, error: EMPTY_ARGS_ERROR }, JSON.stringify(input));
  }
});

test('악의적 인자는 실행되지 않고 토큰으로만 다뤄진다', () => {
  const payloads = [
    `x\nEOF\ntouch ${CANARY}`,
    `x\n'\nEOF\ntouch ${CANARY}\n`,
    `$(touch ${CANARY})`,
    `"$(touch ${CANARY})"`,
    `\`touch ${CANARY}\``,
    `x; touch ${CANARY}`,
    `x && touch ${CANARY} || touch ${CANARY}`,
    `x | touch ${CANARY}`,
    `'x' "y" ${CANARY}`,
    `x' ; touch ${CANARY} ; '`,
    `"unterminated $(touch ${CANARY})`,
    `--out ${CANARY}`,
    `x --out=${CANARY}`,
    `${'a '.repeat(500)}`,
  ];
  for (const p of payloads) {
    const r = runStdin(`${PROJECT}\n${p}\n`);
    assert.equal(r.code, 0, p);
    assert.ok(r.json, `JSON이 아니에요: ${p}`);
    assert.equal(touched(), false, `명령이 실행됐어요: ${p}`);
    if (r.json.ok) assert.ok(!r.json.target.dir.includes('\n'));
  }
});

test('특수 문자가 든 실제 경로도 한 토큰으로 검사한다', () => {
  const weird = `we ird $(touch ${path.basename(CANARY)}) \`id\` 'q' "d"`;
  const dir = makeSkill(weird, goodFiles(), 'other');
  const ag = path.join(path.dirname(dir), 'agents');
  fs.mkdirSync(ag, { recursive: true });
  fs.writeFileSync(path.join(ag, 'helper-agent.md'), '---\nname: helper-agent\ndescription: x\n---\n');
  for (const arg of [sq(dir), dir.replace(/([\s$`'"\\])/g, '\\$1')]) {
    const r = runStdin(`${PROJECT}\n${arg}\n`, {}, path.dirname(dir));
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true, `${arg}: ${r.json.error}`);
    assert.equal(r.json.target.dirName, weird);
    assert.equal(touched(), false);
    assert.equal(fs.existsSync(path.join(path.dirname(dir), path.basename(CANARY))), false);
  }
});

test('--args-stdin과 위치 인자를 섞으면 오류 JSON', () => {
  const r = spawnSync(process.execPath, [BIN, 'rules', '--args-stdin', TMP], { input: '\nx\n', env: { ...process.env, ...ENV }, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).ok, false);
});
