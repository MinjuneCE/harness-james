// 기준 스킬은 모든 규칙을 통과하고, 규칙마다 일부러 망가뜨린 스킬(뮤턴트)은 그 규칙에 걸려야 한다(미탐 0).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { makeSkill, goodFiles, GOOD_SKILL_MD, MARK, fakeGithubToken, randAlnum, rule, HOME, PROJECT, TMP, BIN, ENV, ROOT, runCli } from './helpers.mjs';

const { runRules } = await import('../lib/check.mjs');
const { RULE_IDS } = await import('../lib/spec.mjs');
const { isoLocal, localDay } = await import('../lib/context.mjs');

const md = (fn) => fn(GOOD_SKILL_MD);
const withFm = (fm, body = '# 본문\n') => `---\n${fm}\n---\n${body}`;
const repl = (a, b) => (s) => {
  assert.ok(s.includes(a), `기준 SKILL.md에 ${a}가 없어요`);
  return s.replace(a, b);
};
const longText = (n) => '가'.repeat(n);
const ZW = String.fromCharCode(0x200b);

// [이름, 기대 규칙, 기대 심각도, 파일 바꾸기, 배치(dirName, where), 옵션]
const MUTANTS = [
  ['S1 깨진 YAML', 'S1', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('description: 샘플', 'description: "샘플')) })],
  ['S1 description이 맵', 'S1', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], 'description: {a: 1}\n')) })],
  ['S2 대문자·밑줄 이름', 'S2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', 'name: Bad_Name')) }), ['Bad_Name']],
  ['S2 제로폭 문자', 'S2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', `name: "good${ZW}skill"`)) })],
  ['S2 name 없음 + 나쁜 폴더명', 'S2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill\n', '')) }), ['Bad.Dir']],
  ['S2 65자 이름', 'S2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', `name: ${'a'.repeat(65)}`)) }), ['a'.repeat(65)]],
  ['S3 폴더명과 다름', 'S3', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', 'name: other-name')) })],
  ['S4 auto에 description 없음', 'S4', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], '')) })],
  ['S4 manual에 빈 description', 'S4', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], 'description: ""\ndisable-model-invocation: true\n')) })],
  ['S5 1,024자 초과', 'S5', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], `description: ${longText(1100)}\n`)) })],
  ['S5 합쳐서 1,536자 초과', 'S5', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], `description: ${longText(900)}\nwhen_to_use: ${longText(700)}\n`)) })],
  ['S6 XML 태그', 'S6', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('요청할 때 쓴다.', '요청할 때 쓴다. <example>리포트</example>')) })],
  ['S6 when_to_use의 HTML', 'S6', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('argument-hint:', 'when_to_use: "보고서 <br> 요청"\nargument-hint:')) })],
  ['S7 호출 키 오타', 'S7', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: high\ndisable-model-invocaton: true')) })],
  ['S7 밑줄 allowed_tools', 'S7', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('allowed-tools:', 'allowed_tools:')) })],
  ['S7 일반 키 오타', 'S7', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: high\nlicence: MIT')) })],
  ['S8 모르는 키', 'S8', 'MINOR', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: high\nowner-team: data')) })],
  ['S9 claude가 든 이름', 'S9', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', 'name: claude-helper')) }), ['claude-helper']],
  ['S9 synced 폴더', 'S9', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill\n', '')) }), ['synced']],
  ['S9 anthropic-skills', 'S9', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('name: good-skill', 'name: anthropic-skills')) }), ['anthropic-skills']],
  ['S10 effort 값', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: extreme')) })],
  ['S10 model 값', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('model: opus', 'model: gpt-4o')) })],
  ['S10 불리언 값', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('background: false', 'background: maybe')) })],
  ['S10 fork 없이 agent', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('context: fork\n', '')) })],
  ['S10 중복 키', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: high\neffort: low')) })],
  ['S10 shell 값', 'S10', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('effort: high', 'effort: high\nshell: zsh')) })],
  ['S11 없는 에이전트', 'S11', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('agent: helper-agent', 'agent: missing-agent')) })],
  ['S11 사용자 스킬이 프로젝트 전용 에이전트', 'S11', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('agent: helper-agent', 'agent: proj-agent')) })],
  ['S12 루트 README', 'S12', 'MINOR', (f) => ({ ...f, 'README.md': '# 읽어 주세요\n' })],
  ['T6 $ARGUMENTS인데 hint 없음', 'T6', 'MINOR', (f) => ({ ...f, 'SKILL.md': md(repl(/argument-hint: .*\n/.exec(GOOD_SKILL_MD)[0], '')) })],
  ['T6 이름 인자', 'T6', 'MINOR', (f) => ({ ...f, 'SKILL.md': withFm('name: good-skill\ndescription: 이름 인자를 쓰는 스킬. 테스트할 때 쓴다.\narguments: [mode]\ndisable-model-invocation: true', '# 본문\n\n모드는 $mode예요.\n'), 'bin/tool.mjs': null, 'lib/util.mjs': null, 'test/util.test.mjs': null, 'references/guide.md': null })],
  ['T7 긴 설명', 'T7', 'MINOR', (f) => ({ ...f, 'SKILL.md': md(repl(/description: .*\n/.exec(GOOD_SKILL_MD)[0], `description: ${longText(600)}\n`)) })],
  ['C3 501줄 본문', 'C3', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '줄\n'.repeat(500) })],
  ['R3 중첩 참조', 'R3', 'MAJOR', (f) => ({ ...f, 'references/guide.md': '# 가이드\n\n자세한 건 [깊은 문서](deep.md).\n', 'references/deep.md': '# 깊은 문서\n' })],
  ['R4 목차 없는 긴 문서', 'R4', 'MINOR', (f) => ({ ...f, 'references/guide.md': '# 가이드\n\n' + '설명 줄\n'.repeat(120) })],
  ['R6 JS 문법', 'R6', 'MAJOR', (f) => ({ ...f, 'lib/broken.mjs': 'export function (\n' })],
  ['R6 Workflow 본문 문법', 'R6', 'MAJOR', (f) => ({ ...f, 'workflow/run.mjs': 'export const meta = { name: "x" }\nconst a = await agent("p"\nreturn a\n', 'SKILL.md': GOOD_SKILL_MD + '\nworkflow/run.mjs\n' })],
  ['R6 Python 문법', 'R6', 'MAJOR', (f) => ({ ...f, 'scripts/broken.py': 'def f(:\n  pass\n', 'SKILL.md': GOOD_SKILL_MD + '\nscripts/broken.py\n' })],
  ['R6 셸 문법', 'R6', 'MAJOR', (f) => ({ ...f, 'scripts/broken.sh': 'if then fi\n', 'SKILL.md': GOOD_SKILL_MD + '\nscripts/broken.sh\n' })],
  ['R7 언급 없는 진입점', 'R7', 'MINOR', (f) => ({ ...f, 'scripts/hidden.mjs': "console.log('x');\n" })],
  ['R8 주석 미완성 표시', 'R8', 'MINOR', (f) => ({ ...f, 'lib/util.mjs': `// ${MARK}: 다듬기\nexport function hello() {\n  return 'hi';\n}\n` })],
  ['R8 문서 줄머리 표시', 'R8', 'MINOR', (f) => ({ ...f, 'references/guide.md': `# 가이드\n\n- ${MARK}: 표 채우기\n` })],
  ['R8 파이썬 주석', 'R8', 'MINOR', (f) => ({ ...f, 'scripts/x.py': `x = 1  # ${'FIX' + 'ME'} later\n`, 'SKILL.md': GOOD_SKILL_MD + '\nscripts/x.py\n' })],
  ['R9 테스트 없음', 'R9', 'MINOR', (f) => ({ ...f, 'test/util.test.mjs': null })],
  ['R11 홈 절대 경로', 'R11', 'MINOR', (f) => ({ ...f, 'lib/util.mjs': `export const P = '/Us' + 'ers/x';\nexport const Q = '${'/Users/' + 'alice/work/data.json'}';\nexport function hello() { return 'hi'; }\n` })],
  ['R11 역슬래시 경로', 'R11', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '\n`scripts\\run.py`를 실행해요.\n' })],
  ['X1 토큰(파일)', 'X1', 'BLOCKER', (f) => ({ ...f, 'lib/config.mjs': `export const token = "${fakeGithubToken()}";\n` })],
  ['X1 .env 관례 파일', 'X1', 'BLOCKER', (f) => ({ ...f, '.env': `SERVICE_API_KEY=${randAlnum(32)}\n` })],
  ['X2 파괴 명령', 'X2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('Bash(git status:*)', 'Bash(rm -' + 'rf:*)')) })],
  ['X2 와일드카드가 push를 품음', 'X2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('Bash(git status:*)', 'Bash(git:*)')) })],
  ['X2 Bash 전체 허용', 'X2', 'MAJOR', (f) => ({ ...f, 'SKILL.md': md(repl('Bash(git status:*)', 'Bash')) })],
  ['X2 목록형 force', 'X2', 'BLOCKER', (f) => ({ ...f, 'SKILL.md': md(repl('allowed-tools: Read Grep Bash(git status:*)', 'allowed-tools:\n  - Read\n  - "Bash(git push --for' + 'ce:*)"')) })],
  ['X5 bash 블록에 따옴표 없는 $ARGUMENTS', 'X5', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '\n```bash\nnode "${CLAUDE_SKILL_DIR}/bin/tool.mjs" $ARGUMENTS\n```\n' })],
  ['X5 언어 표시 없는 블록의 $1', 'X5', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '\n```\nnode bin/tool.mjs --in $1\n```\n' })],
  ['X5 한 줄 ! 주입', 'X5', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '\n결과: !`node ${CLAUDE_SKILL_DIR}/bin/tool.mjs $ARGUMENTS[0]`\n' })],
  ['X5 ```! 블록의 이름 인자', 'X5', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD.replace('effort: high', 'effort: high\narguments: [target]') + '\n```!\nnode bin/tool.mjs $target\n```\n' })],
  ['X5 따옴표 없는 heredoc 본문', 'X5', 'MINOR', (f) => ({ ...f, 'SKILL.md': GOOD_SKILL_MD + '\n```sh\nnode bin/tool.mjs <<EOF\n$ARGUMENTS\nEOF\n```\n' })],
];

