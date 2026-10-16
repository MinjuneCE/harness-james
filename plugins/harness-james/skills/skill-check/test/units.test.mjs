// 규칙 판정 기준의 단위 테스트 (외부 명령 없음)
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARK } from './helpers.mjs';
import { parseFrontmatterYaml } from '../lib/yaml.mjs';
import { findXmlTags, nearestKnownKey, hasToc, findMarks, splitTools, findArgUses, stripFences, unquotedArgs, shellLines, X5 } from '../lib/rules.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { isPlaceholder, mask } from '../lib/secrets.mjs';
import { globToRegExp } from '../lib/context.mjs';

test('YAML 부분 집합', () => {
  const ok = (src, data) => {
    const r = parseFrontmatterYaml(src);
    assert.equal(r.ok, true, `${src}: ${r.error}`);
    if (data) assert.deepEqual(r.data, data);
    return r;
  };
  ok('name: a\ndescription: "x: y"', { name: 'a', description: 'x: y' });
  ok("d: 'it''s'", { d: "it's" });
  ok('d: "tab\\tq\\"u"', { d: 'tab\tq"u' });
  ok('d: >-\n  one\n  two\n\n  three\ne: 1', { d: 'one two\nthree', e: 1 });
  ok('d: |\n  a\n  b\n', { d: 'a\nb\n' });
  ok('a: [x, "y, z", 3]', { a: ['x', 'y, z', 3] });
  ok('a:\n  - x\n  - y', { a: ['x', 'y'] });
  ok('a:\n- x\nb: c', { a: ['x'], b: 'c' });
  ok('h:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "echo"', { h: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo' }] }] } });
  ok('# 주석\na: 1 # 끝 주석', { a: 1 });
  ok('a: plain\n  continued', { a: 'plain continued' });
  ok('m: {k: v}', { m: { k: 'v' } });
  // Claude Code와 같은 재시도
  assert.equal(ok('d: x: y').retried, true);
  ok('d: [a, b', { d: '[a, b' });
  ok('d: @foo', { d: '@foo' });
  // 중복 키는 마지막 값
  const r = ok('a: 1\na: 2', { a: 2 });
  assert.equal(r.dups.length, 1);
  // 실패해야 하는 것
  for (const bad of ['d: "a" b', 'd: - a', 'd: "\\q"', 'a: "unterminated', ' a: 1\nb: [', 'a: 1\n\tb: 2']) {
    assert.equal(parseFrontmatterYaml(bad).ok, false, bad);
  }
});

test('S6 태그와 자리표시 구분', () => {
  const t = (s) => findXmlTags(s).tags;
  assert.deepEqual(t('a <example>b</example>'), ['<example>', '</example>']);
  assert.deepEqual(t('줄 <br> 바꿈'), ['<br>']);
  assert.deepEqual(t('self <x/> closing'), ['<x/>']);
  assert.deepEqual(t('<a href="u">링크'), ['<a href="u">']);
  assert.deepEqual(t('<custom>내용</custom>'), ['<custom>', '</custom>']);
  assert.deepEqual(t('<스킬 디렉터리>를 넣어요'), []);
  assert.deepEqual(t('<branch|sha> 또는 <리포트.json 경로>'), []);
  assert.deepEqual(t('`<file>` 하나'), []);
  assert.deepEqual(findXmlTags('<file>').placeholders, ['<file>']);
  assert.deepEqual(t('a < b > c'), []);
});

test('S7 오타 키 판정', () => {
  assert.equal(nearestKnownKey('disable-model-invocaton'), 'disable-model-invocation');
  assert.equal(nearestKnownKey('allowed_tools'), 'allowed-tools');
  assert.equal(nearestKnownKey('Allowed-Tools'), 'allowed-tools');
  assert.equal(nearestKnownKey('when-to-use'), 'when_to_use');
  assert.equal(nearestKnownKey('agnet'), 'agent');
  assert.equal(nearestKnownKey('owner-team'), null);
  assert.equal(nearestKnownKey('version'), null);
});

test('R4 목차 판정', () => {
  assert.equal(hasToc('# 제목\n\n## 목차\n- a\n'), true);
  assert.equal(hasToc('# Title\n\n## Contents\n'), true);
  assert.equal(hasToc('# T\n- [a](#a)\n- [b](#b)\n- [c](#c)\n'), true);
  assert.equal(hasToc('# T\n\n본문\n'), false);
  assert.equal(hasToc('# T\n' + '줄\n'.repeat(40) + '## 목차\n'), false);
});

test('R8 미완성 표시는 주석과 줄머리만 센다', () => {
  const marks = (path, text, kind) => findMarks({ path, text, kind }).map((x) => x.line);
  assert.deepEqual(marks('a.mjs', `const s = '${MARK}';\n// ${MARK}: x\n/* ${MARK} */\nfoo(); // ${MARK}\n`, 'code'), [2, 3, 4]);
  assert.deepEqual(marks('a.mjs', `/*\n * ${MARK}: x\n */\n`, 'code'), [2]);
  assert.deepEqual(marks('a.py', `s = "# ${MARK}"\nx = 1  # ${MARK}\n`, 'code'), [2]);
  assert.deepEqual(marks('d.md', `${MARK}: 남은 일\n- ${MARK} 항목\n문장 속 ${MARK}는 세지 않아요\n\`${MARK}\` 코드\n\`\`\`\n${MARK}\n\`\`\`\n<!-- ${MARK} -->\n`, 'doc'), [1, 2, 8]);
  assert.deepEqual(marks('n.txt', `${MARK} 첫 줄\n중간 ${MARK}\n`, 'other'), [1]);
  assert.deepEqual(marks('a.mjs', 'const XXXL = 1; // size XXXL\n', 'code'), []);
});

test('X2 allowed-tools 나누기', () => {
  assert.deepEqual(splitTools('Read Grep Bash(git status:*)'), ['Read', 'Grep', 'Bash(git status:*)']);
  assert.deepEqual(splitTools('Read, Bash(git log --oneline:*)'), ['Read', 'Bash(git log --oneline:*)']);
  assert.deepEqual(splitTools(['Read', ' Bash ']), ['Read', 'Bash']);
});

test('T6 인자 찾기는 이스케이프를 뺀다', () => {
  assert.deepEqual(findArgUses('a $ARGUMENTS b $ARGUMENTS[1] $0 $mode \\$1.00', ['mode']).map((x) => x.text), ['$ARGUMENTS', '$ARGUMENTS[1]', '$0', '$mode']);
  assert.deepEqual(findArgUses('${CLAUDE_SKILL_DIR} $HOME', []), []);
});

test('비밀값 자리표시 거르기와 가리기', () => {
  for (const v of ['<token>', 'xxxxxxxxxxxx', '${API_KEY}', 'your-api-key-here', 'dummy-secret-value', 'process.env.TOKEN', 'aaaaaaaaaaaaaaaa']) assert.equal(isPlaceholder(v), true, v);
  assert.equal(isPlaceholder('Zq8' + 'Lm2Kd9Rt5Wy1'), false);
  assert.equal(mask('abcdefgh'), 'abcd…(8자)');
});

test('프로파일 글롭', () => {
  assert.equal(globToRegExp('**').test('/a/b'), true);
  assert.equal(globToRegExp('/x/**').test('/x/y/z'), true);
  assert.equal(globToRegExp('/x/**').test('/xy/z'), false);
  assert.equal(globToRegExp('/x/*/s').test('/x/a/s'), true);
  assert.equal(globToRegExp('/x/*/s').test('/x/a/b/s'), false);
});

test('코드 블록 지우기는 줄 수를 지킨다', () => {
  const s = 'a\n```\nb\n```\nc';
  assert.equal(stripFences(s).split('\n').length, 5);
  assert.ok(!stripFences(s).includes('b'));
});

test('X5 따옴표 밖 인자 찾기', () => {
  const u = (l, n = []) => unquotedArgs(l, n);
  assert.deepEqual(u('node x.mjs $ARGUMENTS'), ['$ARGUMENTS']);
  assert.deepEqual(u('node x.mjs $ARGUMENTS[1] $0 $mode', ['mode']), ['$ARGUMENTS[1]', '$0', '$mode']);
  assert.deepEqual(u('node x.mjs "$ARGUMENTS" \'$1\' "a $0 b"'), []);
  assert.deepEqual(u('awk \'{print $1}\' f'), []);
  assert.deepEqual(u('echo \\$1 ${CLAUDE_SKILL_DIR} $HOME $mode2', ['mode']), []);
  assert.deepEqual(u('echo ok # $ARGUMENTS 주석'), []);
  assert.deepEqual(u('echo "a\\"b" $1'), ['$1']);
});

test('X5 셸 맥락: 셸 블록, ! 주입, 따옴표 heredoc 제외', () => {
  const body = [
    '산문 $ARGUMENTS는 셸이 아니에요',            // 0
    '```js', 'run($ARGUMENTS)', '```',              // 1-3
    '```bash', 'a $1', '```',                        // 4-6
    '```', 'b $2', '```',                            // 7-9
    '```!', "node x <<'ARGS'", '$ARGUMENTS', 'ARGS', 'after $3', '```', // 10-15
    '```sh', 'cat <<"E"', '$4', 'E', 'cat <<\\F', '$5', 'F', 'cat <<-\'G\'', '\t$6', '\tG', '```', // 16-26
    '인라인 !`node x $7` 끝',                          // 27
    '`node x $8` 는 주입이 아니에요',                  // 28
  ].join('\n');
  const hits = shellLines(body).filter((l) => unquotedArgs(l.text, []).length).map((l) => l.line);
  assert.deepEqual(hits, [5, 8, 14, 27]);
});

test('X5 규칙: skill-check 자신의 주입 꼴은 통과한다', () => {
  const body = "```!\nnode ${CLAUDE_SKILL_DIR}/bin/skill-check.mjs rules --args-stdin <<'SKILL_CHECK_ARGS'\n${CLAUDE_PROJECT_DIR}\n$ARGUMENTS\nSKILL_CHECK_ARGS\n```\n";
  assert.equal(X5({ data: {}, body, bodyStartLine: 5 }).status, 'pass');
  const bad = X5({ data: {}, body: '```bash\nnode x $ARGUMENTS\n```\n', bodyStartLine: 5 });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.findings[0].line, 6);
  assert.match(bad.findings[0].fix, /인자가 하나뿐이면 "\$ARGUMENTS"처럼 큰따옴표로 감싸요/);
  assert.match(bad.findings[0].fix, /여러 개를 받으면 .*heredoc.*stdin.*"\$0" "\$1"처럼 위치 인자를 각각 큰따옴표로/);
  const pos = X5({ data: {}, body: '```bash\nnode x $0 $ARGUMENTS[1]\n```\n', bodyStartLine: 1 });
  assert.equal(pos.findings[0].fix, '위치 인자는 "$0" "$1"처럼 각각 큰따옴표로 감싸요.');
  const named = X5({ data: { arguments: ['mode', 'target'] }, body: '```bash\nnode x $mode $target\n```\n', bodyStartLine: 1 });
  assert.equal(named.findings[0].fix, 'arguments에 정의한 이름 인자는 "$mode" "$target"처럼 각각 큰따옴표로 감싸요.');
  assert.ok(bad.findings[0].fix.length <= 300);
});

test('규칙 제목은 질문형이다', async () => {
  const { RULE_IDS, RULE_TITLES } = await import('../lib/spec.mjs');
  for (const id of RULE_IDS) assert.match(RULE_TITLES[id], /[은는인한했었]가$/, `${id}: ${RULE_TITLES[id]}`);
});

test('프로파일 hint에 낡기 쉬운 값(브랜치, 커밋, 날짜, 버전, 숫자 id)이 없다', () => {
  const dir = path.join(ROOT, 'profiles');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const fb of p.forbidden) {
      for (const h of fb.hints || []) {
        assert.doesNotMatch(h, /(^|[\s/])(feat|feature|fix|hotfix|release|chore|bugfix)\/[\w.-]+/, `${f} ${fb.id}: 브랜치 이름 ${h}`);
        assert.doesNotMatch(h, /\b[0-9a-f]{7,40}\b/, `${f} ${fb.id}: 커밋 SHA ${h}`);
        assert.doesNotMatch(h, /\b20\d\d[-.]?\d\d([-.]?\d\d)?\b/, `${f} ${fb.id}: 날짜·API 버전 ${h}`);
        assert.doesNotMatch(h, /\bv?\d+\.\d+(\.\d+)?\b/, `${f} ${fb.id}: 버전 ${h}`);
        assert.doesNotMatch(h, /\b\d{6,}\b/, `${f} ${fb.id}: 숫자 id ${h}`);
      }
    }
  }
});

test('Workflow 판별은 앞의 주석을 건너뛰고, 공백·주석이 길어도 빠르다(정규식 역추적 없음)', async () => {
  const { WORKFLOW_HEAD, checkWorkflowSyntax } = await import('../lib/external.mjs');
  assert.ok(WORKFLOW_HEAD.test('#!/usr/bin/env node\n/* 설명 */\n// 메모\n\nexport const meta = {}\n'));
  assert.ok(!WORKFLOW_HEAD.test('import x from "y";\nexport const meta = {}\n'));
  assert.equal(checkWorkflowSyntax('export const meta = {}\nconst a = await agent("p")\nreturn a\n'), null);
  assert.equal(checkWorkflowSyntax('export const meta = {}\nconst a = = 1\nreturn a\n').line, 2);
  const t0 = Date.now();
  for (const text of [' '.repeat(50000) + 'x', '// 주석\n'.repeat(20000) + 'x', '/*' + ' '.repeat(50000)]) assert.ok(!WORKFLOW_HEAD.test(text));
  assert.ok(Date.now() - t0 < 500, `${Date.now() - t0}ms`);
});
