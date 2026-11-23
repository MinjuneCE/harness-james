// 기계 점검 단위 시험: JSON 모양, 가중치 합, 별칭 중복, 빈 구조, 구조 밖 파일, 대조 상대 프로필, 구조 id 변경.
// 실행: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { aliasProblems, checkProfile, dependentProblems, diffProfiles, featureRefs, shapeProblems, siblingHint, treeCheck, weightProblems } from "../lib/check.mjs";
import { BASE_FILES, baseProfile, gitRepo, workspace, write } from "./helpers.mjs";

const ids = (items, level) => items.filter((i) => !level || i.level === level).map((i) => `${i.check}:${i.id}`);
const has = (items, check, level) => items.some((i) => i.check === check && (!level || i.level === level));

test("JSON 모양: 온전한 프로필은 문제 없음", () => {
  assert.deepEqual(shapeProblems(baseProfile()), []);
});

test("JSON 모양: 빠진 칸과 틀린 타입을 FAIL로 낸다", () => {
  const p = baseProfile();
  delete p.repo.github;
  p.repo.traits = [];
  p.version = "1.0";
  p.dimensions.XYZ = { weight: 0.1 };
  p.structures[0].criticality = 120;
  delete p.structures[1].why;
  p.structures.push({ id: "a.none", name: "빈 경로", criticality: 50, paths: [], why: "x" });
  p.dependents = [{ source: "src/pay/a.js", replicas: [{ path: "x.js" }] }];
  const got = ids(shapeProblems(p), "FAIL");
  for (const want of ["shape:version", "shape:repo.github", "shape:repo.traits", "shape:dimensions.XYZ", "shape:structures[0] a.pay", "shape:structures[1] a.cfg", "shape:structures[2] a.none", "shape:dependents[0].replicas[0]"]) assert.ok(got.includes(want), `${want} 없음: ${got.join(" ")}`);
});

test("JSON 모양: 객체가 아니면 바로 FAIL", () => {
  assert.equal(shapeProblems(null)[0].level, "FAIL");
  assert.equal(shapeProblems([])[0].id, "root");
});

test("rules: /pr-verify 준비 단계가 멈출 규칙은 FAIL, 다른 레포 규칙은 WARN, 읽지 않는 칸은 WARN", () => {
  const ok = { id: "r-ok", repo: "app", kind: "added-line-regex", criterion: "SEC-01", severity: "medium", confidence: "likely", paths: ["src/**"], pattern: "(?i)\\beval\\(" };
  assert.deepEqual(shapeProblems(baseProfile({ rules: [ok], disabled_rules: ["x"], rule_overrides: {} })), []);
  const got = shapeProblems(baseProfile({ known_debt: [], rules: [
    ok, { ...ok },
    { ...ok, id: "r-kind", kind: "nope" },
    { ...ok, id: "r-sev", severity: "huge" },
    { ...ok, id: "r-rx", pattern: "(" },
    { ...ok, id: "r-nopat", pattern: undefined },
    { ...ok, id: "r-other", repo: "web" },
    { repo: "app" },
  ], disabled_rules: "x" }));
  assert.deepEqual(ids(got, "WARN"), ["unread-key:known_debt", "rules:r-other"]);
  assert.deepEqual(ids(got, "FAIL"), ["rules:disabled_rules", "rules:r-ok", "rules:r-kind", "rules:r-sev", "rules:r-rx", "rules:r-nopat", "rules:rules[7]"]);
  assert.equal(shapeProblems(baseProfile({ rules: {} }))[0].id, "rules");
});

test("repo.path: 절대 경로는 FAIL(/pr-verify가 워크스페이스 뒤에 이어 붙임), ../ 상대 경로는 통과", () => {
  assert.deepEqual(ids(shapeProblems(baseProfile({ repo: { ...baseProfile().repo, path: "/abs/app" } }))), ["shape:repo.path"]);
  assert.deepEqual(shapeProblems(baseProfile({ repo: { ...baseProfile().repo, path: "../app" } })), []);
});

