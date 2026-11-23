// 워크스페이스, 평가 폴더, 등록된 프로필, 초안을 둘 수 있는 곳. 위치 규칙은 /pr-verify(같은 플러그인의 pr-verify 스킬)와 같다.
// - 평가 폴더: <워크스페이스>/docs/evaluation (VERIFY_EVAL_DIR로 바꿈, 워크스페이스 기준 상대 경로)
// - 워크스페이스: VERIFY_WORKSPACE, 없으면 평가 폴더의 profiles/가 있는 가장 가까운 상위 디렉터리, 그것도 없으면 지금 폴더(첫 프로필을 만들 때)
// - 산식 숫자(config/scoring.json): 프로젝트 평가 폴더에 있으면 그것, 없으면 pr-verify 스킬의 기본값
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN_EVAL_DIR = resolve(SKILL_DIR, "../pr-verify/evaluation");
export const evalRel = () => (process.env.VERIFY_EVAL_DIR || "docs/evaluation").replace(/\/+$/, "");
export const profilesRel = () => join(evalRel(), "profiles");
// 초안·점검 결과를 두는 곳. /pr-verify 실행 산출물(.verify/runs/)과 같은 작업 폴더 아래다
export const WORK_DIR = ".verify";
export const DRAFTS_DIR = join(WORK_DIR, "profile-drafts");

export function findWorkspace(start = process.cwd()) {
  if (process.env.VERIFY_WORKSPACE) return real(process.env.VERIFY_WORKSPACE);
  const marker = profilesRel();
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, marker))) return real(dir);
    if (dirname(dir) === dir) break;
  }
  return real(start);
}
export const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
export function scoringPath(ws) {
  const own = join(ws, evalRel(), "config/scoring.json");
  return existsSync(own) ? own : join(PLUGIN_EVAL_DIR, "config/scoring.json");
}
export function loadScoring(ws) {
  const p = scoringPath(ws);
  if (!existsSync(p)) throw new Error(`산식 파일이 없음: ${p} (pr-verify 스킬과 같은 플러그인에서 돌리거나 ${evalRel()}/config/scoring.json을 둔다)`);
  return readJson(p);
}
export function loadProfiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().flatMap((f) => {
    try { return [{ ...readJson(join(dir, f)), _path: join(dir, f) }]; } catch { return []; }
  });
}
function real(p) { try { return realpathSync(p); } catch { return resolve(p); } }
const under = (p, root) => { const r = relative(real(root), p); return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[A-Za-z]:/.test(r)); };
// 초안은 <ws>/.verify/ 아래나 임시 폴더에만 쓴다. 등록 프로필 폴더, 스킬 폴더, 대상 레포에는 이 도구가 쓰지 않는다
export function assertDraftPath(ws, target) {
  let dir = resolve(target);
  while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
  const abs = join(real(dir), relative(dir, resolve(target)));
  if (under(abs, join(ws, WORK_DIR)) || (under(abs, tmpdir()) && !under(abs, ws))) return abs;
  throw new Error(`초안은 ${join(ws, WORK_DIR)} 아래나 임시 폴더에만 쓴다: ${target} (${profilesRel()} 반영은 사용자 확인 뒤 사람이 옮긴다)`);
}
// 워크스페이스 안이면 상대 경로, 밖이면 절대 경로
export const rel = (ws, p) => { const r = relative(ws, p); return r === "" ? "." : r.startsWith("..") ? p : r; };
