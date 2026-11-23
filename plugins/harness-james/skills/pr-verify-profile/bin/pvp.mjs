#!/usr/bin/env node
// pr-verify-profile: /pr-verify 프로필 초안과 구조 목록 변경안을 돕는 결정적 도구.
//   inventory --repo <레포 폴더> [--ref <ref>] [--json <파일>]          레포를 훑어 판단 재료를 낸다(읽기만)
//   skeleton  --repo <레포 폴더> --key <key> [--alias <a>]… [--ref <ref>] [--base <default_base>] [--out <폴더>] [--force]
//                                                                         구조 목록이 빈 프로필 뼈대를 초안 폴더에 쓴다
//   check     --profile <프로필> [--repo <폴더>] [--head <ref>] [--base <ref>] [--against <등록 프로필>] [--json <파일>] [--quiet]
//                                                                         기계 점검. FAIL이 있으면 종료 코드 1
//   table     --profile <프로필> [--repo <폴더>] [--head <ref>] [--base <ref>] [--against <등록 프로필>]
//                                                                         사용자 확인 표(Markdown)
// 종료 코드: 0 = 돌았음(WARN이 있어도 0), 1 = FAIL 있음(check), 2 = 인자 오류·쓰기 거부, 3 = 못 돌림(레포·ref·프로필을 못 읽음)
// 쓰기는 초안 폴더(<워크스페이스>/.verify/ 아래나 임시 폴더)에만 한다. 평가 폴더의 profiles/와 대상 레포에는 쓰지 않는다.
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkProfile } from "../lib/check.mjs";
import { gitIn } from "../lib/git.mjs";
import { baseCandidates, inventory, inventoryText } from "../lib/inventory.mjs";
import { skeleton } from "../lib/skeleton.mjs";
import { confirmTable } from "../lib/table.mjs";
import { DRAFTS_DIR, assertDraftPath, findWorkspace, loadProfiles, loadScoring, profilesRel, readJson, rel } from "../lib/workspace.mjs";

const SPEC = {
  inventory: { valued: ["repo", "ref", "json"], multi: [], flags: [] },
  skeleton: { valued: ["repo", "ref", "key", "base", "out"], multi: ["alias"], flags: ["force"] },
  check: { valued: ["profile", "repo", "head", "base", "against", "json"], multi: [], flags: ["quiet"] },
  table: { valued: ["profile", "repo", "head", "base", "against"], multi: [], flags: [] },
};
// 항목 이름이 점검 이름과 같은 말이면 한 번만 찍는다
const GENERIC_IDS = new Set(["tree", "changed", "overlap", "paths", "coverage_ignore", "comment_syntax", "version", "dimensions"]);
class Exit extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const usage = (msg) => new Exit(2, msg);
const cannot = (msg) => new Exit(3, msg);

function parse(argv) {
  const [cmd, ...rest] = argv;
  const spec = SPEC[cmd];
  if (!spec) throw usage(`명령은 ${Object.keys(SPEC).join(" | ")} 중 하나: ${cmd ?? "(없음)"}`);
  const opt = Object.fromEntries(spec.multi.map((k) => [k, []]));
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw usage(`알 수 없는 인자: ${a}`);
    const eq = a.indexOf("=");
    const k = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (spec.flags.includes(k)) { opt[k] = true; continue; }
    if (!spec.valued.includes(k) && !spec.multi.includes(k)) throw usage(`${cmd}에 없는 옵션: --${k}`);
    const v = eq < 0 ? rest[++i] : a.slice(eq + 1);
    if (v === undefined || v === "") throw usage(`--${k}에 값이 없음`);
    if (spec.multi.includes(k)) opt[k].push(v); else opt[k] = v;
  }
  return { cmd, opt };
}