test("가중치 합: 1.0이면 조용, 아니면 FAIL", () => {
  assert.deepEqual(weightProblems(baseProfile()), []);
  assert.deepEqual(weightProblems(baseProfile({ dimensions: { SEC: { weight: 0.22 }, PERF: { weight: 0.15 }, ARCH: { weight: 0.13 }, REL: { weight: 0.25 }, OPS: { weight: 0.1 }, TEST: { weight: 0.15 } } })), [], "부동소수 오차는 넘어간다");
  const bad = weightProblems(baseProfile({ dimensions: { SEC: { weight: 0.5 }, REL: { weight: 0.4 } } }));
  assert.equal(bad[0].level, "FAIL");
  assert.match(bad[0].message, /0\.900/);
});

test("가중치: client 아닌 레포의 A11Y는 WARN", () => {
  const got = weightProblems(baseProfile({ dimensions: { SEC: { weight: 0.5 }, A11Y: { weight: 0.5 } } }));
  assert.deepEqual(ids(got, "WARN"), ["weights:A11Y"]);
});

test("별칭 중복: 다른 프로필의 key·name·별칭과 겹치면 FAIL(대소문자 무시)", () => {
  const other = { ...baseProfile(), repo: { ...baseProfile().repo, key: "shop", name: "Shop-App", github: "acme/shop", aliases: ["shop", "APP2"] }, _path: "/x/shop.json" };
  assert.deepEqual(aliasProblems(baseProfile(), [other]), []);
  const p = baseProfile();
  p.repo.aliases = ["app", "shop-app", "app2"];
  const got = aliasProblems(p, [other]);
  assert.equal(got.length, 1);
  assert.match(got[0].message, /shop\.json와 이름이 겹침: shop-app, app2/);
});

test("별칭 중복: 같은 github이면 FAIL, 자기 별칭끼리 겹치면 INFO", () => {
  const other = { ...baseProfile(), repo: { ...baseProfile().repo, key: "o", name: "o", aliases: ["o"] }, _path: "/x/o.json" };
  assert.ok(ids(aliasProblems(baseProfile(), [other]), "FAIL").includes("alias:github"));
  const p = baseProfile();
  p.repo.aliases = ["app", "App"];
  assert.deepEqual(ids(aliasProblems(p, []), "INFO"), ["alias:app"]);
});

test("구조 id가 겹치면 FAIL", () => {
  const p = baseProfile();
  p.structures.push({ ...p.structures[0] });
  assert.ok(ids(aliasProblems(p, []), "FAIL").includes("structure-id:a.pay"));
});

test("트리 점검: 다 걸리면 조용하고 구조별 파일 수를 낸다", () => {
  const r = treeCheck({ profile: baseProfile(), tree: Object.keys(BASE_FILES) });
  assert.deepEqual(r.items, []);
  assert.deepEqual(r.rows.map((x) => [x.id, x.files]), [["a.pay", 1], ["a.cfg", 2]]);
});

test("트리 점검: 빈 구조는 WARN", () => {
  const p = baseProfile();
  p.structures.push({ id: "a.gone", name: "없어진 것", criticality: 80, paths: ["src/gone/**"], why: "x" });
  const r = treeCheck({ profile: p, tree: Object.keys(BASE_FILES) });
  assert.deepEqual(ids(r.items, "WARN"), ["empty-structure:a.gone"]);
  assert.equal(r.rows.at(-1).files, 0);
});

test("트리 점검: 구조 밖 파일을 잡고, 같은 폴더 단서와 뺄 파일 후보를 붙인다", () => {
  const tree = [...Object.keys(BASE_FILES), "src/pay/refund.js", "src/mail/send.js", "config/extra.json", ".editorconfig"];
  const r = treeCheck({ profile: baseProfile(), tree });
  const it = r.items.find((i) => i.check === "uncovered-tree");
  assert.equal(it.level, "WARN");
  assert.match(it.message, /9개 중 3개/);
  assert.equal(it.files.length, 3, "src/pay/refund.js는 src/pay/**에 걸린다");
  assert.ok(it.files.some((f) => f.startsWith("config/extra.json") && f.includes("a.cfg 1개")));
  assert.ok(it.files.some((f) => f.startsWith(".editorconfig") && f.includes("coverage_ignore 후보(서식·린트 설정)")));
  assert.equal(r.stats.uncovered_tree, 3);
});