test('기준 스킬은 fail도 error도 없다', async () => {
  const dir = makeSkill('good-skill', goodFiles());
  const r = await runRules(dir);
  assert.equal(r.ok, true);
  assert.equal(r.rules.length, 25);
  assert.deepEqual(r.rules.map((x) => x.id), RULE_IDS);
  const bad = r.rules.filter((x) => x.status === 'fail' || x.status === 'error');
  assert.deepEqual(bad, [], JSON.stringify(bad, null, 1));
  assert.deepEqual(r.types, ['auto', 'fork', 'code', 'docs']);
  assert.equal(r.target.scope, 'user');
  assert.equal(r.summary.blocker + r.summary.major + r.summary.minor, 0);
  const last = new Date(Date.UTC(2026, 9, 14));
  assert.deepEqual(r.usage, { usageCount: 3, lastUsedAt: isoLocal(last), lastUsedDay: localDay(last), source: '~/.claude.json skillUsage' });
  assert.ok(!JSON.stringify(r).includes('do-not-read'), '~/.claude.json의 다른 키가 새면 안 돼요');
  assert.equal(r.frontmatter.parsed, true);
  assert.ok(r.frontmatter.listingChars > 0);
});

test('규칙 25개마다 걸리는 뮤턴트가 있다', () => {
  const covered = new Set(MUTANTS.map((m) => m[1]));
  assert.deepEqual(RULE_IDS.filter((id) => !covered.has(id)), []);
});

