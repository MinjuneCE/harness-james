// /pr-verify diff 밖 결정적 신호: 갈림점(base) 기준으로 reach·ledger·co-change(·reach-compare)를 돌려
// RUN_DIR/signals/<tool>.json, RUN_DIR/signals/summary.md, RUN_DIR/replicas/를 만든다.
// 신호는 판정 자료로만 붙인다. 판정 범위·점수는 바꾸지 않는다.
// 도구는 플러그인에 없고 프로젝트가 준비한다. 위치: VERIFY_SIGNAL_BIN(reach·ledger-check·co-change), 피처맵은 VERIFY_FM_BIN
// (둘 다 워크스페이스 기준 상대 경로 또는 절대 경로). 돌아야 하는 도구의 위치가 설정되지 않았거나 파일이 없으면
// 그 도구는 status error와 경고로 남고 실행은 이어진다(framework 3.7). 신호 JSON v1 형식은 각 도구가 낸다.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { git, gitTry, matchesAny, resolveCommit } from "./lib.mjs";

export const SIGNAL_TOOLS = ["reach", "ledger", "co-change", "reach-compare", "feature-map"];
const BIN_FILE = { reach: "reach.mjs", "reach-compare": "reach.mjs", ledger: "ledger-check.mjs", "co-change": "co-change.mjs", "feature-map": "fm-check.mjs" };
const SEV_ORDER = ["FAIL", "WARN", "INFO"];
const TOOL_TIMEOUT_MS = 20 * 60 * 1000;
const SUMMARY_MAX_ITEMS = 200; // 도구 하나가 summary.md에 싣는 항목 수 (JSON에는 전부 남음)
const SUMMARY_MAX_INFO = 10; // 도구 하나의 INFO가 이보다 많으면 summary.md에는 종류별 개수만

export const SIGNAL_ENV = { signal: "VERIFY_SIGNAL_BIN", "feature-map": "VERIFY_FM_BIN" };
export const signalBin = (ws) => (process.env.VERIFY_SIGNAL_BIN ? resolve(ws, process.env.VERIFY_SIGNAL_BIN) : null);
export const featureMapBin = (ws) => (process.env.VERIFY_FM_BIN ? resolve(ws, process.env.VERIFY_FM_BIN) : null);

