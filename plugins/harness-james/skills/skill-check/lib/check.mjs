// 1단계 전체 흐름: 유형 판별 → plugin validate → 자체 규칙 → 사용량 → 다른 스킬 목록 → JSON
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_VERSION, RUBRIC_VERSION, RULE_IDS, RULE_TITLES, OUTPUT_MAX_BYTES, MAX_FINDINGS_PER_RULE } from './spec.mjs';
import { walkSkill } from './files.mjs';
import { parseFrontmatterYaml } from './yaml.mjs';
import { splitFrontmatter, detectScope, collectOtherSkills, collectAgents, readUsage, loadProfiles, isTrueish, expandHome, tildify, isoLocal, realpathOr } from './context.mjs';
import { validateSkill, checkSyntax, cliVersion } from './external.mjs';
import { regexScan, gitleaksScan, findScanExceptions } from './secrets.mjs';
import { RULE_FNS, NEEDS_VALUES, finalize, F, listingChars, chars } from './rules.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_ROOT = path.resolve(HERE, '..');

export function resolveTarget(arg) {
  return path.resolve(expandHome(arg));
}

function typesOf(data, files, valuesKnown) {
  const t = [];
  const manual = valuesKnown && isTrueish(data['disable-model-invocation']);
  if (!manual) t.push('auto');
  else t.push('manual');
  if (valuesKnown && data.context === 'fork') t.push('fork');
  if (files.some((f) => f.kind === 'code' || f.kind === 'test')) t.push('code');
  if (files.some((f) => f.kind === 'doc')) t.push('docs');
  return t;
}

function errorResult(message, extra = {}) {
  return { ok: false, tool: 'skill-check', version: TOOL_VERSION, rubricVersion: RUBRIC_VERSION, generatedAt: isoLocal(), error: message, ...extra };
}

