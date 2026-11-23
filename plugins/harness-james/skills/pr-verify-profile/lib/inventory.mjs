// 레포 훑기(읽기만): 파일 목록·폴더 묶음·바뀐 횟수·레포 성격·뺄 파일 후보·주석 문법·예시 env 키 이름.
// 구조를 정하는 판단은 하지 않는다. 판단에 쓸 사실만 모은다.
import { basename, dirname, extname } from "node:path";
import { matchesAny } from "./glob.mjs";
import { isExampleEnv, isRealEnv, localLag } from "./git.mjs";
import { IGNORE_CLASSES } from "./ignore.mjs";

const C_STYLE = ["//", "/*", "*", "*/"];
const HASH = ["#"];
// 등록된 프로필에 없는 확장자의 기본 주석 문법
const DEFAULT_COMMENT_SYNTAX = {
  "**/*.java": C_STYLE, "**/*.kt": C_STYLE, "**/*.gradle": C_STYLE, "**/*.js": C_STYLE, "**/*.jsx": C_STYLE, "**/*.mjs": C_STYLE, "**/*.cjs": C_STYLE,
  "**/*.ts": C_STYLE, "**/*.tsx": C_STYLE, "**/*.scss": C_STYLE, "**/*.css": ["/*", "*", "*/"], "**/*.sql": ["--", "/*", "*", "*/"],
  "**/*.yml": HASH, "**/*.yaml": HASH, "**/*.toml": HASH, "**/*.properties": ["#", "!"], "**/*.sh": HASH, "**/*.py": HASH, "**/*.service": HASH, "**/*.graphql": HASH,
  "**/*.prisma": ["//", "///"], "**/Dockerfile": HASH, "**/.env*": HASH, "**/*.example": HASH,
};
// 레포 성격(traits) 추정. 근거 파일을 같이 낸다
export function detectKind(tree) {
  const has = (g) => tree.some((p) => matchesAny(p, [g]));
  const signals = [];
  const traits = new Set();
  let kind = "unknown";
  if (["build.gradle", "build.gradle.kts", "pom.xml"].some(has)) { traits.add("server"); signals.push("빌드 파일(gradle·maven)"); kind = "server"; }
  if (["go.mod", "Cargo.toml", "Gemfile", "composer.json", "manage.py"].some(has)) { traits.add("server"); signals.push("서버 언어 빌드·진입 파일(go·cargo·gem·composer·django)"); if (kind === "unknown") kind = "server"; }
  if (["**/Dockerfile", "**/docker-compose*.yml", "**/compose*.yml"].some(has)) { traits.add("server"); signals.push("Dockerfile·compose(배포되는 프로세스)"); if (kind === "unknown") kind = "server"; }
  if (["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "index.html", "public/index.html"].some(has)) { traits.add("client"); signals.push("화면 코드(tsx·jsx·vue·svelte·index.html)"); kind = kind === "unknown" ? "client" : "app"; }
  if (has("layout/theme.liquid") || (has("sections/*.liquid") && has("templates/*"))) { traits.add("client"); signals.push("layout·sections·templates(테마)"); kind = "theme"; }
  return { kind, traits: ["server", "client"].filter((t) => traits.has(t)), signals };
}

const slugOf = (url) => {
  const m = String(url ?? "").trim().match(/github\.com[:/]+([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/i);
  return m ? m[1] : null;
};

// default_base 후보: 원격의 기본 브랜치(origin/HEAD가 가리키는 것)가 먼저, 그다음 흔한 이름 순서. 있는 것만
export function baseCandidates(g) {
  const originHead = g.tryRun("rev-parse", "--abbrev-ref", "origin/HEAD")?.trim();
  const named = originHead && originHead !== "origin/HEAD" && /^origin\//.test(originHead) ? [originHead] : [];
  return [...new Set([...named, "origin/main", "origin/master", "origin/dev", "origin/develop"])].filter((r) => g.commit(r));
}

export function inventory({ g, ref, profiles = [], repoPath }) {
  const sha = g.commit(ref);
  if (!sha) throw new Error(`ref ${ref}를 찾지 못함 (${g.dir})`);
  const tree = g.tree(sha);
  const github = slugOf(g.tryRun("remote", "get-url", "origin"));
  const name = github ? github.split("/")[1] : basename(g.dir);

  // 파일마다 건드린 커밋 수. 첫 커밋(뿌리)에서만 나온 파일은 그 뒤로 안 바뀐 것이다(템플릿 그대로일 수 있다)
  const roots = g.lines("rev-list", "--max-parents=0", sha).map((r) => {
    const [date, ...subject] = (g.tryRun("log", "-1", "--format=%cs\t%s", r) ?? "").trim().split("\t");
    return { sha: r, date, subject: subject.join("\t") };
  }).sort((a, b) => a.date.localeCompare(b.date));
  const rootSet = new Set(roots.map((r) => r.sha));
  const commits = new Map();
  const onlyRoot = new Map();
  let cur = null;
  for (const l of (g.tryRun("log", "--no-renames", "--root", "--name-only", "--format=%x00%H", "-n", "5000", sha) ?? "").split("\n")) {
    if (l.startsWith("\0")) { cur = l.slice(1); continue; }
    if (!l) continue;
    commits.set(l, (commits.get(l) ?? 0) + 1);
    onlyRoot.set(l, (onlyRoot.get(l) ?? true) && rootSet.has(cur));
  }
  const untouched = (p) => onlyRoot.get(p) === true;

  // 폴더 묶음
  const byDir = new Map();
  for (const p of tree) { const d = dirname(p); if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(p); }
  const groups = [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, files]) => ({
    dir, files: files.length, commits: files.reduce((n, p) => n + (commits.get(p) ?? 0), 0), untouched_since_root: files.filter(untouched).length, names: files.map((p) => basename(p)),
  }));

  // 앞 glob이 이미 잡은 파일만 잡는 glob은 뺀다(src/test/** 다음의 **/test/**, README.md 다음의 **/*.md 등)
  const taken = new Set();
  const ignore_candidates = IGNORE_CLASSES.flatMap((c) => {
    return c.globs.map((glob) => {
      const hit = tree.filter((p) => matchesAny(p, [glob]));
      const fresh = hit.filter((p) => !taken.has(p));
      for (const p of hit) taken.add(p);
      return { glob, reason: c.reason, sure: c.sure, files: hit.length, fresh: fresh.length, sample: hit.length <= 3 ? hit : [] };
    }).filter((x) => x.fresh).map(({ fresh, ...x }) => x);
  });

  // 주석 문법: 등록된 프로필이 이미 쓰는 것이 먼저, 없으면 기본 표. 이 레포에 그 파일이 있을 때만
  const known = {};
  for (const p of profiles) for (const [glob, v] of Object.entries(p.comment_syntax ?? {})) known[glob] ??= v;
  const comment_syntax = {};
  for (const [glob, v] of Object.entries({ ...DEFAULT_COMMENT_SYNTAX, ...known })) if (tree.some((p) => matchesAny(p, [glob]))) comment_syntax[glob] = v;
  const ignore_line_patterns = {};
  for (const p of profiles) for (const [glob, v] of Object.entries(p.ignore_line_patterns ?? {})) if (!ignore_line_patterns[glob] && tree.some((f) => matchesAny(f, [glob]))) ignore_line_patterns[glob] = v;

  const by_ext = {};
  for (const p of tree) { const e = extname(p) || basename(p); by_ext[e] = (by_ext[e] ?? 0) + 1; }
  const env_keys = Object.fromEntries(tree.filter(isExampleEnv).map((p) => [p, g.envKeys(sha, p)]));

  const kind = detectKind(tree);
  const sameTraits = (p) => JSON.stringify([...(p.repo?.traits ?? [])].sort()) === JSON.stringify([...kind.traits].sort());
  const preset = profiles.find(sameTraits) ?? null;
  const bases = baseCandidates(g);
  const originHead = g.tryRun("rev-parse", "--abbrev-ref", "origin/HEAD")?.trim() || null;
  const lags = g.lines("for-each-ref", "--format=%(refname:short)", "refs/heads").map((b) => ({ branch: b, ...(localLag(g, b) ?? {}) })).filter((b) => b.behind > 0);

  return {
    repo: { name, github, path: repoPath, ref, sha, default_base_candidates: bases, origin_head: originHead, last_fetch: g.lastFetch(), roots, local_branches_behind_origin: lags },
    kind: { ...kind, preset_from: preset ? { key: preset.repo.key, file: basename(preset._path) } : null },
    registered: profiles.filter((p) => (github && p.repo?.github?.toLowerCase() === github.toLowerCase()) || p.repo?.name === name).map((p) => ({ key: p.repo.key, file: basename(p._path) })),
    other_profiles: profiles.map((p) => ({ key: p.repo.key, name: p.repo.name, traits: p.repo.traits ?? [] })),
    files: { total: tree.length, untouched_since_root: tree.filter(untouched).length, by_ext },
    groups, ignore_candidates, comment_syntax, ignore_line_patterns, env_keys,
    // 레포에 커밋된 진짜 env 파일(경로만. 내용은 읽지 않는다)
    committed_env_files: tree.filter(isRealEnv),
  };
}

export function inventoryText(inv) {
  const L = [];
  const r = inv.repo;
  L.push(`# ${r.name} @ ${r.ref} (${r.sha.slice(0, 7)})`, "");
  L.push(`- GitHub: ${r.github ?? "origin 없음"} · 경로: ${r.path}`);
  L.push(`- 성격 추정: ${inv.kind.traits.join("+") || "모름(직접 정해요)"} — 근거: ${inv.kind.signals.join(", ") || "없음"}${inv.kind.preset_from ? ` · 같은 성격의 등록 프로필: ${inv.kind.preset_from.file}` : ""}`);
  L.push(`- default_base 후보: ${r.default_base_candidates.join(", ") || "없음"} (origin/HEAD → ${r.origin_head ?? "?"})`);
  L.push(`- 마지막 fetch: ${r.last_fetch ?? "기록 없음"} — origin 쪽 ref는 이 시각의 것이에요. 이 도구는 fetch하지 않아요`);
  L.push(`- 첫 커밋(첫 검증의 base 후보${r.roots.length > 1 ? ". 뿌리가 여럿이면 맨 앞의 가장 오래된 것을 쓴다" : ""}): ${r.roots.map((x) => `${x.sha.slice(0, 7)} ${x.date} ${x.subject.slice(0, 50)}`).join(" / ")}`);
  if (r.local_branches_behind_origin.length) L.push(`- origin보다 뒤처진 로컬 브랜치: ${r.local_branches_behind_origin.map((b) => `${b.branch}(${b.behind}커밋 뒤)`).join(", ")} — ref는 origin/…로 적어요`);
  if (inv.registered.length) L.push(`- 이미 등록된 프로필: ${inv.registered.map((p) => p.file).join(", ")} — 새 초안이 아니라 변경안 모드로 가요`);
  L.push(`- 파일 ${inv.files.total}개, 그중 첫 커밋 뒤로 안 바뀐 것 ${inv.files.untouched_since_root}개`, "");
  L.push("## 폴더 묶음 (파일 수 · 건드린 커밋 합 · 첫 커밋 그대로인 파일 수)", "");
  for (const gr of inv.groups) L.push(`- \`${gr.dir}/\` ${gr.files} · ${gr.commits} · ${gr.untouched_since_root} — ${(gr.names.length <= 40 ? gr.names : gr.names.slice(0, 14)).join(", ")}${gr.names.length > 40 ? ` … 외 ${gr.names.length - 14}` : ""}`);
  L.push("", "## 구조에서 뺄 파일 후보 (coverage_ignore)", "");
  for (const c of inv.ignore_candidates) L.push(`- \`${c.glob}\` ${c.files}개${c.sample.length ? `(${c.sample.join(", ")})` : ""} — ${c.reason}${c.sure ? "" : " (판단 필요: 초안에 안 넣음)"}`);
  L.push("- 구조에 든 파일은 여기 걸려도 구조가 이긴다. 시험 폴더 밖의 시험(배포 스크립트 시험 등)이 섞였는지 본다.");
  if (inv.committed_env_files.length) L.push("", "## 커밋된 env 파일 (경로만. 내용은 읽지 않는다)", "", `- ${inv.committed_env_files.map((p) => `\`${p}\``).join(", ")} — 빌드·실행 값을 정하는 파일이라 구조에 넣을 후보다. 내용은 열지 않고 경로만 구조 paths에 적는다`);
  if (Object.keys(inv.env_keys).length) {
    L.push("", "## 예시 env 파일의 키 이름", "");
    for (const [p, keys] of Object.entries(inv.env_keys)) L.push(`- \`${p}\`: ${keys.join(", ") || "(키 없음)"}`);
  }
  return L.join("\n");
}
