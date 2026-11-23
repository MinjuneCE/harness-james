import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run, parseArgs } from "../scripts/install.mjs";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");
const sha = (s) => createHash("sha256").update(s).digest("hex");
const fresh = () => mkdtempSync(join(tmpdir(), "cc-conv-"));
const quiet = { log: () => {} };
const go = (dir, ...args) => run([...args, "--config-dir", dir], { ...quiet, pluginRoot: PLUGIN });

test("install writes every doc and rule and fills the docs path into rules", () => {
  const dir = fresh();
  assert.equal(go(dir), 0);
  for (const f of ["README.md", "common.md", "be/common.md", "fe/common.md", "examples/README.md", "examples/be/java-spring.md", "examples/fe/shopify-ui-extension.md"]) {
    assert.ok(existsSync(join(dir, "conventions", f)), `doc ${f} installed`);
  }
  const rules = readdirSync(join(dir, "rules")).sort();
  assert.deepEqual(rules, readdirSync(join(PLUGIN, "rules")).sort());
  for (const r of rules) {
    const text = readFileSync(join(dir, "rules", r), "utf8");
    assert.ok(!text.includes("{{CONVENTIONS_DIR}}"), `${r} has no placeholder left`);
    assert.ok(text.startsWith("---\npaths:"), `${r} keeps paths frontmatter first`);
  }
  assert.match(readFileSync(join(dir, "rules", "conventions-common.md"), "utf8"), new RegExp(`${join(dir, "conventions")}/common.md`));
});

test("check reports same right after install and differs before", () => {
  const dir = fresh();
  assert.equal(go(dir, "check"), 1);
  go(dir);
  assert.equal(go(dir, "check"), 0);
});

test("install refuses to overwrite a file it did not write unless forced", () => {
  const dir = fresh();
  mkdirSync(join(dir, "rules"), { recursive: true });
  writeFileSync(join(dir, "rules", "conventions-common.md"), "mine\n");
  assert.equal(go(dir), 2);
  assert.equal(readFileSync(join(dir, "rules", "conventions-common.md"), "utf8"), "mine\n");
  assert.equal(go(dir, "--force"), 0);
  assert.notEqual(readFileSync(join(dir, "rules", "conventions-common.md"), "utf8"), "mine\n");
});

test("install refuses to overwrite a file edited after install", () => {
  const dir = fresh();
  go(dir);
  const manifestPath = join(dir, "conventions", ".installed-by-code-conventions.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.files["conventions/common.md"] = "0".repeat(64);
  writeFileSync(manifestPath, JSON.stringify(m));
  writeFileSync(join(dir, "conventions", "common.md"), "edited\n");
  assert.equal(go(dir), 2);
  assert.equal(readFileSync(join(dir, "conventions", "common.md"), "utf8"), "edited\n");
});

test("install updates an outdated file it wrote", () => {
  const dir = fresh();
  go(dir);
  const manifestPath = join(dir, "conventions", ".installed-by-code-conventions.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(join(dir, "conventions", "common.md"), "old\n");
  m.files["conventions/common.md"] = sha("old\n");
  writeFileSync(manifestPath, JSON.stringify(m));
  assert.equal(go(dir), 0);
  assert.equal(readFileSync(join(dir, "conventions", "common.md"), "utf8"), readFileSync(join(PLUGIN, "conventions", "common.md"), "utf8"));
});

test("uninstall removes installed files and leaves foreign ones", () => {
  const dir = fresh();
  go(dir);
  writeFileSync(join(dir, "rules", "other.md"), "keep\n");
  assert.equal(go(dir, "uninstall"), 0);
  assert.deepEqual(readdirSync(join(dir, "rules")), ["other.md"]);
  assert.ok(!existsSync(join(dir, "conventions", "common.md")));
  assert.ok(!existsSync(join(dir, "conventions", ".installed-by-code-conventions.json")));
});

test("config dir comes from CLAUDE_CONFIG_DIR when no flag is given", () => {
  assert.equal(parseArgs([], { CLAUDE_CONFIG_DIR: "/tmp/x" }).configDir, "/tmp/x");
  assert.throws(() => parseArgs(["--bogus"], {}), /모르는 인자/);
});

test("rules hold only the common, backend and frontend summaries", () => {
  const dir = fresh();
  go(dir);
  assert.deepEqual(readdirSync(join(dir, "rules")).sort(), ["conventions-backend.md", "conventions-common.md", "conventions-frontend.md"]);
});

test("example summaries stay under conventions/examples with the docs path filled", () => {
  const dir = fresh();
  go(dir);
  const exRules = join(dir, "conventions", "examples", "rules");
  assert.deepEqual(readdirSync(exRules).sort(), ["conventions-java-spring.md", "conventions-shopify-ui-extension.md"]);
  for (const r of readdirSync(exRules)) {
    const text = readFileSync(join(exRules, r), "utf8");
    assert.ok(!text.includes("{{CONVENTIONS_DIR}}"), `${r} has no placeholder left`);
    assert.ok(text.includes(join(dir, "conventions", "examples")), `${r} points at the installed example doc`);
  }
});