test('뮤턴트는 모두 기대한 규칙과 심각도로 걸린다', { concurrency: 6 }, async (t) => {
  await Promise.all(MUTANTS.map(([title, id, sev, mutate, place]) =>
    t.test(`${id}: ${title}`, async () => {
      const [dirName, where] = place || ['good-skill', 'other'];
      const files = mutate(goodFiles());
      const dir = makeSkill(dirName, files, where || 'other');
      if ((where || 'other') === 'other') {
        // 기본 배치(other)에서도 helper-agent를 찾도록 스킬 옆 agents/를 둔다
        const ag = path.join(path.dirname(dir), 'agents');
        fs.mkdirSync(ag, { recursive: true });
        fs.writeFileSync(path.join(ag, 'helper-agent.md'), '---\nname: helper-agent\ndescription: x\n---\n');
      }
      const r = await runRules(dir, title.includes('프로젝트 전용') ? { as: 'user' } : {});
      assert.equal(r.ok, true, r.error);
      const x = rule(r, id);
      assert.equal(x.status, 'fail', `${id}가 걸리지 않았어요: ${JSON.stringify(x)}`);
      assert.equal(x.severity, sev, JSON.stringify(x.findings));
      for (const f of x.findings) {
        assert.ok(f.message && f.fix, 'message와 fix가 있어야 해요');
        assert.ok(f.message.length <= 300 && f.text.length <= 300);
      }
    })));
});

