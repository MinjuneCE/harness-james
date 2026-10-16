// 대상 밖의 맥락: 범위(scope), 다른 스킬 목록, 에이전트 목록, 사용량, 프로파일.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseFrontmatterYaml } from './yaml.mjs';
import { TEXT_CLIP } from './spec.mjs';

export function homeDir() {
  return process.env.SKILL_CHECK_HOME || os.homedir();
}

export function clip(s, n = TEXT_CLIP) {
  if (s == null) return s;
  const str = String(s);
  const chars = Array.from(str);
  return chars.length > n ? chars.slice(0, n - 1).join('') + '…' : str;
}

export function expandHome(p) {
  if (p === '~') return homeDir();
  if (p.startsWith('~/')) return path.join(homeDir(), p.slice(2));
  return p;
}

// 홈 경로를 ~로 바꿔 보여 준다(결과에 사용자 이름을 남기지 않기 위해).
export function tildify(p) {
  const h = homeDir();
  if (p === h) return '~';
  if (p.startsWith(h + path.sep)) return '~/' + p.slice(h.length + 1);
  return p;
}

export function realpathOr(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// 로컬 시각 ISO 문자열(예: 2026-10-16T12:00:00+09:00). 한 JSON 안의 시각은 모두 이 형식으로 낸다.
export function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const pad = (n) => String(Math.trunc(Math.abs(n))).padStart(2, '0');
  const local = new Date(d.getTime() + off * 60000).toISOString().slice(0, 19);
  return `${local}${sign}${pad(off / 60)}:${pad(off % 60)}`;
}

