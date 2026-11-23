// SKILL.md and the files it points at stay in step with the code: templates ↔ kinds, ${CLAUDE_SKILL_DIR} paths, plugin-only paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KINDS } from "../lib/board.mjs";

const SKILL = fileURLToPath(new URL("..", import.meta.url));
const doc = fs.readFileSync(path.join(SKILL, "SKILL.md"), "utf8");
const [, front, body] = doc.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

test("frontmatter: name = folder, Read of its own folder and the collab CLI allowed", () => {
  assert.match(front, /^name: pane-collab$/m);
  assert.equal(path.basename(SKILL.replace(/\/$/, "")), "pane-collab");
  assert.match(front, /^allowed-tools: .*Read\(\/\$\{CLAUDE_SKILL_DIR\}\/\*\*\)/m, "the leading / makes the substituted path absolute");
  assert.match(front, /Bash\(node \$\{CLAUDE_SKILL_DIR\}\/bin\/collab\.mjs \*\)/);
  assert.match(body, /`node \$\{CLAUDE_SKILL_DIR\}\/bin\/collab\.mjs <명령>`/, "the CLI line in the body matches the allowed rule (no quotes)");
});

test("every template in the table exists, every template file is in the table, and the kinds match the board", () => {
  const listed = [...new Set([...body.matchAll(/`templates\/([\w-]+\.md)`/g)].map((m) => m[1]))].sort();
  const files = fs.readdirSync(path.join(SKILL, "templates")).sort();
  assert.deepEqual(listed, files);
  const tableKinds = [...body.matchAll(/^\| `templates\/[\w-]+\.md`[^|]*\| ([^|]+) \|/gm)].flatMap((m) => [...m[1].matchAll(/`([\w-]+)`/g)].map((k) => k[1]));
  assert.deepEqual([...new Set(tableKinds)].sort(), [...KINDS].sort());
  for (const f of files) {
    const head = fs.readFileSync(path.join(SKILL, "templates", f), "utf8").split("\n")[0];
    assert.match(head, /kind `[\w-]+`/, `${f} names its kind`);
  }
});

test("${CLAUDE_SKILL_DIR} paths in the skill and the guide exist", () => {
  const texts = [body, fs.readFileSync(path.join(SKILL, "references/project-guide.md"), "utf8")];
  const refs = texts.flatMap((t) => [...t.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([\w./-]+[\w-])/g)].map((m) => m[1]));
  assert.ok(refs.length >= 4);
  for (const r of refs) assert.ok(fs.existsSync(path.join(SKILL, r)), r);
});

test("plugin paths only: the CLI is run from the plugin, settings live beside the board", () => {
  const all = [doc, ...fs.readdirSync(path.join(SKILL, "templates")).map((f) => fs.readFileSync(path.join(SKILL, "templates", f), "utf8")), fs.readFileSync(path.join(SKILL, "references/project-guide.md"), "utf8")].join("\n");
  assert.doesNotMatch(all, /\.claude\/skills\/pane-collab/);
});

test("project-sub: its ${CLAUDE_PLUGIN_ROOT} paths exist, the allow rules match the commands it shows, no user-skill paths", () => {
  const plugin = path.join(SKILL, "..", "..");
  const text = fs.readFileSync(path.join(plugin, "skills", "project-sub", "SKILL.md"), "utf8");
  const [, ps] = text.match(/^---\n([\s\S]*?)\n---\n/);
  const refs = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+[\w-])/g)].map((m) => m[1].replace(/\/\*\*$/, ""));
  assert.ok(refs.length >= 4);
  for (const r of refs) assert.ok(fs.existsSync(path.join(plugin, r)), r);
  assert.match(ps, /Bash\(node \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pane-collab\/bin\/collab\.mjs \*\)/);
  assert.match(text, /`collab`은 `node \$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pane-collab\/bin\/collab\.mjs`/, "the shown command matches the Bash rule letter for letter (the rule is not path-normalized)");
  assert.match(ps, /Read\(\/\$\{CLAUDE_PLUGIN_ROOT\}\/skills\/pane-lead\/templates\/\*\*\)/, "Read rules need the plugin root, not CLAUDE_SKILL_DIR/..: the read path is normalized first");
  assert.doesNotMatch(text, /\.claude\/skills\/|~\/\.claude|CLAUDE_SKILL_DIR\}\/\.\./);
});