function openRepo(ws, path) {
  if (!existsSync(resolve(ws, path))) throw cannot(`레포 폴더가 없음: ${path}`);
  const dir = realpathSync(resolve(ws, path));
  const g = gitIn(dir);
  if (!g.isRepo()) throw cannot(`git 레포가 아님: ${path}`);
  return { dir, g };
}
function readProfile(ws, path, what = "프로필") {
  const abs = resolve(ws, path);
  if (!existsSync(abs)) throw cannot(`${what} 파일이 없음: ${path}`);
  try { return { ...readJson(abs), _path: abs }; } catch (e) { throw new Exit(1, `FAIL shape ${path} — JSON을 읽지 못함: ${e.message}`); }
}
function writeDraft(ws, path, text, force = false) {
  const abs = assertDraftPath(ws, resolve(ws, path));
  if (existsSync(abs) && !force) throw usage(`이미 있는 파일은 덮어쓰지 않음: ${rel(ws, abs)} (--force로 덮어쓰거나 --out을 바꿔요)`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text);
  return abs;
}
const strip = (p) => { const { _path, ...rest } = p; return rest; };

// 초안 점검 준비: 등록 프로필, 같은 폴더의 다른 초안, 등록본(--against, 없으면 같은 key·github의 등록 프로필)
function prepareCheck(ws, opt) {
  if (!opt.profile) throw usage("--profile이 필요함");
  const profile = readProfile(ws, opt.profile);
  const registered = loadProfiles(join(ws, profilesRel()));
  const isRegistered = registered.some((q) => q._path === profile._path);
  const siblings = isRegistered ? [] : loadProfiles(dirname(profile._path)).filter((q) => q._path !== profile._path);
  let against = opt.against ? readProfile(ws, opt.against, "등록 프로필") : null;
  if (!against && !isRegistered) against = registered.find((q) => q.repo?.key === profile.repo?.key) ?? null;
  const r = checkProfile({ profile: strip(profile), profilePath: profile._path, ws, registered, siblings, repoDir: opt.repo ? resolve(ws, opt.repo) : null, head: opt.head ?? null, base: opt.base ?? null, against: against ? strip(against) : null });
  return { profile, against, r };
}