test("트리 점검: 바뀐 파일 중 구조 밖인 것만 따로 낸다(coverage_ignore는 뺀다)", () => {
  const tree = [...Object.keys(BASE_FILES), "src/mail/send.js"];
  const r = treeCheck({ profile: baseProfile(), tree, changed: ["src/pay/charge.js", "src/mail/send.js", "src/test/charge.test.js"] });
  const it = r.items.find((i) => i.check === "uncovered-changed");
  assert.match(it.message, /3개 중 1개/);
  assert.deepEqual(it.files.map((f) => f.split("  ")[0]), ["src/mail/send.js"]);
  assert.deepEqual(r.rows.map((x) => x.changed), [1, 0]);
});

test("트리 점검: 구조 밖 파일이 많으면 목록 대신 폴더 요약", () => {
  const tree = [...Object.keys(BASE_FILES), ...Array.from({ length: 70 }, (_, i) => `assets/img/p${i}.dat`)];
  const it = treeCheck({ profile: baseProfile(), tree }).items.find((i) => i.check === "uncovered-tree");
  assert.equal(it.files.length, 0);
  assert.equal(it.more, 70);
  assert.match(it.message, /assets\/img\/ 70/);
});

test("트리 점검: 겹침·죽은 경로·주석 문법 없음은 INFO", () => {
  const p = baseProfile();
  p.structures[1].paths.push("src/pay/charge.js", "nothing/**");
  p.coverage_ignore.push("vendor/**");
  delete p.comment_syntax["**/*.yml"];
  const r = treeCheck({ profile: p, tree: Object.keys(BASE_FILES) });
  assert.deepEqual(ids(r.items, "WARN"), []);
  assert.deepEqual(ids(r.items, "INFO").sort(), ["comment-syntax:comment_syntax", "dead-path:paths", "ignore-dead:coverage_ignore", "overlap:overlap"]);
});

test("같은 폴더 단서: 같은 폴더가 먼저, 없으면 위 폴더, 루트는 루트 파일만", () => {
  const st = baseProfile().structures;
  const tree = ["src/pay/charge.js", "src/pay/sub/x.js", "config/app.yml", "package.json", "tool.cfg", "docs/a.md", "src/other/deep/z.js"];
  assert.deepEqual(siblingHint("src/pay/new.js", tree, st), { dir: "src/pay", top: [{ id: "a.pay", n: 1 }] });
  assert.deepEqual(siblingHint("src/other/deep/z.js", tree, st), { dir: "src", top: [{ id: "a.pay", n: 2 }] });
  assert.deepEqual(siblingHint("tool.cfg", tree, st), { dir: ".", top: [{ id: "a.cfg", n: 1 }] });
  assert.equal(siblingHint("tool.cfg", ["tool.cfg", "src/pay/charge.js"], st), null, "루트에 구조 파일이 없으면 단서 없음");
});

function twoRepos() {
  const w = workspace();
  const web = gitRepo(join(w.ws, "web"), { origin: "https://github.com/acme/web.git" });
  web.commit("init", { "src/client.js": "x\n" });
  web.setOrigin("dev");
  const webProfile = { ...baseProfile(), repo: { key: "web", name: "web", path: "web", github: "acme/web", default_base: "origin/dev", aliases: ["web"], traits: ["client"] }, _path: join(w.ws, "docs/evaluation/profiles/web.json") };
  const dep = (over = {}) => baseProfile({ dependents: [{ source: "src/pay/charge.js", replicas: [{ repo: "web", path: "src/client.js", ref: "origin/dev", ...over }] }] });
  return { ...w, web, webProfile, dep };
}

test("대조: 상대 프로필이 등록돼 있고 ref·파일이 맞으면 조용", () => {
  const t = twoRepos();
  try {
    assert.deepEqual(dependentProblems({ profile: t.dep(), tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws }), []);
  } finally { t.cleanup(); }
});

