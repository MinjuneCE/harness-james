// 느린 테스트: 내장 YAML 파서와 `claude plugin validate`가 같은 입력에서 같은 판단(파싱 성공/실패)을 하는지 본다.
// claude CLI가 없으면 건너뛴다. 케이스를 한 디렉터리에 모아 validate를 한 번만 부른다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFrontmatterYaml } from '../lib/yaml.mjs';
import { splitFrontmatter } from '../lib/context.mjs';

const CASES = {
  'colon-in-quotes': 'name: a\ndescription: "x: y"',
  'colon-plain': 'name: a\ndescription: x: y',
  'colon-plain-2': 'name: a\ndescription: Use when: the user asks',
  'single-quote-escape': "name: a\ndescription: 'it''s: fine'",
  'double-escape': 'name: a\ndescription: "tab\\t and \\u00e9"',
  'bad-escape': 'name: a\ndescription: "bad \\q"',
  'unterminated': 'name: a\ndescription: "open',
  'after-quote': 'name: a\ndescription: "a" b',
  'folded': 'name: a\ndescription: >-\n  one\n  two',
  'literal-keep': 'name: a\ndescription: |+\n  one\n\n',
  'literal-indent': 'name: a\ndescription: |2\n    indented\n  base',
  'flow-seq': 'name: a\ndescription: d\nallowed-tools: [Read, "Bash(git status:*)"]',
  'flow-unclosed': 'name: a\ndescription: [a, b',
  'flow-map-desc': 'name: a\ndescription: {a: 1}',
  'block-seq': 'name: a\ndescription: d\npaths:\n  - "**/*.md"\n  - src/**',
  'block-seq-same-indent': 'name: a\ndescription: d\npaths:\n- a\n- b',
  'nested-hooks': 'name: a\ndescription: d\nhooks:\n  PreToolUse:\n    - matcher: Bash\n      hooks:\n        - type: command\n          command: "node x.mjs"',
  'metadata': 'name: a\ndescription: d\nmetadata:\n  owner: me\n  tags: [x, y]',
  'comments': '# head\nname: a # c\ndescription: d # e\n# tail',
  'dup-key': 'name: a\ndescription: d\ndescription: e',
  'leading-dash': 'name: a\ndescription: - item',
  'at-sign': 'name: a\ndescription: @mention',
  'backtick': 'name: a\ndescription: `code` first',
  'alias': 'name: a\ndescription: *ref',
  'tag': 'name: a\ndescription: !foo bar',
  'percent': 'name: a\ndescription: %x',
  'hash-no-space': 'name: a\ndescription: C#lang',
  'tab-indent': 'name: a\ndescription: d\n\tfoo: 1',
  'bad-indent': 'name: a\n  description: d\n bad: x',
  'plain-continued': 'name: a\ndescription: first\n  second line',
  'empty-value': 'name: a\ndescription: d\nmetadata:',
  'korean': 'name: a\ndescription: 한국어 설명: 콜론 포함',
  'url': 'name: a\ndescription: see https://example.com/x',
  'bool-yes': 'name: a\ndescription: d\ndisable-model-invocation: yes',
  'quoted-key': 'name: a\n"description": d',
  'question-plain': 'name: a\ndescription: ?what',
  'brace-in-middle': 'name: a\ndescription: uses {braces} inside',
  'multi-doc-dash': 'name: a\ndescription: d\n---extra: 1',
};

const claude = process.env.SKILL_CHECK_CLAUDE_BIN || 'claude';
const has = spawnSync(claude, ['--version'], { encoding: 'utf8' }).status === 0;

test('내장 파서와 claude plugin validate의 파싱 판단이 같다', { skip: !has && 'claude CLI 없음', timeout: 60000 }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-check-eq-'));
  try {
    for (const [k, fm] of Object.entries(CASES)) {
      const d = path.join(tmp, 'skills', k);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'SKILL.md'), `---\n${fm}\n---\n본문\n`);
    }
    const r = spawnSync(claude, ['plugin', 'validate', '--json', tmp], { encoding: 'utf8', timeout: 60000 });
    const rep = JSON.parse(r.stdout);
    const vErr = {};
    for (const c of rep.contents || []) {
      const k = path.basename(path.dirname(c.file));
      vErr[k] = (c.errors || []).map((e) => e.path);
    }
    const diffs = [];
    for (const k of Object.keys(CASES)) {
      const text = fs.readFileSync(path.join(tmp, 'skills', k, 'SKILL.md'), 'utf8');
      const fm = splitFrontmatter(text);
      const ours = parseFrontmatterYaml(fm.yaml);
      const validateParses = !(vErr[k] || []).includes('frontmatter');
      if (validateParses !== ours.ok) diffs.push(`${k}: validate=${validateParses} ours=${ours.ok}${ours.ok ? '' : ` (${ours.error})`}`);
      // validate가 description 타입 오류를 내면 우리도 문자열이 아니어야 한다
      if ((vErr[k] || []).includes('description') && ours.ok) assert.notEqual(typeof ours.data.description, 'string', k);
    }
    assert.deepEqual(diffs, []);
    // 테스트가 헛돌지 않도록: 실패 쪽 케이스도 충분히 있어야 한다
    const failing = Object.keys(CASES).filter((k) => (vErr[k] || []).includes('frontmatter'));
    assert.ok(failing.length >= 5, `validate 실패 케이스가 ${failing.length}개뿐이에요: ${failing.join(', ')}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
