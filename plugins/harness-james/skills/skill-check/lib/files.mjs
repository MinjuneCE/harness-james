// 스킬 디렉터리의 파일 목록과 종류 판별.
import fs from 'node:fs';
import path from 'node:path';
import { CODE_EXT, SKIP_DIRS } from './spec.mjs';

const MAX_FILES = 3000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export function isTestPath(rel) {
  const parts = rel.split('/');
  const base = parts[parts.length - 1];
  if (parts.slice(0, -1).some((p) => p === 'test' || p === 'tests' || p === '__tests__')) return true;
  return /\.(test|spec)\.[^.]+$/.test(base) || /_test\.[^.]+$/.test(base);
}

export function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function kindOf(rel, text, mode) {
  const ext = path.extname(rel).toLowerCase();
  if (rel === 'SKILL.md') return 'skill';
  if (ext === '.md' || ext === '.markdown') return 'doc';
  const code = CODE_EXT.has(ext) || (text != null && text.startsWith('#!')) || (!ext && (mode & 0o111) !== 0);
  if (code) return isTestPath(rel) ? 'test' : 'code';
  return 'other';
}

// 파일 목록. 각 항목: {path, abs, size, lines, kind, binary, text, mode, skipped}
export function walkSkill(dir) {
  const out = [];
  const notes = [];
  const stack = [''];
  while (stack.length) {
    const relDir = stack.pop();
    let ents;
    try {
      ents = fs.readdirSync(path.join(dir, relDir), { withFileTypes: true });
    } catch (e) {
      notes.push(`디렉터리를 읽지 못했어요: ${relDir || '.'} (${e.code || e.message})`);
      continue;
    }
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const ent of ents) {
      const rel = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(rel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (out.length >= MAX_FILES) {
        notes.push(`파일이 ${MAX_FILES}개를 넘어서 나머지는 보지 않았어요`);
        stack.length = 0;
        break;
      }
      const abs = path.join(dir, rel);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      const f = { path: rel, abs, size: st.size, mode: st.mode, lines: 0, binary: false, text: null, kind: 'other' };
      if (st.size <= MAX_TEXT_BYTES) {
        try {
          const buf = fs.readFileSync(abs);
          if (looksBinary(buf)) f.binary = true;
          else {
            f.text = buf.toString('utf8');
            f.lines = f.text === '' ? 0 : f.text.split('\n').length - (f.text.endsWith('\n') ? 1 : 0);
          }
        } catch (e) {
          f.unreadable = e.code || e.message;
        }
      } else {
        f.skipped = 'large';
      }
      f.kind = f.binary ? 'other' : kindOf(rel, f.text, st.mode);
      out.push(f);
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: out, notes };
}

export function lineOfIndex(text, idx) {
  let n = 1;
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}