test("대조: 상대 프로필이 없으면 WARN, 초안에만 있으면 INFO", () => {
  const t = twoRepos();
  try {
    const none = dependentProblems({ profile: t.dep(), tree: Object.keys(BASE_FILES), registered: [], ws: t.ws });
    assert.deepEqual(ids(none), ["dependent-repo:web"]);
    assert.equal(none[0].level, "WARN");
    assert.match(none[0].message, /프로필이 없음/);
    const draftOnly = dependentProblems({ profile: t.dep(), tree: Object.keys(BASE_FILES), registered: [], siblings: [t.webProfile], ws: t.ws });
    assert.deepEqual(draftOnly.map((i) => `${i.level}:${i.check}`), ["INFO:dependent-repo"]);
  } finally { t.cleanup(); }
});

test("대조: 원천·상대 파일이 없으면 WARN", () => {
  const t = twoRepos();
  try {
    const p = baseProfile({ dependents: [{ source: "src/pay/none.js", replicas: [{ repo: "web", path: "src/none.js", ref: "origin/dev" }] }] });
    const got = dependentProblems({ profile: p, tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws });
    assert.deepEqual(ids(got, "WARN"), ["dependent-source:src/pay/none.js", "dependent-path:web:src/none.js"]);
  } finally { t.cleanup(); }
});

test("대조: ref가 로컬 브랜치 이름이고 origin보다 뒤처져 있으면 WARN(몇 커밋 뒤인지), 같으면 INFO", () => {
  const t = twoRepos();
  try {
    const same = dependentProblems({ profile: t.dep({ ref: "dev" }), tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws });
    assert.deepEqual(same.map((i) => `${i.level}:${i.check}`), ["INFO:dependent-ref"]);
    // origin/dev만 두 커밋 앞서게 한다(로컬 dev는 그대로)
    const local = t.web.git("rev-parse", "HEAD");
    t.web.commit("c2", { "src/client.js": "y\n" });
    t.web.commit("c3", { "src/client.js": "z\n" });
    t.web.setOrigin("dev");
    t.web.git("update-ref", "refs/heads/dev", local);
    const behind = dependentProblems({ profile: t.dep({ ref: "dev" }), tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws });
    assert.equal(behind[0].level, "WARN");
    assert.match(behind[0].message, /origin\/dev보다 2커밋 뒤/);
  } finally { t.cleanup(); }
});

test("대조: 이미 default_base에 들어간 옛 브랜치를 가리키면 WARN", () => {
  const t = twoRepos();
  try {
    t.web.setOrigin("feat/old");
    t.web.commit("later", { "src/client.js": "y\n" });
    t.web.setOrigin("dev");
    const got = dependentProblems({ profile: t.dep({ ref: "origin/feat/old" }), tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws });
    assert.deepEqual(ids(got, "WARN"), ["dependent-ref:web:origin/feat/old:stale"]);
    assert.match(got[0].message, /1커밋 뒤/);
  } finally { t.cleanup(); }
});

test("대조: 없는 ref와 없는 레포 폴더는 WARN", () => {
  const t = twoRepos();
  try {
    const noRef = dependentProblems({ profile: t.dep({ ref: "origin/nope" }), tree: Object.keys(BASE_FILES), registered: [t.webProfile], ws: t.ws });
    assert.match(noRef[0].message, /origin\/nope를 web에서 찾지 못함/);
    const gone = { ...t.webProfile, repo: { ...t.webProfile.repo, path: "missing" } };
    const noDir = dependentProblems({ profile: t.dep(), tree: Object.keys(BASE_FILES), registered: [gone], ws: t.ws });
    assert.match(noDir[0].message, /레포 폴더가 없음/);
  } finally { t.cleanup(); }
});

const META = (st) => `<!-- fm: id=001-pay; repo=app; spec=docs/sdd/app/specs/001-pay; structures=${st}; verified=dev@abc1234; date=2026-11-16; status=clean -->\n# Pay\n`;