// 리포트 첫 줄에 쓰는 로컬 날짜(MM/DD)
export function localDay(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

export function splitFrontmatter(text) {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(t);
  if (!m) {
    if (/^---[ \t]*\r?\n/.test(t) && /^---[ \t]*\r?\n---[ \t]*(\r?\n|$)/.test(t)) {
      return { has: true, yaml: '', body: t.replace(/^---[ \t]*\r?\n---[ \t]*(\r?\n|$)/, ''), bodyStartLine: 3 };
    }
    return { has: false, yaml: null, body: t, bodyStartLine: 1 };
  }
  const yaml = m[1].replace(/\r/g, '');
  const body = t.slice(m[0].length);
  const bodyStartLine = yaml.split('\n').length + 3;
  return { has: true, yaml, body, bodyStartLine };
}

// 범위 판별
export function detectScope(dir, asOpt) {
  const real = realpathOr(dir);
  const home = realpathOr(homeDir());
  const parent = path.dirname(real);
  const res = { scope: 'other', scopeSource: 'path', projectDir: null, pluginRoot: null, real };
  if (path.basename(parent) === 'skills') {
    const grand = path.dirname(parent);
    if (parent === path.join(home, '.claude', 'skills')) res.scope = 'user';
    else if (fs.existsSync(path.join(grand, '.claude-plugin', 'plugin.json'))) {
      res.scope = 'plugin';
      res.pluginRoot = grand;
    } else if (path.basename(grand) === '.claude') {
      res.scope = 'project';
      res.projectDir = path.dirname(grand);
    }
  }
  if (asOpt === 'user' || asOpt === 'project') {
    res.scope = asOpt;
    res.scopeSource = '--as';
    if (asOpt === 'project' && !res.projectDir) res.projectDir = fallbackProjectDir();
    if (asOpt === 'user') res.projectDir = null;
  }
  return res;
}

// CLAUDE_PROJECT_DIR가 없으면 현재 디렉터리에서 위로 올라가며 .claude/가 있는 곳을 찾는다(홈은 빼고).
export function fallbackProjectDir() {
  if (process.env.CLAUDE_PROJECT_DIR) return realpathOr(process.env.CLAUDE_PROJECT_DIR);
  const home = realpathOr(homeDir());
  const start = realpathOr(process.cwd());
  for (let d = start; ; d = path.dirname(d)) {
    if (d !== home && fs.existsSync(path.join(d, '.claude'))) return d;
    if (fs.existsSync(path.join(d, '.git')) || path.dirname(d) === d) break;
  }
  return start;
}

function skillSummary(skillDir, fullName, scope) {
  let text;
  try { text = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'); } catch { return null; }
  const fm = splitFrontmatter(text);
  let data = {};
  if (fm.has && fm.yaml) {
    const r = parseFrontmatterYaml(fm.yaml);
    if (r.ok) data = r.data;
  }
  let desc = typeof data.description === 'string' ? data.description : '';
  if (!desc) desc = (fm.body.split('\n').find((l) => l.trim() !== '') || '').trim();
  if (typeof data.when_to_use === 'string' && data.when_to_use) desc += ' ' + data.when_to_use;
  const manual = isTrueish(data['disable-model-invocation']);
  const name = fullName || (typeof data.name === 'string' && data.name) || path.basename(skillDir);
  return { name, scope, invocation: manual ? 'manual' : 'auto', description: clip(desc.replace(/\s+/g, ' ').trim()) };
}

export function isTrueish(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['true', 'yes', 'on', '1'].includes(v.toLowerCase());
  return false;
}

function listSkillDirs(root) {
  let ents;
  try { ents = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return ents
    .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && e.name !== 'synced' && e.name !== '.trash' && !e.name.startsWith('.'))
    .map((e) => path.join(root, e.name))
    .filter((d) => fs.existsSync(path.join(d, 'SKILL.md')))
    .sort();
}

// 켜진 플러그인: [{name, root}]
export function enabledPlugins(projectDir) {
  const home = homeDir();
  const enabled = new Set();
  const settingsFiles = [path.join(home, '.claude', 'settings.json')];
  if (projectDir) settingsFiles.push(path.join(projectDir, '.claude', 'settings.json'), path.join(projectDir, '.claude', 'settings.local.json'));
  for (const f of settingsFiles) {
    const s = readJson(f);
    const ep = s && s.enabledPlugins;
    if (ep && typeof ep === 'object') {
      for (const [k, v] of Object.entries(ep)) {
        if (v === true) enabled.add(k);
        else if (v === false) enabled.delete(k);
      }
    }
  }
  const inst = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const out = [];
  const notes = [];
  for (const key of [...enabled].sort()) {
    const recs = inst && inst.plugins && inst.plugins[key];
    if (!Array.isArray(recs)) { notes.push(`켜진 플러그인 ${key}의 설치 경로를 찾지 못해 목록에서 뺐어요`); continue; }
    const rec = recs.find((r) => r.scope === 'user') || recs.find((r) => r.projectPath && projectDir && realpathOr(r.projectPath) === projectDir);
    if (!rec || !rec.installPath || !fs.existsSync(rec.installPath)) { notes.push(`켜진 플러그인 ${key}의 설치 경로가 없어 목록에서 뺐어요`); continue; }
    const manifest = readJson(path.join(rec.installPath, '.claude-plugin', 'plugin.json')) || readJson(path.join(rec.installPath, 'plugin.json'));
    const name = (manifest && typeof manifest.name === 'string' && manifest.name) || key.split('@')[0];
    out.push({ name, root: rec.installPath });
  }
  return { plugins: out, notes };
}

export function collectOtherSkills(target, scopeInfo) {
  const home = homeDir();
  const self = scopeInfo.real;
  const out = [];
  const notes = [];
  for (const d of listSkillDirs(path.join(home, '.claude', 'skills'))) {
    if (realpathOr(d) === self) continue;
    const s = skillSummary(d, null, 'user');
    if (s) out.push(s);
  }
  const projectDir = scopeInfo.scope === 'project' && scopeInfo.projectDir ? scopeInfo.projectDir : fallbackProjectDir();
  if (realpathOr(projectDir) !== realpathOr(home)) {
    for (const d of listSkillDirs(path.join(projectDir, '.claude', 'skills'))) {
      if (realpathOr(d) === self) continue;
      const s = skillSummary(d, null, 'project');
      if (s) out.push(s);
    }
  }
  const ep = enabledPlugins(projectDir);
  notes.push(...ep.notes);
  for (const p of ep.plugins) {
    for (const d of listSkillDirs(path.join(p.root, 'skills'))) {
      if (realpathOr(d) === self) continue;
      const s = skillSummary(d, `${p.name}:${path.basename(d)}`, 'plugin');
      if (s) out.push(s);
    }
  }
  return { otherSkills: out, notes };
}

function agentNamesIn(dir, prefix = '') {
  const names = [];
  const walk = (d, sub) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p, [...sub, e.name]); continue; }
      if (!e.name.endsWith('.md')) continue;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      const fm = splitFrontmatter(text);
      let name = null;
      if (fm.has && fm.yaml) {
        const r = parseFrontmatterYaml(fm.yaml);
        if (r.ok && typeof r.data.name === 'string' && r.data.name) name = r.data.name;
      }
      if (prefix) {
        const n = name || e.name.replace(/\.md$/, '');
        names.push([prefix, ...sub, n].join(':'));
      } else if (name) {
        names.push(name);
      }
    }
  };
  walk(dir, []);
  return names;
}

