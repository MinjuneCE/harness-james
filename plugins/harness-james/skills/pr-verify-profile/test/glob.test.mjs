// glob이 /pr-verify와 같은 뜻인지. 같은 플러그인의 pr-verify 구현(옆 스킬 폴더)과 대조한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { globToRegExp, inStructure, matchPaths, matchesAny } from "../lib/glob.mjs";
import { SKILL_DIR } from "./helpers.mjs";

const GLOBS = ["src/main/java/**/domain/**", "src/main/java/**/*Scheduler*.java", "plugins/*/plugin.toml", "**/*.test.*", "**/tests/**", "application*.yml", "build.gradle", "**/.env*", "a?c/*.js", "**/Dockerfile", "src/**", "x.(y)+[z]"];
const PATHS = ["src/main/java/com/a/domain/X.java", "src/main/java/domain/X.java", "src/main/java/com/a/JobScheduler.java", "plugins/card/plugin.toml", "plugins/card/src/plugin.toml", "a.test.js", "x/a.test.js", "x/tests/a.js", "tests/a.js", "application-dev.yml", "sub/application.yml", "build.gradle", ".env.dev", "x/.env", "abc/i.js", "ac/i.js", "Dockerfile", "infra/Dockerfile", "src/a", "x.(y)+[z]", "xay"];

test("glob 뜻: * 는 / 를 넘지 않고, **/ 는 폴더 0개 이상", () => {
  assert.equal(matchesAny("src/a.js", ["src/*.js"]), true);
  assert.equal(matchesAny("src/x/a.js", ["src/*.js"]), false);
  assert.equal(matchesAny("Dockerfile", ["**/Dockerfile"]), true);
  assert.equal(matchesAny("infra/prd/Dockerfile", ["**/Dockerfile"]), true);
  assert.equal(matchesAny("src/x/y/a.js", ["src/**"]), true);
  assert.equal(matchPaths("src/gen/a.js", ["src/**"], ["src/gen/**"]), false);
  assert.equal(inStructure("src/a.js", { paths: ["src/**"] }), true);
  assert.equal(matchesAny("x.(y)+[z]", ["x.(y)+[z]"]), true, "정규식 글자는 글자 그대로");
});

test("pr-verify 구현과 같은 결과", async (t) => {
  const lib = resolve(SKILL_DIR, "../pr-verify/scripts/lib.mjs");
  if (!existsSync(lib)) return t.skip(`pr-verify 구현이 없음: ${lib}`);
  const ref = await import(pathToFileURL(lib).href);
  for (const g of GLOBS) {
    assert.equal(globToRegExp(g).source, ref.globToRegExp(g).source, `정규식이 다름: ${g}`);
    for (const p of PATHS) assert.equal(matchesAny(p, [g]), ref.matchesAny(p, [g]), `${g} ~ ${p}`);
  }
});