function main() {
  const { cmd, opt } = parse(process.argv.slice(2));
  const ws = findWorkspace();
  if (cmd === "inventory" || cmd === "skeleton") {
    if (!opt.repo) throw usage("--repo가 필요함");
    const { dir, g } = openRepo(ws, opt.repo);
    const profiles = loadProfiles(join(ws, profilesRel()));
    const ref = opt.ref ?? baseCandidates(g)[0] ?? (g.commit("HEAD") ? "HEAD" : undefined);
    if (!ref) throw cannot(`볼 ref가 없음(origin/… 원격 추적 브랜치도 HEAD도 없음): ${opt.repo}`);
    let inv;
    // repo.path는 워크스페이스 기준 상대 경로로 적는다(/pr-verify 준비 단계가 워크스페이스 뒤에 이어 붙인다). 밖이면 ../로 시작한다
    try { inv = inventory({ g, ref, profiles, repoPath: relative(ws, dir) || "." }); } catch (e) { throw cannot(e.message); }
    if (cmd === "inventory") {
      console.log(inventoryText(inv));
      if (opt.json) console.log(`\nJSON=${rel(ws, writeDraft(ws, opt.json, JSON.stringify(inv, null, 2) + "\n", true))}`);
      return 0;
    }
    if (!opt.key) throw usage("--key가 필요함(짧은 레포 이름: /pr-verify <key>로 부르고 dependents가 가리키는 값)");
    if (inv.registered.length) throw usage(`이미 등록된 프로필이 있음: ${inv.registered.map((p) => p.file).join(", ")} — 새 뼈대 대신 등록본을 초안 폴더에 복사해 고치고 check --against로 봐요`);
    if (!inv.kind.traits.length) console.error("! 레포 성격을 추정하지 못함 — 뼈대의 repo.traits와 dimensions를 직접 채워요");
    const preset = inv.kind.preset_from ? profiles.find((p) => p.repo.key === inv.kind.preset_from.key) : null;
    const rubricVersion = /rubric ([\d.]+)/.exec(preset?.$comment ?? "")?.[1];
    const draft = skeleton({ inv, key: opt.key, aliases: opt.alias, base: opt.base, preset, ...(rubricVersion ? { rubricVersion } : {}), today: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) });
    const out = writeDraft(ws, join(opt.out ?? DRAFTS_DIR, `${inv.repo.name}.json`), JSON.stringify(draft, null, 2) + "\n", opt.force);
    console.log(`DRAFT=${rel(ws, out)}`);
    console.log(`- 채운 칸: repo, traits(${inv.kind.traits.join("+") || "비었음"}), comment_syntax ${Object.keys(draft.comment_syntax).length}개, coverage_ignore ${draft.coverage_ignore.length}개`);
    console.log(`- ${preset ? `${basename(preset._path)}에서 가져온 출발값: dimensions(가중치), floors${preset.criteria ? ", criteria" : ""} — 이 레포에 맞게 고쳐요` : "같은 성격의 등록 프로필이 없어 dimensions가 비었음 — 직접 채워요"}`);
    console.log("- 비워 둔 칸: structures, dependents(판단이 필요한 칸). rules, ledgers, feature_map은 넣지 않음(필요할 때 직접 더해요)");
    return 0;
  }
  const { profile, against, r } = prepareCheck(ws, opt);
  if (cmd === "table") {
    // 레포나 ref를 못 읽으면 파일 수를 셀 수 없다. 0으로 채운 표를 내지 않는다
    const unread = r.items.find((i) => i.check === "repo" && i.level === "FAIL");
    if (unread) throw cannot(unread.message);
    if (!r.rows.length && !(profile.structures ?? []).length) throw cannot("구조 목록이 비어 표를 만들 수 없음");
    console.log(confirmTable({ profile, rows: r.rows.length ? r.rows : (profile.structures ?? []).map((s) => ({ ...s, review_threshold: s.review_threshold ?? null, files: 0, changed: null })), scoring: loadScoring(ws), diff: r.diff }));
    return 0;
  }
  const where = `${rel(ws, profile._path)}${r.head ? ` @ ${opt.head ?? profile.repo?.default_base} (${r.head.slice(0, 7)})` : ""}${r.base ? `, base ${r.base.slice(0, 7)}` : ""}${against ? `, 등록본 ${rel(ws, against._path)}` : ""}`;
  const shown = r.items.filter((i) => !opt.quiet || i.level !== "INFO");
  for (const it of shown) {
    console.log(`${it.level} ${it.check}${GENERIC_IDS.has(it.id) ? "" : ` ${it.id}`} — ${it.message}`);
    for (const f of it.files ?? []) console.log(`    ${f}`);
    if (it.more) console.log(`    … ${it.files?.length ? `외 ${it.more}개` : `${it.more}개(목록은 --json)`}`);
  }
  if (r.rows.length && !opt.quiet) console.log(`구조별 파일 수${r.base ? "(바뀐 파일)" : ""}: ${r.rows.map((x) => `${x.id} ${x.files}${x.changed !== null ? `(${x.changed})` : ""}`).join(" · ")}`);
  if (r.diff && !opt.quiet) console.log(`등록본과의 차이: 새 구조 ${r.diff.added.length} · 없앤 구조 ${r.diff.removed.length} · id 바꿈 ${r.diff.renamed.length} · 고친 구조 ${r.diff.changed.length} · coverage_ignore +${r.diff.coverage_ignore.added.length}/−${r.diff.coverage_ignore.removed.length} · dependents +${r.diff.dependents.added.length}/−${r.diff.dependents.removed.length}, ref 바뀜 ${r.diff.dependents.refs.reduce((n, x) => n + x.n, 0)} · version ${r.diff.version[0]} → ${r.diff.version[1]}`);
  const s = r.stats;
  console.log(`pr-verify-profile check: ${s.FAIL ? "FAIL" : s.WARN ? "WARN" : "ok"} — FAIL ${s.FAIL} · WARN ${s.WARN} · INFO ${s.INFO} · ${where}${!s.FAIL && !s.WARN ? " · 고칠 것 없음" : ""}`);
  if (opt.json) console.log(`JSON=${rel(ws, writeDraft(ws, opt.json, JSON.stringify({ version: 1, tool: "pr-verify-profile", profile: rel(ws, profile._path), against: against ? rel(ws, against._path) : null, head: r.head, base: r.base, stats: s, items: r.items, structures: r.rows, diff: r.diff }, null, 2) + "\n", true))}`);
  return s.FAIL ? 1 : 0;
}

try { process.exitCode = main(); } catch (e) {
  if (!(e instanceof Exit)) { console.error(`pr-verify-profile: ${e.message}`); process.exitCode = /초안은|덮어쓰지/.test(e.message) ? 2 : 3; }
  else { console.error(e.code === 1 ? e.message : `pr-verify-profile: ${e.message}`); process.exitCode = e.code; }
}