export async function runRules(dirArg, opts = {}) {
  const t0 = Date.now();
  if (!dirArg) return errorResult('스킬 디렉터리를 주세요: skill-check rules <스킬 디렉터리>');
  const dir = resolveTarget(dirArg);
  let st;
  try { st = fs.statSync(dir); } catch (e) { return errorResult(`경로를 찾지 못했어요: ${tildify(dir)} (${e.code || e.message})`); }
  if (!st.isDirectory()) return errorResult(`디렉터리가 아니에요: ${tildify(dir)}`);
  const skillPath = path.join(dir, 'SKILL.md');
  let skillBuf;
  try { skillBuf = fs.readFileSync(skillPath); } catch (e) {
    return errorResult(`SKILL.md를 읽지 못했어요: ${tildify(skillPath)} (${e.code || e.message})`);
  }
  if (skillBuf.includes(0)) return errorResult('SKILL.md가 텍스트 파일이 아니에요(바이너리)');
  const skillText = skillBuf.toString('utf8');
  const dirName = path.basename(dir);
  const notes = [];

  const { files, notes: walkNotes } = walkSkill(dir);
  notes.push(...walkNotes);
  const scopeInfo = detectScope(dir, opts.as);

  const fm = splitFrontmatter(skillText);
  let parse = { ok: true, data: {}, dups: [], keyLines: {} };
  if (fm.has && fm.yaml) parse = parseFrontmatterYaml(fm.yaml);
  if (!parse.ok) parse = { ...parse, data: {}, dups: [], keyLines: {} };

  // 외부 검사는 동시에 돌린다
  const syntaxFiles = files.filter((f) => (f.kind === 'code' || f.kind === 'test') && f.text != null);
  const [validate, syntax, gl, cliVer] = await Promise.all([
    validateSkill(skillText, dirName).catch((e) => ({ available: false, reason: e.message })),
    checkSyntax(syntaxFiles).catch(() => null),
    gitleaksScan(files).catch((e) => ({ status: 'failed', reason: `실행 중 오류: ${e.message}` })),
    cliVersion().catch(() => null),
  ]);
  // gitleaks가 기본이다. 없거나 실패하면 정규식 토큰 검사로 대신하고, 실패는 드러낸다(조용히 pass 금지).
  // 관례 파일(.env 등) 검사와 예외 설정 탐지는 언제나 돈다. 이것까지 실패하면 X1은 error다.
  const useGl = gl.status === 'ok';
  const glFailure = gl.status === 'failed' ? gl.reason : null;
  let regexFindings = [];
  let secretsError = null;
  try { regexFindings = regexScan(files, { patterns: !useGl }); } catch (e) { secretsError = `정규식 검사 실패: ${e.message}`; }
  const exceptions = findScanExceptions(files);
  const secrets = { scanner: useGl ? 'gitleaks' : 'regex', findings: [...(useGl ? gl.findings : []), ...regexFindings], exceptions, glFailure, error: secretsError };
  if (gl.status === 'absent') notes.push('gitleaks가 없어 비밀값을 정규식으로 검사했어요(미탐 가능)');
  if (glFailure) notes.push(`gitleaks 실패: ${glFailure}. 정규식으로 대신 검사했어요(미탐 가능)`);
  if (exceptions.length) notes.push(`비밀값 검사 예외 설정이 있어요(무시하고 검사했어요): ${exceptions.slice(0, 5).map((e) => `${e.file}${e.line ? ':' + e.line : ''}`).join(', ')}`);

  // S1
  let s1;
  let frontmatterDropped = false;
  if (!validate.available) {
    s1 = { status: 'error', findings: [], note: validate.reason || 'claude plugin validate를 쓰지 못했어요' };
  } else if (validate.errors.length) {
    frontmatterDropped = validate.errors.some((e) => e.path === 'frontmatter');
    s1 = { status: 'fail', findings: validate.errors.map((e) => F('SKILL.md', 1, e.path || 'frontmatter', 'BLOCKER', e.message, e.path === 'frontmatter' ? 'YAML 문법을 고쳐요. 콜론·따옴표가 든 값은 따옴표로 감싸거나 블록 스칼라(>-)로 써요.' : `${e.path} 값을 스펙에 맞게 고쳐요.`)) };
  } else {
    s1 = { status: 'pass', findings: [] };
  }
  for (const w of validate.warnings || []) notes.push(`plugin validate 경고: ${w.message}`);

  const parserLimit = !parse.ok && validate.available && !frontmatterDropped;
  const valuesKnown = parse.ok && !frontmatterDropped;
  if (parserLimit) notes.push(`파서 한계: validate는 통과했지만 내장 파서가 frontmatter를 읽지 못했어요(${parse.error}, ${parse.line}줄). 값이 필요한 규칙은 error로 두었어요`);
  if (!parse.ok && !validate.available) notes.push(`내장 파서가 frontmatter를 읽지 못했어요(${parse.error}). validate도 쓸 수 없어 값이 필요한 규칙은 error로 두었어요`);
  if (parse.retried) notes.push('frontmatter에 특수 문자가 든 값이 있어 따옴표를 씌워 다시 읽었어요(Claude Code와 같은 동작)');

  const data = valuesKnown ? parse.data : {};
  const types = typesOf(data, files, valuesKnown);
  const body = fm.body;
  const bodyLines = body === '' ? 0 : body.split('\n').length - (body.endsWith('\n') ? 1 : 0);

  const agents = types.includes('fork') ? collectAgents(scopeInfo, dir) : null;
  const ctx = {
    dir, dirName, files, skillText, data, parse, types, body, bodyLines, bodyStartLine: fm.bodyStartLine,
    scope: scopeInfo.scope, agents, syntax, secrets,
  };

  const rules = [];
  for (const id of RULE_IDS) {
    let r;
    if (id === 'S1') r = s1;
    else if (NEEDS_VALUES.has(id) && frontmatterDropped) r = { status: 'na', findings: [], note: 'S1 실패로 런타임에 frontmatter가 모두 버려져서 판정하지 않았어요' };
    else if (NEEDS_VALUES.has(id) && !parse.ok) r = { status: 'error', findings: [], note: parserLimit ? '파서 한계' : 'frontmatter를 읽지 못함' };
    else {
      try { r = RULE_FNS[id](ctx); } catch (e) { r = { status: 'error', findings: [], note: `규칙 실행 오류: ${e.message}` }; }
    }
    if (r.findings.length > MAX_FINDINGS_PER_RULE) {
      const more = r.findings.length - MAX_FINDINGS_PER_RULE;
      r.findings = r.findings.slice(0, MAX_FINDINGS_PER_RULE);
      r.note = [r.note, `finding ${more}개를 더 찾았지만 생략했어요`].filter(Boolean).join('; ');
    }
    rules.push(finalize(id, RULE_TITLES[id], r));
  }

  const summary = { blocker: 0, major: 0, minor: 0, error: 0, na: 0, pass: 0 };
  for (const r of rules) {
    if (r.status === 'fail') summary[r.severity.toLowerCase()]++;
    else summary[r.status]++;
  }

  const name = typeof data.name === 'string' && data.name ? data.name : dirName;
  let usageKey = name;
  if (scopeInfo.scope === 'plugin' && scopeInfo.pluginRoot) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(scopeInfo.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (m.name) usageKey = `${m.name}:${dirName}`;
    } catch { /* 플러그인 이름 없음 */ }
  }
  const usage = readUsage(usageKey);
  const { otherSkills, notes: osNotes } = collectOtherSkills(dir, scopeInfo);
  notes.push(...osNotes);
  const profilesDir = process.env.SKILL_CHECK_PROFILES_DIR || path.join(SKILL_ROOT, 'profiles');
  // 실행 중인 프로젝트(stdin 1줄째는 bin이 CLAUDE_PROJECT_DIR로 넘긴다)에 맞는 프로파일도 함께 적용한다.
  const runProject = process.env.CLAUDE_PROJECT_DIR ? realpathOr(process.env.CLAUDE_PROJECT_DIR) : null;
  const { profiles, notes: pNotes } = loadProfiles(scopeInfo.real, profilesDir, runProject);
  notes.push(...pNotes);

  const fmData = {};
  for (const [k, v] of Object.entries(data)) fmData[k] = typeof v === 'string' && v.length > 2000 ? v.slice(0, 2000) + '…' : v;

  const out = {
    ok: true,
    tool: 'skill-check', version: TOOL_VERSION, rubricVersion: RUBRIC_VERSION,
    cliVersion: cliVer,
    generatedAt: isoLocal(),
    evalRequested: !!opts.eval,
    target: {
      dir: tildify(scopeInfo.real), dirName, name,
      scope: scopeInfo.scope, scopeSource: scopeInfo.scopeSource,
      files: files.map((f) => ({ path: f.path, lines: f.lines, kind: f.kind })),
    },
    types,
    frontmatter: {
      parsed: parse.ok, parser: 'builtin-subset',
      ...(parse.ok ? {} : { parseError: parse.error, parseErrorLine: parse.line }),
      keys: Object.keys(parse.data || {}),
      data: fmData,
      descriptionChars: chars(typeof data.description === 'string' ? data.description : ''),
      listingChars: listingChars(data),
      bodyLines,
    },
    rules,
    summary,
    usage,
    otherSkills,
    profiles,
    secretsScanner: secrets.scanner,
    notes,
    elapsedMs: Date.now() - t0,
  };
  return shrink(out);
}