// 갈림점 = merge-base(<기준 ref>, head). 기준 ref는 PR 대상이면 PR base, 아니면 프로파일 default_base
export function forkPoint(repo, baseRef, headSha) {
  const name = baseRef.replace(/^origin\//, "");
  const sha = resolveCommit(repo, baseRef) ?? resolveCommit(repo, `origin/${name}`) ?? resolveCommit(repo, name);
  if (!sha) return { ref: baseRef, sha: null, fork: null };
  return { ref: baseRef, sha, fork: gitTry(repo, ["merge-base", sha, headSha]) };
}

function runTool(ws, bin, tool, args, out) {
  const rec = { tool, status: "error", note: null, json: relative(ws, out), items: 0, by_severity: {}, elapsed_ms: 0 };
  if (!bin) { rec.note = `도구 위치 설정 안 됨: ${SIGNAL_ENV[tool === "feature-map" ? "feature-map" : "signal"]}`; return { rec, data: null }; }
  const file = join(bin, BIN_FILE[tool]);
  if (!existsSync(file)) { rec.note = `도구 없음: ${relative(ws, file) || file}`; return { rec, data: null }; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [file, ...args, "--json", out], { cwd: ws, encoding: "utf8", timeout: TOOL_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  rec.elapsed_ms = Date.now() - t0;
  let data = null;
  try { data = JSON.parse(readFileSync(out, "utf8")); } catch {}
  const tail = (s) => String(s ?? "").trim().split("\n").slice(-3).join(" / ").slice(0, 300);
  if (r.error) { rec.note = `실행 실패: ${r.error.code === "ETIMEDOUT" ? `${TOOL_TIMEOUT_MS / 60000}분 초과` : r.error.message}`; return { rec, data: null }; }
  if (r.status !== 0) {
    rec.note = `종료 코드 ${r.status}${data?.note ? `: ${data.note}` : tail(r.stderr) ? `: ${tail(r.stderr)}` : ""}`;
    return { rec, data: data?.status === "error" ? data : null };
  }
  if (!data || data.version !== 1 || !Array.isArray(data.items)) { rec.note = `신호 JSON v1을 읽지 못함 (${rec.json})`; return { rec, data: null }; }
  const expect = tool === "ledger" ? ["ledger"] : [tool];
  if (!expect.includes(data.tool)) rec.note = `tool 값이 ${data.tool} (기대 ${expect[0]})`;
  rec.status = ["ok", "skipped", "error"].includes(data.status) ? data.status : "error";
  rec.note = [rec.note, data.note].filter(Boolean).join(" · ") || null;
  rec.items = data.items.length;
  for (const it of data.items) rec.by_severity[it.severity] = (rec.by_severity[it.severity] ?? 0) + 1;
  return { rec, data };
}

// dependents[].source를 이 실행 diff가 건드리면 복제본을 그 ref의 내용으로 RUN_DIR/replicas/<repo key>/<path>에 둔다
function collectReplicas(ws, runDir, profile, profiles, changedPaths, warnings) {
  const out = [];
  for (const dep of profile.dependents ?? []) {
    const touched = changedPaths.filter((p) => matchesAny(p, [dep.source]));
    if (!touched.length) continue;
    for (const rp of dep.replicas ?? []) {
      const other = profiles.find((p) => p.repo.key === rp.repo);
      const rec = { source: dep.source, touched: touched.slice(0, 10), repo: rp.repo, ref: null, sha: null, path: rp.path, files: [], note: dep.note ?? null, missing: null };
      if (!other) { rec.missing = `프로파일 없음: ${rp.repo}`; warnings.push(`복제본 레포 ${rp.repo}의 프로파일이 없음 (dependents ${dep.source})`); out.push(rec); continue; }
      const repoDir = join(ws, other.repo.path);
      rec.ref = rp.ref ?? other.repo.default_base;
      rec.sha = existsSync(repoDir) ? resolveCommit(repoDir, rec.ref) ?? resolveCommit(repoDir, `origin/${rec.ref.replace(/^origin\//, "")}`) : null;
      if (!rec.sha) { rec.missing = `ref를 찾지 못함: ${rec.ref}`; warnings.push(`복제본 ${rp.repo}:${rp.path}의 ref ${rec.ref}를 찾지 못함`); out.push(rec); continue; }
      const glob = /[*?[]/.test(rp.path);
      const paths = glob
        ? (gitTry(repoDir, ["ls-tree", "-r", "--name-only", rec.sha]) ?? "").split("\n").filter((p) => p && matchesAny(p, [rp.path]))
        : [rp.path];
      for (const p of paths) {
        let body;
        try { body = git(repoDir, ["show", `${rec.sha}:${p}`], { quiet: true, encoding: "buffer" }); } catch { continue; }
        const dest = join(runDir, "replicas", rp.repo, p);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, body);
        rec.files.push(relative(runDir, dest));
      }
      if (!rec.files.length) rec.missing = `${rec.ref}에 파일 없음`;
      out.push(rec);
    }
  }
  return out;
}

const loc = (e) => `\`${e.file}${e.line ? `:${e.line}` : ""}\``;
const sec = (ms) => `${(ms / 1000).toFixed(1)}초`;
const sevText = (by) => SEV_ORDER.filter((s) => by[s]).map((s) => `${s} ${by[s]}`).join(" · ");

function summaryMd({ mode, fork, head, runBase, repoPath, tools, datas, replicas }) {
  const L = [];
  L.push(`# diff 밖 결정적 신호 (${mode === "full" ? "전체 모드" : "증분 범위 밖 누적"})`, "");
  L.push("도구가 찾은 diff 밖 사실과 근거예요. 판정에 쓰려면 코드에서 확인해요. 신호는 판정 범위와 점수를 바꾸지 않아요.", "");
  L.push(`- 범위: 갈림점 \`${fork.slice(0, 7)}\` .. head \`${head.slice(0, 7)}\``);
  if (mode !== "full") L.push(`- 이 실행의 diff는 \`${runBase.slice(0, 7)}\`부터예요. 아래 항목은 그 앞 커밋까지 포함한 누적 범위라서 diff에 안 보일 수 있어요.`);
  L.push(`- base 쪽 근거 줄은 갈림점 트리 기준이에요${mode === "full" ? " (`RUN_DIR/base/`와 같음)" : ` (\`git -C ${repoPath} show ${fork.slice(0, 7)}:<file>\`)`}.`);
  L.push(`- 도구: ${tools.map((t) => `${t.tool} ${t.status}${t.status === "ok" ? ` ${t.items}건${t.items ? ` (${sevText(t.by_severity)})` : ""}` : ""}${t.elapsed_ms ? ` ${sec(t.elapsed_ms)}` : ""}`).join(" / ")}`, "");
  for (const t of tools) {
    const d = datas[t.tool];
    L.push(`## ${t.tool} — ${t.status}${t.status === "ok" ? `, ${t.items}건` : ""}`, "");
    if (t.note) L.push(`- 메모: ${t.note}`, "");
    if (!d?.items?.length) { if (t.status === "ok") L.push("항목 없음.", ""); continue; }
    // INFO가 많으면 종류별 개수만 싣는다 (항목은 도구 JSON에 전부 있음)
    const infos = d.items.filter((it) => it.severity === "INFO");
    const collapse = infos.length > SUMMARY_MAX_INFO;
    const items = d.items.filter((it) => !collapse || it.severity !== "INFO").sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity));
    if (collapse) {
      const kinds = {};
      for (const it of infos) kinds[it.kind] = (kinds[it.kind] ?? 0) + 1;
      L.push(`- INFO ${infos.length}건은 개수만 적어요: ${Object.entries(kinds).map(([k, n]) => `${k} ${n}`).join(", ")} (\`${t.json}\`)`);
    }
    for (const it of items.slice(0, SUMMARY_MAX_ITEMS)) {
      L.push(`- ${it.severity} ${it.kind} \`${it.symbol}\` — ${it.message}`);
      if (it.head?.length) L.push(`  - head: ${it.head.map(loc).join(", ")}`);
      if (it.base?.length) L.push(`  - base: ${it.base.map(loc).join(", ")}`);
      if (it.docs?.length) L.push(`  - 문서: ${it.docs.map(loc).join(", ")}`);
    }
    if (items.length > SUMMARY_MAX_ITEMS) L.push(`- … 외 ${items.length - SUMMARY_MAX_ITEMS}건 (\`${t.json}\`)`);
    L.push("");
  }
  if (replicas.length) {
    L.push("## 다른 레포 복제본 (프로파일 dependents)", "");
    L.push("이 실행 diff가 원천을 건드려서, 복제본을 그 ref의 내용으로 `RUN_DIR/replicas/`에 뒀어요.", "");
    for (const r of replicas) {
      const touched = r.touched.length === 1 && r.touched[0] === r.source ? "" : `(${r.touched.map((p) => `\`${p}\``).join(", ")})`;
      L.push(`- \`${r.source}\` 변경${touched} → ${r.repo} \`${r.path}\` @ \`${r.ref ?? "-"}\`${r.sha ? ` (${r.sha.slice(0, 7)})` : ""}${r.note ? ` — ${r.note}` : ""}`);
      if (r.files.length) L.push(`  - 사본: ${r.files.map((f) => `\`${f}\``).join(", ")}`);
      if (r.missing) L.push(`  - 못 가져옴: ${r.missing}`);
    }
    L.push("");
  }
  return L.join("\n");
}

// mode: "full" | "incremental". fork: 갈림점 sha. runBase: 이 실행 diff의 merge-base. changedPaths: 이 실행 diff가 바꾼 경로(옛 경로 포함)
export function runOutsideSignals({ ws, runDir, profile, profiles, repo, mode, fork, head, runBase, branch, mergeRef, changedPaths, warnings }) {
  const t0 = Date.now();
  const bin = signalBin(ws);
  const dir = join(runDir, "signals");
  mkdirSync(dir, { recursive: true });
  const outOf = (tool) => join(dir, `${tool}.json`);
  const tools = [];
  const datas = {};
  const skip = (tool, note) => tools.push({ tool, status: "skipped", note, json: null, items: 0, by_severity: {}, elapsed_ms: 0 });
  const go = (tool, args, from = bin) => {
    const { rec, data } = runTool(ws, from, tool, args, outOf(tool));
    tools.push(rec);
    if (data) datas[tool] = data;
    if (rec.status === "error") warnings.push(`신호 ${tool} 실패 — 이 신호 없이 진행: ${rec.note ?? "이유 없음"}`);
  };
  // 장부: 대상 브랜치 이름으로 찾고, SHA 대상이면 그 커밋을 품은 장부 브랜치(로컬 또는 origin)로 찾는다
  const contains = (b) => [b, `origin/${b}`].some((ref) => { const tip = resolveCommit(repo, ref); return tip && (tip === head || gitTry(repo, ["merge-base", "--is-ancestor", head, tip]) !== null); });
  const ledger = (profile.ledgers ?? []).find((l) => branch && (l.branches ?? []).includes(branch))
    ?? (branch ? null : (profile.ledgers ?? []).find((l) => (l.branches ?? []).some(contains)) ?? null);

  const javaRepo = ["build.gradle", "build.gradle.kts", "gradlew"].some((f) => gitTry(repo, ["cat-file", "-e", `${head}:${f}`]) !== null);
  if (!javaRepo) skip("reach", "Gradle 레포 아님(head 트리에 build.gradle·gradlew 없음)");
  else go("reach", ["--repo", repo, "--base", fork, "--head", head, ...(process.env.VERIFY_REACH_CACHE ? ["--cache", process.env.VERIFY_REACH_CACHE] : [])]);

  if (!ledger) skip("ledger", branch ? `프로파일 ledgers에 ${branch} 없음` : "SHA 대상이고 이 커밋을 품은 장부 브랜치가 없음");
  else go("ledger", ["--repo", repo, "--ref", head, "--ledger", ledger.plan, ...(ledger.tasks ? ["--tasks", ledger.tasks] : []), ...(ledger.docs ?? []).flatMap((g) => ["--docs", g]), "--base", fork]);

  if (!(profile.dependents ?? []).length) skip("co-change", "프로파일 dependents 없음");
  else go("co-change", ["--profile", profile._path, "--repo", repo, "--base", fork, "--head", head, ...(ledger ? ["--ledger", ledger.plan] : [])]);

  if (mergeRef) {
    if (!javaRepo) skip("reach-compare", "Gradle 레포 아님");
    else go("reach-compare", ["--repo", repo, "--compare", "--a", head, "--b", mergeRef, "--base", fork, ...(process.env.VERIFY_REACH_CACHE ? ["--cache", process.env.VERIFY_REACH_CACHE] : [])]);
  }

  // 피처맵: 프로파일에 feature_map이 있는 레포만. 기능 파일 낡음과 갈림점 뒤 구조에 안 걸린 파일
  if (profile.feature_map) go("feature-map", ["--profile", profile._path, "--repo", repo, "--base", fork, "--head", head], featureMapBin(ws));

  const replicas = collectReplicas(ws, runDir, profile, profiles, changedPaths, warnings);
  const summaryPath = join(dir, "summary.md");
  writeFileSync(summaryPath, summaryMd({ mode, fork, head, runBase, repoPath: relative(ws, repo) || repo, tools, datas, replicas }));
  const count = (sev) => tools.reduce((n, t) => n + (t.by_severity[sev] ?? 0), 0);
  return {
    base: fork,
    bin: bin ? relative(ws, bin) || bin : null,
    tools,
    counts: { total: tools.reduce((n, t) => n + t.items, 0), FAIL: count("FAIL"), WARN: count("WARN"), INFO: count("INFO") },
    replicas,
    replica_files: [...new Set(replicas.flatMap((r) => r.files))].length,
    summary: relative(ws, summaryPath),
    elapsed_ms: Date.now() - t0,
  };
}