test("피처맵 메타의 structures= 칸을 읽는다", () => {
  const w = workspace();
  try {
    write(w.ws, { "map/001-pay.md": META("a.pay, a.cfg"), "map/002-none.md": "# no meta\n", "map/README.md": "index\n" });
    assert.deepEqual(featureRefs(w.ws, baseProfile({ feature_map: "map" })), [
      { file: "map/001-pay.md", id: "001-pay", structures: ["a.pay", "a.cfg"] },
      { file: "map/002-none.md", id: "002-none", structures: [] },
    ]);
    assert.deepEqual(featureRefs(w.ws, baseProfile()), []);
  } finally { w.cleanup(); }
});

test("등록본과의 차이: 구조를 더하고 경로를 넓히면 id 경고 없이 차이만 낸다", () => {
  const w = workspace();
  try {
    const current = baseProfile({ feature_map: "map" });
    write(w.ws, { "map/001-pay.md": META("a.pay") });
    const draft = structuredClone(current);
    draft.version = "1.1.0";
    draft.structures[1].paths.push("config/*.json");
    draft.structures[1].criticality = 75;
    draft.structures.push({ id: "a.mail", name: "메일", criticality: 80, paths: ["src/mail/**"], why: "발송" });
    draft.coverage_ignore.push(".editorconfig");
    const d = diffProfiles({ current, draft, ws: w.ws, draftTree: ["config/app.yml", "config/x.json", "package.json"] });
    assert.deepEqual(d.added, ["a.mail"]);
    assert.deepEqual(d.removed, []);
    assert.deepEqual(d.changed.map((c) => c.id), ["a.cfg"]);
    assert.deepEqual(d.changed[0].criticality, [70, 75]);
    assert.deepEqual(d.changed[0].paths, { added: ["config/*.json"], removed: [] });
    assert.deepEqual(d.changed[0].files, [2, 3]);
    assert.deepEqual(d.coverage_ignore, { added: [".editorconfig"], removed: [] });
    assert.deepEqual(d.items, []);
    assert.equal(d.unchanged, false);
  } finally { w.cleanup(); }
});

test("등록본과의 차이: 구조 id를 없애거나 바꾸면 피처맵 메타가 깨진다고 표시한다", () => {
  const w = workspace();
  try {
    const current = baseProfile({ feature_map: "map" });
    write(w.ws, { "map/001-pay.md": META("a.pay") });
    const renamedDraft = structuredClone(current);
    renamedDraft.version = "2.0.0";
    renamedDraft.structures[0].id = "a.payment";
    const r = diffProfiles({ current, draft: renamedDraft, ws: w.ws });
    assert.deepEqual(r.renamed, [{ from: "a.pay", to: "a.payment" }]);
    assert.deepEqual(r.removed, []);
    assert.equal(r.items[0].check, "structure-id-change");
    assert.match(r.items[0].message, /a\.payment로 이름 바꿈 — 피처맵 메타 1곳/);
    assert.deepEqual(r.items[0].files, ["map/001-pay.md"]);
    const removedDraft = structuredClone(current);
    removedDraft.version = "2.0.0";
    removedDraft.structures.pop();
    const x = diffProfiles({ current, draft: removedDraft, ws: w.ws });
    assert.deepEqual(x.removed, ["a.cfg"]);
    assert.match(x.items[0].message, /a\.cfg를 없앰 — 이 id를 가리키는 피처맵 메타는 없음/);
  } finally { w.cleanup(); }
});

test("등록본과의 차이: 구조가 바뀌었는데 version이 그대로면 WARN, 안 바뀌었으면 조용", () => {
  const w = workspace();
  try {
    const current = baseProfile();
    const draft = structuredClone(current);
    assert.equal(diffProfiles({ current, draft, ws: w.ws }).unchanged, true);
    assert.deepEqual(diffProfiles({ current, draft, ws: w.ws }).items, []);
    draft.structures[0].paths.push("src/pay2/**");
    assert.deepEqual(ids(diffProfiles({ current, draft, ws: w.ws }).items), ["version:version"]);
  } finally { w.cleanup(); }
});

test("전체 점검: 고칠 것이 없으면 FAIL·WARN 0", () => {
  const w = workspace();
  try {
    const r = checkProfile({ profile: baseProfile(), ws: w.ws });
    assert.deepEqual(ids(r.items), []);
    assert.equal(r.stats.FAIL + r.stats.WARN, 0);
    assert.equal(r.head, w.root);
  } finally { w.cleanup(); }
});