// 에이전트 출처별 이름 목록
export function collectAgents(scopeInfo, skillDir) {
  const home = homeDir();
  const user = agentNamesIn(path.join(home, '.claude', 'agents'));
  const projectDir = scopeInfo.scope === 'project' ? scopeInfo.projectDir : null;
  const project = projectDir ? agentNamesIn(path.join(projectDir, '.claude', 'agents')) : [];
  const cwdProject = scopeInfo.scope === 'other' ? agentNamesIn(path.join(fallbackProjectDir(), '.claude', 'agents')) : [];
  // 스테이징(범위 other)에서는 스킬 폴더 옆 agents/를 같이 본다(설치 전 배치: <root>/skill/, <root>/agents/).
  const sibling = scopeInfo.scope === 'other' ? agentNamesIn(path.join(path.dirname(scopeInfo.real), 'agents')) : [];
  const extra = [];
  for (const d of (process.env.SKILL_CHECK_AGENT_DIRS || '').split(path.delimiter).filter(Boolean)) extra.push(...agentNamesIn(d));
  const plugin = [];
  const ep = enabledPlugins(projectDir || fallbackProjectDir());
  for (const p of ep.plugins) plugin.push(...agentNamesIn(path.join(p.root, 'agents'), p.name));
  if (scopeInfo.scope === 'plugin' && scopeInfo.pluginRoot) {
    const manifest = readJson(path.join(scopeInfo.pluginRoot, '.claude-plugin', 'plugin.json'));
    const pname = manifest && manifest.name;
    if (pname) plugin.push(...agentNamesIn(path.join(scopeInfo.pluginRoot, 'agents'), pname));
  }
  // 대상이 user 범위일 때 '프로젝트 전용'을 알아보려고 현재 프로젝트 에이전트도 모은다.
  const anyProject = agentNamesIn(path.join(fallbackProjectDir(), '.claude', 'agents'));
  return { user, project, cwdProject, sibling, extra, plugin, anyProject };
}

export function readUsage(name) {
  const p = process.env.SKILL_CHECK_CLAUDE_JSON || path.join(homeDir(), '.claude.json');
  let raw;
  try { raw = fs.readFileSync(p, 'utf8'); } catch { return null; }
  let rec;
  try {
    const su = JSON.parse(raw).skillUsage;
    rec = su && typeof su === 'object' ? su[name] : null;
  } catch {
    return null;
  }
  raw = null;
  if (!rec || typeof rec !== 'object') return null;
  const count = Number.isFinite(rec.usageCount) ? rec.usageCount : null;
  const lastDate = Number.isFinite(rec.lastUsedAt) ? new Date(rec.lastUsedAt) : null;
  const last = lastDate ? isoLocal(lastDate) : null;
  const day = lastDate ? localDay(lastDate) : null;
  return { usageCount: count, lastUsedAt: last, lastUsedDay: day, source: '~/.claude.json skillUsage' };
}

export function globToRegExp(glob) {
  const g = expandHome(glob);
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*' && g[i + 2] === '/') {
      re += '(?:.*/)?';
      i += 2;
    } else if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// 대상 스킬 경로(target)와 실행 중인 프로젝트 경로(project) 중 하나라도 appliesTo에 맞으면 적용한다.
// 같은 id는 한 번만 넣고, 둘 다 맞으면 matchedBy는 target이다.
export function loadProfiles(targetReal, profilesDir, projectDir = null) {
  const out = [];
  const notes = [];
  let files = [];
  try { files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json')).sort(); } catch {
    notes.push('프로파일 폴더를 읽지 못했어요');
    return { profiles: out, notes };
  }
  // 프로젝트 폴더 자체도 '<프로젝트>/**'에 맞게 끝에 구분자를 붙여 본다.
  const projectPaths = projectDir ? [projectDir, projectDir + path.sep] : [];
  const seen = new Set();
  for (const f of files) {
    const p = readJson(path.join(profilesDir, f));
    if (!p || !Array.isArray(p.appliesTo)) { notes.push(`프로파일 ${f}을 읽지 못했어요`); continue; }
    const res = p.appliesTo.map((g) => globToRegExp(g));
    const byTarget = res.some((re) => re.test(targetReal));
    const byProject = !byTarget && res.some((re) => projectPaths.some((x) => re.test(x)));
    if (!byTarget && !byProject) continue;
    const id = p.id || f.replace(/\.json$/, '');
    if (seen.has(id)) { notes.push(`프로파일 id ${id}가 겹쳐서 ${f}는 뺐어요`); continue; }
    seen.add(id);
    out.push({ id, matchedBy: byTarget ? 'target' : 'project', forbidden: p.forbidden || [], knownGuards: p.knownGuards || [] });
  }
  return { profiles: out, notes };
}
