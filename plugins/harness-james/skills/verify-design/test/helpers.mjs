// 시험 공통: 스킬 안 임시 폴더, 합성 fixture 경로, 스킬에 든 rubric 폴더(읽기 전용), 같은 플러그인의 에이전트 폴더
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SKILL = resolve(HERE, "..");
export const FIXTURE = join(HERE, "fixtures/bundle-a");
export const RUBRIC_DIR = join(SKILL, "evaluation/rubrics");
// <플러그인>/skills/<스킬> → <플러그인>/agents
export const AGENTS_DIR = resolve(SKILL, "../../agents");
export const HAS_RUBRIC = existsSync(RUBRIC_DIR);

export function tmpDir(t) {
  const base = join(HERE, ".tmp");
  mkdirSync(base, { recursive: true });
  const d = mkdtempSync(join(base, "t-"));
  t?.after?.(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

export function copyFixture(t) {
  const d = tmpDir(t);
  cpSync(FIXTURE, d, { recursive: true });
  return d;
}

export function extractArgs(root, out, extra = {}) {
  return { root, profile: "profile.json", out, maps: [], rubricDir: RUBRIC_DIR, generatedAt: "T0", ...extra };
}