test("전체 점검: 새 커밋에서 빠진 파일은 --base 범위와 트리 양쪽에서 잡는다", () => {
  const w = workspace();
  try {
    w.app.commit("add mail", { "src/mail/send.js": "x\n", "src/pay/charge.js": "// pay\nexport const a = 2;\n" });
    w.app.setOrigin("dev");
    const r = checkProfile({ profile: baseProfile(), ws: w.ws, base: w.root });
    assert.deepEqual(ids(r.items, "WARN"), ["uncovered-changed:changed", "uncovered-tree:tree"]);
    assert.deepEqual(r.rows.map((x) => [x.id, x.files, x.changed]), [["a.pay", 1, 1], ["a.cfg", 2, 0]]);
    const old = checkProfile({ profile: baseProfile(), ws: w.ws, head: w.root });
    assert.equal(old.stats.WARN, 0, "옛 커밋에서는 조용");
  } finally { w.cleanup(); }
});

test("전체 점검: 레포·ref를 못 열면 FAIL, github이 origin과 다르면 WARN", () => {
  const w = workspace();
  try {
    const noRepo = baseProfile();
    noRepo.repo.path = "nowhere";
    assert.ok(has(checkProfile({ profile: noRepo, ws: w.ws }).items, "repo", "FAIL"));
    assert.ok(has(checkProfile({ profile: baseProfile(), ws: w.ws, head: "origin/none" }).items, "repo", "FAIL"));
    const wrong = baseProfile();
    wrong.repo.github = "acme/other";
    assert.deepEqual(ids(checkProfile({ profile: wrong, ws: w.ws }).items, "WARN"), ["repo:repo.github"]);
  } finally { w.cleanup(); }
});

test("전체 점검: 등록본을 고친 초안은 등록본과 이름이 겹쳐도 FAIL이 아니다", () => {
  const w = workspace();
  try {
    const current = { ...baseProfile(), _path: join(w.ws, "docs/evaluation/profiles/app.json") };
    const draft = baseProfile({ version: "1.1.0" });
    draft.structures[0].paths.push("src/pay2/**");
    const alone = checkProfile({ profile: draft, profilePath: join(w.ws, ".verify/app.json"), ws: w.ws, registered: [current] });
    assert.ok(has(alone.items, "alias", "FAIL"), "등록본을 안 알려 주면 겹침으로 본다");
    const r = checkProfile({ profile: draft, profilePath: join(w.ws, ".verify/app.json"), ws: w.ws, registered: [current], against: baseProfile() });
    assert.equal(r.stats.FAIL, 0);
    assert.deepEqual(r.diff.changed.map((c) => c.id), ["a.pay"]);
  } finally { w.cleanup(); }
});

test("전체 점검: 피처맵 메타가 없는 구조를 가리키면 WARN", () => {
  const w = workspace();
  try {
    write(w.ws, { "map/001-pay.md": META("a.pay,a.ghost") });
    const r = checkProfile({ profile: baseProfile({ feature_map: "map" }), ws: w.ws });
    assert.deepEqual(ids(r.items, "WARN"), ["feature-meta:001-pay:a.ghost"]);
  } finally { w.cleanup(); }
});

test("대조: 등록 프로필이 여럿이면 key로 상대를 고른다", () => {
  const t = twoRepos();
  try {
    const first = { ...baseProfile(), repo: { ...baseProfile().repo, key: "zzz", name: "zzz", path: "nowhere", github: "acme/zzz", aliases: ["zzz"] }, _path: "/p/zzz.json" };
    assert.deepEqual(dependentProblems({ profile: t.dep(), tree: Object.keys(BASE_FILES), registered: [first, t.webProfile], ws: t.ws }), []);
  } finally { t.cleanup(); }
});

test("같은 폴더 단서: 하위 폴더 파일은 루트까지 올라가지 않는다", () => {
  const st = baseProfile().structures;
  assert.equal(siblingHint("docs/a.md", ["docs/a.md", "package.json", "src/pay/charge.js"], st), null);
});