// 30KB를 넘으면 덜 중요한 것부터 줄인다.
export function shrink(out) {
  const size = () => Buffer.byteLength(JSON.stringify(out));
  if (size() <= OUTPUT_MAX_BYTES) return out;
  if (out.target.files.length > 200) {
    const n = out.target.files.length;
    out.target.files = out.target.files.slice(0, 200);
    out.notes.push(`파일 목록이 ${n}개라 앞 200개만 남겼어요`);
  }
  for (const lim of [150, 80]) {
    if (size() <= OUTPUT_MAX_BYTES) break;
    for (const s of out.otherSkills) if (s.description && s.description.length > lim) s.description = s.description.slice(0, lim - 1) + '…';
    out.notes.push(`출력이 커서 다른 스킬 설명을 ${lim}자로 줄였어요`);
  }
  for (const lim of [10, 5, 2]) {
    if (size() <= OUTPUT_MAX_BYTES) break;
    for (const r of out.rules) {
      if (r.findings.length > lim) {
        const more = r.findings.length - lim;
        r.findings = r.findings.slice(0, lim);
        r.note = [r.note, `출력 크기 때문에 finding ${more}개를 생략했어요`].filter(Boolean).join('; ');
      }
    }
  }
  if (size() > OUTPUT_MAX_BYTES) {
    out.target.files = out.target.files.slice(0, 50);
    out.notes.push('출력이 커서 파일 목록을 50개로 줄였어요');
  }
  return out;
}

export function writeRunLog(result, name) {
  const dir = process.env.SKILL_CHECK_RUNS_DIR || path.join(expandHome('~'), '.claude', 'skill-check', 'runs');
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const safe = String(name || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-${safe}.json`);
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  return file;
}
