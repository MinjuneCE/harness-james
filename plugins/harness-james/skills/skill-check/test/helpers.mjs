// 테스트 공통: 임시 HOME·프로젝트·기록 경로를 잡고, 테스트 스킬을 실행 중에 만든다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'skill-check.mjs');

export const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skill-check-test-')));
export const HOME = path.join(TMP, 'home');
export const PROJECT = path.join(TMP, 'project');
export const RUNS = path.join(TMP, 'runs');
export const CLAUDE_JSON = path.join(TMP, 'claude.json');

fs.mkdirSync(path.join(HOME, '.claude', 'skills'), { recursive: true });
fs.mkdirSync(path.join(HOME, '.claude', 'agents'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.claude', 'skills'), { recursive: true });
fs.mkdirSync(path.join(PROJECT, '.claude', 'agents'), { recursive: true });
fs.writeFileSync(path.join(HOME, '.claude', 'agents', 'helper-agent.md'), '---\nname: helper-agent\ndescription: 테스트용 에이전트\n---\n본문\n');
fs.writeFileSync(path.join(PROJECT, '.claude', 'agents', 'proj-agent.md'), '---\nname: proj-agent\ndescription: 프로젝트 전용 에이전트\n---\n본문\n');
fs.writeFileSync(CLAUDE_JSON, JSON.stringify({
  otherKey: 'do-not-read',
  skillUsage: { 'good-skill': { usageCount: 3, lastUsedAt: Date.UTC(2026, 9, 14) } },
}));

export const ENV = {
  SKILL_CHECK_HOME: HOME,
  CLAUDE_PROJECT_DIR: PROJECT,
  SKILL_CHECK_RUNS_DIR: RUNS,
  SKILL_CHECK_CLAUDE_JSON: CLAUDE_JSON,
};
Object.assign(process.env, ENV);

// 테스트 비밀값은 실행 중에 무작위로 만든다(소스에 비밀값처럼 보이는 문자열을 두지 않기 위해).
export function randAlnum(n) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = crypto.randomBytes(n);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}
export const fakeGithubToken = () => 'gh' + 'p_' + randAlnum(36);

export const MARK = 'TO' + 'DO';

export const GOOD_SKILL_MD = `---
name: good-skill
description: 샘플 데이터를 리포트로 정리한다. 사용자가 샘플 리포트나 sample report를 요청할 때 쓴다.
argument-hint: "<입력 파일>"
context: fork
agent: helper-agent
background: false
effort: high
model: opus
allowed-tools: Read Grep Bash(git status:*)
---
# 좋은 스킬

\`node \${CLAUDE_SKILL_DIR}/bin/tool.mjs $ARGUMENTS\`로 실행한다.

형식을 정할 때 [가이드](references/guide.md)를 읽는다.

테스트: \`node --test test/\`
`;

export function goodFiles() {
  return {
    'SKILL.md': GOOD_SKILL_MD,
    'bin/tool.mjs': "#!/usr/bin/env node\nimport { hello } from '../lib/util.mjs';\nconsole.log(hello());\n",
    'lib/util.mjs': "export function hello() {\n  return 'hi';\n}\n",
    'test/util.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert';\nimport { hello } from '../lib/util.mjs';\ntest('hello', () => assert.equal(hello(), 'hi'));\n",
    'references/guide.md': '# 가이드\n\n표는 두 칸으로 만든다.\n',
  };
}

let seq = 0;
// where: 'user' | 'project' | 'other'
export function makeSkill(dirName, files, where = 'user') {
  const base = where === 'user' ? path.join(HOME, '.claude', 'skills')
    : where === 'project' ? path.join(PROJECT, '.claude', 'skills')
    : path.join(TMP, 'staging', String(++seq));
  const dir = path.join(base, dirName);
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(files)) {
    if (content == null) continue;
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function editSkillMd(md, fn) {
  return fn(md);
}

export function runCli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...process.env, ...ENV, ...extraEnv }, encoding: 'utf8', timeout: 60000 });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* 아래에서 실패 처리 */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

export function rule(result, id) {
  return result.rules.find((r) => r.id === id);
}