test("전체 점검: 파일 이름이 바뀌어 죽은 경로는 새 이름을 알려 준다(glob 접두어가 있어도)", () => {
  const w = workspace({ files: { ...BASE_FILES, "src/lib/port/OldName.js": "export const longEnoughBodyForRenameDetection = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';\n" } });
  try {
    w.app.git("mv", "src/lib/port/OldName.js", "src/lib/port/NewName.js");
    w.app.commit("rename", {});
    w.app.setOrigin("dev");
    const p = baseProfile();
    p.structures[1].paths.push("src/**/port/OldName.js");
    const r = checkProfile({ profile: p, ws: w.ws });
    const it = r.items.find((i) => i.check === "renamed-path");
    assert.equal(it.level, "WARN");
    assert.match(it.message, /a\.cfg의 경로 src\/\*\*\/port\/OldName\.js는 git 기록에서 이름이 바뀐 것으로 보임 → src\/lib\/port\/NewName\.js — 맞으면 경로를 새 이름으로/);
    p.structures[0].paths.push("src/lib/**");
    assert.match(checkProfile({ profile: p, ws: w.ws }).items.find((i) => i.check === "renamed-path").message, /새 파일은 a\.pay에 걸려 있음/);
  } finally { w.cleanup(); }
});

test("전체 점검: 이미 default_base에 들어간 장기 브랜치는 INFO", () => {
  const w = workspace();
  try {
    w.app.setOrigin("feat/long");
    w.app.commit("later", { "src/pay/charge.js": "x\n" });
    w.app.setOrigin("dev");
    const r = checkProfile({ profile: baseProfile({ long_lived_branches: ["feat/long", "feat/gone"] }), ws: w.ws });
    assert.deepEqual(ids(r.items, "INFO"), ["stale-branch:feat/long", "stale-branch:feat/gone"]);
    assert.equal(r.stats.WARN, 0);
  } finally { w.cleanup(); }
});

test("등록본과의 차이: dependents의 ref만 바꿔도 차이로 잡고 version을 본다", () => {
  const w = workspace();
  try {
    const dep = (ref) => [{ source: "src/pay/charge.js", replicas: [{ repo: "web", path: "a.js", ref }, { repo: "web", path: "b.js", ref }] }];
    const current = baseProfile({ dependents: dep("feat/x") });
    const draft = baseProfile({ dependents: [...dep("origin/dev"), { source: "config/app.yml", replicas: [{ repo: "web", path: "c.js" }] }] });
    const d = diffProfiles({ current, draft, ws: w.ws });
    assert.deepEqual(d.dependents, { added: ["config/app.yml → web:c.js"], removed: [], refs: [{ move: "feat/x → origin/dev", n: 2 }] });
    assert.equal(d.unchanged, false);
    assert.deepEqual(ids(d.items), ["version:version"]);
    assert.deepEqual(d.version, ["1.0.0", "1.0.0"]);
  } finally { w.cleanup(); }
});

test("등록본과의 차이: 필요한 version 단계보다 덜 올리면 WARN", () => {
  const w = workspace();
  try {
    const current = baseProfile({ version: "1.2.0" });
    const add = structuredClone(current);
    add.structures.push({ id: "a.mail", name: "메일", criticality: 80, paths: ["src/mail/**"], why: "발송" });
    const v = (draft, version) => ids(diffProfiles({ current, draft: { ...draft, version }, ws: w.ws }).items).filter((x) => x === "version:version").length;
    assert.equal(v(add, "1.2.1"), 1, "구조 추가에 PATCH는 모자람");
    assert.equal(v(add, "1.3.0"), 0);
    assert.equal(v(add, "2.0.0"), 0);
    const drop = structuredClone(current);
    drop.structures.pop();
    assert.equal(v(drop, "1.3.0"), 1, "구조 삭제에 MINOR는 모자람");
    assert.equal(v(drop, "2.0.0"), 0);
    assert.match(diffProfiles({ current, draft: { ...drop, version: "1.3.0" }, ws: w.ws }).items.find((i) => i.check === "version").message, /MAJOR/);
  } finally { w.cleanup(); }
});