test('Workflow 본문(최상위 await·return)과 meta로 시작하는 보통 모듈은 R6를 통과한다', async () => {
  const files = goodFiles();
  files['workflow/run.mjs'] = '// 설명\nexport const meta = { name: "x", phases: [{ title: "A" }] }\nconst a = await agent("p", { phase: "A" })\nreturn { a }\n';
  files['lib/meta.mjs'] = 'export const meta = { v: 1 };\nexport function f() { return meta; }\n';
  files['SKILL.md'] = GOOD_SKILL_MD + '\nworkflow/run.mjs\n';
  const r = await runRules(makeSkill('good-skill', files));
  assert.equal(rule(r, 'R6').status, 'pass', JSON.stringify(rule(r, 'R6').findings));
});

test('뮤턴트 배치 확인: 프로젝트 스킬은 프로젝트 에이전트를 쓸 수 있다', async () => {
  const files = goodFiles();
  files['SKILL.md'] = GOOD_SKILL_MD.replace('agent: helper-agent', 'agent: proj-agent');
  const dir = makeSkill('good-skill', files, 'project');
  const r = await runRules(dir);
  assert.equal(r.target.scope, 'project');
  assert.equal(rule(r, 'S11').status, 'pass');
});

test('내장 에이전트와 빈 agent는 통과한다', async () => {
  for (const a of ['Explore', 'general-purpose', '']) {
    const files = goodFiles();
    files['SKILL.md'] = GOOD_SKILL_MD.replace('agent: helper-agent', a ? `agent: ${a}` : 'agent: ""');
    const r = await runRules(makeSkill('good-skill', files));
    assert.equal(rule(r, 'S11').status, 'pass', a);
  }
});

test('--as가 범위를 바꾼다', async () => {
  const dir = makeSkill('good-skill', goodFiles(), 'other');
  const r1 = await runRules(dir);
  assert.equal(r1.target.scope, 'other');
  assert.equal(r1.target.scopeSource, 'path');
  const r2 = await runRules(dir, { as: 'project' });
  assert.equal(r2.target.scope, 'project');
  assert.equal(r2.target.scopeSource, '--as');
});

test('manual 스킬은 auto 전용 규칙을 na로 둔다', async () => {
  const files = goodFiles();
  files['SKILL.md'] = GOOD_SKILL_MD.replace('effort: high', 'effort: high\ndisable-model-invocation: true');
  const r = await runRules(makeSkill('good-skill', files));
  assert.deepEqual(r.types.slice(0, 1), ['manual']);
  assert.equal(rule(r, 'T7').status, 'na');
});

test('S1이 frontmatter를 버리면 값 규칙은 na, 파서 한계는 error로 둔다', async () => {
  const files = goodFiles();
  files['SKILL.md'] = GOOD_SKILL_MD.replace('description: 샘플', 'description: "샘플');
  const r = await runRules(makeSkill('good-skill', files));
  assert.equal(rule(r, 'S1').status, 'fail');
  assert.equal(rule(r, 'S4').status, 'na');
  assert.equal(r.summary.blocker, 1);
});

test('summary는 항목 단위로 센다', async () => {
  const files = goodFiles();
  files['lib/a.mjs'] = `// ${MARK} 하나\n// ${MARK} 둘\n`;
  const r = await runRules(makeSkill('good-skill', files));
  assert.equal(rule(r, 'R8').findings.length, 2);
  assert.equal(r.summary.minor, 1);
});

test('다른 스킬 목록은 대상을 빼고 synced·.trash를 뺀다', async () => {
  makeSkill('other-a', { 'SKILL.md': withFm('name: other-a\ndescription: 다른 스킬 A. 테스트할 때 쓴다.') });
  makeSkill('synced', { 'SKILL.md': withFm('name: synced\ndescription: 빼야 함') });
  makeSkill('proj-b', { 'SKILL.md': withFm('name: proj-b\ndescription: 프로젝트 스킬 B\ndisable-model-invocation: true') }, 'project');
  const dir = makeSkill('good-skill', goodFiles());
  const r = await runRules(dir);
  const names = r.otherSkills.map((s) => s.name);
  assert.ok(names.includes('other-a'));
  assert.ok(names.includes('proj-b'));
  // 대상 자신(사용자 범위 good-skill)은 빠진다. 같은 이름의 프로젝트 스킬은 겹침 재료라 남는다.
  assert.ok(!r.otherSkills.some((s) => s.name === 'good-skill' && s.scope === 'user'));
  assert.ok(!names.includes('synced'));
  assert.equal(r.otherSkills.find((s) => s.name === 'proj-b').invocation, 'manual');
});

test('결과는 매번 같다(시각·소요 시간 제외)', async () => {
  const dir = makeSkill('good-skill', goodFiles());
  const strip = (r) => JSON.stringify({ ...r, generatedAt: null, elapsedMs: null });
  const a = await runRules(dir);
  const b = await runRules(dir);
  assert.equal(strip(a), strip(b));
});

test('홈 경로는 ~로 보이고, 프로파일이 적용된다', async () => {
  const r = await runRules(makeSkill('good-skill', goodFiles()));
  assert.ok(r.target.dir.startsWith('~/'), r.target.dir);
  assert.ok(r.profiles.some((p) => p.id === 'user-common'));
  assert.deepEqual(r.profiles.map((p) => p.id), ['user-common'], '함께 배포하는 프로파일은 user-common 하나예요');
  void HOME; void PROJECT;
});

// 프로젝트 경로로 고르는 프로파일은 합성 프로파일로 시험한다(배포본에는 특정 프로젝트용 프로파일이 없다).
function demoProfiles() {
  const dir = path.join(TMP, 'profiles-demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'profiles', 'user-common.json'), path.join(dir, 'user-common.json'));
  fs.writeFileSync(path.join(dir, 'demo-workspace.json'), JSON.stringify({
    id: 'demo-workspace', description: '합성 워크스페이스', appliesTo: ['~/Projects/demo-workspace/**'], forbidden: [], knownGuards: [],
  }));
  return dir;
}

test('프로젝트 경로에 맞는 프로파일도 적용하고, 같은 id는 한 번만 넣는다', async () => {
  const dir = makeSkill('good-skill', goodFiles());
  const ws = path.join(HOME, 'Projects', 'demo-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const saved = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = ws;
  process.env.SKILL_CHECK_PROFILES_DIR = demoProfiles();
  try {
    const r = await runRules(dir);
    const ids = r.profiles.map((p) => p.id);
    assert.deepEqual(ids.filter((x) => x === 'user-common'), ['user-common'], ids.join(','));
    assert.equal(r.profiles.find((p) => p.id === 'user-common').matchedBy, 'target');
    assert.equal(r.profiles.find((p) => p.id === 'demo-workspace').matchedBy, 'project');
    process.env.CLAUDE_PROJECT_DIR = saved;
    const r2 = await runRules(dir);
    assert.ok(!r2.profiles.some((p) => p.id === 'demo-workspace'), '다른 프로젝트에서는 빠져야 해요');
  } finally {
    process.env.CLAUDE_PROJECT_DIR = saved;
    delete process.env.SKILL_CHECK_PROFILES_DIR;
  }
});

test('--args-stdin 1줄째 프로젝트 경로로 프로파일을 고른다', () => {
  makeSkill('good-skill', goodFiles());
  const ws = path.join(HOME, 'Projects', 'demo-workspace');
  fs.mkdirSync(ws, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, 'rules', '--args-stdin'], {
    input: `${ws}\n~/.claude/skills/good-skill\n`, env: { ...process.env, ...ENV, SKILL_CHECK_PROFILES_DIR: demoProfiles() }, encoding: 'utf8', timeout: 60000,
  });
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true, r.stdout);
  assert.equal(j.profiles.find((p) => p.id === 'demo-workspace').matchedBy, 'project');
});

test('사용 시각은 로컬 시각이고, 날짜(MM/DD)도 로컬 기준이다', () => {
  makeSkill('good-skill', goodFiles());
  // 한국 시각 10/15 03:00 = UTC 10/14 18:00. UTC로 날짜를 내면 하루 전이 된다.
  const cj = path.join(TMP, 'claude-tz.json');
  fs.writeFileSync(cj, JSON.stringify({ skillUsage: { 'good-skill': { usageCount: 2, lastUsedAt: Date.UTC(2026, 9, 14, 18) } } }));
  const r = runCli(['rules', path.join(HOME, '.claude', 'skills', 'good-skill')], { TZ: 'Asia/Seoul', SKILL_CHECK_CLAUDE_JSON: cj });
  assert.equal(r.json.ok, true, r.stdout);
  assert.equal(r.json.usage.lastUsedAt, '2026-10-15T03:00:00+09:00');
  assert.equal(r.json.usage.lastUsedDay, '10/15');
  assert.match(r.json.generatedAt, /\+09:00$/);
});
